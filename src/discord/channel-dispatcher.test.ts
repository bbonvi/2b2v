import { describe, test, expect } from "bun:test";
import { createChannelDispatcher, type PendingMessage, type DispatchHandler } from "./channel-dispatcher";
import type { DispatcherConfig } from "../config/types";

function makeConfig(overrides: Partial<DispatcherConfig> = {}): DispatcherConfig {
  return {
    enabled: true,
    mentionDebounceMs: 50,
    defaultDebounceMs: 100,
    maxFollowUps: 5,
    ...overrides,
  };
}

function makeMessage(channelId: string): unknown {
  return { channelId };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createChannelDispatcher", () => {
  test("fires handler after debounce with accumulated messages", async () => {
    const batches: PendingMessage[][] = [];
    const handler: DispatchHandler = (msgs) => { batches.push([...msgs]); return Promise.resolve(); };

    const dispatcher = createChannelDispatcher({ config: makeConfig(), handler });

    dispatcher.enqueue(makeMessage("ch-1"), false);
    dispatcher.enqueue(makeMessage("ch-1"), false);

    // Wait for debounce to fire
    await delay(150);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);

    dispatcher.dispose();
  });

  test("mention shortens debounce from default to mention timing", async () => {
    const batches: PendingMessage[][] = [];
    const handler: DispatchHandler = (msgs) => { batches.push([...msgs]); return Promise.resolve(); };

    const config = makeConfig({ mentionDebounceMs: 30, defaultDebounceMs: 200 });
    const dispatcher = createChannelDispatcher({ config, handler });

    // First message starts default debounce
    dispatcher.enqueue(makeMessage("ch-1"), false);

    // Mention arrives shortly after, should shorten debounce
    await delay(10);
    dispatcher.enqueue(makeMessage("ch-1"), true);

    // After mention debounce but before default debounce
    await delay(50);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);

    dispatcher.dispose();
  });

  test("serializes handler execution per channel", async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const batches: PendingMessage[][] = [];

    const handler: DispatchHandler = async (msgs) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      batches.push([...msgs]);
      await delay(80);
      concurrentCount--;
    };

    const config = makeConfig({ defaultDebounceMs: 20 });
    const dispatcher = createChannelDispatcher({ config, handler });

    // First message
    dispatcher.enqueue(makeMessage("ch-1"), false);

    // Wait for debounce to fire and handler to start
    await delay(40);

    // Second message arrives during handler execution
    dispatcher.enqueue(makeMessage("ch-1"), false);

    // Wait for everything to complete
    await delay(200);

    expect(maxConcurrent).toBe(1);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(1);
    expect(batches[1]).toHaveLength(1);

    dispatcher.dispose();
  });

  test("different channels run independently", async () => {
    const batches: { channelId: string; count: number }[] = [];

    const handler: DispatchHandler = (msgs) => {
      const channelId = ((msgs[0] as PendingMessage).message as { channelId: string }).channelId;
      batches.push({ channelId, count: msgs.length });
      return Promise.resolve();
    };

    const config = makeConfig({ defaultDebounceMs: 30 });
    const dispatcher = createChannelDispatcher({ config, handler });

    dispatcher.enqueue(makeMessage("ch-1"), false);
    dispatcher.enqueue(makeMessage("ch-2"), false);

    await delay(60);

    expect(batches).toHaveLength(2);
    const ch1 = batches.find((b) => b.channelId === "ch-1");
    const ch2 = batches.find((b) => b.channelId === "ch-2");
    expect(ch1).toBeDefined();
    expect(ch2).toBeDefined();

    dispatcher.dispose();
  });

  test("queued messages form new batch after handler completes", async () => {
    const batches: PendingMessage[][] = [];

    const handler: DispatchHandler = async (msgs) => {
      batches.push([...msgs]);
      await delay(60);
    };

    const config = makeConfig({ defaultDebounceMs: 20 });
    const dispatcher = createChannelDispatcher({ config, handler });

    // First message triggers handler
    dispatcher.enqueue(makeMessage("ch-1"), false);

    // Wait for debounce, handler starts
    await delay(30);

    // These arrive during handler execution
    dispatcher.enqueue(makeMessage("ch-1"), false);
    dispatcher.enqueue(makeMessage("ch-1"), false);

    // Wait for first handler + debounce + second handler
    await delay(200);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(1);
    expect(batches[1]).toHaveLength(2);

    dispatcher.dispose();
  });

  test("dispose clears all timers", async () => {
    const batches: PendingMessage[][] = [];
    const handler: DispatchHandler = (msgs) => { batches.push([...msgs]); return Promise.resolve(); };

    const dispatcher = createChannelDispatcher({ config: makeConfig(), handler });

    dispatcher.enqueue(makeMessage("ch-1"), false);
    dispatcher.dispose();

    await delay(150);

    expect(batches).toHaveLength(0);
  });

  test("handler errors do not break serialization", async () => {
    let callCount = 0;
    const handler: DispatchHandler = (_msgs) => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("handler failed"));
      return Promise.resolve();
    };

    const config = makeConfig({ defaultDebounceMs: 20 });
    const dispatcher = createChannelDispatcher({ config, handler });

    // First message - handler will throw
    dispatcher.enqueue(makeMessage("ch-1"), false);

    await delay(40);

    // Second message - should still work
    dispatcher.enqueue(makeMessage("ch-1"), false);

    await delay(60);

    expect(callCount).toBe(2);

    dispatcher.dispose();
  });
});
