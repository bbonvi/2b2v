import { test, expect, describe, beforeEach } from "bun:test";
import { createDatabase, type Database } from "../db/database";
import { createSchedule, getSchedule, listSchedules } from "../db/schedule-repository";
import {
  createDeleteScheduledMessageTool,
  createListScheduledMessagesTool,
  createScheduleTool,
  createScheduleTools,
  type ScheduleToolDeps,
} from "./schedule-tool";
import type { AgentTool } from "@mariozechner/pi-agent-core";

describe("createScheduleTool (schedule_message)", () => {
  let db: Database;
  let tool: AgentTool;
  let registeredIds: string[];

  beforeEach(() => {
    db = createDatabase(":memory:");
    registeredIds = [];

    const deps: ScheduleToolDeps = {
      db,
      guildId: "guild-1",
      channelId: "ch-1",
      timezone: "America/New_York",
      onScheduleCreated: (id) => registeredIds.push(id),
    };
    tool = createScheduleTool(deps);
  });

  test("has correct label", () => {
    expect(tool.label).toBe("schedule_message");
  });

  test("createScheduleTools exposes create, list, and delete tools", () => {
    const tools = createScheduleTools({
      db,
      guildId: "guild-1",
      channelId: "ch-1",
      timezone: "America/New_York",
    });
    expect(tools.map((t) => t.name)).toEqual([
      "schedule_message",
      "list_scheduled_messages",
      "delete_scheduled_message",
    ]);
  });

  // --- mode: "in" (relative) ---

  test("creates a one-off schedule from relative time (mode: in)", async () => {
    const before = Date.now();
    const result = await tool.execute(
      "call-1",
      { mode: "in", amount: 30, unit: "minutes", instructions: "Check back later" },
      new AbortController().signal,
      () => {}
    );

    const schedules = listSchedules(db, { guildId: "guild-1" });
    expect(schedules).toHaveLength(1);

    const s = schedules[0];
    if (s === undefined) throw new Error("unreachable");
    expect(s.type).toBe("one_off");
    expect(s.source).toBe("tool");
    expect(s.channelId).toBe("ch-1");
    expect(s.timezone).toBe("America/New_York");
    expect(s.messageContent).toBe("Check back later");
    expect(s.enabled).toBe(true);
    // runAt should be ~30 min from now
    expect(s.runAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(s.runAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 1000);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Scheduled");
    // Response should use local wall-clock format, not ISO Z
    expect(text).not.toContain("Z");
    expect(text).toContain("America/New_York");
  });

  test("defaults to mode: in when mode is omitted", async () => {
    const result = await tool.execute(
      "c-default",
      { amount: 10, unit: "minutes", instructions: "implicit in mode" },
      new AbortController().signal,
      () => {}
    );
    const schedules = listSchedules(db, { guildId: "guild-1" });
    expect(schedules).toHaveLength(1);
    expect((result.content[0] as { text: string }).text).toContain("Scheduled");
  });

  test("supports seconds unit", async () => {
    await tool.execute("c2", { mode: "in", amount: 45, unit: "seconds", instructions: "ping" }, new AbortController().signal, () => {});
    const s = listSchedules(db, { guildId: "guild-1" })[0];
    if (s === undefined) throw new Error("unreachable");
    expect(s.runAt).toBeGreaterThan(Date.now() + 40_000);
    expect(s.runAt).toBeLessThan(Date.now() + 50_000);
  });

  test("supports hours unit", async () => {
    await tool.execute("c3", { mode: "in", amount: 2, unit: "hours", instructions: "reminder" }, new AbortController().signal, () => {});
    const s = listSchedules(db, { guildId: "guild-1" })[0];
    if (s === undefined) throw new Error("unreachable");
    expect(s.runAt).toBeGreaterThan(Date.now() + 2 * 3600_000 - 1000);
  });

  test("calls onScheduleCreated callback with new schedule ID", async () => {
    await tool.execute("c4", { mode: "in", amount: 10, unit: "minutes", instructions: "test" }, new AbortController().signal, () => {});
    expect(registeredIds).toHaveLength(1);
    const s = listSchedules(db, { guildId: "guild-1" })[0];
    if (s === undefined) throw new Error("unreachable");
    expect(registeredIds[0]).toBe(s.id);
  });

  test("rejects zero or negative amount", async () => {
    const result = await tool.execute("c5", { mode: "in", amount: 0, unit: "minutes", instructions: "bad" }, new AbortController().signal, () => {});
    expect((result.content[0] as { text: string }).text).toContain("positive");
    expect(listSchedules(db, { guildId: "guild-1" })).toHaveLength(0);
  });

  test("rejects invalid unit", async () => {
    const result = await tool.execute("c6", { mode: "in", amount: 5, unit: "days", instructions: "bad" }, new AbortController().signal, () => {});
    expect((result.content[0] as { text: string }).text).toContain("seconds, minutes, or hours");
    expect(listSchedules(db, { guildId: "guild-1" })).toHaveLength(0);
  });

  test("rejects mode: in with missing amount/unit", async () => {
    const result = await tool.execute("c-missing", { mode: "in", instructions: "bad" }, new AbortController().signal, () => {});
    expect((result.content[0] as { text: string }).text).toContain("requires amount and unit");
    expect(listSchedules(db, { guildId: "guild-1" })).toHaveLength(0);
  });

  test("rejects mode: at with missing localDateTime", async () => {
    const result = await tool.execute("c-missing-dt", { mode: "at", instructions: "bad" }, new AbortController().signal, () => {});
    expect((result.content[0] as { text: string }).text).toContain("requires localDateTime");
    expect(listSchedules(db, { guildId: "guild-1" })).toHaveLength(0);
  });

  // --- mode: "at" (absolute local datetime) ---

  test("creates a one-off schedule from absolute local datetime (mode: at)", async () => {
    // 2026-06-15 10:00 in America/New_York = 2026-06-15 14:00 UTC (EDT)
    const result = await tool.execute(
      "c-at-1",
      { mode: "at", localDateTime: "2026-06-15 10:00", instructions: "Absolute reminder" },
      new AbortController().signal,
      () => {}
    );

    const schedules = listSchedules(db, { guildId: "guild-1" });
    expect(schedules).toHaveLength(1);

    const s = schedules[0];
    if (s === undefined) throw new Error("unreachable");
    expect(s.type).toBe("one_off");
    expect(s.source).toBe("tool");
    expect(s.runAt).toBe(Date.UTC(2026, 5, 15, 14, 0, 0)); // EDT = UTC-4

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("2026-06-15 10:00");
    expect(text).toContain("America/New_York");
  });

  test("mode: at rejects invalid format", async () => {
    const result = await tool.execute(
      "c-at-bad",
      { mode: "at", localDateTime: "2026-06-15T10:00:00Z", instructions: "bad" },
      new AbortController().signal,
      () => {}
    );
    expect((result.content[0] as { text: string }).text).toContain("YYYY-MM-DD HH:mm");
    expect(listSchedules(db, { guildId: "guild-1" })).toHaveLength(0);
  });

  test("mode: at rejects DST nonexistent time", async () => {
    // 2026-03-08 02:30 doesn't exist in America/New_York (spring forward)
    const result = await tool.execute(
      "c-at-dst",
      { mode: "at", localDateTime: "2026-03-08 02:30", instructions: "bad" },
      new AbortController().signal,
      () => {}
    );
    const text = (result.content[0] as { text: string }).text.toLowerCase();
    expect(text).toContain("nonexistent");
    expect(listSchedules(db, { guildId: "guild-1" })).toHaveLength(0);
  });

  test("mode: at rejects DST ambiguous time", async () => {
    // 2026-11-01 01:30 is ambiguous in America/New_York (fall back)
    const result = await tool.execute(
      "c-at-ambig",
      { mode: "at", localDateTime: "2026-11-01 01:30", instructions: "bad" },
      new AbortController().signal,
      () => {}
    );
    const text = (result.content[0] as { text: string }).text.toLowerCase();
    expect(text).toContain("ambiguous");
    expect(listSchedules(db, { guildId: "guild-1" })).toHaveLength(0);
  });

  test("mode: at rejects time in the past", async () => {
    const result = await tool.execute(
      "c-at-past",
      { mode: "at", localDateTime: "2020-01-01 00:00", instructions: "bad" },
      new AbortController().signal,
      () => {}
    );
    const text = (result.content[0] as { text: string }).text.toLowerCase();
    expect(text).toContain("past");
    expect(listSchedules(db, { guildId: "guild-1" })).toHaveLength(0);
  });

  test("mode: at calls onScheduleCreated callback", async () => {
    await tool.execute(
      "c-at-cb",
      { mode: "at", localDateTime: "2026-06-15 10:00", instructions: "future" },
      new AbortController().signal,
      () => {}
    );
    expect(registeredIds).toHaveLength(1);
  });

  test("creates a recurring schedule from cron expression (mode: cron)", async () => {
    const result = await tool.execute(
      "c-cron-1",
      { mode: "cron", cronExpression: "0 9 * * *", instructions: "Say good morning" },
      new AbortController().signal,
      () => {}
    );

    const schedules = listSchedules(db, { guildId: "guild-1" });
    expect(schedules).toHaveLength(1);

    const s = schedules[0];
    if (s === undefined) throw new Error("unreachable");
    expect(s.type).toBe("cron");
    expect(s.source).toBe("tool");
    expect(s.channelId).toBe("ch-1");
    expect(s.timezone).toBe("America/New_York");
    expect(s.cronExpression).toBe("0 9 * * *");
    expect(s.runAt).toBeNull();
    expect(s.messageContent).toBe("Say good morning");
    expect(s.enabled).toBe(true);
    expect(registeredIds).toEqual([s.id]);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("recurring");
    expect(text).toContain("0 9 * * *");
    expect(text).toContain("America/New_York");
  });

  test("mode: cron rejects missing cronExpression", async () => {
    const result = await tool.execute(
      "c-cron-missing",
      { mode: "cron", instructions: "bad" },
      new AbortController().signal,
      () => {}
    );
    expect((result.content[0] as { text: string }).text).toContain("cronExpression");
    expect(listSchedules(db, { guildId: "guild-1" })).toHaveLength(0);
  });

  test("mode: cron rejects invalid cronExpression", async () => {
    const result = await tool.execute(
      "c-cron-invalid",
      { mode: "cron", cronExpression: "not a cron", instructions: "bad" },
      new AbortController().signal,
      () => {}
    );
    expect((result.content[0] as { text: string }).text).toContain("Invalid cronExpression");
    expect(listSchedules(db, { guildId: "guild-1" })).toHaveLength(0);
  });
});

describe("schedule list/delete tools", () => {
  let db: Database;
  let deletedIds: string[];
  let deps: ScheduleToolDeps;

  beforeEach(() => {
    db = createDatabase(":memory:");
    deletedIds = [];
    deps = {
      db,
      guildId: "guild-1",
      channelId: "ch-1",
      timezone: "UTC",
      onScheduleDeleted: (id) => deletedIds.push(id),
    };
  });

  test("list_scheduled_messages lists only pending schedules in the current channel and guild", async () => {
    const currentId = createSchedule(db, {
      guildId: "guild-1",
      channelId: "ch-1",
      source: "tool",
      type: "one_off",
      runAt: Date.now() + 60_000,
      timezone: "UTC",
      messageContent: "current channel reminder",
    });
    createSchedule(db, {
      guildId: "guild-1",
      channelId: "ch-2",
      source: "tool",
      type: "one_off",
      runAt: Date.now() + 60_000,
      timezone: "UTC",
      messageContent: "other channel reminder",
    });
    createSchedule(db, {
      guildId: "guild-2",
      channelId: "ch-1",
      source: "tool",
      type: "one_off",
      runAt: Date.now() + 60_000,
      timezone: "UTC",
      messageContent: "other guild reminder",
    });
    createSchedule(db, {
      guildId: "guild-1",
      channelId: "ch-1",
      source: "tool",
      type: "one_off",
      runAt: Date.now() - 60_000,
      timezone: "UTC",
      messageContent: "past reminder",
    });

    const listTool = createListScheduledMessagesTool(deps);
    const result = await listTool.execute("list-1", {}, new AbortController().signal, () => {});
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain(currentId);
    expect(text).toContain("current channel reminder");
    expect(text).not.toContain("other channel reminder");
    expect(text).not.toContain("other guild reminder");
    expect(text).not.toContain("past reminder");
  });

  test("list_scheduled_messages does not show deleted schedules", async () => {
    const id = createSchedule(db, {
      guildId: "guild-1",
      channelId: "ch-1",
      source: "tool",
      type: "one_off",
      runAt: Date.now() + 60_000,
      timezone: "UTC",
      messageContent: "to delete",
    });
    const deleteTool = createDeleteScheduledMessageTool(deps);
    await deleteTool.execute("delete-1", { scheduleId: id }, new AbortController().signal, () => {});

    const listTool = createListScheduledMessagesTool(deps);
    const result = await listTool.execute("list-1", {}, new AbortController().signal, () => {});
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("No pending");
    expect(text).not.toContain(id);
  });

  test("delete_scheduled_message deletes only pending schedules in current channel and guild", async () => {
    const id = createSchedule(db, {
      guildId: "guild-1",
      channelId: "ch-1",
      source: "tool",
      type: "one_off",
      runAt: Date.now() + 60_000,
      timezone: "UTC",
      messageContent: "delete me",
    });
    const otherChannelId = createSchedule(db, {
      guildId: "guild-1",
      channelId: "ch-2",
      source: "tool",
      type: "one_off",
      runAt: Date.now() + 60_000,
      timezone: "UTC",
      messageContent: "do not delete",
    });

    const deleteTool = createDeleteScheduledMessageTool(deps);
    const miss = await deleteTool.execute("delete-miss", { scheduleId: otherChannelId }, new AbortController().signal, () => {});
    expect((miss.content[0] as { text: string }).text).toContain("No pending");
    expect(getSchedule(db, otherChannelId)).not.toBeNull();

    const hit = await deleteTool.execute("delete-hit", { scheduleId: id }, new AbortController().signal, () => {});
    expect((hit.content[0] as { text: string }).text).toContain("Deleted");
    expect(getSchedule(db, id)).toBeNull();
    expect(deletedIds).toEqual([id]);
  });
});
