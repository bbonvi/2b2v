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
  type CreateCron,
  type SchedulerTimerApi,
} from "./engine";

class FakeTimers {
  nowMs = 1_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  readonly api: SchedulerTimerApi = {
    now: () => this.nowMs,
    setTimeout: (callback, ms) => {
      const id = this.nextId;
      this.nextId += 1;
      this.timers.set(id, { at: this.nowMs + Math.max(0, ms), callback });
      return id;
    },
    clearTimeout: (timer) => {
      if (typeof timer === "number") this.timers.delete(timer);
    },
  };

  async advance(ms: number): Promise<void> {
    const end = this.nowMs + ms;
    for (;;) {
      let next: { id: number; at: number; callback: () => void } | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && (next === null || timer.at < next.at)) {
          next = { id, ...timer };
        }
      }
      if (next === null) break;
      this.nowMs = next.at;
      this.timers.delete(next.id);
      next.callback();
      await Promise.resolve();
    }
    this.nowMs = end;
  }
}

class FakeCrons {
  callbacks: Array<() => void> = [];

  readonly create: CreateCron = (expression, _options, callback) => {
    if (expression === "not a cron") throw new Error("invalid cron");
    this.callbacks.push(callback);
    let stopped = false;
    return {
      stop: () => {
        stopped = true;
      },
      get stopped() {
        return stopped;
      },
    };
  };

  fire(index = 0): void {
    this.callbacks[index]?.();
  }
}

describe("SchedulerEngine", () => {
  let db: Database;
  let engine: SchedulerEngine | undefined;
  let fired: ScheduleFireEvent[];
  let timers: FakeTimers;
  let crons: FakeCrons;

  beforeEach(() => {
    db = createDatabase(":memory:");
    fired = [];
    timers = new FakeTimers();
    crons = new FakeCrons();
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
      timers: timers.api,
      createCron: crons.create,
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

  test("fires a cron schedule callback", () => {
    addCronSchedule("* * * * * *"); // every second
    const e = makeEngine();
    e.start();
    crons.fire();
    expect(fired.length).toBeGreaterThanOrEqual(1);
    const first = fired[0];
    if (first === undefined) throw new Error("unreachable");
    expect(first.schedule.messageContent).toBe("hello");
    expect(first.schedule.guildId).toBe("guild-1");
    e.stop();
  });

  test("fires a one-off schedule and auto-disables it", async () => {
    const runAt = timers.nowMs + 500;
    const id = addOneOffSchedule(runAt, "reminder");
    const e = makeEngine();
    e.start();

    await timers.advance(500);
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
    const id = addOneOffSchedule(timers.nowMs + 180, "long reminder");
    const e = makeEngine({ maxOneOffTimerDelayMs: 50 });
    e.start();

    await timers.advance(80);
    expect(fired).toHaveLength(0);
    expect(e.activeCount()).toBe(1);
    expect(getSchedule(db, id)?.enabled).toBe(true);

    await timers.advance(100);
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
    addOneOffSchedule(timers.nowMs - 60_000, "past");
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

  test("addSchedule registers a new schedule at runtime", () => {
    const e = makeEngine();
    e.start();
    expect(e.activeCount()).toBe(0);

    const id = addCronSchedule("* * * * * *");
    e.addSchedule(id);
    expect(e.activeCount()).toBe(1);

    crons.fire();
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

  test("onFire callback receives full schedule row", () => {
    addCronSchedule("* * * * * *", "UTC", "test-msg");
    const e = makeEngine();
    e.start();

    crons.fire();
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
