import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import type { GuildConfig, GuildConfigYaml } from "./types.ts";
import { loadGlobalConfig, loadGuildConfigs, loadGuildConfigFile, loadMainConfig, resolveGuildConfig, resolveInstructions, saveGuildConfig, validateTrimConfig, validateVpnConfig, validateBashToolConfig } from "./loader.ts";

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
    expect(cfg.defaultThinkingLevel).toBeUndefined();
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
    expect((cfg as unknown as { defaultPromptCaching?: unknown }).defaultPromptCaching).toEqual({
      enabled: true,
    });
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

  test("rejects deprecated global instructionsPath/instructions keys", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "instructionsPath: config/instructions.md\n");
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow(
      'Deprecated config key "instructionsPath" is no longer supported. Use promptProfile instead.',
    );
  });

  test("rejects deprecated global persona/toolInstructions path keys", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "personaPath: config/persona.md\n");
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow(
      'Deprecated config key "personaPath" is no longer supported. Use promptProfile instead.',
    );
  });

  test("derives default promptProfile when promptProfile is omitted", () => {
    const cfgPath = join(TEST_DIR, "nonexistent.yaml");
    const cfg = loadGlobalConfig(BASE_ENV, cfgPath);
    expect((cfg as unknown as { promptProfile?: unknown }).promptProfile).toEqual({
      persona: [{ kind: "file", path: join(TEST_DIR, "persona.md"), optional: false }],
      toolInstructions: [{ kind: "file", path: join(TEST_DIR, "tool_instructions.md"), optional: false }],
      instructions: [{ kind: "file", path: join(TEST_DIR, "instructions.md"), optional: false }],
      lateInstructions: [{ kind: "file", path: join(TEST_DIR, "late_instructions.md"), optional: true }],
    });
  });

  test("parses explicit promptProfile sources from YAML", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(
      file,
      [
        "promptProfile:",
        "  persona:",
        "    - file: config/persona.md",
        '    - text: "Persona addon"',
        "  toolInstructions:",
        "    - file: config/tool_instructions.md",
        "    - file: config/ops.md",
        "      optional: true",
        "  instructions:",
        "    - file: config/instructions.md",
        '    - text: "Instruction addon"',
        "  lateInstructions:",
        "    - file: config/late_instructions.md",
        '    - text: "Late reinforcement"',
      ].join("\n"),
    );
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect((cfg as unknown as { promptProfile?: unknown }).promptProfile).toEqual({
      persona: [
        { kind: "file", path: "config/persona.md", optional: false },
        { kind: "inline", text: "Persona addon" },
      ],
      toolInstructions: [
        { kind: "file", path: "config/tool_instructions.md", optional: false },
        { kind: "file", path: "config/ops.md", optional: true },
      ],
      instructions: [
        { kind: "file", path: "config/instructions.md", optional: false },
        { kind: "inline", text: "Instruction addon" },
      ],
      lateInstructions: [
        { kind: "file", path: "config/late_instructions.md", optional: false },
        { kind: "inline", text: "Late reinforcement" },
      ],
    });
  });

  test("loads defaultInstructions from promptProfile.instructions inline source", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "promptProfile:\n  instructions:\n    - text: Legacy global instructions\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultInstructions).toBe("Legacy global instructions");
  });

  test("loads defaultInstructions from promptProfile.instructions file source", () => {
    const instrFile = join(TEST_DIR, "instr.md");
    writeFileSync(instrFile, "File-based instructions\n");
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(
      file,
      [
        "promptProfile:",
        "  instructions:",
        `    - file: ${instrFile}`,
      ].join("\n"),
    );
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultInstructions).toBe("File-based instructions");
  });

  test("rejects invalid promptProfile sources", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(
      file,
      [
        "promptProfile:",
        "  persona:",
        "    - file: config/persona.md",
        '      text: "invalid"',
      ].join("\n"),
    );
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow(
      'promptProfile.persona[0] must define exactly one of "file" or "text"',
    );
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

  test("uses actionLoop defaults when not configured", () => {
    const cfg = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "nonexistent.yaml"));
    expect(cfg.defaultActionLoop).toEqual({
      maxToolCalls: 8,
      wallClockTimeoutMs: 45_000,
      llmOutputTimeoutMs: 12_000,
    });
  });

  test("parses global actionLoop overrides", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "actionLoop:\n  maxToolCalls: 12\n  wallClockTimeoutMs: 30000\n  llmOutputTimeoutMs: 9000\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultActionLoop).toEqual({
      maxToolCalls: 12,
      wallClockTimeoutMs: 30_000,
      llmOutputTimeoutMs: 9_000,
    });
  });

  test("rejects invalid global actionLoop values", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "actionLoop:\n  maxToolCalls: 0\n  wallClockTimeoutMs: 500\n");
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow("actionLoop.maxToolCalls must be >= 1");
  });

  test("rejects invalid global llmOutputTimeoutMs", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "actionLoop:\n  maxToolCalls: 8\n  wallClockTimeoutMs: 30000\n  llmOutputTimeoutMs: 500\n");
    expect(() => loadGlobalConfig(BASE_ENV, file)).toThrow("actionLoop.llmOutputTimeoutMs must be >= 1000");
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
    expect(resolved.thinkingLevel).toBeUndefined();
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
    writeFileSync(cfgFile, "promptProfile:\n  instructions:\n    - text: Global default\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    expect(global.defaultInstructions).toBe("Global default");
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "52",
      slug: "no-instr",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.instructions).toBe("Global default");
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
    writeFileSync(cfgFile, "thinkingLevel: high\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    expect(global.defaultThinkingLevel).toBe("high");
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "80",
      slug: "thinking-inherit",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.thinkingLevel).toBe("high");
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

  test("inherits actionLoop from global defaults", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "actionLoop:\n  maxToolCalls: 9\n  wallClockTimeoutMs: 60000\n  llmOutputTimeoutMs: 8500\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "113",
      slug: "action-loop-inherit",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.actionLoop).toEqual({
      maxToolCalls: 9,
      wallClockTimeoutMs: 60_000,
      llmOutputTimeoutMs: 8_500,
    });
  });

  test("guild actionLoop overrides global defaults", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "actionLoop:\n  maxToolCalls: 9\n  wallClockTimeoutMs: 60000\n  llmOutputTimeoutMs: 8500\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "114",
      slug: "action-loop-override",
      actionLoop: { maxToolCalls: 3, wallClockTimeoutMs: 15000, llmOutputTimeoutMs: 4500 },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.actionLoop).toEqual({
      maxToolCalls: 3,
      wallClockTimeoutMs: 15_000,
      llmOutputTimeoutMs: 4_500,
    });
  });

  test("rejects invalid guild actionLoop overrides", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "actionLoop:\n  maxToolCalls: 9\n  wallClockTimeoutMs: 60000\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "115",
      slug: "action-loop-invalid",
      actionLoop: { maxToolCalls: 0, wallClockTimeoutMs: 5000, llmOutputTimeoutMs: 9000 },
    };
    expect(() => resolveGuildConfig(global, partial)).toThrow("actionLoop.maxToolCalls must be >= 1");
  });

  test("rejects invalid guild llmOutputTimeoutMs override", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const cfgFile = join(TEST_DIR, "config.yaml");
    writeFileSync(cfgFile, "actionLoop:\n  maxToolCalls: 9\n  wallClockTimeoutMs: 60000\n  llmOutputTimeoutMs: 8500\n");
    const global = loadGlobalConfig(BASE_ENV, cfgFile);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "116",
      slug: "action-loop-invalid-timeout",
      actionLoop: { maxToolCalls: 3, wallClockTimeoutMs: 5000, llmOutputTimeoutMs: 500 },
    };
    expect(() => resolveGuildConfig(global, partial)).toThrow("actionLoop.llmOutputTimeoutMs must be >= 1000");
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
      triggerInstructions: {},
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
      emotes: { include: false },
      members: { include: true },
      actionLoop: { maxToolCalls: 8, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
      dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000, maxFollowUps: 5 },
      promptCaching: { enabled: true },
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
      triggerInstructions: {},
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
      emotes: { include: false },
      members: { include: true },
      actionLoop: { maxToolCalls: 8, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
      dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000, maxFollowUps: 5 },
      promptCaching: { enabled: true },
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
      triggers: { mention: true, keywords: [], randomChance: 0 },
      triggerInstructions: {},
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
      instructions: "",
      emotes: { include: false },
      members: { include: true },
      actionLoop: { maxToolCalls: 8, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
      dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000, maxFollowUps: 5 },
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

describe("validateBashToolConfig", () => {
  test("accepts undefined (disabled)", () => {
    expect(() => validateBashToolConfig(undefined)).not.toThrow();
  });

  test("accepts enabled=false with any fields", () => {
    expect(() => validateBashToolConfig({
      enabled: false,
      ssh: { host: "", port: 0, user: "" },
      timeoutMs: 0,
      outputLimit: 0,
      blocklist: [],
    })).not.toThrow();
  });

  test("accepts valid enabled config", () => {
    expect(() => validateBashToolConfig({
      enabled: true,
      ssh: { host: "bash-vm", port: 22, user: "user" },
      timeoutMs: 5000,
      outputLimit: 4000,
      blocklist: ["\\bshutdown\\b"],
    })).not.toThrow();
  });

  test("rejects enabled with empty ssh.host", () => {
    expect(() => validateBashToolConfig({
      enabled: true,
      ssh: { host: "", port: 22, user: "user" },
      timeoutMs: 5000,
      outputLimit: 4000,
      blocklist: [],
    })).toThrow("bashTool.ssh.host required when bashTool.enabled");
  });

  test("rejects enabled with invalid ssh.port", () => {
    expect(() => validateBashToolConfig({
      enabled: true,
      ssh: { host: "bash-vm", port: 0, user: "user" },
      timeoutMs: 5000,
      outputLimit: 4000,
      blocklist: [],
    })).toThrow("bashTool.ssh.port must be 1-65535");
  });

  test("rejects enabled with ssh.port > 65535", () => {
    expect(() => validateBashToolConfig({
      enabled: true,
      ssh: { host: "bash-vm", port: 70000, user: "user" },
      timeoutMs: 5000,
      outputLimit: 4000,
      blocklist: [],
    })).toThrow("bashTool.ssh.port must be 1-65535");
  });

  test("rejects enabled with empty ssh.user", () => {
    expect(() => validateBashToolConfig({
      enabled: true,
      ssh: { host: "bash-vm", port: 22, user: "" },
      timeoutMs: 5000,
      outputLimit: 4000,
      blocklist: [],
    })).toThrow("bashTool.ssh.user required when bashTool.enabled");
  });

  test("rejects enabled with non-positive timeoutMs", () => {
    expect(() => validateBashToolConfig({
      enabled: true,
      ssh: { host: "bash-vm", port: 22, user: "user" },
      timeoutMs: 0,
      outputLimit: 4000,
      blocklist: [],
    })).toThrow("bashTool.timeoutMs must be positive");
  });

  test("rejects enabled with non-positive outputLimit", () => {
    expect(() => validateBashToolConfig({
      enabled: true,
      ssh: { host: "bash-vm", port: 22, user: "user" },
      timeoutMs: 5000,
      outputLimit: 0,
      blocklist: [],
    })).toThrow("bashTool.outputLimit must be positive");
  });

  test("rejects invalid regex in blocklist", () => {
    expect(() => validateBashToolConfig({
      enabled: true,
      ssh: { host: "bash-vm", port: 22, user: "user" },
      timeoutMs: 5000,
      outputLimit: 4000,
      blocklist: ["[invalid("],
    })).toThrow("bashTool.blocklist contains invalid regex");
  });
});

describe("loadGlobalConfig bashTool", () => {
  beforeEach(setup);
  afterEach(teardown);

  const BASE_ENV = { DISCORD_TOKEN: "tok_test", OPENROUTER_API_KEY: "or_test" };

  test("bashTool is undefined when not in YAML", () => {
    const cfg = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "nonexistent.yaml"));
    expect(cfg.defaultBashTool).toBeUndefined();
  });

  test("bashTool is undefined when enabled is false", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "bashTool:\n  enabled: false\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultBashTool).toBeUndefined();
  });

  test("bashTool is resolved with defaults when enabled is true", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "bashTool:\n  enabled: true\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultBashTool).toBeDefined();
    expect(cfg.defaultBashTool?.enabled).toBe(true);
    expect(cfg.defaultBashTool?.ssh.host).toBe("bash-vm");
    expect(cfg.defaultBashTool?.ssh.port).toBe(22);
    expect(cfg.defaultBashTool?.ssh.user).toBe("user");
    expect(cfg.defaultBashTool?.timeoutMs).toBe(5000);
    expect(cfg.defaultBashTool?.outputLimit).toBe(4000);
    expect(cfg.defaultBashTool?.blocklist.length).toBeGreaterThan(0);
  });

  test("bashTool ssh config is customizable", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "bashTool:\n  enabled: true\n  ssh:\n    host: custom-host\n    port: 2222\n    user: admin\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultBashTool?.ssh.host).toBe("custom-host");
    expect(cfg.defaultBashTool?.ssh.port).toBe(2222);
    expect(cfg.defaultBashTool?.ssh.user).toBe("admin");
  });

  test("bashTool timeoutMs and outputLimit are customizable", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "bashTool:\n  enabled: true\n  timeoutMs: 10000\n  outputLimit: 8000\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultBashTool?.timeoutMs).toBe(10000);
    expect(cfg.defaultBashTool?.outputLimit).toBe(8000);
  });

  test("bashTool blocklist can be overridden", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "bashTool:\n  enabled: true\n  blocklist:\n    - custom-pattern\n");
    const cfg = loadGlobalConfig(BASE_ENV, file);
    expect(cfg.defaultBashTool?.blocklist).toEqual(["custom-pattern"]);
  });
});

describe("resolveGuildConfig bashTool", () => {
  beforeEach(setup);
  afterEach(teardown);

  const BASE_ENV = { DISCORD_TOKEN: "t", OPENROUTER_API_KEY: "k" };

  test("guild inherits undefined bashTool when global disabled", () => {
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "42",
      slug: "test",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.bashTool).toBeUndefined();
  });

  test("guild cannot enable bashTool when global disabled", () => {
    const global = loadGlobalConfig(BASE_ENV, join(TEST_DIR, "none.yaml"));
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "42",
      slug: "test",
      bashTool: { enabled: true },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.bashTool).toBeUndefined();
  });

  test("guild inherits bashTool when global enabled", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "bashTool:\n  enabled: true\n");
    const global = loadGlobalConfig(BASE_ENV, file);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "42",
      slug: "test",
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.bashTool).toBeDefined();
    expect(resolved.bashTool?.enabled).toBe(true);
  });

  test("guild can disable bashTool when global enabled", () => {
    const file = join(TEST_DIR, "config.yaml");
    writeFileSync(file, "bashTool:\n  enabled: true\n");
    const global = loadGlobalConfig(BASE_ENV, file);
    const partial: GuildConfigYaml & { guildId: string; slug: string } = {
      guildId: "42",
      slug: "test",
      bashTool: { enabled: false },
    };
    const resolved = resolveGuildConfig(global, partial);
    expect(resolved.bashTool).toBeUndefined();
  });
});

describe("saveGuildConfig bashTool", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("persists bashTool enabled state", () => {
    const file = join(GUILDS_DIR, "60-bash.yaml");
    writeFileSync(file, "");

    const resolved: GuildConfig = {
      guildId: "60",
      slug: "bash",
      triggers: { mention: true, keywords: [], randomChance: 0 },
      triggerInstructions: {},
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
      instructions: "",
      bashTool: {
        enabled: true,
        ssh: { host: "bash-vm", port: 22, user: "user" },
        timeoutMs: 5000,
        outputLimit: 4000,
        blocklist: [],
      },
      emotes: { include: false },
      members: { include: true },
      actionLoop: { maxToolCalls: 8, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
      dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000, maxFollowUps: 5 },
      promptCaching: { enabled: true },
    };

    saveGuildConfig(file, resolved);

    const reloaded = loadGuildConfigFile(file);
    expect(reloaded.bashTool?.enabled).toBe(true);
  });

  test("does not persist bashTool when undefined", () => {
    const file = join(GUILDS_DIR, "61-no-bash.yaml");
    writeFileSync(file, "");

    const resolved: GuildConfig = {
      guildId: "61",
      slug: "no-bash",
      triggers: { mention: true, keywords: [], randomChance: 0 },
      triggerInstructions: {},
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
      instructions: "",
      emotes: { include: false },
      members: { include: true },
      actionLoop: { maxToolCalls: 8, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
      dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000, maxFollowUps: 5 },
      promptCaching: { enabled: true },
    };

    saveGuildConfig(file, resolved);

    const reloaded = loadGuildConfigFile(file);
    expect(reloaded.bashTool).toBeUndefined();
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
      emotes: { include: true },
      members: { include: true },
      actionLoop: { maxToolCalls: 8, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
      dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000, maxFollowUps: 5 },
      promptCaching: { enabled: true },
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
      triggers: { mention: true, keywords: [], randomChance: 0 },
      triggerInstructions: {
        random: "Be playful.",
        mention: "Be helpful.",
      },
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
      actionLoop: { maxToolCalls: 8, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
      dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000, maxFollowUps: 5 },
      promptCaching: { enabled: true },
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
      actionLoop: { maxToolCalls: 8, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
      dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000, maxFollowUps: 5 },
      promptCaching: { enabled: true },
    };

    saveGuildConfig(file, resolved);

    const reloaded = loadGuildConfigFile(file);
    expect(reloaded.triggerInstructions).toBeUndefined();
  });
});
