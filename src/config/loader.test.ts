import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import type { GuildConfig, GuildConfigYaml } from "./types.ts";
import { loadGlobalConfig, loadGuildConfigs, loadGuildConfigFile, loadMainConfig, resolveGuildConfig, resolveInstructions, saveGuildConfig, validateTrimConfig } from "./loader.ts";

const TEST_DIR = join(import.meta.dir, "../../.test-config");
const GUILDS_DIR = join(TEST_DIR, "guilds");

function setup() {
  mkdirSync(GUILDS_DIR, { recursive: true });
}

function teardown() {
  rmSync(TEST_DIR, { recursive: true, force: true });
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
    writeFileSync(file, "triggers:\n  mention: false\n  keywords: [hello]\n  randomChance: 0.1\n");
    const cfg = loadMainConfig(file);
    expect(cfg.triggers?.mention).toBe(false);
    expect(cfg.triggers?.keywords).toEqual(["hello"]);
    expect(cfg.triggers?.randomChance).toBe(0.1);
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
    expect(cfg.defaultThinkingLevel).toBe("medium");
    expect(cfg.defaultTimezone).toBe("UTC");
    expect(cfg.defaultTrim).toEqual({ trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 });
    expect(cfg.defaultTriggers).toEqual({ mention: true, keywords: [], randomChance: 0 });
    expect(cfg.defaultMemoryRetentionDays).toBe(180);
    expect(cfg.defaultImageMaxDimension).toBe(768);
    expect(cfg.defaultMergeMessageGapSeconds).toBe(120);
    expect(cfg.defaultImageReadMaxPerCall).toBe(10);
    expect(cfg.defaultImageCaptioningEnabled).toBe(false);
    expect(cfg.defaultAttachmentsDir).toBe("data/attachments");
    expect(cfg.defaultInstructions).toBe("");
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

  test("reads instructions from YAML inline", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, 'instructions: "Be helpful"\n');
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultInstructions).toBe("Be helpful");
  });

  test("reads instructions from file path in YAML", () => {
    const instrFile = join(TEST_DIR, "instr.md");
    writeFileSync(instrFile, "File-based instructions\n");
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, `instructionsPath: ${instrFile}\n`);
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultInstructions).toBe("File-based instructions");
  });

  test("QDRANT_URL env overrides YAML qdrantUrl", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "qdrantUrl: http://yaml-qdrant:6333\n");
    const cfg = loadGlobalConfig({ ...BASE_ENV, QDRANT_URL: "http://env-qdrant:6333" }, file);
    expect(cfg.qdrantUrl).toBe("http://env-qdrant:6333");
  });

  test("falls back to YAML qdrantUrl when env not set", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "qdrantUrl: http://yaml-qdrant:6333\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.qdrantUrl).toBe("http://yaml-qdrant:6333");
  });

  test("reads triggers from YAML", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "triggers:\n  mention: false\n  keywords: [bot]\n  randomChance: 0.05\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultTriggers.mention).toBe(false);
    expect(cfg.defaultTriggers.keywords).toEqual(["bot"]);
    expect(cfg.defaultTriggers.randomChance).toBe(0.05);
  });

  test("derives attachmentsDir from YAML dataDir", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "dataDir: /srv/data\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultAttachmentsDir).toBe("/srv/data/attachments");
  });

  test("throws on missing DISCORD_TOKEN", () => {
    expect(() => loadGlobalConfig({ OPENROUTER_API_KEY: "x" }, join(TEST_DIR, "none.yaml"))).toThrow("DISCORD_TOKEN");
  });

  test("throws on missing OPENROUTER_API_KEY", () => {
    expect(() => loadGlobalConfig({ DISCORD_TOKEN: "x" }, join(TEST_DIR, "none.yaml"))).toThrow("OPENROUTER_API_KEY");
  });

  test("secrets come from env vars", () => {
    const cfg = loadGlobalConfig({ ...BASE_ENV, BRAVE_API_KEY: "brave_test" }, join(TEST_DIR, "none.yaml"));
    expect(cfg.discordToken).toBe("tok_test");
    expect(cfg.openrouterApiKey).toBe("or_test");
    expect(cfg.braveApiKey).toBe("brave_test");
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
    expect(resolved.thinkingLevel).toBe("medium");
    expect(resolved.timezone).toBe("UTC");
    expect(resolved.trim).toEqual({ trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 });
    expect(resolved.memoryRetentionDays).toBe(180);
    expect(resolved.mergeMessageGapSeconds).toBe(120);
    expect(resolved.imageReadMaxPerCall).toBe(10);
    expect(resolved.imageCaptioningEnabled).toBe(false);
    expect(resolved.attachmentsDir).toBe("data/attachments");
    expect(resolved.instructions).toBe("");
  });

  test("per-guild overrides for new fields", () => {
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "99",
      slug: "override",
      trim: { windowSize: 30, messageCharLimit: 500 },
      mergeMessageGapSeconds: 60,
      imageReadMaxPerCall: 5,
      imageCaptioningEnabled: true,
      attachmentsDir: "/custom/attachments",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.trim.windowSize).toBe(30);
    expect(resolved.trim.messageCharLimit).toBe(500);
    expect(resolved.trim.replyQuoteChars).toBe(50); // default
    expect(resolved.mergeMessageGapSeconds).toBe(60);
    expect(resolved.imageReadMaxPerCall).toBe(5);
    expect(resolved.imageCaptioningEnabled).toBe(true);
    expect(resolved.attachmentsDir).toBe("/custom/attachments");
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

  test("falls back to global defaultInstructions when guild has none", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, 'instructions: "Global default"\n');
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    expect(global.defaultInstructions).toBe("Global default");
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "52",
      slug: "no-instr",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.instructions).toBe("Global default");
  });

  test("inherits trigger defaults from global config YAML", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "triggers:\n  keywords: [hey, bot]\n  randomChance: 0.03\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "60",
      slug: "trigger-inherit",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.triggers.keywords).toEqual(["hey", "bot"]);
    expect(resolved.triggers.randomChance).toBe(0.03);
    expect(resolved.triggers.mention).toBe(true); // default
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
      triggers: { mention: true, keywords: ["hey"], randomChance: 0.1 },
      model: "custom/m",
      thinkingLevel: "high",
      timezone: "Asia/Tokyo",
      trim: { trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 },
      memoryRetentionDays: 180,
      adminUserIds: [],
      imageMaxDimension: 768,
      mergeMessageGapSeconds: 120,
      imageReadMaxPerCall: 10,
      imageCaptioningEnabled: false,
      attachmentsDir: "data/attachments",
      instructions: "",
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
      instructions: "Custom guild instructions",
    };

    saveGuildConfig(file, resolved);

    const reloaded = loadGuildConfigFile(file);
    expect(reloaded.instructions).toBe("Custom guild instructions");
  });
});
