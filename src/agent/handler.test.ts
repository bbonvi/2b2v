import { describe, test, expect } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { handleMessage, patchToolLookup, type IncomingMessage, type HandlerDeps } from "./handler.ts";
import type { AssembledContext } from "./context-assembly.ts";
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
    defaultTrim: { trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 },
    defaultTriggers: { mention: true, keywords: [], randomChance: 0 },
    defaultMemoryRetentionDays: 180,
    defaultImageMaxDimension: 768,
    defaultMergeMessageGapSeconds: 120,
    defaultImageReadMaxPerCall: 10,
    defaultImageCaptioningEnabled: false,
    defaultAttachmentsDir: "data/attachments",
    defaultInstructions: "",
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
    trim: { trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 },
    memoryRetentionDays: 180,
    adminUserIds: [],
    imageMaxDimension: 768,
    mergeMessageGapSeconds: 120,
    imageReadMaxPerCall: 10,
    imageCaptioningEnabled: false,
    attachmentsDir: "data/attachments",
    instructions: "",

    ...overrides,
  };
}

function makeContext(overrides: Partial<AssembledContext> = {}): AssembledContext {
  return {
    sections: [
      { label: "Persona", text: "You are a test bot.", cached: true },
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
      context: makeContext(),
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
      context: makeContext(),
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
      context: makeContext(),
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
      context: makeContext(),
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
      context: makeContext(),
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
      context: makeContext(),
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
      context: makeContext(),
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

describe("patchToolLookup", () => {
  function makeTool(name: string): AgentTool {
    return {
      name,
      label: name,
      description: "test",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
    } as unknown as AgentTool;
  }

  test("exact match still works", () => {
    const tools = [makeTool("send_message"), makeTool("save_memory")];
    patchToolLookup(tools);
    const found = tools.find((t) => t.name === "send_message");
    expect(found).toBeDefined();
    expect(found?.name).toBe("send_message");
  });

  test("finds tool when LLM adds leading space", () => {
    const tools = [makeTool("send_message"), makeTool("save_memory")];
    patchToolLookup(tools);
    const found = tools.find((t) => t.name === " send_message");
    expect(found).toBeDefined();
    expect(found?.name).toBe("send_message");
  });

  test("finds tool when LLM adds trailing space", () => {
    const tools = [makeTool("send_message")];
    patchToolLookup(tools);
    const found = tools.find((t) => t.name === "send_message ");
    expect(found).toBeDefined();
    expect(found?.name).toBe("send_message");
  });

  test("finds tool when LLM adds double leading space", () => {
    const tools = [makeTool("send_message")];
    patchToolLookup(tools);
    const found = tools.find((t) => t.name === "  send_message");
    expect(found).toBeDefined();
    expect(found?.name).toBe("send_message");
  });

  test("returns undefined for genuinely unknown tool", () => {
    const tools = [makeTool("send_message")];
    patchToolLookup(tools);
    const found = tools.find((t) => t.name === "nonexistent_tool");
    expect(found).toBeUndefined();
  });
});
