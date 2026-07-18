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
  validateTrimConfig,
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

describe("instructions", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("prefers a non-empty instruction file and otherwise uses inline text", () => {
    const path = join(TEST_DIR, "instructions.md");
    writeFileSync(path, "  file content  \n");
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
    });
    saveGuildConfig(path, config);
    expect(loadGuildConfigFile(path)).toMatchObject({
      modelProfile: "fast",
      instructions: "Guild instructions",
    });
  });
});

describe("validation helpers", () => {
  test("validates trim ordering", () => {
    expect(() => validateTrimConfig({
      trimTrigger: 200,
      trimTarget: 150,
      windowSize: 20,
      messageCharLimit: 200,
      replyQuoteChars: 50,
    })).not.toThrow();
    expect(() => validateTrimConfig({
      trimTrigger: 150,
      trimTarget: 150,
      windowSize: 20,
      messageCharLimit: 200,
      replyQuoteChars: 50,
    })).toThrow("trimTrigger must be > trim.trimTarget");
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
