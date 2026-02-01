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

  test("creates a one-off schedule from relative time", async () => {
    const before = Date.now();
    const result = await tool.execute(
      "call-1",
      { amount: 30, unit: "minutes", message: "Check back later" },
      new AbortController().signal,
      () => {}
    );

    const schedules = listSchedules(db, { guildId: "guild-1" });
    expect(schedules).toHaveLength(1);

    const s = schedules[0];
    expect(s.type).toBe("one_off");
    expect(s.source).toBe("tool");
    expect(s.channelId).toBe("ch-1");
    expect(s.timezone).toBe("America/New_York");
    expect(s.messageContent).toBe("Check back later");
    expect(s.enabled).toBe(true);
    // runAt should be ~30 min from now
    expect(s.runAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(s.runAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 1000);

    expect(result.text).toContain("Scheduled");
  });

  test("supports seconds unit", async () => {
    await tool.execute("c2", { amount: 45, unit: "seconds", message: "ping" }, new AbortController().signal, () => {});
    const s = listSchedules(db, { guildId: "guild-1" })[0];
    expect(s.runAt).toBeGreaterThan(Date.now() + 40_000);
    expect(s.runAt).toBeLessThan(Date.now() + 50_000);
  });

  test("supports hours unit", async () => {
    await tool.execute("c3", { amount: 2, unit: "hours", message: "reminder" }, new AbortController().signal, () => {});
    const s = listSchedules(db, { guildId: "guild-1" })[0];
    expect(s.runAt).toBeGreaterThan(Date.now() + 2 * 3600_000 - 1000);
  });

  test("calls onScheduleCreated callback with new schedule ID", async () => {
    await tool.execute("c4", { amount: 10, unit: "minutes", message: "test" }, new AbortController().signal, () => {});
    expect(registeredIds).toHaveLength(1);
    const s = listSchedules(db, { guildId: "guild-1" })[0];
    expect(registeredIds[0]).toBe(s.id);
  });

  test("rejects zero or negative amount", async () => {
    const result = await tool.execute("c5", { amount: 0, unit: "minutes", message: "bad" }, new AbortController().signal, () => {});
    expect(result.text).toContain("positive");
    expect(listSchedules(db, { guildId: "guild-1" })).toHaveLength(0);
  });

  test("rejects invalid unit", async () => {
    const result = await tool.execute("c6", { amount: 5, unit: "days", message: "bad" }, new AbortController().signal, () => {});
    expect(result.text).toContain("seconds, minutes, or hours");
    expect(listSchedules(db, { guildId: "guild-1" })).toHaveLength(0);
  });
});
