import { describe, expect, mock, test } from "bun:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { handleMessage, hasMaintenanceMaterial, injectTriggerInstruction, runSilentMemoryAgentPass, runSilentToolAgentPass, type ChatCompleteFn, type HandlerDeps, type IncomingMessage, type MessageSender, type VoiceAttachment } from "./handler.ts";
import type { AssembledContext, ContextSection } from "./context-assembly.ts";
import type { GlobalConfig, GuildConfig, PromptTransportConfig } from "../config/types.ts";
import type { TtsResult } from "../tts/types.ts";
import { RequestLog } from "../logger.ts";
import type { RuntimePromptBundle } from "../config/instruction-bundle.ts";
import type { OpenRouterMessage } from "../llm/types.ts";

const TEST_RUNTIME_PROMPTS = {
  reply: "# Runtime Core\nReserved action directives.",
  finalActionInstruction: "## Final Action Instruction\nSend visible output or intentionally stay silent.",
  toolDescriptions: {},
  toolParameterDescriptions: {},
  contextTemplates: {
    "agent-time-budget-exhausted": "Native turn time budget exhausted after {{timeoutMs}}ms; stop tool use.",
    "memory-pass-decision": "Review only strongly implied durable facts. Before adding, check existing memories. Prefer expiresIn for relative expiry.",
    "visible-reply-execution-mode": "## Execution Mode: Visible Reply\nPersona-specific visible mode.",
    "scheduled-task-execution-mode": "## Scheduled Task Context\nPersona-specific scheduled mode.",
  },
  memoryContextTemplates: {},
  imageDescriptionSystemPrompt: [
    "Describe images for another Discord chat model.",
    "Mention visible race/ethnicity/skin tone only when relevant.",
    "Use normal words like woman when useful.",
    "Call out whether this looks like a selfie, movie/TV/anime/game frame, actor, or vibe.",
  ].join("\n"),
  ambientAttentionEvaluator: {
    shared: "Ambient shared.",
    ambientPickup: "Ambient pickup.",
    lingeringAttention: "Lingering attention.",
    followUp: "Follow up.",
  },
  ambientInitiative: {
    evaluator: {
      shared: "Initiative evaluator shared.",
      selfExpression: "Initiative evaluator self.",
      targetedCheckin: "Initiative evaluator checkin.",
    },
    generation: {
      shared: "Initiative generation shared.",
      selfExpression: "Initiative generation self.",
      targetedCheckin: "Initiative generation checkin.",
    },
  },
  relationships: { context: "Relationship context." },
  skills: {
    byId: {
      image_generation: {
        id: "image_generation",
        title: "Image Generation",
        description: "Use for generated images.",
        requiredForTools: ["codex_generate_image"],
        instructionDocuments: [],
        content: "# Skill: Image Generation\nUse the image tool.",
      },
    },
    indexPrompt: "## Skills\n- image_generation: Use for generated images. Required before: codex_generate_image.",
    requiredByTool: { codex_generate_image: "image_generation" },
  },
} satisfies RuntimePromptBundle;

function makePromptTransportConfig(): PromptTransportConfig {
  return {
    openaiCodex: {
      mode: "split-input",
      sections: {
        system: { role: "developer", target: "instructions", cacheGroup: "core" },
        core: { role: "developer", target: "input", cacheGroup: "core" },
        skills: { role: "developer", target: "input", cacheGroup: "runtime" },
        runtime: { role: "developer", target: "input", cacheGroup: "runtime" },
        stableContext: { role: "user", target: "input", cacheGroup: "stable-context" },
        olderHistory: { role: "user", target: "input", cacheGroup: "older-history" },
        serverMembers: { role: "user", target: "input" },
        threadsInChannel: { role: "user", target: "input" },
        discordContext: { role: "user", target: "input" },
        upcomingSchedules: { role: "user", target: "input" },
        memories: { role: "user", target: "input" },
        recentHistory: { role: "user", target: "input" },
        currentContext: { role: "user", target: "input" },
        responseInstruction: { role: "developer", target: "input" },
        currentTurn: { role: "user", target: "input" },
        finalActionInstruction: { role: "user", target: "input" },
      },
    },
    openrouter: {
      mode: "split-input",
      sections: {
        system: { role: "developer", target: "input", cacheGroup: "core" },
        core: { role: "developer", target: "input", cacheGroup: "core" },
        skills: { role: "developer", target: "input", cacheGroup: "runtime" },
        runtime: { role: "developer", target: "input", cacheGroup: "runtime" },
        stableContext: { role: "user", target: "input", cacheGroup: "stable-context" },
        olderHistory: { role: "user", target: "input", cacheGroup: "older-history" },
        serverMembers: { role: "user", target: "input" },
        threadsInChannel: { role: "user", target: "input" },
        discordContext: { role: "user", target: "input" },
        upcomingSchedules: { role: "user", target: "input" },
        memories: { role: "user", target: "input" },
        recentHistory: { role: "user", target: "input" },
        currentContext: { role: "user", target: "input" },
        responseInstruction: { role: "developer", target: "input" },
        currentTurn: { role: "user", target: "input" },
        finalActionInstruction: { role: "user", target: "input" },
      },
    },
  };
}

function makeGlobalConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    discordToken: "test-token",
    openrouterApiKey: "test-key",
    codexAuthPath: "data/codex-auth.json",
    codexTransport: "websocket-cached",
    defaultLlmProvider: "openrouter",
    defaultModel: "moonshotai/kimi-k2.5",
    defaultModelParams: {},
    defaultTimezone: "UTC",
    defaultTrim: { trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 },
    defaultTriggers: { mention: true, keywords: [], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingResumeGraceMs: 3000, typingMaxWaitMs: 15000 },
    defaultTriggerInstructions: {},
    defaultMergeMessageGapSeconds: 120,
    defaultImageReferenceMaxPerCall: 10,
    defaultImageReading: { fallbackEnabled: false, fallbackModel: "moonshotai/kimi-k2.5", fallbackModelParams: {} },
    defaultImageGeneration: { quality: "auto" },
    logLevel: "info",
    dataDir: "./data",
    uiLang: "en",
    defaultEmotes: { include: false },
    defaultMembers: { include: true },
    defaultDispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
    defaultTypingSimulation: { enabled: false, inputReadingWpm: 450, inputMinDelayMs: 300, inputMaxDelayMs: 3500, outputTypingWpm: 180, outputMinHoldMs: 700, outputMaxHoldMs: 3500 },
    defaultAgentJobs: { imageTimeoutMs: 300_000, imageCancelGraceMs: 60_000, terminalVisibleMs: 600_000, maxImageReplacements: 2 },
    defaultSchedulePressure: { maxRequesterRunsPerHour: 120, maxRequesterRunsPerDay: 500, maxGuildRunsPerHour: 600, maxGuildRunsPerDay: 3000 },
    defaultPromptCaching: { enabled: true },
    defaultPromptTransport: makePromptTransportConfig(),
    defaultBackgroundLlm: { modelParams: {} },
    defaultReplyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
    defaultReasoningContinuation: { enabled: true, maxAgeMs: 30 * 60 * 1000 },
    defaultMemoryExtraction: {
      postReply: true,
      maxToolCalls: 5,
      ambient: { enabled: false, everyMessages: 300, maxBatchMessages: 300, minIntervalSeconds: 600 },
    },
    ...overrides,
  };
}

function makeGuildConfig(overrides: Partial<GuildConfig> = {}): GuildConfig {
  return {
    guildId: "guild-1",
    slug: "test",
    triggers: { mention: true, keywords: [], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingResumeGraceMs: 3000, typingMaxWaitMs: 15000 },
    triggerInstructions: {},
    timezone: "UTC",
    trim: { trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 },
    adminUserIds: [],
    mergeMessageGapSeconds: 120,
    imageReferenceMaxPerCall: 10,
    imageReading: { fallbackEnabled: false, fallbackModel: "moonshotai/kimi-k2.5", fallbackModelParams: {} },
    imageGeneration: { quality: "auto" },
    instructions: "",
    emotes: { include: false },
    members: { include: true },
    dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
    typingSimulation: { enabled: false, inputReadingWpm: 450, inputMinDelayMs: 300, inputMaxDelayMs: 3500, outputTypingWpm: 180, outputMinHoldMs: 700, outputMaxHoldMs: 3500 },
    agentJobs: { imageTimeoutMs: 300_000, imageCancelGraceMs: 60_000, terminalVisibleMs: 600_000, maxImageReplacements: 2 },
    schedulePressure: { maxRequesterRunsPerHour: 120, maxRequesterRunsPerDay: 500, maxGuildRunsPerHour: 600, maxGuildRunsPerDay: 3000 },
    promptCaching: { enabled: true },
    promptTransport: makePromptTransportConfig(),
    backgroundLlm: {
      model: "moonshotai/kimi-k2.5",
      modelParams: {},
      promptCaching: { enabled: true },
    },
    replyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
    reasoningContinuation: { enabled: true, maxAgeMs: 30 * 60 * 1000 },
    memoryExtraction: {
      postReply: true,
      maxToolCalls: 5,
      ambient: { enabled: false, everyMessages: 300, maxBatchMessages: 300, minIntervalSeconds: 600 },
    },
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
    currentChannelId: "channel-1",
    personaPrompt: "You are a test bot.",
    runtimePrompts: TEST_RUNTIME_PROMPTS,
    sender,
    completeChat,
    liveMessageTypingHoldMs: 0,
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

function findMessageContent(messages: Array<{ content?: unknown }>, needle: string): string | undefined {
  return messages.map((message) => contentText(message.content)).find((content) => content.includes(needle));
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
      guildConfig: makeGuildConfig({ triggers: { mention: false, keywords: [], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingResumeGraceMs: 3000, typingMaxWaitMs: 15000 } }),
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
      guildConfig: makeGuildConfig({ triggers: { mention: false, keywords: [], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingResumeGraceMs: 3000, typingMaxWaitMs: 15000 } }),
      triggerOverride: { reason: "keyword", keyword: "туби" },
      completeChat: completeChat as unknown as ChatCompleteFn,
    }));

    expect(result.triggered).toBe(true);
    expect(result.triggerResult).toEqual({ reason: "keyword", keyword: "туби" });
    expect(completeChat).toHaveBeenCalledTimes(1);
  });

  test("sends direct final model text", async () => {
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ sender }),
    );

    expect(result.responseText).toBe("hello user");
    expect(senderCalls).toEqual([{ text: "hello user", reply: true, channelId: undefined }]);
  });

  test("routes individual message envelopes by channel_id", async () => {
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string; replyTo?: string }> = [];
    const sender: MessageSender = (text, reply, channelId, _voice, _signal, replyTo) => {
      senderCalls.push({ text, reply, channelId, replyTo });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message>here</message><message channel_id=\"thread-1\" reply_to=\"msg-9\">there</message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: {
        role: "assistant",
        model: "m",
        stopReason: "stop",
        content: [{ type: "text", text: "routed" }],
        usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
      },
    });

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ sender, completeChat }),
    );

    expect(senderCalls).toEqual([
      { text: "here", reply: true, channelId: undefined, replyTo: undefined },
      { text: "there", reply: false, channelId: "thread-1", replyTo: "msg-9" },
    ]);
  });

  test("same-current-channel routing does not suppress default first-message replies", async () => {
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message channel_id=\"channel-1\">same channel</message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "same channel" }] },
    });

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ sender, completeChat, currentChannelId: "channel-1" }),
    );

    expect(senderCalls).toEqual([{ text: "same channel", reply: true, channelId: "channel-1" }]);
  });

  test("cross-channel routed messages without reply_to default to normal sends", async () => {
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message channel_id=\"thread-1\">thread message</message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "thread message" }] },
    });

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ sender, completeChat, currentChannelId: "channel-1" }),
    );

    expect(senderCalls).toEqual([{ text: "thread message", reply: false, channelId: "thread-1" }]);
  });

  test("first current-channel message still replies after an earlier cross-channel send", async () => {
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message channel_id=\"thread-1\">thread message</message><message>current message</message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "messages" }] },
    });

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ sender, completeChat, currentChannelId: "channel-1" }),
    );

    expect(senderCalls).toEqual([
      { text: "thread message", reply: false, channelId: "thread-1" },
      { text: "current message", reply: true, channelId: undefined },
    ]);
  });

  test("does not require OpenRouter image fallback options when Codex fallback is disabled", async () => {
    const completeChat: ChatCompleteFn = (request) => {
      expect(request.provider).toBe("openai-codex");
      expect(request.apiKey).toBe("");
      expect(request.providerParams?.codexAuthPath).toBe("data/codex-auth.json");
      return Promise.resolve({
        text: "codex reply",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        globalConfig: makeGlobalConfig({
          openrouterApiKey: undefined,
          defaultLlmProvider: "openai-codex",
          defaultModel: "gpt-5.5",
        }),
        guildConfig: makeGuildConfig({
          llmProvider: "openai-codex",
          model: "gpt-5.5",
          imageReading: { fallbackEnabled: false, fallbackModel: "moonshotai/kimi-k2.5", fallbackModelParams: {} },
          imageGeneration: { quality: "auto" },
        }),
        completeChat,
      }),
    );

    expect(result.responseText).toBe("codex reply");
  });

  test("sends keyword-triggered final text as a reply", async () => {
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ content: "hello bot", translatedContent: "hello bot" }),
      makeDeps({
        guildConfig: makeGuildConfig({
          triggers: { mention: false, keywords: ["bot"], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingResumeGraceMs: 3000, typingMaxWaitMs: 15000 },
        }),
        sender,
      }),
    );

    expect(senderCalls).toEqual([{ text: "hello user", reply: true, channelId: undefined }]);
  });

  test("includes loaded runtime prompts before volatile turn context", async () => {
    const completeChat: ChatCompleteFn = (request) => {
      const payload = {
        messages: [
          ...(request.systemPrompt !== "" ? [{ role: "system", content: request.systemPrompt }] : []),
          ...request.messages,
        ],
      };
      request.onPayload?.(payload);
      const text = payloadText(payload);
      expect(text).toContain(TEST_RUNTIME_PROMPTS.skills.indexPrompt.trim());
      expect(text).toContain(TEST_RUNTIME_PROMPTS.reply.trim());
      expect(text).toContain(TEST_RUNTIME_PROMPTS.finalActionInstruction.trim());
      expect(text).toContain(TEST_RUNTIME_PROMPTS.contextTemplates["visible-reply-execution-mode"]);
      expect(text.indexOf(TEST_RUNTIME_PROMPTS.reply.trim())).toBeLessThan(text.indexOf("## Memory"));
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
      expect(messages[0]?.role).toBe("developer");
      expect(contentText(messages[0]?.content)).toContain("You are a test bot.");
      expect(contentText(messages[0]?.content)).not.toContain(TEST_RUNTIME_PROMPTS.reply.trim());
      expect(messages[1]?.role).toBe("developer");
      expect(contentText(messages[1]?.content)).toContain(TEST_RUNTIME_PROMPTS.skills.indexPrompt.trim());
      expect(contentText(messages[1]?.content)).toContain("image_generation");
      expect(contentText(messages[1]?.content)).toContain(TEST_RUNTIME_PROMPTS.reply.trim());
      expect(messages[2]).toEqual({
        role: "user",
        content: "Stable context is loaded; wait for the current Discord turn.",
      });
      expect(messages[3]).toEqual({ role: "assistant", content: "Ready." });
      expect(findMessageContent(messages, "## Memory")).toContain("- 1 [@user] [preference] concise");
      expect(findMessageContent(messages, "## Server Members")).toContain("@user");
      expect(findMessageContent(messages, "Guild: g1")).toBe("Guild: g1");
      const currentTurn = findMessageContent(messages, "## New Discord Event");
      expect(currentTurn).toContain("## Discord Event Metadata");
      expect(currentTurn).toContain("Trigger MsgID: msg-1");
      expect(currentTurn).toContain("Trigger Author: @testuser");
      expect(currentTurn).toContain("Trigger AuthorID: user-1");
      expect(currentTurn).toContain("Trigger DisplayName: Test Nick");
      expect(currentTurn).toContain("Trigger GlobalName: Test Global");
      expect(currentTurn).toContain("Trigger AuthorIsBot: false");
      expect(currentTurn).toContain("Trigger ReplyToMsgID: parent-msg");
      expect(currentTurn).toContain("Audio: #29 chunk_08.wav");
      expect(currentTurn).toContain("Reply Context: The current event replies to a message you previously sent here from another channel.");
      expect(currentTurn).toContain("Source GuildID: source-guild");
      expect(currentTurn).toContain("Source ChannelID: source-channel");
      expect(currentTurn).toContain("Source MsgID: source-msg");
      expect(currentTurn).toContain("hello bot");
      const currentTurnIndex = messages.findIndex((message) => contentText(message.content).includes("## New Discord Event"));
      expect(messages[currentTurnIndex + 1]?.role).toBe("user");
      const finalAction = contentText(messages[currentTurnIndex + 1]?.content);
      expect(finalAction).toStartWith("## Execution Mode: Visible Reply");
      expect(finalAction).toContain(TEST_RUNTIME_PROMPTS.finalActionInstruction.trim());

      return Promise.resolve({
        text: "done",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({
        mentionedUserIds: ["bot-1"],
        replyToMessageId: "parent-msg",
        authorDisplayName: "Test Nick",
        authorGlobalName: "Test Global",
        authorIsBot: false,
        repliedToBotRouteSource: {
          sourceGuildId: "source-guild",
          sourceChannelId: "source-channel",
          sourceMessageId: "source-msg",
        },
        assets: [{
          id: 29,
          kind: "audio",
          sourceKind: "attachment",
          filename: "chunk_08.wav",
          contentType: "audio/wav",
          size: 5_030_816,
          width: null,
          height: null,
          durationSeconds: 198.3,
        }],
      }),
      makeDeps({ completeChat }),
    );
  });

  test("uses full debounced current-turn event content when provided", async () => {
    let currentTurn = "";
    const completeChat: ChatCompleteFn = (request) => {
      currentTurn = findMessageContent(request.messages, "## New Discord Event") ?? "";
      return Promise.resolve({
        text: "ok",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({
        translatedContent: "latest followup",
        eventContent: "first trigger [msg-break] latest followup",
        mentionedUserIds: ["bot-1"],
      }),
      makeDeps({ completeChat }),
    );

    expect(currentTurn).toContain("Trigger MsgID: msg-1");
    expect(currentTurn).toContain("first trigger [msg-break] latest followup");
  });

  test("marks an external bot author in current event metadata", async () => {
    let currentTurn = "";
    const completeChat: ChatCompleteFn = (request) => {
      currentTurn = findMessageContent(request.messages, "## New Discord Event") ?? "";
      return Promise.resolve({
        text: "ok",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({
        authorId: "other-bot",
        authorIsBot: true,
        mentionedUserIds: ["bot-1"],
      }),
      makeDeps({ completeChat }),
    );

    expect(currentTurn).toContain("Trigger AuthorIsBot: true");
  });

  test("splits Codex stable prompt into input messages", async () => {
    const completeChat: ChatCompleteFn = (request) => {
      const payload = {
        instructions: request.systemPrompt,
        input: request.messages.map((message) => ({
          type: "message",
          role: message.role,
          content: contentText(message.content),
        })),
      };
      request.onPayload?.(payload);

      expect(payload.instructions).toBe("Top-level policy.");
      expect(payload.instructions).not.toContain("You are a helpful assistant.");
      expect(payload.input[0]).toMatchObject({ role: "developer" });
      expect(contentText((payload.input[0] as { content?: unknown }).content)).toContain("You are a test bot.");
      expect(payload.input[1]).toMatchObject({ role: "developer" });
      expect(contentText((payload.input[1] as { content?: unknown }).content)).toContain("Reserved action directives");
      expect(payload.input.some((item) =>
        item.type === "message" && item.role === "user" && item.content.includes("## Memory")
      )).toBe(true);
      expect(payload.input.some((item) =>
        item.type === "message" && item.role === "user" && item.content.includes("## New Discord Event")
      )).toBe(true);
      const currentTurnIndex = payload.input.findIndex((item) =>
        item.type === "message" && item.content.includes("## New Discord Event")
      );
      expect(payload.input[currentTurnIndex + 1]).toMatchObject({
        type: "message",
        role: "user",
      });
      expect(payload.input[currentTurnIndex + 1]?.content).toContain("## Final Action Instruction");

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
        systemPrompt: "Top-level policy.",
        guildConfig: makeGuildConfig({ llmProvider: "openai-codex", model: "gpt-5.5" }),
      }),
    );
  });

  test("does not duplicate Codex instruction-target core prompt", async () => {
    const transport = makePromptTransportConfig();
    transport.openaiCodex.sections.core = {
      ...transport.openaiCodex.sections.core,
      target: "instructions",
    };
    let capturedPayload: { instructions?: unknown; input: unknown[] } | undefined;
    const completeChat: ChatCompleteFn = (request) => {
      const payload = {
        instructions: request.systemPrompt,
        input: request.messages.map((message) => ({
          type: "message",
          role: message.role,
          content: contentText(message.content),
        })),
      };
      request.onPayload?.(payload);
      capturedPayload = payload;

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
        guildConfig: makeGuildConfig({ llmProvider: "openai-codex", model: "gpt-5.5", promptTransport: transport }),
      }),
    );

    if (capturedPayload === undefined) throw new Error("expected payload capture");
    expect(typeof capturedPayload.instructions).toBe("string");
    expect(capturedPayload.instructions).toContain("You are a test bot.");
    const promptText = JSON.stringify(capturedPayload);
    expect(promptText.match(/You are a test bot\./g)?.length).toBe(1);
  });

  test("keeps older chat history in the stable prompt instead of volatile turn context", async () => {
    const completeChat: ChatCompleteFn = (request) => {
      const payload = { messages: [...request.messages] };
      request.onPayload?.(payload);

      const messages = payload.messages as Array<{ role?: string; content?: unknown }>;
      const olderHistory = contentText(messages[2]?.content);
      const recentHistory = findMessageContent(messages, "## Chat History\n[@new]: volatile recent");
      expect(olderHistory).toContain("## Chat History — Older");
      expect(olderHistory).toContain("[@old]: cached chunk");
      expect(recentHistory).toContain("## Chat History\n[@new]: volatile recent");
      expect(recentHistory).not.toContain("[@old]: cached chunk");

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
      "2b2v:guild-1:channel-1:openrouter:moonshotai/kimi-k2.5",
      "2b2v:guild-1:channel-1:openrouter:moonshotai/kimi-k2.5",
    ]);
  });

  test("hashes long provider session ids to fit OpenAI prompt cache key limits", async () => {
    const sessionIds: Array<string | undefined> = [];
    const completeChat: ChatCompleteFn = (request) => {
      sessionIds.push(request.sessionId);
      return Promise.resolve({
        text: "ok",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "ok" }] },
      });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        globalConfig: makeGlobalConfig({ defaultLlmProvider: "openai-codex", defaultModel: "gpt-5.5" }),
        guildConfig: makeGuildConfig({
          llmProvider: "openai-codex",
          model: "gpt-5.5",
        }),
        requestLog: new RequestLog("1075346959298199564", "1080016551471743046"),
      }),
    );

    expect(sessionIds[0]?.startsWith("2b2v:")).toBe(true);
    expect(sessionIds[0]?.length).toBeLessThanOrEqual(64);
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

  test("sends message directive segments as separate Discord messages", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message>first line</message><message>second line</message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; reply: boolean }> = [];
    const sender: MessageSender = (text, reply) => {
      senderCalls.push({ text, reply });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const afterReplyCalls: unknown[] = [];
    const afterReply = (request: unknown): Promise<void> => {
      afterReplyCalls.push(request);
      return Promise.resolve();
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, afterReply }),
    );

    expect(senderCalls).toEqual([
      { text: "first line", reply: true },
      { text: "second line", reply: false },
    ]);
    expect(afterReplyCalls[0]).toMatchObject({
      assistantReply: "first line\n[msg-break]\nsecond line",
    });
    expect(result.responseText).toBe("first line\n[msg-break]\nsecond line");
  });

  test("applies message delivery attributes per Discord message", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: [
        "<message reply=\"false\">normal first</message>",
        "<message reply=\"true\">reply second</message>",
        "<message reply_to=\"older-123\">targeted third</message>",
        "<message>normal fourth</message>",
      ].join(""),
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; reply: boolean; replyToMessageId?: string }> = [];
    const sender: MessageSender = (text, reply, _channelId, _voice, _signal, replyToMessageId) => {
      senderCalls.push({ text, reply, replyToMessageId });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender }),
    );

    expect(senderCalls).toEqual([
      { text: "normal first", reply: false, replyToMessageId: undefined },
      { text: "reply second", reply: true, replyToMessageId: undefined },
      { text: "targeted third", reply: false, replyToMessageId: "older-123" },
      { text: "normal fourth", reply: false, replyToMessageId: undefined },
    ]);
  });

  test("attaches typed asset_ids on the requested message only", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message asset_ids=[12]>again</message><message asset_ids=[13]></message><message>done</message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; attachmentIds: string[] }> = [];
    const sender: MessageSender = (text, _reply, _channelId, _voice, _signal, _replyToMessageId, attachments) => {
      senderCalls.push({ text, attachmentIds: attachments?.map((attachment) => attachment.id) ?? [] });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        sender,
        resolveAssetAttachments: (assetIds) => Promise.resolve(assetIds.map((id) => ({
          id: `chat-asset-${id}`,
          buffer: Buffer.from("image"),
          filename: `chat-asset-${id}.png`,
          contentType: "image/png",
        }))),
      }),
    );

    expect(senderCalls).toEqual([
      { text: "again", attachmentIds: ["chat-asset-12"] },
      { text: "", attachmentIds: ["chat-asset-13"] },
      { text: "done", attachmentIds: [] },
    ]);
  });

  test("streams final message envelopes as they close", async () => {
    const lookupTool: AgentTool = {
      name: "search_channel_messages",
      label: "Search",
      description: "Search",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "tool result" }], details: {} }),
    };
    const events: string[] = [];
    let calls = 0;
    const completeChat: ChatCompleteFn = async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          text: "",
          toolCalls: [
            {
              id: "call-search",
              type: "function",
              function: { name: "search_channel_messages", arguments: "{\"query\":\"x\"}" },
            },
            {
              id: "call-search-skipped",
              type: "function",
              function: { name: "search_channel_messages", arguments: "{\"query\":\"y\"}" },
            },
          ],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        };
      }

      expect(request.toolChoice).toBe("none");
      await request.onTextDelta?.("<message keep_typing=\"true\">first</message><message>sec");
      events.push("after-first-delta");
      await request.onTextDelta?.("ond</message>");
      return {
        text: "<message keep_typing=\"true\">first</message><message>second</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const senderCalls: Array<{ text: string; reply: boolean }> = [];
    const sender: MessageSender = (text, reply) => {
      senderCalls.push({ text, reply });
      events.push(`sent:${text}`);
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const onStillWorking = mock(() => {
      events.push("typing");
    });

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        sender,
        extraTools: [lookupTool],
        onStillWorking,
        guildConfig: makeGuildConfig({ replyLoop: { maxToolCalls: 1, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 } }),
      }),
    );

    expect(events.indexOf("sent:first")).toBeLessThan(events.indexOf("after-first-delta"));
    expect(senderCalls).toEqual([
      { text: "first", reply: true },
      { text: "second", reply: false },
    ]);
    expect(onStillWorking).toHaveBeenCalled();
    expect(result.responseText).toBe("first\n[msg-break]\nsecond");
  });

  test("streams ordinary first-turn answers even when tools are available", async () => {
    const lookupTool: AgentTool = {
      name: "search_channel_messages",
      label: "Search",
      description: "Search",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "unused" }], details: {} }),
    };
    const events: string[] = [];
    const completeChat: ChatCompleteFn = async (request) => {
      expect(request.toolChoice).toBe("auto");
      await request.onTextDelta?.("<message>first normal</message><message>second");
      events.push("after-first-delta");
      await request.onTextDelta?.(" normal</message>");
      return {
        text: "<message>first normal</message><message>second normal</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const senderCalls: Array<{ text: string; reply: boolean }> = [];
    const sender: MessageSender = (text, reply) => {
      senderCalls.push({ text, reply });
      events.push(`sent:${text}`);
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, extraTools: [lookupTool] }),
    );

    expect(events.indexOf("sent:first normal")).toBeLessThan(events.indexOf("after-first-delta"));
    expect(senderCalls).toEqual([
      { text: "first normal", reply: true },
      { text: "second normal", reply: false },
    ]);
    expect(result.responseText).toBe("first normal\n[msg-break]\nsecond normal");
  });

  test("streaming consumes late ignore directives without dropping later messages", async () => {
    const finalText = "<message>first</message><ignore>skip</ignore><message>second</message>";
    const completeChat: ChatCompleteFn = async (request) => {
      await request.onTextDelta?.(finalText);
      return {
        text: finalText,
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const senderCalls: Array<{ text: string; reply: boolean }> = [];
    const sender: MessageSender = (text, reply) => {
      senderCalls.push({ text, reply });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const onIgnoredReply = mock(() => {});

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, onIgnoredReply }),
    );

    expect(senderCalls).toEqual([
      { text: "first", reply: true },
      { text: "second", reply: false },
    ]);
    expect(onIgnoredReply).toHaveBeenCalledTimes(0);
    expect(result.responseText).toBe("first\n[msg-break]\nsecond");
  });

  test("waits for typing indicator before sending the next streamed message", async () => {
    const events: string[] = [];
    let releaseTyping: (() => void) | undefined;
    const typingGate = new Promise<void>((resolve) => {
      releaseTyping = resolve;
    });
    const completeChat: ChatCompleteFn = async (request) => {
      const deltaPromise = request.onTextDelta?.("<message>first</message><message>sec") ?? Promise.resolve(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual(["sent:first", "typing-start"]);
      releaseTyping?.();
      await deltaPromise;
      await request.onTextDelta?.("ond</message>");
      return {
        text: "<message>first</message><message>second</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const sender: MessageSender = (text) => {
      events.push(`sent:${text}`);
      return Promise.resolve({ sentMessageId: `sent-${events.length}` });
    };
    const onStillWorking = async (): Promise<void> => {
      events.push("typing-start");
      await typingGate;
      events.push("typing-done");
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, onStillWorking }),
    );

    expect(events).toEqual(["sent:first", "typing-start", "typing-done", "sent:second"]);
  });

  test("emits typing between streamed messages that are already complete", async () => {
    const completeChat: ChatCompleteFn = async (request) => {
      await request.onTextDelta?.("<message keep_typing=\"true\">first</message><message>second</message>");
      return {
        text: "<message keep_typing=\"true\">first</message><message>second</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const events: string[] = [];
    const sentAt: number[] = [];
    const sender: MessageSender = (text) => {
      sentAt.push(Date.now());
      events.push(`sent:${text}`);
      return Promise.resolve({ sentMessageId: `sent-${events.length}` });
    };
    const onStillWorking = mock(() => {
      events.push("typing");
    });

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, onStillWorking, liveMessageTypingHoldMs: 25 }),
    );

    expect(events).toEqual(["sent:first", "typing", "sent:second"]);
    expect((sentAt[1] ?? 0) - (sentAt[0] ?? 0)).toBeGreaterThanOrEqual(15);
    expect(onStillWorking).toHaveBeenCalledTimes(1);
  });

  test("holds visible typing before each message when typing simulation is enabled", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message>first reply</message><message>second reply</message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const events: string[] = [];
    let typingStartedAt = 0;
    const sender: MessageSender = (text) => {
      events.push(`sent:${text}`);
      return Promise.resolve({ sentMessageId: `sent-${events.length}` });
    };
    const onStillWorking = mock(() => {
      typingStartedAt = Date.now();
      events.push("typing");
    });
    const onVisibleOutput = mock(() => {
      typingStartedAt = 0;
    });

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        sender,
        onStillWorking,
        onVisibleOutput,
        getTypingStartedAt: () => typingStartedAt,
        guildConfig: makeGuildConfig({
          typingSimulation: {
            enabled: true,
            inputReadingWpm: 0,
            inputMinDelayMs: 0,
            inputMaxDelayMs: 0,
            outputTypingWpm: 10,
            outputMinHoldMs: 10,
            outputMaxHoldMs: 10,
          },
        }),
      }),
    );

    expect(events).toEqual(["typing", "sent:first reply", "typing", "sent:second reply"]);
    expect(onStillWorking).toHaveBeenCalledTimes(2);
  });

  test("holds visible typing before each streamed message when typing simulation is enabled", async () => {
    const completeChat: ChatCompleteFn = async (request) => {
      await request.onTextDelta?.("<message>first reply</message><message>second reply</message>");
      return {
        text: "<message>first reply</message><message>second reply</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const events: string[] = [];
    let typingStartedAt = 0;
    const sender: MessageSender = (text) => {
      events.push(`sent:${text}`);
      return Promise.resolve({ sentMessageId: `sent-${events.length}` });
    };
    const onStillWorking = mock(() => {
      typingStartedAt = Date.now();
      events.push("typing");
    });
    const onVisibleOutput = mock(() => {
      typingStartedAt = 0;
    });

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        sender,
        onStillWorking,
        onVisibleOutput,
        getTypingStartedAt: () => typingStartedAt,
        guildConfig: makeGuildConfig({
          typingSimulation: {
            enabled: true,
            inputReadingWpm: 0,
            inputMinDelayMs: 0,
            inputMaxDelayMs: 0,
            outputTypingWpm: 10,
            outputMinHoldMs: 10,
            outputMaxHoldMs: 10,
          },
        }),
      }),
    );

    expect(events).toEqual(["typing", "sent:first reply", "typing", "sent:second reply"]);
    expect(onStillWorking).toHaveBeenCalledTimes(2);
  });

  test("does not emit typing while flushing leftover streamed messages after completion", async () => {
    const completeChat: ChatCompleteFn = async (request) => {
      await request.onTextDelta?.("<message>first</message>");
      return {
        text: "<message>first</message><message>second</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const senderCalls: string[] = [];
    const sender: MessageSender = (text) => {
      senderCalls.push(text);
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const onStillWorking = mock(() => {});

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, onStillWorking }),
    );

    expect(senderCalls).toEqual(["first", "second"]);
    expect(onStillWorking).toHaveBeenCalledTimes(0);
  });

  test("does not slice final plain text with a streamed message envelope offset", async () => {
    const finalText = "Не вышло и во второй раз. Похоже, генератор сегодня решил умереть стоя, очень драматично.";
    const completeChat: ChatCompleteFn = async (request) => {
      await request.onTextDelta?.("<message keep_typing=\"true\">be right back</message>");
      return {
        text: finalText,
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const senderCalls: Array<{ text: string; reply: boolean }> = [];
    const sender: MessageSender = (text, reply) => {
      senderCalls.push({ text, reply });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender }),
    );

    expect(senderCalls).toEqual([
      { text: "be right back", reply: true },
      { text: finalText, reply: false },
    ]);
    expect(result.responseText).toBe(finalText);
  });

  test("sends voice directive segments as TTS audio", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "Text first <voice>[whispers] quiet line</voice> text after",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; reply: boolean; voice: boolean; historyText?: string }> = [];
    const sender: MessageSender = (text, reply, _channelId, voice) => {
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

  test("sends audio directive inside message directive as one separate voice message", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message>text first</message><message><audio>spoken second</audio></message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; reply: boolean; voice: boolean; historyText?: string }> = [];
    const sender: MessageSender = (text, reply, _channelId, voice) => {
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
      { text: "text first", reply: true, voice: false, historyText: undefined },
      { text: "", reply: false, voice: true, historyText: "<voice>spoken second</voice>" },
    ]);
    expect(speechTexts).toEqual(["spoken second"]);
    expect(result.responseText).toBe("text first\n[msg-break]\n<voice>spoken second</voice>");
  });

  test("keeps Discord pings as text content instead of generated speech", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<voice>@user hey</voice>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; voice: boolean; historyText?: string }> = [];
    const sender: MessageSender = (text, _reply, _channelId, voice) => {
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
    const sender: MessageSender = (text, _reply, _channelId, voice) => {
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
    const sender: MessageSender = (text, _reply, _channelId, voice) => {
      senderCalls.push({ text, voice });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender }),
    );

    expect(senderCalls).toEqual([{ text: "audio please", voice: undefined }]);
  });

  test("ignore directive produces no Discord send but still schedules silent memory pass", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<ignore>not worth answering</ignore>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const sender: MessageSender = mock(() => Promise.resolve({ sentMessageId: "sent-1" }));
    const afterReplyCalls: unknown[] = [];
    const afterReply = mock((request: unknown) => {
      afterReplyCalls.push(request);
      return Promise.resolve();
    });
    const ignoredReplyCalls: unknown[] = [];
    const onIgnoredReply = mock((request: unknown) => {
      ignoredReplyCalls.push(request);
    });

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, afterReply, onIgnoredReply }),
    );

    expect(result.agentRan).toBe(true);
    expect(result.responseText).toBeUndefined();
    expect(sender).toHaveBeenCalledTimes(0);
    expect(onIgnoredReply).toHaveBeenCalledTimes(1);
    expect(ignoredReplyCalls[0]).toMatchObject({
      sourceMessageId: "msg-1",
      historyText: "<ignore>not worth answering</ignore>",
      rawResponse: "<ignore>not worth answering</ignore>",
    });
    expect(afterReply).toHaveBeenCalledTimes(1);
    expect(afterReplyCalls[0]).toMatchObject({
      assistantReply: "<ignore>not worth answering</ignore>",
      visibleReplySent: false,
    });
  });

  test("pre-send discard skips silent memory pass", async () => {
    const afterReply = mock(() => Promise.resolve());
    const sender = mock(() => Promise.resolve({ sentMessageId: "sent-1" }));
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "stale reply",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, afterReply, preSendCheck: () => false }),
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

  test("retries transient provider Not Found errors before sending final response", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls < 3) return Promise.reject(new Error("Not Found"));
      return Promise.resolve({
        text: "recovered after provider error",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "recovered after provider error" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat }),
    );

    expect(result.responseText).toBe("recovered after provider error");
    expect(calls).toBe(3);
  });

  test("retries Codex SSE server_error events before sending final response", async () => {
    let calls = 0;
    const codexServerError = "Codex error: {\"type\":\"error\",\"error\":{\"type\":\"server_error\",\"code\":\"server_error\",\"message\":\"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req-test in your message.\",\"param\":null},\"sequence_number\":3}";
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls < 3) return Promise.reject(new Error(codexServerError));
      return Promise.resolve({
        text: "recovered after codex server error",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "recovered after codex server error" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        globalConfig: makeGlobalConfig({ defaultLlmProvider: "openai-codex", defaultModel: "gpt-5.5" }),
        guildConfig: makeGuildConfig({ llmProvider: "openai-codex", model: "gpt-5.5" }),
      }),
    );

    expect(result.responseText).toBe("recovered after codex server error");
    expect(calls).toBe(3);
  });

  test("records normalized provider errors with pending LLM request payload", async () => {
    const requestLog = new RequestLog("guild-1", "channel-1");
    const completeChat: ChatCompleteFn = (request) => {
      request.onPayload?.({ model: request.model, route: "test-route" });
      return Promise.reject(new Error("Not Found"));
    };

    let thrown: unknown;
    try {
      await handleMessage(
        makeMessage({ mentionedUserIds: ["bot-1"] }),
        makeDeps({ completeChat, requestLog }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("OpenRouter request failed: Not Found");
    const llmCalls = requestLog.toEntry().llmCalls;
    expect(llmCalls).toHaveLength(3);
    expect(llmCalls.every((call) => call.isError === true)).toBe(true);
    expect(llmCalls[2]?.error).toBe("OpenRouter request failed: Not Found");
    expect(llmCalls[2]?.requestPayload).toEqual({ model: "moonshotai/kimi-k2.5", route: "test-route" });
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
        expect(request.tools?.some((toolDef) => toolDef.function.name === "load_skill")).toBe(true);
        expect(request.tools?.some((toolDef) => toolDef.function.name === "lookup")).toBe(true);
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
      makeDeps({
        extraTools: [tool],
        completeChat,
        sender,
        guildConfig: makeGuildConfig({
          replyLoop: { maxToolCalls: 1, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
        }),
      }),
    );

    expect(result.responseText).toBe("answer is 42");
    expect(toolCalls).toEqual([{ query: "x" }]);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  test("retains Codex provider-native reasoning content into the next tool turn request", async () => {
    const providerNativeContent = [
      {
        type: "thinking" as const,
        thinking: "",
        thinkingSignature: "{\"type\":\"reasoning\",\"id\":\"rs_1\",\"encrypted_content\":\"sealed\",\"summary\":[]}",
      },
      {
        type: "toolCall" as const,
        id: "call_abc|fc_123",
        name: "lookup",
        arguments: { query: "x" },
      },
    ];
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "tool says 42" }], details: {} }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call_abc|fc_123",
            type: "function",
            function: { name: "lookup", arguments: "{\"query\":\"x\"}" },
          }],
          providerNativeContent,
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      const assistantMessage = request.messages.find((message) => message.role === "assistant");
      expect(assistantMessage?.providerNativeContent).toEqual(providerNativeContent);
      expect(assistantMessage?.tool_calls?.[0]?.id).toBe("call_abc|fc_123");
      expect(request.messages.some((message) =>
        message.role === "tool"
          && message.tool_call_id === "call_abc|fc_123"
          && typeof message.content === "string"
          && message.content.includes("tool says 42")
      )).toBe(true);
      return Promise.resolve({
        text: "answer is 42",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer is 42" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        globalConfig: makeGlobalConfig({ defaultLlmProvider: "openai-codex", defaultModel: "gpt-5.5" }),
        guildConfig: makeGuildConfig({
          llmProvider: "openai-codex",
          model: "gpt-5.5",
        }),
      }),
    );

    expect(result.responseText).toBe("answer is 42");
    expect(calls).toBe(2);
  });

  test("replays and saves Codex native reasoning continuation across runs", async () => {
    const priorProviderNativeContent = [{
      type: "thinking" as const,
      thinking: "",
      thinkingSignature: "{\"type\":\"reasoning\",\"id\":\"rs_old\",\"encrypted_content\":\"old\"}",
    }];
    const finalProviderNativeContent = [{
      type: "thinking" as const,
      thinking: "",
      thinkingSignature: "{\"type\":\"reasoning\",\"id\":\"rs_new\",\"encrypted_content\":\"new\"}",
    }, {
      type: "text" as const,
      text: "hello user",
      textSignature: "msg_new",
    }];
    const saved: unknown[] = [];
    const completeChat: ChatCompleteFn = (request) => {
      const replayed = request.messages.find((message) =>
        message.role === "assistant" && message.providerNativeContent === priorProviderNativeContent
      );
      expect(replayed).toBeDefined();
      return Promise.resolve({
        text: "hello user",
        toolCalls: [],
        providerNativeContent: finalProviderNativeContent,
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "hello user" }] },
      });
    };

    await handleMessage(
      makeMessage({ guildId: "guild-1", channelId: "channel-1", mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        guildConfig: makeGuildConfig({ llmProvider: "openai-codex", model: "gpt-5.5" }),
        nativeReasoningContinuation: {
          load: (input) => {
            expect(input).toMatchObject({
              guildId: "guild-1",
              channelId: "channel-1",
              userId: "user-1",
              provider: "openai-codex",
              model: "gpt-5.5",
              maxAgeMs: 30 * 60 * 1000,
            });
            return priorProviderNativeContent;
          },
          save: (input) => { saved.push(input); },
        },
      }),
    );

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      provider: "openai-codex",
      model: "gpt-5.5",
      sourceMessageId: "msg-1",
      providerNativeContent: finalProviderNativeContent,
    });
  });

  test("does not use Codex native reasoning continuation for ambient runs", async () => {
    const load = mock(() => [{
      type: "thinking" as const,
      thinking: "",
      thinkingSignature: "{\"type\":\"reasoning\",\"id\":\"rs_old\",\"encrypted_content\":\"old\"}",
    }]);
    const save = mock(() => {});
    const completeChat: ChatCompleteFn = (request) => {
      expect(request.messages.some((message) => message.role === "assistant" && message.providerNativeContent !== undefined)).toBe(false);
      return Promise.resolve({
        text: "ambient reply",
        toolCalls: [],
        providerNativeContent: [{ type: "text", text: "ambient reply", textSignature: "msg_new" }],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "ambient reply" }] },
      });
    };

    await handleMessage(
      makeMessage({ guildId: "guild-1", channelId: "channel-1" }),
      makeDeps({
        completeChat,
        guildConfig: makeGuildConfig({ llmProvider: "openai-codex", model: "gpt-5.5" }),
        triggerOverride: { reason: "ambient_initiative" },
        nativeReasoningContinuation: { load, save },
      }),
    );

    expect(load).toHaveBeenCalledTimes(0);
    expect(save).toHaveBeenCalledTimes(0);
  });

  test("sends visible text attached to a load_skill tool turn", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls === 1) {
        const text = [
          "<scene perspective=\"outside_character_editor\">",
          "room read: playful image request",
          "</scene>",
          "<message reply=\"true\">Ладно. Обычное селфи.</message>",
          "<message reply=\"false\">Без твоей подологии.</message>",
        ].join("\n");
        return Promise.resolve({
          text,
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "load_skill", arguments: "{\"skill\":\"image_generation\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text }] },
        });
      }
      return Promise.resolve({
        text: "<ignore>already sent</ignore>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "<ignore>already sent</ignore>" }] },
      });
    };

    const sender = mock<MessageSender>(() => Promise.resolve({ sentMessageId: "sent-1" }));

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender }),
    );

    expect(calls).toBe(2);
    expect(sender).toHaveBeenCalledTimes(2);
    expect(sender.mock.calls[0]?.[0]).toBe("Ладно. Обычное селфи.");
    expect(sender.mock.calls[0]?.[1]).toBe(true);
    expect(sender.mock.calls[1]?.[0]).toBe("Без твоей подологии.");
    expect(sender.mock.calls[1]?.[1]).toBe(false);
  });

  test("attaches generated image tool output to the final reply", async () => {
    const tool: AgentTool = {
      name: "codex_generate_image",
      label: "Codex Image",
      description: "Generate image",
      parameters: Type.Object({ prompt: Type.String() }),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Generated image queued." }],
        details: { generatedAttachmentIds: ["img-1"] },
      }),
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
            function: { name: "load_skill", arguments: "{\"skill\":\"image_generation\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      if (calls === 2) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-2",
            type: "function",
            function: { name: "codex_generate_image", arguments: "{\"prompt\":\"a blue house\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "here",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "here" }] },
      });
    };

    const sentAttachments: unknown[] = [];
    const sender: MessageSender = (_text, _reply, _channelId, _voice, _signal, _replyToMessageId, attachments) => {
      sentAttachments.push(attachments);
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        sender,
        consumeGeneratedAttachments: (ids) => ids.map((id) => ({
          id,
          buffer: Buffer.from("fake"),
          filename: `${id}.png`,
          contentType: "image/png",
          historyText: "a blue house",
        })),
      }),
    );

    expect(sentAttachments).toEqual([[
      {
        id: "img-1",
        buffer: Buffer.from("fake"),
        filename: "img-1.png",
        contentType: "image/png",
        historyText: "a blue house",
      },
    ]]);
  });

  test("blocks codex_generate_image until image_generation skill is loaded", async () => {
    let executeCalls = 0;
    const tool: AgentTool = {
      name: "codex_generate_image",
      label: "Codex Image",
      description: "Generate image",
      parameters: Type.Object({ prompt: Type.String() }),
      execute: () => {
        executeCalls += 1;
        return Promise.resolve({
          content: [{ type: "text", text: "Generated image queued." }],
          details: { generatedAttachmentIds: ["img-1"] },
        });
      },
    };

    let calls = 0;
    let sawSkillError = false;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "codex_generate_image", arguments: "{\"prompt\":\"a blue house\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      sawSkillError = request.messages.some((message) =>
        message.role === "tool"
        && message.name === "codex_generate_image"
        && typeof message.content === "string"
        && message.content.includes("requires the image_generation skill")
      );
      return Promise.resolve({
        text: "ok",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "ok" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [tool], completeChat }),
    );

    expect(result.responseText).toBe("ok");
    expect(sawSkillError).toBe(true);
    expect(executeCalls).toBe(0);
  });

  test("does not require final text after async image job is queued", async () => {
    const tool: AgentTool = {
      name: "codex_generate_image",
      label: "Codex Image",
      description: "Generate image",
      parameters: Type.Object({ prompt: Type.String() }),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Started async image generation job img-1." }],
        details: {
          asyncJobId: "img-1",
          asyncJobStatus: "queued",
          asyncJobCreated: true,
        },
      }),
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
            function: { name: "load_skill", arguments: "{\"skill\":\"image_generation\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "",
        toolCalls: [{
          id: "call-2",
          type: "function",
          function: { name: "codex_generate_image", arguments: "{\"prompt\":\"a blue house\"}" },
        }],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    const sender = mock(() => Promise.resolve({ sentMessageId: "sent-1" }));
    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [tool], completeChat, sender }),
    );

    expect(result.triggered).toBe(true);
    expect(result.agentRan).toBe(true);
    expect(result.responseText).toBeUndefined();
    expect(calls).toBe(2);
    expect(sender).toHaveBeenCalledTimes(0);
  });

  test("async completion sends pending attachment without current image input", async () => {
    let sawImageInput = false;
    let sawNormalTurnText = false;
    const completeChat: ChatCompleteFn = (request) => {
      const currentTurnMessage = request.messages.find((message) => contentText(message.content).includes("## New Discord Event"));
      const content = currentTurnMessage?.content;
      if (Array.isArray(content)) {
        sawImageInput = content.some((part) => part.type === "image_url");
        sawNormalTurnText = content.some((part) =>
          part.type === "text"
          && part.text.includes("[Async Image Job Ready]")
          && part.text.includes("## New Discord Event")
        );
      } else {
        sawNormalTurnText = contentText(content).includes("[Async Image Job Ready]")
          && contentText(content).includes("## New Discord Event");
      }
      return Promise.resolve({
        text: "done",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "done" }] },
      });
    };

    const sentAttachments: string[][] = [];
    const sender: MessageSender = (_text, _reply, _channelId, _voice, _signal, _replyToMessageId, attachments) => {
      sentAttachments.push(attachments?.map((attachment) => attachment.id) ?? []);
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({
        content: "[Async Image Job Ready] Job img-1 generated an image.",
        translatedContent: "[Async Image Job Ready] Job img-1 generated an image.",
      }),
      makeDeps({
        forceTrigger: true,
        context: makeContext({ userMessage: "[Async Image Job Ready] Job img-1 generated an image." }),
        completeChat,
        sender,
        initialPendingAttachments: [{
          id: "img-1",
          buffer: Buffer.from("fake-image"),
          filename: "img-1.png",
          contentType: "image/png",
          historyText: "generated image",
        }],
      }),
    );

    expect(sawImageInput).toBe(false);
    expect(sawNormalTurnText).toBe(true);
    expect(sentAttachments).toEqual([["img-1"]]);
  });

  test("does not resend a streamed explicit final message after generated image tool output", async () => {
    const tool: AgentTool = {
      name: "codex_generate_image",
      label: "Codex Image",
      description: "Generate image",
      parameters: Type.Object({ prompt: Type.String() }),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Generated image queued." }],
        details: { generatedAttachmentIds: ["img-1"] },
      }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = async (request) => {
      calls += 1;
      if (calls === 1) {
        await request.onTextDelta?.("\n");
        return {
          text: "\n",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "load_skill", arguments: "{\"skill\":\"image_generation\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        };
      }
      if (calls === 2) {
        return {
          text: "",
          toolCalls: [{
            id: "call-2",
            type: "function",
            function: { name: "codex_generate_image", arguments: "{\"prompt\":\"a blue house\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        };
      }

      await request.onTextDelta?.("<message>Вот.</message>");
      return {
        text: "<message>Вот.</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "<message>Вот.</message>" }] },
      };
    };

    const senderCalls: Array<{ text: string; attachmentIds: string[] }> = [];
    const sender: MessageSender = (text, _reply, _channelId, _voice, _signal, _replyToMessageId, attachments) => {
      senderCalls.push({ text, attachmentIds: attachments?.map((attachment) => attachment.id) ?? [] });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        sender,
        consumeGeneratedAttachments: (ids) => ids.map((id) => ({
          id,
          buffer: Buffer.from("fake"),
          filename: `${id}.png`,
          contentType: "image/png",
          historyText: "a blue house",
        })),
      }),
    );

    expect(senderCalls).toEqual([{ text: "Вот.", attachmentIds: ["img-1"] }]);
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
        && m.content.includes("turn time budget exhausted")
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
        && m.content.includes("turn time budget exhausted")
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
        && m.content.includes("turn time budget exhausted")
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
      name: "read_asset",
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
            function: { name: "read_asset", arguments: "{}" },
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

  test("uses live OpenRouter metadata instead of static registry for image support", async () => {
    const tool: AgentTool = {
      name: "read_asset",
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
      if (request.systemPrompt.includes("Describe images for another Discord chat model")) {
        fallbackCalls += 1;
        return Promise.resolve({
          text: "fallback should not run",
          toolCalls: [],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "fallback should not run" }] },
        });
      }

      mainCalls += 1;
      if (mainCalls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "read_asset", arguments: "{}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      expect(request.messages.some((m) =>
        Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")
      )).toBe(true);
      return Promise.resolve({
        text: "native image answer",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "native image answer" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        modelImageInputSupport: "supported",
        guildConfig: makeGuildConfig({
          model: "new-vendor/vision-model-not-in-registry",
          imageReading: {
            fallbackEnabled: true,
            fallbackModel: "moonshotai/kimi-k2.5",
            fallbackModelParams: {},
          },
        }),
      }),
    );

    expect(result.responseText).toBe("native image answer");
    expect(mainCalls).toBe(2);
    expect(fallbackCalls).toBe(0);
  });

  test("returns a clear tool error instead of image parts for text-only models", async () => {
    const tool: AgentTool = {
      name: "read_asset",
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
            function: { name: "read_asset", arguments: "{}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      const toolMessage = request.messages.find((m) => m.role === "tool" && m.name === "read_asset");
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
      name: "read_asset",
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
      if (request.systemPrompt.includes("Describe images for another Discord chat model")) {
        imageCalls += 1;
        expect(request.systemPrompt).toContain("Describe images for another Discord chat model");
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
            function: { name: "read_asset", arguments: "{}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      const toolMessage = request.messages.find((m) => m.role === "tool" && m.name === "read_asset");
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
      name: "read_asset",
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
            function: { name: "read_asset", arguments: "{}" },
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
      const toolMessage = request.messages.find((m) => m.role === "tool" && m.name === "read_asset");
      expect(toolMessage?.content).toContain("current LLM endpoint cannot read image input");
      expect(request.messages.some((m) => m.role === "user" && contentText(m.content).includes("## New Discord Event"))).toBe(true);

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
      name: "read_asset",
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
      if (request.systemPrompt.includes("Describe images for another Discord chat model")) {
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
            function: { name: "read_asset", arguments: "{}" },
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
      const toolMessage = request.messages.find((m) => m.role === "tool" && m.name === "read_asset");
      expect(toolMessage?.content).toContain("Native image reading was unavailable");
      expect(toolMessage?.content).toContain("Fallback saw a small square test image.");
      expect(request.messages.some((m) => m.role === "user" && contentText(m.content).includes("## New Discord Event"))).toBe(true);

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

  test("start_thread does not route a plain final answer to the created thread", async () => {
    const threadTool: AgentTool = {
      name: "start_thread",
      label: "Start Thread",
      description: "Create a thread",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Thread created" }],
        details: { channel_id: "thread-1", threadName: "Thread", parent_channel_id: "channel-1" },
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
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [threadTool], completeChat, sender }),
    );

    expect(senderCalls).toEqual([{ text: "thread answer", reply: true, channelId: undefined }]);
  });

  test("after start_thread the model sends inside the thread only with explicit channel_id", async () => {
    const threadTool: AgentTool = {
      name: "start_thread",
      label: "Start Thread",
      description: "Create a thread",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Thread created: channel_id thread-1" }],
        details: { channel_id: "thread-1", threadName: "Thread", parent_channel_id: "channel-1" },
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
        text: "<message channel_id=\"thread-1\">thread answer</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "thread answer" }] },
      });
    };
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [threadTool], completeChat, sender, currentChannelId: "channel-1" }),
    );

    expect(senderCalls).toEqual([{ text: "thread answer", reply: false, channelId: "thread-1" }]);
  });

  test("close_thread does not route a plain final answer to the parent", async () => {
    const closeTool: AgentTool = {
      name: "close_thread",
      label: "Close Thread",
      description: "Close a thread",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Thread closed" }],
        details: { channel_id: "thread-1", threadName: "Thread", parent_channel_id: "channel-1" },
      }),
    };
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: "call-1", type: "function", function: { name: "close_thread", arguments: "{}" } }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "closed",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "closed" }] },
      });
    };
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [closeTool], completeChat, sender }),
    );

    expect(senderCalls).toEqual([{ text: "closed", reply: true, channelId: undefined }]);
  });

  test("close_thread suppresses a later plain final answer after closing the current thread", async () => {
    const closeTool: AgentTool = {
      name: "close_thread",
      label: "Close Thread",
      description: "Close a thread",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Thread closed" }],
        details: { channel_id: "thread-1", threadName: "Thread", parent_channel_id: "channel-1" },
      }),
    };
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: "call-1", type: "function", function: { name: "close_thread", arguments: "{}" } }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "closed",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "closed" }] },
      });
    };
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [closeTool], completeChat, sender, currentChannelId: "thread-1" }),
    );

    expect(senderCalls).toEqual([]);
  });

  test("silent memory pass stops on wall-clock timeout without recovery completion", async () => {
    const recordMemoryTool: AgentTool = {
      name: "record_memory",
      label: "record_memory",
      description: "Record memory",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Memory update complete." }],
        details: { applied: 0, requested: 1 },
      }),
    };
    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => {
          reject(request.signal?.reason instanceof Error ? request.signal.reason : new Error("aborted"));
        }, { once: true });
      });
    };

    await runSilentMemoryAgentPass({
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({
        replyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 1, llmOutputTimeoutMs: 10_000 },
      }),
      context: makeContext(),
      personaPrompt: "You are a test bot.",
      runtimePrompts: TEST_RUNTIME_PROMPTS,
      incomingMessage: makeMessage(),
      userContent: "remember I like concise answers",
      assistantReply: "got it",
      visibleReplySent: true,
      tools: [recordMemoryTool],
      completeChat,
    });

    expect(calls).toBe(1);
  });

  test("silent memory pass honors configured maintenance tool-call cap", async () => {
    const toolCalls: unknown[] = [];
    const recordMemoryTool: AgentTool = {
      name: "record_memory",
      label: "record_memory",
      description: "Record memory",
      parameters: Type.Object({}),
      execute: (_id, params) => {
        toolCalls.push(params);
        return Promise.resolve({
          content: [{ type: "text", text: "Memory update complete." }],
          details: { applied: 0, requested: 1 },
        });
      },
    };
    const completeChat: ChatCompleteFn = (request) => Promise.resolve({
      text: "",
      toolCalls: request.tools?.length === 0
        ? []
        : [{ id: `call-${toolCalls.length + 1}`, type: "function", function: { name: "record_memory", arguments: "{}" } }],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });

    await runSilentMemoryAgentPass({
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({
        memoryExtraction: {
          postReply: true,
          maxToolCalls: 2,
          ambient: { enabled: false, everyMessages: 300, maxBatchMessages: 300, minIntervalSeconds: 600 },
        },
      }),
      context: makeContext(),
      personaPrompt: "You are a test bot.",
      runtimePrompts: TEST_RUNTIME_PROMPTS,
      incomingMessage: makeMessage(),
      userContent: "remember I like concise answers",
      assistantReply: "got it",
      visibleReplySent: true,
      tools: [recordMemoryTool],
      completeChat,
    });

    expect(toolCalls).toHaveLength(2);
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
      visibleReplySent: true,
    });
    const memoryRequest = afterReplyCalls[0] as { recentContext: string };
    expect(memoryRequest.recentContext).not.toContain("Server Members");
    expect(memoryRequest.recentContext).not.toContain("cached");
    const maintenanceRequest = afterReplyCalls[0] as {
      maintenanceTranscript?: Array<{ role: string; content?: unknown }>;
      availableTools?: Array<{ name: string }>;
      promptContext?: { sessionId?: string; stableSections: Array<{ text: string }> };
    };
    expect(maintenanceRequest.maintenanceTranscript?.some((message) => message.role === "assistant" && message.content === "hello user")).toBe(true);
    expect(maintenanceRequest.availableTools).toBeDefined();
    expect(maintenanceRequest.promptContext).toBeDefined();
    expect(maintenanceRequest.promptContext?.stableSections.some((section) => section.text === TEST_RUNTIME_PROMPTS.reply.trim())).toBe(true);
    expect(JSON.stringify(maintenanceRequest.promptContext?.stableSections)).not.toContain("Silent Memory Pass");
  });

  test("maintenance material includes silent user-only turns", () => {
    expect(hasMaintenanceMaterial({ userMessage: "clanker", assistantReply: "" })).toBe(true);
    expect(hasMaintenanceMaterial({ userMessage: "", assistantReply: "<ignore>not dignifying that</ignore>" })).toBe(true);
    expect(hasMaintenanceMaterial({ userMessage: "", assistantReply: "" })).toBe(false);
  });

  test("silent maintenance passes preserve prior tool results", async () => {
    const transcript: OpenRouterMessage[] = [
      { role: "user", content: "hello bot" },
      { role: "assistant", content: "hello user" },
    ];
    const recordMemoryTool: AgentTool = {
      name: "record_memory",
      label: "record_memory",
      description: "Record memory",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "memory recorded" }], details: {} }),
    };
    const recordRelationshipTool: AgentTool = {
      name: "record_relationship",
      label: "record_relationship",
      description: "Record relationship",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "relationship recorded" }], details: {} }),
    };
    let sawMemoryToolResult = false;
    const promptPayloads: unknown[] = [];
    const completeChat: ChatCompleteFn = (request) => {
      const payload = { messages: request.messages.map((message) => ({ role: message.role, content: message.content })) };
      request.onPayload?.(payload);
      promptPayloads.push(payload);
      const last = request.messages[request.messages.length - 1];
      const control = typeof last?.content === "string" ? last.content : "";
      if (control.includes("Memory Maintenance")) {
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: "mem-call", type: "function", function: { name: "record_memory", arguments: "{}" } }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      sawMemoryToolResult = JSON.stringify(request.messages).includes("memory recorded");
      return Promise.resolve({
        text: "",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };
    const common = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig(),
      context: makeContext(),
      personaPrompt: "You are a test bot.",
      runtimePrompts: TEST_RUNTIME_PROMPTS,
      incomingMessage: makeMessage(),
      userContent: "hello bot",
      assistantReply: "hello user",
      visibleReplySent: true,
      transcript,
      promptContext: {
        provider: "openrouter" as const,
        model: "moonshotai/kimi-k2.5",
        transport: makePromptTransportConfig().openrouter,
        stableSections: [{ role: "developer" as const, text: "VISIBLE STABLE PROMPT", target: "input" as const, cacheGroup: "runtime" }],
        initialRoles: ["user" as const],
        sessionId: "same-visible-session",
        promptCaching: { enabled: true },
      },
      completeChat,
    };

    await runSilentMemoryAgentPass({ ...common, tools: [recordMemoryTool] });
    await runSilentToolAgentPass({
      ...common,
      tools: [recordRelationshipTool],
      runtimeInstruction: "## Silent Relationship Pass",
      controlMessage: "## Execution Mode: Relationship Maintenance\nPrivate relationship maintenance is active.",
      terminateAfterSuccessfulToolNames: ["record_relationship"],
    });

    expect(sawMemoryToolResult).toBe(true);
    expect(JSON.stringify(promptPayloads)).toContain("VISIBLE STABLE PROMPT");
    expect(JSON.stringify(promptPayloads)).not.toContain("Silent Memory Pass");
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
