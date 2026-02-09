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
import type { PromptCachingConfig, TriggerInstructions } from "../config/types.ts";
import type { TtsConfig, TtsResult } from "../tts/types.ts";
import { resolveGuildModel, buildStreamOptions } from "../llm/client.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";
import type { Logger, RequestLog } from "../logger.ts";
import {
  buildStructuredActionProtocolPrompt,
  runStructuredActionLoop,
  type LoopMessage,
} from "./structured-actions.ts";
import { buildLateInstructionPrompt, resolvePromptPolicy } from "./prompt-policy.ts";
import { completeOpenRouterChat } from "../llm/openrouter-chat.ts";

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
  sender: MessageSender;
  /** Additional tools beyond send_message (memory, search, etc.). */
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

function combineLateInstruction(
  policyLateInstruction: string,
  configuredLateInstruction: string,
): string {
  if (configuredLateInstruction === "") return policyLateInstruction;
  if (policyLateInstruction === "") return configuredLateInstruction;
  return `${policyLateInstruction}\n\n${configuredLateInstruction}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return value;
}

function stripCacheControlFromMessages(messages: unknown[]): void {
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      if ("cache_control" in part) {
        delete part.cache_control;
      }
    }
  }
}

function makePromptContent(
  text: string,
  withCacheControl: boolean
): string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> {
  if (!withCacheControl) return text;
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

interface StablePromptSection {
  role: "system" | "developer";
  text: string;
}

function getStablePromptSections(context: AssembledContext): StablePromptSection[] {
  return context.sections
    .filter((section) => section.cached)
    .map((section) => ({ role: section.role, text: section.text }));
}

interface StablePromptGroup {
  role: "system" | "developer";
  text: string;
}

function groupStableSections(stableSections: StablePromptSection[]): StablePromptGroup[] {
  const groups = new Map<string, StablePromptGroup>();
  for (const section of stableSections) {
    const key = `${section.role}:cached`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { role: section.role, text: section.text });
      continue;
    }
    existing.text = `${existing.text}\n\n${section.text}`;
  }
  return [...groups.values()];
}

/**
 * Mutate OpenAI-compatible payload by prepending grouped stable context sections.
 * Stable sections are merged by (role, cached) buckets and keep original order within each bucket.
 */
function prependStableSectionsToPayload(
  payload: unknown,
  stableSections: StablePromptSection[],
  promptCaching: PromptCachingConfig
): void {
  if (!isRecord(payload)) return;
  const messages = payload.messages;
  if (!Array.isArray(messages)) return;

  if (promptCaching.enabled) stripCacheControlFromMessages(messages);

  const stableGroups = groupStableSections(stableSections);
  const toInsert = stableGroups.map((group, idx) => ({
    role: group.role,
    content: makePromptContent(group.text, promptCaching.enabled && idx === 0),
  }));
  if (toInsert.length > 0) {
    messages.unshift(...toInsert);
  }
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
  const tools: AgentTool[] = [sendTool, ...(deps.extraTools ?? [])];
  const { tools: timedTools, state: timingState } = wrapToolsWithTiming(tools);

  let finalTools: AgentTool[] = timedTools;
  if (deps.followUpDeps !== undefined) {
    finalTools = wrapToolsWithFollowUp(timedTools, deps.followUpDeps).tools;
  }

  const promptPolicy = resolvePromptPolicy(new Set(finalTools.map((tool) => tool.name)));
  const resolvedLateInstruction = combineLateInstruction(
    buildLateInstructionPrompt(promptPolicy),
    deps.globalConfig.defaultLateInstruction,
  );
  context = injectResolvedLateInstruction(context, resolvedLateInstruction);
  const stableSections = getStablePromptSections(context);
  const splitPrompts = contextToSplitPrompts(context);

  const reqLog = deps.requestLog;
  const llmComplete = deps.llmComplete;

  const actionProtocolPrompt = buildStructuredActionProtocolPrompt(finalTools, promptPolicy);
  const systemPrompt = [splitPrompts.developer, actionProtocolPrompt]
    .filter((part) => part !== "")
    .join("\n\n");

  let assistantResponseNotified = false;

  try {
    const userContent = deps.context.userMessage !== "" ? deps.context.userMessage : msg.translatedContent;

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
        deps.log?.debug("llm_output", { content: completion.text });

        if (!assistantResponseNotified) {
          assistantResponseNotified = true;
          deps.onAssistantResponseStart?.();
        }

        return {
          rawText: completion.text,
          responsePayload: completion.payload,
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
      signal: baseStreamOptions.signal as AbortSignal | undefined,
    });

    deps.log?.debug("structured action loop completed", {
      stopReason: loopResult.stopReason,
      turns: loopResult.turns,
      toolCalls: loopResult.toolCalls,
    });
  } finally {
    deps.onAgentEnd?.();
  }

  return { triggered: true, triggerResult, agentRan: true };
}
