import { describe, test, expect } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { handleMessage, type IncomingMessage, type HandlerDeps } from "./handler.ts";
import type { PromptContext } from "./prompt.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";
import type { MessageSender } from "./send-message-tool.ts";
import type { Logger } from "../logger.ts";

function makeGlobalConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    discordToken: "test-token",
    openrouterApiKey: "test-key",
    defaultModel: "moonshotai/kimi-k2.5",
    defaultThinkingLevel: "medium",
    defaultTimezone: "UTC",
    defaultTrim: { trimTrigger: 200, trimTarget: 150 },
    defaultMemoryRetentionDays: 180,
    defaultImageMaxDimension: 768,
    personaPath: "config/persona.md",
    logLevel: "info",
    dataDir: "./data",
    modelCacheDir: "./model-cache",
    qdrantUrl: "http://localhost:6333",
    ...overrides,
  };
}

function makeGuildConfig(overrides: Partial<GuildConfig> = {}): GuildConfig {
  return {
    guildId: "guild-1",
    slug: "test",
    triggers: { mention: true, keywords: [], randomChance: 0 },
    thinkingLevel: "medium",
    timezone: "UTC",
    trim: { trimTrigger: 200, trimTarget: 150 },
    memoryRetentionDays: 180,
    adminUserIds: [],
    imageMaxDimension: 768,

    ...overrides,
  };
}

function makePromptContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    persona: "You are a test bot.",
    journalSummaries: [],
    upcomingSchedules: [],
    chatHistory: [],
    emojiContext: "",
    displayNameContext: "",
    guildId: "test-guild",
    channelId: "test-channel",
    timestamp: "2025-01-01T00:00:00.000Z",
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
    ...overrides,
  };
}

describe("handleMessage", () => {
  test("returns triggered=false when no trigger matches", async () => {
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "" });
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({
        triggers: { mention: false, keywords: [], randomChance: 0 },
      }),
      promptContext: makePromptContext(),
      sender,
    };

    const result = await handleMessage(makeMessage(), deps);
    expect(result.triggered).toBe(false);
    expect(result.triggerResult).toBeNull();
    expect(result.agentRan).toBe(false);
  });

  test("returns triggered=false when author is bot", async () => {
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "" });
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig(),
      promptContext: makePromptContext(),
      sender,
    };

    const result = await handleMessage(
      makeMessage({ authorId: "bot-1", botUserId: "bot-1" }),
      deps
    );
    expect(result.triggered).toBe(false);
  });

  test("returns triggered=true with mention trigger", async () => {
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "" });
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({
        triggers: { mention: true, keywords: [], randomChance: 0 },
      }),
      promptContext: makePromptContext(),
      sender,
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      deps
    );
    expect(result.triggered).toBe(true);
    expect(result.triggerResult).toEqual({ reason: "mention" });
    expect(result.agentRan).toBe(true);
  });

  test("returns triggered=true with keyword trigger", async () => {
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "" });
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({
        triggers: { mention: false, keywords: ["hello"], randomChance: 0 },
      }),
      promptContext: makePromptContext(),
      sender,
    };

    const result = await handleMessage(
      makeMessage({ content: "hello bot", translatedContent: "hello bot" }),
      deps
    );
    expect(result.triggered).toBe(true);
    expect(result.triggerResult).toEqual({ reason: "keyword", keyword: "hello" });
    expect(result.agentRan).toBe(true);
  });

  test("returns triggered=false when keyword does not match", async () => {
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "" });
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({
        triggers: { mention: false, keywords: ["goodbye"], randomChance: 0 },
      }),
      promptContext: makePromptContext(),
      sender,
    };

    const result = await handleMessage(
      makeMessage({ content: "hello bot", translatedContent: "hello bot" }),
      deps
    );
    expect(result.triggered).toBe(false);
    expect(result.agentRan).toBe(false);
  });

  test("passes extraTools to agent without error", async () => {
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "" });
    const fakeTool = {
      name: "fake_tool",
      label: "Fake",
      description: "A test tool",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      }),
    } as const;
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig(),
      promptContext: makePromptContext(),
      sender,
      extraTools: [fakeTool as unknown as AgentTool],
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      deps
    );
    expect(result.triggered).toBe(true);
    expect(result.agentRan).toBe(true);
  });

  test("accepts logger with logTokenUsage", async () => {
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "" });
    const logSpy = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      logTokenUsage: () => {},
      child: () => logSpy,
    };
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({
        triggers: { mention: true, keywords: [], randomChance: 0 },
      }),
      promptContext: makePromptContext(),
      sender,
      log: logSpy as unknown as Logger,
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      deps
    );
    expect(result.triggered).toBe(true);
    expect(result.agentRan).toBe(true);
  });
});
