import { describe, test, expect } from "bun:test";
import { resolveModel, buildStreamOptions } from "./client.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";

const GLOBAL: GlobalConfig = {
  discordToken: "t",
  openrouterApiKey: "or_key_123",
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
  dataDir: "data",
  modelCacheDir: "model-cache",
  qdrantUrl: "http://localhost:6333",
  uiLang: "en",
  defaultEmotes: { include: false },
  defaultMembers: { include: true },
  defaultDispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000, maxFollowUps: 5 },
  defaultPromptCaching: { enabled: true },
  defaultActionLoop: { maxToolCalls: 8, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
};

const GUILD: GuildConfig = {
  guildId: "1",
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
};

describe("resolveModel", () => {
  test("returns registered model for known OpenRouter model", () => {
    const model = resolveModel("moonshotai/kimi-k2.5");
    expect(model.id).toBe("moonshotai/kimi-k2.5");
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("openrouter");
  });

  test("creates custom model for unknown model string", () => {
    const model = resolveModel("some-vendor/custom-model-v3");
    expect(model.id).toBe("some-vendor/custom-model-v3");
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("openrouter");
    expect(model.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  test("uses guild model override when provided", () => {
    const guildWithOverride = { ...GUILD, model: "openai/gpt-4o" };
    const model = resolveModel(guildWithOverride.model);
    expect(model.id).toBe("openai/gpt-4o");
  });

  test("falls back to default model when guild has no override", () => {
    const model = resolveModel(GLOBAL.defaultModel);
    expect(model.id).toBe("moonshotai/kimi-k2.5");
  });
});

describe("buildStreamOptions", () => {
  test("includes API key from global config", () => {
    const opts = buildStreamOptions(GLOBAL, GUILD);
    expect(opts.apiKey).toBe("or_key_123");
  });

  test("passes through guild modelParams", () => {
    const guildWithParams = {
      ...GUILD,
      modelParams: { temperature: 0.7, topP: 0.9 },
    };
    const opts = buildStreamOptions(GLOBAL, guildWithParams);
    expect(opts.temperature).toBe(0.7);
    expect(opts.topP).toBe(0.9);
  });

  test("works with no modelParams", () => {
    const opts = buildStreamOptions(GLOBAL, GUILD);
    expect(opts.apiKey).toBe("or_key_123");
    expect(opts.temperature).toBeUndefined();
  });

  test("includes cacheRetention for prompt caching", () => {
    const opts = buildStreamOptions(GLOBAL, GUILD);
    expect(opts.cacheRetention).toBe("short");
  });

  test("passes through toolChoice from modelParams", () => {
    const guildWithToolChoice = {
      ...GUILD,
      modelParams: { toolChoice: "required" as const },
    };
    const opts = buildStreamOptions(GLOBAL, guildWithToolChoice);
    expect(opts.toolChoice).toBe("required");
  });
});
