import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const ReactToMessageParams = Type.Object({
  message_id: Type.String({ description: "Discord message ID to react to. Must be visible or retrievable in the selected guild chat." }),
  chat_id: Type.Optional(Type.String({ description: "Guild text channel or thread ID containing the message. Defaults to the current chat. DMs are not supported." })),
  emoji: Type.String({ description: "Reaction emoji to add. Use a small Unicode emoji like 👍 when possible; custom emoji names, :name:, or Discord emoji markup may also work." }),
});

export type ReactToMessageInput = Static<typeof ReactToMessageParams>;

export interface ReactToMessageDetails {
  messageId: string;
  chatId: string;
  emoji: string;
}

export interface ReactToMessageRequest {
  messageId: string;
  chatId: string;
  emoji: string;
}

export type MessageReactor = (input: ReactToMessageRequest) => Promise<ReactToMessageDetails>;

export interface ReactToMessageToolDeps {
  currentChannelId: string;
  reactToMessage: MessageReactor;
}

/** Normalize react_to_message tool input and apply the current-chat default. */
export function normalizeReactToMessageInput(
  params: ReactToMessageInput,
  currentChannelId: string,
): ReactToMessageRequest | { error: string } {
  const messageId = params.message_id.trim();
  const chatId = params.chat_id?.trim() === undefined || params.chat_id.trim() === ""
    ? currentChannelId
    : params.chat_id.trim();
  const emoji = params.emoji.trim();

  if (messageId === "") return { error: "message_id is required." };
  if (chatId === "") return { error: "chat_id is required." };
  if (emoji === "") return { error: "emoji is required." };
  return { messageId, chatId, emoji };
}

/** Create the react_to_message AgentTool. */
export function createReactToMessageTool(deps: ReactToMessageToolDeps): AgentTool {
  return {
    name: "react_to_message",
    label: "React To Message",
    description:
      "Add a Discord reaction to a visible or retrievable guild message in an accessible guild text channel/thread. Use this for small acknowledgements like 👍 instead of sending a text reply when the task is already handled and no text is needed, especially after starting async image generation. Do not use in DMs.",
    parameters: ReactToMessageParams,
    execute: async (
      _toolCallId,
      params,
    ): Promise<AgentToolResult<ReactToMessageDetails | { error: string }>> => {
      const normalized = normalizeReactToMessageInput(params as ReactToMessageInput, deps.currentChannelId);
      if ("error" in normalized) {
        return {
          content: [{ type: "text", text: `Failed to react to message: ${normalized.error}` }],
          details: { error: normalized.error },
        };
      }

      try {
        const details = await deps.reactToMessage(normalized);
        return {
          content: [{
            type: "text",
            text: `Reacted to message ${details.messageId} in chat ${details.chatId} with ${details.emoji}. If no text reply is needed, stop here or use <ignore> to stay silent.`,
          }],
          details,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to react to message: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}
