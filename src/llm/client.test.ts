import { describe, test, expect } from "bun:test";
import {
  resolveModel,
  resolveGuildModel,
  resolveGuildModelKey,
  buildBackgroundStreamOptions,
  buildImageReadingStreamOptions,
  buildStreamOptions,
  fetchOpenRouterModelMetadata,
  imageInputSupportFromMetadata,
} from "./client.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";

const GLOBAL: GlobalConfig = {
  discordToken: "t",
  openrouterApiKey: "or_key_123",
  codexAuthPath: "data/codex-auth.json",
  defaultLlmProvider: "openrouter",
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
  defaultLateInstruction: "",
  promptProfile: {
    persona: [{ kind: "file", path: "prompts/persona.md", optional: false }],
    toolInstructions: [],
    instructions: [],
    lateInstructions: [{ kind: "file", path: "prompts/style.md", optional: false }],
  },
  logLevel: "info",
  dataDir: "data",
  modelCacheDir: "model-cache",
  qdrantUrl: "http://localhost:6333",
  uiLang: "en",
  defaultEmotes: { include: false },
  defaultMembers: { include: true },
  defaultDispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
  defaultPromptCaching: { enabled: true },
  defaultBackgroundLlm: { modelParams: {} },
  defaultReplyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
};

const GUILD: GuildConfig = {
  guildId: "1",
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
  replyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
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

  test("resolves OpenAI Codex subscription models", () => {
    const model = resolveModel("gpt-5.5", "openai-codex");
    expect(model.id).toBe("gpt-5.5");
    expect(model.api).toBe("openai-codex-responses");
    expect(model.provider).toBe("openai-codex");
    expect(model.llmProvider).toBe("openai-codex");
    expect(model.input).toContain("image");
  });

  test("uses provider-qualified guild model keys", () => {
    const global = { ...GLOBAL, defaultLlmProvider: "openai-codex" as const, defaultModel: "gpt-5.5" };
    const guild = { ...GUILD, llmProvider: "openai-codex" as const, model: "gpt-5.5" };
    expect(resolveGuildModel(global, guild).llmProvider).toBe("openai-codex");
    expect(resolveGuildModelKey(global, guild)).toBe("openai-codex:gpt-5.5");
  });
});

describe("fetchOpenRouterModelMetadata", () => {
  test("reads image input modalities from OpenRouter metadata", async () => {
    const calls: string[] = [];
    const metadata = await fetchOpenRouterModelMetadata({
      modelId: "vendor/vision-model",
      apiKey: "test-key",
      fetchFn: (url, init) => {
        calls.push(url.toString());
        expect(init?.headers).toEqual({ Authorization: "Bearer test-key" });
        return Promise.resolve(Response.json({
          data: [{
            id: "vendor/vision-model",
            canonical_slug: "vendor/vision-model",
            architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          }],
        }));
      },
    });

    expect(calls[0]).toContain("/models?output_modalities=all");
    expect(metadata).toEqual({ id: "vendor/vision-model", inputModalities: ["text", "image"] });
    expect(imageInputSupportFromMetadata(metadata)).toBe("supported");
  });

  test("returns null when OpenRouter does not list the model", async () => {
    const metadata = await fetchOpenRouterModelMetadata({
      modelId: "vendor/missing",
      apiKey: "test-key",
      fetchFn: () => Promise.resolve(Response.json({ data: [] })),
    });

    expect(metadata).toBeNull();
    expect(imageInputSupportFromMetadata(metadata)).toBe("unknown");
  });

  test("classifies listed text-only models as unsupported", () => {
    expect(imageInputSupportFromMetadata({
      id: "vendor/text-model",
      inputModalities: ["text"],
    })).toBe("unsupported");
  });
});

describe("buildBackgroundStreamOptions", () => {
  test("passes service_tier only when configured", () => {
    const opts = buildBackgroundStreamOptions(GLOBAL, GUILD);
    expect(opts.service_tier).toBeUndefined();

    const flex = buildBackgroundStreamOptions(GLOBAL, {
      ...GUILD,
      backgroundLlm: { ...GUILD.backgroundLlm, serviceTier: "flex" },
    });
    expect(flex.service_tier).toBe("flex");
  });

  test("uses background model params", () => {
    const opts = buildBackgroundStreamOptions(GLOBAL, {
      ...GUILD,
      backgroundLlm: {
        ...GUILD.backgroundLlm,
        modelParams: { temperature: 0.1 },
      },
    });
    expect(opts.temperature).toBe(0.1);
  });

  test("maps background thinkingLevel to provider reasoning params", () => {
    const openrouter = buildBackgroundStreamOptions(GLOBAL, {
      ...GUILD,
      backgroundLlm: { ...GUILD.backgroundLlm, thinkingLevel: "medium" },
    });
    expect(openrouter.reasoning).toEqual({ effort: "medium" });

    const codex = buildBackgroundStreamOptions(GLOBAL, {
      ...GUILD,
      backgroundLlm: {
        ...GUILD.backgroundLlm,
        provider: "openai-codex",
        thinkingLevel: "xhigh",
      },
    });
    expect(codex.reasoningEffort).toBe("xhigh");
  });

  test("does not override explicit background reasoning params", () => {
    const opts = buildBackgroundStreamOptions(GLOBAL, {
      ...GUILD,
      backgroundLlm: {
        ...GUILD.backgroundLlm,
        modelParams: { reasoning: { effort: "high" } },
        thinkingLevel: "low",
      },
    });
    expect(opts.reasoning).toEqual({ effort: "high" });
  });

  test("uses Codex auth path and service tier spelling for Codex background calls", () => {
    const opts = buildBackgroundStreamOptions(GLOBAL, {
      ...GUILD,
      backgroundLlm: {
        ...GUILD.backgroundLlm,
        provider: "openai-codex",
        serviceTier: "priority",
      },
    });
    expect(opts.apiKey).toBe("");
    expect(opts.codexAuthPath).toBe("data/codex-auth.json");
    expect(opts.serviceTier).toBe("priority");
    expect(opts.service_tier).toBeUndefined();
  });
});

describe("buildImageReadingStreamOptions", () => {
  test("includes API key and image fallback model params", () => {
    const opts = buildImageReadingStreamOptions(GLOBAL, {
      ...GUILD,
      imageReading: {
        fallbackEnabled: true,
        fallbackModel: "moonshotai/kimi-k2.5",
        fallbackModelParams: { temperature: 0, topP: 0.2 },
      },
    });

    expect(opts.apiKey).toBe("or_key_123");
    expect(opts.temperature).toBe(0);
    expect(opts.topP).toBe(0.2);
  });

  test("uses Codex auth path for Codex image fallback", () => {
    const opts = buildImageReadingStreamOptions(GLOBAL, {
      ...GUILD,
      imageReading: {
        fallbackEnabled: true,
        fallbackProvider: "openai-codex",
        fallbackModel: "gpt-5.5",
        fallbackModelParams: { temperature: 0 },
      },
    });
    expect(opts.apiKey).toBe("");
    expect(opts.codexAuthPath).toBe("data/codex-auth.json");
    expect(opts.temperature).toBe(0);
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

  test("maps thinkingLevel to OpenRouter reasoning effort", () => {
    const opts = buildStreamOptions(GLOBAL, {
      ...GUILD,
      thinkingLevel: "medium",
    });
    expect(opts.reasoning).toEqual({ effort: "medium" });
  });

  test("does not override explicit OpenRouter reasoning params", () => {
    const opts = buildStreamOptions(GLOBAL, {
      ...GUILD,
      modelParams: { reasoning: { effort: "high" } },
      thinkingLevel: "low",
    });
    expect(opts.reasoning).toEqual({ effort: "high" });
  });

  test("works with no modelParams", () => {
    const opts = buildStreamOptions(GLOBAL, GUILD);
    expect(opts.apiKey).toBe("or_key_123");
    expect(opts.temperature).toBeUndefined();
  });

  test("does not send non-OpenRouter cache retention params", () => {
    const opts = buildStreamOptions(GLOBAL, GUILD);
    expect(opts.cacheRetention).toBeUndefined();
  });

  test("passes through toolChoice from modelParams", () => {
    const guildWithToolChoice = {
      ...GUILD,
      modelParams: { toolChoice: "required" as const },
    };
    const opts = buildStreamOptions(GLOBAL, guildWithToolChoice);
    expect(opts.toolChoice).toBe("required");
  });

  test("uses Codex auth path instead of OpenRouter API key for Codex main calls", () => {
    const opts = buildStreamOptions(GLOBAL, {
      ...GUILD,
      llmProvider: "openai-codex",
      model: "gpt-5.5",
      modelParams: { reasoningEffort: "high" },
    });
    expect(opts.apiKey).toBe("");
    expect(opts.codexAuthPath).toBe("data/codex-auth.json");
    expect(opts.reasoningEffort).toBe("high");
  });

  test("maps thinkingLevel to Codex reasoning effort", () => {
    const opts = buildStreamOptions(GLOBAL, {
      ...GUILD,
      llmProvider: "openai-codex",
      model: "gpt-5.5",
      thinkingLevel: "xhigh",
    });
    expect(opts.reasoningEffort).toBe("xhigh");
  });

  test("does not override explicit Codex reasoning effort", () => {
    const opts = buildStreamOptions(GLOBAL, {
      ...GUILD,
      llmProvider: "openai-codex",
      model: "gpt-5.5",
      modelParams: { reasoningEffort: "high" },
      thinkingLevel: "low",
    });
    expect(opts.reasoningEffort).toBe("high");
  });
});
