import { describe, expect, test } from "bun:test";
import { activeEpochWindow, nextEpochWindow, randomStartInWindows } from "./windows.ts";

describe("persona mode local-time windows", () => {
  test("resolves cross-midnight active and next windows", () => {
    const windows = [{ start: "23:00", end: "08:00" }];
    const activeAt = Date.UTC(2026, 0, 2, 2, 0);
    const active = activeEpochWindow(windows, "UTC", activeAt);
    expect(active).toEqual({
      startAt: Date.UTC(2026, 0, 1, 23, 0),
      endAt: Date.UTC(2026, 0, 2, 8, 0),
    });
    expect(nextEpochWindow(windows, "UTC", activeAt)?.startAt).toBe(Date.UTC(2026, 0, 2, 23, 0));
  });

  test("chooses a persisted episode start that leaves room for its duration", () => {
    const slot = randomStartInWindows(
      [{ start: "12:00", end: "13:00" }],
      "UTC",
      Date.UTC(2026, 0, 2, 0, 0),
      Date.UTC(2026, 0, 2, 23, 0),
      10 * 60_000,
      () => 0,
    );
    expect(slot?.startsAt).toBe(Date.UTC(2026, 0, 2, 12, 0));
    expect(slot?.windowEndsAt).toBe(Date.UTC(2026, 0, 2, 13, 0));
  });
});
