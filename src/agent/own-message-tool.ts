import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const EditOwnMessageParams = Type.Object({
  message_id: Type.String({ description: "Discord message ID to edit." }),
  content: Type.String({ description: "Replacement message content." }),
  channel_id: Type.Optional(Type.String({ description: "Guild channel or thread containing the bot-authored message." })),
});

const DeleteOwnMessageParams = Type.Object({
  message_id: Type.String({ description: "Discord message ID to delete." }),
  channel_id: Type.Optional(Type.String({ description: "Guild channel or thread containing the bot-authored message." })),
});

export type EditOwnMessageInput = Static<typeof EditOwnMessageParams>;
export type DeleteOwnMessageInput = Static<typeof DeleteOwnMessageParams>;

export interface OwnMessageLookup {
  id: string;
  guildId: string | null;
  channelId: string;
  authorId: string;
  authorUsername: string;
  content: string;
  createdAt: number;
  replyToId: string | null;
}

export interface OwnMessageStateInput {
  messageId: string;
  guildId: string;
  channelId: string;
}

export interface OwnMessageEditStateInput extends OwnMessageStateInput {
  botUserId: string;
  botUsername: string;
  rawContent: string;
  translatedContent: string;
  createdAt: number;
  replyToId: string | null;
}

export interface OwnMessageToolsDeps {
  currentChannelId: string;
  botUserId: string;
  fetchMessage: (channelId: string, messageId: string) => Promise<OwnMessageLookup | null>;
  editMessage: (channelId: string, messageId: string, content: string) => Promise<{ rawContent: string }>;
  deleteMessage: (channelId: string, messageId: string) => Promise<void>;
  afterEdit: (input: OwnMessageEditStateInput) => Promise<void>;
  afterDelete: (input: OwnMessageStateInput) => Promise<void>;
}

interface AuthorizedOwnMessage {
  channelId: string;
  message: OwnMessageLookup & { guildId: string };
}

function firstText(result: "edit" | "delete", messageId: string): string {
  return result === "edit"
    ? `Edited own message ${messageId}.`
    : `Deleted own message ${messageId}.`;
}

/**
 * Resolve and authorize a message mutation against the live Discord message.
 * Only guild messages authored by the current bot user are accepted.
 */
export async function authorizeOwnMessageOperation(
  deps: Pick<OwnMessageToolsDeps, "currentChannelId" | "botUserId" | "fetchMessage">,
  input: { messageId: string; channelId?: string },
): Promise<{ ok: true; value: AuthorizedOwnMessage } | { ok: false; error: string; message: string }> {
  const messageId = input.messageId.trim();
  if (messageId === "") {
    return { ok: false, error: "missing_message_id", message: "message_id is required." };
  }

  const channelId = input.channelId?.trim() !== "" && input.channelId !== undefined
    ? input.channelId.trim()
    : deps.currentChannelId;
  const message = await deps.fetchMessage(channelId, messageId);
  if (message === null) {
    return {
      ok: false,
      error: "message_not_found",
      message: `Cannot access message ${messageId} in channel ${channelId}; use a guild text channel/thread ID because DMs are not supported.`,
    };
  }
  if (message.guildId === null) {
    return {
      ok: false,
      error: "dm_not_supported",
      message: `Cannot modify message ${messageId}: DMs are not supported.`,
    };
  }
  if (message.authorId !== deps.botUserId) {
    return {
      ok: false,
      error: "not_own_message",
      message: `Cannot modify message ${messageId}: it was not authored by this bot.`,
    };
  }
  if (message.channelId !== channelId) {
    return {
      ok: false,
      error: "wrong_channel",
      message: `Cannot modify message ${messageId}: it is not in channel ${channelId}.`,
    };
  }

  return { ok: true, value: { channelId, message: { ...message, guildId: message.guildId } } };
}

/** Create tools that let the bot edit or delete only its own Discord messages. */
export function createOwnMessageTools(deps: OwnMessageToolsDeps): AgentTool[] {
  return [
    {
      name: "edit_own_message",
      label: "Edit Own Message",
      description: "Edit a Discord message authored by this bot only.",
      parameters: EditOwnMessageParams,
      execute: async (
        _toolCallId,
        params,
      ): Promise<AgentToolResult<{ messageId: string; channel_id: string } | { error: string }>> => {
        const p = params as EditOwnMessageInput;
        const content = p.content.trim();
        if (content === "") {
          return {
            content: [{ type: "text", text: "Cannot edit a message to empty content; use delete_own_message to retract it." }],
            details: { error: "empty_content" },
          };
        }

        const auth = await authorizeOwnMessageOperation(deps, {
          messageId: p.message_id,
          channelId: p.channel_id,
        });
        if (!auth.ok) {
          return {
            content: [{ type: "text", text: auth.message }],
            details: { error: auth.error },
          };
        }

        let edited: { rawContent: string };
        try {
          edited = await deps.editMessage(auth.value.channelId, auth.value.message.id, content);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [{ type: "text", text: `Failed to edit own message ${auth.value.message.id}: ${message}` }],
            details: { error: message },
          };
        }

        await deps.afterEdit({
          messageId: auth.value.message.id,
          guildId: auth.value.message.guildId,
          channelId: auth.value.message.channelId,
          botUserId: deps.botUserId,
          botUsername: auth.value.message.authorUsername,
          rawContent: edited.rawContent,
          translatedContent: content,
          createdAt: auth.value.message.createdAt,
          replyToId: auth.value.message.replyToId,
        });

        return {
          content: [{ type: "text", text: firstText("edit", auth.value.message.id) }],
          details: { messageId: auth.value.message.id, channel_id: auth.value.channelId },
        };
      },
    },
    {
      name: "delete_own_message",
      label: "Delete Own Message",
      description: "Delete a Discord message authored by this bot only.",
      parameters: DeleteOwnMessageParams,
      execute: async (
        _toolCallId,
        params,
      ): Promise<AgentToolResult<{ messageId: string; channel_id: string } | { error: string }>> => {
        const p = params as DeleteOwnMessageInput;
        const auth = await authorizeOwnMessageOperation(deps, {
          messageId: p.message_id,
          channelId: p.channel_id,
        });
        if (!auth.ok) {
          return {
            content: [{ type: "text", text: auth.message }],
            details: { error: auth.error },
          };
        }

        try {
          await deps.deleteMessage(auth.value.channelId, auth.value.message.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [{ type: "text", text: `Failed to delete own message ${auth.value.message.id}: ${message}` }],
            details: { error: message },
          };
        }

        await deps.afterDelete({
          messageId: auth.value.message.id,
          guildId: auth.value.message.guildId,
          channelId: auth.value.message.channelId,
        });

        return {
          content: [{ type: "text", text: firstText("delete", auth.value.message.id) }],
          details: { messageId: auth.value.message.id, channel_id: auth.value.channelId },
        };
      },
    },
  ];
}
