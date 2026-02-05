import { describe, test, expect } from "bun:test";
import {
  createSendMessageTool,
  type MessageSender,
  type VoiceAttachment,
} from "./send-message-tool.ts";
import type { TtsResult, TtsConfig } from "../tts/types.ts";

const defaultTtsConfig: TtsConfig = {
  enabled: true,
  voices: {
    normal: {
      voiceId: "normal-voice-id",
      speed: 1.0,
      stability: 0.5,
      similarityBoost: 0.75,
      model: "eleven_flash_v2_5",
    },
    whisper: {
      voiceId: "whisper-voice-id",
      speed: 1.0,
      stability: 0.3,
      similarityBoost: 0.4,
      model: "eleven_flash_v2_5",
    },
  },
};

interface MockSenderCall {
  text: string;
  reply: boolean;
  chatId?: string;
  voice?: VoiceAttachment;
}

function createMockSender(warnings?: string[]): {
  sender: MessageSender;
  calls: MockSenderCall[];
} {
  const calls: MockSenderCall[] = [];
  const sender: MessageSender = (text, reply, chatId, voice) => {
    calls.push({ text, reply, chatId, voice });
    return Promise.resolve({ sentMessageId: "msg-1", warnings });
  };
  return { sender, calls };
}

function createMockGenerateSpeech(result: TtsResult): {
  generate: (text: string, voiceType: string) => Promise<TtsResult>;
  calls: { text: string; voiceType: string }[];
} {
  const calls: { text: string; voiceType: string }[] = [];
  const generate = (text: string, voiceType: string): Promise<TtsResult> => {
    calls.push({ text, voiceType });
    return Promise.resolve(result);
  };
  return { generate, calls };
}

describe("createSendMessageTool", () => {
  test("returns a tool with correct name and description", () => {
    const { sender } = createMockSender();
    const tool = createSendMessageTool({ sender, ttsEnabled: false });
    expect(tool.name).toBe("send_message");
    expect(tool.label).toBe("Send Message");
    expect(tool.description).toContain("reply");
    expect(tool.description).toContain("is_voice_message");
  });

  describe("text message (default behavior)", () => {
    test("execute calls sender with text and reply=false by default", async () => {
      const { sender, calls } = createMockSender();
      const tool = createSendMessageTool({ sender, ttsEnabled: false });

      const result = await tool.execute("call-1", { text: "Hello", reply: false });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ text: "Hello", reply: false, chatId: undefined, voice: undefined });
      expect(result.details.sentMessageId).toBe("msg-1");
      expect(result.content[0]).toEqual({
        type: "text",
        text: "Message sent.",
      });
    });

    test("execute passes reply=true to sender", async () => {
      const { sender, calls } = createMockSender();
      const tool = createSendMessageTool({ sender, ttsEnabled: false });

      const result = await tool.execute("call-1", { text: "Hi there", reply: true });

      expect(calls[0]).toEqual({ text: "Hi there", reply: true, chatId: undefined, voice: undefined });
      expect(result.details.sentMessageId).toBe("msg-1");
    });

    test("execute propagates signal to sender", async () => {
      let receivedSignal: AbortSignal | undefined;
      const sender: MessageSender = (_text, _reply, _chatId, _voice, signal) => {
        receivedSignal = signal;
        return Promise.resolve({ sentMessageId: "" });
      };
      const tool = createSendMessageTool({ sender, ttsEnabled: false });
      const controller = new AbortController();

      await tool.execute("call-1", { text: "hi", reply: false }, controller.signal);

      expect(receivedSignal).toBe(controller.signal);
    });

    test("returns tool error when sender fails", async () => {
      const sender: MessageSender = () => Promise.reject(new Error("Discord API unavailable"));
      const tool = createSendMessageTool({ sender, ttsEnabled: false });

      const result = await tool.execute("call-1", { text: "hi", reply: false });

      expect(result.details.sentMessageId).toBe("");
      expect((result.details as { error?: string }).error).toBe("Discord API unavailable");
      expect(result.content[0]).toEqual({
        type: "text",
        text: "Failed to send message: Discord API unavailable",
      });
    });

    test("is_voice_message=false behaves like text message", async () => {
      const { sender, calls } = createMockSender();
      const tool = createSendMessageTool({ sender, ttsEnabled: true, ttsConfig: defaultTtsConfig });

      const result = await tool.execute("call-1", { text: "Hello", reply: false, is_voice_message: false });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.voice).toBeUndefined();
      expect(result.content[0]).toEqual({ type: "text", text: "Message sent." });
    });

    test("includes single emoji warning in result when sender returns one", async () => {
      const { sender } = createMockSender([":whatever:"]);
      const tool = createSendMessageTool({ sender, ttsEnabled: false });

      const result = await tool.execute("call-1", { text: "Hello :whatever:", reply: false });

      expect(result.content[0]).toEqual({
        type: "text",
        text: "Message sent.\n\nWarning: unknown emotes (not available in this server): :whatever:",
      });
      expect(result.details.unresolvedEmotes).toEqual([":whatever:"]);
    });

    test("includes multiple emoji warnings in result when sender returns many", async () => {
      const { sender } = createMockSender([":foo:", ":bar:"]);
      const tool = createSendMessageTool({ sender, ttsEnabled: false });

      const result = await tool.execute("call-1", { text: "Hello :foo: :bar:", reply: false });

      expect(result.content[0]).toEqual({
        type: "text",
        text: "Message sent.\n\nWarning: unknown emotes (not available in this server): :foo:, :bar:",
      });
      expect(result.details.unresolvedEmotes).toEqual([":foo:", ":bar:"]);
    });

    test("result unchanged when sender returns no warnings", async () => {
      const { sender } = createMockSender();
      const tool = createSendMessageTool({ sender, ttsEnabled: false });

      const result = await tool.execute("call-1", { text: "Hello", reply: false });

      expect(result.content[0]).toEqual({ type: "text", text: "Message sent." });
      expect(result.details.unresolvedEmotes).toBeUndefined();
    });
  });

  describe("chat_id routing", () => {
    test("passes chat_id to sender when provided", async () => {
      const { sender, calls } = createMockSender();
      const tool = createSendMessageTool({ sender, ttsEnabled: false });

      const result = await tool.execute("call-1", {
        text: "Hello thread",
        reply: false,
        chat_id: "thread-123",
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        text: "Hello thread",
        reply: false,
        chatId: "thread-123",
        voice: undefined,
      });
      expect(result.details.sentMessageId).toBe("msg-1");
    });

    test("chat_id undefined defaults to current chat (existing behavior)", async () => {
      const { sender, calls } = createMockSender();
      const tool = createSendMessageTool({ sender, ttsEnabled: false });

      await tool.execute("call-1", { text: "Hi", reply: false });

      expect(calls[0]?.chatId).toBeUndefined();
    });

    test("returns error when chat_id provided with reply=true", async () => {
      const { sender, calls } = createMockSender();
      const tool = createSendMessageTool({ sender, ttsEnabled: false });

      const result = await tool.execute("call-1", {
        text: "This should fail",
        reply: true,
        chat_id: "thread-123",
      });

      expect(calls).toHaveLength(0);
      expect(result.details.sentMessageId).toBe("");
      expect(result.content[0]).toEqual({
        type: "text",
        text: "Cannot use reply=true when sending to a different chat. Set reply=false or omit chat_id.",
      });
    });

    test("allows reply=false with chat_id", async () => {
      const { sender, calls } = createMockSender();
      const tool = createSendMessageTool({ sender, ttsEnabled: false });

      const result = await tool.execute("call-1", {
        text: "Continue in thread",
        reply: false,
        chat_id: "thread-456",
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.chatId).toBe("thread-456");
      expect(result.details.sentMessageId).toBe("msg-1");
    });

    test("passes chat_id through for voice messages", async () => {
      const { sender, calls } = createMockSender();
      const { generate } = createMockGenerateSpeech({
        ok: true,
        buffer: Buffer.from("audio"),
        contentType: "audio/mpeg",
      });

      const tool = createSendMessageTool({
        sender,
        ttsEnabled: true,
        ttsConfig: defaultTtsConfig,
        generateSpeech: generate,
      });

      await tool.execute("call-1", {
        text: "Voice in thread",
        reply: false,
        is_voice_message: true,
        chat_id: "thread-789",
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.chatId).toBe("thread-789");
      expect(calls[0]?.voice).toBeDefined();
    });

    test("returns clear error when sender throws (invalid chat_id)", async () => {
      const sender: MessageSender = () => Promise.reject(new Error('Invalid chat_id: channel "bad-id" not found'));
      const tool = createSendMessageTool({ sender, ttsEnabled: false });

      const result = await tool.execute("call-1", {
        text: "Hello",
        reply: false,
        chat_id: "bad-id",
      });

      expect(result.details.sentMessageId).toBe("");
      expect((result.details as { error?: string }).error).toBe('Invalid chat_id: channel "bad-id" not found');
      expect(result.content[0]).toEqual({
        type: "text",
        text: 'Failed to send message: Invalid chat_id: channel "bad-id" not found',
      });
    });

    test("returns clear error when voice sender throws (invalid chat_id)", async () => {
      const sender: MessageSender = () => Promise.reject(new Error('Invalid chat_id: channel "bad-id" not found'));
      const { generate } = createMockGenerateSpeech({
        ok: true,
        buffer: Buffer.from("audio"),
        contentType: "audio/mpeg",
      });

      const tool = createSendMessageTool({
        sender,
        ttsEnabled: true,
        ttsConfig: defaultTtsConfig,
        generateSpeech: generate,
      });

      const result = await tool.execute("call-1", {
        text: "Voice hello",
        reply: false,
        is_voice_message: true,
        chat_id: "bad-id",
      });

      expect(result.details.sentMessageId).toBe("");
      expect((result.details as { voiceError?: string }).voiceError).toBe('Invalid chat_id: channel "bad-id" not found');
      expect(result.content[0]).toEqual({
        type: "text",
        text: 'Failed to send voice message: Invalid chat_id: channel "bad-id" not found',
      });
    });
  });

  describe("voice message", () => {
    test("returns error when TTS is disabled", async () => {
      const { sender, calls } = createMockSender();
      const tool = createSendMessageTool({ sender, ttsEnabled: false });

      const result = await tool.execute("call-1", { text: "Hello", reply: false, is_voice_message: true });

      expect(calls).toHaveLength(0);
      expect(result.details.sentMessageId).toBe("");
      expect(result.details.voiceError).toBe("Voice messages are not enabled for this server.");
      expect(result.content[0]).toEqual({
        type: "text",
        text: "Voice messages are not enabled for this server. Message not sent.",
      });
    });

    test("returns error when generateSpeech is not provided", async () => {
      const { sender, calls } = createMockSender();
      const tool = createSendMessageTool({
        sender,
        ttsEnabled: true,
        ttsConfig: defaultTtsConfig,
        // generateSpeech not provided
      });

      const result = await tool.execute("call-1", { text: "Hello", reply: false, is_voice_message: true });

      expect(calls).toHaveLength(0);
      expect(result.details.voiceError).toBe("Voice generation unavailable (no API key).");
    });

    test("returns error when whisper voice is not configured", async () => {
      const { sender, calls } = createMockSender();
      const { generate } = createMockGenerateSpeech({ ok: true, buffer: Buffer.from(""), contentType: "audio/mpeg" });
      const ttsConfigNoWhisper: TtsConfig = {
        enabled: true,
        voices: {
          normal: defaultTtsConfig.voices.normal,
          // whisper not configured
        },
      };

      const tool = createSendMessageTool({
        sender,
        ttsEnabled: true,
        ttsConfig: ttsConfigNoWhisper,
        generateSpeech: generate,
      });

      const result = await tool.execute("call-1", {
        text: "Hello",
        reply: false,
        is_voice_message: true,
        voice_type: "whisper",
      });

      expect(calls).toHaveLength(0);
      expect(result.details.voiceError).toBe("Voice type 'whisper' is not configured.");
    });

    test("returns error when voice generation fails", async () => {
      const { sender, calls } = createMockSender();
      const { generate } = createMockGenerateSpeech({ ok: false, error: "ElevenLabs rate limit exceeded" });

      const tool = createSendMessageTool({
        sender,
        ttsEnabled: true,
        ttsConfig: defaultTtsConfig,
        generateSpeech: generate,
      });

      const result = await tool.execute("call-1", { text: "Hello", reply: false, is_voice_message: true });

      expect(calls).toHaveLength(0);
      expect(result.details.voiceError).toBe("ElevenLabs rate limit exceeded");
      expect(result.content[0]).toEqual({
        type: "text",
        text: "Voice generation failed: ElevenLabs rate limit exceeded. Message not sent.",
      });
    });

    test("sends voice message on successful generation", async () => {
      const { sender, calls } = createMockSender();
      const audioBuffer = Buffer.from([0x49, 0x44, 0x33]);
      const { generate, calls: speechCalls } = createMockGenerateSpeech({
        ok: true,
        buffer: audioBuffer,
        contentType: "audio/mpeg",
      });

      const tool = createSendMessageTool({
        sender,
        ttsEnabled: true,
        ttsConfig: defaultTtsConfig,
        generateSpeech: generate,
      });

      const result = await tool.execute("call-1", { text: "Hello world", reply: true, is_voice_message: true });

      expect(speechCalls).toHaveLength(1);
      expect(speechCalls[0]).toEqual({ text: "Hello world", voiceType: "normal" });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.text).toBe("Hello world");
      expect(calls[0]?.reply).toBe(true);
      expect(calls[0]?.voice).toEqual({
        buffer: audioBuffer,
        filename: "voice_message.mp3",
        contentType: "audio/mpeg",
      });

      expect(result.details.sentMessageId).toBe("msg-1");
      expect(result.details.voiceGenerated).toBe(true);
      expect(result.content[0]).toEqual({ type: "text", text: "Voice message sent." });
    });

    test("uses normal voice type by default", async () => {
      const { sender } = createMockSender();
      const { generate, calls: speechCalls } = createMockGenerateSpeech({
        ok: true,
        buffer: Buffer.from(""),
        contentType: "audio/mpeg",
      });

      const tool = createSendMessageTool({
        sender,
        ttsEnabled: true,
        ttsConfig: defaultTtsConfig,
        generateSpeech: generate,
      });

      await tool.execute("call-1", { text: "Hello", reply: false, is_voice_message: true });

      expect(speechCalls[0]?.voiceType).toBe("normal");
    });

    test("uses whisper voice type when specified", async () => {
      const { sender } = createMockSender();
      const { generate, calls: speechCalls } = createMockGenerateSpeech({
        ok: true,
        buffer: Buffer.from(""),
        contentType: "audio/mpeg",
      });

      const tool = createSendMessageTool({
        sender,
        ttsEnabled: true,
        ttsConfig: defaultTtsConfig,
        generateSpeech: generate,
      });

      await tool.execute("call-1", { text: "Psst", reply: false, is_voice_message: true, voice_type: "whisper" });

      expect(speechCalls[0]?.voiceType).toBe("whisper");
    });
  });
});
