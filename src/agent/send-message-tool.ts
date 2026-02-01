import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const SendMessageParams = Type.Object({
  text: Type.String({ description: "Message text to send" }),
  reply: Type.Boolean({
    description: "When true, send as a reply to the trigger message. When false, send as a normal channel message.",
    default: false,
  }),
});

export type SendMessageInput = Static<typeof SendMessageParams>;

/** Details returned from the send_message tool execution. */
export interface SendMessageDetails {
  sentMessageId: string;
}

/**
 * Callback that performs the actual Discord send.
 * The handler module wires this to real Discord API calls.
 */
export type MessageSender = (
  text: string,
  reply: boolean,
  signal?: AbortSignal
) => Promise<{ sentMessageId: string }>;

/**
 * Create the send_message AgentTool with an injected sender.
 * Pure factory — no Discord dependency at construction time.
 */
export function createSendMessageTool(
  sender: MessageSender
): AgentTool<typeof SendMessageParams, SendMessageDetails> {
  return {
    name: "send_message",
    label: "Send Message",
    description:
      "Send a message to the current Discord channel. Set reply=true to reply to the trigger message, or reply=false for a normal channel message. Call multiple times to send multiple messages.",
    parameters: SendMessageParams,
    execute: async (
      _toolCallId,
      params,
      signal
    ): Promise<AgentToolResult<SendMessageDetails>> => {
      const result = await sender(params.text, params.reply, signal);
      return {
        content: [
          {
            type: "text",
            text: `Message sent.`,
          },
        ],
        details: {
          sentMessageId: result.sentMessageId,
        },
      };
    },
  };
}
