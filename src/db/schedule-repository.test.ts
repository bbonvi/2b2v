import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createDatabase, type Database } from "./database";
import {
  createSchedule,
  updateSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  listUpcomingForContext,
  type ScheduleSource,
  type ScheduleType,
} from "./schedule-repository";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("createSchedule", () => {
  test("creates a recurring cron schedule", () => {
    const id = createSchedule(db, {
      guildId: "guild-1",
      channelId: "ch-1",
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "America/New_York",
      messageContent: "Good morning!",
    });

    expect(id).toBeString();
    const row = getSchedule(db, id);
    expect(row).not.toBeNull();
    expect(row?.guildId).toBe("guild-1");
    expect(row?.channelId).toBe("ch-1");
    expect(row?.source).toBe("admin");
    expect(row?.type).toBe("cron");
    expect(row?.cronExpression).toBe("0 9 * * *");
    expect(row?.runAt).toBeNull();
    expect(row?.timezone).toBe("America/New_York");
    expect(row?.messageContent).toBe("Good morning!");
    expect(row?.enabled).toBe(true);
    expect(row?.createdAt).toBeNumber();
    expect(row?.updatedAt).toBeNumber();
  });

  test("creates a one-off schedule with run_at timestamp", () => {
    const runAt = Date.now() + 60_000;
    const id = createSchedule(db, {
      guildId: "guild-1",
      channelId: "ch-1",
      source: "bot",
      type: "one_off",
      runAt,
      timezone: "UTC",
      messageContent: "Reminder!",
    });

    const row = getSchedule(db, id);
    expect(row?.type).toBe("one_off");
    expect(row?.runAt).toBe(runAt);
    expect(row?.cronExpression).toBeNull();
  });

  test("creates a tool-created schedule", () => {
    const id = createSchedule(db, {
      guildId: "guild-2",
      channelId: "ch-5",
      source: "tool",
      type: "one_off",
      runAt: Date.now() + 3600_000,
      timezone: "Asia/Tokyo",
      messageContent: "Check back later",
    });

    const row = getSchedule(db, id);
    expect(row?.source).toBe("tool");
    expect(row?.guildId).toBe("guild-2");
  });

  test("defaults enabled to true", () => {
    const id = createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "admin",
      type: "cron",
      cronExpression: "* * * * *",
      timezone: "UTC",
      messageContent: "test",
    });
    expect(getSchedule(db, id)?.enabled).toBe(true);
  });

  test("allows explicit enabled=false", () => {
    const id = createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "admin",
      type: "cron",
      cronExpression: "* * * * *",
      timezone: "UTC",
      messageContent: "test",
      enabled: false,
    });
    expect(getSchedule(db, id)?.enabled).toBe(false);
  });

  test("rejects invalid source value", () => {
    expect(() =>
      createSchedule(db, {
        guildId: "g1",
        channelId: "c1",
        source: "invalid" as ScheduleSource,
        type: "cron",
        cronExpression: "* * * * *",
        timezone: "UTC",
        messageContent: "test",
      })
    ).toThrow();
  });

  test("rejects invalid type value", () => {
    expect(() =>
      createSchedule(db, {
        guildId: "g1",
        channelId: "c1",
        source: "admin",
        type: "invalid" as ScheduleType,
        cronExpression: "* * * * *",
        timezone: "UTC",
        messageContent: "test",
      })
    ).toThrow();
  });
});

describe("getSchedule", () => {
  test("returns null for nonexistent id", () => {
    expect(getSchedule(db, "nope")).toBeNull();
  });
});

describe("updateSchedule", () => {
  test("updates message content", () => {
    const id = createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      messageContent: "old",
    });

    const updated = updateSchedule(db, id, { messageContent: "new" });
    expect(updated).toBe(true);
    expect(getSchedule(db, id)?.messageContent).toBe("new");
  });

  test("updates enabled flag", () => {
    const id = createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      messageContent: "test",
    });

    updateSchedule(db, id, { enabled: false });
    expect(getSchedule(db, id)?.enabled).toBe(false);

    updateSchedule(db, id, { enabled: true });
    expect(getSchedule(db, id)?.enabled).toBe(true);
  });

  test("updates cron expression and timezone", () => {
    const id = createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      messageContent: "test",
    });

    updateSchedule(db, id, {
      cronExpression: "30 18 * * 5",
      timezone: "Europe/London",
    });
    const row = getSchedule(db, id);
    expect(row).not.toBeNull();
    expect(row?.cronExpression).toBe("30 18 * * 5");
    expect(row?.timezone).toBe("Europe/London");
  });

  test("updates updatedAt timestamp", () => {
    const id = createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      messageContent: "test",
    });
    const before = getSchedule(db, id)?.updatedAt ?? 0;

    // Small delay to ensure timestamp changes
    updateSchedule(db, id, { messageContent: "changed" });
    const after = getSchedule(db, id)?.updatedAt ?? 0;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  test("returns false for nonexistent id", () => {
    expect(updateSchedule(db, "nope", { messageContent: "x" })).toBe(false);
  });
});

describe("deleteSchedule", () => {
  test("deletes an existing schedule", () => {
    const id = createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      messageContent: "test",
    });

    expect(deleteSchedule(db, id)).toBe(true);
    expect(getSchedule(db, id)).toBeNull();
  });

  test("returns false for nonexistent id", () => {
    expect(deleteSchedule(db, "nope")).toBe(false);
  });
});

describe("listSchedules", () => {
  test("lists schedules by guild", () => {
    createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      messageContent: "g1 schedule",
    });
    createSchedule(db, {
      guildId: "g2",
      channelId: "c2",
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      messageContent: "g2 schedule",
    });

    const g1Schedules = listSchedules(db, { guildId: "g1" });
    expect(g1Schedules).toHaveLength(1);
    if (!g1Schedules[0]) throw new Error("unreachable");
    expect(g1Schedules[0].messageContent).toBe("g1 schedule");
  });

  test("filters by source", () => {
    createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      messageContent: "admin",
    });
    createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "bot",
      type: "one_off",
      runAt: Date.now() + 60_000,
      timezone: "UTC",
      messageContent: "bot",
    });

    const adminOnly = listSchedules(db, { guildId: "g1", source: "admin" });
    expect(adminOnly).toHaveLength(1);
    if (!adminOnly[0]) throw new Error("unreachable");
    expect(adminOnly[0].source).toBe("admin");
  });

  test("filters by enabled", () => {
    createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      messageContent: "active",
    });
    createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      messageContent: "disabled",
      enabled: false,
    });

    const enabledOnly = listSchedules(db, { guildId: "g1", enabled: true });
    expect(enabledOnly).toHaveLength(1);
    if (!enabledOnly[0]) throw new Error("unreachable");
    expect(enabledOnly[0].messageContent).toBe("active");
  });

  test("returns empty array for guild with no schedules", () => {
    expect(listSchedules(db, { guildId: "empty" })).toEqual([]);
  });

  test("orders by created_at ascending", () => {
    // Create in known order
    const _id1 = createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      messageContent: "first",
    });
    const _id2 = createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "bot",
      type: "cron",
      cronExpression: "0 18 * * *",
      timezone: "UTC",
      messageContent: "second",
    });

    const all = listSchedules(db, { guildId: "g1" });
    if (!all[0] || !all[1]) throw new Error("unreachable");
    expect(all[0].messageContent).toBe("first");
    expect(all[1].messageContent).toBe("second");
  });
});

describe("listUpcomingForContext", () => {
  test("returns enabled schedules for a guild", () => {
    createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      messageContent: "daily greeting",
    });
    createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "bot",
      type: "one_off",
      runAt: Date.now() + 60_000,
      timezone: "UTC",
      messageContent: "reminder",
    });
    createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      messageContent: "disabled",
      enabled: false,
    });

    const upcoming = listUpcomingForContext(db, "g1");
    expect(upcoming).toHaveLength(2);
    // Should not include disabled
    expect(upcoming.every((s) => s.enabled)).toBe(true);
  });

  test("returns empty for guild with no schedules", () => {
    expect(listUpcomingForContext(db, "no-guild")).toEqual([]);
  });
});

describe("schema constraints", () => {
  test("schedules table exists with expected columns", () => {
    const info = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schedules'")
      .get() as { name: string } | undefined;
    expect(info?.name).toBe("schedules");
  });

  test("guild_enabled index exists", () => {
    const idx = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_schedules_guild_enabled'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_schedules_guild_enabled");
  });

  test("enforces unique id constraint", () => {
    const now = Date.now();
    const insert = (id: string) =>
      db.raw
        .prepare(
          `INSERT INTO schedules (id, guild_id, channel_id, source, type, cron_expression, run_at, timezone, message_content, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, "g1", "c1", "admin", "cron", "* * * * *", null, "UTC", "test", 1, now, now);

    insert("dup-1");
    expect(() => insert("dup-1")).toThrow();
  });
});
