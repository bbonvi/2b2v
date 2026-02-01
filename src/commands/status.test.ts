import { describe, test, expect, mock } from "bun:test";
import {
  formatUptime,
  buildStatusEmbed,
  createStatusHandler,
  type StatusStats,
  type StatusCommandDeps,
} from "./status.ts";

describe("formatUptime", () => {
  test("formats seconds only", () => {
    expect(formatUptime(5_000)).toBe("5s");
  });

  test("formats minutes and seconds", () => {
    expect(formatUptime(125_000)).toBe("2m 5s");
  });

  test("formats hours, minutes, seconds", () => {
    expect(formatUptime(3_661_000)).toBe("1h 1m 1s");
  });

  test("formats days", () => {
    expect(formatUptime(90_061_000)).toBe("1d 1h 1m 1s");
  });

  test("handles zero", () => {
    expect(formatUptime(0)).toBe("0s");
  });
});

describe("buildStatusEmbed", () => {
  test("includes uptime and guild count", () => {
    const stats: StatusStats = { uptimeMs: 60_000, guildCount: 2 };
    const embed = buildStatusEmbed(stats);
    expect(embed.title).toBe("Bot Status");
    expect(embed.fields).toHaveLength(2);
    expect(embed.fields[0]).toEqual({ name: "Uptime", value: "1m 0s", inline: true });
    expect(embed.fields[1]).toEqual({ name: "Guilds", value: "2", inline: true });
  });

  test("includes optional stats when provided", () => {
    const stats: StatusStats = {
      uptimeMs: 1000,
      guildCount: 1,
      messageCount: 42,
      memoryCount: 7,
      scheduleCount: 3,
    };
    const embed = buildStatusEmbed(stats);
    expect(embed.fields).toHaveLength(5);
    expect(embed.fields[2]).toEqual({ name: "Messages", value: "42", inline: true });
    expect(embed.fields[3]).toEqual({ name: "Memories", value: "7", inline: true });
    expect(embed.fields[4]).toEqual({ name: "Schedules", value: "3", inline: true });
  });

  test("omits optional stats when undefined", () => {
    const stats: StatusStats = { uptimeMs: 0, guildCount: 0 };
    const embed = buildStatusEmbed(stats);
    expect(embed.fields).toHaveLength(2);
  });
});

describe("createStatusHandler", () => {
  function makeDeps(overrides?: Partial<StatusCommandDeps>): StatusCommandDeps {
    return {
      getStats: () => ({ uptimeMs: 60_000, guildCount: 2 }),
      adminUserIds: [],
      ...overrides,
    };
  }

  function makeInteraction(opts: {
    userId: string;
    permissionBits: bigint | null;
  }) {
    const replyMock = mock(() => Promise.resolve());
    return {
      user: { id: opts.userId },
      memberPermissions: opts.permissionBits !== null ? { bitfield: opts.permissionBits } : null,
      reply: replyMock,
    };
  }

  /** Extract the first argument to the first call of reply mock. */
  function replyArg(interaction: { reply: ReturnType<typeof mock> }): unknown {
    const calls = (interaction.reply as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const firstCall = calls[0] as unknown[];
    return firstCall[0];
  }

  test("rejects non-admin with ephemeral message", async () => {
    const handler = createStatusHandler(makeDeps());
    const interaction = makeInteraction({ userId: "999", permissionBits: 0n });
    await handler(interaction as never);
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const call = replyArg(interaction) as { content: string; ephemeral: boolean };
    expect(call.content).toBe("Admin access required.");
    expect(call.ephemeral).toBe(true);
  });

  test("responds with embed for admin user (Discord permissions)", async () => {
    const handler = createStatusHandler(makeDeps());
    const interaction = makeInteraction({ userId: "123", permissionBits: 8n });
    await handler(interaction as never);
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const call = replyArg(interaction) as { embeds: unknown[]; ephemeral: boolean };
    expect(call.ephemeral).toBe(true);
    expect(call.embeds).toHaveLength(1);
  });

  test("responds with embed for fallback admin user", async () => {
    const handler = createStatusHandler(makeDeps({ adminUserIds: ["555"] }));
    const interaction = makeInteraction({ userId: "555", permissionBits: null });
    await handler(interaction as never);
    const call = replyArg(interaction) as { embeds: unknown[]; ephemeral: boolean };
    expect(call.embeds).toHaveLength(1);
  });

  test("calls getStats and passes result to embed", async () => {
    const getStats = mock(() => ({
      uptimeMs: 90_061_000,
      guildCount: 3,
      messageCount: 100,
    }));
    const handler = createStatusHandler(makeDeps({ getStats }));
    const interaction = makeInteraction({ userId: "1", permissionBits: 8n });
    await handler(interaction as never);
    expect(getStats).toHaveBeenCalledTimes(1);
    const call = replyArg(interaction) as { embeds: Array<{ fields: Array<{ value: string }> }> };
    const embed = call.embeds[0] as { fields: Array<{ value: string }> };
    expect((embed.fields[0] as { value: string }).value).toBe("1d 1h 1m 1s");
    expect((embed.fields[1] as { value: string }).value).toBe("3");
    expect((embed.fields[2] as { value: string }).value).toBe("100");
  });
});
