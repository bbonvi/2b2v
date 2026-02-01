import { describe, test, expect, mock } from "bun:test";
import {
  configCommandDefinition,
  createConfigHandler,
  CONFIGURABLE_KEYS,
  validateConfigValue,
  formatConfigValue,
  type ConfigCommandDeps,
} from "./config.ts";
import type { GuildConfig } from "../config/types.ts";

function makeGuildConfig(overrides?: Partial<GuildConfig>): GuildConfig {
  return {
    guildId: "guild1",
    slug: "test",
    triggers: { mention: true, keywords: ["hello"], randomChance: 0.05 },
    thinkingLevel: "medium",
    timezone: "UTC",
    trim: { trimTrigger: 200, trimTarget: 150 },
    memoryRetentionDays: 180,
    adminUserIds: [],
    imageMaxDimension: 768,
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<ConfigCommandDeps>): ConfigCommandDeps {
  return {
    getGuildConfig: mock(() => makeGuildConfig()),
    updateGuildConfig: mock(() => undefined),
    adminUserIds: [],
    ...overrides,
  };
}

function makeInteraction(opts: {
  userId: string;
  guildId: string | null;
  permissionBits: bigint | null;
  subcommand: string;
  key?: string | null;
  value?: string | null;
}) {
  const replyMock = mock(() => Promise.resolve());
  return {
    user: { id: opts.userId },
    guildId: opts.guildId,
    memberPermissions: opts.permissionBits !== null ? { bitfield: opts.permissionBits } : null,
    options: {
      getSubcommand: () => opts.subcommand,
      getString: (name: string) => {
        if (name === "key") return opts.key ?? null;
        if (name === "value") return opts.value ?? null;
        return null;
      },
    },
    reply: replyMock,
  };
}

function replyArg(interaction: { reply: ReturnType<typeof mock> }): unknown {
  const calls = (interaction.reply as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return (calls[0] as unknown[])[0];
}

describe("configCommandDefinition", () => {
  test("has correct name", () => {
    const json = configCommandDefinition.toJSON();
    expect(json.name).toBe("config");
  });

  test("has three subcommands", () => {
    const json = configCommandDefinition.toJSON();
    const opts = json.options ?? [];
    expect(opts).toHaveLength(3);
    const names = opts.map((o: { name: string }) => o.name).sort();
    expect(names).toEqual(["get", "list", "set"]);
  });
});

describe("validateConfigValue", () => {
  test("validates model as non-empty string", () => {
    expect(validateConfigValue("model", "anthropic/claude-3.5-sonnet")).toBeNull();
    expect(validateConfigValue("model", "")).not.toBeNull();
  });

  test("validates thinkingLevel against known levels", () => {
    expect(validateConfigValue("thinkingLevel", "high")).toBeNull();
    expect(validateConfigValue("thinkingLevel", "off")).toBeNull();
    expect(validateConfigValue("thinkingLevel", "medium")).toBeNull();
    expect(validateConfigValue("thinkingLevel", "xhigh")).toBeNull();
    expect(validateConfigValue("thinkingLevel", "")).not.toBeNull();
    expect(validateConfigValue("thinkingLevel", "turbo")).not.toBeNull();
    expect(validateConfigValue("thinkingLevel", "max")).not.toBeNull();
  });

  test("validates timezone as non-empty string", () => {
    expect(validateConfigValue("timezone", "US/Eastern")).toBeNull();
    expect(validateConfigValue("timezone", "")).not.toBeNull();
  });

  test("validates triggers.randomChance as 0-1", () => {
    expect(validateConfigValue("triggers.randomChance", "0.05")).toBeNull();
    expect(validateConfigValue("triggers.randomChance", "1.5")).not.toBeNull();
    expect(validateConfigValue("triggers.randomChance", "abc")).not.toBeNull();
  });

  test("validates triggers.mention as boolean", () => {
    expect(validateConfigValue("triggers.mention", "true")).toBeNull();
    expect(validateConfigValue("triggers.mention", "false")).toBeNull();
    expect(validateConfigValue("triggers.mention", "maybe")).not.toBeNull();
  });

  test("validates trim values as positive integers", () => {
    expect(validateConfigValue("trim.trimTrigger", "200")).toBeNull();
    expect(validateConfigValue("trim.trimTrigger", "-5")).not.toBeNull();
    expect(validateConfigValue("trim.trimTrigger", "3.5")).not.toBeNull();
  });

  test("validates memoryRetentionDays as positive integer", () => {
    expect(validateConfigValue("memoryRetentionDays", "180")).toBeNull();
    expect(validateConfigValue("memoryRetentionDays", "0")).not.toBeNull();
  });

  test("validates imageMaxDimension as positive integer", () => {
    expect(validateConfigValue("imageMaxDimension", "768")).toBeNull();
    expect(validateConfigValue("imageMaxDimension", "abc")).not.toBeNull();
  });

  test("validates triggers.keywords as comma-separated", () => {
    expect(validateConfigValue("triggers.keywords", "hello,world")).toBeNull();
    expect(validateConfigValue("triggers.keywords", "single")).toBeNull();
    expect(validateConfigValue("triggers.keywords", "")).toBeNull();
    expect(validateConfigValue("triggers.keywords", "a, b, c")).toBeNull();
  });

  test("rejects unknown keys", () => {
    expect(validateConfigValue("nonexistent", "value")).not.toBeNull();
  });
});

describe("formatConfigValue", () => {
  test("formats simple values", () => {
    const config = makeGuildConfig();
    expect(formatConfigValue(config, "timezone")).toBe("UTC");
    expect(formatConfigValue(config, "model")).toBe("(not set)");
  });

  test("formats nested values", () => {
    const config = makeGuildConfig();
    expect(formatConfigValue(config, "triggers.mention")).toBe("true");
    expect(formatConfigValue(config, "triggers.keywords")).toBe("hello");
    expect(formatConfigValue(config, "trim.trimTrigger")).toBe("200");
  });
});

describe("createConfigHandler", () => {
  test("rejects non-admin", async () => {
    const handler = createConfigHandler(makeDeps());
    const interaction = makeInteraction({
      userId: "999",
      guildId: "guild1",
      permissionBits: 0n,
      subcommand: "list",
    });
    await handler(interaction as never);
    const call = replyArg(interaction) as { content: string; ephemeral: boolean };
    expect(call.content).toBe("Admin access required.");
    expect(call.ephemeral).toBe(true);
  });

  test("rejects when not in a guild", async () => {
    const handler = createConfigHandler(makeDeps());
    const interaction = makeInteraction({
      userId: "1",
      guildId: null,
      permissionBits: 8n,
      subcommand: "list",
    });
    await handler(interaction as never);
    const call = replyArg(interaction) as { content: string };
    expect(call.content).toBe("This command can only be used in a guild.");
  });

  test("list returns all settings", async () => {
    const deps = makeDeps();
    const handler = createConfigHandler(deps);
    const interaction = makeInteraction({
      userId: "1",
      guildId: "guild1",
      permissionBits: 8n,
      subcommand: "list",
    });
    await handler(interaction as never);
    expect(deps.getGuildConfig).toHaveBeenCalledWith("guild1");
    const call = replyArg(interaction) as { embeds: Array<{ fields: unknown[] }>; ephemeral: boolean };
    expect(call.ephemeral).toBe(true);
    expect(call.embeds).toHaveLength(1);
    const embed = call.embeds[0] as { fields: unknown[] } | undefined;
    expect(embed).toBeDefined();
    if (embed === undefined) throw new Error("unreachable");
    expect(embed.fields.length).toBeGreaterThan(5);
  });

  test("get returns a specific key", async () => {
    const deps = makeDeps();
    const handler = createConfigHandler(deps);
    const interaction = makeInteraction({
      userId: "1",
      guildId: "guild1",
      permissionBits: 8n,
      subcommand: "get",
      key: "timezone",
    });
    await handler(interaction as never);
    const call = replyArg(interaction) as { content: string; ephemeral: boolean };
    expect(call.content).toContain("timezone");
    expect(call.content).toContain("UTC");
    expect(call.ephemeral).toBe(true);
  });

  test("get rejects unknown key", async () => {
    const handler = createConfigHandler(makeDeps());
    const interaction = makeInteraction({
      userId: "1",
      guildId: "guild1",
      permissionBits: 8n,
      subcommand: "get",
      key: "nonexistent",
    });
    await handler(interaction as never);
    const call = replyArg(interaction) as { content: string };
    expect(call.content).toContain("Unknown key");
  });

  test("set updates and persists a value", async () => {
    const deps = makeDeps();
    const handler = createConfigHandler(deps);
    const interaction = makeInteraction({
      userId: "1",
      guildId: "guild1",
      permissionBits: 8n,
      subcommand: "set",
      key: "timezone",
      value: "US/Eastern",
    });
    await handler(interaction as never);
    expect(deps.updateGuildConfig).toHaveBeenCalledTimes(1);
    const call = replyArg(interaction) as { content: string; ephemeral: boolean };
    expect(call.content).toContain("timezone");
    expect(call.content).toContain("US/Eastern");
    expect(call.ephemeral).toBe(true);
  });

  test("set rejects invalid value", async () => {
    const deps = makeDeps();
    const handler = createConfigHandler(deps);
    const interaction = makeInteraction({
      userId: "1",
      guildId: "guild1",
      permissionBits: 8n,
      subcommand: "set",
      key: "triggers.randomChance",
      value: "5.0",
    });
    await handler(interaction as never);
    expect(deps.updateGuildConfig).not.toHaveBeenCalled();
    const call = replyArg(interaction) as { content: string };
    expect(call.content).toContain("Invalid");
  });

  test("set works with fallback admin", async () => {
    const deps = makeDeps({ adminUserIds: ["555"] });
    const handler = createConfigHandler(deps);
    const interaction = makeInteraction({
      userId: "555",
      guildId: "guild1",
      permissionBits: null,
      subcommand: "set",
      key: "model",
      value: "anthropic/claude-3.5-sonnet",
    });
    await handler(interaction as never);
    expect(deps.updateGuildConfig).toHaveBeenCalledTimes(1);
    const call = replyArg(interaction) as { content: string };
    expect(call.content).toContain("model");
  });

  test("set keywords trims whitespace from entries", async () => {
    const deps = makeDeps();
    const handler = createConfigHandler(deps);
    const interaction = makeInteraction({
      userId: "1",
      guildId: "guild1",
      permissionBits: 8n,
      subcommand: "set",
      key: "triggers.keywords",
      value: " hello , world ",
    });
    await handler(interaction as never);
    expect(deps.updateGuildConfig).toHaveBeenCalledTimes(1);
    const calls = (deps.updateGuildConfig as ReturnType<typeof mock>).mock.calls;
    const updatedConfig = (calls[0] as unknown[])[1] as GuildConfig;
    expect(updatedConfig.triggers.keywords).toEqual(["hello", "world"]);
  });

  test("set empty keywords clears the list", async () => {
    const deps = makeDeps();
    const handler = createConfigHandler(deps);
    const interaction = makeInteraction({
      userId: "1",
      guildId: "guild1",
      permissionBits: 8n,
      subcommand: "set",
      key: "triggers.keywords",
      value: "",
    });
    await handler(interaction as never);
    const calls = (deps.updateGuildConfig as ReturnType<typeof mock>).mock.calls;
    const updatedConfig = (calls[0] as unknown[])[1] as GuildConfig;
    expect(updatedConfig.triggers.keywords).toEqual([]);
  });

  test("get without key hints user", async () => {
    const handler = createConfigHandler(makeDeps());
    const interaction = makeInteraction({
      userId: "1",
      guildId: "guild1",
      permissionBits: 8n,
      subcommand: "get",
      key: null,
    });
    await handler(interaction as never);
    const call = replyArg(interaction) as { content: string };
    expect(call.content).toContain("key");
  });
});

describe("CONFIGURABLE_KEYS", () => {
  test("contains expected keys", () => {
    expect(CONFIGURABLE_KEYS).toContain("model");
    expect(CONFIGURABLE_KEYS).toContain("timezone");
    expect(CONFIGURABLE_KEYS).toContain("triggers.mention");
    expect(CONFIGURABLE_KEYS).toContain("triggers.keywords");
    expect(CONFIGURABLE_KEYS).toContain("triggers.randomChance");
  });
});
