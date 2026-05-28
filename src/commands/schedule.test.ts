import { describe, test, expect, mock } from "bun:test";
import {
  scheduleCommandDefinition,
  createScheduleHandler,
  formatScheduleRow,
  formatScheduleList,
  type ScheduleCommandDeps,
} from "./schedule.ts";
import type { ScheduleRow } from "../db/schedule-repository.ts";

type ReplyFn = ReturnType<typeof mock>;

function makeInteraction(overrides: {
  subcommand: string;
  guildId?: string | null;
  isAdmin?: boolean;
  options?: Record<string, string | number | null>;
}): { reply: ReplyFn; followUp: ReplyFn } {
  const opts: Record<string, string | number | null> = overrides.options ?? {};
  const replyFn: ReplyFn = mock(() => Promise.resolve());
  const followUpFn: ReplyFn = mock(() => Promise.resolve());
  return {
    guildId: "guildId" in overrides ? overrides.guildId : "guild-1",
    channelId: "default-ch",
    user: { id: "user-1" },
    memberPermissions: {
      bitfield: overrides.isAdmin !== false ? BigInt(0x8) : BigInt(0),
    },
    options: {
      getSubcommand: () => overrides.subcommand,
      getString: (key: string) => {
        const val = opts[key];
        return typeof val === "string" ? val : null;
      },
      getInteger: (key: string) => {
        const val = opts[key];
        return typeof val === "number" ? val : null;
      },
    },
    reply: replyFn,
    followUp: followUpFn,
  } as unknown as { reply: ReplyFn; followUp: ReplyFn };
}

function makeDeps(overrides?: Partial<ScheduleCommandDeps>): ScheduleCommandDeps {
  return {
    listSchedules: overrides?.listSchedules ?? mock(() => []),
    createSchedule: overrides?.createSchedule ?? mock(() => "new-id"),
    deleteSchedule: overrides?.deleteSchedule ?? mock(() => true),
    onScheduleCreated: overrides?.onScheduleCreated ?? mock(() => {}),
    onScheduleRemoved: overrides?.onScheduleRemoved ?? mock(() => {}),
    adminUserIds: overrides?.adminUserIds ?? [],
    getGuildTimezone: overrides?.getGuildTimezone ?? mock(() => "America/New_York"),
  };
}

function makeScheduleRow(overrides?: Partial<ScheduleRow>): ScheduleRow {
  return {
    id: "sched-1",
    guildId: "guild-1",
    channelId: "ch-1",
    source: "admin",
    type: "cron",
    cronExpression: "0 9 * * *",
    runAt: null,
    timezone: "UTC",
    messageContent: "Good morning!",
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function replyText(interaction: { reply: ReplyFn }): string {
  return JSON.stringify(interaction.reply.mock.calls[0]);
}

describe("scheduleCommandDefinition", () => {
  test("has correct name and subcommands", () => {
    const json = scheduleCommandDefinition.toJSON();
    expect(json.name).toBe("schedule");
    const subNames = (json.options ?? []).map((o: { name: string }) => o.name);
    expect(subNames).toContain("list");
    expect(subNames).toContain("add");
    expect(subNames).toContain("remove");
  });
});

describe("formatScheduleRow", () => {
  test("formats cron schedule", () => {
    const row = makeScheduleRow();
    const result = formatScheduleRow(row);
    expect(result).toContain("sched-1");
    expect(result).toContain("cron");
    expect(result).toContain("0 9 * * *");
    expect(result).toContain("Good morning!");
  });

  test("formats future one-off schedule", () => {
    const futureMs = Date.now() + 86_400_000;
    const row = makeScheduleRow({
      type: "one_off",
      cronExpression: null,
      runAt: futureMs,
    });
    const result = formatScheduleRow(row);
    expect(result).toContain("one_off");
    expect(result).toContain("<t:");
    expect(result).not.toContain("[past]");
  });

  test("marks past one-off schedule with [past]", () => {
    const pastMs = Date.now() - 86_400_000;
    const row = makeScheduleRow({
      type: "one_off",
      cronExpression: null,
      runAt: pastMs,
    });
    const result = formatScheduleRow(row);
    expect(result).toContain("[past]");
  });

  test("marks disabled schedules", () => {
    const row = makeScheduleRow({ enabled: false });
    const result = formatScheduleRow(row);
    expect(result).toContain("⏸");
  });

  test("truncates long message content", () => {
    const longMsg = "A".repeat(200);
    const row = makeScheduleRow({ messageContent: longMsg });
    const result = formatScheduleRow(row);
    expect(result.length).toBeLessThan(300);
    expect(result).toContain("…");
  });
});

describe("formatScheduleList", () => {
  test("each chunk fits within 2000 chars", () => {
    const schedules = Array.from({ length: 30 }, (_, i) =>
      makeScheduleRow({
        id: `sched-${i}`,
        messageContent: `Message content for schedule number ${i} with some padding text here`,
      })
    );
    const chunks = formatScheduleList(schedules);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    // all schedule IDs should appear across chunks
    for (let i = 0; i < 30; i++) {
      const found = chunks.some((c) => c.includes(`sched-${i}`));
      expect(found).toBe(true);
    }
  });

  test("returns single chunk for small list", () => {
    const schedules = [
      makeScheduleRow({ id: "s1" }),
      makeScheduleRow({ id: "s2" }),
    ];
    const chunks = formatScheduleList(schedules);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("s1");
    expect(chunks[0]).toContain("s2");
  });

  test("returns empty array for no schedules", () => {
    expect(formatScheduleList([])).toEqual([]);
  });

  test("sorts: enabled before disabled, recent before old", () => {
    const now = Date.now();
    const schedules = [
      makeScheduleRow({ id: "old-disabled", enabled: false, createdAt: now - 100000 }),
      makeScheduleRow({ id: "new-enabled", enabled: true, createdAt: now }),
      makeScheduleRow({ id: "old-enabled", enabled: true, createdAt: now - 50000 }),
    ];
    const chunks = formatScheduleList(schedules);
    const text = chunks.join("\n");
    const posNew = text.indexOf("new-enabled");
    const posOldEnabled = text.indexOf("old-enabled");
    const posOldDisabled = text.indexOf("old-disabled");
    // enabled schedules appear before disabled
    expect(posNew).toBeLessThan(posOldDisabled);
    expect(posOldEnabled).toBeLessThan(posOldDisabled);
  });
});

describe("createScheduleHandler", () => {
  test("rejects non-admin", async () => {
    const deps = makeDeps();
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({ subcommand: "list", isAdmin: false });
    await handler(interaction as never);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Admin access required." })
    );
  });

  test("rejects outside guild", async () => {
    const deps = makeDeps();
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({ subcommand: "list", guildId: null });
    await handler(interaction as never);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "This command can only be used in a guild." })
    );
  });

  test("list returns all guild schedules", async () => {
    const schedules = [
      makeScheduleRow({ id: "s1", source: "admin" }),
      makeScheduleRow({ id: "s2", source: "bot" }),
      makeScheduleRow({ id: "s3", source: "tool" }),
    ];
    const deps = makeDeps({ listSchedules: mock(() => schedules) });
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({ subcommand: "list" });
    await handler(interaction as never);
    expect(interaction.reply).toHaveBeenCalled();
    const text = replyText(interaction);
    expect(text).toContain("s1");
    expect(text).toContain("s2");
    expect(text).toContain("s3");
  });

  test("list uses followUp for large schedule lists", async () => {
    const schedules = Array.from({ length: 30 }, (_, i) =>
      makeScheduleRow({
        id: `sched-${i}`,
        messageContent: `Scheduled message content number ${i} with some extra padding text`,
      })
    );
    const deps = makeDeps({ listSchedules: mock(() => schedules) });
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({ subcommand: "list" });
    await handler(interaction as never);
    expect(interaction.reply).toHaveBeenCalled();
    // first reply must be <=2000 chars
    const firstReply = (interaction.reply.mock.calls[0] as unknown as [{ content: string }])[0];
    expect(firstReply.content.length).toBeLessThanOrEqual(2000);
    // followUp called for remaining chunks
    expect(interaction.followUp.mock.calls.length).toBeGreaterThan(0);
    for (const call of interaction.followUp.mock.calls) {
      const arg = (call as unknown as [{ content: string }])[0];
      expect(arg.content.length).toBeLessThanOrEqual(2000);
    }
  });

  test("list shows empty message when no schedules", async () => {
    const deps = makeDeps({ listSchedules: mock(() => []) });
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({ subcommand: "list" });
    await handler(interaction as never);
    expect(replyText(interaction).toLowerCase()).toContain("no schedules");
  });

  test("add creates cron schedule with explicit timezone", async () => {
    const createFn = mock(() => "new-cron-id");
    const onCreated = mock(() => {});
    const deps = makeDeps({ createSchedule: createFn, onScheduleCreated: onCreated });
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({
      subcommand: "add",
      options: {
        type: "cron",
        cron: "0 9 * * *",
        channel: "ch-99",
        message: "Hello!",
        timezone: "Europe/London",
      },
    });
    await handler(interaction as never);
    expect(createFn).toHaveBeenCalled();
    const args = createFn.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(args[0]).toMatchObject({
      guildId: "guild-1",
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "Europe/London",
    });
    expect(onCreated).toHaveBeenCalledWith("new-cron-id");
    // Response includes effective timezone
    const text = replyText(interaction);
    expect(text).toContain("Europe/London");
  });

  test("add cron defaults timezone to guild timezone", async () => {
    const createFn = mock(() => "cron-guild-tz");
    const deps = makeDeps({
      createSchedule: createFn,
      getGuildTimezone: mock(() => "Europe/Berlin"),
    });
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({
      subcommand: "add",
      options: {
        type: "cron",
        cron: "0 9 * * *",
        channel: "ch-99",
        message: "Guten Morgen!",
      },
    });
    await handler(interaction as never);
    const args = createFn.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(args[0]).toMatchObject({ timezone: "Europe/Berlin" });
    expect(replyText(interaction)).toContain("Europe/Berlin");
  });

  test("add creates one-off schedule with local format", async () => {
    const createFn = mock(() => "new-oneoff-id");
    const deps = makeDeps({
      createSchedule: createFn,
      getGuildTimezone: mock(() => "America/New_York"),
    });
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({
      subcommand: "add",
      options: {
        type: "one_off",
        "run-at": "2026-06-15 10:00",
        channel: "ch-99",
        message: "Reminder!",
      },
    });
    await handler(interaction as never);
    expect(createFn).toHaveBeenCalled();
    const args = createFn.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(args[0]).toMatchObject({ type: "one_off", timezone: "America/New_York" });
    expect(typeof args[0].runAt).toBe("number");
    // Response includes local time and timezone
    const text = replyText(interaction);
    expect(text).toContain("2026-06-15 10:00");
    expect(text).toContain("America/New_York");
  });

  test("add one_off rejects ISO 8601 with Z suffix", async () => {
    const deps = makeDeps();
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({
      subcommand: "add",
      options: {
        type: "one_off",
        "run-at": "2026-06-15T10:00:00Z",
        channel: "ch-1",
        message: "bad",
      },
    });
    await handler(interaction as never);
    const text = replyText(interaction);
    expect(text).toContain("YYYY-MM-DD HH:mm");
  });

  test("add one_off rejects ISO 8601 with offset", async () => {
    const deps = makeDeps();
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({
      subcommand: "add",
      options: {
        type: "one_off",
        "run-at": "2026-06-15T10:00:00+05:00",
        channel: "ch-1",
        message: "bad",
      },
    });
    await handler(interaction as never);
    const text = replyText(interaction);
    expect(text).toContain("YYYY-MM-DD HH:mm");
  });

  test("add one_off ignores timezone option and uses guild timezone", async () => {
    const createFn = mock(() => "oneoff-guild-tz");
    const deps = makeDeps({
      createSchedule: createFn,
      getGuildTimezone: mock(() => "Asia/Tokyo"),
    });
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({
      subcommand: "add",
      options: {
        type: "one_off",
        "run-at": "2026-06-15 10:00",
        channel: "ch-1",
        message: "test",
        timezone: "Europe/London", // should be ignored for one_off
      },
    });
    await handler(interaction as never);
    const args = createFn.mock.calls[0] as unknown as [Record<string, unknown>];
    // timezone should be guild timezone, not the explicit option
    expect(args[0]).toMatchObject({ timezone: "Asia/Tokyo" });
  });

  test("add rejects cron without expression", async () => {
    const deps = makeDeps();
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({
      subcommand: "add",
      options: { type: "cron", channel: "ch-1", message: "Hello!" },
    });
    await handler(interaction as never);
    expect(replyText(interaction)).toContain("cron");
  });

  test("add rejects one_off without run-at", async () => {
    const deps = makeDeps();
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({
      subcommand: "add",
      options: { type: "one_off", channel: "ch-1", message: "Hello!" },
    });
    await handler(interaction as never);
    expect(replyText(interaction)).toContain("run-at");
  });

  test("add rejects missing message", async () => {
    const deps = makeDeps();
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({
      subcommand: "add",
      options: { type: "cron", cron: "0 9 * * *", channel: "ch-1" },
    });
    await handler(interaction as never);
    expect(replyText(interaction).toLowerCase()).toContain("message");
  });

  test("remove deletes schedule and notifies engine", async () => {
    const deleteFn = mock(() => true);
    const onRemoved = mock(() => {});
    const deps = makeDeps({ deleteSchedule: deleteFn, onScheduleRemoved: onRemoved });
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({
      subcommand: "remove",
      options: { id: "sched-1" },
    });
    await handler(interaction as never);
    expect(deleteFn).toHaveBeenCalledWith("sched-1", "guild-1");
    expect(onRemoved).toHaveBeenCalledWith("sched-1");
    expect(replyText(interaction)).toContain("sched-1");
  });

  test("remove reports not found", async () => {
    const deps = makeDeps({ deleteSchedule: mock(() => false) });
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({
      subcommand: "remove",
      options: { id: "nonexistent" },
    });
    await handler(interaction as never);
    expect(replyText(interaction).toLowerCase()).toContain("not found");
  });

  test("remove rejects missing id", async () => {
    const deps = makeDeps();
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({ subcommand: "remove" });
    await handler(interaction as never);
    expect(replyText(interaction).toLowerCase()).toContain("id");
  });

  test("fallback admin via adminUserIds", async () => {
    const deps = makeDeps({
      adminUserIds: ["user-1"],
      listSchedules: mock(() => []),
    });
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({ subcommand: "list", isAdmin: false });
    await handler(interaction as never);
    expect(replyText(interaction).toLowerCase()).toContain("no schedules");
  });
});
