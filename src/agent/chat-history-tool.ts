import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { formatLocalWallClock } from "../time/agent-time.ts";

export interface ChatHistoryMessage {
  id: string;
  authorUsername: string;
  content: string;
  createdAt: number;
}

export interface ChatHistoryToolDeps {
  guildId: string;
  timezone: string;
  fetchMessages: (chatId: string, limit: number) => Promise<ChatHistoryMessage[]>;
}

const ChatHistoryParams = Type.Object({
  chat_id: Type.String({ description: "The chat ID to fetch history from (channel, thread, or DM)." }),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of messages to retrieve. Default: 50, max: 100." })
  ),
});

export function createChatHistoryTool(deps: ChatHistoryToolDeps): AgentTool {
  const { timezone, fetchMessages } = deps;

  return {
    name: "chat_history",
    label: "chat_history",
    description:
      "Fetch recent messages from a Discord chat. Useful for reviewing conversation context in a specific channel, thread, or DM.",
    parameters: ChatHistoryParams,

    async execute(
      _toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ count: number } | { error: boolean }>> {
      const { chat_id, limit: rawLimit } = params as { chat_id: string; limit?: number };
      const limit = Math.min(rawLimit ?? 50, 100);

      let messages: ChatHistoryMessage[];
      try {
        messages = await fetchMessages(chat_id, limit);
      } catch {
        return {
          content: [{ type: "text", text: "Unable to fetch chat history. The bot may lack permission to read this chat." }],
          details: { error: true },
        };
      }

      if (messages.length === 0) {
        return {
          content: [{ type: "text", text: "No messages found in this chat." }],
          details: { count: 0 },
        };
      }

      const lines = messages.map((m) => formatMessage(m, timezone));
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: messages.length },
      };
    },
  };
}

function formatMessage(m: ChatHistoryMessage, timezone: string): string {
  const date = formatLocalWallClock(m.createdAt, timezone);
  return `[${date}] ${m.authorUsername}: ${m.content}`;
}
