import { Agent } from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { shouldRespond, type TriggerInput, type TriggerResult } from "./triggers.ts";
import { assembleSystemPrompt, type PromptContext } from "./prompt.ts";
import { createSendMessagesTool, type MessageSender } from "./send-messages-tool.ts";
import { resolveGuildModel, buildStreamOptions } from "../llm/client.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";
import type { Logger } from "../logger.ts";
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
  /** Multimodal image blocks, if any (handled by C.5 later). */
  images?: { type: "image"; data: string; mimeType: string }[];
}

/** Dependencies injected into the handler. No direct discord.js coupling. */
export interface HandlerDeps {
  globalConfig: GlobalConfig;
  guildConfig: GuildConfig;
  promptContext: PromptContext;
  sender: MessageSender;
  /** Additional tools beyond send_messages (memory, search, etc.). */
  extraTools?: AgentTool[];
  /** Logger for agent event tracing. */
  log?: Logger;
}

export interface HandleResult {
  triggered: boolean;
  triggerResult: TriggerResult;
  agentRan: boolean;
}

/**
 * Core message handler. Evaluates triggers, builds agent, runs prompt.
 *
 * Returns whether the bot was triggered and whether the agent ran.
 * The agent may choose not to use send_messages (declining to respond).
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

  const systemPrompt = assembleSystemPrompt(deps.promptContext);
  const model = resolveGuildModel(deps.globalConfig, deps.guildConfig);
  const streamOptions = buildStreamOptions(deps.globalConfig, deps.guildConfig);

  const sendTool = createSendMessagesTool(deps.sender) as unknown as AgentTool;
  const tools: AgentTool[] = [sendTool, ...(deps.extraTools ?? [])];

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: model as unknown as Model<never>,
      thinkingLevel: deps.guildConfig.thinkingLevel as ThinkingLevel,
      tools,
      messages: [],
    },
    convertToLlm: defaultConvertToLlm,
  });

  // Set stream options (apiKey etc.)
  // The Agent uses streamSimple under the hood which needs these
  // We pass apiKey via getApiKey callback
  agent.getApiKey = () => streamOptions.apiKey;

  if (deps.log !== undefined) {
    const agentLog = deps.log;
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
          agentLog.debug("tool_call", { tool: e.toolName, args: e.args });
          break;
        case "tool_execution_end":
          agentLog.debug("tool_result", { tool: e.toolName, isError: e.isError });
          break;
        case "message_end": {
          agentLog.debug("message_end", { message: e.message });
          const msg2 = e.message as unknown as Record<string, unknown>;
          if (msg2.role === "assistant" && msg2.usage !== undefined) {
            const usage = msg2.usage as Record<string, unknown>;
            const cost = usage.cost as Record<string, unknown> | undefined;
            agentLog.logTokenUsage({
              model: typeof msg2.model === "string" ? msg2.model : "unknown",
              promptTokens: typeof usage.input === "number" ? usage.input : 0,
              completionTokens: typeof usage.output === "number" ? usage.output : 0,
              totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : 0,
              estimatedCostUsd: typeof cost?.total === "number" ? cost.total : undefined,
            });
          }
          break;
        }
        case "turn_start":
        case "turn_end":
        case "message_start":
        case "message_update":
        case "tool_execution_update":
          break;
      }
    });
  }

  const userContent = msg.translatedContent;
  await agent.prompt(userContent, msg.images);

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
