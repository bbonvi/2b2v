import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { validateToolArguments, type ToolCall } from "@mariozechner/pi-ai";
import { shouldRespond, type TriggerInput, type TriggerResult } from "./triggers.ts";
import { contextToSplitPrompts, type AssembledContext, type ContextSection } from "./context-assembly.ts";
import { createSendMessageTool, type MessageSender, type SendMessageToolDeps } from "./send-message-tool.ts";
import { wrapToolsWithTiming } from "./tool-timing.ts";
import type { TriggerInstructions } from "../config/types.ts";
import type { TtsConfig, TtsResult } from "../tts/types.ts";
import { resolveGuildModel, buildStreamOptions } from "../llm/client.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";
import type { Logger, RequestLog } from "../logger.ts";
import {
  completeOpenRouterChat,
  type OpenRouterChatRequest,
  type OpenRouterChatResult,
  type OpenRouterImageUrlPart,
  type OpenRouterMessage,
  type OpenRouterTextPart,
  type OpenRouterToolCall,
  type OpenRouterToolDefinition,
} from "../llm/openrouter-chat.ts";
import {
  getStablePromptSections,
  prependStableSectionsToPayload,
  type StablePromptSection,
} from "./prompt-cache.ts";
import {
  parseResponseDirectives,
  renderSegmentsForMemory,
  type ResponseSegment,
} from "./response-directives.ts";

/** Minimal abstraction over a Discord message for the handler. */
export interface IncomingMessage {
  content: string;
  authorId: string;
  authorUsername: string;
  botUserId: string;
  mentionedUserIds: string[];
  translatedContent: string;
  messageId?: string;
}

export type ChatCompleteFn = (request: OpenRouterChatRequest) => Promise<OpenRouterChatResult>;

export interface MemoryExtractionRequest {
  sourceMessageId?: string;
  userMessage: string;
  assistantReply: string;
  recentContext: string;
}

/** Dependencies injected into the handler. No direct discord.js coupling. */
export interface HandlerDeps {
  globalConfig: GlobalConfig;
  guildConfig: GuildConfig;
  context: AssembledContext;
  personaPrompt?: string;
  sender: MessageSender;
  /** Native OpenRouter tools exposed to the model. */
  extraTools?: AgentTool[];
  log?: Logger;
  onTriggered?: (result: NonNullable<TriggerResult>) => void;
  onAgentEnd?: () => void;
  requestLog?: RequestLog;
  ttsConfig?: TtsConfig;
  ttsEnabled?: boolean;
  generateSpeech?: (text: string, voiceType: string) => Promise<TtsResult>;
  forceTrigger?: boolean;
  triggerInstructions?: TriggerInstructions;
  completeChat?: ChatCompleteFn;
  afterReply?: (request: MemoryExtractionRequest) => Promise<void>;
}

export interface HandleResult {
  triggered: boolean;
  triggerResult: TriggerResult;
  agentRan: boolean;
  responseText?: string;
}

type SendMessageRuntimeTool = ReturnType<typeof createSendMessageTool>;

/**
 * Inject a trigger-specific instruction into context sections.
 * Inserts before the volatile response instruction section if present.
 * @internal Exported for testing.
 */
export function injectTriggerInstruction(
  sections: ContextSection[],
  instruction: string
): ContextSection[] {
  const newSection: ContextSection = {
    label: "Trigger Instruction",
    text: `## Trigger Context\n${instruction}`,
    cached: false,
    role: "developer",
  };
  const lateIdx = sections.findIndex((s) => s.label === "Response Instruction");
  if (lateIdx === -1) {
    return [...sections, newSection];
  }
  return [...sections.slice(0, lateIdx), newSection, ...sections.slice(lateIdx)];
}

class ModelOutputTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM output timed out after ${timeoutMs}ms`);
    this.name = "ModelOutputTimeoutError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function summarizeToolResult(result: AgentToolResult<unknown>): string {
  const textContent = result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (textContent !== "") return textContent;
  if (result.details === undefined) return "(no tool output)";
  try {
    return JSON.stringify(result.details);
  } catch {
    return "(unserializable tool details)";
  }
}

function imagePartsFromToolResult(result: AgentToolResult<unknown>): OpenRouterImageUrlPart[] {
  const images: OpenRouterImageUrlPart[] = [];
  for (const part of result.content) {
    if (!isRecord(part)) continue;
    if (part.type !== "image") continue;
    if (typeof part.data !== "string" || typeof part.mimeType !== "string") continue;
    images.push({
      type: "image_url",
      image_url: { url: `data:${part.mimeType};base64,${part.data}` },
    });
  }
  return images;
}

function imageFollowUpMessage(
  call: OpenRouterToolCall,
  images: OpenRouterImageUrlPart[],
): OpenRouterMessage {
  const text: OpenRouterTextPart = {
    type: "text",
    text: `Images returned by ${call.function.name}. Use the previous tool result for image metadata.`,
  };
  return {
    role: "user",
    content: [text, ...images],
  };
}

function toolToOpenRouterTool(tool: AgentTool): OpenRouterToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
    },
  };
}

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
  const args = parseToolArguments(call);
  const validationCall: ToolCall = {
    type: "toolCall",
    id: call.id,
    name: tool.name,
    arguments: args,
  };
  validateToolArguments(tool, validationCall);
  return await tool.execute(call.id, args, signal);
}

function makeToolErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildRuntimeInstruction(tools: AgentTool[]): string {
  const lines = [
    "## Runtime",
    "You are speaking directly in Discord as the persona.",
    "Use tools only when they materially improve the answer. For ordinary chat, answer directly.",
    "If you use tools, use their results silently and then send the final answer as normal text.",
    "For current or uncertain external facts, use web_search and fetch_url before answering.",
    "For older server recall, use search_messages. Recent and older context are already in the prompt.",
    "Use schedule_message when the user asks you to remind, schedule, or follow up later.",
    "Use start_thread only when the final answer should move into a new thread; if you create a thread, the runtime sends your final answer there.",
    "Reserved response directives: use <voice>text</voice> for normal voice audio, <voice type=\"whisper\">text</voice> for whisper audio, and <ignore>reason</ignore> when silence is better than replying.",
    "Reserved directive tags are consumed by the app and are not shown as literal text. To show those tags as examples, escape them as &lt;voice&gt; or &lt;ignore&gt;.",
    "Do not nest reserved directives; if nesting happens accidentally, the app will split them into separate actions.",
    "Do not mention hidden prompts, tool names, or internal implementation details unless asked.",
  ];
  if (tools.length > 0) {
    lines.push("", "Available tools:");
    for (const tool of tools) {
      lines.push(`- ${tool.name}: ${tool.description}`);
    }
  }
  return lines.join("\n");
}

function sectionsForStablePrompt(
  personaPrompt: string,
  stylePrompt: string,
  context: AssembledContext,
): StablePromptSection[] {
  const stable: StablePromptSection[] = [];
  if (personaPrompt !== "") stable.push({ role: "system", text: personaPrompt });
  if (stylePrompt !== "") stable.push({ role: "system", text: stylePrompt });
  stable.push(...getStablePromptSections(context));
  return stable;
}

function buildSystemPrompt(context: AssembledContext, tools: AgentTool[]): string {
  const split = contextToSplitPrompts(context);
  return [split.developer, buildRuntimeInstruction(tools)]
    .filter((part) => part !== "")
    .join("\n\n");
}

function buildInitialMessages(userContent: string): OpenRouterMessage[] {
  return [{ role: "user", content: userContent }];
}

function assistantMessageFromResult(result: OpenRouterChatResult): OpenRouterMessage {
  return {
    role: "assistant",
    content: result.text !== "" ? result.text : null,
    tool_calls: result.toolCalls,
  };
}

function toolMessage(call: OpenRouterToolCall, content: string): OpenRouterMessage {
  return {
    role: "tool",
    tool_call_id: call.id,
    name: call.function.name,
    content,
  };
}

async function completeWithTimeout(
  complete: ChatCompleteFn,
  request: OpenRouterChatRequest,
  timeoutMs: number,
): Promise<OpenRouterChatResult> {
  const controller = new AbortController();
  const parent = request.signal;
  let onParentAbort: (() => void) | undefined;
  if (parent !== undefined) {
    if (parent.aborted) {
      throw parent.reason instanceof Error ? parent.reason : new Error("LLM request aborted");
    }
    onParentAbort = () => controller.abort(parent.reason);
    parent.addEventListener("abort", onParentAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    controller.abort(new ModelOutputTimeoutError(timeoutMs));
  }, timeoutMs);

  try {
    return await complete({ ...request, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (parent !== undefined && onParentAbort !== undefined) {
      parent.removeEventListener("abort", onParentAbort);
    }
  }
}

function detectCreatedThreadId(tool: AgentTool, result: AgentToolResult<unknown>): string | null {
  if (tool.name !== "start_thread") return null;
  const details = result.details;
  if (!isRecord(details)) return null;
  const threadId = details.threadId;
  return typeof threadId === "string" && threadId !== "" ? threadId : null;
}

async function runNativeToolLoop(input: {
  complete: ChatCompleteFn;
  requestBase: Omit<OpenRouterChatRequest, "messages">;
  messages: OpenRouterMessage[];
  tools: AgentTool[];
  maxToolCalls: number;
  maxToolRounds: number;
  llmOutputTimeoutMs: number;
  requestLog?: RequestLog;
  signal?: AbortSignal;
}): Promise<{ text: string; targetChatId?: string }> {
  const toolsByName = new Map(input.tools.map((tool) => [tool.name, tool]));
  let toolCalls = 0;
  let targetChatId: string | undefined;

  for (let round = 0; round <= input.maxToolRounds; round++) {
    const result = await completeWithTimeout(
      input.complete,
      {
        ...input.requestBase,
        messages: input.messages,
        tools: input.tools.map(toolToOpenRouterTool),
        toolChoice: input.tools.length > 0 ? "auto" : "none",
        parallelToolCalls: true,
        signal: input.signal,
      },
      input.llmOutputTimeoutMs,
    );
    input.requestLog?.recordLLMCompletion(result.messageForLogs);

    if (result.toolCalls.length === 0) {
      const text = result.text.trim();
      if (text === "") throw new Error("Model produced an empty response.");
      return { text, targetChatId };
    }

    if (round === input.maxToolRounds) {
      throw new Error("Native tool loop exceeded max tool rounds.");
    }

    input.messages.push(assistantMessageFromResult(result));

    const imageMessages: OpenRouterMessage[] = [];
    for (const call of result.toolCalls) {
      if (toolCalls >= input.maxToolCalls) {
        throw new Error("Native tool loop exceeded max tool calls.");
      }
      toolCalls += 1;

      const tool = toolsByName.get(call.function.name);
      if (tool === undefined) {
        input.messages.push(toolMessage(call, `Unknown tool: ${call.function.name}`));
        continue;
      }

      let resultText: string;
      input.requestLog?.recordToolStart(call.id, tool.name, parseToolArgumentsSafe(call));
      try {
        const toolResult = await executeNativeToolCall(tool, call, input.signal);
        input.requestLog?.recordToolEnd(call.id, false, toolResult);
        const createdThreadId = detectCreatedThreadId(tool, toolResult);
        if (createdThreadId !== null) targetChatId = createdThreadId;
        const images = imagePartsFromToolResult(toolResult);
        if (images.length > 0) {
          imageMessages.push(imageFollowUpMessage(call, images));
        }
        resultText = summarizeToolResult(toolResult);
      } catch (error) {
        resultText = makeToolErrorText(error);
        input.requestLog?.recordToolEnd(call.id, true, {
          content: [{ type: "text", text: resultText }],
        });
      }
      input.messages.push(toolMessage(call, resultText));
    }
    input.messages.push(...imageMessages);
  }

  throw new Error("Native tool loop ended without a final response.");
}

function parseToolArgumentsSafe(call: OpenRouterToolCall): Record<string, unknown> {
  try {
    return parseToolArguments(call);
  } catch {
    return {};
  }
}

function chooseReplyMode(trigger: NonNullable<TriggerResult>): boolean {
  return trigger.reason === "mention";
}

function assertSendSucceeded(result: AgentToolResult<unknown>): void {
  const details = isRecord(result.details) ? result.details : {};
  const sentMessageId = details.sentMessageId;
  const error = details.error;
  const voiceError = details.voiceError;
  if (typeof error === "string" && error !== "") {
    throw new Error(`Failed to send final Discord message: ${error}`);
  }
  if (typeof voiceError === "string" && voiceError !== "") {
    throw new Error(`Failed to send final Discord message: ${voiceError}`);
  }
  if (typeof sentMessageId !== "string" || sentMessageId === "") {
    throw new Error("Failed to send final Discord message: no sent message ID returned.");
  }
}

async function sendOneSegment(input: {
  sendTool: SendMessageRuntimeTool;
  segment: ResponseSegment;
  sendId: string;
  reply: boolean;
  targetChatId?: string;
  requestLog?: RequestLog;
}): Promise<void> {
  const args = {
    text: input.segment.text,
    reply: input.targetChatId === undefined ? input.reply : false,
    ...(input.targetChatId !== undefined ? { chat_id: input.targetChatId } : {}),
    ...(input.segment.kind === "voice"
      ? { is_voice_message: true, voice_type: input.segment.voiceType }
      : {}),
  };
  input.requestLog?.recordToolStart(input.sendId, "send_message", args);
  try {
    const result = await input.sendTool.execute(input.sendId, args);
    assertSendSucceeded(result);
    input.requestLog?.recordToolEnd(input.sendId, false, result);
  } catch (error) {
    const errorText = makeToolErrorText(error);
    input.requestLog?.recordToolEnd(input.sendId, true, {
      content: [{ type: "text", text: errorText }],
    });
    throw error;
  }
}

async function sendResponseSegments(input: {
  sendTool: SendMessageRuntimeTool;
  segments: ResponseSegment[];
  replyFirst: boolean;
  targetChatId?: string;
  requestLog?: RequestLog;
  log?: Logger;
}): Promise<void> {
  let sent = 0;
  for (const segment of input.segments) {
    sent += 1;
    const sendId = `final-send-${sent}`;
    if (segment.kind === "text") {
      await sendOneSegment({
        sendTool: input.sendTool,
        segment,
        sendId,
        reply: sent === 1 && input.replyFirst,
        targetChatId: input.targetChatId,
        requestLog: input.requestLog,
      });
      continue;
    }

    try {
      await sendOneSegment({
        sendTool: input.sendTool,
        segment,
        sendId,
        reply: sent === 1 && input.replyFirst,
        targetChatId: input.targetChatId,
        requestLog: input.requestLog,
      });
    } catch (error) {
      input.log?.warn("voice directive failed; falling back to text", {
        voiceType: segment.voiceType,
        error: makeToolErrorText(error),
      });
      await sendOneSegment({
        sendTool: input.sendTool,
        segment: { kind: "text", text: segment.text },
        sendId: `${sendId}-fallback`,
        reply: sent === 1 && input.replyFirst,
        targetChatId: input.targetChatId,
        requestLog: input.requestLog,
      });
    }
  }
}

/**
 * Core message handler. Evaluates triggers, runs a native tool-calling persona reply,
 * sends the final Discord text, then optionally schedules background memory extraction.
 */
export async function handleMessage(
  msg: IncomingMessage,
  deps: HandlerDeps
): Promise<HandleResult> {
  let triggerResult: TriggerResult;

  if (deps.forceTrigger === true) {
    triggerResult = { reason: "scheduled" };
  } else {
    const triggerInput: TriggerInput = {
      content: msg.content,
      authorId: msg.authorId,
      botUserId: msg.botUserId,
      mentionedUserIds: msg.mentionedUserIds,
    };

    triggerResult = shouldRespond(triggerInput, deps.guildConfig.triggers);
    if (triggerResult === null) {
      return { triggered: false, triggerResult: null, agentRan: false };
    }
  }

  deps.onTriggered?.(triggerResult);

  const triggerInstruction = deps.triggerInstructions?.[triggerResult.reason];
  let context = deps.context;
  if (triggerInstruction !== undefined && triggerInstruction !== "") {
    context = {
      ...context,
      sections: injectTriggerInstruction(context.sections, triggerInstruction),
    };
  }

  const model = resolveGuildModel(deps.globalConfig, deps.guildConfig);
  const baseStreamOptions = buildStreamOptions(deps.globalConfig, deps.guildConfig);
  const providerParams: Record<string, unknown> = { ...baseStreamOptions };
  delete providerParams.apiKey;
  delete providerParams.signal;
  delete providerParams.onPayload;

  const tools = [...(deps.extraTools ?? [])];
  const { tools: timedTools, state: timingState } = wrapToolsWithTiming(tools);
  const complete = deps.completeChat ?? completeOpenRouterChat;
  const stableSections = sectionsForStablePrompt(
    deps.personaPrompt ?? "",
    deps.globalConfig.defaultLateInstruction,
    context,
  );
  const userContent = context.userMessage !== "" ? context.userMessage : msg.translatedContent;
  const systemPrompt = buildSystemPrompt(context, timedTools);
  const reqLog = deps.requestLog;
  const startedAt = Date.now();

  try {
    deps.log?.debug("native_reply_loop_start", {
      model: model.id,
      toolNames: timedTools.map((tool) => tool.name),
      maxToolCalls: deps.guildConfig.replyLoop.maxToolCalls,
      wallClockTimeoutMs: deps.guildConfig.replyLoop.wallClockTimeoutMs,
      llmOutputTimeoutMs: deps.guildConfig.replyLoop.llmOutputTimeoutMs,
    });

    const wallController = new AbortController();
    const wallTimeout = setTimeout(() => {
      wallController.abort(new Error(`Native reply loop timed out after ${deps.guildConfig.replyLoop.wallClockTimeoutMs}ms`));
    }, deps.guildConfig.replyLoop.wallClockTimeoutMs);

    let finalText = "";
    let targetChatId: string | undefined;
    try {
      timingState.setReferenceTime();
      const result = await runNativeToolLoop({
        complete,
        requestBase: {
          apiKey: baseStreamOptions.apiKey,
          model: model.id,
          systemPrompt,
          providerParams,
          onPayload: (payload: unknown) => {
            prependStableSectionsToPayload(payload, stableSections, deps.guildConfig.promptCaching);
            reqLog?.recordLLMRequest(payload);
            deps.log?.debug("llm_request_payload", { payload });
          },
        },
        messages: buildInitialMessages(userContent),
        tools: timedTools,
        maxToolCalls: deps.guildConfig.replyLoop.maxToolCalls,
        maxToolRounds: deps.guildConfig.replyLoop.maxToolCalls,
        llmOutputTimeoutMs: deps.guildConfig.replyLoop.llmOutputTimeoutMs,
        requestLog: reqLog,
        signal: wallController.signal,
      });
      finalText = result.text;
      targetChatId = result.targetChatId;
    } finally {
      clearTimeout(wallTimeout);
    }

    const sendToolDeps: SendMessageToolDeps = {
      sender: deps.sender,
      ttsEnabled: deps.ttsEnabled ?? false,
      ttsConfig: deps.ttsConfig,
      generateSpeech: deps.generateSpeech,
    };
    const sendTool = createSendMessageTool(sendToolDeps);

    const parsedResponse = parseResponseDirectives(finalText);
    if (parsedResponse.ignored) {
      deps.log?.debug("native_reply_ignored", { durationMs: Date.now() - startedAt });
      return { triggered: true, triggerResult, agentRan: true };
    }
    if (parsedResponse.segments.length === 0) {
      deps.log?.debug("native_reply_empty_after_directives", { durationMs: Date.now() - startedAt });
      return { triggered: true, triggerResult, agentRan: true };
    }

    await sendResponseSegments({
      sendTool,
      segments: parsedResponse.segments,
      replyFirst: chooseReplyMode(triggerResult),
      targetChatId,
      requestLog: reqLog,
      log: deps.log,
    });

    const memoryReply = renderSegmentsForMemory(parsedResponse.segments);
    void deps.afterReply?.({
      sourceMessageId: msg.messageId,
      userMessage: userContent,
      assistantReply: memoryReply,
      recentContext: context.sections
        .filter((section) => !section.cached)
        .map((section) => section.text)
        .join("\n\n"),
    }).catch((error: unknown) => {
      deps.log?.warn("memory extraction failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    deps.log?.debug("native_reply_loop_end", {
      durationMs: Date.now() - startedAt,
      outputLength: memoryReply.length,
    });
    return { triggered: true, triggerResult, agentRan: true, responseText: memoryReply };
  } finally {
    deps.onAgentEnd?.();
  }
}
