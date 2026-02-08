import { describe, test, expect, mock, spyOn } from "bun:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { handleMessage, injectTriggerInstruction, type IncomingMessage, type HandlerDeps, type LlmCompleteFn } from "./handler.ts";
import type { AssembledContext, ContextSection } from "./context-assembly.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";
import type { MessageSender } from "./send-message-tool.ts";
import type { Logger, TokenUsage } from "../logger.ts";

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
    promptProfile: {
      persona: [{ kind: "file", path: "config/persona.md", optional: false }],
      toolInstructions: [{ kind: "file", path: "config/tool_instructions.md", optional: false }],
      instructions: [],
    },
    logLevel: "info",
    dataDir: "./data",
    modelCacheDir: "./model-cache",
    qdrantUrl: "http://localhost:6333",
    uiLang: "en",
    defaultEmotes: { include: false },
    defaultMembers: { include: true },
    defaultDispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000, maxFollowUps: 5 },
    defaultPromptCaching: { enabled: true },
    defaultActionLoop: { maxToolCalls: 8, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
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
    dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000, maxFollowUps: 5 },
    promptCaching: { enabled: true },
    actionLoop: { maxToolCalls: 8, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
    ...overrides,
  };
}

function makeContext(overrides: Partial<AssembledContext> = {}): AssembledContext {
  return {
    sections: [
      { label: "Persona", text: "You are a test bot.", cached: true, role: "system" },
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
    ...overrides,
  };
}

function assistantWithText(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openrouter",
    model: "moonshotai/kimi-k2.5",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeFetchJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeTestLogger(): { logger: Logger; debug: ReturnType<typeof mock>; warn: ReturnType<typeof mock> } {
  const debug = mock(() => {});
  const info = mock(() => {});
  const warn = mock(() => {});
  const error = mock(() => {});
  const logTokenUsage = mock((_usage: TokenUsage) => {});
  const logger = {
    debug,
    info,
    warn,
    error,
    logTokenUsage,
    child: () => logger,
  } as Logger;
  return { logger, debug, warn };
}

describe("handleMessage", () => {
  test("returns triggered=false when no trigger matches", async () => {
    const llmComplete = mock(() => Promise.resolve(assistantWithText("{}")));
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "" });
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({
        triggers: { mention: false, keywords: [], randomChance: 0 },
      }),
      context: makeContext(),
      sender,
      llmComplete: llmComplete as unknown as LlmCompleteFn,
    };

    const result = await handleMessage(makeMessage(), deps);
    expect(result.triggered).toBe(false);
    expect(result.agentRan).toBe(false);
    expect(llmComplete).toHaveBeenCalledTimes(0);
  });

  test("executes send_message through structured tool_call", async () => {
    const senderCalls: Array<{ text: string; reply: boolean }> = [];
    const sender: MessageSender = (text, reply) => {
      senderCalls.push({ text, reply });
      return Promise.resolve({ sentMessageId: "m-1" });
    };

    const llmComplete: LlmCompleteFn = (_model, _context, _options) => {
      const payload = {
        status: "done",
        actions: [
          {
            type: "tool_call",
            tool_name: "send_message",
            arguments: { text: "hello user", reply: true },
          },
          { type: "stop_response", reason: "complete" },
        ],
      };
      return Promise.resolve(assistantWithText(JSON.stringify(payload)));
    };

    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({ triggers: { mention: true, keywords: [], randomChance: 0 } }),
      context: makeContext(),
      sender,
      llmComplete,
    };

    const result = await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), deps);

    expect(result.triggered).toBe(true);
    expect(result.agentRan).toBe(true);
    expect(senderCalls).toHaveLength(1);
    expect(senderCalls[0]?.text).toBe("hello user");
    expect(senderCalls[0]?.reply).toBe(true);
  });

  test("retries when model emits plain text instead of JSON", async () => {
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "m-1" });
    let calls = 0;

    const llmComplete: LlmCompleteFn = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(assistantWithText("just thinking out loud"));
      }
      const payload = {
        status: "done",
        actions: [{ type: "ignore_user", reason: "no response needed" }],
      };
      return Promise.resolve(assistantWithText(JSON.stringify(payload)));
    };

    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({ triggers: { mention: true, keywords: [], randomChance: 0 } }),
      context: makeContext(),
      sender,
      llmComplete,
    };

    await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), deps);

    expect(calls).toBe(2);
  });

  test("respects max tool call limit", async () => {
    let sendCalls = 0;
    const sender: MessageSender = () => {
      sendCalls += 1;
      return Promise.resolve({ sentMessageId: `m-${sendCalls}` });
    };

    const llmComplete: LlmCompleteFn = () => {
      const payload = {
        status: "continue",
        actions: [
          { type: "tool_call", tool_name: "send_message", arguments: { text: "one", reply: false } },
          { type: "tool_call", tool_name: "send_message", arguments: { text: "two", reply: false } },
        ],
      };
      return Promise.resolve(assistantWithText(JSON.stringify(payload)));
    };

    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({
        triggers: { mention: true, keywords: [], randomChance: 0 },
        actionLoop: { maxToolCalls: 1, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
      }),
      context: makeContext(),
      sender,
      llmComplete,
    };

    await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), deps);

    expect(sendCalls).toBe(1);
  });

  test("prepends stable sections to payload and marks first with cache_control", async () => {
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "m-1" });
    let capturedPayload: unknown;

    const llmComplete: LlmCompleteFn = (_model, _context, options) => {
      const mutablePayload = {
        messages: [{ role: "user", content: "hello" }],
      };
      options.onPayload?.(mutablePayload);
      capturedPayload = mutablePayload;

      const payload = {
        status: "done",
        actions: [{ type: "ignore_user", reason: "done" }],
      };
      return Promise.resolve(assistantWithText(JSON.stringify(payload)));
    };

    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({ promptCaching: { enabled: true }, triggers: { mention: true, keywords: [], randomChance: 0 } }),
      context: makeContext({
        sections: [
          { label: "S1", text: "stable-1", cached: true, role: "system" },
          { label: "S2", text: "stable-2", cached: true, role: "system" },
          { label: "V1", text: "volatile", cached: false, role: "developer" },
        ],
      }),
      sender,
      llmComplete,
    };

    await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), deps);

    const payload = capturedPayload as { messages?: Array<{ role?: string; content?: unknown }> };
    const first = payload.messages?.[0];
    expect(first?.role).toBe("system");

    const firstContent = first?.content as Array<{ text?: string; cache_control?: unknown }>;
    expect(firstContent[0]?.text).toBe("stable-1\n\nstable-2");
    expect(firstContent[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("injectTriggerInstruction inserts before Late Instruction", () => {
    const sections: ContextSection[] = [
      { label: "Persona", text: "bot", cached: true, role: "system" },
      { label: "Late Instruction", text: "late", cached: false, role: "developer" },
    ];

    const result = injectTriggerInstruction(sections, "mention behavior");

    expect(result[1]?.label).toBe("Trigger Instruction");
    expect(result[1]?.text).toBe("## Trigger Context\nmention behavior");
    expect(result[2]?.label).toBe("Late Instruction");
  });

  test("passes extra tools to loop and executes them", async () => {
    let extraExecuted = false;
    const fakeTool: AgentTool = {
      name: "fake_tool",
      label: "Fake Tool",
      description: "used by tests",
      parameters: Type.Object({ value: Type.String() }),
      execute: () => {
        extraExecuted = true;
        return Promise.resolve({ content: [{ type: "text", text: "ok" }], details: {} });
      },
    } as unknown as AgentTool;

    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "m-1" });
    const llmComplete: LlmCompleteFn = () => {
      const payload = {
        status: "done",
        actions: [
          { type: "tool_call", tool_name: "fake_tool", arguments: { value: "x" } },
          { type: "ignore_user", reason: "done" },
        ],
      };
      return Promise.resolve(assistantWithText(JSON.stringify(payload)));
    };

    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({ triggers: { mention: true, keywords: [], randomChance: 0 } }),
      context: makeContext(),
      sender,
      llmComplete,
      extraTools: [fakeTool],
    };

    await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), deps);

    expect(extraExecuted).toBe(true);
  });

  test("logs each llm output content in debug mode", async () => {
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "m-1" });
    const firstPayload = {
      status: "continue",
      actions: [{ type: "tool_call", tool_name: "send_message", arguments: { text: "hello", reply: false } }],
    };
    const secondPayload = {
      status: "done",
      actions: [{ type: "stop_response", reason: "done" }],
    };
    let call = 0;

    const llmComplete: LlmCompleteFn = () => {
      call += 1;
      if (call === 1) return Promise.resolve(assistantWithText(JSON.stringify(firstPayload)));
      return Promise.resolve(assistantWithText(JSON.stringify(secondPayload)));
    };

    const { logger, debug } = makeTestLogger();
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({ triggers: { mention: true, keywords: [], randomChance: 0 } }),
      context: makeContext(),
      sender,
      llmComplete,
      log: logger,
    };

    await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), deps);

    const llmOutputCalls = debug.mock.calls.filter((args) => args[0] === "llm_output");
    expect(llmOutputCalls).toHaveLength(2);
    expect(llmOutputCalls[0]?.[1]).toEqual({ content: JSON.stringify(firstPayload) });
    expect(llmOutputCalls[1]?.[1]).toEqual({ content: JSON.stringify(secondPayload) });
  });

  test("retries without response_format when provider reports schema state explosion", async () => {
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "m-1" });
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        makeFetchJsonResponse({
          error: {
            message: "Provider returned error",
            metadata: {
              raw: JSON.stringify({
                error: {
                  code: 400,
                  message: "The specified schema produces a constraint that has too many states for serving.",
                  status: "INVALID_ARGUMENT",
                },
              }),
            },
          },
        }, 400)
      )
      .mockResolvedValueOnce(
        makeFetchJsonResponse({
          model: "google/gemini-3-flash-preview",
          choices: [{
            message: { content: "{\"status\":\"done\",\"actions\":[{\"type\":\"ignore_user\",\"reason\":\"no response needed\"}]}" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      );

    const { logger, warn } = makeTestLogger();
    const deps: HandlerDeps = {
      globalConfig: makeGlobalConfig({ defaultModel: "google/gemini-3-flash-preview" }),
      guildConfig: makeGuildConfig({ model: "google/gemini-3-flash-preview", triggers: { mention: true, keywords: [], randomChance: 0 } }),
      context: makeContext(),
      sender,
      log: logger,
    };

    const result = await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), deps);

    expect(result.triggered).toBe(true);
    expect(result.agentRan).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const firstBodyRaw = fetchSpy.mock.calls[0]?.[1]?.body;
    const secondBodyRaw = fetchSpy.mock.calls[1]?.[1]?.body;
    const firstBody = typeof firstBodyRaw === "string" ? JSON.parse(firstBodyRaw) as { response_format?: unknown } : {};
    const secondBody = typeof secondBodyRaw === "string" ? JSON.parse(secondBodyRaw) as { response_format?: unknown } : {};

    expect(firstBody.response_format).toBeDefined();
    expect(secondBody.response_format).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "structured output unsupported, retrying without response_format",
      expect.objectContaining({ model: "google/gemini-3-flash-preview" }),
    );

    fetchSpy.mockRestore();
  });
});
