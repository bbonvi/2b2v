import { describe, expect, test } from "bun:test";
import { AsyncTaskTracker } from "./async-task-tracker";

describe("AsyncTaskTracker", () => {
  test("drains tasks added while an earlier task is running", async () => {
    const tracker = new AsyncTaskTracker();
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
    void tracker.track(first);

    const draining = tracker.drain();
    void tracker.track(second);
    releaseFirst?.();
    await Promise.resolve();
    expect(tracker.activeCount()).toBe(1);
    releaseSecond?.();
    await draining;

    expect(tracker.activeCount()).toBe(0);
  });

  test("settled failures do not prevent draining", async () => {
    const tracker = new AsyncTaskTracker();
    void tracker.track(Promise.reject(new Error("failed"))).catch(() => {});

    await tracker.drain();

    expect(tracker.activeCount()).toBe(0);
  });
});
