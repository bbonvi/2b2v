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
    defaultPromptCaching: { enabled: true, profile: "conservative" },
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
    promptCaching: { enabled: true, profile: "conservative" },
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

type PayloadMessage = { role?: unknown; content?: unknown };

function messageText(message: PayloadMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const parts = message.content as unknown[];
  const first = parts[0];
  if (first === null || typeof first !== "object") return "";
  const text = (first as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function hasCacheControl(message: PayloadMessage): boolean {
  if (!Array.isArray(message.content)) return false;
  const parts = message.content as unknown[];
  const first = parts[0];
  if (first === null || typeof first !== "object") return false;
  return (first as { cache_control?: unknown }).cache_control !== undefined;
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

  test("conservative profile applies cache_control to tail stable sections for moonshot", async () => {
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
    const stableSections: ContextSection[] = [
      { label: "S1", text: "stable-system-1", cached: true, role: "system" },
      { label: "S2", text: "stable-system-2", cached: true, role: "system" },
      { label: "D1", text: "stable-dev-1", cached: true, role: "developer" },
      { label: "D2", text: "stable-dev-2", cached: true, role: "developer" },
      { label: "D3", text: "stable-dev-3", cached: true, role: "developer" },
      { label: "D4", text: "stable-dev-4", cached: true, role: "developer" },
    ];
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig({ defaultModel: "moonshotai/kimi-k2.5" }),
      guildConfig: makeGuildConfig({
        model: "moonshotai/kimi-k2.5",
        triggers: { mention: true, keywords: [], randomChance: 0 },
        promptCaching: { enabled: true, profile: "conservative" },
      }),
      context: makeContext({
        sections: [...stableSections, { label: "Current Context", text: "volatile context", cached: false, role: "developer" }],
        userMessage: "hello bot",
      }),
      sender,
      requestLog: requestLog as unknown as HandlerDeps["requestLog"],
    };

    await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), deps);

    const payload = capturedPayload as { messages?: PayloadMessage[] };
    const messages = payload.messages ?? [];
    expect(messages.length).toBeGreaterThanOrEqual(stableSections.length + 1);

    const prepended = messages.slice(0, stableSections.length);
    expect(prepended.map((m) => m.role)).toEqual(["system", "system", "developer", "developer", "developer", "developer"]);
    expect(prepended.map((m) => messageText(m))).toEqual(stableSections.map((s) => s.text));
    expect(prepended.map((m) => hasCacheControl(m))).toEqual([false, false, true, true, true, true]);
  });

  test("google models avoid breakpoints on volatile cached developer history sections", async () => {
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
    const stableSections: ContextSection[] = [
      { label: "S1", text: "stable-system-1", cached: true, role: "system" },
      { label: "Chat History — Older", text: "stable-dev-older-history", cached: true, role: "developer" },
    ];
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig({ defaultModel: "google/gemini-3-flash-preview" }),
      guildConfig: makeGuildConfig({
        model: "google/gemini-3-flash-preview",
        triggers: { mention: true, keywords: [], randomChance: 0 },
        promptCaching: { enabled: true, profile: "conservative" },
      }),
      context: makeContext({
        sections: [...stableSections, { label: "Current Context", text: "volatile context", cached: false, role: "developer" }],
        userMessage: "hello bot",
      }),
      sender,
      requestLog: requestLog as unknown as HandlerDeps["requestLog"],
    };

    await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), deps);

    const payload = capturedPayload as { messages?: PayloadMessage[] };
    const messages = payload.messages ?? [];
    const prepended = messages.slice(0, stableSections.length);
    expect(prepended.map((m) => hasCacheControl(m))).toEqual([true, false]);
  });

  test("aggressive profile applies cache_control to all stable sections for non-anthropic models", async () => {
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
    const stableSections: ContextSection[] = [
      { label: "S1", text: "stable-system-1", cached: true, role: "system" },
      { label: "S2", text: "stable-system-2", cached: true, role: "system" },
      { label: "D1", text: "stable-dev-1", cached: true, role: "developer" },
      { label: "D2", text: "stable-dev-2", cached: true, role: "developer" },
      { label: "D3", text: "stable-dev-3", cached: true, role: "developer" },
      { label: "D4", text: "stable-dev-4", cached: true, role: "developer" },
    ];
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig({ defaultModel: "moonshotai/kimi-k2.5" }),
      guildConfig: makeGuildConfig({
        model: "moonshotai/kimi-k2.5",
        triggers: { mention: true, keywords: [], randomChance: 0 },
        promptCaching: { enabled: true, profile: "aggressive" },
      }),
      context: makeContext({
        sections: [...stableSections, { label: "Current Context", text: "volatile context", cached: false, role: "developer" }],
        userMessage: "hello bot",
      }),
      sender,
      requestLog: requestLog as unknown as HandlerDeps["requestLog"],
    };

    await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), deps);

    const payload = capturedPayload as { messages?: PayloadMessage[] };
    const messages = payload.messages ?? [];
    const prepended = messages.slice(0, stableSections.length);
    expect(prepended.map((m) => hasCacheControl(m))).toEqual([true, true, true, true, true, true]);
  });

  test("aggressive profile is clamped to four breakpoints for anthropic models", async () => {
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
    const stableSections: ContextSection[] = [
      { label: "S1", text: "stable-system-1", cached: true, role: "system" },
      { label: "S2", text: "stable-system-2", cached: true, role: "system" },
      { label: "D1", text: "stable-dev-1", cached: true, role: "developer" },
      { label: "D2", text: "stable-dev-2", cached: true, role: "developer" },
      { label: "D3", text: "stable-dev-3", cached: true, role: "developer" },
      { label: "D4", text: "stable-dev-4", cached: true, role: "developer" },
    ];
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig({ defaultModel: "anthropic/claude-sonnet-4" }),
      guildConfig: makeGuildConfig({
        model: "anthropic/claude-sonnet-4",
        triggers: { mention: true, keywords: [], randomChance: 0 },
        promptCaching: { enabled: true, profile: "aggressive" },
      }),
      context: makeContext({
        sections: [...stableSections, { label: "Current Context", text: "volatile context", cached: false, role: "developer" }],
        userMessage: "hello bot",
      }),
      sender,
      requestLog: requestLog as unknown as HandlerDeps["requestLog"],
    };

    await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), deps);

    const payload = capturedPayload as { messages?: PayloadMessage[] };
    const messages = payload.messages ?? [];
    const prepended = messages.slice(0, stableSections.length);
    expect(prepended.map((m) => hasCacheControl(m))).toEqual([true, true, true, true, false, false]);
  });

  test("disabled prompt caching inserts stable sections without cache_control", async () => {
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
    const stableSections: ContextSection[] = [
      { label: "S1", text: "stable-system-1", cached: true, role: "system" },
      { label: "D1", text: "stable-dev-1", cached: true, role: "developer" },
      { label: "D2", text: "stable-dev-2", cached: true, role: "developer" },
    ];
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig({ defaultModel: "moonshotai/kimi-k2.5" }),
      guildConfig: makeGuildConfig({
        model: "moonshotai/kimi-k2.5",
        triggers: { mention: true, keywords: [], randomChance: 0 },
        promptCaching: { enabled: false, profile: "conservative" },
      }),
      context: makeContext({
        sections: [...stableSections, { label: "Current Context", text: "volatile context", cached: false, role: "developer" }],
        userMessage: "hello bot",
      }),
      sender,
      requestLog: requestLog as unknown as HandlerDeps["requestLog"],
    };

    await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), deps);

    const payload = capturedPayload as { messages?: PayloadMessage[] };
    const messages = payload.messages ?? [];
    const prepended = messages.slice(0, stableSections.length);
    expect(prepended.map((m) => hasCacheControl(m))).toEqual([false, false, false]);

    const userMessage = messages.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    expect(hasCacheControl(userMessage as PayloadMessage)).toBe(false);
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
