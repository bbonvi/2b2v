import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import type { GuildConfig, GuildConfigYaml } from "./types.ts";
import { loadGlobalConfig, loadGuildConfigs, loadGuildConfigFile, resolveGuildConfig, saveGuildConfig } from "./loader.ts";

const TEST_DIR = join(import.meta.dir, "../../.test-config");
const GUILDS_DIR = join(TEST_DIR, "guilds");

function setup() {
  mkdirSync(GUILDS_DIR, { recursive: true });
}

function teardown() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("loadGlobalConfig", () => {
  test("reads defaults and env overrides", () => {
    const env = {
      DISCORD_TOKEN: "tok_test",
      OPENROUTER_API_KEY: "or_test",
      BRAVE_API_KEY: "brave_test",
      LOG_LEVEL: "debug",
    };
    const cfg = loadGlobalConfig(env);
    expect(cfg.discordToken).toBe("tok_test");
    expect(cfg.openrouterApiKey).toBe("or_test");
    expect(cfg.braveApiKey).toBe("brave_test");
    expect(cfg.logLevel).toBe("debug");
    expect(cfg.defaultModel).toBe("moonshotai/kimi-k2.5");
    expect(cfg.defaultThinkingLevel).toBe("medium");
    expect(cfg.defaultTimezone).toBe("UTC");
    expect(cfg.defaultTrim).toEqual({ trimTrigger: 200, trimTarget: 150 });
    expect(cfg.defaultMemoryRetentionDays).toBe(180);
    expect(cfg.defaultImageMaxDimension).toBe(768);
  });

  test("throws on missing DISCORD_TOKEN", () => {
    expect(() => loadGlobalConfig({ OPENROUTER_API_KEY: "x" })).toThrow("DISCORD_TOKEN");
  });

  test("throws on missing OPENROUTER_API_KEY", () => {
    expect(() => loadGlobalConfig({ DISCORD_TOKEN: "x" })).toThrow("OPENROUTER_API_KEY");
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
});

describe("resolveGuildConfig", () => {
  test("merges guild partial onto global defaults", () => {
    const global = loadGlobalConfig({
      DISCORD_TOKEN: "t",
      OPENROUTER_API_KEY: "k",
    });
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
    expect(resolved.trim).toEqual({ trimTrigger: 200, trimTarget: 150 });
    expect(resolved.memoryRetentionDays).toBe(180);
  });
});

describe("loadGuildConfigs", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("loads all guild yamls from directory", () => {
    writeFileSync(join(GUILDS_DIR, "1-alpha.yaml"), "timezone: Europe/Berlin\n");
    writeFileSync(join(GUILDS_DIR, "2-beta.yaml"), "model: openai/gpt-4o\n");
    const global = loadGlobalConfig({
      DISCORD_TOKEN: "t",
      OPENROUTER_API_KEY: "k",
    });
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
    const global = loadGlobalConfig({
      DISCORD_TOKEN: "t",
      OPENROUTER_API_KEY: "k",
    });
    const guilds = loadGuildConfigs(GUILDS_DIR, global);
    expect(guilds.size).toBe(0);
  });

  test("skips non-yaml files", () => {
    writeFileSync(join(GUILDS_DIR, "notes.txt"), "ignore me");
    writeFileSync(join(GUILDS_DIR, "3-real.yaml"), "");
    const global = loadGlobalConfig({
      DISCORD_TOKEN: "t",
      OPENROUTER_API_KEY: "k",
    });
    const guilds = loadGuildConfigs(GUILDS_DIR, global);
    expect(guilds.size).toBe(1);
    expect(guilds.has("3")).toBe(true);
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
      trim: { trimTrigger: 200, trimTarget: 150 },
      memoryRetentionDays: 180,
      adminUserIds: [],
      imageMaxDimension: 768,

    };

    saveGuildConfig(file, resolved);

    // Re-read and verify
    const reloaded = loadGuildConfigFile(file);
    expect(reloaded.timezone).toBe("Asia/Tokyo");
    expect(reloaded.model).toBe("custom/m");
    expect(reloaded.triggers?.keywords).toEqual(["hey"]);
  });
});
