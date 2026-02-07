import { Agent } from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import { streamSimple, type ProviderStreamOptions } from "@mariozechner/pi-ai";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { shouldRespond, type TriggerInput, type TriggerResult } from "./triggers.ts";
import { contextToSplitPrompts, type AssembledContext, type ContextSection, type SplitPrompts } from "./context-assembly.ts";
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
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

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
  /** Optional transform applied to context before each LLM call (e.g., inject follow-ups). */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
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

/**
 * Patch the tools array's `find` method to tolerate whitespace in LLM-returned
 * tool names. pi-agent-core does `tools.find(t => t.name === toolCall.name)` —
 * if the model returns `" send_message"` (leading space), the exact match fails.
 * This fallback probes common whitespace variants so the real tool is found.
 */
export function patchToolLookup(tools: AgentTool[]): void {
  const nativeFind = Array.prototype.find;
  const WS = ["", " ", "  "];
  Object.defineProperty(tools, "find", {
    value(predicate: (value: AgentTool, index: number, array: AgentTool[]) => boolean) {
      const exact = nativeFind.call(this, predicate) as AgentTool | undefined;
      if (exact !== undefined) return exact;
      for (const tool of this as AgentTool[]) {
        for (const pre of WS) {
          for (const suf of WS) {
            if (pre === "" && suf === "") continue;
            const probe = Object.create(tool, {
              name: { value: `${pre}${tool.name}${suf}`, enumerable: true },
            }) as AgentTool;
            if (predicate(probe, 0, this as AgentTool[])) return tool;
          }
        }
      }
      return undefined;
    },
    writable: true,
    configurable: true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isAnthropicModelPayload(payload: Record<string, unknown>): boolean {
  const model = payload.model;
  return typeof model === "string" && model.startsWith("anthropic/");
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

/**
 * Mutate OpenAI-compatible payload by prepending split prompt groups.
 * For Anthropic models on OpenRouter, attach cache breakpoints to stable prefix
 * groups and remove volatile cache breakpoints that would bust prefix caching.
 */
function prependSplitPromptsToPayload(payload: unknown, splitPrompts: SplitPrompts): void {
  if (!isRecord(payload)) return;
  const messages = payload.messages;
  if (!Array.isArray(messages)) return;

  const useAnthropicCacheControl = isAnthropicModelPayload(payload);
  if (useAnthropicCacheControl) {
    stripCacheControlFromMessages(messages);
  }

  const toInsert: Array<{ role: "system" | "developer"; content: unknown }> = [];
  if (splitPrompts.system !== "") {
    toInsert.push({
      role: "system",
      content: makePromptContent(splitPrompts.system, useAnthropicCacheControl),
    });
  }
  if (splitPrompts.cachedDeveloper !== "") {
    toInsert.push({
      role: "developer",
      content: makePromptContent(splitPrompts.cachedDeveloper, useAnthropicCacheControl),
    });
  }
  if (toInsert.length > 0) {
    messages.unshift(...toInsert);
  }
}

/**
 * Core message handler. Evaluates triggers, builds agent, runs prompt.
 *
 * Returns whether the bot was triggered and whether the agent ran.
 * The agent may choose not to use send_message (declining to respond).
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

  // Inject trigger-specific instruction if configured
  const triggerInstruction = deps.triggerInstructions?.[triggerResult.reason];
  let context = deps.context;
  if (triggerInstruction !== undefined && triggerInstruction !== "") {
    context = {
      ...context,
      sections: injectTriggerInstruction(context.sections, triggerInstruction),
    };
  }

  const splitPrompts = contextToSplitPrompts(context);
  // pi-ai only accepts a single systemPrompt string. We pass the volatile (uncached)
  // developer portion; the system and cached-developer portions are injected via
  // onPayload mutation (see below).
  const systemPrompt = splitPrompts.developer;
  const model = resolveGuildModel(deps.globalConfig, deps.guildConfig);
  const streamOptions = buildStreamOptions(deps.globalConfig, deps.guildConfig);

  const sendToolDeps: SendMessageToolDeps = {
    sender: deps.sender,
    ttsEnabled: deps.ttsEnabled ?? false,
    ttsConfig: deps.ttsConfig,
    generateSpeech: deps.generateSpeech,
  };
  const sendTool = createSendMessageTool(sendToolDeps) as unknown as AgentTool;
  const tools: AgentTool[] = [sendTool, ...(deps.extraTools ?? [])];
  patchToolLookup(tools);
  const { tools: timedTools, state: timingState } = wrapToolsWithTiming(tools);

  // Wrap with follow-up annotations if deps provided
  let finalTools: AgentTool[] = timedTools;
  if (deps.followUpDeps !== undefined) {
    finalTools = wrapToolsWithFollowUp(timedTools, deps.followUpDeps).tools;
  }

  const reqLog = deps.requestLog;
  let isFirstTurn = true;
  const forceFirst = deps.guildConfig.forceToolCallFirstRun;
  const disableParallel = deps.guildConfig.disableParallelToolCallsFirstRun;
  const wrappedStreamFn: typeof streamSimple = (model_, context, options) => {
    const firstTurn = isFirstTurn;
    isFirstTurn = false;
    return streamSimple(model_, context, {
      ...options,
      ...streamOptions,
      toolChoice: (firstTurn && forceFirst) ? "required" : undefined,
      parallelToolCalls: (firstTurn && disableParallel) ? false : undefined,
      onPayload: (payload: unknown) => {
        // pi-ai sends systemPrompt (the uncached developer portion) as a single
        // "developer" message. We prepend the cached portions so the final order is:
        //   [0] role=system    — tool instructions, persona, custom instructions (cached prefix)
        //   [1] role=developer — stable guild/thread context, older history (cached prefix)
        //   [2] role=developer — volatile channel context, journal, recent history, current context
        //   [3..] user/assistant/tool messages
        // This enables automatic prefix caching: messages [0] and [1] are stable
        // across requests, so providers cache them as a shared prefix.
        prependSplitPromptsToPayload(payload, splitPrompts);
        reqLog?.recordLLMRequest(payload);
      },
    } as ProviderStreamOptions);
  };

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: model as unknown as Model<never>,
      thinkingLevel: (deps.guildConfig.thinkingLevel ?? "off") as ThinkingLevel,
      tools: finalTools,
      messages: [],
    },
    convertToLlm: defaultConvertToLlm,
    streamFn: wrappedStreamFn,
    transformContext: deps.transformContext,
  });

  agent.getApiKey = () => streamOptions.apiKey;

  let assistantResponseNotified = false;
  agent.subscribe((e) => {
    if (e.type === "turn_start") {
      // Set timing reference when a new turn begins (before LLM call).
      // Tool timing then measures: LLM thinking + tool execution.
      timingState.setReferenceTime();
    }

    if (assistantResponseNotified) {
      if (e.type === "agent_end") deps.onAgentEnd?.();
      return;
    }

    if (e.type === "message_start" && "role" in e.message && e.message.role === "assistant") {
      assistantResponseNotified = true;
      deps.onAssistantResponseStart?.();
    }
    if (e.type === "message_update" && "role" in e.message && e.message.role === "assistant") {
      assistantResponseNotified = true;
      deps.onAssistantResponseStart?.();
    }
    if (e.type === "agent_end") {
      deps.onAgentEnd?.();
    }
  });

  if (deps.log !== undefined) {
    const agentLog = deps.log;
    const reqLog = deps.requestLog;
    agentLog.debug("agent tools", { tools: tools.map((t) => t.name) });
    agent.subscribe((e) => {
      switch (e.type) {
        case "agent_start":
          agentLog.debug("agent_start");
          break;
        case "agent_end":
          agentLog.debug("agent_end", { messageCount: e.messages.length });
          break;
        case "tool_execution_start":
          reqLog?.recordToolStart(e.toolCallId, e.toolName, e.args);
          break;
        case "tool_execution_end":
          reqLog?.recordToolEnd(e.toolCallId, e.isError, e.result);
          break;
        case "message_end":
          reqLog?.recordLLMCompletion(e.message as unknown as Record<string, unknown>);
          break;
        case "turn_start":
        case "turn_end":
        case "message_start":
        case "message_update":
        case "tool_execution_update":
          break;
      }
    });
  }

  const userContent = deps.context.userMessage !== "" ? deps.context.userMessage : msg.translatedContent;
  await agent.prompt(userContent);

  return { triggered: true, triggerResult, agentRan: true };
}

/**
 * Default message converter: passes through standard LLM message types.
 */
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m): m is Message =>
      typeof m === "object" &&
      "role" in m &&
      ["user", "assistant", "toolResult"].includes((m as { role: string }).role)
  );
}
