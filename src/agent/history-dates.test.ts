import { test, expect, describe } from "bun:test";
import { formatDateStamp, insertDateStamps, formatRelativeAgo, formatMemoryTimestamps, formatJournalTimestamp } from "./history-dates.ts";
import type { HistoryMessage } from "./history-types.ts";

function msg(id: string, timestamp: number): HistoryMessage {
  return {
    id,
    author: "alice",
    authorId: "uid-alice",
    content: `content-${id}`,
    isBot: false,
    timestamp,
    replyToId: null,
    imageIds: [],
    captions: [],
    hasEmbeds: false,
    isSynthetic: false,
    relatedThreadId: null,
  };
}

describe("formatDateStamp", () => {
  test("formats UTC correctly", () => {
    // 2026-02-02 14:05 UTC
    const ts = Date.UTC(2026, 1, 2, 14, 5, 0);
    const result = formatDateStamp(ts, "UTC");
    expect(result).toBe("[DATE 2026-02-02 14:05 +00:00]");
  });

  test("formats with timezone offset", () => {
    // 2026-02-02 14:05 UTC → 2026-02-02 23:05 in Asia/Tokyo (+09:00)
    const ts = Date.UTC(2026, 1, 2, 14, 5, 0);
    const result = formatDateStamp(ts, "Asia/Tokyo");
    expect(result).toBe("[DATE 2026-02-02 23:05 +09:00]");
  });

  test("falls back to UTC for invalid timezone", () => {
    const ts = Date.UTC(2026, 1, 2, 14, 5, 0);
    const result = formatDateStamp(ts, "Invalid/Zone");
    expect(result).toBe("[DATE 2026-02-02 14:05 +00:00]");
  });

  test("deterministic for identical inputs", () => {
    const ts = Date.UTC(2026, 6, 15, 8, 30, 0);
    const r1 = formatDateStamp(ts, "America/New_York");
    const r2 = formatDateStamp(ts, "America/New_York");
    expect(r1).toBe(r2);
  });

  test("handles negative offset", () => {
    const ts = Date.UTC(2026, 1, 2, 14, 5, 0);
    const result = formatDateStamp(ts, "America/New_York");
    // Feb in NYC is EST = -05:00
    expect(result).toBe("[DATE 2026-02-02 09:05 -05:00]");
  });
});

describe("insertDateStamps", () => {
  test("empty input returns empty", () => {
    expect(insertDateStamps([], "UTC")).toEqual([]);
  });

  test("first message always gets a date stamp", () => {
    const result = insertDateStamps([msg("1", 1000)], "UTC");
    expect(result).toHaveLength(2);
    expect(result[0]?.type).toBe("date");
    expect(result[1]).toEqual({ type: "index", index: 0 });
  });

  test("no new stamp within 5 minutes", () => {
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    const msgs = [
      msg("1", base),
      msg("2", base + 2 * 60_000),  // +2 min
      msg("3", base + 4 * 60_000),  // +4 min
    ];
    const result = insertDateStamps(msgs, "UTC");
    // 1 date stamp + 3 indices
    const dateCount = result.filter((r) => r.type === "date").length;
    expect(dateCount).toBe(1);
    expect(result).toHaveLength(4);
  });

  test("new stamp after 5 minutes", () => {
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    const msgs = [
      msg("1", base),
      msg("2", base + 5 * 60_000), // exactly 5 min
    ];
    const result = insertDateStamps(msgs, "UTC");
    const dateCount = result.filter((r) => r.type === "date").length;
    expect(dateCount).toBe(2);
  });

  test("date stamp inserted before the triggering message", () => {
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    const msgs = [
      msg("1", base),
      msg("2", base + 10 * 60_000),
    ];
    const result = insertDateStamps(msgs, "UTC");
    // date, index 0, date, index 1
    expect(result[0]?.type).toBe("date");
    expect(result[1]).toEqual({ type: "index", index: 0 });
    expect(result[2]?.type).toBe("date");
    expect(result[3]).toEqual({ type: "index", index: 1 });
  });

  test("deterministic for identical inputs", () => {
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    const msgs = [msg("1", base), msg("2", base + 6 * 60_000)];
    const r1 = insertDateStamps(msgs, "UTC");
    const r2 = insertDateStamps(msgs, "UTC");
    expect(r1).toEqual(r2);
  });

  test("multiple date stamps across long history", () => {
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    const msgs = Array.from({ length: 10 }, (_, i) =>
      msg(String(i), base + i * 3 * 60_000) // every 3 min
    );
    const result = insertDateStamps(msgs, "UTC");
    const dateCount = result.filter((r) => r.type === "date").length;
    // stamps at: 0min, 6min (idx 2), 12min (idx 4), 18min (idx 6), 24min (idx 8)
    // first always, then every >=5 min gap
    // idx0=0, idx1=3, idx2=6 (6-0=6>=5 → stamp), idx3=9, idx4=12 (12-6=6>=5 → stamp), etc
    expect(dateCount).toBe(5);
  });
});

describe("formatRelativeAgo", () => {
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;
  const YEAR = 365 * DAY;

  test("less than 1 minute returns '<1m ago'", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(formatRelativeAgo(now - 0, now)).toBe("<1m ago");
    expect(formatRelativeAgo(now - 30_000, now)).toBe("<1m ago");
    expect(formatRelativeAgo(now - 59_999, now)).toBe("<1m ago");
  });

  test("minutes: 1m to 59m", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(formatRelativeAgo(now - MINUTE, now)).toBe("1m ago");
    expect(formatRelativeAgo(now - 5 * MINUTE, now)).toBe("5m ago");
    expect(formatRelativeAgo(now - 59 * MINUTE, now)).toBe("59m ago");
  });

  test("hours: 1h to 23h", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(formatRelativeAgo(now - HOUR, now)).toBe("1h ago");
    expect(formatRelativeAgo(now - 2 * HOUR, now)).toBe("2h ago");
    expect(formatRelativeAgo(now - 23 * HOUR, now)).toBe("23h ago");
  });

  test("days: 1d to 6d", () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    expect(formatRelativeAgo(now - DAY, now)).toBe("1d ago");
    expect(formatRelativeAgo(now - 3 * DAY, now)).toBe("3d ago");
    expect(formatRelativeAgo(now - 6 * DAY, now)).toBe("6d ago");
  });

  test("weeks: 1w to 4w", () => {
    const now = Date.UTC(2026, 1, 1, 12, 0, 0);
    expect(formatRelativeAgo(now - WEEK, now)).toBe("1w ago");
    expect(formatRelativeAgo(now - 2 * WEEK, now)).toBe("2w ago");
    expect(formatRelativeAgo(now - 4 * WEEK, now)).toBe("4w ago");
  });

  test("months: 1mo to 11mo", () => {
    const now = Date.UTC(2026, 11, 1, 12, 0, 0);
    expect(formatRelativeAgo(now - MONTH, now)).toBe("1mo ago");
    expect(formatRelativeAgo(now - 3 * MONTH, now)).toBe("3mo ago");
    expect(formatRelativeAgo(now - 11 * MONTH, now)).toBe("11mo ago");
  });

  test("years: 1y and beyond", () => {
    const now = Date.UTC(2028, 0, 1, 12, 0, 0);
    expect(formatRelativeAgo(now - YEAR, now)).toBe("1y ago");
    expect(formatRelativeAgo(now - 2 * YEAR, now)).toBe("2y ago");
  });

  test("boundary: exactly at threshold switches to larger unit", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    // Exactly 60 minutes = 1h
    expect(formatRelativeAgo(now - 60 * MINUTE, now)).toBe("1h ago");
    // Exactly 24 hours = 1d
    expect(formatRelativeAgo(now - 24 * HOUR, now)).toBe("1d ago");
    // Exactly 7 days = 1w
    expect(formatRelativeAgo(now - 7 * DAY, now)).toBe("1w ago");
  });

  test("deterministic with nowMs injection", () => {
    const timestamp = Date.UTC(2026, 0, 1, 10, 0, 0);
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(formatRelativeAgo(timestamp, now)).toBe("2h ago");
    expect(formatRelativeAgo(timestamp, now)).toBe("2h ago");
  });
});

describe("formatMemoryTimestamps", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  test("created only when timestamps match", () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    const created = now - 5 * DAY;
    expect(formatMemoryTimestamps(created, created, now)).toBe("(Created: 5d ago)");
  });

  test("both timestamps when updated differs", () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    const created = now - 5 * DAY;
    const updated = now - 2 * HOUR;
    expect(formatMemoryTimestamps(created, updated, now)).toBe("(Created: 5d ago; Updated: 2h ago)");
  });

  test("recent creation and update", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const created = now - 1 * HOUR;
    const updated = now - 10 * 60 * 1000; // 10 minutes
    expect(formatMemoryTimestamps(created, updated, now)).toBe("(Created: 1h ago; Updated: 10m ago)");
  });

  test("deterministic with nowMs injection", () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    const created = now - 3 * DAY;
    const updated = now - 1 * DAY;
    const result1 = formatMemoryTimestamps(created, updated, now);
    const result2 = formatMemoryTimestamps(created, updated, now);
    expect(result1).toBe(result2);
    expect(result1).toBe("(Created: 3d ago; Updated: 1d ago)");
  });
});

describe("formatJournalTimestamp", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  test("formats updatedAt only", () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    const updated = now - 5 * DAY;
    expect(formatJournalTimestamp(updated, now)).toBe("(5d ago)");
  });

  test("recent update", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const updated = now - 10 * 60 * 1000; // 10 minutes
    expect(formatJournalTimestamp(updated, now)).toBe("(10m ago)");
  });

  test("deterministic with nowMs injection", () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    const updated = now - 2 * HOUR;
    const result1 = formatJournalTimestamp(updated, now);
    const result2 = formatJournalTimestamp(updated, now);
    expect(result1).toBe(result2);
    expect(result1).toBe("(2h ago)");
  });
});
