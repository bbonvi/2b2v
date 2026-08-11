import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { GuildConfig } from "./types.ts";
import {
  loadGlobalConfig,
  loadGuildConfigFile,
  loadGuildConfigs,
  loadMainConfig,
  resolveGuildConfig,
  resolveInstructions,
  saveGuildConfig,
  validateContextHistoryConfig,
  validateVpnConfig,
} from "./loader.ts";

const TEST_DIR = join(import.meta.dir, "../../.test-config");
const GUILDS_DIR = join(TEST_DIR, "guilds");
const BASE_ENV = {
  DISCORD_TOKEN: "tok_test",
  OPENROUTER_API_KEY: "or_test",
};

function setup(): void {
  mkdirSync(GUILDS_DIR, { recursive: true });
}

function teardown(): void {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

function writeConfig(text: string): string {
  const path = join(TEST_DIR, "config.yaml");
  writeFileSync(path, text);
  return path;
}

describe("raw config loading", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("returns an empty object for missing and empty files", () => {
    expect(loadMainConfig(join(TEST_DIR, "missing.yaml"))).toEqual({});
    expect(loadMainConfig(writeConfig(""))).toEqual({});
  });

  test("parses named model profiles", () => {
    const config = loadMainConfig(writeConfig([
      "modelProfiles:",
      "  main:",
      "    provider: openai-codex",
      "    model: gpt-5.6-sol",
      "modelProfile: main",
    ].join("\n")));
    expect(config.modelProfiles?.main?.model).toBe("gpt-5.6-sol");
    expect(config.modelProfile).toBe("main");
  });

  test("loads guild identity from filename", () => {
    const path = join(GUILDS_DIR, "123-test-room.yaml");
    writeFileSync(path, "modelProfile: fast\n");
    expect(loadGuildConfigFile(path)).toMatchObject({
      guildId: "123",
      slug: "test-room",
      modelProfile: "fast",
    });
  });
});

describe("prompt transport", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("loads custom content and lets a guild clear it", () => {
    const global = loadGlobalConfig(BASE_ENV, writeConfig([
      "promptTransport:",
      "  openaiCodex:",
      "    sections:",
      "      custom:",
      "        content: |",
      "          Use the new feature.",
    ].join("\n")));

    expect(global.defaultPromptTransport.openaiCodex.sections.custom.content).toBe("Use the new feature.\n");
    expect(resolveGuildConfig(global, {
      guildId: "1",
      slug: "",
      promptTransport: {
        openaiCodex: {
          sections: { custom: { content: "" } },
        },
      },
    }).promptTransport.openaiCodex.sections.custom.content).toBe("");

    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      "promptTransport:",
      "  openaiCodex:",
      "    sections:",
      "      custom:",
      "        content: 42",
    ].join("\n")))).toThrow("promptTransport.openaiCodex.sections.custom.content must be a string");
  });
});

describe("instructions", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("prefers a non-empty instruction file and otherwise uses inline text", () => {
    const path = join(TEST_DIR, "instructions.md");
    writeFileSync(path, "  file <!-- hidden\ninstruction -->content  \n");
    expect(resolveInstructions("inline", path)).toBe("file content");
    expect(resolveInstructions("inline", join(TEST_DIR, "missing.md"))).toBe("inline");
    expect(resolveInstructions(undefined, undefined)).toBe("");
  });
});

describe("model profile resolution", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("provides a complete default profile when YAML is absent", () => {
    const config = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "missing.yaml"));
    expect(config.defaultModelProfile).toBe("main");
    expect(config.modelProfiles.main).toEqual({
      provider: "openrouter",
      model: "moonshotai/kimi-k2.5",
      modelParams: {},
      thinkingLevel: undefined,
      serviceTier: undefined,
      codexTransport: "websocket-cached",
      promptCaching: { enabled: true },
    });
    expect(config.defaultImageReading).toEqual({
      fallbackEnabled: false,
      fallbackModelProfile: "main",
    });
    expect(config.defaultImageGeneration).toEqual({
      quality: "auto",
      modelProfile: "main",
    });
    expect(config.repertoire).toEqual({
      enabled: false,
      lookbackHours: 48,
      refreshMinutes: 240,
      maxSourceChannels: 4,
      maxMessages: 15,
      maxChars: 10_000,
    });
    expect(config.defaultRelationships?.priorExchanges).toEqual({
      enabled: false,
      maxExchanges: 6,
      maxMessageChars: 700,
      refreshMinutes: 60,
    });
    expect(config.defaultVoice?.playback.volume).toBe(1);
  });

  test("loads and validates repertoire settings", () => {
    const config = loadGlobalConfig(BASE_ENV, writeConfig([
      "repertoire:",
      "  enabled: true",
      "  lookbackHours: 24",
      "  refreshMinutes: 60",
      "  maxSourceChannels: 3",
      "  maxMessages: 12",
      "  maxChars: 8000",
    ].join("\n")));
    expect(config.repertoire).toEqual({
      enabled: true,
      lookbackHours: 24,
      refreshMinutes: 60,
      maxSourceChannels: 3,
      maxMessages: 12,
      maxChars: 8_000,
    });
    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      "repertoire:",
      "  maxMessages: 0",
    ].join("\n")))).toThrow("repertoire.maxMessages must be a positive integer");
  });

  test("validates prior-exchange limits", () => {
    for (const field of ["maxExchanges", "maxMessageChars", "refreshMinutes"]) {
      expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
        "relationships:",
        "  priorExchanges:",
        `    ${field}: 0`,
      ].join("\n")))).toThrow(`relationships.priorExchanges.${field} must be >= 1`);
    }
  });

  test("resolves complete per-workload profiles and voice maintenance references", () => {
    const config = loadGlobalConfig(BASE_ENV, writeConfig([
      "modelProfiles:",
      "  main:",
      "    provider: openai-codex",
      "    model: gpt-5.6-sol",
      "    thinkingLevel: medium",
      "    codexTransport: websocket-cached",
      "  fast:",
      "    provider: openai-codex",
      "    model: gpt-5.6-terra",
      "    thinkingLevel: minimal",
      "    serviceTier: priority",
      "    codexTransport: websocket-cached",
      "    promptCaching:",
      "      enabled: false",
      "modelProfile: main",
      "memoryExtraction:",
      "  modelProfile: main",
      "relationships:",
      "  modelProfile: main",
      "  priorExchanges:",
      "    enabled: true",
      "    maxExchanges: 4",
      "    maxMessageChars: 500",
      "    refreshMinutes: 30",
      "innerThreads:",
      "  modelProfile: fast",
      "privateLife:",
      "  maintenance:",
      "    modelProfile: fast",
      "voice:",
      "  modelProfile: fast",
      "  maintenance:",
      "    summary:",
      "      modelProfile: fast",
      "      everySegments: 12",
      "    extraction:",
      "      modelProfile: main",
      "      everySegments: 80",
      "ambientAttention:",
      "  enabled: true",
      "  evaluator:",
      "    modelProfile: fast",
    ].join("\n")));

    expect(config.modelProfiles.fast).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.6-terra",
      thinkingLevel: "minimal",
      serviceTier: "priority",
      codexTransport: "websocket-cached",
      promptCaching: { enabled: false },
    });
    expect(config.defaultVoice?.modelProfile).toBe("fast");
    expect(config.defaultVoice?.maintenance.summary).toMatchObject({
      modelProfile: "fast",
      everySegments: 12,
    });
    expect(config.defaultVoice?.maintenance.extraction).toMatchObject({
      modelProfile: "main",
      everySegments: 80,
    });
    expect(config.defaultInnerThreads?.modelProfile).toBe("fast");
    expect(config.defaultRelationships?.priorExchanges).toEqual({
      enabled: true,
      maxExchanges: 4,
      maxMessageChars: 500,
      refreshMinutes: 30,
    });
    expect(config.privateLife?.maintenance.modelProfile).toBe("fast");
    expect(config.defaultAmbientAttention?.evaluator.modelProfile).toBe("fast");
  });

  test("rejects unknown workload references", () => {
    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      "modelProfiles:",
      "  main:",
      "    provider: openai-codex",
      "    model: gpt-5.6-sol",
      "voice:",
      "  modelProfile: missing",
    ].join("\n")))).toThrow(
      'voice.modelProfile references unknown model profile "missing"',
    );
    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      "innerThreads:",
      "  modelProfile: missing",
    ].join("\n")))).toThrow(
      'innerThreads.modelProfile references unknown model profile "missing"',
    );
    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      "privateLife:",
      "  maintenance:",
      "    modelProfile: missing",
    ].join("\n")))).toThrow(
      'privateLife.maintenance.modelProfile references unknown model profile "missing"',
    );
  });

  test("validates profile provider, transport, tier, and reasoning values", () => {
    const base = [
      "modelProfiles:",
      "  main:",
      "    provider: openai-codex",
      "    model: gpt-5.6-sol",
    ];
    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      ...base,
      "    serviceTier: cheap",
    ].join("\n")))).toThrow('serviceTier must be "flex" or "priority"');
    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      ...base,
      "    codexTransport: carrier-pigeon",
    ].join("\n")))).toThrow("codexTransport");
    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      ...base,
      "    thinkingLevel: enormous",
    ].join("\n")))).toThrow("thinkingLevel");
  });

  test("requires OpenRouter credentials when any declared profile uses it", () => {
    const path = writeConfig([
      "modelProfiles:",
      "  main:",
      "    provider: openai-codex",
      "    model: gpt-5.6-sol",
      "  vision:",
      "    provider: openrouter",
      "    model: vendor/vision",
    ].join("\n"));
    expect(() => loadGlobalConfig({ DISCORD_TOKEN: "test" }, path))
      .toThrow("OPENROUTER_API_KEY is required");
  });

  test("accepts positive voice playback volume and rejects invalid values", () => {
    const configured = loadGlobalConfig(BASE_ENV, writeConfig([
      "voice:",
      "  playback:",
      "    volume: 2.5",
    ].join("\n")));
    expect(configured.defaultVoice?.playback.volume).toBe(2.5);

    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      "voice:",
      "  playback:",
      "    volume: 0",
    ].join("\n")))).toThrow("voice.playback.volume must be a positive number");
  });

  test("resolves and validates profile-wide private-life configuration", () => {
    const configured = loadGlobalConfig(BASE_ENV, writeConfig([
      "privateLife:",
      "  enabled: true",
      "  wallClockTimeoutMs: 501000",
      "  opportunitiesPerDay: 37",
      "  sleepRateMultiplier: 0.02",
      "  candidateCount: 7",
      "  recentResidueHistoryLimit: 31",
      "  recentResidueMaxAgeHours: 36",
      "  visibleOutputCooldownMinutes: 12",
      "  maintenance:",
      "    modelProfile: main",
      "  originWeights:",
      "    spontaneous: 2",
      "    continue-inner-thread: 0",
      "    recent-residue: 0",
      "  actionScopeWeights:",
      "    reflect-only: 4",
      "    social-opportunity: 0.1",
    ].join("\n")));

    expect(configured.privateLife).toMatchObject({
      enabled: true,
      wallClockTimeoutMs: 501_000,
      opportunitiesPerDay: 37,
      sleepRateMultiplier: 0.02,
      candidateCount: 7,
      recentResidueHistoryLimit: 31,
      recentResidueMaxAgeHours: 36,
      visibleOutputCooldownMinutes: 12,
      maintenance: {
        modelProfile: "main",
      },
      originWeights: {
        spontaneous: 2,
        "continue-inner-thread": 0,
        "recent-residue": 0,
      },
      actionScopeWeights: {
        "reflect-only": 4,
        "social-opportunity": 0.1,
      },
    });
    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      "privateLife:",
      "  enabled: true",
      "  sleepRateMultiplier: 0",
    ].join("\n")))).toThrow("privateLife.sleepRateMultiplier must be > 0 and <= 1");
    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      "privateLife:",
      "  originWeights:",
      "    spontaneous: 0",
      "    continue-inner-thread: 0",
      "    recent-residue: 0",
    ].join("\n")))).toThrow("privateLife.originWeights must contain at least one positive weight");
    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      "privateLife:",
      "  visibleOutputCooldownMinutes: 1441",
    ].join("\n")))).toThrow("privateLife.visibleOutputCooldownMinutes must be between 0 and 1440");
    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      "privateLife:",
      "  wallClockTimeoutMs: 999",
    ].join("\n")))).toThrow("privateLife.wallClockTimeoutMs must be >= 1000");
    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      "privateLife:",
      "  guildId: guild-1",
    ].join("\n")))).toThrow("location overrides belong to Prompt Lab");
  });
});

describe("guild resolution and persistence", () => {
  beforeEach(setup);
  afterEach(teardown);

  const configText = [
    "modelProfiles:",
    "  main:",
    "    provider: openai-codex",
    "    model: gpt-5.6-sol",
    "  fast:",
    "    provider: openai-codex",
    "    model: gpt-5.3-codex-spark",
    "modelProfile: main",
  ].join("\n");

  test("inherits the default profile and accepts a guild profile reference", () => {
    const global = loadGlobalConfig(BASE_ENV, writeConfig(configText));
    expect(resolveGuildConfig(global, { guildId: "1", slug: "" }).modelProfile)
      .toBe("main");
    expect(resolveGuildConfig(global, {
      guildId: "2",
      slug: "",
      modelProfile: "fast",
    }).modelProfile).toBe("fast");
  });

  test("inherits and overrides inner-thread maintenance configuration", () => {
    const global = loadGlobalConfig(BASE_ENV, writeConfig([
      configText,
      "innerThreads:",
      "  enabled: false",
      "  modelProfile: fast",
    ].join("\n")));
    expect(global.defaultInnerThreads).toEqual({ enabled: false, modelProfile: "fast" });
    expect(resolveGuildConfig(global, { guildId: "1", slug: "" }).innerThreads)
      .toEqual({ enabled: false, modelProfile: "fast" });
    expect(resolveGuildConfig(global, {
      guildId: "2",
      slug: "",
      innerThreads: { enabled: true, modelProfile: "main" },
    }).innerThreads).toEqual({ enabled: true, modelProfile: "main" });
  });

  test("parses and overrides semantic-maintenance durations per guild", () => {
    const global = loadGlobalConfig(BASE_ENV, writeConfig([
      configText,
      "semanticMaintenance:",
      "  burst:",
      "    modelProfile: fast",
      "    quietAfter: 2m",
      "    maxWait: 4m",
      "  sweep:",
      "    modelProfile: fast",
      "    every: 6h",
    ].join("\n")));
    expect(global.defaultSemanticMaintenance.burst).toMatchObject({
      quietAfterMs: 120_000,
      maxWaitMs: 240_000,
      modelProfile: "fast",
    });
    expect(global.defaultSemanticMaintenance.sweep).toMatchObject({
      everyMs: 21_600_000,
      modelProfile: "fast",
    });
    expect(resolveGuildConfig(global, {
      guildId: "2",
      slug: "",
      semanticMaintenance: {
        burst: { modelProfile: "main", quietAfter: "10m", maxWait: "12m" },
        sweep: { modelProfile: "main" },
      },
    }).semanticMaintenance).toMatchObject({
      burst: {
      quietAfterMs: 600_000,
      maxWaitMs: 720_000,
        modelProfile: "main",
      },
      sweep: { modelProfile: "main" },
    });
  });

  test("inherits and overrides ambient initiative wall-clock budget", () => {
    const global = loadGlobalConfig(BASE_ENV, writeConfig([
      configText,
      "ambientInitiative:",
      "  wallClockTimeoutMs: 500000",
    ].join("\n")));
    expect(global.defaultAmbientInitiative?.wallClockTimeoutMs).toBe(500_000);
    expect(resolveGuildConfig(global, {
      guildId: "2",
      slug: "",
      ambientInitiative: { wallClockTimeoutMs: 501_000 },
    }).ambientInitiative?.wallClockTimeoutMs).toBe(501_000);
    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      configText,
      "ambientInitiative:",
      "  wallClockTimeoutMs: 999",
    ].join("\n")))).toThrow("ambientInitiative.wallClockTimeoutMs must be >= 1000");
  });

  test("inherits and overrides bounded notebook configuration", () => {
    const global = loadGlobalConfig(BASE_ENV, writeConfig([
      configText,
      "notebooks:",
      "  enabled: true",
      "  maxPromptTitles: 10",
      "  defaultShelfAfter:",
      "    amount: 7",
      "    unit: days",
    ].join("\n")));
    expect(global.defaultNotebooks).toEqual({
      enabled: true,
      maxPromptTitles: 10,
      defaultShelfAfterMs: 604800000,
    });
    expect(resolveGuildConfig(global, {
      guildId: "2",
      slug: "",
      notebooks: { maxPromptTitles: 5 },
    }).notebooks).toEqual({
      enabled: true,
      maxPromptTitles: 5,
      defaultShelfAfterMs: 604800000,
    });
    expect(() => loadGlobalConfig(BASE_ENV, writeConfig([
      configText,
      "notebooks:",
      "  defaultShelfAfter:",
      "    amount: 0",
      "    unit: days",
    ].join("\n")))).toThrow("Duration requires a positive amount");
  });

  test("rejects an unknown guild profile reference", () => {
    const global = loadGlobalConfig(BASE_ENV, writeConfig(configText));
    expect(() => resolveGuildConfig(global, {
      guildId: "2",
      slug: "",
      modelProfile: "missing",
    })).toThrow('modelProfile references unknown model profile "missing"');
  });

  test("loads all guild files against the shared catalog", () => {
    const global = loadGlobalConfig(BASE_ENV, writeConfig(configText));
    writeFileSync(join(GUILDS_DIR, "1-main.yaml"), "modelProfile: main\n");
    writeFileSync(join(GUILDS_DIR, "2-fast.yaml"), "modelProfile: fast\n");
    const guilds = loadGuildConfigs(GUILDS_DIR, global);
    expect(guilds.get("1")?.modelProfile).toBe("main");
    expect(guilds.get("2")?.modelProfile).toBe("fast");
  });

  test("persists the guild profile reference", () => {
    const global = loadGlobalConfig(BASE_ENV, writeConfig(configText));
    const path = join(GUILDS_DIR, "2-fast.yaml");
    const config: GuildConfig = resolveGuildConfig(global, {
      guildId: "2",
      slug: "fast",
      modelProfile: "fast",
      instructions: "Guild instructions",
      ambientInitiative: { wallClockTimeoutMs: 501_000 },
    });
    saveGuildConfig(path, config);
    expect(loadGuildConfigFile(path)).toMatchObject({
      modelProfile: "fast",
      instructions: "Guild instructions",
      innerThreads: { enabled: true, modelProfile: "main" },
      ambientInitiative: { wallClockTimeoutMs: 501_000 },
    });
  });
});

describe("validation helpers", () => {
  test("validates context-history limits", () => {
    expect(() => validateContextHistoryConfig({
      retainedMessages: 150,
      recentMessages: 20,
      messageCharLimit: 200,
    })).not.toThrow();
    expect(() => validateContextHistoryConfig({
      retainedMessages: 20,
      recentMessages: 21,
      messageCharLimit: 200,
    })).toThrow("retainedMessages must be >= contextHistory.recentMessages");
  });

  test("validates enabled VPN configuration", () => {
    expect(() => validateVpnConfig(undefined)).not.toThrow();
    expect(() => validateVpnConfig({
      enabled: true,
      apiUrl: "",
      vpnPeer: "peer",
    })).toThrow("vpn.apiUrl required");
  });
});
