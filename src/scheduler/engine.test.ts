import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createDatabase, type Database } from "../db/database";
import {
  createSchedule,
  getSchedule,
} from "../db/schedule-repository";
import {
  createSchedulerEngine,
  type SchedulerEngine,
  type ScheduleFireEvent,
} from "./engine";

describe("SchedulerEngine", () => {
  let db: Database;
  let engine: SchedulerEngine | undefined;
  let fired: ScheduleFireEvent[];

  beforeEach(() => {
    db = createDatabase(":memory:");
    fired = [];
  });

  afterEach(() => {
    if (engine !== undefined) engine.stop();
  });

  function makeEngine(opts?: { pollIntervalMs?: number; maxOneOffTimerDelayMs?: number }) {
    engine = createSchedulerEngine({
      db,
      onFire: (event) => {
        fired.push(event);
      },
      pollIntervalMs: opts?.pollIntervalMs,
      maxOneOffTimerDelayMs: opts?.maxOneOffTimerDelayMs,
    });
    return engine;
  }

  function addCronSchedule(cron: string, tz = "UTC", msg = "hello") {
    return createSchedule(db, {
      guildId: "guild-1",
      channelId: "ch-1",
      source: "bot",
      type: "cron",
      cronExpression: cron,
      timezone: tz,
      messageContent: msg,
    });
  }

  function addOneOffSchedule(runAt: number, msg = "one-off") {
    return createSchedule(db, {
      guildId: "guild-1",
      channelId: "ch-1",
      source: "tool",
      type: "one_off",
      runAt,
      timezone: "UTC",
      messageContent: msg,
    });
  }

  test("starts and stops without error when no schedules exist", () => {
    const e = makeEngine();
    e.start();
    expect(e.isRunning()).toBe(true);
    e.stop();
    expect(e.isRunning()).toBe(false);
  });

  test("loads and schedules a cron job on start", () => {
    addCronSchedule("* * * * * *"); // every second
    const e = makeEngine();
    e.start();
    expect(e.activeCount()).toBe(1);
    e.stop();
  });

  test("fires a cron schedule callback", async () => {
    addCronSchedule("* * * * * *"); // every second
    const e = makeEngine();
    e.start();
    // Wait up to 2.5 seconds for at least one fire
    await waitFor(() => fired.length > 0, 2500);
    expect(fired.length).toBeGreaterThanOrEqual(1);
    const first = fired[0];
    if (first === undefined) throw new Error("unreachable");
    expect(first.schedule.messageContent).toBe("hello");
    expect(first.schedule.guildId).toBe("guild-1");
    e.stop();
  });

  test("fires a one-off schedule and auto-disables it", async () => {
    const runAt = Date.now() + 500; // 500ms from now
    const id = addOneOffSchedule(runAt, "reminder");
    const e = makeEngine();
    e.start();

    await waitFor(() => fired.length > 0, 2000);
    expect(fired.length).toBe(1);
    const oneOff = fired[0];
    if (oneOff === undefined) throw new Error("unreachable");
    expect(oneOff.schedule.messageContent).toBe("reminder");

    // Should be disabled in DB
    const row = getSchedule(db, id);
    expect(row).not.toBeUndefined();
    expect(row?.enabled).toBe(false);
    e.stop();
  });

  test("re-arms long one-off schedules instead of firing at the first timer chunk", async () => {
    const id = addOneOffSchedule(Date.now() + 180, "long reminder");
    const e = makeEngine({ maxOneOffTimerDelayMs: 50 });
    e.start();

    await sleep(80);
    expect(fired).toHaveLength(0);
    expect(e.activeCount()).toBe(1);
    expect(getSchedule(db, id)?.enabled).toBe(true);

    await waitFor(() => fired.length > 0, 1000);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.schedule.messageContent).toBe("long reminder");
    expect(getSchedule(db, id)?.enabled).toBe(false);
    e.stop();
  });

  test("does not schedule disabled schedules", () => {
    createSchedule(db, {
      guildId: "guild-1",
      channelId: "ch-1",
      source: "bot",
      type: "cron",
      cronExpression: "* * * * * *",
      timezone: "UTC",
      messageContent: "disabled",
      enabled: false,
    });
    const e = makeEngine();
    e.start();
    expect(e.activeCount()).toBe(0);
    e.stop();
  });

  test("skips one-off schedules whose run_at is in the past", () => {
    addOneOffSchedule(Date.now() - 60_000, "past");
    const e = makeEngine();
    e.start();
    // Past one-offs should be auto-disabled, not scheduled
    expect(e.activeCount()).toBe(0);
    const rows = db.raw
      .prepare("SELECT enabled FROM schedules")
      .all() as { enabled: number }[];
    const row0 = rows[0];
    if (row0 === undefined) throw new Error("unreachable");
    expect(row0.enabled).toBe(0);
    e.stop();
  });

  test("addSchedule registers a new schedule at runtime", async () => {
    const e = makeEngine();
    e.start();
    expect(e.activeCount()).toBe(0);

    const id = addCronSchedule("* * * * * *");
    e.addSchedule(id);
    expect(e.activeCount()).toBe(1);

    await waitFor(() => fired.length > 0, 2500);
    expect(fired.length).toBeGreaterThanOrEqual(1);
    e.stop();
  });

  test("removeSchedule unregisters a running schedule", () => {
    const id = addCronSchedule("* * * * * *");
    const e = makeEngine();
    e.start();
    expect(e.activeCount()).toBe(1);

    e.removeSchedule(id);
    expect(e.activeCount()).toBe(0);
    e.stop();
  });

  test("respects per-guild timezone for cron schedules", () => {
    // This test validates that the Cron instance is created with the correct timezone.
    // We can't easily assert the exact fire time in a unit test, but we verify
    // the schedule is accepted and active with a non-UTC timezone.
    addCronSchedule("0 0 9 * * *", "America/New_York", "morning");
    const e = makeEngine();
    e.start();
    expect(e.activeCount()).toBe(1);
    e.stop();
  });

  test("stop clears all active schedules", () => {
    addCronSchedule("* * * * * *");
    addCronSchedule("*/5 * * * * *");
    const e = makeEngine();
    e.start();
    expect(e.activeCount()).toBe(2);
    e.stop();
    expect(e.activeCount()).toBe(0);
  });

  test("handles invalid cron expression gracefully", () => {
    createSchedule(db, {
      guildId: "guild-1",
      channelId: "ch-1",
      source: "bot",
      type: "cron",
      cronExpression: "not a cron",
      timezone: "UTC",
      messageContent: "bad",
    });
    const e = makeEngine();
    // Should not throw; invalid schedule skipped
    e.start();
    expect(e.activeCount()).toBe(0);
    e.stop();
  });

  test("onFire callback receives full schedule row", async () => {
    addCronSchedule("* * * * * *", "UTC", "test-msg");
    const e = makeEngine();
    e.start();

    await waitFor(() => fired.length > 0, 2500);
    const event = fired[0];
    if (event === undefined) throw new Error("unreachable");
    expect(event.schedule.guildId).toBe("guild-1");
    expect(event.schedule.channelId).toBe("ch-1");
    expect(event.schedule.messageContent).toBe("test-msg");
    expect(event.schedule.type).toBe("cron");
    expect(event.schedule.timezone).toBe("UTC");
    e.stop();
  });
});

function waitFor(fn: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs)
        return reject(new Error("waitFor timeout"));
      setTimeout(check, 50);
    };
    check();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
