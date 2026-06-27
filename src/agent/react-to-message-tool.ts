import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

const ReactToMessageParams = Type.Object({
  message_id: Type.String({ description: "Discord message ID to react to." }),
  channel_id: Type.Optional(Type.String({ description: "Guild text channel or thread ID containing the message." })),
  emoji: Type.String({ description: "Reaction emoji to add." }),
});

export type ReactToMessageInput = Static<typeof ReactToMessageParams>;

export interface ReactToMessageDetails {
  messageId: string;
  channelId: string;
  emoji: string;
}

export interface ReactToMessageRequest {
  messageId: string;
  channelId: string;
  emoji: string;
}

export type MessageReactor = (input: ReactToMessageRequest) => Promise<ReactToMessageDetails>;

export interface ReactToMessageToolDeps {
  currentChannelId: string;
  reactToMessage: MessageReactor;
}

/** Normalize react_to_message tool input and apply the current-channel default. */
export function normalizeReactToMessageInput(
  params: ReactToMessageInput,
  currentChannelId: string,
): ReactToMessageRequest | { error: string } {
  const messageId = params.message_id.trim();
  const channelId = params.channel_id?.trim() === undefined || params.channel_id.trim() === ""
    ? currentChannelId
    : params.channel_id.trim();
  const emoji = params.emoji.trim();

  if (messageId === "") return { error: "message_id is required." };
  if (channelId === "") return { error: "channel_id is required." };
  if (emoji === "") return { error: "emoji is required." };
  return { messageId, channelId, emoji };
}

/** Create the react_to_message AgentTool. */
export function createReactToMessageTool(deps: ReactToMessageToolDeps): AgentTool {
  return {
    name: "react_to_message",
    label: "React To Message",
    description: "Add a Discord reaction to a guild message.",
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
            text: `Reacted to message ${details.messageId} in channel ${details.channelId} with ${details.emoji}; if no text reply is needed, stop here or use <ignore> to stay silent.`,
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
