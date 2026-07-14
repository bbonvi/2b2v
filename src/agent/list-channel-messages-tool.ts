import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { formatLocalWallClock } from "../time/agent-time.ts";
import type { HistoryMessage } from "./history-types.ts";
import { formatMessageLine } from "./history-formatting.ts";
import { resolveReplies } from "./history-replies.ts";

export type ListChannelMessage = HistoryMessage;

export interface ListChannelMessagesPage {
  messages: ListChannelMessage[];
}

export interface ListChannelMessagesInput {
  channelId: string;
  limit: number;
  beforeMessageId?: string;
  afterMessageId?: string;
  aroundMessageId?: string;
}

export interface ListChannelMessagesToolDeps {
  guildId: string;
  timezone: string;
  fetchMessages: (input: ListChannelMessagesInput) => Promise<ListChannelMessagesPage | null>;
}

const ListChannelMessagesParams = Type.Object({
  channel_id: Type.String({ description: "Guild channel or thread ID." }),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of messages to retrieve." })
  ),
  before_message_id: Type.Optional(Type.String({ description: "Fetch messages older than this message ID." })),
  after_message_id: Type.Optional(Type.String({ description: "Fetch messages newer than this message ID." })),
  around_message_id: Type.Optional(Type.String({ description: "Fetch messages surrounding and including this message ID." })),
});

export function createListChannelMessagesTool(deps: ListChannelMessagesToolDeps): AgentTool {
  const { timezone, fetchMessages } = deps;

  return {
    name: "list_channel_messages",
    label: "list_channel_messages",
    description: "Fetch recent messages from an accessible guild channel or thread.",
    parameters: ListChannelMessagesParams,

    async execute(
      _toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ count: number; oldest_message_id?: string; newest_message_id?: string } | { error: boolean }>> {
      const {
        channel_id,
        limit: rawLimit,
        before_message_id,
        after_message_id,
        around_message_id,
      } = params as {
        channel_id: string;
        limit?: number;
        before_message_id?: string;
        after_message_id?: string;
        around_message_id?: string;
      };
      const limit = Math.max(1, Math.min(rawLimit ?? 50, 100));
      const beforeMessageId = before_message_id?.trim();
      const afterMessageId = after_message_id?.trim();
      const aroundMessageId = around_message_id?.trim();
      const hasBeforeCursor = beforeMessageId !== undefined && beforeMessageId !== "";
      const hasAfterCursor = afterMessageId !== undefined && afterMessageId !== "";
      const hasAroundCursor = aroundMessageId !== undefined && aroundMessageId !== "";

      if (Number(hasBeforeCursor) + Number(hasAfterCursor) + Number(hasAroundCursor) > 1) {
        return {
          content: [{ type: "text", text: "Use only one of before_message_id, after_message_id, or around_message_id." }],
          details: { error: true },
        };
      }

      let page: ListChannelMessagesPage | null;
      try {
        page = await fetchMessages({
          channelId: channel_id,
          limit,
          ...(beforeMessageId !== undefined && beforeMessageId !== "" ? { beforeMessageId } : {}),
          ...(afterMessageId !== undefined && afterMessageId !== "" ? { afterMessageId } : {}),
          ...(aroundMessageId !== undefined && aroundMessageId !== "" ? { aroundMessageId } : {}),
        });
      } catch {
        return {
          content: [{ type: "text", text: "Unable to fetch channel history; the bot may lack permission to read this channel." }],
          details: { error: true },
        };
      }
      if (page === null) {
        return {
          content: [{ type: "text", text: "Channel or cursor message not found, or the bot may lack permission to read it." }],
          details: { error: true },
        };
      }

      const { messages } = page;
      if (messages.length === 0) {
        return {
          content: [{ type: "text", text: "No messages found in this channel." }],
          details: { count: 0 },
        };
      }

      const replies = resolveReplies({
        older: [],
        newer: messages,
        latestUserMessage: null,
        replyQuoteChars: 200,
      }).newer;
      const oldestMessageId = messages[0]?.id;
      const newestMessageId = messages[messages.length - 1]?.id;
      const cursorLine = `Page cursors: oldest_message_id=${oldestMessageId ?? ""}; newest_message_id=${newestMessageId ?? ""}. Use before_message_id for older messages or after_message_id for newer messages.`;
      const lines = [
        "Channel messages, ordered oldest to newest.",
        ...messages.map((message) => `[${formatLocalWallClock(message.timestamp, timezone)}]\n${formatMessageLine({
          message,
          reply: replies.get(message.id) ?? null,
          includeMessageIds: true,
        })}`),
        cursorLine,
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: messages.length,
          ...(oldestMessageId !== undefined ? { oldest_message_id: oldestMessageId } : {}),
          ...(newestMessageId !== undefined ? { newest_message_id: newestMessageId } : {}),
        },
      };
    },
  };
}
