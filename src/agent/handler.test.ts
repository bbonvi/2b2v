import { describe, expect, mock, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { handleMessage, injectTriggerInstruction, type ChatCompleteFn, type HandlerDeps, type IncomingMessage } from "./handler.ts";
import type { AssembledContext, ContextSection } from "./context-assembly.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";
import type { MessageSender, VoiceAttachment } from "./send-message-tool.ts";
import type { TtsConfig, TtsResult } from "../tts/types.ts";

function makeGlobalConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    discordToken: "test-token",
    openrouterApiKey: "test-key",
    defaultModel: "moonshotai/kimi-k2.5",
    defaultModelParams: {},
    defaultTimezone: "UTC",
    defaultTrim: { trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 },
    defaultTriggers: { mention: true, keywords: [], randomChance: 0 },
    defaultTriggerInstructions: {},
    defaultImageMaxDimension: 768,
    defaultMergeMessageGapSeconds: 120,
    defaultImageReadMaxPerCall: 10,
    defaultImageCaptioningEnabled: false,
    defaultAttachmentsDir: "data/attachments",
    defaultInstructions: "",
    defaultLateInstruction: "Keep it short.",
    promptProfile: {
      persona: [{ kind: "file", path: "prompts/persona.md", optional: false }],
      toolInstructions: [],
      instructions: [],
      lateInstructions: [{ kind: "file", path: "prompts/style.md", optional: false }],
    },
    logLevel: "info",
    dataDir: "./data",
    modelCacheDir: "./model-cache",
    qdrantUrl: "http://localhost:6333",
    uiLang: "en",
    defaultEmotes: { include: false },
    defaultMembers: { include: true },
    defaultDispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
    defaultPromptCaching: { enabled: true },
    defaultReplyLoop: { maxToolCalls: 8, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
    ...overrides,
  };
}

function makeGuildConfig(overrides: Partial<GuildConfig> = {}): GuildConfig {
  return {
    guildId: "guild-1",
    slug: "test",
    triggers: { mention: true, keywords: [], randomChance: 0 },
    triggerInstructions: {},
    timezone: "UTC",
    trim: { trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 },
    adminUserIds: [],
    imageMaxDimension: 768,
    mergeMessageGapSeconds: 120,
    imageReadMaxPerCall: 10,
    imageCaptioningEnabled: false,
    attachmentsDir: "data/attachments",
    instructions: "",
    emotes: { include: false },
    members: { include: true },
    dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
    promptCaching: { enabled: true },
    replyLoop: { maxToolCalls: 8, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
    ...overrides,
  };
}

const ttsConfig: TtsConfig = {
  enabled: true,
  voices: {
    normal: { voiceId: "normal", speed: 1, stability: 0.5, similarityBoost: 0.75, model: "eleven_flash_v2_5" },
    whisper: { voiceId: "whisper", speed: 1, stability: 0.5, similarityBoost: 0.75, model: "eleven_flash_v2_5" },
  },
};

function makeContext(overrides: Partial<AssembledContext> = {}): AssembledContext {
  return {
    sections: [
      { label: "Server Members", text: "## Server Members\n@user", cached: false, role: "developer" },
      { label: "Memories", text: "## Memory\n- 1 [@user] [preference] concise", cached: false, role: "developer" },
      { label: "Current Context", text: "Guild: g1", cached: false, role: "developer" },
    ],
    userMessage: "hello bot",
    ...overrides,
  };
}

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    content: "hello bot",
    authorId: "user-1",
    authorUsername: "testuser",
    botUserId: "bot-1",
    mentionedUserIds: [],
    translatedContent: "hello bot",
    messageId: "msg-1",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  const sender: MessageSender = () => Promise.resolve({ sentMessageId: "sent-1" });
  const completeChat: ChatCompleteFn = () => Promise.resolve({
    text: "hello user",
    toolCalls: [],
    rawResponse: {},
    messageForLogs: {
      role: "assistant",
      model: "m",
      stopReason: "stop",
      content: [{ type: "text", text: "hello user" }],
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
    },
  });

  return {
    globalConfig: makeGlobalConfig(),
    guildConfig: makeGuildConfig(),
    context: makeContext(),
    personaPrompt: "You are a test bot.",
    sender,
    completeChat,
    ...overrides,
  };
}

describe("handleMessage", () => {
  test("returns triggered=false when no trigger matches", async () => {
    const completeChat = mock(() => Promise.resolve({
      text: "unused",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: {},
    }));
    const result = await handleMessage(makeMessage(), makeDeps({
      guildConfig: makeGuildConfig({ triggers: { mention: false, keywords: [], randomChance: 0 } }),
      completeChat: completeChat as unknown as ChatCompleteFn,
    }));

    expect(result.triggered).toBe(false);
    expect(result.agentRan).toBe(false);
    expect(completeChat).toHaveBeenCalledTimes(0);
  });

  test("sends direct final model text", async () => {
    const senderCalls: Array<{ text: string; reply: boolean; chatId?: string }> = [];
    const sender: MessageSender = (text, reply, chatId) => {
      senderCalls.push({ text, reply, chatId });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ sender }),
    );

    expect(result.responseText).toBe("hello user");
    expect(senderCalls).toEqual([{ text: "hello user", reply: true, chatId: undefined }]);
  });

  test("sends voice directive segments as TTS audio", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "Text first <voice type=\"whisper\">quiet line</voice> text after",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; reply: boolean; voice: boolean }> = [];
    const sender: MessageSender = (text, reply, _chatId, voice) => {
      senderCalls.push({ text, reply, voice: voice !== undefined });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const generateSpeech = (): Promise<TtsResult> =>
      Promise.resolve({ ok: true, buffer: Buffer.from("audio"), contentType: "audio/mpeg" });

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, ttsEnabled: true, ttsConfig, generateSpeech }),
    );

    expect(senderCalls).toEqual([
      { text: "Text first", reply: true, voice: false },
      { text: "quiet line", reply: false, voice: true },
      { text: "text after", reply: false, voice: false },
    ]);
    expect(result.responseText).toBe("Text first\n[voice whisper] quiet line\ntext after");
  });

  test("falls back to text when a voice directive cannot generate audio", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<voice>audio please</voice>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; voice?: VoiceAttachment }> = [];
    const sender: MessageSender = (text, _reply, _chatId, voice) => {
      senderCalls.push({ text, voice });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender }),
    );

    expect(senderCalls).toEqual([{ text: "audio please", voice: undefined }]);
  });

  test("ignore directive produces no Discord send and no memory extraction", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<ignore>not worth answering</ignore>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const sender: MessageSender = mock(() => Promise.resolve({ sentMessageId: "sent-1" }));
    const afterReply = mock(() => Promise.resolve());

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, afterReply }),
    );

    expect(result.agentRan).toBe(true);
    expect(result.responseText).toBeUndefined();
    expect(sender).toHaveBeenCalledTimes(0);
    expect(afterReply).toHaveBeenCalledTimes(0);
  });

  test("throws and skips memory extraction when the final Discord send fails", async () => {
    const afterReply = mock(() => Promise.resolve());
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "" });

    let thrown: unknown;
    try {
      await handleMessage(
        makeMessage({ mentionedUserIds: ["bot-1"] }),
        makeDeps({ sender, afterReply }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Failed to send final Discord message");
    expect(afterReply).toHaveBeenCalledTimes(0);
  });

  test("executes native tool calls then sends final text", async () => {
    const toolCalls: unknown[] = [];
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: (_id, params) => {
        toolCalls.push(params);
        return Promise.resolve({ content: [{ type: "text", text: "tool says 42" }], details: {} });
      },
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        expect(request.tools?.[0]?.function.name).toBe("lookup");
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: "{\"query\":\"x\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      expect(
        request.messages.some((m) =>
          m.role === "tool" && typeof m.content === "string" && m.content.includes("tool says 42")),
      ).toBe(true);
      return Promise.resolve({
        text: "answer is 42",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer is 42" }] },
      });
    };

    const sender: MessageSender = mock(() => Promise.resolve({ sentMessageId: "sent-1" }));
    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [tool], completeChat, sender }),
    );

    expect(result.responseText).toBe("answer is 42");
    expect(toolCalls).toEqual([{ query: "x" }]);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  test("passes image tool results back to the model as multimodal context", async () => {
    const tool: AgentTool = {
      name: "read_chat_images",
      label: "Read Images",
      description: "Read images",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [
          { type: "text", text: "{\"id\":1,\"width\":10,\"height\":10}" },
          { type: "image", data: "abcd", mimeType: "image/jpeg" },
        ],
        details: {},
      }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "read_chat_images", arguments: "{}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      const multimodal = request.messages.find((m) => m.role === "user" && Array.isArray(m.content));
      expect(multimodal).toBeDefined();
      const parts = Array.isArray(multimodal?.content) ? multimodal.content : [];
      expect(parts.some((part) =>
        part.type === "image_url" && part.image_url.url === "data:image/jpeg;base64,abcd"
      )).toBe(true);

      return Promise.resolve({
        text: "image answer",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "image answer" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [tool], completeChat }),
    );

    expect(result.responseText).toBe("image answer");
  });

  test("routes final answer to a created thread", async () => {
    const threadTool: AgentTool = {
      name: "start_thread",
      label: "Start Thread",
      description: "Create a thread",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Thread created" }],
        details: { threadId: "thread-1", threadName: "Thread", parentChatId: "channel-1" },
      }),
    };
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: "call-1", type: "function", function: { name: "start_thread", arguments: "{}" } }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "thread answer",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "thread answer" }] },
      });
    };
    const senderCalls: Array<{ text: string; reply: boolean; chatId?: string }> = [];
    const sender: MessageSender = (text, reply, chatId) => {
      senderCalls.push({ text, reply, chatId });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [threadTool], completeChat, sender }),
    );

    expect(senderCalls).toEqual([{ text: "thread answer", reply: false, chatId: "thread-1" }]);
  });

  test("calls background memory extraction after send", async () => {
    const afterReplyCalls: unknown[] = [];
    const afterReply = (request: unknown): Promise<void> => {
      afterReplyCalls.push(request);
      return Promise.resolve();
    };
    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ afterReply }),
    );

    expect(afterReplyCalls).toHaveLength(1);
    expect(afterReplyCalls[0]).toMatchObject({
      sourceMessageId: "msg-1",
      userMessage: "hello bot",
      assistantReply: "hello user",
    });
  });

  test("injectTriggerInstruction inserts before response instruction", () => {
    const sections: ContextSection[] = [
      { label: "Current Context", text: "ctx", cached: false, role: "developer" },
      { label: "Response Instruction", text: "respond", cached: false, role: "developer" },
    ];

    const result = injectTriggerInstruction(sections, "Mentioned directly.");

    expect(result.map((section) => section.label)).toEqual([
      "Current Context",
      "Trigger Instruction",
      "Response Instruction",
    ]);
  });
});
