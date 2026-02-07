import { describe, test, expect } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { handleMessage, patchToolLookup, injectTriggerInstruction, type IncomingMessage, type HandlerDeps } from "./handler.ts";
import type { AssembledContext, ContextSection } from "./context-assembly.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";
import type { MessageSender } from "./send-message-tool.ts";
import type { Logger } from "../logger.ts";

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
    defaultMemoryRetentionDays: 180,
    defaultImageMaxDimension: 768,
    defaultMergeMessageGapSeconds: 120,
    defaultImageReadMaxPerCall: 10,
    defaultImageCaptioningEnabled: false,
    defaultAttachmentsDir: "data/attachments",
    defaultInstructions: "",
    personaPath: "config/persona.md",
    toolInstructionsPath: "config/tool_instructions.md",
    logLevel: "info",
    dataDir: "./data",
    modelCacheDir: "./model-cache",
    qdrantUrl: "http://localhost:6333",
    uiLang: "en",
    defaultEmotes: { include: false },
    defaultMembers: { include: true },
    defaultForceToolCallFirstRun: false,
    defaultDisableParallelToolCallsFirstRun: false,
    defaultDispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000, maxFollowUps: 5 },
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
    memoryRetentionDays: 180,
    adminUserIds: [],
    imageMaxDimension: 768,
    mergeMessageGapSeconds: 120,
    imageReadMaxPerCall: 10,
    imageCaptioningEnabled: false,
    attachmentsDir: "data/attachments",
    instructions: "",
    emotes: { include: false },
    members: { include: true },
    forceToolCallFirstRun: false,
    disableParallelToolCallsFirstRun: false,
    dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000, maxFollowUps: 5 },
    ...overrides,
  };
}

function makeContext(overrides: Partial<AssembledContext> = {}): AssembledContext {
  return {
    sections: [
      { label: "Persona", text: "You are a test bot.", cached: true, role: "system" },
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

  test("adds cache_control breakpoints to stable context messages for anthropic models", async () => {
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "" });
    let capturedPayload: unknown;
    const requestLog = {
      recordLLMRequest(payload: unknown) {
        capturedPayload = structuredClone(payload);
      },
      recordToolStart() {},
      recordToolEnd() {},
      recordLLMCompletion() {},
    };
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig({ defaultModel: "anthropic/claude-sonnet-4" }),
      guildConfig: makeGuildConfig({
        model: "anthropic/claude-sonnet-4",
        triggers: { mention: true, keywords: [], randomChance: 0 },
      }),
      context: makeContext({
        sections: [
          { label: "Tool Instructions", text: "Use send_message.", cached: true, role: "system" },
          { label: "Persona", text: "You are a test bot.", cached: true, role: "system" },
          { label: "Server Members", text: "## Server Members\n@alice — Alice", cached: true, role: "developer" },
          { label: "Current Context", text: "volatile context", cached: false, role: "developer" },
        ],
        userMessage: "hello bot",
      }),
      sender,
      requestLog: requestLog as unknown as HandlerDeps["requestLog"],
    };

    await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), deps);

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload).not.toBeNull();
    expect(typeof capturedPayload).toBe("object");
    const payload = capturedPayload as { messages?: unknown[] };
    const messages = payload.messages;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages?.length).toBeGreaterThanOrEqual(3);

    const systemMessage = messages?.[0] as { role?: string; content?: unknown };
    const cachedDevMessage = messages?.[1] as { role?: string; content?: unknown };

    expect(systemMessage.role).toBe("system");
    expect(Array.isArray(systemMessage.content)).toBe(true);
    expect((systemMessage.content as Array<{ cache_control?: unknown }>)[0]?.cache_control).toEqual({
      type: "ephemeral",
    });

    expect(cachedDevMessage.role).toBe("developer");
    expect(Array.isArray(cachedDevMessage.content)).toBe(true);
    expect((cachedDevMessage.content as Array<{ cache_control?: unknown }>)[0]?.cache_control).toEqual({
      type: "ephemeral",
    });

    const userMessage = messages?.find((m) => {
      if (m === null || typeof m !== "object") return false;
      return (m as { role?: unknown }).role === "user";
    }) as { content?: unknown } | undefined;
    expect(userMessage).toBeDefined();
    expect(Array.isArray(userMessage?.content)).toBe(true);
    expect((userMessage?.content as Array<{ cache_control?: unknown }>)[0]?.cache_control).toBeUndefined();
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

describe("injectTriggerInstruction", () => {
  test("appends section when no Late Instruction exists", () => {
    const sections: ContextSection[] = [
      { label: "Persona", text: "You are a test bot.", cached: true, role: "system" },
      { label: "Instructions", text: "## Instructions\nBe helpful.", cached: true, role: "system" },
    ];
    const result = injectTriggerInstruction(sections, "This is a random reply.");
    expect(result.length).toBe(3);
    expect(result[2]?.label).toBe("Trigger Instruction");
    expect(result[2]?.text).toBe("## Trigger Context\nThis is a random reply.");
    expect(result[2]?.cached).toBe(false);
  });

  test("inserts section before Late Instruction", () => {
    const sections: ContextSection[] = [
      { label: "Persona", text: "You are a test bot.", cached: true, role: "system" },
      { label: "Instructions", text: "## Instructions\nBe helpful.", cached: true, role: "system" },
      { label: "Late Instruction", text: "ALWAYS USE send_message.", cached: false, role: "developer" },
    ];
    const result = injectTriggerInstruction(sections, "You were mentioned.");
    expect(result.length).toBe(4);
    expect(result[2]?.label).toBe("Trigger Instruction");
    expect(result[2]?.text).toBe("## Trigger Context\nYou were mentioned.");
    expect(result[3]?.label).toBe("Late Instruction");
  });

  test("preserves original sections order", () => {
    const sections: ContextSection[] = [
      { label: "Persona", text: "Persona text.", cached: true, role: "system" },
      { label: "Chat History — Older", text: "Older history.", cached: true, role: "developer" },
      { label: "Chat History — Newer", text: "Newer history.", cached: false, role: "developer" },
      { label: "Late Instruction", text: "Late text.", cached: false, role: "developer" },
    ];
    const result = injectTriggerInstruction(sections, "Scheduled task.");
    expect(result.length).toBe(5);
    expect(result[0]?.label).toBe("Persona");
    expect(result[1]?.label).toBe("Chat History — Older");
    expect(result[2]?.label).toBe("Chat History — Newer");
    expect(result[3]?.label).toBe("Trigger Instruction");
    expect(result[4]?.label).toBe("Late Instruction");
  });
});
