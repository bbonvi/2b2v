import { describe, test, expect, mock } from "bun:test";
import { MessageFlags } from "discord.js";
import {
  createMemoryWipeHandler,
  memoryWipeCommandDefinition,
  type MemoryWipeDeps,
  type WipeResult,
  type WipeRecentResult,
} from "./memory-wipe.ts";

describe("memoryWipeCommandDefinition", () => {
  test("has correct name and description", () => {
    const json = memoryWipeCommandDefinition.toJSON();
    expect(json.name).toBe("memory-wipe");
    expect(json.description).toContain("Clear");
  });

  test("has recent and confirm options", () => {
    const json = memoryWipeCommandDefinition.toJSON();
    const opts = json.options ?? [];
    expect(opts).toHaveLength(2);

    const recentOpt = opts.find((o) => (o as { name: string }).name === "recent") as {
      name: string;
      type: number;
      required: boolean;
      min_value?: number;
      max_value?: number;
    };
    expect(recentOpt).toBeDefined();
    expect(recentOpt.required).toBe(false);
    expect(recentOpt.min_value).toBe(1);
    expect(recentOpt.max_value).toBe(1000);

    const confirmOpt = opts.find((o) => (o as { name: string }).name === "confirm") as {
      name: string;
      type: number;
      required: boolean;
    };
    expect(confirmOpt).toBeDefined();
    expect(confirmOpt.required).toBe(false);
  });
});

describe("createMemoryWipeHandler", () => {
  function makeDeps(overrides?: Partial<MemoryWipeDeps>): MemoryWipeDeps {
    return {
      wipeGuild: mock(() => Promise.resolve({ memoriesDeleted: 5, messagesDeleted: 10 } satisfies WipeResult)),
      wipeRecent: mock(() => Promise.resolve({ messagesDeleted: 3, imagesDeleted: 1 } satisfies WipeRecentResult)),
      adminUserIds: [],
      ...overrides,
    };
  }

  function makeInteraction(opts: {
    userId: string;
    guildId: string | null;
    channelId?: string | null;
    permissionBits: bigint | null;
    confirmValue?: string | null;
    recentValue?: number | null;
  }) {
    const replyMock = mock(() => Promise.resolve());
    return {
      user: { id: opts.userId },
      guildId: opts.guildId,
      channelId: opts.channelId ?? "channel1",
      memberPermissions: opts.permissionBits !== null ? { bitfield: opts.permissionBits } : null,
      options: {
        getString: (name: string) => {
          if (name === "confirm") return opts.confirmValue ?? null;
          return null;
        },
        getInteger: (name: string) => {
          if (name === "recent") return opts.recentValue ?? null;
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

  test("rejects non-admin", async () => {
    const handler = createMemoryWipeHandler(makeDeps());
    const interaction = makeInteraction({
      userId: "999",
      guildId: "guild1",
      permissionBits: 0n,
      confirmValue: "WIPE",
    });
    await handler(interaction as never);
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const call = replyArg(interaction) as { content: string; flags: number };
    expect(call.content).toBe("Admin access required.");
    expect(call.flags).toBe(MessageFlags.Ephemeral);
  });

  test("rejects when not in a guild", async () => {
    const handler = createMemoryWipeHandler(makeDeps());
    const interaction = makeInteraction({
      userId: "1",
      guildId: null,
      permissionBits: 8n,
      confirmValue: "WIPE",
    });
    await handler(interaction as never);
    const call = replyArg(interaction) as { content: string; flags: number };
    expect(call.content).toBe("This command can only be used in a guild.");
    expect(call.flags).toBe(MessageFlags.Ephemeral);
  });

  test("rejects wrong confirmation string", async () => {
    const deps = makeDeps();
    const handler = createMemoryWipeHandler(deps);
    const interaction = makeInteraction({
      userId: "1",
      guildId: "guild1",
      permissionBits: 8n,
      confirmValue: "wrong",
    });
    await handler(interaction as never);
    const call = replyArg(interaction) as { content: string; flags: number };
    expect(call.content).toContain("WIPE");
    expect(call.flags).toBe(MessageFlags.Ephemeral);
    expect(deps.wipeGuild).not.toHaveBeenCalled();
  });

  test("wipes guild data on correct confirmation", async () => {
    const deps = makeDeps();
    const handler = createMemoryWipeHandler(deps);
    const interaction = makeInteraction({
      userId: "1",
      guildId: "guild1",
      permissionBits: 8n,
      confirmValue: "WIPE",
    });
    await handler(interaction as never);
    expect(deps.wipeGuild).toHaveBeenCalledTimes(1);
    expect(deps.wipeGuild).toHaveBeenCalledWith("guild1");
    const call = replyArg(interaction) as { content: string; flags: number };
    expect(call.content).toContain("5 memories");
    expect(call.content).toContain("10 messages");
    expect(call.flags).toBe(MessageFlags.Ephemeral);
  });

  test("works with fallback admin user", async () => {
    const deps = makeDeps({ adminUserIds: ["555"] });
    const handler = createMemoryWipeHandler(deps);
    const interaction = makeInteraction({
      userId: "555",
      guildId: "guild1",
      permissionBits: null,
      confirmValue: "WIPE",
    });
    await handler(interaction as never);
    expect(deps.wipeGuild).toHaveBeenCalledTimes(1);
    const call = replyArg(interaction) as { content: string };
    expect(call.content).toContain("memories");
  });

  test("handles wipe errors gracefully", async () => {
    const deps = makeDeps({
      wipeGuild: mock(() => Promise.reject(new Error("DB failure"))),
    });
    const handler = createMemoryWipeHandler(deps);
    const interaction = makeInteraction({
      userId: "1",
      guildId: "guild1",
      permissionBits: 8n,
      confirmValue: "WIPE",
    });
    await handler(interaction as never);
    const call = replyArg(interaction) as { content: string; flags: number };
    expect(call.content).toContain("failed");
    expect(call.flags).toBe(MessageFlags.Ephemeral);
  });

  test("recent mode deletes messages without confirmation", async () => {
    const deps = makeDeps();
    const handler = createMemoryWipeHandler(deps);
    const interaction = makeInteraction({
      userId: "1",
      guildId: "guild1",
      permissionBits: 8n,
      recentValue: 5,
    });
    await handler(interaction as never);

    expect(deps.wipeRecent).toHaveBeenCalledTimes(1);
    expect(deps.wipeRecent).toHaveBeenCalledWith("guild1", "channel1", 5);
    expect(deps.wipeGuild).not.toHaveBeenCalled();

    const call = replyArg(interaction) as { content: string; flags: number };
    expect(call.content).toContain("3 messages");
    expect(call.content).toContain("1 images");
    expect(call.flags).toBe(MessageFlags.Ephemeral);
  });

  test("recent mode rejects non-admin", async () => {
    const deps = makeDeps();
    const handler = createMemoryWipeHandler(deps);
    const interaction = makeInteraction({
      userId: "999",
      guildId: "guild1",
      permissionBits: 0n,
      recentValue: 5,
    });
    await handler(interaction as never);

    expect(deps.wipeRecent).not.toHaveBeenCalled();
    const call = replyArg(interaction) as { content: string };
    expect(call.content).toBe("Admin access required.");
  });

  test("recent mode handles errors gracefully", async () => {
    const deps = makeDeps({
      wipeRecent: mock(() => Promise.reject(new Error("DB failure"))),
    });
    const handler = createMemoryWipeHandler(deps);
    const interaction = makeInteraction({
      userId: "1",
      guildId: "guild1",
      permissionBits: 8n,
      recentValue: 10,
    });
    await handler(interaction as never);

    const call = replyArg(interaction) as { content: string; flags: number };
    expect(call.content).toContain("Recent wipe failed");
    expect(call.flags).toBe(MessageFlags.Ephemeral);
  });
});
