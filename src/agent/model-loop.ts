import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import type { RuntimePromptBundle } from "../config/instruction-bundle.ts";
import type { Logger, RequestLog } from "../logger.ts";
import type { OpenRouterChatRequest, OpenRouterChatResult, OpenRouterMessage, OpenRouterToolCall } from "../llm/types.ts";
import { parseResponseDirectives, type ResponseSegment } from "./response-directives.ts";
import { requestedToolActivations, ToolCatalog, withActivatedToolNames } from "./tool-catalog.ts";
import type { TimingState } from "./tool-timing.ts";
import type { ChatCompleteFn, OutboundAttachment } from "./turn-types.ts";
import { appendImageUnsupportedToolText, describeImagesWithFallback, imageFollowUpMessage, imagePartsFromToolResult, isImageInputUnsupportedError, replaceUnsupportedImageMessages, summarizeToolResult, type ImageFallbackRuntime, type ImageFollowUpSource } from "./image-fallback.ts";
import { abortReason, abortable, assertActionCanCommit, completeModelTurnWithRetries, isAgentTimeBudgetExceededError, isAgentTimeBudgetExceededSignal, isRecord, makeToolErrorText, MODEL_TURN_MAX_ATTEMPTS, requireTextResult, requireTextUnlessToolCalls } from "./model-retry.ts";
import { agentTimeBudgetExhaustedMessage, toolBudgetExhaustedMessage, toolToOpenRouterTool } from "./turn-prompt.ts";

const MAX_INTERNAL_SKILL_LOADS_PER_LOOP = 8;

function parseToolArguments(call: OpenRouterToolCall): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = call.function.arguments.trim() === "" ? {} : JSON.parse(call.function.arguments);
  } catch {
    throw new Error(`Tool ${call.function.name} arguments are not valid JSON.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Tool ${call.function.name} arguments must be an object.`);
  }
  return parsed;
}

async function executeNativeToolCall(
  tool: AgentTool,
  call: OpenRouterToolCall,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<unknown>> {
  if (signal?.aborted === true) {
    throw abortReason(signal, `Tool ${tool.name} aborted before execution.`);
  }
  const args = parseToolArguments(call);
  const validationCall: ToolCall = {
    type: "toolCall",
    id: call.id,
    name: tool.name,
    arguments: args,
  };
  validateToolArguments(tool, validationCall);
  return await abortable(tool.execute(call.id, args, signal), signal);
}

function intermediateStatusText(text: string): { text: string; malformedPrivateOutput: boolean } {
  const parsed = parseResponseDirectives(text);
  if (parsed.ignored || parsed.malformedPrivateOutput === true) {
    return { text: "", malformedPrivateOutput: parsed.malformedPrivateOutput === true };
  }
  return {
    text: parsed.segments
    .filter((segment): segment is Extract<ResponseSegment, { kind: "text" }> => segment.kind === "text")
    .map((segment) => segment.text)
    .join("\n")
    .trim(),
    malformedPrivateOutput: false,
  };
}

function modelTurnStopReason(result: OpenRouterChatResult): string | undefined {
  return result.stopReason;
}
function assistantMessageFromResult(result: OpenRouterChatResult): OpenRouterMessage {
  return {
    role: "assistant",
    content: result.text !== "" ? result.text : null,
    tool_calls: result.toolCalls,
    ...(result.providerNativeContent !== undefined && result.providerNativeContent.length > 0
      ? { providerNativeContent: result.providerNativeContent }
      : {}),
  };
}

function assistantMessageWithToolCalls(
  result: OpenRouterChatResult,
  toolCalls: readonly OpenRouterToolCall[],
): OpenRouterMessage {
  const allowedIds = new Set(toolCalls.map((call) => call.id));
  const providerNativeContent = result.providerNativeContent?.filter((part) =>
    part.type !== "toolCall" || allowedIds.has(part.id)
  );
  return assistantMessageFromResult({
    ...result,
    toolCalls: [...toolCalls],
    ...(providerNativeContent !== undefined ? { providerNativeContent } : {}),
  });
}

export function toolMessage(
  call: OpenRouterToolCall,
  content: string,
  addedToolNames?: readonly string[],
): OpenRouterMessage {
  return {
    role: "tool",
    tool_call_id: call.id,
    name: call.function.name,
    content,
    ...(addedToolNames !== undefined && addedToolNames.length > 0
      ? { addedToolNames: [...addedToolNames] }
      : {}),
  };
}

const PARALLEL_SAFE_READ_ONLY_TOOLS = new Set([
  "list_channel_messages",
  "fetch_images",
  "fetch_url",
  "find_notebooks",
  "list_notebook_revisions",
  "read_notebook",
  "search_memories",
  "search_notebook",
  "list_emojis",
  "list_scheduled_tasks",
  "list_chat_users",
  "list_channels",
  "list_agent_jobs",
  "read_asset",
  "read_agent_job",
  "read_user_avatar",
  "search_channel_messages",
  "search_images",
  "summarize_video",
  "web_search",
]);

/**
 * Only repo-owned tools with read-only semantics are allowed to run together.
 * Unknown/custom tools default to ordered execution because their side effects are not known here.
 */
function canRunToolInParallel(tool: AgentTool): boolean {
  return PARALLEL_SAFE_READ_ONLY_TOOLS.has(tool.name);
}

interface ExecutedToolCall {
  call: OpenRouterToolCall;
  tool: AgentTool;
  result?: AgentToolResult<unknown>;
  errorText?: string;
}

function generatedAttachmentIdsFromToolResult(result: AgentToolResult<unknown>): string[] {
  const details = isRecord(result.details) ? result.details : undefined;
  const ids = details?.generatedAttachmentIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string" && id !== "");
}

function asyncImageJobCreatedFromToolResult(result: AgentToolResult<unknown>): boolean {
  const details = isRecord(result.details) ? result.details : undefined;
  return details?.asyncJobCreated === true;
}

function toolResultNeedsRepair(result: AgentToolResult<unknown>): boolean {
  const details = isRecord(result.details) ? result.details : undefined;
  if (details === undefined) return false;
  if (details.error !== undefined && details.error !== false && details.error !== null && details.error !== "") {
    return true;
  }
  if (Array.isArray(details.errors) && details.errors.length > 0) return true;
  return Array.isArray(details.rejected) && details.rejected.length > 0;
}

function toolExecutionNeedsRepair(execution: ExecutedToolCall): boolean {
  return execution.result === undefined || toolResultNeedsRepair(execution.result);
}

function didCloseCurrentChannel(input: {
  tool: AgentTool;
  result: AgentToolResult<unknown>;
  currentChannelId?: string;
}): boolean {
  if (input.currentChannelId === undefined || input.tool.name !== "close_thread") return false;
  const details = isRecord(input.result.details) ? input.result.details : undefined;
  return details?.channel_id === input.currentChannelId;
}

async function executeToolCallForLoop(input: {
  tool: AgentTool;
  call: OpenRouterToolCall;
  signal?: AbortSignal;
  requestLog?: RequestLog;
}): Promise<ExecutedToolCall> {
  input.requestLog?.recordToolStart(input.call.id, input.tool.name, parseToolArgumentsSafe(input.call));
  try {
    const result = await executeNativeToolCall(input.tool, input.call, input.signal);
    input.requestLog?.recordToolEnd(input.call.id, toolResultNeedsRepair(result), result);
    return { call: input.call, tool: input.tool, result };
  } catch (error) {
    const errorText = makeToolErrorText(error);
    input.requestLog?.recordToolEnd(input.call.id, true, {
      content: [{ type: "text", text: errorText }],
    });
    return { call: input.call, tool: input.tool, errorText };
  }
}

async function renderExecutedToolCall(input: {
  execution: ExecutedToolCall;
  imageInputSupported: boolean;
  imageFallback?: ImageFallbackRuntime;
  imageFollowUpSources: Map<OpenRouterMessage, ImageFollowUpSource>;
  imageMessages: OpenRouterMessage[];
  consumeGeneratedAttachments?: (ids: string[]) => OutboundAttachment[];
  pendingAttachments: OutboundAttachment[];
}): Promise<{ resultText: string; asyncImageJobCreated: boolean }> {
  if (input.execution.result === undefined) {
    return {
      resultText: input.execution.errorText ?? "Tool failed without an error message.",
      asyncImageJobCreated: false,
    };
  }

  const { call, tool, result } = input.execution;
  const asyncImageJobCreated = tool.name === "codex_generate_image" && asyncImageJobCreatedFromToolResult(result);
  const generatedAttachmentIds = generatedAttachmentIdsFromToolResult(result);
  if (generatedAttachmentIds.length > 0) {
    input.pendingAttachments.push(...(input.consumeGeneratedAttachments?.(generatedAttachmentIds) ?? []));
  }
  const images = imagePartsFromToolResult(result);
  let resultText = summarizeToolResult(result);

  if (images.length > 0 && input.imageInputSupported) {
    const followUp = imageFollowUpMessage(call, images, resultText);
    input.imageFollowUpSources.set(followUp.message, followUp.source);
    input.imageMessages.push(followUp.message);
  } else if (images.length > 0 && input.imageFallback?.enabled === true) {
    resultText = await describeImagesWithFallback({
      fallback: input.imageFallback,
      images,
      metadataText: resultText,
      sourceName: tool.name,
      reason: "the selected main model does not advertise image input support",
    });
  } else if (images.length > 0) {
    resultText = appendImageUnsupportedToolText(resultText, images.length);
  }

  return { resultText, asyncImageJobCreated };
}

function loadedSkillIdFromResult(result: AgentToolResult<unknown>): string | undefined {
  const details = isRecord(result.details) ? result.details : undefined;
  return typeof details?.skillId === "string" && details.skillId !== "" ? details.skillId : undefined;
}

function blockedForMissingSkillExecution(input: {
  call: OpenRouterToolCall;
  tool: AgentTool;
  requiredSkillId: string;
  requestLog?: RequestLog;
}): ExecutedToolCall {
  const message = `${input.tool.name} requires the ${input.requiredSkillId} skill. Call load_skill with skill="${input.requiredSkillId}" before using ${input.tool.name}.`;
  input.requestLog?.recordToolSkipped(
    input.call.id,
    input.tool.name,
    parseToolArgumentsSafe(input.call),
    message,
  );
  return {
    call: input.call,
    tool: input.tool,
    result: {
      content: [{ type: "text", text: message }],
      details: { error: true, requiredSkillId: input.requiredSkillId },
    },
  };
}

export async function runNativeToolLoop(input: {
  complete: ChatCompleteFn;
  requestBase: Omit<OpenRouterChatRequest, "messages">;
  messages: OpenRouterMessage[];
  tools: AgentTool[];
  initialToolNames?: ReadonlySet<string>;
  maxToolCalls?: number;
  maxToolRounds?: number;
  agentTimeBudgetMs: number;
  llmOutputTimeoutMs: number;
  retryDelayMs?: (attempt: number) => number;
  requestLog?: RequestLog;
  sendIntermediateText?: (text: string, channelId: string | undefined) => Promise<boolean>;
  streamFinalText?: (delta: string, channelId: string | undefined) => Promise<boolean>;
  onModelTurnStart?: (channelId: string | undefined) => void;
  onStillWorking?: (channelId: string | undefined) => void | Promise<void>;
  hasExternalVisibleOutput?: () => boolean;
  currentChannelId?: string;
  imageInputSupported: boolean;
  imageFallback?: ImageFallbackRuntime;
  consumeGeneratedAttachments?: (ids: string[]) => OutboundAttachment[];
  pendingAttachments: OutboundAttachment[];
  toolTiming?: TimingState;
  runtimePrompts?: RuntimePromptBundle;
  log?: Logger;
  signal?: AbortSignal;
  allowEmptyFinalResponse?: boolean | (() => boolean);
  correctInvalidMessageDirectives?: boolean;
  stopOnAgentTimeBudget?: boolean;
  terminateAfterSuccessfulToolRoundNames?: readonly string[];
  onActiveToolsChanged?: (tools: readonly AgentTool[]) => void;
  initialLoadedSkillIds?: readonly string[];
  onLoadedSkillsChanged?: (skillIds: readonly string[]) => void;
  onActionCommitted?: () => void;
  takePendingMessages?: () => OpenRouterMessage[] | Promise<OpenRouterMessage[]>;
  stopAfterAsyncImageJobCreated?: boolean;
  beforeModelTurn?: (messages: OpenRouterMessage[]) => Promise<void>;
}): Promise<{ text: string; stopReason?: string }> {
  const toolCatalog = new ToolCatalog(
    input.tools,
    input.initialToolNames ?? new Set(input.tools.map((tool) => tool.name)),
  );
  const loadedSkills = new Set(input.initialLoadedSkillIds ?? []);
  input.onActiveToolsChanged?.(toolCatalog.activeTools());
  input.onLoadedSkillsChanged?.([...loadedSkills]);
  const terminateAfterSuccessfulToolRoundNames = new Set(input.terminateAfterSuccessfulToolRoundNames ?? []);
  const imageFollowUpSources = new Map<OpenRouterMessage, ImageFollowUpSource>();
  let toolCalls = 0;
  let toolRounds = 0;
  let internalToolLoads = 0;
  let sentIntermediateStatus = false;
  const streamingState = { visibleText: false };
  let agentTimeBudgetMarked = false;
  let asyncImageJobCreated = false;
  let correctedInvalidMessageDirectives = false;
  const allowEmptyFinalResponse = (): boolean => typeof input.allowEmptyFinalResponse === "function"
    ? input.allowEmptyFinalResponse()
    : input.allowEmptyFinalResponse === true;

  const markAgentTimeBudgetExhausted = (): void => {
    if (agentTimeBudgetMarked) return;
    agentTimeBudgetMarked = true;
    input.messages.push({
      role: "system",
      content: agentTimeBudgetExhaustedMessage(input.agentTimeBudgetMs, input.runtimePrompts),
    });
    input.log?.warn("native reply loop agent time budget exhausted", {
      timeoutMs: input.agentTimeBudgetMs,
    });
  };

  const completeFinalWithoutTools = async (
    emptyResponseMessage = "Model produced an empty response after tool budget exhaustion.",
    maxAttempts = MODEL_TURN_MAX_ATTEMPTS,
    signal: AbortSignal | null | undefined = input.signal,
    recoverAgentTimeBudget = true,
  ): Promise<{ text: string; stopReason?: string }> => {
    let completedVisibleMessage = false;
    try {
      await input.beforeModelTurn?.(input.messages);
      const result = await completeModelTurnWithRetries({
        complete: input.complete,
        request: {
          ...input.requestBase,
          messages: input.messages,
          tools: [],
          toolChoice: "none",
          parallelToolCalls: false,
          onTextDelta: input.streamFinalText !== undefined
            ? async (delta) => {
              const sent = await input.streamFinalText?.(delta, undefined);
              if (sent === true) {
                streamingState.visibleText = true;
                completedVisibleMessage = true;
              }
            }
            : undefined,
          signal: signal ?? undefined,
        },
        timeoutMs: input.llmOutputTimeoutMs,
        maxAttempts,
        retryDelayMs: input.retryDelayMs,
        validateResult: allowEmptyFinalResponse() ? undefined : requireTextResult(emptyResponseMessage),
        onAttemptStart: () => {
          completedVisibleMessage = false;
          input.onModelTurnStart?.(undefined);
        },
        hasCompletedVisibleMessage: () => completedVisibleMessage,
        requestLog: input.requestLog,
        log: input.log,
      });
      input.requestLog?.recordLLMCompletion(result.messageForLogs);
      const text = result.text.trim();
      const stopReason = modelTurnStopReason(result);
      if (stopReason === "length") {
        return { text, stopReason };
      }
      input.messages.push(assistantMessageFromResult({ ...result, text }));
      return { text, ...(stopReason !== undefined ? { stopReason } : {}) };
    } catch (error) {
      if (recoverAgentTimeBudget && isAgentTimeBudgetExceededError(error)) {
        return await finishAfterAgentTimeBudget();
      }
      throw error;
    }
  };

  const completeFinalAfterAgentTimeBudget = async (): Promise<{ text: string; stopReason?: string }> => {
    markAgentTimeBudgetExhausted();
    return await completeFinalWithoutTools(
      "Model produced an empty response after agent time budget exhaustion.",
      1,
      null,
      false,
    );
  };

  const finishAfterAgentTimeBudget = async (): Promise<{ text: string; stopReason?: string }> => {
    if (input.stopOnAgentTimeBudget === true) {
      return { text: "" };
    }
    return await completeFinalAfterAgentTimeBudget();
  };

  const agentTimeBudgetToolMessage = (): string => agentTimeBudgetExhaustedMessage(input.agentTimeBudgetMs, input.runtimePrompts);

  const appendSkippedToolCallsForAgentTimeBudget = (calls: OpenRouterToolCall[]): void => {
    for (const skippedCall of calls) {
      input.requestLog?.recordToolSkipped(
        skippedCall.id,
        skippedCall.function.name,
        parseToolArgumentsSafe(skippedCall),
        agentTimeBudgetToolMessage(),
      );
      input.messages.push(toolMessage(skippedCall, agentTimeBudgetToolMessage()));
    }
  };

  for (;;) {
    const pendingMessages = await input.takePendingMessages?.() ?? [];
    input.messages.push(...pendingMessages);
    await input.beforeModelTurn?.(input.messages);
    let result: OpenRouterChatResult;
    let completedVisibleMessage = false;
    try {
      input.toolTiming?.markModelTurnStart();
      result = await completeModelTurnWithRetries({
        complete: input.complete,
        request: {
          ...input.requestBase,
          messages: input.messages,
          tools: toolCatalog.activeTools().map(toolToOpenRouterTool),
          toolChoice: toolCatalog.activeTools().length > 0 ? "auto" : "none",
          parallelToolCalls: true,
          onTextDelta: input.streamFinalText !== undefined
            ? async (delta) => {
              const sent = await input.streamFinalText?.(delta, undefined);
              if (sent === true) {
                streamingState.visibleText = true;
                completedVisibleMessage = true;
              }
            }
            : undefined,
          signal: input.signal,
        },
        timeoutMs: input.llmOutputTimeoutMs,
        retryDelayMs: input.retryDelayMs,
        validateResult: allowEmptyFinalResponse() ? undefined : requireTextUnlessToolCalls("Model produced an empty response."),
        onAttemptStart: () => {
          completedVisibleMessage = false;
          input.onModelTurnStart?.(undefined);
        },
        hasCompletedVisibleMessage: () => completedVisibleMessage,
        requestLog: input.requestLog,
        log: input.log,
      });
      input.toolTiming?.markToolCallsReady();
      for (const pendingMessage of pendingMessages) stripTransientImageData(pendingMessage);
    } catch (error) {
      if (
        isImageInputUnsupportedError(error)
        && await replaceUnsupportedImageMessages(
          input.messages,
          input.imageFallback,
          makeToolErrorText(error),
          imageFollowUpSources,
        )
      ) {
        continue;
      }
      if (isAgentTimeBudgetExceededError(error)) {
        return await finishAfterAgentTimeBudget();
      }
      throw error;
    }
    if (result.toolCalls.length > 0) {
      assertActionCanCommit(input.signal, "Agent loop aborted before tool execution.");
      input.onActionCommitted?.();
    }
    input.requestLog?.recordLLMCompletion(result.messageForLogs);
    const stopReason = modelTurnStopReason(result);
    if (stopReason === "length") {
      const text = result.text.trim();
      return { text, stopReason };
    }

    if (result.toolCalls.length === 0) {
      const text = result.text.trim();
      const parsedDirectives = input.correctInvalidMessageDirectives === true
        ? parseResponseDirectives(text)
        : undefined;
      if (
        parsedDirectives?.directiveErrors !== undefined
        && !correctedInvalidMessageDirectives
        && !streamingState.visibleText
      ) {
        correctedInvalidMessageDirectives = true;
        input.messages.push(assistantMessageFromResult({ ...result, text }));
        input.messages.push({
          role: "system",
          content: `Correct the invalid <message> directive and return the complete response again. ${parsedDirectives.directiveErrors.join(" ")}`,
        });
        input.log?.warn("retrying reply after invalid message directive", {
          errors: parsedDirectives.directiveErrors,
        });
        continue;
      }
      input.messages.push(assistantMessageFromResult({ ...result, text }));
      return { text, ...(stopReason !== undefined ? { stopReason } : {}) };
    }

    if (!sentIntermediateStatus && !streamingState.visibleText) {
      const status = intermediateStatusText(result.text);
      if (status.malformedPrivateOutput) {
        input.log?.warn("malformed private output blocked from intermediate delivery", {
          outputLength: result.text.length,
        });
      } else if (status.text !== "" && input.sendIntermediateText !== undefined) {
        const sent = await input.sendIntermediateText(result.text, undefined);
        if (sent) {
          sentIntermediateStatus = true;
          await input.onStillWorking?.(undefined);
        }
      }
    }

    if (isAgentTimeBudgetExceededSignal(input.signal)) {
      return await finishAfterAgentTimeBudget();
    }

    const turnActiveToolNames = new Set(toolCatalog.activeTools().map((tool) => tool.name));
    const turnLoadedSkills = new Set(loadedSkills);
    const replayableToolCalls = result.toolCalls.filter((call) =>
      turnActiveToolNames.has(call.function.name) && toolCatalog.registeredTool(call.function.name) !== undefined
    );
    const inactiveToolCalls = result.toolCalls
      .filter((call) => !replayableToolCalls.includes(call))
      .map((call) => {
        const registeredTool = toolCatalog.registeredTool(call.function.name);
        const requiredSkillIds = normalizeRequiredSkills(input.runtimePrompts?.skills.requiredByTool[call.function.name]);
        const message = registeredTool === undefined
          ? `Unknown tool: ${call.function.name}`
          : requiredSkillIds.length > 0
            ? `${call.function.name} is not active in this model turn. Call load_skill with one of ${requiredSkillIds.map((id) => `skill="${id}"`).join(" or ")}, then call ${call.function.name} in the next model turn.`
            : `${call.function.name} is not active in this model turn. Call search_tools for this action, then call ${call.function.name} in the next model turn.`;
        input.requestLog?.recordToolSkipped(
          call.id,
          call.function.name,
          parseToolArgumentsSafe(call),
          message,
        );
        return { call, message };
      });
    const hasOperationalToolCall = replayableToolCalls.some((call) =>
      call.function.name !== "load_skill" && call.function.name !== "search_tools"
    );
    if (hasOperationalToolCall && input.maxToolRounds !== undefined && toolRounds >= input.maxToolRounds) {
      input.messages.push(assistantMessageWithToolCalls(result, replayableToolCalls));
      for (const call of replayableToolCalls) {
        input.requestLog?.recordToolSkipped(
          call.id,
          call.function.name,
          parseToolArgumentsSafe(call),
          toolBudgetExhaustedMessage("rounds", input.runtimePrompts),
        );
        input.messages.push(toolMessage(call, toolBudgetExhaustedMessage("rounds", input.runtimePrompts)));
      }
      if (inactiveToolCalls.length > 0) {
        input.messages.push({
          role: "user",
          content: [...new Set(inactiveToolCalls.map(({ message }) => message))].join("\n"),
        });
      }
      if (terminateAfterSuccessfulToolRoundNames.size > 0) return { text: "" };
      return await completeFinalWithoutTools();
    }

    input.messages.push(assistantMessageWithToolCalls(result, replayableToolCalls));

    const imageMessages: OpenRouterMessage[] = [];
    const inactiveToolRecoveryMessages = inactiveToolCalls.map(({ message }) => message);
    const pendingParallelCalls: Array<{ call: OpenRouterToolCall; tool: AgentTool }> = [];
    const toolRoundState = {
      sawTerminatingToolCall: false,
      needsRepair: false,
    };
    const noteToolExecution = (execution: ExecutedToolCall): void => {
      if (terminateAfterSuccessfulToolRoundNames.has(execution.tool.name)) {
        toolRoundState.sawTerminatingToolCall = true;
      }
      if (toolExecutionNeedsRepair(execution)) {
        toolRoundState.needsRepair = true;
      }
    };
    const activateRequestedTools = (execution: ExecutedToolCall): void => {
      if (execution.tool.name !== "load_skill" && execution.tool.name !== "search_tools") return;
      if (execution.result === undefined) return;
      const requested = requestedToolActivations(execution.result);
      if (requested.length === 0) return;
      const added = toolCatalog.activate(requested);
      execution.result = withActivatedToolNames(execution.result, added);
      if (added.length > 0) input.onActiveToolsChanged?.(toolCatalog.activeTools());
    };
    const flushParallelCalls = async (): Promise<void> => {
      if (pendingParallelCalls.length === 0) return;
      input.requestLog?.beginToolBatch(pendingParallelCalls.map(({ call }) => call.id), "parallel");
      const executions = await Promise.all(pendingParallelCalls.map(({ call, tool }) =>
        executeToolCallForLoop({
          tool,
          call,
          signal: input.signal,
          requestLog: input.requestLog,
        })
      ));
      pendingParallelCalls.length = 0;

      for (const execution of executions) {
        activateRequestedTools(execution);
        noteToolExecution(execution);
        if (execution.tool.name === "load_skill" && execution.result !== undefined) {
          const skillId = loadedSkillIdFromResult(execution.result);
          if (skillId !== undefined) {
            loadedSkills.add(skillId);
            input.onLoadedSkillsChanged?.([...loadedSkills]);
          }
        }
        const rendered = await renderExecutedToolCall({
          execution,
          imageInputSupported: input.imageInputSupported,
          imageFallback: input.imageFallback,
          imageFollowUpSources,
          imageMessages,
          consumeGeneratedAttachments: input.consumeGeneratedAttachments,
          pendingAttachments: input.pendingAttachments,
        });
        if (rendered.asyncImageJobCreated) asyncImageJobCreated = true;
        input.messages.push(toolMessage(
          execution.call,
          rendered.resultText,
          execution.result?.addedToolNames,
        ));
      }
    };

    for (let callIndex = 0; callIndex < replayableToolCalls.length; callIndex += 1) {
      const call = replayableToolCalls[callIndex];
      if (call === undefined) continue;
      if (isAgentTimeBudgetExceededSignal(input.signal)) {
        await flushParallelCalls();
        appendSkippedToolCallsForAgentTimeBudget(replayableToolCalls.slice(callIndex));
        input.messages.push(...imageMessages);
        return await finishAfterAgentTimeBudget();
      }
      const registeredTool = toolCatalog.registeredTool(call.function.name);
      if (registeredTool === undefined) continue;
      const tool = registeredTool;

      if (tool.name === "load_skill" || tool.name === "search_tools") {
        if (internalToolLoads >= MAX_INTERNAL_SKILL_LOADS_PER_LOOP) {
          await flushParallelCalls();
          const message = "Private capability loading budget exhausted for this turn.";
          input.requestLog?.recordToolSkipped(
            call.id,
            call.function.name,
            parseToolArgumentsSafe(call),
            message,
          );
          input.messages.push(toolMessage(call, message));
          input.messages.push(...imageMessages);
          return await completeFinalWithoutTools();
        }
        internalToolLoads += 1;
      } else if (input.maxToolCalls !== undefined && toolCalls >= input.maxToolCalls) {
        await flushParallelCalls();
        if (isAgentTimeBudgetExceededSignal(input.signal)) {
          appendSkippedToolCallsForAgentTimeBudget(replayableToolCalls.slice(callIndex));
          input.messages.push(...imageMessages);
          return await finishAfterAgentTimeBudget();
        }
        for (const skippedCall of replayableToolCalls.slice(callIndex)) {
          input.requestLog?.recordToolSkipped(
            skippedCall.id,
            skippedCall.function.name,
            parseToolArgumentsSafe(skippedCall),
            toolBudgetExhaustedMessage("calls", input.runtimePrompts),
          );
          input.messages.push(toolMessage(skippedCall, toolBudgetExhaustedMessage("calls", input.runtimePrompts)));
        }
        input.messages.push(...imageMessages);
        if (terminateAfterSuccessfulToolRoundNames.size > 0) return { text: "" };
        return await completeFinalWithoutTools();
      } else {
        toolCalls += 1;
      }

      const requiredSkillIds = normalizeRequiredSkills(input.runtimePrompts?.skills.requiredByTool[tool.name]);
      if (requiredSkillIds.length > 0 && !requiredSkillIds.some((skillId) => turnLoadedSkills.has(skillId))) {
        await flushParallelCalls();
        const execution = blockedForMissingSkillExecution({
          call,
          tool,
          requiredSkillId: requiredSkillIds[0] ?? "",
          requestLog: input.requestLog,
        });
        const rendered = await renderExecutedToolCall({
          execution,
          imageInputSupported: input.imageInputSupported,
          imageFallback: input.imageFallback,
          imageFollowUpSources,
          imageMessages,
          consumeGeneratedAttachments: input.consumeGeneratedAttachments,
          pendingAttachments: input.pendingAttachments,
        });
        input.messages.push(toolMessage(call, rendered.resultText));
        continue;
      }

      if (canRunToolInParallel(tool)) {
        pendingParallelCalls.push({ call, tool });
        continue;
      }

      await flushParallelCalls();
      if (isAgentTimeBudgetExceededSignal(input.signal)) {
        appendSkippedToolCallsForAgentTimeBudget(result.toolCalls.slice(callIndex));
        input.messages.push(...imageMessages);
        return await finishAfterAgentTimeBudget();
      }
      input.requestLog?.beginToolBatch([call.id], "sequential");
      const execution = await executeToolCallForLoop({
        tool,
        call,
        signal: input.signal,
        requestLog: input.requestLog,
      });
      activateRequestedTools(execution);
      noteToolExecution(execution);
      if (execution.tool.name === "load_skill" && execution.result !== undefined) {
        const skillId = loadedSkillIdFromResult(execution.result);
        if (skillId !== undefined) {
          loadedSkills.add(skillId);
          input.onLoadedSkillsChanged?.([...loadedSkills]);
        }
      }
      const rendered = await renderExecutedToolCall({
        execution,
        imageInputSupported: input.imageInputSupported,
        imageFallback: input.imageFallback,
        imageFollowUpSources,
        imageMessages,
        consumeGeneratedAttachments: input.consumeGeneratedAttachments,
        pendingAttachments: input.pendingAttachments,
      });
      if (rendered.asyncImageJobCreated) asyncImageJobCreated = true;
      input.messages.push(toolMessage(call, rendered.resultText, execution.result?.addedToolNames));
      if (execution.result !== undefined && didCloseCurrentChannel({
        tool,
        result: execution.result,
        currentChannelId: input.currentChannelId,
      })) {
        return { text: "" };
      }
      if (isAgentTimeBudgetExceededSignal(input.signal)) {
        appendSkippedToolCallsForAgentTimeBudget(replayableToolCalls.slice(callIndex + 1));
        input.messages.push(...imageMessages);
        return await finishAfterAgentTimeBudget();
      }
    }
    await flushParallelCalls();
    input.messages.push(...imageMessages);
    if (inactiveToolRecoveryMessages.length > 0) {
      input.messages.push({
        role: "user",
        content: [...new Set(inactiveToolRecoveryMessages)].join("\n"),
      });
    }
    if (hasOperationalToolCall) toolRounds += 1;
    if (toolRoundState.sawTerminatingToolCall && !toolRoundState.needsRepair) {
      return { text: "" };
    }
    if (asyncImageJobCreated && input.stopAfterAsyncImageJobCreated !== false) {
      return { text: "" };
    }
    if (isAgentTimeBudgetExceededSignal(input.signal)) {
      return await finishAfterAgentTimeBudget();
    }
    // Direct public tool output stops typing when delivered. If the agent loop
    // continues, resume immediately rather than waiting for a text segment.
    if (input.hasExternalVisibleOutput?.() === true) {
      await input.onStillWorking?.(undefined);
    }
  }

  throw new Error("Native tool loop ended without a final response.");
}

function stripTransientImageData(message: OpenRouterMessage): void {
  if (!Array.isArray(message.content)) return;
  const text = message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
  message.content = text;
}

function normalizeRequiredSkills(required: string | string[] | undefined): string[] {
  return required === undefined ? [] : typeof required === "string" ? [required] : required;
}

function parseToolArgumentsSafe(call: OpenRouterToolCall): Record<string, unknown> {
  try {
    return parseToolArguments(call);
  } catch {
    return {};
  }
}
