import { Agent } from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { shouldRespond, type TriggerInput, type TriggerResult } from "./triggers.ts";
import { contextToSystemPrompt, type AssembledContext } from "./context-assembly.ts";
import { createSendMessageTool, type MessageSender } from "./send-message-tool.ts";
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
  /** Called when a trigger matches, before the agent runs. Use for eager typing. */
  onTriggered?: () => void;
  /** Request-scoped log accumulator. */
  requestLog?: RequestLog;
}

export interface HandleResult {
  triggered: boolean;
  triggerResult: TriggerResult;
  agentRan: boolean;
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
  const triggerInput: TriggerInput = {
    content: msg.content,
    authorId: msg.authorId,
    botUserId: msg.botUserId,
    mentionedUserIds: msg.mentionedUserIds,
  };

  const triggerResult = shouldRespond(triggerInput, deps.guildConfig.triggers);
  if (!triggerResult) {
    return { triggered: false, triggerResult: null, agentRan: false };
  }

  deps.onTriggered?.();

  const systemPrompt = contextToSystemPrompt(deps.context);
  const model = resolveGuildModel(deps.globalConfig, deps.guildConfig);
  const streamOptions = buildStreamOptions(deps.globalConfig, deps.guildConfig);

  const sendTool = createSendMessageTool(deps.sender) as unknown as AgentTool;
  const tools: AgentTool[] = [sendTool, ...(deps.extraTools ?? [])];
  patchToolLookup(tools);

  const reqLog = deps.requestLog;
  const wrappedStreamFn: typeof streamSimple = (model_, context, options) => {
    return streamSimple(model_, context, {
      ...options,
      ...streamOptions,
      onPayload: (payload: unknown) => {
        reqLog?.recordLLMRequest(payload);
      },
    });
  };

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: model as unknown as Model<never>,
      thinkingLevel: deps.guildConfig.thinkingLevel as ThinkingLevel,
      tools,
      messages: [],
    },
    convertToLlm: defaultConvertToLlm,
    streamFn: wrappedStreamFn,
  });

  agent.getApiKey = () => streamOptions.apiKey;

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
