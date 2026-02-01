import { describe, test, expect, mock } from "bun:test";
import {
  createMemoryWipeHandler,
  memoryWipeCommandDefinition,
  type MemoryWipeDeps,
  type WipeResult,
} from "./memory-wipe.ts";

describe("memoryWipeCommandDefinition", () => {
  test("has correct name and description", () => {
    const json = memoryWipeCommandDefinition.toJSON();
    expect(json.name).toBe("memory-wipe");
    expect(json.description).toContain("Clear");
  });

  test("has confirm option", () => {
    const json = memoryWipeCommandDefinition.toJSON();
    const opts = json.options ?? [];
    expect(opts).toHaveLength(1);
    const opt = opts[0] as { name: string; type: number; required: boolean };
    expect(opt.name).toBe("confirm");
    expect(opt.required).toBe(true);
  });
});

describe("createMemoryWipeHandler", () => {
  function makeDeps(overrides?: Partial<MemoryWipeDeps>): MemoryWipeDeps {
    return {
      wipeGuild: mock(() => Promise.resolve({ memoriesDeleted: 5, messagesDeleted: 10 } satisfies WipeResult)),
      adminUserIds: [],
      ...overrides,
    };
  }

  function makeInteraction(opts: {
    userId: string;
    guildId: string | null;
    permissionBits: bigint | null;
    confirmValue: string;
  }) {
    const replyMock = mock(() => Promise.resolve());
    return {
      user: { id: opts.userId },
      guildId: opts.guildId,
      memberPermissions: opts.permissionBits !== null ? { bitfield: opts.permissionBits } : null,
      options: {
        getString: (name: string) => {
          if (name === "confirm") return opts.confirmValue;
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
    const call = replyArg(interaction) as { content: string; ephemeral: boolean };
    expect(call.content).toBe("Admin access required.");
    expect(call.ephemeral).toBe(true);
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
    const call = replyArg(interaction) as { content: string; ephemeral: boolean };
    expect(call.content).toBe("This command can only be used in a guild.");
    expect(call.ephemeral).toBe(true);
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
    const call = replyArg(interaction) as { content: string; ephemeral: boolean };
    expect(call.content).toContain("WIPE");
    expect(call.ephemeral).toBe(true);
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
    const call = replyArg(interaction) as { content: string; ephemeral: boolean };
    expect(call.content).toContain("5 memories");
    expect(call.content).toContain("10 messages");
    expect(call.ephemeral).toBe(true);
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
    const call = replyArg(interaction) as { content: string; ephemeral: boolean };
    expect(call.content).toContain("failed");
    expect(call.ephemeral).toBe(true);
  });
});
