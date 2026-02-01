import { Agent } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { shouldRespond, type TriggerInput, type TriggerResult } from "./triggers.ts";
import { assembleSystemPrompt, type PromptContext, type ChatMessage } from "./prompt.ts";
import { createSendMessagesTool, type MessageSender } from "./send-messages-tool.ts";
import { resolveGuildModel, buildStreamOptions } from "../llm/client.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";
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
  extraTools?: any[];
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

  const sendTool = createSendMessagesTool(deps.sender);
  const tools = [sendTool, ...(deps.extraTools ?? [])];

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: model as any,
      thinkingLevel: deps.guildConfig.thinkingLevel as ThinkingLevel,
      tools,
      messages: [],
    },
    convertToLlm: defaultConvertToLlm,
  });

  // Set stream options (apiKey etc.)
  // The Agent uses streamSimple under the hood which needs these
  // We pass apiKey via getApiKey callback
  agent.getApiKey = async () => streamOptions.apiKey;

  const userContent = msg.translatedContent;
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
      m !== null &&
      "role" in m &&
      (m.role === "user" || m.role === "assistant" || m.role === "toolResult")
  );
}
