import { test, expect, describe } from "bun:test";
import { formatDateStamp, insertDateStamps } from "./history-dates.ts";
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
