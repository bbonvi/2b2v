import { describe, test, expect } from "bun:test";
import { createChannelDispatcher, selectDispatchMessageForTrigger, type PendingMessage, type DispatchHandler, type ChannelDispatcher } from "./channel-dispatcher";
import type { TriggerResult } from "../agent/triggers.ts";
import type { DispatcherConfig, TriggerConfig } from "../config/types";

function makeConfig(overrides: Partial<DispatcherConfig> = {}): DispatcherConfig {
  return {
    enabled: true,
    mentionDebounceMs: 50,
    defaultDebounceMs: 100,
    ...overrides,
  };
}

function makeTriggers(overrides: Partial<TriggerConfig> = {}): TriggerConfig {
  return {
    mention: true,
    keywords: [],
    randomChance: 0,
    keywordDebounceMs: 80,
    typingIdleMs: 50,
    typingMaxWaitMs: 500,
    ...overrides,
  };
}

let messageCounter = 0;
function makeMessage(channelId: string, id?: string): unknown {
  messageCounter += 1;
  return { channelId, id: id ?? `m-${messageCounter}` };
}

function makePending(
  id: string,
  authorId: string,
  triggerResult: TriggerResult = null,
  receivedAt = Date.now(),
): PendingMessage {
  return {
    id,
    message: makeMessage("ch-1", id),
    receivedAt,
    authorId,
    triggerResult,
  };
}

function enqueue(
  dispatcher: ChannelDispatcher,
  message: unknown,
  triggerResult: TriggerResult = null,
  authorId = "user-1",
): void {
  dispatcher.enqueue(message, { authorId, triggerResult });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createChannelDispatcher", () => {
  test("selects the mentioned message instead of unrelated later batch chatter", () => {
    const mentioned = makePending("m-mentioned", "user-1", { reason: "mention" }, 1000);
    const unrelated = makePending("m-unrelated", "user-2", null, 1001);
    const selected = selectDispatchMessageForTrigger(
      [mentioned, unrelated],
      { result: { reason: "mention" }, message: mentioned },
    );

    expect(selected?.id).toBe("m-mentioned");
  });

  test("keeps mention replies pinned to the mentioned message despite same-author follow-up", () => {
    const mentioned = makePending("m-mentioned", "user-1", { reason: "mention" }, 1000);
    const followup = makePending("m-followup", "user-1", null, 1001);
    const selected = selectDispatchMessageForTrigger(
      [mentioned, followup],
      { result: { reason: "mention" }, message: mentioned },
    );

    expect(selected?.id).toBe("m-mentioned");
  });

  test("selects the randomly triggered message instead of latest batch message", () => {
    const random = makePending("m-random", "user-1", { reason: "random" }, 1000);
    const later = makePending("m-later", "user-2", null, 1001);
    const selected = selectDispatchMessageForTrigger(
      [random, later],
      { result: { reason: "random" }, message: random },
    );

    expect(selected?.id).toBe("m-random");
  });

  test("suppresses queued messages that were already surfaced during current run", async () => {
    let callCount = 0;
    const handler: DispatchHandler = async (msgs) => {
      callCount++;
      const currentId = (msgs[0] as PendingMessage).id;
      if (callCount === 1) {
        await delay(60);
        return { coveredMessageIds: [currentId, "m-2"] };
      }
      return { coveredMessageIds: [currentId] };
    };

    const config = makeConfig({ mentionDebounceMs: 20, defaultDebounceMs: 20 });
    const dispatcher = createChannelDispatcher({ config, triggers: makeTriggers(), handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-1"), { reason: "mention" });
    await delay(30); // first handler starts

    // Arrives while first handler is running, should be queued then suppressed.
    enqueue(dispatcher, makeMessage("ch-1", "m-2"), { reason: "mention" });

    await delay(160);

    expect(callCount).toBe(1);
    dispatcher.dispose();
  });

  test("ignores late enqueue for message IDs already suppressed", async () => {
    let callCount = 0;
    const handler: DispatchHandler = (msgs) => {
      callCount++;
      const currentId = (msgs[0] as PendingMessage).id;
      return Promise.resolve({ coveredMessageIds: [currentId, "m-late"] });
    };

    const config = makeConfig({ mentionDebounceMs: 20, defaultDebounceMs: 20 });
    const dispatcher = createChannelDispatcher({ config, triggers: makeTriggers(), handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-1"), { reason: "mention" });
    await delay(60);

    // Simulates delayed enqueue (e.g., slower upstream work before dispatcher enqueue).
    enqueue(dispatcher, makeMessage("ch-1", "m-late"), { reason: "mention" });
    await delay(60);

    expect(callCount).toBe(1);
    dispatcher.dispose();
  });

  test("fires handler after debounce with accumulated messages", async () => {
    const batches: PendingMessage[][] = [];
    const handler: DispatchHandler = (msgs) => { batches.push([...msgs]); return Promise.resolve(undefined); };

    const dispatcher = createChannelDispatcher({ config: makeConfig(), triggers: makeTriggers(), handler });

    enqueue(dispatcher, makeMessage("ch-1"));
    enqueue(dispatcher, makeMessage("ch-1"));

    // Wait for debounce to fire
    await delay(150);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);

    dispatcher.dispose();
  });

  test("mention shortens debounce from default to mention timing", async () => {
    const batches: PendingMessage[][] = [];
    const handler: DispatchHandler = (msgs) => { batches.push([...msgs]); return Promise.resolve(undefined); };

    const config = makeConfig({ mentionDebounceMs: 30, defaultDebounceMs: 200 });
    const dispatcher = createChannelDispatcher({ config, triggers: makeTriggers(), handler });

    // First message starts default debounce
    enqueue(dispatcher, makeMessage("ch-1"));

    // Mention arrives shortly after, should shorten debounce
    await delay(10);
    enqueue(dispatcher, makeMessage("ch-1"), { reason: "mention" });

    // After mention debounce but before default debounce
    await delay(50);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);

    dispatcher.dispose();
  });

  test("passes keyword trigger from earlier message when latest batch message is untriggered", async () => {
    const calls: Array<{ ids: string[]; trigger: TriggerResult }> = [];
    const handler: DispatchHandler = (msgs, trigger) => {
      calls.push({ ids: msgs.map((m) => m.id), trigger: trigger?.result ?? null });
      return Promise.resolve(undefined);
    };

    const config = makeConfig({ defaultDebounceMs: 200 });
    const triggers = makeTriggers({ keywordDebounceMs: 20 });
    const dispatcher = createChannelDispatcher({ config, triggers, handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-key"), { reason: "keyword", keyword: "туби" }, "user-1");
    enqueue(dispatcher, makeMessage("ch-1", "m-followup"), null, "user-1");

    await delay(70);

    expect(calls).toEqual([
      { ids: ["m-key", "m-followup"], trigger: { reason: "keyword", keyword: "туби" } },
    ]);

    dispatcher.dispose();
  });

  test("waits for keyword triggering user to stop typing", async () => {
    let callCount = 0;
    const handler: DispatchHandler = () => {
      callCount++;
      return Promise.resolve(undefined);
    };

    const config = makeConfig({ defaultDebounceMs: 200 });
    const triggers = makeTriggers({ keywordDebounceMs: 20, typingIdleMs: 50, typingMaxWaitMs: 200 });
    const dispatcher = createChannelDispatcher({ config, triggers, handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-key"), { reason: "keyword", keyword: "туби" }, "user-1");
    await delay(5);
    dispatcher.recordTyping("ch-1", "user-1");

    await delay(35);
    expect(callCount).toBe(0);

    await delay(60);
    expect(callCount).toBe(1);

    dispatcher.dispose();
  });

  test("message from triggering user clears typing wait until typing starts again", async () => {
    let callCount = 0;
    const handler: DispatchHandler = () => {
      callCount++;
      return Promise.resolve(undefined);
    };

    const config = makeConfig({ defaultDebounceMs: 200 });
    const triggers = makeTriggers({ keywordDebounceMs: 20, typingIdleMs: 80, typingMaxWaitMs: 300 });
    const dispatcher = createChannelDispatcher({ config, triggers, handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-key"), { reason: "keyword", keyword: "туби" }, "user-1");
    await delay(5);
    dispatcher.recordTyping("ch-1", "user-1");
    await delay(5);
    enqueue(dispatcher, makeMessage("ch-1", "m-followup"), null, "user-1");

    await delay(50);
    expect(callCount).toBe(1);

    dispatcher.dispose();
  });

  test("typing by other users does not delay keyword trigger", async () => {
    let callCount = 0;
    const handler: DispatchHandler = () => {
      callCount++;
      return Promise.resolve(undefined);
    };

    const config = makeConfig({ defaultDebounceMs: 200 });
    const triggers = makeTriggers({ keywordDebounceMs: 20, typingIdleMs: 80, typingMaxWaitMs: 300 });
    const dispatcher = createChannelDispatcher({ config, triggers, handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-key"), { reason: "keyword", keyword: "туби" }, "user-1");
    dispatcher.recordTyping("ch-1", "user-2");

    await delay(50);
    expect(callCount).toBe(1);

    dispatcher.dispose();
  });

  test("serializes handler execution per channel", async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const batches: PendingMessage[][] = [];

    const handler: DispatchHandler = async (msgs): Promise<undefined> => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      batches.push([...msgs]);
      await delay(80);
      concurrentCount--;
      return undefined;
    };

    const config = makeConfig({ defaultDebounceMs: 20 });
    const dispatcher = createChannelDispatcher({ config, triggers: makeTriggers(), handler });

    // First message
    enqueue(dispatcher, makeMessage("ch-1"));

    // Wait for debounce to fire and handler to start
    await delay(40);

    // Second message arrives during handler execution
    enqueue(dispatcher, makeMessage("ch-1"));

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
      return Promise.resolve(undefined);
    };

    const config = makeConfig({ defaultDebounceMs: 30 });
    const dispatcher = createChannelDispatcher({ config, triggers: makeTriggers(), handler });

    enqueue(dispatcher, makeMessage("ch-1"));
    enqueue(dispatcher, makeMessage("ch-2"));

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

    const handler: DispatchHandler = async (msgs): Promise<undefined> => {
      batches.push([...msgs]);
      await delay(60);
      return undefined;
    };

    const config = makeConfig({ defaultDebounceMs: 20 });
    const dispatcher = createChannelDispatcher({ config, triggers: makeTriggers(), handler });

    // First message triggers handler
    enqueue(dispatcher, makeMessage("ch-1"));

    // Wait for debounce, handler starts
    await delay(30);

    // These arrive during handler execution
    enqueue(dispatcher, makeMessage("ch-1"));
    enqueue(dispatcher, makeMessage("ch-1"));

    // Wait for first handler + debounce + second handler
    await delay(200);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(1);
    expect(batches[1]).toHaveLength(2);

    dispatcher.dispose();
  });

  test("does not drop late pending messages when queued messages already exist", async () => {
    const batches: PendingMessage[][] = [];

    const handler: DispatchHandler = async (msgs): Promise<undefined> => {
      batches.push([...msgs]);
      if (batches.length === 1) await delay(100);
      return undefined;
    };

    const config = makeConfig({ mentionDebounceMs: 20, defaultDebounceMs: 20 });
    const dispatcher = createChannelDispatcher({ config, triggers: makeTriggers(), handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-1"), { reason: "mention" });
    await delay(30);

    enqueue(dispatcher, makeMessage("ch-1", "m-queued"), { reason: "keyword", keyword: "bot" });
    await delay(30);

    enqueue(dispatcher, makeMessage("ch-1", "m-late"), { reason: "mention" });
    await delay(180);

    expect(batches.map((batch) => batch.map((message) => message.id))).toEqual([
      ["m-1"],
      ["m-queued", "m-late"],
    ]);

    dispatcher.dispose();
  });

  test("dispose clears all timers", async () => {
    const batches: PendingMessage[][] = [];
    const handler: DispatchHandler = (msgs) => { batches.push([...msgs]); return Promise.resolve(undefined); };

    const dispatcher = createChannelDispatcher({ config: makeConfig(), triggers: makeTriggers(), handler });

    enqueue(dispatcher, makeMessage("ch-1"));
    dispatcher.dispose();

    await delay(150);

    expect(batches).toHaveLength(0);
  });

  test("handler errors do not break serialization", async () => {
    let callCount = 0;
    const handler: DispatchHandler = (_msgs) => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("handler failed"));
      return Promise.resolve(undefined);
    };

    const config = makeConfig({ defaultDebounceMs: 20 });
    const dispatcher = createChannelDispatcher({ config, triggers: makeTriggers(), handler });

    // First message - handler will throw
    enqueue(dispatcher, makeMessage("ch-1"));

    await delay(40);

    // Second message - should still work
    enqueue(dispatcher, makeMessage("ch-1"));

    await delay(60);

    expect(callCount).toBe(2);

    dispatcher.dispose();
  });
});
