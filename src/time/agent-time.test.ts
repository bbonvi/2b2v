import { test, expect, describe } from "bun:test";
import {
  formatLocalWallClock,
  currentLocalContext,
  parseLocalDateTimeToEpoch,
} from "./agent-time.ts";

describe("formatLocalWallClock", () => {
  test("formats epoch ms in UTC", () => {
    const ts = Date.UTC(2026, 1, 6, 14, 30, 0); // 2026-02-06 14:30 UTC
    expect(formatLocalWallClock(ts, "UTC")).toBe("2026-02-06 14:30");
  });

  test("formats epoch ms in Asia/Tokyo (+09:00)", () => {
    const ts = Date.UTC(2026, 1, 6, 14, 30, 0); // 2026-02-06 23:30 Tokyo
    expect(formatLocalWallClock(ts, "Asia/Tokyo")).toBe("2026-02-06 23:30");
  });

  test("formats epoch ms in America/New_York (EST = -05:00)", () => {
    const ts = Date.UTC(2026, 1, 6, 14, 30, 0); // 2026-02-06 09:30 NYC
    expect(formatLocalWallClock(ts, "America/New_York")).toBe("2026-02-06 09:30");
  });

  test("handles midnight correctly", () => {
    const ts = Date.UTC(2026, 1, 6, 5, 0, 0); // 2026-02-06 00:00 in UTC+5
    expect(formatLocalWallClock(ts, "Asia/Karachi")).toBe("2026-02-06 10:00");
  });

  test("falls back to UTC for invalid timezone", () => {
    const ts = Date.UTC(2026, 1, 6, 14, 30, 0);
    expect(formatLocalWallClock(ts, "Invalid/Zone")).toBe("2026-02-06 14:30");
  });

  test("deterministic for identical inputs", () => {
    const ts = Date.UTC(2026, 6, 15, 8, 30, 0);
    const r1 = formatLocalWallClock(ts, "Europe/Berlin");
    const r2 = formatLocalWallClock(ts, "Europe/Berlin");
    expect(r1).toBe(r2);
  });

  test("handles DST transition periods correctly", () => {
    // 2026-03-08 is spring forward day in US. 2:00 AM -> 3:00 AM EDT
    // 2026-03-08 07:00 UTC = 2026-03-08 03:00 EDT (after spring forward)
    const ts = Date.UTC(2026, 2, 8, 7, 0, 0);
    expect(formatLocalWallClock(ts, "America/New_York")).toBe("2026-03-08 03:00");
  });
});

describe("currentLocalContext", () => {
  test("produces timezone and local date/time lines", () => {
    const nowMs = Date.UTC(2026, 1, 6, 12, 30, 0);
    const result = currentLocalContext("Europe/Berlin", nowMs);
    expect(result).toContain("Timezone: Europe/Berlin");
    expect(result).toContain("Local Date/Time: 2026-02-06 13:30");
  });

  test("uses UTC for invalid timezone with warning", () => {
    const nowMs = Date.UTC(2026, 1, 6, 12, 0, 0);
    const result = currentLocalContext("Invalid/Zone", nowMs);
    expect(result).toContain("Timezone: UTC");
    expect(result).toContain("Local Date/Time: 2026-02-06 12:00");
  });
});

describe("parseLocalDateTimeToEpoch", () => {
  test("parses valid local datetime in UTC", () => {
    const result = parseLocalDateTimeToEpoch("2026-02-06 14:30", "UTC");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.epochMs).toBe(Date.UTC(2026, 1, 6, 14, 30, 0));
    }
  });

  test("parses valid local datetime in offset timezone", () => {
    // 2026-02-06 09:30 NYC EST = 2026-02-06 14:30 UTC
    const result = parseLocalDateTimeToEpoch("2026-02-06 09:30", "America/New_York");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.epochMs).toBe(Date.UTC(2026, 1, 6, 14, 30, 0));
    }
  });

  test("rejects invalid format (missing time)", () => {
    const result = parseLocalDateTimeToEpoch("2026-02-06", "UTC");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("YYYY-MM-DD HH:mm");
    }
  });

  test("rejects ISO 8601 with Z suffix", () => {
    const result = parseLocalDateTimeToEpoch("2026-02-06T14:30:00Z", "UTC");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("YYYY-MM-DD HH:mm");
    }
  });

  test("rejects ISO 8601 with offset", () => {
    const result = parseLocalDateTimeToEpoch("2026-02-06T14:30:00+05:00", "UTC");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("YYYY-MM-DD HH:mm");
    }
  });

  test("rejects garbage input", () => {
    const result = parseLocalDateTimeToEpoch("not-a-date", "UTC");
    expect(result.ok).toBe(false);
  });

  test("rejects DST nonexistent time (spring forward gap)", () => {
    // In America/New_York, 2026-03-08 02:30 does not exist (clocks skip 2:00→3:00)
    const result = parseLocalDateTimeToEpoch("2026-03-08 02:30", "America/New_York");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain("nonexistent");
    }
  });

  test("rejects DST ambiguous time (fall back overlap)", () => {
    // In America/New_York, 2026-11-01 01:30 is ambiguous (clocks fall back 2:00→1:00)
    const result = parseLocalDateTimeToEpoch("2026-11-01 01:30", "America/New_York");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain("ambiguous");
    }
  });

  test("rejects invalid timezone", () => {
    const result = parseLocalDateTimeToEpoch("2026-02-06 14:30", "Invalid/Zone");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain("timezone");
    }
  });

  test("rejects out of range values", () => {
    const result = parseLocalDateTimeToEpoch("2026-02-30 14:30", "UTC");
    expect(result.ok).toBe(false);
  });

  test("rejects time with seconds", () => {
    const result = parseLocalDateTimeToEpoch("2026-02-06 14:30:00", "UTC");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("YYYY-MM-DD HH:mm");
    }
  });
});
