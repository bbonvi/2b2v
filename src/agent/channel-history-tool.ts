import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

export interface ChannelMessage {
  id: string;
  authorUsername: string;
  content: string;
  createdAt: number;
}

export interface ChannelHistoryToolDeps {
  guildId: string;
  fetchMessages: (channelId: string, limit: number) => Promise<ChannelMessage[]>;
}

const ChannelHistoryParams = Type.Object({
  channelId: Type.String({ description: "The channel ID to fetch history from." }),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of messages to retrieve. Default: 50, max: 100." })
  ),
});

export function createChannelHistoryTool(deps: ChannelHistoryToolDeps): AgentTool {
  const { fetchMessages } = deps;

  return {
    name: "channel_history",
    label: "channel_history",
    description:
      "Fetch recent messages from a Discord channel. Useful for reviewing conversation context in a specific channel.",
    parameters: ChannelHistoryParams,

    async execute(
      _toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ count: number } | { error: boolean }>> {
      const { channelId, limit: rawLimit } = params as { channelId: string; limit?: number };
      const limit = Math.min(rawLimit ?? 50, 100);

      let messages: ChannelMessage[];
      try {
        messages = await fetchMessages(channelId, limit);
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

      const lines = messages.map((m) => formatMessage(m));
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: messages.length },
      };
    },
  };
}

function formatMessage(m: ChannelMessage): string {
  const date = new Date(m.createdAt).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return `[${date}] ${m.authorUsername}: ${m.content}`;
}
