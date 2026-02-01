import { describe, test, expect, mock } from "bun:test";
import {
  scheduleCommandDefinition,
  createScheduleHandler,
  formatScheduleRow,
  type ScheduleCommandDeps,
} from "./schedule.ts";
import type { ScheduleRow } from "../db/schedule-repository.ts";

type ReplyFn = ReturnType<typeof mock>;

function makeInteraction(overrides: {
  subcommand: string;
  guildId?: string | null;
  isAdmin?: boolean;
  options?: Record<string, string | number | null>;
}): { reply: ReplyFn } {
  const opts: Record<string, string | number | null> = overrides.options ?? {};
  const replyFn: ReplyFn = mock(() => Promise.resolve());
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
  } as unknown as { reply: ReplyFn };
}

function makeDeps(overrides?: Partial<ScheduleCommandDeps>): ScheduleCommandDeps {
  return {
    listSchedules: overrides?.listSchedules ?? mock(() => []),
    createSchedule: overrides?.createSchedule ?? mock(() => "new-id"),
    deleteSchedule: overrides?.deleteSchedule ?? mock(() => true),
    onScheduleCreated: overrides?.onScheduleCreated ?? mock(() => {}),
    onScheduleRemoved: overrides?.onScheduleRemoved ?? mock(() => {}),
    adminUserIds: overrides?.adminUserIds ?? [],
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

  test("formats one-off schedule", () => {
    const row = makeScheduleRow({
      type: "one_off",
      cronExpression: null,
      runAt: 1700000000000,
    });
    const result = formatScheduleRow(row);
    expect(result).toContain("one_off");
    expect(result).toContain("2023-");
  });

  test("marks disabled schedules", () => {
    const row = makeScheduleRow({ enabled: false });
    const result = formatScheduleRow(row);
    expect(result).toContain("disabled");
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

  test("list shows empty message when no schedules", async () => {
    const deps = makeDeps({ listSchedules: mock(() => []) });
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({ subcommand: "list" });
    await handler(interaction as never);
    expect(replyText(interaction).toLowerCase()).toContain("no schedules");
  });

  test("add creates cron schedule", async () => {
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
        timezone: "America/New_York",
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
    });
    expect(onCreated).toHaveBeenCalledWith("new-cron-id");
  });

  test("add creates one-off schedule", async () => {
    const createFn = mock(() => "new-oneoff-id");
    const deps = makeDeps({ createSchedule: createFn });
    const handler = createScheduleHandler(deps);
    const interaction = makeInteraction({
      subcommand: "add",
      options: {
        type: "one_off",
        "run-at": "2025-06-15T10:00:00Z",
        channel: "ch-99",
        message: "Reminder!",
      },
    });
    await handler(interaction as never);
    expect(createFn).toHaveBeenCalled();
    const args = createFn.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(args[0]).toMatchObject({ type: "one_off" });
    expect(typeof args[0].runAt).toBe("number");
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
    expect(deleteFn).toHaveBeenCalledWith("sched-1");
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
