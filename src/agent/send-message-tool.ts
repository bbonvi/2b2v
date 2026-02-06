import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TtsResult, TtsConfig } from "../tts/types.ts";

const SendMessageParams = Type.Object({
  text: Type.String({ description: "Message text to send" }),
  reply: Type.Boolean({
    description: "When true, send as a reply to the trigger message. When false, send as a normal channel message.",
    default: false,
  }),
  chat_id: Type.Optional(
    Type.String({
      description:
        "Target chat ID (channel, thread, or DM). Omit to send to current chat. Cannot use reply=true with a different chat_id.",
    })
  ),
  is_voice_message: Type.Optional(
    Type.Boolean({
      description: "When true, send as a voice message (audio attachment) instead of text. Use sparingly.",
      default: false,
    })
  ),
  voice_type: Type.Optional(
    Type.Union([Type.Literal("normal"), Type.Literal("whisper")], {
      description: "Voice preset to use. 'whisper' only available if configured.",
    })
  ),
  reply_to_message_id: Type.Optional(
    Type.String({
      description: "Reply to a specific message by ID. When provided, sends as a reply to that message (reply field is ignored). Use this to reply to follow-up messages.",
    })
  ),
});

export type SendMessageInput = Static<typeof SendMessageParams>;

/** Attachment data for a voice message. */
export interface VoiceAttachment {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

/** Details returned from the send_message tool execution. */
export interface SendMessageDetails {
  sentMessageId: string;
  voiceGenerated?: boolean;
  voiceError?: string;
  error?: string;
  unresolvedEmotes?: string[];
}

/**
 * Callback that performs the actual Discord send.
 * The handler module wires this to real Discord API calls.
 * Returns sentMessageId and optional warnings (e.g., unresolved emoji names).
 */
export type MessageSender = (
  text: string,
  reply: boolean,
  chatId: string | undefined,
  voice?: VoiceAttachment,
  signal?: AbortSignal,
  replyToMessageId?: string,
) => Promise<{ sentMessageId: string; warnings?: string[] }>;

/** Dependencies for the send_message tool. */
export interface SendMessageToolDeps {
  sender: MessageSender;
  ttsEnabled: boolean;
  ttsConfig?: TtsConfig;
  generateSpeech?: (text: string, voiceType: string) => Promise<TtsResult>;
}

/**
 * Create the send_message AgentTool with an injected sender.
 * Pure factory — no Discord dependency at construction time.
 */
export function createSendMessageTool(
  deps: SendMessageToolDeps
): AgentTool<typeof SendMessageParams, SendMessageDetails> {
  const { sender, ttsEnabled, ttsConfig, generateSpeech } = deps;

  return {
    name: "send_message",
    label: "Send Message",
    description:
      "Send a message to chat. Optionally specify chat_id to send to a thread or other chat. Set reply=true to reply to the trigger message (only valid for current chat). Call multiple times to send multiple messages. Optional: is_voice_message=true sends as audio attachment. Use `start_typing` before sending a message. Always send_message if you want to communicate something to a user.",
    parameters: SendMessageParams,
    execute: async (
      _toolCallId,
      params,
      signal
    ): Promise<AgentToolResult<SendMessageDetails>> => {
      const { text, reply, chat_id, is_voice_message, voice_type, reply_to_message_id } = params;

      // Reject cross-chat reply: cannot reply to trigger message when targeting a different chat
      // (reply_to_message_id takes precedence over reply boolean, so skip this check)
      if (chat_id !== undefined && reply && reply_to_message_id === undefined) {
        return {
          content: [
            {
              type: "text",
              text: "Cannot use reply=true when sending to a different chat. Set reply=false or omit chat_id.",
            },
          ],
          details: { sentMessageId: "" },
        };
      }

      // Text-only path (default)
      if (is_voice_message !== true) {
        let result: { sentMessageId: string; warnings?: string[] };
        try {
          const effectiveReply = reply_to_message_id !== undefined ? false : reply;
          result = await sender(text, effectiveReply, chat_id, undefined, signal, reply_to_message_id);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [{ type: "text", text: `Failed to send message: ${message}` }],
            details: { sentMessageId: "", error: message },
          };
        }

        // Build result message with optional emoji warning
        const emoteWarnings = result.warnings ?? [];
        let resultText = "Message sent.";
        if (emoteWarnings.length > 0) {
          const emoteList = emoteWarnings.join(", ");
          resultText = `Message sent.\nWarning: unknown emotes (not available in this server): ${emoteList}`;
        }

        return {
          content: [{ type: "text", text: resultText }],
          details: {
            sentMessageId: result.sentMessageId,
            ...(emoteWarnings.length > 0 ? { unresolvedEmotes: emoteWarnings } : {}),
          },
        };
      }

      // Voice message path
      if (!ttsEnabled) {
        return {
          content: [{ type: "text", text: "Voice messages are not enabled for this server. Message not sent." }],
          details: { sentMessageId: "", voiceError: "Voice messages are not enabled for this server." },
        };
      }

      if (generateSpeech === undefined) {
        return {
          content: [{ type: "text", text: "Voice generation unavailable (no API key). Message not sent." }],
          details: { sentMessageId: "", voiceError: "Voice generation unavailable (no API key)." },
        };
      }

      const selectedType = voice_type ?? "normal";

      // Validate voice type is configured
      if (selectedType === "whisper" && ttsConfig?.voices.whisper === undefined) {
        return {
          content: [{ type: "text", text: "Voice type 'whisper' is not configured. Message not sent." }],
          details: { sentMessageId: "", voiceError: "Voice type 'whisper' is not configured." },
        };
      }

      // Generate audio
      const ttsResult = await generateSpeech(text, selectedType);

      if (!ttsResult.ok) {
        return {
          content: [{ type: "text", text: `Voice generation failed: ${ttsResult.error}. Message not sent.` }],
          details: { sentMessageId: "", voiceError: ttsResult.error },
        };
      }

      // Send voice message
      const voiceAttachment: VoiceAttachment = {
        buffer: ttsResult.buffer,
        filename: "voice_message.mp3",
        contentType: ttsResult.contentType,
      };

      let result: { sentMessageId: string };
      try {
        const effectiveReplyVoice = reply_to_message_id !== undefined ? false : reply;
        result = await sender(text, effectiveReplyVoice, chat_id, voiceAttachment, signal, reply_to_message_id);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to send voice message: ${message}` }],
          details: { sentMessageId: "", voiceGenerated: true, voiceError: message },
        };
      }

      return {
        content: [{ type: "text", text: "Voice message sent." }],
        details: {
          sentMessageId: result.sentMessageId,
          voiceGenerated: true,
        },
      };
    },
  };
}
