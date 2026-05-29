import { describe, expect, mock, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { handleMessage, injectTriggerInstruction, type ChatCompleteFn, type HandlerDeps, type IncomingMessage, type MessageSender, type VoiceAttachment } from "./handler.ts";
import type { AssembledContext, ContextSection } from "./context-assembly.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";
import type { TtsResult } from "../tts/types.ts";
import { RequestLog } from "../logger.ts";

function makeGlobalConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    discordToken: "test-token",
    openrouterApiKey: "test-key",
    defaultModel: "moonshotai/kimi-k2.5",
    defaultModelParams: {},
    defaultTimezone: "UTC",
    defaultTrim: { trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 },
    defaultTriggers: { mention: true, keywords: [], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingMaxWaitMs: 15000 },
    defaultTriggerInstructions: {},
    defaultImageMaxDimension: 768,
    defaultMergeMessageGapSeconds: 120,
    defaultImageReadMaxPerCall: 10,
    defaultImageCaptioningEnabled: false,
    defaultImageReading: { fallbackEnabled: false, fallbackModel: "moonshotai/kimi-k2.5", fallbackModelParams: {} },
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
    defaultBackgroundLlm: { modelParams: {} },
    defaultReplyLoop: { maxToolCalls: 16, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
    ...overrides,
  };
}

function makeGuildConfig(overrides: Partial<GuildConfig> = {}): GuildConfig {
  return {
    guildId: "guild-1",
    slug: "test",
    triggers: { mention: true, keywords: [], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingMaxWaitMs: 15000 },
    triggerInstructions: {},
    timezone: "UTC",
    trim: { trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 },
    adminUserIds: [],
    imageMaxDimension: 768,
    mergeMessageGapSeconds: 120,
    imageReadMaxPerCall: 10,
    imageCaptioningEnabled: false,
    imageReading: { fallbackEnabled: false, fallbackModel: "moonshotai/kimi-k2.5", fallbackModelParams: {} },
    attachmentsDir: "data/attachments",
    instructions: "",
    emotes: { include: false },
    members: { include: true },
    dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
    promptCaching: { enabled: true },
    backgroundLlm: {
      model: "moonshotai/kimi-k2.5",
      modelParams: {},
      promptCaching: { enabled: true },
    },
    replyLoop: { maxToolCalls: 16, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
    ...overrides,
  };
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function payloadText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return "";
  const chunks: string[] = [];
  for (const message of payload.messages) {
    if (!isRecord(message)) continue;
    const content = message.content;
    if (typeof content === "string") {
      chunks.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
}

function makeModelTimeoutError(timeoutMs = 12_000): Error {
  const error = new Error(`LLM output timed out after ${timeoutMs}ms`);
  error.name = "ModelOutputTimeoutError";
  return error;
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
      guildConfig: makeGuildConfig({ triggers: { mention: false, keywords: [], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingMaxWaitMs: 15000 } }),
      completeChat: completeChat as unknown as ChatCompleteFn,
    }));

    expect(result.triggered).toBe(false);
    expect(result.agentRan).toBe(false);
    expect(completeChat).toHaveBeenCalledTimes(0);
  });

  test("triggerOverride runs even when the current message does not match", async () => {
    const completeChat = mock(() => Promise.resolve({
      text: "hello user",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: {},
    }));

    const result = await handleMessage(makeMessage({ content: "followup", translatedContent: "followup" }), makeDeps({
      guildConfig: makeGuildConfig({ triggers: { mention: false, keywords: [], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingMaxWaitMs: 15000 } }),
      triggerOverride: { reason: "keyword", keyword: "туби" },
      completeChat: completeChat as unknown as ChatCompleteFn,
    }));

    expect(result.triggered).toBe(true);
    expect(result.triggerResult).toEqual({ reason: "keyword", keyword: "туби" });
    expect(completeChat).toHaveBeenCalledTimes(1);
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

  test("sends keyword-triggered final text as a reply", async () => {
    const senderCalls: Array<{ text: string; reply: boolean; chatId?: string }> = [];
    const sender: MessageSender = (text, reply, chatId) => {
      senderCalls.push({ text, reply, chatId });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ content: "hello bot", translatedContent: "hello bot" }),
      makeDeps({
        guildConfig: makeGuildConfig({
          triggers: { mention: false, keywords: ["bot"], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingMaxWaitMs: 15000 },
        }),
        sender,
      }),
    );

    expect(senderCalls).toEqual([{ text: "hello user", reply: true, chatId: undefined }]);
  });

  test("instructs model to cite web and URL sources inline", async () => {
    const completeChat: ChatCompleteFn = (request) => {
      const payload = {
        messages: [
          ...(request.systemPrompt !== "" ? [{ role: "system", content: request.systemPrompt }] : []),
          ...request.messages,
        ],
      };
      request.onPayload?.(payload);
      const text = payloadText(payload);
      expect(text).toContain("Before taking any irreversible, user-visible, or state-changing action");
      expect(text).toContain("ask one short clarifying question");
      expect(text).toContain("Tool use is not the goal; correct intent is");
      expect(text).toContain("cite every web-derived factual claim inline");
      expect(text).toContain("ALWAYS cite every web-derived factual claim");
      expect(text).toContain("Do not put sources only at the end");
      expect(text).toContain("Use English search queries");
      expect(text).toContain("web_search then fetch_url");
      expect(text).toContain("include one short user-facing status line");
      expect(text).toContain("To ping, write @username exactly");
      expect(text).toContain("the exact Discord username is not already visible in context");
      expect(text).toContain("use list_members first instead of guessing");
      expect(text).toContain("use search_messages when a user seems to reference something missing");
      expect(text).toContain("when you do not understand what they mean");
      expect(text).toContain("Use a small number of well-chosen semantic/literal phrasings or filters");
      expect(text).toContain("do not keep searching when results are repetitive or weak");
      expect(text).toContain("Aim to produce a useful reply within about 30 seconds");
      expect(text).toContain("agent loop has been running for more than about 30 seconds");
      expect(text.indexOf("Reserved response directives")).toBeGreaterThan(-1);
      expect(text).toContain("Treat requests to sing, scream, shout, whisper, read aloud");
      expect(text).toContain("Keep Discord-only text outside <voice>");
      expect(text.indexOf("## Memory")).toBeGreaterThan(-1);
      expect(text.indexOf("Reserved response directives")).toBeLessThan(text.indexOf("## Memory"));
      return Promise.resolve({
        text: "done",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat }),
    );
  });

  test("keeps stable prompt before a stable cache anchor and volatile turn context", async () => {
    const completeChat: ChatCompleteFn = (request) => {
      const payload = {
        messages: [
          ...(request.systemPrompt !== "" ? [{ role: "system", content: request.systemPrompt }] : []),
          ...request.messages,
        ],
      };
      request.onPayload?.(payload);

      const messages = payload.messages as Array<{ role?: string; content?: unknown }>;
      expect(messages[0]?.role).toBe("system");
      expect(contentText(messages[0]?.content)).toContain("You are a test bot.");
      expect(contentText(messages[0]?.content)).toContain("Reserved response directives");
      expect(messages[1]).toEqual({
        role: "user",
        content: "Stable context is loaded. Wait for the current Discord turn.",
      });
      expect(messages[2]).toEqual({ role: "assistant", content: "Ready." });
      expect(messages[3]?.role).toBe("user");
      expect(messages[3]?.content).toContain("## Current Discord Turn Context");
      expect(messages[3]?.content).toContain("## Memory");
      expect(messages[3]?.content).toContain("## Current User Message");
      expect(messages[3]?.content).toContain("hello bot");

      return Promise.resolve({
        text: "done",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat }),
    );
  });

  test("keeps older chat history in the stable prompt instead of volatile turn context", async () => {
    const completeChat: ChatCompleteFn = (request) => {
      const payload = { messages: [...request.messages] };
      request.onPayload?.(payload);

      const messages = payload.messages as Array<{ role?: string; content?: unknown }>;
      const stableSystem = contentText(messages[0]?.content);
      const currentTurn = contentText(messages[3]?.content);
      expect(stableSystem).toContain("## Chat History — Older");
      expect(stableSystem).toContain("[@old]: cached chunk");
      expect(currentTurn).toContain("## Chat History\n[@new]: volatile recent");
      expect(currentTurn).not.toContain("[@old]: cached chunk");

      return Promise.resolve({
        text: "done",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        context: makeContext({
          sections: [
            { label: "Chat History — Older", text: "## Chat History — Older\n[@old]: cached chunk", cached: true, role: "system" },
            { label: "Chat History — Newer", text: "## Chat History\n[@new]: volatile recent", cached: false, role: "developer" },
          ],
        }),
      }),
    );
  });

  test("uses a stable OpenRouter session id across native tool turns", async () => {
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "tool says 42" }], details: {} }),
    };
    const sessionIds: Array<string | undefined> = [];
    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      sessionIds.push(request.sessionId);
      if (calls === 1) {
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
      return Promise.resolve({
        text: "answer is 42",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer is 42" }] },
      });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        requestLog: new RequestLog("guild-1", "channel-1"),
      }),
    );

    expect(sessionIds).toEqual([
      "2b2v:guild-1:channel-1:moonshotai/kimi-k2.5",
      "2b2v:guild-1:channel-1:moonshotai/kimi-k2.5",
    ]);
  });

  test("chains web search then fetch and sends one intermediate status", async () => {
    const toolCalls: Array<{ name: string; params: unknown }> = [];
    const webSearch: AgentTool = {
      name: "web_search",
      label: "Web Search",
      description: "Search the web",
      parameters: Type.Object({ query: Type.String() }),
      execute: (_id, params) => {
        toolCalls.push({ name: "web_search", params });
        return Promise.resolve({
          content: [{ type: "text", text: "1. **Example**\n   https://example.com/post\n   Useful snippet" }],
          details: {},
        });
      },
    };
    const fetchUrl: AgentTool = {
      name: "fetch_url",
      label: "Fetch URL",
      description: "Fetch a URL",
      parameters: Type.Object({ url: Type.String() }),
      execute: (_id, params) => {
        toolCalls.push({ name: "fetch_url", params });
        return Promise.resolve({
          content: [{ type: "text", text: "# Example\n\nSource: https://example.com/post\n\nFetched page body" }],
          details: {},
        });
      },
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "I'll check, one sec.",
          toolCalls: [{
            id: "call-search",
            type: "function",
            function: { name: "web_search", arguments: "{\"query\":\"example\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      if (calls === 2) {
        expect(request.messages.some((m) =>
          m.role === "tool" && typeof m.content === "string" && m.content.includes("https://example.com/post"),
        )).toBe(true);
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-fetch",
            type: "function",
            function: { name: "fetch_url", arguments: "{\"url\":\"https://example.com/post\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      expect(request.messages.some((m) =>
        m.role === "tool" && typeof m.content === "string" && m.content.includes("Fetched page body"),
      )).toBe(true);
      return Promise.resolve({
        text: "Fetched summary [source](https://example.com/post)",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    const senderCalls: Array<{ text: string; reply: boolean }> = [];
    const sender: MessageSender = (text, reply) => {
      senderCalls.push({ text, reply });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const onStillWorking = mock(() => {});

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [webSearch, fetchUrl],
        completeChat,
        sender,
        onStillWorking,
        guildConfig: makeGuildConfig({ replyLoop: { maxToolCalls: 2, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 } }),
      }),
    );

    expect(result.responseText).toBe("Fetched summary [source](https://example.com/post)");
    expect(toolCalls).toEqual([
      { name: "web_search", params: { query: "example" } },
      { name: "fetch_url", params: { url: "https://example.com/post" } },
    ]);
    expect(senderCalls).toEqual([
      { text: "I'll check, one sec.", reply: true },
      { text: "Fetched summary [source](https://example.com/post)", reply: false },
    ]);
    expect(onStillWorking).toHaveBeenCalledTimes(1);
  });

  test("sends voice directive segments as TTS audio", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "Text first <voice>[whispers] quiet line</voice> text after",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; reply: boolean; voice: boolean; historyText?: string }> = [];
    const sender: MessageSender = (text, reply, _chatId, voice) => {
      senderCalls.push({ text, reply, voice: voice !== undefined, historyText: voice?.historyText });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const speechTexts: string[] = [];
    const generateSpeech = (text: string): Promise<TtsResult> => {
      speechTexts.push(text);
      return Promise.resolve({ ok: true, buffer: Buffer.from("audio"), contentType: "audio/mpeg" });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, ttsEnabled: true, generateSpeech }),
    );

    expect(senderCalls).toEqual([
      {
        text: "Text first\ntext after",
        reply: true,
        voice: true,
        historyText: "Text first\n<voice>[whispers] quiet line</voice>\ntext after",
      },
    ]);
    expect(speechTexts).toEqual(["[whispers] quiet line"]);
    expect(result.responseText).toBe('Text first\n<voice>[whispers] quiet line</voice>\ntext after');
  });

  test("keeps Discord pings as text content instead of generated speech", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<voice>@user hey</voice>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; voice: boolean; historyText?: string }> = [];
    const sender: MessageSender = (text, _reply, _chatId, voice) => {
      senderCalls.push({ text, voice: voice !== undefined, historyText: voice?.historyText });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const speechTexts: string[] = [];
    const generateSpeech = (text: string): Promise<TtsResult> => {
      speechTexts.push(text);
      return Promise.resolve({ ok: true, buffer: Buffer.from("audio"), contentType: "audio/mpeg" });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, ttsEnabled: true, generateSpeech }),
    );

    expect(senderCalls).toEqual([{
      text: "@user",
      voice: true,
      historyText: "@user\n<voice>hey</voice>",
    }]);
    expect(speechTexts).toEqual(["hey"]);
    expect(result.responseText).toBe("@user\n<voice>hey</voice>");
  });

  test("stores sanitized voice XML in sender history and memory extraction", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<voice>[SLOW] Седьмая. [sings] Ладно. [heavy sigh, then amused resignation] Ещё.</voice>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; historyText?: string }> = [];
    const sender: MessageSender = (text, _reply, _chatId, voice) => {
      senderCalls.push({ text, historyText: voice?.historyText });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const afterReplyCalls: unknown[] = [];
    const afterReply = (request: unknown): Promise<void> => {
      afterReplyCalls.push(request);
      return Promise.resolve();
    };
    const generateSpeech = (): Promise<TtsResult> =>
      Promise.resolve({ ok: true, buffer: Buffer.from("audio"), contentType: "audio/mpeg" });

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, ttsEnabled: true, generateSpeech, afterReply }),
    );

    expect(senderCalls).toEqual([{
      text: "",
      historyText: "<voice>[SLOW] Седьмая. [sings] Ладно. [heavy sigh, then amused resignation] Ещё.</voice>",
    }]);
    expect(afterReplyCalls[0]).toMatchObject({
      assistantReply: "<voice>[SLOW] Седьмая. [sings] Ладно. [heavy sigh, then amused resignation] Ещё.</voice>",
    });
    expect(result.responseText).toBe("<voice>[SLOW] Седьмая. [sings] Ладно. [heavy sigh, then amused resignation] Ещё.</voice>");
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

  test("retries LLM output timeouts before sending final response", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls < 3) return Promise.reject(makeModelTimeoutError());
      return Promise.resolve({
        text: "recovered after timeout",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "recovered after timeout" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat }),
    );

    expect(result.responseText).toBe("recovered after timeout");
    expect(calls).toBe(3);
  });

  test("retries empty final model responses before sending final response", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls < 3) {
        return Promise.resolve({
          text: "",
          toolCalls: [],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 0, totalTokens: 1 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "non-empty answer",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "non-empty answer" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat }),
    );

    expect(result.responseText).toBe("non-empty answer");
    expect(calls).toBe(3);
  });

  test("does not retry empty text when the model returned tool calls", async () => {
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
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls === 1) {
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
      return Promise.resolve({
        text: "answer from tool",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer from tool" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [tool], completeChat }),
    );

    expect(result.responseText).toBe("answer from tool");
    expect(calls).toBe(2);
    expect(toolCalls).toEqual([{ query: "x" }]);
  });

  test("stops retrying empty final model responses after three attempts", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      return Promise.resolve({
        text: "",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 0, totalTokens: 1 }, content: [] },
      });
    };
    const sender: MessageSender = mock(() => Promise.resolve({ sentMessageId: "sent-1" }));

    let thrown: unknown;
    try {
      await handleMessage(
        makeMessage({ mentionedUserIds: ["bot-1"] }),
        makeDeps({ completeChat, sender }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Model produced an empty response.");
    expect(calls).toBe(3);
    expect(sender).toHaveBeenCalledTimes(0);
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

  test("runs safe read-only tool calls in parallel and preserves tool message order", async () => {
    let active = 0;
    let maxActive = 0;
    const starts: string[] = [];
    const finishes: string[] = [];
    const fetchUrl: AgentTool = {
      name: "fetch_url",
      label: "Fetch URL",
      description: "Fetch a URL",
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id, params) => {
        const { url } = params as { url: string };
        starts.push(url);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, url.endsWith("/one") ? 30 : 10));
        active -= 1;
        finishes.push(url);
        return {
          content: [{ type: "text", text: `body for ${url}` }],
          details: {},
        };
      },
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [
            { id: "call-one", type: "function", function: { name: "fetch_url", arguments: "{\"url\":\"https://example.com/one\"}" } },
            { id: "call-two", type: "function", function: { name: "fetch_url", arguments: "{\"url\":\"https://example.com/two\"}" } },
          ],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      const toolMessages = request.messages.filter((m) => m.role === "tool");
      expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["call-one", "call-two"]);
      expect(toolMessages[0]?.content).toContain("body for https://example.com/one");
      expect(toolMessages[1]?.content).toContain("body for https://example.com/two");
      return Promise.resolve({
        text: "parallel answer",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "parallel answer" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [fetchUrl], completeChat }),
    );

    expect(result.responseText).toBe("parallel answer");
    expect(maxActive).toBe(2);
    expect(starts).toEqual(["https://example.com/one", "https://example.com/two"]);
    expect(finishes).toEqual(["https://example.com/two", "https://example.com/one"]);
  });

  test("forces a final answer when the native tool call budget is exhausted", async () => {
    const toolCalls: unknown[] = [];
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: (_id, params) => {
        toolCalls.push(params);
        return Promise.resolve({ content: [{ type: "text", text: "first result" }], details: {} });
      },
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [
            { id: "call-1", type: "function", function: { name: "lookup", arguments: "{\"query\":\"x\"}" } },
            { id: "call-2", type: "function", function: { name: "lookup", arguments: "{\"query\":\"y\"}" } },
          ],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      expect(request.toolChoice).toBe("none");
      expect(request.tools).toEqual([]);
      expect(request.messages.some((m) =>
        m.role === "tool" && m.tool_call_id === "call-1" && typeof m.content === "string" && m.content.includes("first result")
      )).toBe(true);
      expect(request.messages.some((m) =>
        m.role === "tool" && m.tool_call_id === "call-2" && typeof m.content === "string" && m.content.includes("budget exhausted")
      )).toBe(true);
      return Promise.resolve({
        text: "answer from partial tool results",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer from partial tool results" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        guildConfig: makeGuildConfig({ replyLoop: { maxToolCalls: 1, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 } }),
      }),
    );

    expect(result.responseText).toBe("answer from partial tool results");
    expect(toolCalls).toEqual([{ query: "x" }]);
  });

  test("forces a final answer when the native tool round budget is exhausted", async () => {
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "first result" }], details: {} }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls <= 2) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: `call-${calls}`,
            type: "function",
            function: { name: "lookup", arguments: `{"query":"${calls}"}` },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      expect(request.toolChoice).toBe("none");
      expect(request.tools).toEqual([]);
      expect(request.messages.some((m) =>
        m.role === "tool" && m.tool_call_id === "call-2" && typeof m.content === "string" && m.content.includes("round budget exhausted")
      )).toBe(true);
      return Promise.resolve({
        text: "answer after too many rounds",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer after too many rounds" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        guildConfig: makeGuildConfig({ replyLoop: { maxToolCalls: 1, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 } }),
      }),
    );

    expect(result.responseText).toBe("answer after too many rounds");
    expect(calls).toBe(3);
  });

  test("forces a final answer when agent time expires during an LLM turn", async () => {
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "unused" }], details: {} }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_, reject) => {
          const signal = request.signal;
          if (signal === undefined) {
            reject(new Error("expected abort signal"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
          }, { once: true });
        });
      }

      expect(request.toolChoice).toBe("none");
      expect(request.tools).toEqual([]);
      expect(request.signal?.aborted).toBe(false);
      expect(request.messages.some((m) =>
        m.role === "system"
        && typeof m.content === "string"
        && m.content.includes("agent time budget exhausted")
      )).toBe(true);
      return Promise.resolve({
        text: "answer from available context",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer from available context" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        guildConfig: makeGuildConfig({ replyLoop: { maxToolCalls: 2, wallClockTimeoutMs: 10, llmOutputTimeoutMs: 1_000 } }),
      }),
    );

    expect(result.responseText).toBe("answer from available context");
    expect(calls).toBe(2);
  });

  test("switches to agent-time finalization when time expires during tool-budget final answer", async () => {
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "first result" }], details: {} }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [
            { id: "call-1", type: "function", function: { name: "lookup", arguments: "{\"query\":\"x\"}" } },
            { id: "call-2", type: "function", function: { name: "lookup", arguments: "{\"query\":\"y\"}" } },
          ],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      if (calls === 2) {
        expect(request.toolChoice).toBe("none");
        expect(request.signal).toBeDefined();
        return new Promise((_, reject) => {
          const signal = request.signal;
          if (signal === undefined) {
            reject(new Error("expected abort signal"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
          }, { once: true });
        });
      }

      expect(request.toolChoice).toBe("none");
      expect(request.tools).toEqual([]);
      expect(request.signal?.aborted).toBe(false);
      expect(request.messages.some((m) =>
        m.role === "tool"
        && m.tool_call_id === "call-2"
        && typeof m.content === "string"
        && m.content.includes("tool call budget exhausted")
      )).toBe(true);
      expect(request.messages.some((m) =>
        m.role === "system"
        && typeof m.content === "string"
        && m.content.includes("agent time budget exhausted")
      )).toBe(true);
      return Promise.resolve({
        text: "answer after finalization timeout",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer after finalization timeout" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        guildConfig: makeGuildConfig({ replyLoop: { maxToolCalls: 1, wallClockTimeoutMs: 50, llmOutputTimeoutMs: 1_000 } }),
      }),
    );

    expect(result.responseText).toBe("answer after finalization timeout");
    expect(calls).toBe(3);
  });

  test("forces a final answer when agent time expires during tool execution", async () => {
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: (_id, _params, signal) => new Promise((_, reject) => {
        if (signal === undefined) {
          reject(new Error("expected abort signal"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error("tool aborted"));
        }, { once: true });
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
            function: { name: "lookup", arguments: "{\"query\":\"x\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      expect(request.toolChoice).toBe("none");
      expect(request.messages.some((m) =>
        m.role === "tool"
        && m.tool_call_id === "call-1"
        && typeof m.content === "string"
        && m.content.includes("agent time budget exhausted")
      )).toBe(true);
      expect(request.messages.some((m) =>
        m.role === "system"
        && typeof m.content === "string"
        && m.content.includes("agent time budget exhausted")
      )).toBe(true);
      return Promise.resolve({
        text: "answer after timed out tool",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer after timed out tool" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        guildConfig: makeGuildConfig({ replyLoop: { maxToolCalls: 2, wallClockTimeoutMs: 10, llmOutputTimeoutMs: 1_000 } }),
      }),
    );

    expect(result.responseText).toBe("answer after timed out tool");
    expect(calls).toBe(2);
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

  test("returns a clear tool error instead of image parts for text-only models", async () => {
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

      const toolMessage = request.messages.find((m) => m.role === "tool" && m.name === "read_chat_images");
      expect(typeof toolMessage?.content).toBe("string");
      expect(toolMessage?.content).toContain("current LLM endpoint cannot read image input");
      expect(request.messages.some((m) =>
        Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")
      )).toBe(false);

      return Promise.resolve({
        text: "cannot inspect image",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "cannot inspect image" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        guildConfig: makeGuildConfig({ model: "deepseek/deepseek-v4-pro:price" }),
      }),
    );

    expect(result.responseText).toBe("cannot inspect image");
  });

  test("uses fallback image model when the selected model cannot read image input", async () => {
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

    let mainCalls = 0;
    let imageCalls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      if (request.model === "moonshotai/kimi-k2.5") {
        imageCalls += 1;
        expect(request.systemPrompt).toContain("You describe images");
        expect(request.systemPrompt).toContain("race/ethnicity/skin tone");
        expect(request.systemPrompt).toContain("Use normal words like woman");
        expect(request.systemPrompt).toContain("selfie");
        expect(request.systemPrompt).toContain("movie/TV/anime/game frame");
        expect(request.systemPrompt).toContain("actor");
        expect(request.systemPrompt).toContain("vibe");
        expect(request.messages.some((m) =>
          Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")
        )).toBe(true);
        return Promise.resolve({
          text: "A very detailed image description.",
          toolCalls: [],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "A very detailed image description." }] },
        });
      }

      mainCalls += 1;
      if (mainCalls === 1) {
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

      const toolMessage = request.messages.find((m) => m.role === "tool" && m.name === "read_chat_images");
      expect(toolMessage?.content).toContain("Native image reading was unavailable");
      expect(toolMessage?.content).toContain("fallback image model moonshotai/kimi-k2.5");
      expect(toolMessage?.content).toContain("A very detailed image description.");
      expect(request.messages.some((m) =>
        Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")
      )).toBe(false);

      return Promise.resolve({
        text: "fallback answer",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "fallback answer" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        guildConfig: makeGuildConfig({
          model: "deepseek/deepseek-v4-pro:price",
          imageReading: {
            fallbackEnabled: true,
            fallbackModel: "moonshotai/kimi-k2.5",
            fallbackModelParams: { temperature: 0 },
          },
        }),
      }),
    );

    expect(result.responseText).toBe("fallback answer");
    expect(mainCalls).toBe(2);
    expect(imageCalls).toBe(1);
  });

  test("recovers when provider rejects image input after an image tool result", async () => {
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
      if (calls === 2) {
        throw new Error("No endpoints found that support image input; rawResponse={\"error\":{\"message\":\"No endpoints found that support image input\",\"code\":404}}");
      }

      expect(request.messages.some((m) =>
        Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")
      )).toBe(false);
      const toolMessage = request.messages.find((m) => m.role === "tool" && m.name === "read_chat_images");
      expect(toolMessage?.content).toContain("current LLM endpoint cannot read image input");
      expect(request.messages.filter((m) => m.role === "user")).toHaveLength(1);

      return Promise.resolve({
        text: "cannot inspect image",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "cannot inspect image" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [tool], completeChat }),
    );

    expect(result.responseText).toBe("cannot inspect image");
    expect(calls).toBe(3);
  });

  test("falls back to image description when provider rejects native image input", async () => {
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

    let mainCalls = 0;
    let fallbackCalls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      if (request.systemPrompt.includes("You describe images")) {
        fallbackCalls += 1;
        expect(request.messages.some((m) =>
          Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")
        )).toBe(true);
        return Promise.resolve({
          text: "Fallback saw a small square test image.",
          toolCalls: [],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "Fallback saw a small square test image." }] },
        });
      }

      mainCalls += 1;
      if (mainCalls === 1) {
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
      if (mainCalls === 2) {
        throw new Error("No endpoints found that support image input; rawResponse={\"error\":{\"message\":\"No endpoints found that support image input\",\"code\":404}}");
      }

      expect(request.messages.some((m) =>
        Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")
      )).toBe(false);
      const toolMessage = request.messages.find((m) => m.role === "tool" && m.name === "read_chat_images");
      expect(toolMessage?.content).toContain("Native image reading was unavailable");
      expect(toolMessage?.content).toContain("Fallback saw a small square test image.");
      expect(request.messages.filter((m) => m.role === "user")).toHaveLength(1);

      return Promise.resolve({
        text: "described image answer",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "described image answer" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        guildConfig: makeGuildConfig({
          imageReading: {
            fallbackEnabled: true,
            fallbackModel: "moonshotai/kimi-k2.5",
            fallbackModelParams: {},
          },
        }),
      }),
    );

    expect(result.responseText).toBe("described image answer");
    expect(mainCalls).toBe(3);
    expect(fallbackCalls).toBe(1);
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
      makeDeps({
        afterReply,
        context: makeContext({
          sections: [
            { label: "Server Members", text: "## Server Members\n@user", cached: false, role: "developer" },
            { label: "Memories", text: "## Memory\n- 1 [@user] [preference] concise", cached: false, role: "developer" },
            { label: "Chat History — Older", text: "## Chat History — Older\n[@old]: cached", cached: true, role: "system" },
            { label: "Chat History — Newer", text: "## Chat History\n[@bob]: relevant context", cached: false, role: "developer" },
            { label: "Current Context", text: "Guild: g1", cached: false, role: "developer" },
          ],
        }),
      }),
    );

    expect(afterReplyCalls).toHaveLength(1);
    expect(afterReplyCalls[0]).toMatchObject({
      sourceMessageId: "msg-1",
      userMessage: "hello bot",
      assistantReply: "hello user",
      recentContext: "## Chat History\n[@bob]: relevant context",
    });
    expect(JSON.stringify(afterReplyCalls[0])).not.toContain("Server Members");
    expect(JSON.stringify(afterReplyCalls[0])).not.toContain("cached");
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
