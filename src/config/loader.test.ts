import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import type { GuildConfig, GuildConfigYaml, PromptTransportConfig } from "./types.ts";
import { loadGlobalConfig, loadGuildConfigs, loadGuildConfigFile, loadMainConfig, resolveGuildConfig, resolveInstructions, saveGuildConfig, validateTrimConfig, validateVpnConfig } from "./loader.ts";

const TEST_DIR = join(import.meta.dir, "../../.test-config");
const GUILDS_DIR = join(TEST_DIR, "guilds");

function setup() {
  mkdirSync(GUILDS_DIR, { recursive: true });
}

function teardown() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

function defaultTriggerConfig(overrides: Partial<GuildConfig["triggers"]> = {}): GuildConfig["triggers"] {
  return {
    mention: true,
    keywords: [],
    randomChance: 0,
    keywordDebounceMs: 2500,
    typingIdleMs: 10000,
    typingResumeGraceMs: 3000,
    typingMaxWaitMs: 15000,
    ...overrides,
  };
}

function defaultPromptTransportConfig(): PromptTransportConfig {
  return {
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
}

describe("loadMainConfig", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("returns empty object when file does not exist", () => {
    const cfg = loadMainConfig(join(TEST_DIR, "nonexistent.yaml"));
    expect(cfg).toEqual({});
  });

  test("parses YAML fields", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "model: openai/gpt-4o\ntimezone: America/New_York\nlogLevel: debug\n");
    const cfg = loadMainConfig(file);
    expect(cfg.model).toBe("openai/gpt-4o");
    expect(cfg.timezone).toBe("America/New_York");
    expect(cfg.logLevel).toBe("debug");
  });

  test("parses trim config", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "trim:\n  trimTrigger: 100\n  windowSize: 10\n");
    const cfg = loadMainConfig(file);
    expect(cfg.trim?.trimTrigger).toBe(100);
    expect(cfg.trim?.windowSize).toBe(10);
  });

  test("parses triggers config", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "triggers:\n  mention: false\n  keywords: [hello]\n  randomChance: 0.1\n  keywordDebounceMs: 3000\n  typingIdleMs: 2000\n  typingResumeGraceMs: 3500\n  typingMaxWaitMs: 12000\n");
    const cfg = loadMainConfig(file);
    expect(cfg.triggers?.mention).toBe(false);
    expect(cfg.triggers?.keywords).toEqual(["hello"]);
    expect(cfg.triggers?.randomChance).toBe(0.1);
    expect(cfg.triggers?.keywordDebounceMs).toBe(3000);
    expect(cfg.triggers?.typingIdleMs).toBe(2000);
    expect(cfg.triggers?.typingResumeGraceMs).toBe(3500);
    expect(cfg.triggers?.typingMaxWaitMs).toBe(12000);
  });

  test("returns empty object for empty file", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "");
    const cfg = loadMainConfig(file);
    expect(cfg).toEqual({});
  });
});

describe("resolveInstructions", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("returns empty string when both undefined", () => {
    expect(resolveInstructions(undefined, undefined)).toBe("");
  });

  test("returns inline instructions when no path", () => {
    expect(resolveInstructions("inline text", undefined)).toBe("inline text");
  });

  test("returns file content when path exists", () => {
    const file = join(TEST_DIR, "instructions.md");
    writeFileSync(file, "  file content  \n");
    expect(resolveInstructions("inline fallback", file)).toBe("file content");
  });

  test("falls back to inline when path file does not exist", () => {
    expect(resolveInstructions("fallback", join(TEST_DIR, "missing.md"))).toBe("fallback");
  });

  test("falls back to inline when path is empty string", () => {
    expect(resolveInstructions("fallback", "")).toBe("fallback");
  });
});

describe("loadGlobalConfig", () => {
  beforeEach(setup);
  afterEach(teardown);

  const BASE_ENV = { DISCORD_TOKEN: "tok_test", OPENROUTER_API_KEY: "or_test" };

  test("reads defaults when no YAML file exists", () => {
    const cfg = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "nonexistent.yaml"));
    expect(cfg.defaultModel).toBe("moonshotai/kimi-k2.5");
    expect(cfg.defaultThinkingLevel).toBeUndefined();
    expect(cfg.defaultTimezone).toBe("UTC");
    expect(cfg.defaultTrim).toEqual({ trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 });
    expect(cfg.defaultTriggers).toEqual(defaultTriggerConfig());
    expect(cfg.defaultMergeMessageGapSeconds).toBe(120);
    expect(cfg.defaultImageReferenceMaxPerCall).toBe(10);
    expect(cfg.defaultImageReading).toEqual({
      fallbackEnabled: false,
      fallbackProvider: "openrouter",
      fallbackModel: "moonshotai/kimi-k2.5",
      fallbackModelParams: {},
    });
    expect(cfg.defaultImageGeneration).toEqual({ quality: "auto" });
    expect(cfg.defaultAssetReading).toEqual({
      maxCharsPerRead: 30000,
      maxDownloadBytes: 104857600,
      maxTranscriptionDurationSeconds: 7200,
      videoPreviewMaxBytes: 104857600,
      videoPreviewTimesSeconds: [0, 1, 5],
      videoPreviewTimeoutSeconds: 30,
      timeoutSeconds: { image: 30, gif: 30, audio: 90, video: 180, text: 30, file: 30 },
    });
    expect((cfg as unknown as { defaultPromptCaching?: unknown }).defaultPromptCaching).toEqual({
      enabled: true,
    });
    expect(cfg.defaultTypingSimulation).toEqual({
      enabled: false,
      inputReadingWpm: 450,
      inputMinDelayMs: 300,
      inputMaxDelayMs: 3500,
      outputTypingWpm: 180,
      outputMinHoldMs: 700,
      outputMaxHoldMs: 3500,
    });
    expect(cfg.defaultRelationships?.enabled).toBe(true);
    expect(cfg.defaultRelationships?.maxAxisDeltaPerSignal).toBe(4);
    expect(cfg.defaultRelationships?.maxToolCalls).toBe(5);
    expect(cfg.logLevel).toBe("info");
  });

  test("reads values from YAML config file", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "model: custom/model\ntimezone: Asia/Tokyo\nlogLevel: debug\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultModel).toBe("custom/model");
    expect(cfg.defaultTimezone).toBe("Asia/Tokyo");
    expect(cfg.logLevel).toBe("debug");
  });

  test("reads lazy asset limits", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "assetReading:\n  maxCharsPerRead: 50000\n  videoPreviewTimesSeconds: [0, 2]\n  timeoutSeconds:\n    audio: 120\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultAssetReading?.maxCharsPerRead).toBe(50000);
    expect(cfg.defaultAssetReading?.videoPreviewTimesSeconds).toEqual([0, 2]);
    expect(cfg.defaultAssetReading?.timeoutSeconds.audio).toBe(120);
    expect(cfg.defaultAssetReading?.timeoutSeconds.image).toBe(30);
  });

  test("reads external image safety limits", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "externalImages:\n  maxBytes: 123456\n  maxRedirects: 2\n  maxPageImages: 4\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.externalImages).toMatchObject({
      maxBytes: 123456,
      maxRedirects: 2,
      maxPageImages: 4,
      maxImagesPerCall: 5,
    });
  });

  test("rejects a non-positive image reference limit", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "imageReferenceMaxPerCall: 0\n");
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow("imageReferenceMaxPerCall must be a positive integer");
  });

  test("resolves ElevenLabs request parameters from TTS config", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, [
      "tts:",
      "  enabled: true",
      "  voices:",
      "    normal:",
      "      voiceId: voice-123",
      "      applyTextNormalization: on",
      "      outputFormat: mp3_44100_128",
      "      model: eleven_v3",
    ].join("\n"));
    const cfg = loadGlobalConfig(BASE_ENV, file);

    expect(cfg.defaultTts?.voices.normal.applyTextNormalization).toBe("on");
    expect(cfg.defaultTts?.voices.normal.outputFormat).toBe("mp3_44100_128");
  });

  test("rejects invalid TTS text normalization mode", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, [
      "tts:",
      "  enabled: true",
      "  voices:",
      "    normal:",
      "      voiceId: voice-123",
      "      applyTextNormalization: always",
    ].join("\n"));

    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow(
      'tts.voices.normal.applyTextNormalization must be "auto", "on", or "off"',
    );
  });

  test("reads triggers from YAML", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "triggers:\n  mention: false\n  keywords: [bot]\n  randomChance: 0.05\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultTriggers.mention).toBe(false);
    expect(cfg.defaultTriggers.keywords).toEqual(["bot"]);
    expect(cfg.defaultTriggers.randomChance).toBe(0.05);
  });

  test("throws on missing DISCORD_TOKEN", () => {
    expect(() => loadGlobalConfig({ OPENROUTER_API_KEY: "x" }, join(TEST_DIR, "none.yaml"))).toThrow("DISCORD_TOKEN");
  });

  test("throws on missing OPENROUTER_API_KEY", () => {
    expect(() => loadGlobalConfig({ DISCORD_TOKEN: "x" }, join(TEST_DIR, "none.yaml"))).toThrow("OPENROUTER_API_KEY");
  });

  test("does not require OpenRouter key when Codex is the only enabled LLM provider", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "llmProvider: openai-codex\nmodel: gpt-5.5\n");
    const cfg = loadGlobalConfig({
      DISCORD_TOKEN: "tok_test",
      CODEX_AUTH_PATH: "/tmp/codex-auth.json",
    }, file);
    expect(cfg.defaultLlmProvider).toBe("openai-codex");
    expect(cfg.defaultModel).toBe("gpt-5.5");
    expect(cfg.openrouterApiKey).toBeUndefined();
    expect(cfg.codexAuthPath).toBe("/tmp/codex-auth.json");
    expect(cfg.codexTransport).toBe("websocket-cached");
  });

  test("parses Codex transport", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "codexTransport: sse\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.codexTransport).toBe("sse");
  });

  test("rejects invalid Codex transport", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "codexTransport: invalid\n");
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow(
      'codexTransport must be "sse", "websocket", "websocket-cached", or "auto"',
    );
  });

  test("rejects invalid LLM provider", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "llmProvider: codex\n");
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow('llmProvider must be "openrouter" or "openai-codex"');
  });

  test("secrets come from env vars", () => {
    const cfg = loadGlobalConfig({ ...BASE_ENV, BRAVE_API_KEY: "brave_test" }, join(TEST_DIR, "none.yaml"));
    expect(cfg.discordToken).toBe("tok_test");
    expect(cfg.openrouterApiKey).toBe("or_test");
    expect(cfg.braveApiKey).toBe("brave_test");
  });

  test("parses global promptCaching overrides", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "promptCaching:\n  enabled: false\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect((cfg as unknown as { defaultPromptCaching?: unknown }).defaultPromptCaching).toEqual({
      enabled: false,
    });
  });

  test("ignores extra global promptCaching fields", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "promptCaching:\n  enabled: true\n  profile: invalid-profile\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect((cfg as unknown as { defaultPromptCaching?: unknown }).defaultPromptCaching).toEqual({
      enabled: true,
    });
  });

  test("parses global promptTransport overrides", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, [
      "promptTransport:",
      "  openaiCodex:",
      "    mode: legacy-instructions",
      "    sections:",
      "      core:",
      "        target: instructions",
      "      currentTurn:",
      "        role: developer",
      "",
    ].join("\n"));
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultPromptTransport.openaiCodex.mode).toBe("legacy-instructions");
    expect(cfg.defaultPromptTransport.openaiCodex.sections.core).toMatchObject({
      role: "developer",
      target: "instructions",
      cacheGroup: "core",
    });
    expect(cfg.defaultPromptTransport.openaiCodex.sections.currentTurn.role).toBe("developer");
    expect(cfg.defaultPromptTransport.openrouter.sections.currentTurn.role).toBe("user");
  });

  test("rejects unknown promptTransport section ids", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "promptTransport:\n  openaiCodex:\n    sections:\n      mystery:\n        role: user\n");
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow("promptTransport.openaiCodex.sections.mystery");
  });

  test("uses replyLoop defaults when not configured", () => {
    const cfg = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "nonexistent.yaml"));
    expect(cfg.defaultReplyLoop).toEqual({
      maxToolCalls: 64,
      wallClockTimeoutMs: 45_000,
      llmOutputTimeoutMs: 12_000,
    });
  });

  test("parses global replyLoop overrides", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "replyLoop:\n  maxToolCalls: 12\n  wallClockTimeoutMs: 30000\n  llmOutputTimeoutMs: 9000\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultReplyLoop).toEqual({
      maxToolCalls: 12,
      wallClockTimeoutMs: 30_000,
      llmOutputTimeoutMs: 9_000,
    });
  });

  test("parses global memoryExtraction overrides", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, [
      "memoryExtraction:",
      "  postReply: false",
      "  maxToolCalls: 4",
      "  ambient:",
      "    enabled: true",
      "    everyMessages: 120",
      "    maxBatchMessages: 80",
      "    minIntervalSeconds: 30",
    ].join("\n"));
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultMemoryExtraction).toEqual({
      postReply: false,
      maxToolCalls: 4,
      ambient: {
        enabled: true,
        everyMessages: 120,
        maxBatchMessages: 80,
        minIntervalSeconds: 30,
      },
    });
  });

  test("rejects invalid global memoryExtraction values", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "memoryExtraction:\n  ambient:\n    everyMessages: 0\n");
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow("memoryExtraction.ambient.everyMessages must be >= 1");
    writeFileSync(file, "memoryExtraction:\n  maxToolCalls: 0\n");
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow("memoryExtraction.maxToolCalls must be >= 1");
  });

  test("rejects deprecated global actionLoop key", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "actionLoop:\n  maxToolCalls: 12\n");
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow(
      'Deprecated config key "global.actionLoop" is no longer supported. Use global.replyLoop instead.',
    );
  });

  test("rejects invalid global replyLoop values", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "replyLoop:\n  maxToolCalls: 0\n  wallClockTimeoutMs: 500\n");
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow("replyLoop.maxToolCalls must be >= 1");
  });

  test("rejects invalid global llmOutputTimeoutMs", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "replyLoop:\n  maxToolCalls: 8\n  wallClockTimeoutMs: 30000\n  llmOutputTimeoutMs: 500\n");
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow("replyLoop.llmOutputTimeoutMs must be >= 1000");
  });

  test("parses global backgroundLlm overrides", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, [
      "backgroundLlm:",
      "  model: google/gemini-2.5-flash",
      "  serviceTier: flex",
      "  modelParams:",
      "    temperature: 0.1",
      "  promptCaching:",
      "    enabled: false",
    ].join("\n"));
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultBackgroundLlm).toEqual({
      model: "google/gemini-2.5-flash",
      modelParams: { temperature: 0.1 },
      thinkingLevel: undefined,
      serviceTier: "flex",
      promptCaching: { enabled: false },
    });
  });

  test("rejects invalid backgroundLlm service tier", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "backgroundLlm:\n  serviceTier: cheap\n");
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow('backgroundLlm.serviceTier must be "flex" or "priority"');
  });

  test("parses global image reading fallback config", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, [
      "imageReading:",
      "  fallbackEnabled: true",
      "  fallbackModel: moonshotai/kimi-k2.5",
      "  fallbackModelParams:",
      "    temperature: 0",
    ].join("\n"));
    const cfg = loadGlobalConfig(BASE_ENV, file);

    expect(cfg.defaultImageReading).toEqual({
      fallbackEnabled: true,
      fallbackProvider: "openrouter",
      fallbackModel: "moonshotai/kimi-k2.5",
      fallbackModelParams: { temperature: 0 },
    });
  });

  test("parses global image generation config", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, [
      "imageGeneration:",
      "  quality: high",
    ].join("\n"));
    const cfg = loadGlobalConfig(BASE_ENV, file);

    expect(cfg.defaultImageGeneration).toEqual({ quality: "high" });
  });

  test("rejects invalid image generation quality", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, [
      "imageGeneration:",
      "  quality: ultra",
    ].join("\n"));

    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow(
      'imageGeneration.quality must be "auto", "low", "medium", or "high"',
    );
  });
});

describe("loadGuildConfigFile", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("parses guild id from filename, ignores slug", () => {
    const file = join(GUILDS_DIR, "123456789-my-server.yaml");
    writeFileSync(file, "model: google/gemini-2.5-flash\ntimezone: America/New_York\n");
    const cfg = loadGuildConfigFile(file);
    expect(cfg.guildId).toBe("123456789");
    expect(cfg.slug).toBe("my-server");
    expect(cfg.model).toBe("google/gemini-2.5-flash");
    expect(cfg.timezone).toBe("America/New_York");
  });

  test("handles empty yaml as all-defaults partial", () => {
    const file = join(GUILDS_DIR, "999-empty.yaml");
    writeFileSync(file, "");
    const cfg = loadGuildConfigFile(file);
    expect(cfg.guildId).toBe("999");
    expect(cfg.model).toBeUndefined();
  });

  test("parses triggers correctly", () => {
    const file = join(GUILDS_DIR, "111-triggers.yaml");
    writeFileSync(file, "triggers:\n  mention: false\n  keywords: [hello, hi]\n  randomChance: 0.05\n");
    const cfg = loadGuildConfigFile(file);
    expect(cfg.triggers?.mention).toBe(false);
    expect(cfg.triggers?.keywords).toEqual(["hello", "hi"]);
    expect(cfg.triggers?.randomChance).toBe(0.05);
  });

  test("rejects deprecated guild actionLoop key", () => {
    const file = join(GUILDS_DIR, "111-action-loop.yaml");
    writeFileSync(file, "actionLoop:\n  maxToolCalls: 12\n");
    expect(() => loadGuildConfigFile(file)).toThrow(
      'Deprecated config key "guild.actionLoop" is no longer supported. Use guild.replyLoop instead.',
    );
  });

  test("parses adminUserIds", () => {
    const file = join(GUILDS_DIR, "222-admin.yaml");
    writeFileSync(file, 'adminUserIds:\n  - "100"\n  - "200"\n');
    const cfg = loadGuildConfigFile(file);
    expect(cfg.adminUserIds).toEqual(["100", "200"]);
  });

  test("parses instructions fields", () => {
    const file = join(GUILDS_DIR, "333-instr.yaml");
    writeFileSync(file, 'instructions: "Guild-specific instructions"\ninstructionsPath: config/guild-instr.md\n');
    const cfg = loadGuildConfigFile(file);
    expect(cfg.instructions).toBe("Guild-specific instructions");
    expect(cfg.instructionsPath).toBe("config/guild-instr.md");
  });
});

describe("resolveGuildConfig", () => {
  const BASE_ENV = { DISCORD_TOKEN: "t", OPENROUTER_API_KEY: "k" };

  test("merges guild partial onto global defaults", () => {
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "42",
      slug: "test",
      model: "custom/model",
      triggers: { keywords: ["bot"] },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.guildId).toBe("42");
    expect(resolved.model).toBe("custom/model");
    expect(resolved.triggers.keywords).toEqual(["bot"]);
    // defaults inherited
    expect(resolved.triggers.mention).toBe(true);
    expect(resolved.triggers.randomChance).toBe(0);
    expect(resolved.thinkingLevel).toBeUndefined();
    expect(resolved.timezone).toBe("UTC");
    expect(resolved.trim).toEqual({ trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 });
    expect(resolved.mergeMessageGapSeconds).toBe(120);
    expect(resolved.imageReferenceMaxPerCall).toBe(10);
    expect(resolved.imageReading).toEqual({
      fallbackEnabled: false,
      fallbackProvider: "openrouter",
      fallbackModel: "moonshotai/kimi-k2.5",
      fallbackModelParams: {},
    });
    expect(resolved.imageGeneration).toEqual({ quality: "auto" });
    expect(resolved.instructions).toBe("");
  });

  test("per-guild overrides for new fields", () => {
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "99",
      slug: "override",
      trim: { windowSize: 30, messageCharLimit: 500 },
      mergeMessageGapSeconds: 60,
      imageReferenceMaxPerCall: 5,
      imageReading: {
        fallbackEnabled: true,
        fallbackModel: "openai/gpt-4o-mini",
        fallbackModelParams: { temperature: 0 },
      },
      imageGeneration: {
        quality: "high",
      },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.trim.windowSize).toBe(30);
    expect(resolved.trim.messageCharLimit).toBe(500);
    expect(resolved.trim.replyQuoteChars).toBe(50); // default
    expect(resolved.mergeMessageGapSeconds).toBe(60);
    expect(resolved.imageReferenceMaxPerCall).toBe(5);
    expect(resolved.imageReading).toEqual({
      fallbackEnabled: true,
      fallbackProvider: "openrouter",
      fallbackModel: "openai/gpt-4o-mini",
      fallbackModelParams: { temperature: 0 },
    });
    expect(resolved.imageGeneration).toEqual({ quality: "high" });
  });

  test("rejects an invalid guild image reference limit", () => {
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    expect(() => resolveGuildConfig(global, {
      guildId: "99",
      slug: "invalid-image-limit",
      imageReferenceMaxPerCall: 1.5,
    })).toThrow("imageReferenceMaxPerCall must be a positive integer");
  });

  test("guild inline instructions override global default", () => {
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "50",
      slug: "instr",
      instructions: "Guild instructions",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.instructions).toBe("Guild instructions");
  });

  test("guild instructionsPath takes priority over inline", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const instrFile = join(TEST_DIR, "guild-instr.md");
    writeFileSync(instrFile, "From file\n");
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "51",
      slug: "instr-path",
      instructions: "Inline fallback",
      instructionsPath: instrFile,
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.instructions).toBe("From file");
    rmSync(instrFile);
  });

  test("uses empty guild instructions when none are configured", () => {
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "52",
      slug: "no-instr",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.instructions).toBe("");
  });

  test("merges global defaultModelParams with guild modelParams", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "modelParams:\n  reasoning:\n    effort: medium\n  temperature: 0.8\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    expect(global.defaultModelParams).toEqual({ reasoning: { effort: "medium" }, temperature: 0.8 });

    // Guild overrides reasoning but inherits temperature
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "70",
      slug: "params-merge",
      modelParams: { reasoning: { effort: "high" }, topP: 0.9 },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.modelParams).toEqual({
      reasoning: { effort: "high" },
      temperature: 0.8,
      topP: 0.9,
    });
  });

  test("guild with no modelParams inherits global defaults", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "modelParams:\n  reasoning:\n    effort: low\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "71",
      slug: "params-inherit",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.modelParams).toEqual({ reasoning: { effort: "low" } });
  });

  test("inherits thinkingLevel from global when guild does not specify", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "thinkingLevel: max\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    expect(global.defaultThinkingLevel).toBe("max");
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "80",
      slug: "thinking-inherit",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.thinkingLevel).toBe("max");
  });

  test("guild thinkingLevel overrides global", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "thinkingLevel: high\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "81",
      slug: "thinking-override",
      thinkingLevel: "low",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.thinkingLevel).toBe("low");
  });

  test("rejects invalid global thinkingLevel", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "thinkingLevel: enormous\n");
    expect(() => loadGlobalConfig(BASE_ENV, cfgFile)).toThrow(
      'thinkingLevel must be "minimal", "low", "medium", "high", "xhigh", or "max"',
    );
  });

  test("rejects invalid guild thinkingLevel", () => {
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "83",
      slug: "bad-thinking",
      thinkingLevel: "enormous" as never,
    };
    expect(() => resolveGuildConfig(global, partial)).toThrow(
      'thinkingLevel must be "minimal", "low", "medium", "high", "xhigh", or "max"',
    );
  });

  test("rejects invalid background thinkingLevel", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "backgroundLlm:\n  thinkingLevel: enormous\n");
    expect(() => loadGlobalConfig(BASE_ENV, cfgFile)).toThrow(
      'backgroundLlm.thinkingLevel must be "minimal", "low", "medium", "high", "xhigh", or "max"',
    );
  });

  test("thinkingLevel remains undefined when neither global nor guild specifies", () => {
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    expect(global.defaultThinkingLevel).toBeUndefined();
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "82",
      slug: "no-thinking",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.thinkingLevel).toBeUndefined();
  });

  test("inherits trigger defaults from global config YAML", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "triggers:\n  keywords: [hey, bot]\n  randomChance: 0.03\n  keywordDebounceMs: 3200\n  typingIdleMs: 2100\n  typingResumeGraceMs: 3600\n  typingMaxWaitMs: 13000\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "60",
      slug: "trigger-inherit",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.triggers.keywords).toEqual(["hey", "bot"]);
    expect(resolved.triggers.randomChance).toBe(0.03);
    expect(resolved.triggers.keywordDebounceMs).toBe(3200);
    expect(resolved.triggers.typingIdleMs).toBe(2100);
    expect(resolved.triggers.typingResumeGraceMs).toBe(3600);
    expect(resolved.triggers.typingMaxWaitMs).toBe(13000);
    expect(resolved.triggers.mention).toBe(true); // default
  });

  test("inherits typing simulation from global config YAML", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, [
      "typingSimulation:",
      "  enabled: true",
      "  inputReadingWpm: 11",
      "  inputMinDelayMs: 12",
      "  inputMaxDelayMs: 13",
      "  outputTypingWpm: 14",
      "  outputMinHoldMs: 15",
      "  outputMaxHoldMs: 16",
    ].join("\n"));
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const resolved = resolveGuildConfig(global, { guildId: "61", slug: "typing-simulation" });

    expect(resolved.typingSimulation).toEqual({
      enabled: true,
      inputReadingWpm: 11,
      inputMinDelayMs: 12,
      inputMaxDelayMs: 13,
      outputTypingWpm: 14,
      outputMinHoldMs: 15,
      outputMaxHoldMs: 16,
    });
  });

  test("inherits promptCaching from global", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "promptCaching:\n  enabled: false\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "110",
      slug: "prompt-caching-inherit",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect((resolved as unknown as { promptCaching?: unknown }).promptCaching).toEqual({
      enabled: false,
    });
  });

  test("guild promptCaching overrides global defaults", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "promptCaching:\n  enabled: true\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial = {
      guildId: "111",
      slug: "prompt-caching-override",
      promptCaching: { enabled: false },
    } as GuildConfigYaml & { guildId: string; slug: string };
    const resolved = resolveGuildConfig(global, partial);
    expect((resolved as unknown as { promptCaching?: unknown }).promptCaching).toEqual({
      enabled: false,
    });
  });

  test("guild promptTransport overrides global defaults", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "promptTransport:\n  openaiCodex:\n    sections:\n      currentTurn:\n        role: developer\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "112",
      slug: "prompt-transport-override",
      promptTransport: {
        openaiCodex: {
          sections: {
            currentTurn: { role: "user" },
            core: { target: "instructions" },
          },
        },
      },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.promptTransport.openaiCodex.sections.currentTurn.role).toBe("user");
    expect(resolved.promptTransport.openaiCodex.sections.system.target).toBe("instructions");
    expect(resolved.promptTransport.openaiCodex.sections.core.target).toBe("instructions");
    expect(resolved.promptTransport.openaiCodex.sections.runtime.role).toBe("developer");
  });

  test("rejects Codex system-role input messages", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "promptTransport:\n  openaiCodex:\n    sections:\n      core:\n        role: system\n        target: input\n");
    expect(() => loadGlobalConfig(BASE_ENV, cfgFile)).toThrow("Codex input messages do not allow system roles");
  });

  test("ignores extra guild promptCaching fields", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "promptCaching:\n  enabled: true\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial = {
      guildId: "112",
      slug: "prompt-caching-invalid",
      promptCaching: { enabled: true, profile: "invalid-profile" },
    } as unknown as GuildConfigYaml & { guildId: string; slug: string };
    const resolved = resolveGuildConfig(global, partial);
    expect((resolved as unknown as { promptCaching?: unknown }).promptCaching).toEqual({
      enabled: true,
    });
  });

  test("backgroundLlm inherits effective guild model configuration by default", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "model: global/model\nmodelParams:\n  temperature: 0.7\npromptCaching:\n  enabled: false\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "112b",
      slug: "background-default",
      model: "guild/model",
      modelParams: { topP: 0.9 },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.backgroundLlm).toEqual({
      provider: "openrouter",
      model: "guild/model",
      modelParams: { temperature: 0.7, topP: 0.9 },
      thinkingLevel: undefined,
      serviceTier: undefined,
      promptCaching: { enabled: false },
    });
  });

  test("backgroundLlm supports global and guild overrides", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, [
      "model: global/model",
      "backgroundLlm:",
      "  model: global/bg",
      "  serviceTier: flex",
      "  modelParams:",
      "    temperature: 0.2",
    ].join("\n"));
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "112c",
      slug: "background-override",
      backgroundLlm: {
        model: "guild/bg",
        serviceTier: "priority",
        modelParams: { topP: 0.5 },
        promptCaching: { enabled: false },
      },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.backgroundLlm).toEqual({
      provider: "openrouter",
      model: "guild/bg",
      modelParams: { temperature: 0.2, topP: 0.5 },
      thinkingLevel: undefined,
      serviceTier: "priority",
      promptCaching: { enabled: false },
    });
  });

  test("ambientAttention inherits global config and applies guild overrides", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, [
      "ambientAttention:",
      "  enabled: true",
      "  evaluator:",
      "    provider: openai-codex",
      "    model: gpt-5.3-codex-spark",
      "    thinkingLevel: minimal",
      "    llmOutputTimeoutMs: 8000",
      "    modelParams:",
      "      textVerbosity: low",
      "  ambientPickup:",
      "    enabled: true",
      "    probabilityThreshold: 0.8",
      "    maxRepliesPerUserPerHour: 5",
      "    maxRepliesPerChannelPerHour: 9",
      "  lingering:",
      "    typingActiveMs: 1200",
      "    maxRepliesPerUserPerHour: 18",
      "    maxRepliesPerChannelPerHour: 36",
      "  followUp:",
      "    enabled: false",
      "    maxRepliesPerUserPerHour: 1",
      "    maxRepliesPerChannelPerHour: 2",
    ].join("\n"));
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "112d",
      slug: "ambient",
      ambientAttention: {
        evaluator: { llmOutputTimeoutMs: 9000 },
        ambientPickup: { probabilityThreshold: 0.7 },
        followUp: { enabled: true, maxPerExchange: 1 },
      },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.ambientAttention?.enabled).toBe(true);
    expect(resolved.ambientAttention?.evaluator).toEqual({
      provider: "openai-codex",
      model: "gpt-5.3-codex-spark",
      modelParams: { textVerbosity: "low" },
      thinkingLevel: "minimal",
      serviceTier: undefined,
      llmOutputTimeoutMs: 9000,
    });
    expect(resolved.ambientAttention?.ambientPickup.enabled).toBe(true);
    expect(resolved.ambientAttention?.ambientPickup.probabilityThreshold).toBe(0.7);
    expect(resolved.ambientAttention?.ambientPickup.maxRepliesPerUserPerHour).toBe(5);
    expect(resolved.ambientAttention?.ambientPickup.maxRepliesPerChannelPerHour).toBe(9);
    expect(resolved.ambientAttention?.lingering.typingActiveMs).toBe(1200);
    expect(resolved.ambientAttention?.lingering.maxRepliesPerUserPerHour).toBe(18);
    expect(resolved.ambientAttention?.lingering.maxRepliesPerChannelPerHour).toBe(36);
    expect(resolved.ambientAttention?.followUp.enabled).toBe(true);
    expect(resolved.ambientAttention?.followUp.maxPerExchange).toBe(1);
    expect(resolved.ambientAttention?.followUp.maxRepliesPerUserPerHour).toBe(1);
    expect(resolved.ambientAttention?.followUp.maxRepliesPerChannelPerHour).toBe(2);
  });

  test("ambientInitiative inherits global config and applies guild overrides", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, [
      "ambientInitiative:",
      "  enabled: true",
      "  audience: bots",
      "  botTargetIds: [\"1130796465049042954\"]",
      "  botPressure: -0.15",
      "  shadowMode: true",
      "  checkIntervalMinMs: 1000",
      "  checkIntervalMaxMs: 2000",
      "  activeHours:",
      "    timezone: Europe/Moscow",
      "    start: \"10:00\"",
      "    end: \"01:00\"",
      "  evaluator:",
      "    provider: openai-codex",
      "    model: gpt-5.3-codex-spark",
      "    thinkingLevel: minimal",
      "    llmOutputTimeoutMs: 8000",
      "  selfExpression:",
      "    enabled: true",
      "    maxPerDay: 3",
      "  targetedCheckin:",
      "    maxPerUserPerDay: 2",
    ].join("\n"));
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const resolved = resolveGuildConfig(global, {
      guildId: "113d",
      slug: "initiative",
      ambientInitiative: {
        shadowMode: false,
        selfExpression: { maxPerDay: 4 },
        targetedCheckin: { maxPerUserPerDay: 1 },
      },
    });

    expect(resolved.ambientInitiative?.enabled).toBe(true);
    expect(resolved.ambientInitiative?.audience).toBe("bots");
    expect(resolved.ambientInitiative?.botTargetIds).toEqual(["1130796465049042954"]);
    expect(resolved.ambientInitiative?.botPressure).toBe(-0.15);
    expect(resolved.ambientInitiative?.shadowMode).toBe(false);
    expect(resolved.ambientInitiative?.activeHours.timezone).toBe("Europe/Moscow");
    expect(resolved.ambientInitiative?.selfExpression.maxPerDay).toBe(4);
    expect(resolved.ambientInitiative?.targetedCheckin.maxPerUserPerDay).toBe(1);
    expect(resolved.ambientInitiative?.targetedCheckin.openLoopMaxAgeMs).toBe(172800000);
  });

  test("validates bot-audience ambient initiative configuration", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, [
      "ambientInitiative:",
      "  enabled: true",
      "  audience: bots",
      "  botPressure: 1.1",
    ].join("\n"));

    expect(() => loadGlobalConfig(BASE_ENV, cfgFile)).toThrow("botPressure must be between -1 and 1");

    writeFileSync(cfgFile, [
      "ambientInitiative:",
      "  enabled: true",
      "  audience: bots",
      "  botPressure: -0.2",
    ].join("\n"));

    expect(() => loadGlobalConfig(BASE_ENV, cfgFile)).toThrow("botTargetIds must not be empty");

    writeFileSync(cfgFile, [
      "ambientInitiative:",
      "  audience: everyone",
    ].join("\n"));

    expect(() => loadGlobalConfig(BASE_ENV, cfgFile)).toThrow("audience must be humans or bots");

    writeFileSync(cfgFile, [
      "ambientInitiative:",
      "  audience: bots",
      "  botTargetIds: 1130796465049042954",
    ].join("\n"));

    expect(() => loadGlobalConfig(BASE_ENV, cfgFile)).toThrow("botTargetIds must contain non-empty Discord user IDs");
  });

  test("relationships config inherits global config and applies guild overrides", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, [
      "relationships:",
      "  maxAxisDeltaPerSignal: 2",
      "  maxToolCalls: 4",
    ].join("\n"));
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const resolved = resolveGuildConfig(global, {
      guildId: "114",
      slug: "relationships",
      relationships: {
        maxAxisDeltaPerSignal: 3,
        maxToolCalls: 6,
      },
    });

    expect(global.defaultRelationships?.maxAxisDeltaPerSignal).toBe(2);
    expect(global.defaultRelationships?.maxToolCalls).toBe(4);
    expect(resolved.relationships?.maxAxisDeltaPerSignal).toBe(3);
    expect(resolved.relationships?.maxToolCalls).toBe(6);
  });

  test("rejects invalid relationships maxToolCalls", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "relationships:\n  maxToolCalls: 0\n");
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow("relationships.maxToolCalls must be >= 1");
  });

  test("rejects invalid ambientAttention thresholds", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, [
      "ambientAttention:",
      "  enabled: true",
      "  ambientPickup:",
      "    probabilityThreshold: 1.5",
    ].join("\n"));
    expect(() => loadGlobalConfig(BASE_ENV, cfgFile)).toThrow("ambientAttention.ambientPickup.probabilityThreshold must be between 0 and 1");
  });

  test("inherits replyLoop from global defaults", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "replyLoop:\n  maxToolCalls: 9\n  wallClockTimeoutMs: 60000\n  llmOutputTimeoutMs: 8500\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "113",
      slug: "action-loop-inherit",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.replyLoop).toEqual({
      maxToolCalls: 9,
      wallClockTimeoutMs: 60_000,
      llmOutputTimeoutMs: 8_500,
    });
  });

  test("guild replyLoop overrides global defaults", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "replyLoop:\n  maxToolCalls: 9\n  wallClockTimeoutMs: 60000\n  llmOutputTimeoutMs: 8500\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "114",
      slug: "action-loop-override",
      replyLoop: { maxToolCalls: 3, wallClockTimeoutMs: 15000, llmOutputTimeoutMs: 4500 },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.replyLoop).toEqual({
      maxToolCalls: 3,
      wallClockTimeoutMs: 15_000,
      llmOutputTimeoutMs: 4_500,
    });
  });

  test("guild memoryExtraction overrides global defaults", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, [
      "memoryExtraction:",
      "  postReply: true",
      "  maxToolCalls: 3",
      "  ambient:",
      "    enabled: false",
      "    everyMessages: 300",
      "    maxBatchMessages: 250",
      "    minIntervalSeconds: 600",
    ].join("\n"));
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "117",
      slug: "memory-extraction-override",
      memoryExtraction: {
        postReply: false,
        maxToolCalls: 7,
        ambient: { enabled: true, everyMessages: 40, minIntervalSeconds: 5 },
      },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.memoryExtraction).toEqual({
      postReply: false,
      maxToolCalls: 7,
      ambient: {
        enabled: true,
        everyMessages: 40,
        maxBatchMessages: 250,
        minIntervalSeconds: 5,
      },
    });
  });

  test("rejects invalid guild replyLoop overrides", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "replyLoop:\n  maxToolCalls: 9\n  wallClockTimeoutMs: 60000\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "115",
      slug: "action-loop-invalid",
      replyLoop: { maxToolCalls: 0, wallClockTimeoutMs: 5000, llmOutputTimeoutMs: 9000 },
    };
    expect(() => resolveGuildConfig(global, partial)).toThrow("replyLoop.maxToolCalls must be >= 1");
  });

  test("rejects invalid guild llmOutputTimeoutMs override", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "replyLoop:\n  maxToolCalls: 9\n  wallClockTimeoutMs: 60000\n  llmOutputTimeoutMs: 8500\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "116",
      slug: "action-loop-invalid-timeout",
      replyLoop: { maxToolCalls: 3, wallClockTimeoutMs: 5000, llmOutputTimeoutMs: 500 },
    };
    expect(() => resolveGuildConfig(global, partial)).toThrow("replyLoop.llmOutputTimeoutMs must be >= 1000");
  });
});

describe("loadGuildConfigs", () => {
  beforeEach(setup);
  afterEach(teardown);

  const BASE_ENV = { DISCORD_TOKEN: "t", OPENROUTER_API_KEY: "k" };

  test("loads all guild yamls from directory", () => {
    writeFileSync(join(GUILDS_DIR, "1-alpha.yaml"), "timezone: Europe/Berlin\n");
    writeFileSync(join(GUILDS_DIR, "2-beta.yaml"), "model: openai/gpt-4o\n");
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    const guilds = loadGuildConfigs(GUILDS_DIR, global);
    expect(guilds.size).toBe(2);
    const g1 = guilds.get("1");
    const g2 = guilds.get("2");
    expect(g1).not.toBeNull();
    expect(g2).not.toBeNull();
    expect(g1?.timezone).toBe("Europe/Berlin");
    expect(g2?.model).toBe("openai/gpt-4o");
  });

  test("returns empty map when directory is empty", () => {
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    const guilds = loadGuildConfigs(GUILDS_DIR, global);
    expect(guilds.size).toBe(0);
  });

  test("skips non-yaml files", () => {
    writeFileSync(join(GUILDS_DIR, "notes.txt"), "ignore me");
    writeFileSync(join(GUILDS_DIR, "3-real.yaml"), "");
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    const guilds = loadGuildConfigs(GUILDS_DIR, global);
    expect(guilds.size).toBe(1);
    expect(guilds.has("3")).toBe(true);
  });

  test("rejects guild OpenRouter overrides without OpenRouter credentials", () => {
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "llmProvider: openai-codex\nmodel: gpt-5.5\n");
    writeFileSync(join(GUILDS_DIR, "4-openrouter.yaml"), "llmProvider: openrouter\nmodel: moonshotai/kimi-k2.5\n");
    const global = loadGlobalConfig({ DISCORD_TOKEN: "t", CODEX_AUTH_PATH: "/tmp/codex-auth.json" }, cfgFile);
    expect(() => loadGuildConfigs(GUILDS_DIR, global)).toThrow(
      "OPENROUTER_API_KEY is required by guild 4 OpenRouter LLM configuration",
    );
  });
});

describe("validateTrimConfig", () => {
  test("accepts valid defaults", () => {
    expect(() => validateTrimConfig({ trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 })).not.toThrow();
  });

  test("rejects windowSize < 1", () => {
    expect(() => validateTrimConfig({ trimTrigger: 200, trimTarget: 150, windowSize: 0, messageCharLimit: 200, replyQuoteChars: 50 })).toThrow("windowSize must be at least 1");
  });

  test("rejects trimTarget < windowSize", () => {
    expect(() => validateTrimConfig({ trimTrigger: 200, trimTarget: 5, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 })).toThrow("trimTarget must be >= trim.windowSize");
  });

  test("rejects trimTrigger <= trimTarget", () => {
    expect(() => validateTrimConfig({ trimTrigger: 150, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 })).toThrow("trimTrigger must be > trim.trimTarget");
  });

  test("accepts edge case trimTarget == windowSize", () => {
    expect(() => validateTrimConfig({ trimTrigger: 25, trimTarget: 20, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 })).not.toThrow();
  });
});

describe("saveGuildConfig", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("persists guild config back to yaml file", () => {
    const file = join(GUILDS_DIR, "50-save.yaml");
    writeFileSync(file, "timezone: UTC\n");

    const resolved: GuildConfig = {
      guildId: "50",
      slug: "save",
      triggers: defaultTriggerConfig({ keywords: ["hey"], randomChance: 0.1 }),
      triggerInstructions: {},
      model: "custom/m",
      thinkingLevel: "high",
      timezone: "Asia/Tokyo",
      trim: { trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 },
      adminUserIds: [],
      mergeMessageGapSeconds: 120,
      imageReferenceMaxPerCall: 10,
      imageReading: { fallbackEnabled: false, fallbackModel: "moonshotai/kimi-k2.5", fallbackModelParams: {} },
      imageGeneration: { quality: "auto" },
      instructions: "",
      emotes: { include: false },
      members: { include: true },
      replyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
      reasoningContinuation: { enabled: true, maxAgeMs: 30 * 60 * 1000 },
      dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
      typingSimulation: { enabled: false, inputReadingWpm: 450, inputMinDelayMs: 300, inputMaxDelayMs: 3500, outputTypingWpm: 180, outputMinHoldMs: 700, outputMaxHoldMs: 3500 },
      agentJobs: { imageTimeoutMs: 300_000, imageCancelGraceMs: 60_000, terminalVisibleMs: 600_000, maxImageReplacements: 2 },
    schedulePressure: { maxRequesterRunsPerHour: 120, maxRequesterRunsPerDay: 500, maxGuildRunsPerHour: 600, maxGuildRunsPerDay: 3000 },
      promptCaching: { enabled: true },
      promptTransport: defaultPromptTransportConfig(),
      backgroundLlm: { model: "custom/m", modelParams: {}, promptCaching: { enabled: true } },
      memoryExtraction: { postReply: true, maxToolCalls: 5, ambient: { enabled: false, everyMessages: 300, maxBatchMessages: 300, minIntervalSeconds: 600 } },
    };

    saveGuildConfig(file, resolved);

    // Re-read and verify
    const reloaded = loadGuildConfigFile(file);
    expect(reloaded.timezone).toBe("Asia/Tokyo");
    expect(reloaded.model).toBe("custom/m");
    expect(reloaded.triggers?.keywords).toEqual(["hey"]);
    expect(reloaded.instructions).toBeUndefined(); // empty instructions not persisted
  });

  test("persists non-empty instructions", () => {
    const file = join(GUILDS_DIR, "51-instr.yaml");
    writeFileSync(file, "");

    const resolved: GuildConfig = {
      guildId: "51",
      slug: "instr",
      triggers: defaultTriggerConfig(),
      triggerInstructions: {},
      thinkingLevel: "medium",
      timezone: "UTC",
      trim: { trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 },
      adminUserIds: [],
      mergeMessageGapSeconds: 120,
      imageReferenceMaxPerCall: 10,
      imageReading: { fallbackEnabled: false, fallbackModel: "moonshotai/kimi-k2.5", fallbackModelParams: {} },
      imageGeneration: { quality: "auto" },
      instructions: "Custom guild instructions",
      emotes: { include: false },
      members: { include: true },
      replyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
      reasoningContinuation: { enabled: true, maxAgeMs: 30 * 60 * 1000 },
      dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
      typingSimulation: { enabled: false, inputReadingWpm: 450, inputMinDelayMs: 300, inputMaxDelayMs: 3500, outputTypingWpm: 180, outputMinHoldMs: 700, outputMaxHoldMs: 3500 },
      agentJobs: { imageTimeoutMs: 300_000, imageCancelGraceMs: 60_000, terminalVisibleMs: 600_000, maxImageReplacements: 2 },
    schedulePressure: { maxRequesterRunsPerHour: 120, maxRequesterRunsPerDay: 500, maxGuildRunsPerHour: 600, maxGuildRunsPerDay: 3000 },
      promptCaching: { enabled: true },
      promptTransport: defaultPromptTransportConfig(),
      backgroundLlm: { model: "moonshotai/kimi-k2.5", modelParams: {}, promptCaching: { enabled: true } },
      memoryExtraction: { postReply: true, maxToolCalls: 5, ambient: { enabled: false, everyMessages: 300, maxBatchMessages: 300, minIntervalSeconds: 600 } },
    };

    saveGuildConfig(file, resolved);

    const reloaded = loadGuildConfigFile(file);
    expect(reloaded.instructions).toBe("Custom guild instructions");
  });

  test("persists promptCaching config", () => {
    const file = join(GUILDS_DIR, "52-prompt-caching.yaml");
    writeFileSync(file, "");

    const resolved = {
      guildId: "52",
      slug: "prompt-caching",
      triggers: defaultTriggerConfig(),
      triggerInstructions: {},
      thinkingLevel: "medium",
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
      replyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
      reasoningContinuation: { enabled: true, maxAgeMs: 30 * 60 * 1000 },
      dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
      typingSimulation: { enabled: false, inputReadingWpm: 450, inputMinDelayMs: 300, inputMaxDelayMs: 3500, outputTypingWpm: 180, outputMinHoldMs: 700, outputMaxHoldMs: 3500 },
      agentJobs: { imageTimeoutMs: 300_000, imageCancelGraceMs: 60_000, terminalVisibleMs: 600_000, maxImageReplacements: 2 },
    schedulePressure: { maxRequesterRunsPerHour: 120, maxRequesterRunsPerDay: 500, maxGuildRunsPerHour: 600, maxGuildRunsPerDay: 3000 },
      promptCaching: { enabled: false },
    } as unknown as GuildConfig;

    saveGuildConfig(file, resolved);

    const reloaded = loadGuildConfigFile(file);
    expect((reloaded as unknown as { promptCaching?: unknown }).promptCaching).toEqual({
      enabled: false,
    });
  });
});

describe("validateVpnConfig", () => {
  test("accepts undefined (disabled)", () => {
    expect(() => validateVpnConfig(undefined)).not.toThrow();
  });

  test("accepts enabled=false with empty fields", () => {
    expect(() => validateVpnConfig({ enabled: false, apiUrl: "", vpnPeer: "" })).not.toThrow();
  });

  test("accepts valid enabled config", () => {
    expect(() => validateVpnConfig({ enabled: true, apiUrl: "https://vpn.example.com", vpnPeer: "1.2.3.4" })).not.toThrow();
  });

  test("rejects enabled with empty apiUrl", () => {
    expect(() => validateVpnConfig({ enabled: true, apiUrl: "", vpnPeer: "1.2.3.4" })).toThrow("vpn.apiUrl required when vpn.enabled");
  });

  test("rejects enabled with empty vpnPeer", () => {
    expect(() => validateVpnConfig({ enabled: true, apiUrl: "https://vpn.example.com", vpnPeer: "" })).toThrow("vpn.vpnPeer required when vpn.enabled");
  });
});

describe("loadGlobalConfig vpn", () => {
  beforeEach(setup);
  afterEach(teardown);

  const BASE_ENV = { DISCORD_TOKEN: "tok_test", OPENROUTER_API_KEY: "or_test" };

  test("vpn is undefined when not in YAML", () => {
    const cfg = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "nonexistent.yaml"));
    expect(cfg.vpn).toBeUndefined();
  });

  test("vpn is undefined when enabled is false", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "vpn:\n  enabled: false\n  apiUrl: https://test.com\n  vpnPeer: 1.2.3.4\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.vpn).toBeUndefined();
  });

  test("vpn is resolved when enabled is true", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "vpn:\n  enabled: true\n  apiUrl: https://vpn.example.com\n  vpnPeer: 5.6.7.8\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.vpn).toEqual({ enabled: true, apiUrl: "https://vpn.example.com", vpnPeer: "5.6.7.8" });
  });

  test("vpn credentials can be supplied by the environment", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "vpn:\n  enabled: true\n  apiUrl: https://yaml.example.com\n  vpnPeer: yaml-peer\n");
    const cfg = loadGlobalConfig({
      ...BASE_ENV,
      VPN_API_URL: "https://env.example.com",
      VPN_PEER: "env-peer",
    }, file);
    expect(cfg.vpn).toEqual({ enabled: true, apiUrl: "https://env.example.com", vpnPeer: "env-peer" });
  });

  test("vpn fields default to empty strings when enabled", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "vpn:\n  enabled: true\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.vpn).toEqual({ enabled: true, apiUrl: "", vpnPeer: "" });
  });

  test("uiLang defaults to en", () => {
    const cfg = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "nonexistent.yaml"));
    expect(cfg.uiLang).toBe("en");
  });

  test("uiLang parses ru", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "uiLang: ru\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.uiLang).toBe("ru");
  });

  test("uiLang defaults to en for invalid values", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "uiLang: fr\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.uiLang).toBe("en");
  });
});

describe("loadGlobalConfig triggerInstructions", () => {
  beforeEach(setup);
  afterEach(teardown);

  const BASE_ENV = { DISCORD_TOKEN: "tok_test", OPENROUTER_API_KEY: "or_test" };

  test("defaultTriggerInstructions is empty object when not in YAML", () => {
    const cfg = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "nonexistent.yaml"));
    expect(cfg.defaultTriggerInstructions).toEqual({
      mention: undefined,
      keyword: undefined,
      random: undefined,
      scheduled: undefined,
    });
  });

  test("parses triggerInstructions from YAML", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, `triggerInstructions:
  mention: "You were mentioned."
  keyword: "Keyword triggered."
  random: "Random reply."
  scheduled: "Scheduled task."
`);
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultTriggerInstructions.mention).toBe("You were mentioned.");
    expect(cfg.defaultTriggerInstructions.keyword).toBe("Keyword triggered.");
    expect(cfg.defaultTriggerInstructions.random).toBe("Random reply.");
    expect(cfg.defaultTriggerInstructions.scheduled).toBe("Scheduled task.");
  });

  test("parses partial triggerInstructions", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, `triggerInstructions:
  random: "Only random set."
`);
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultTriggerInstructions.mention).toBeUndefined();
    expect(cfg.defaultTriggerInstructions.random).toBe("Only random set.");
  });
});

describe("resolveGuildConfig triggerInstructions", () => {
  beforeEach(setup);
  afterEach(teardown);

  const BASE_ENV = { DISCORD_TOKEN: "t", OPENROUTER_API_KEY: "k" };

  test("inherits triggerInstructions from global", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, `triggerInstructions:
  mention: "Global mention."
  random: "Global random."
`);
    const global = loadGlobalConfig(BASE_ENV, file);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "90",
      slug: "inherit-trigger-instr",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.triggerInstructions.mention).toBe("Global mention.");
    expect(resolved.triggerInstructions.random).toBe("Global random.");
    expect(resolved.triggerInstructions.keyword).toBeUndefined();
  });

  test("guild overrides single triggerInstruction key", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, `triggerInstructions:
  mention: "Global mention."
  random: "Global random."
`);
    const global = loadGlobalConfig(BASE_ENV, file);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "91",
      slug: "override-trigger-instr",
      triggerInstructions: {
        random: "Guild random override.",
      },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.triggerInstructions.mention).toBe("Global mention.");
    expect(resolved.triggerInstructions.random).toBe("Guild random override.");
  });

  test("guild can set triggerInstruction when global is empty", () => {
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "92",
      slug: "guild-only-trigger-instr",
      triggerInstructions: {
        scheduled: "Guild scheduled.",
      },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.triggerInstructions.scheduled).toBe("Guild scheduled.");
    expect(resolved.triggerInstructions.mention).toBeUndefined();
  });
});

describe("loadGlobalConfig emotes", () => {
  beforeEach(setup);
  afterEach(teardown);

  const BASE_ENV = { DISCORD_TOKEN: "tok_test", OPENROUTER_API_KEY: "or_test" };

  test("defaultEmotes.include is false when not in YAML", () => {
    const cfg = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "nonexistent.yaml"));
    expect(cfg.defaultEmotes).toEqual({ include: false });
  });

  test("parses emotes.include from YAML", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "emotes:\n  include: true\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultEmotes.include).toBe(true);
  });

  test("emotes.include defaults to false when emotes section exists but include not set", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "emotes:\n  somethingElse: true\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultEmotes.include).toBe(false);
  });
});

describe("resolveGuildConfig emotes", () => {
  beforeEach(setup);
  afterEach(teardown);

  const BASE_ENV = { DISCORD_TOKEN: "t", OPENROUTER_API_KEY: "k" };

  test("inherits emotes from global when guild does not override", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "emotes:\n  include: true\n");
    const global = loadGlobalConfig(BASE_ENV, file);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "100",
      slug: "emotes-inherit",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.emotes.include).toBe(true);
  });

  test("guild can override emotes.include", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "emotes:\n  include: true\n");
    const global = loadGlobalConfig(BASE_ENV, file);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "101",
      slug: "emotes-override",
      emotes: { include: false },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.emotes.include).toBe(false);
  });

  test("guild can enable emotes when global disabled", () => {
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    expect(global.defaultEmotes.include).toBe(false);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "102",
      slug: "emotes-enable",
      emotes: { include: true },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.emotes.include).toBe(true);
  });

  test("emotes defaults to { include: false } when neither global nor guild specifies", () => {
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "103",
      slug: "no-emotes",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.emotes).toEqual({ include: false });
  });
});

describe("saveGuildConfig emotes", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("persists emotes config", () => {
    const file = join(GUILDS_DIR, "80-emotes.yaml");
    writeFileSync(file, "");

    const resolved: GuildConfig = {
      guildId: "80",
      slug: "emotes",
      triggers: defaultTriggerConfig(),
      triggerInstructions: {},
      timezone: "UTC",
      trim: { trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 },
      adminUserIds: [],
      mergeMessageGapSeconds: 120,
      imageReferenceMaxPerCall: 10,
      imageReading: { fallbackEnabled: false, fallbackModel: "moonshotai/kimi-k2.5", fallbackModelParams: {} },
      imageGeneration: { quality: "auto" },
      instructions: "",
      emotes: { include: true },
      members: { include: true },
      replyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
      reasoningContinuation: { enabled: true, maxAgeMs: 30 * 60 * 1000 },
      dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
      typingSimulation: { enabled: false, inputReadingWpm: 450, inputMinDelayMs: 300, inputMaxDelayMs: 3500, outputTypingWpm: 180, outputMinHoldMs: 700, outputMaxHoldMs: 3500 },
      agentJobs: { imageTimeoutMs: 300_000, imageCancelGraceMs: 60_000, terminalVisibleMs: 600_000, maxImageReplacements: 2 },
    schedulePressure: { maxRequesterRunsPerHour: 120, maxRequesterRunsPerDay: 500, maxGuildRunsPerHour: 600, maxGuildRunsPerDay: 3000 },
      promptCaching: { enabled: true },
      promptTransport: defaultPromptTransportConfig(),
      backgroundLlm: { model: "moonshotai/kimi-k2.5", modelParams: {}, promptCaching: { enabled: true } },
      memoryExtraction: { postReply: true, maxToolCalls: 5, ambient: { enabled: false, everyMessages: 300, maxBatchMessages: 300, minIntervalSeconds: 600 } },
    };

    saveGuildConfig(file, resolved);

    const reloaded = loadGuildConfigFile(file);
    expect(reloaded.emotes?.include).toBe(true);
  });
});

describe("saveGuildConfig triggerInstructions", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("persists triggerInstructions when set", () => {
    const file = join(GUILDS_DIR, "70-trigger-instr.yaml");
    writeFileSync(file, "");

    const resolved: GuildConfig = {
      guildId: "70",
      slug: "trigger-instr",
      triggers: defaultTriggerConfig(),
      triggerInstructions: {
        random: "Be playful.",
        mention: "Be helpful.",
      },
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
      replyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
      reasoningContinuation: { enabled: true, maxAgeMs: 30 * 60 * 1000 },
      dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
      typingSimulation: { enabled: false, inputReadingWpm: 450, inputMinDelayMs: 300, inputMaxDelayMs: 3500, outputTypingWpm: 180, outputMinHoldMs: 700, outputMaxHoldMs: 3500 },
      agentJobs: { imageTimeoutMs: 300_000, imageCancelGraceMs: 60_000, terminalVisibleMs: 600_000, maxImageReplacements: 2 },
    schedulePressure: { maxRequesterRunsPerHour: 120, maxRequesterRunsPerDay: 500, maxGuildRunsPerHour: 600, maxGuildRunsPerDay: 3000 },
      promptCaching: { enabled: true },
      promptTransport: defaultPromptTransportConfig(),
      backgroundLlm: { model: "moonshotai/kimi-k2.5", modelParams: {}, promptCaching: { enabled: true } },
      memoryExtraction: { postReply: true, maxToolCalls: 5, ambient: { enabled: false, everyMessages: 300, maxBatchMessages: 300, minIntervalSeconds: 600 } },
    };

    saveGuildConfig(file, resolved);

    const reloaded = loadGuildConfigFile(file);
    expect(reloaded.triggerInstructions?.random).toBe("Be playful.");
    expect(reloaded.triggerInstructions?.mention).toBe("Be helpful.");
  });

  test("does not persist triggerInstructions when empty", () => {
    const file = join(GUILDS_DIR, "71-no-trigger-instr.yaml");
    writeFileSync(file, "");

    const resolved: GuildConfig = {
      guildId: "71",
      slug: "no-trigger-instr",
      triggers: defaultTriggerConfig(),
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
      replyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
      reasoningContinuation: { enabled: true, maxAgeMs: 30 * 60 * 1000 },
      dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
      typingSimulation: { enabled: false, inputReadingWpm: 450, inputMinDelayMs: 300, inputMaxDelayMs: 3500, outputTypingWpm: 180, outputMinHoldMs: 700, outputMaxHoldMs: 3500 },
      agentJobs: { imageTimeoutMs: 300_000, imageCancelGraceMs: 60_000, terminalVisibleMs: 600_000, maxImageReplacements: 2 },
    schedulePressure: { maxRequesterRunsPerHour: 120, maxRequesterRunsPerDay: 500, maxGuildRunsPerHour: 600, maxGuildRunsPerDay: 3000 },
      promptCaching: { enabled: true },
      promptTransport: defaultPromptTransportConfig(),
      backgroundLlm: { model: "moonshotai/kimi-k2.5", modelParams: {}, promptCaching: { enabled: true } },
      memoryExtraction: { postReply: true, maxToolCalls: 5, ambient: { enabled: false, everyMessages: 300, maxBatchMessages: 300, minIntervalSeconds: 600 } },
    };

    saveGuildConfig(file, resolved);

    const reloaded = loadGuildConfigFile(file);
    expect(reloaded.triggerInstructions).toBeUndefined();
  });
});
