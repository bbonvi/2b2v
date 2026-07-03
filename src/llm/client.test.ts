import { describe, test, expect } from "bun:test";
import {
  resolveModel,
  resolveGuildModel,
  resolveGuildModelKey,
  buildBackgroundStreamOptions,
  buildAmbientInitiativeStreamOptions,
  buildImageReadingStreamOptions,
  buildStreamOptions,
  fetchOpenRouterModelMetadata,
  imageInputSupportFromMetadata,
} from "./client.ts";
import type { GlobalConfig, GuildConfig, PromptTransportConfig } from "../config/types.ts";

const PROMPT_TRANSPORT: PromptTransportConfig = {
  openaiCodex: {
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

const GLOBAL: GlobalConfig = {
  discordToken: "t",
  openrouterApiKey: "or_key_123",
  codexAuthPath: "data/codex-auth.json",
  codexTransport: "websocket-cached",
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
  defaultImageGeneration: { quality: "auto" },
  defaultAttachmentsDir: "data/attachments",
  defaultInstructions: "",
  logLevel: "info",
  dataDir: "data",
  modelCacheDir: "model-cache",
  qdrantUrl: "http://localhost:6333",
  uiLang: "en",
  defaultEmotes: { include: false },
  defaultMembers: { include: true },
  defaultDispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
  defaultTypingSimulation: { enabled: false, inputReadingWpm: 450, inputMinDelayMs: 300, inputMaxDelayMs: 3500, outputTypingWpm: 180, outputMinHoldMs: 700, outputMaxHoldMs: 3500 },
  defaultAgentJobs: { imageTimeoutMs: 300_000, imageCancelGraceMs: 60_000, terminalVisibleMs: 600_000, maxImageReplacements: 2 },
  defaultPromptCaching: { enabled: true },
  defaultPromptTransport: PROMPT_TRANSPORT,
  defaultBackgroundLlm: { modelParams: {} },
  defaultReplyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
  defaultMemoryExtraction: {
    postReply: true,
    maxToolCalls: 5,
    ambient: { enabled: false, everyMessages: 300, maxBatchMessages: 300, minIntervalSeconds: 600 },
  },
};

const GUILD: GuildConfig = {
  guildId: "1",
  slug: "test",
  triggers: { mention: true, keywords: [], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingMaxWaitMs: 15000 },
  triggerInstructions: {},
  timezone: "UTC",
  trim: { trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 },
  adminUserIds: [],
  imageMaxDimension: 4096,
  mergeMessageGapSeconds: 120,
  imageReadMaxPerCall: 10,
  imageCaptioningEnabled: false,
  imageReading: { fallbackEnabled: false, fallbackModel: "moonshotai/kimi-k2.5", fallbackModelParams: {} },
  imageGeneration: { quality: "auto" },
  attachmentsDir: "data/attachments",
  instructions: "",
  emotes: { include: false },
  members: { include: true },
  dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
  typingSimulation: { enabled: false, inputReadingWpm: 450, inputMinDelayMs: 300, inputMaxDelayMs: 3500, outputTypingWpm: 180, outputMinHoldMs: 700, outputMaxHoldMs: 3500 },
  agentJobs: { imageTimeoutMs: 300_000, imageCancelGraceMs: 60_000, terminalVisibleMs: 600_000, maxImageReplacements: 2 },
  promptCaching: { enabled: true },
  promptTransport: PROMPT_TRANSPORT,
  backgroundLlm: {
    model: "moonshotai/kimi-k2.5",
    modelParams: {},
    promptCaching: { enabled: true },
  },
  replyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
  memoryExtraction: {
    postReply: true,
    maxToolCalls: 5,
    ambient: { enabled: false, everyMessages: 300, maxBatchMessages: 300, minIntervalSeconds: 600 },
  },
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
    expect(opts.transport).toBe("websocket-cached");
    expect(opts.serviceTier).toBe("priority");
    expect(opts.service_tier).toBeUndefined();
  });
});

describe("buildAmbientInitiativeStreamOptions", () => {
  test("uses initiative evaluator config without requiring ambient attention", () => {
    const opts = buildAmbientInitiativeStreamOptions(GLOBAL, {
      ...GUILD,
      ambientInitiative: {
        enabled: true,
        shadowMode: false,
        checkIntervalMinMs: 1000,
        checkIntervalMaxMs: 2000,
        activeHours: { start: "10:00", end: "01:00" },
        historyLimit: 60,
        recentActivityMinMs: 300_000,
        recentActivityMaxMs: 10_800_000,
        quietWindowMs: 360_000,
        typingActiveMs: 10_000,
        botCooldownMs: 2_700_000,
        fatigueAfterAnyMs: 3_600_000,
        maxPerDay: 5,
        minMainChannelHumanMessages: 20,
        mainChannelLookbackDays: 7,
        evaluator: {
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          modelParams: { textVerbosity: "low" },
          thinkingLevel: "minimal",
          serviceTier: "priority",
          llmOutputTimeoutMs: 8000,
        },
        selfExpression: {
          enabled: true,
          basePressure: 0.18,
          pressureThreshold: 0.72,
          probabilityThreshold: 0.72,
          confidenceThreshold: 0.6,
          cooldownMs: 10_800_000,
          maxPerDay: 3,
        },
        targetedCheckin: {
          enabled: true,
          basePressure: 0.16,
          pressureThreshold: 0.72,
          probabilityThreshold: 0.72,
          confidenceThreshold: 0.6,
          cooldownMs: 7_200_000,
          maxPerDay: 3,
          maxPerUserPerDay: 1,
          openLoopMaxAgeMs: 172_800_000,
        },
      },
    });

    expect(opts.apiKey).toBe("");
    expect(opts.codexAuthPath).toBe("data/codex-auth.json");
    expect(opts.transport).toBe("websocket-cached");
    expect(opts.textVerbosity).toBe("low");
    expect(opts.reasoningEffort).toBe("minimal");
    expect(opts.serviceTier).toBe("priority");
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
    expect(opts.transport).toBe("websocket-cached");
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
    expect(opts.transport).toBe("websocket-cached");
    expect(opts.reasoningEffort).toBe("high");
  });

  test("uses configured Codex transport", () => {
    const opts = buildStreamOptions(
      { ...GLOBAL, codexTransport: "sse" },
      { ...GUILD, llmProvider: "openai-codex", model: "gpt-5.5" },
    );
    expect(opts.transport).toBe("sse");
  });

  test("does not let modelParams override configured Codex transport", () => {
    const opts = buildStreamOptions(
      { ...GLOBAL, codexTransport: "websocket" },
      {
        ...GUILD,
        llmProvider: "openai-codex",
        model: "gpt-5.5",
        modelParams: { transport: "sse" },
      },
    );
    expect(opts.transport).toBe("websocket");
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
