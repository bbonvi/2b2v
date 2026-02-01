import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const SendMessagesParams = Type.Object({
  messages: Type.Array(
    Type.Object({
      text: Type.String({ description: "Message text to send" }),
    }),
    {
      description: "Array of messages to send. First message is a reply to the trigger; rest are normal channel messages.",
      minItems: 1,
    }
  ),
});

export type SendMessagesInput = Static<typeof SendMessagesParams>;

/** Details returned from the send_messages tool execution. */
export interface SendMessagesDetails {
  messageCount: number;
  sentMessageIds: string[];
}

/**
 * Callback that performs the actual Discord send.
 * The handler module wires this to real Discord API calls.
 */
export type MessageSender = (
  messages: { text: string }[],
  signal?: AbortSignal
) => Promise<{ sentMessageIds: string[] }>;

/**
 * Create the send_messages AgentTool with an injected sender.
 * Pure factory — no Discord dependency at construction time.
 */
export function createSendMessagesTool(
  sender: MessageSender
): AgentTool<typeof SendMessagesParams, SendMessagesDetails> {
  return {
    name: "send_messages",
    label: "Send Messages",
    description:
      "Send one or more messages to the current Discord channel. The first message is a reply to the trigger message; subsequent messages are normal channel messages. Use short, human-like messages.",
    parameters: SendMessagesParams,
    execute: async (
      _toolCallId,
      params,
      signal
    ): Promise<AgentToolResult<SendMessagesDetails>> => {
      const result = await sender(params.messages, signal);
      return {
        content: [
          {
            type: "text",
            text: `Sent ${params.messages.length} message(s).`,
          },
        ],
        details: {
          messageCount: params.messages.length,
          sentMessageIds: result.sentMessageIds,
        },
      };
    },
  };
}
