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
  fetchMessages: (channelId: string, limit: number) => Promise<ChatHistoryMessage[]>;
}

const ChatHistoryParams = Type.Object({
  channel_id: Type.String({ description: "The guild channel or thread ID to fetch history from. DMs are not supported." }),
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
      "Fetch recent messages from an accessible Discord guild channel or thread, including channels in other guilds. Useful for reviewing conversation context in a specific channel or thread. DMs are not supported.",
    parameters: ChatHistoryParams,

    async execute(
      _toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ count: number } | { error: boolean }>> {
      const { channel_id, limit: rawLimit } = params as { channel_id: string; limit?: number };
      const limit = Math.min(rawLimit ?? 50, 100);

      let messages: ChatHistoryMessage[];
      try {
        messages = await fetchMessages(channel_id, limit);
      } catch {
        return {
          content: [{ type: "text", text: "Unable to fetch channel history. The bot may lack permission to read this channel." }],
          details: { error: true },
        };
      }

      if (messages.length === 0) {
        return {
          content: [{ type: "text", text: "No messages found in this channel." }],
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
