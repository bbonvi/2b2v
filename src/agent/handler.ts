import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  Message,
  Model,
  ProviderStreamOptions,
} from "@mariozechner/pi-ai";
import { shouldRespond, type TriggerInput, type TriggerResult } from "./triggers.ts";
import { contextToSplitPrompts, type AssembledContext, type ContextSection } from "./context-assembly.ts";
import { createSendMessageTool, type MessageSender, type SendMessageToolDeps } from "./send-message-tool.ts";
import { wrapToolsWithTiming } from "./tool-timing.ts";
import { wrapToolsWithFollowUp } from "./tool-followup-wrapper.ts";
import type { FollowUpWrapperDeps } from "./tool-followup-wrapper.ts";
export type { FollowUpState, FollowUpWrapperDeps } from "./tool-followup-wrapper.ts";
import type { TriggerInstructions } from "../config/types.ts";
import type { TtsConfig, TtsResult } from "../tts/types.ts";
import { resolveGuildModel, buildStreamOptions } from "../llm/client.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";
import type { Logger, RequestLog } from "../logger.ts";
import {
  buildStructuredActionProtocolPrompt,
  runStructuredActionLoop,
  type LoopMessage,
  type PersonaTurnAction,
  type StructuredLoopEvent,
} from "./structured-actions.ts";
import { buildLateInstructionPrompt, resolvePromptPolicy } from "./prompt-policy.ts";
import { completeOpenRouterChat } from "../llm/openrouter-chat.ts";
import {
  getStablePromptSections,
  prependStableSectionsToPayload,
  type StablePromptSection,
} from "./prompt-cache.ts";

/** Minimal abstraction over a Discord message for the handler. */
export interface IncomingMessage {
  content: string;
  authorId: string;
  authorUsername: string;
  botUserId: string;
  mentionedUserIds: string[];
  /** Pre-translated (inbound) content for LLM consumption. */
  translatedContent: string;
}

export type LlmCompleteFn = (
  model: Model<never>,
  context: { systemPrompt?: string; messages: Message[] },
  options: ProviderStreamOptions,
) => Promise<AssistantMessage>;

/** Dependencies injected into the handler. No direct discord.js coupling. */
export interface HandlerDeps {
  globalConfig: GlobalConfig;
  guildConfig: GuildConfig;
  context: AssembledContext;
  /** Persona prompt used only by runtime persona_turn calls, not by the outer orchestrator. */
  personaPrompt?: string;
  sender: MessageSender;
  /** Orchestrator tools beyond runtime persona_turn (memory, search, etc.). */
  extraTools?: AgentTool[];
  /** Logger for agent event tracing. */
  log?: Logger;
  /** Called when a trigger matches, before the agent runs. Receives trigger result. */
  onTriggered?: (result: NonNullable<TriggerResult>) => void;
  /** Called when the first assistant response starts streaming. */
  onAssistantResponseStart?: () => void;
  /** Called when the agent finishes, regardless of response. */
  onAgentEnd?: () => void;
  /** Request-scoped log accumulator. */
  requestLog?: RequestLog;
  /** TTS configuration for voice messages. */
  ttsConfig?: TtsConfig;
  /** Whether TTS is enabled (requires API key + config). */
  ttsEnabled?: boolean;
  /** Function to generate speech from text (injected by caller). */
  generateSpeech?: (text: string, voiceType: string) => Promise<TtsResult>;
  /** Skip trigger evaluation and always run the agent (for scheduled tasks). */
  forceTrigger?: boolean;
  /** Per-trigger-type instructions to inject into context. */
  triggerInstructions?: TriggerInstructions;
  /** Follow-up wrapper deps for mid-loop context injection. */
  followUpDeps?: FollowUpWrapperDeps;
  /** Optional transform applied before each LLM call (e.g., inject follow-ups). */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** Optional injected completion function for tests. */
  llmComplete?: LlmCompleteFn;
}

export interface HandleResult {
  triggered: boolean;
  triggerResult: TriggerResult;
  agentRan: boolean;
}

/**
 * Inject a trigger-specific instruction into context sections.
 * Inserts before "Late Instruction" section if present, otherwise appends.
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
  const lateIdx = sections.findIndex((s) => s.label === "Late Instruction");
  if (lateIdx === -1) {
    return [...sections, newSection];
  }
  return [...sections.slice(0, lateIdx), newSection, ...sections.slice(lateIdx)];
}

function injectResolvedLateInstruction(
  context: AssembledContext,
  lateInstruction: string,
): AssembledContext {
  const lateIdx = context.sections.findIndex((section) => section.label === "Late Instruction");
  if (lateIdx !== -1) {
    return {
      ...context,
      sections: context.sections.map((section, idx) => idx === lateIdx ? { ...section, text: lateInstruction } : section),
    };
  }
  return {
    ...context,
    sections: [
      ...context.sections,
      {
        label: "Late Instruction",
        text: lateInstruction,
        cached: false,
        role: "developer",
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return value;
}

function messageContentToText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const textParts: string[] = [];
  for (const part of content) {
    const rec = asRecord(part);
    if (rec === null) continue;
    if (rec.type === "text" && typeof rec.text === "string") {
      textParts.push(rec.text);
    }
  }
  if (textParts.length === 0) return null;
  return textParts.join("\n");
}

function loopMessagesToAgentMessages(messages: LoopMessage[]): AgentMessage[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
  } as AgentMessage));
}

function agentMessagesToLoopMessages(messages: AgentMessage[]): LoopMessage[] {
  const converted: LoopMessage[] = [];
  for (const message of messages) {
    const rec = asRecord(message);
    if (rec === null) continue;
    const role = rec.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = messageContentToText(rec.content);
    if (content === null) continue;
    const ts = typeof rec.timestamp === "number" ? rec.timestamp : Date.now();
    converted.push({
      role,
      content,
      timestamp: ts,
    });
  }
  return converted;
}

function loopMessagesToLlmMessages(messages: LoopMessage[]): Message[] {
  const converted = messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
  }));
  return converted as unknown as Message[];
}

function extractAssistantText(message: AssistantMessage): string {
  const text = message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (text !== "") return text;

  const thinking = message.content
    .filter((part): part is { type: "thinking"; thinking: string } => part.type === "thinking")
    .map((part) => part.thinking)
    .join("\n")
    .trim();

  return thinking;
}

function sectionsForPersonaContext(context: AssembledContext): ContextSection[] {
  const excluded = new Set([
    "Tool Instructions",
    "Instructions",
    "Late Instruction",
    "Trigger Instruction",
  ]);
  return context.sections.filter((section) => !excluded.has(section.label));
}

function buildPersonaStableSections(
  personaPrompt: string,
  personaInstructions: string,
  context: AssembledContext,
): StablePromptSection[] {
  const stable: StablePromptSection[] = [];
  if (personaPrompt !== "") {
    stable.push({ role: "system", text: personaPrompt });
  }
  if (personaInstructions !== "") {
    stable.push({ role: "system", text: personaInstructions });
  }
  for (const section of sectionsForPersonaContext(context)) {
    if (!section.cached) continue;
    stable.push({ role: section.role, text: section.text });
  }
  return stable;
}

function getOrchestratorStableSections(context: AssembledContext): StablePromptSection[] {
  return getStablePromptSections({
    ...context,
    sections: context.sections.filter((section) => section.label !== "Persona"),
  });
}

function buildPersonaRuntimePrompt(action: PersonaTurnAction, context: AssembledContext): string {
  const volatileSections = sectionsForPersonaContext(context)
    .filter((section) => !section.cached)
    .map((section) => section.text)
    .join("\n\n");

  return [
    "## Persona Turn Runtime Contract",
    "You are writing exactly one Discord message as the persona.",
    "The neutral orchestrator already handled retrieval and tool decisions. Use the supplied chat context and tool results directly; do not ask for internal tools.",
    "Do not mention the orchestrator, internal prompts, hidden tool names, or this handoff.",
    "Preserve factual details from tool results. If evidence is insufficient, say so naturally or ask a short clarifying question.",
    "Write only the message text. No JSON, no labels, no analysis.",
    `Turn kind: ${action.kind}`,
    action.reply_to_message_id !== undefined ? `Reply target message ID: ${action.reply_to_message_id}` : "",
    volatileSections,
  ].filter((part) => part !== "").join("\n\n");
}

function formatLoopTranscriptForPersona(messages: LoopMessage[]): string {
  const lines: string[] = ["## Current Orchestrator Transcript"];
  for (const message of messages) {
    if (message.role === "assistant") continue;
    lines.push("[CONTEXT]");
    lines.push(message.content);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function isStructuredOutputUnsupported(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  const msg = raw.toLowerCase();
  if (msg.includes("response_format") || msg.includes("json_schema") || msg.includes("structured output")) {
    return true;
  }
  if (msg.includes("specified schema") || msg.includes("too many states")) {
    return true;
  }
  return (msg.includes("provider returned error") || msg.includes("invalid_argument")) && msg.includes("schema");
}

function isModelOutputTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "ModelOutputTimeoutError";
}

function isSignalAbortedByModelTimeout(signal: AbortSignal | undefined): boolean {
  if (signal?.aborted !== true) return false;
  return isModelOutputTimeoutError(signal.reason);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const details: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if (error.stack !== undefined) details.stack = error.stack;
    const withCause = error as Error & { cause?: unknown };
    if (withCause.cause !== undefined) {
      if (withCause.cause instanceof Error) {
        details.cause = serializeError(withCause.cause);
      } else if (
        typeof withCause.cause === "string"
        || typeof withCause.cause === "number"
        || typeof withCause.cause === "boolean"
        || withCause.cause === null
      ) {
        details.cause = withCause.cause;
      } else {
        details.cause = "non-error cause";
      }
    }
    return details;
  }
  return { message: String(error) };
}

/**
 * Core message handler. Evaluates triggers, builds action loop, runs prompt.
 *
 * Returns whether the bot was triggered and whether the agent ran.
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

  const sendToolDeps: SendMessageToolDeps = {
    sender: deps.sender,
    ttsEnabled: deps.ttsEnabled ?? false,
    ttsConfig: deps.ttsConfig,
    generateSpeech: deps.generateSpeech,
  };
  const sendTool = createSendMessageTool(sendToolDeps) as unknown as AgentTool;
  const tools: AgentTool[] = [...(deps.extraTools ?? [])];
  const { tools: timedTools, state: timingState } = wrapToolsWithTiming(tools);

  let finalTools: AgentTool[] = timedTools;
  if (deps.followUpDeps !== undefined) {
    finalTools = wrapToolsWithFollowUp(timedTools, deps.followUpDeps).tools;
  }

  const promptPolicy = resolvePromptPolicy(new Set(finalTools.map((tool) => tool.name)));
  const resolvedLateInstruction = buildLateInstructionPrompt(promptPolicy);
  context = injectResolvedLateInstruction(context, resolvedLateInstruction);
  const stableSections = getOrchestratorStableSections(context);
  const personaStableSections = buildPersonaStableSections(
    deps.personaPrompt ?? "",
    deps.globalConfig.defaultLateInstruction,
    context,
  );
  const splitPrompts = contextToSplitPrompts(context);

  const reqLog = deps.requestLog;
  const llmComplete = deps.llmComplete;

  const actionProtocolPrompt = buildStructuredActionProtocolPrompt(finalTools, promptPolicy);
  const systemPrompt = [splitPrompts.developer, actionProtocolPrompt]
    .filter((part) => part !== "")
    .join("\n\n");

  let assistantResponseNotified = false;
  const loopStartedAt = Date.now();
  let llmCallSeq = 0;

  try {
    const userContent = deps.context.userMessage !== "" ? deps.context.userMessage : msg.translatedContent;
    deps.log?.debug("structured_loop_start", {
      initialUserContentLength: userContent.length,
      maxToolCalls: deps.guildConfig.actionLoop.maxToolCalls,
      wallClockTimeoutMs: deps.guildConfig.actionLoop.wallClockTimeoutMs,
      llmOutputTimeoutMs: deps.guildConfig.actionLoop.llmOutputTimeoutMs,
      toolNames: finalTools.map((tool) => tool.name),
    });

    const loopResult = await runStructuredActionLoop({
      initialMessages: [
        {
          role: "user",
          content: userContent,
          timestamp: Date.now(),
        },
      ],
      tools: finalTools,
      maxToolCalls: deps.guildConfig.actionLoop.maxToolCalls,
      wallClockTimeoutMs: deps.guildConfig.actionLoop.wallClockTimeoutMs,
      llmOutputTimeoutMs: deps.guildConfig.actionLoop.llmOutputTimeoutMs,
      callModel: async (messages, responseFormat, signal) => {
        const llmCallId = `llm-${++llmCallSeq}`;
        const llmCallStartedAt = Date.now();
        deps.log?.debug("llm_request_start", {
          llmCallId,
          model: model.id,
          messageCount: messages.length,
          responseFormatType: typeof responseFormat.type === "string" ? responseFormat.type : "unknown",
        });
        timingState.setReferenceTime();

        const transformedLoopMessages = deps.transformContext !== undefined
          ? agentMessagesToLoopMessages(
            await deps.transformContext(loopMessagesToAgentMessages(messages), signal),
          )
          : messages;

        const llmMessages = loopMessagesToLlmMessages(transformedLoopMessages);

        const makeOptions = (includeStructuredOutput: boolean): ProviderStreamOptions => ({
          ...baseStreamOptions,
          ...(includeStructuredOutput ? { response_format: responseFormat } : {}),
          signal,
          onPayload: (payload: unknown) => {
            prependStableSectionsToPayload(payload, stableSections, deps.guildConfig.promptCaching);
            reqLog?.recordLLMRequest(payload);
            deps.log?.debug("llm_request_payload", {
              llmCallId,
              payload,
            });
          },
        });

        const completionViaInjected = async (includeStructuredOutput: boolean): Promise<{
          text: string;
          payload: Record<string, unknown>;
        }> => {
          const complete = llmComplete;
          if (complete === undefined) {
            const providerParams: Record<string, unknown> = { ...baseStreamOptions };
            delete providerParams.apiKey;
            delete providerParams.signal;
            delete providerParams.onPayload;
            const result = await completeOpenRouterChat({
              apiKey: baseStreamOptions.apiKey,
              model: model.id,
              systemPrompt,
              messages: transformedLoopMessages.map((message) => ({
                role: message.role,
                content: message.content,
              })),
              providerParams,
              responseFormat: includeStructuredOutput ? responseFormat : undefined,
              signal,
              onPayload: (payload: unknown) => {
                prependStableSectionsToPayload(payload, stableSections, deps.guildConfig.promptCaching);
                reqLog?.recordLLMRequest(payload);
                deps.log?.debug("llm_request_payload", {
                  llmCallId,
                  payload,
                });
              },
            });
            return {
              text: result.text,
              payload: result.messageForLogs,
            };
          }

          const completion = await complete(
            model as unknown as Model<never>,
            { systemPrompt, messages: llmMessages },
            makeOptions(includeStructuredOutput),
          );
          return {
            text: extractAssistantText(completion),
            payload: completion as unknown as Record<string, unknown>,
          };
        };

        let completion: { text: string; payload: Record<string, unknown> };
        try {
          completion = await completionViaInjected(true);
        } catch (error) {
          if (!isSignalAbortedByModelTimeout(signal)) {
            deps.log?.debug("llm_request_error", {
              llmCallId,
              model: model.id,
              durationMs: Date.now() - llmCallStartedAt,
              error: serializeError(error),
            });
          }
          if (!isStructuredOutputUnsupported(error)) {
            throw error;
          }
          deps.log?.warn("structured output unsupported, retrying without response_format", {
            model: model.id,
            error: error instanceof Error ? error.message : String(error),
          });
          completion = await completionViaInjected(false);
        }

        reqLog?.recordLLMCompletion(completion.payload);
        deps.log?.debug("llm_response", {
          llmCallId,
          model: model.id,
          durationMs: Date.now() - llmCallStartedAt,
          outputLength: completion.text.length,
        });
        deps.log?.debug("llm_response_payload", {
          llmCallId,
          response: completion.payload,
        });
        deps.log?.debug("llm_output", { content: completion.text });

        if (!assistantResponseNotified) {
          assistantResponseNotified = true;
          deps.onAssistantResponseStart?.();
        }

        return {
          rawText: completion.text,
          responsePayload: completion.payload,
          actionContextMessages: transformedLoopMessages,
        };
      },
      onToolCall: async (tool, toolCallId, args, signal) => {
        reqLog?.recordToolStart(toolCallId, tool.name, args);
        try {
          const result = await tool.execute(toolCallId, args, signal);
          reqLog?.recordToolEnd(toolCallId, false, result);
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown tool execution error";
          reqLog?.recordToolEnd(toolCallId, true, {
            content: [{ type: "text", text: message }],
          });
          throw error;
        }
      },
      onPersonaTurn: async (action, actionId, messages, signal) => {
        const personaSystemPrompt = buildPersonaRuntimePrompt(action, context);
        const personaUserPrompt = formatLoopTranscriptForPersona(messages);
        const providerParams: Record<string, unknown> = { ...baseStreamOptions };
        delete providerParams.apiKey;
        delete providerParams.signal;
        delete providerParams.onPayload;

        let generatedText = "";
        const personaCallId = `${actionId}-llm`;
        const personaStartedAt = Date.now();
        deps.log?.debug("persona_turn_request_start", {
          personaCallId,
          actionId,
          kind: action.kind,
          model: model.id,
        });

        if (llmComplete === undefined) {
          const result = await completeOpenRouterChat({
            apiKey: baseStreamOptions.apiKey,
            model: model.id,
            systemPrompt: personaSystemPrompt,
            messages: [{ role: "user", content: personaUserPrompt }],
            providerParams,
            signal,
            onPayload: (payload: unknown) => {
              prependStableSectionsToPayload(payload, personaStableSections, deps.guildConfig.promptCaching);
              reqLog?.recordLLMRequest(payload);
              deps.log?.debug("persona_turn_request_payload", { personaCallId, payload });
            },
          });
          generatedText = result.text.trim();
          reqLog?.recordLLMCompletion(result.messageForLogs);
          deps.log?.debug("persona_turn_response_payload", { personaCallId, response: result.messageForLogs });
        } else {
          const completion = await llmComplete(
            model as unknown as Model<never>,
            {
              systemPrompt: personaSystemPrompt,
              messages: [{ role: "user", content: personaUserPrompt, timestamp: Date.now() } as unknown as Message],
            },
            {
              ...baseStreamOptions,
              signal,
              onPayload: (payload: unknown) => {
                prependStableSectionsToPayload(payload, personaStableSections, deps.guildConfig.promptCaching);
                reqLog?.recordLLMRequest(payload);
                deps.log?.debug("persona_turn_request_payload", { personaCallId, payload });
              },
            } as ProviderStreamOptions,
          );
          generatedText = extractAssistantText(completion).trim();
          reqLog?.recordLLMCompletion(completion as unknown as Record<string, unknown>);
        }

        deps.log?.debug("persona_turn_response", {
          personaCallId,
          durationMs: Date.now() - personaStartedAt,
          outputLength: generatedText.length,
        });

        if (generatedText === "") {
          throw new Error("Persona turn produced an empty message");
        }

        const sendArgs: Record<string, unknown> = {
          text: generatedText,
          reply: action.reply,
          ...(action.chat_id !== undefined ? { chat_id: action.chat_id } : {}),
          ...(action.is_voice_message !== undefined ? { is_voice_message: action.is_voice_message } : {}),
          ...(action.voice_type !== undefined ? { voice_type: action.voice_type } : {}),
          ...(action.reply_to_message_id !== undefined ? { reply_to_message_id: action.reply_to_message_id } : {}),
        };
        reqLog?.recordToolStart(`${actionId}-send`, "send_message", sendArgs);
        const result = await sendTool.execute(`${actionId}-send`, sendArgs, signal);
        reqLog?.recordToolEnd(`${actionId}-send`, false, result);
        const sentSummary = result.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        return {
          content: [{
            type: "text",
            text: [
              sentSummary !== "" ? sentSummary : "Persona message sent.",
              `Text: ${generatedText}`,
            ].join("\n"),
          }],
          details: result.details,
        };
      },
      signal: baseStreamOptions.signal as AbortSignal | undefined,
      onLoopEvent: (event: StructuredLoopEvent) => {
        deps.log?.debug("structured_loop_event", event as unknown as Record<string, unknown>);
      },
    });

    deps.log?.debug("structured action loop completed", {
      stopReason: loopResult.stopReason,
      turns: loopResult.turns,
      toolCalls: loopResult.toolCalls,
      durationMs: Date.now() - loopStartedAt,
    });

    if (loopResult.stopReason === "timeout") {
      const timeoutCause = loopResult.timeoutCause ?? "unknown";
      throw new Error(
        `Structured action loop timed out (cause=${timeoutCause}, turns=${loopResult.turns}, toolCalls=${loopResult.toolCalls}, `
        + `wallClockTimeoutMs=${deps.guildConfig.actionLoop.wallClockTimeoutMs}, `
        + `llmOutputTimeoutMs=${deps.guildConfig.actionLoop.llmOutputTimeoutMs})`,
      );
    }
  } finally {
    deps.log?.debug("structured_loop_end", {
      durationMs: Date.now() - loopStartedAt,
    });
    deps.onAgentEnd?.();
  }

  return { triggered: true, triggerResult, agentRan: true };
}
