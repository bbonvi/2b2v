import { test, expect, describe, beforeEach } from "bun:test";
import { createDatabase, type Database } from "../db/database";
import { listSchedules } from "../db/schedule-repository";
import { createScheduleTool, type ScheduleToolDeps } from "./schedule-tool";
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
});
