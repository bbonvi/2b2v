import { describe, test, expect } from "bun:test";
import { createChannelDispatcher as createRawChannelDispatcher, selectDispatchMessageForTrigger, selectDispatchMessagesForTrigger, type PendingMessage, type DispatchHandler, type ChannelDispatcher, type DispatcherTimerApi } from "./channel-dispatcher";
import type { TriggerResult } from "../agent/triggers.ts";
import type { DispatcherConfig, TriggerConfig } from "../config/types";

class FakeTimers {
  nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  readonly api: DispatcherTimerApi = {
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

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.api.setTimeout(resolve, ms);
    });
  }

  private async flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  }

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
      await this.flushMicrotasks();
    }
    this.nowMs = end;
    await this.flushMicrotasks();
  }
}

let activeTimers = new FakeTimers();

function createChannelDispatcher(opts: Omit<Parameters<typeof createRawChannelDispatcher>[0], "timers">): ChannelDispatcher {
  activeTimers = new FakeTimers();
  return createRawChannelDispatcher({ ...opts, timers: activeTimers.api });
}

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
    typingResumeGraceMs: 30,
    typingMaxWaitMs: 500,
    ...overrides,
  };
}

let messageCounter = 0;
function makeMessage(channelId: string, id?: string, createdTimestamp?: number, replyToId?: string): unknown {
  messageCounter += 1;
  return {
    channelId,
    id: id ?? `m-${messageCounter}`,
    ...(createdTimestamp !== undefined ? { createdTimestamp } : {}),
    ...(replyToId !== undefined ? { reference: { messageId: replyToId } } : {}),
  };
}

function makePending(
  id: string,
  authorId: string,
  triggerResult: TriggerResult = null,
  receivedAt = 0,
  replyToId?: string,
): PendingMessage {
  return {
    id,
    message: makeMessage("ch-1", id, undefined, replyToId),
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
  return activeTimers.advance(ms);
}

function sleep(ms: number): Promise<void> {
  return activeTimers.sleep(ms);
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

  test("selects same-author mention follow-up as concrete dispatch message", () => {
    const mentioned = makePending("m-mentioned", "user-1", { reason: "mention" }, 1000);
    const followup = makePending("m-followup", "user-1", null, 1001);
    const selected = selectDispatchMessageForTrigger(
      [mentioned, followup],
      { result: { reason: "mention" }, message: mentioned },
    );

    expect(selected?.id).toBe("m-followup");
  });

  test("does not anchor a triggered reply to a same-author message in another reply branch", () => {
    const keyword = makePending("m-keyword", "user-1", { reason: "keyword", keyword: "2b" }, 1000);
    const otherBranch = makePending("m-other-branch", "user-1", null, 1001, "m-other-user");
    const selected = selectDispatchMessageForTrigger(
      [keyword, otherBranch],
      { result: { reason: "keyword", keyword: "2b" }, message: keyword },
    );

    expect(selected?.id).toBe("m-keyword");
  });

  test("does not merge a same-author message that replies into another branch", () => {
    const keyword = makePending("m-keyword", "user-1", { reason: "keyword", keyword: "2b" }, 1000);
    const splitFollowup = makePending("m-split", "user-1", null, 1001);
    const otherBranch = makePending("m-other-branch", "user-1", null, 1002, "m-other-user");
    const selected = selectDispatchMessagesForTrigger(
      [keyword, splitFollowup, otherBranch],
      { result: { reason: "keyword", keyword: "2b" }, message: keyword },
    );

    expect(selected.map((message) => message.id)).toEqual(["m-keyword", "m-split"]);
  });

  test("merges same-author replies that stay on the triggered branch", () => {
    const mention = makePending("m-mention", "user-1", { reason: "mention" }, 1000, "m-bot");
    const sameTarget = makePending("m-same-target", "user-1", null, 1001, "m-bot");
    const chained = makePending("m-chained", "user-1", null, 1002, "m-same-target");
    const selected = selectDispatchMessagesForTrigger(
      [mention, sameTarget, chained],
      { result: { reason: "mention" }, message: mention },
    );

    expect(selected.map((message) => message.id)).toEqual(["m-mention", "m-same-target", "m-chained"]);
  });

  test("selects the current same-author debounce group for mention follow-up turns", () => {
    const before = makePending("m-before", "user-2", null, 999);
    const mentioned = makePending("m-mentioned", "user-1", { reason: "mention" }, 1000);
    const followup = makePending("m-followup", "user-1", null, 1001);
    const selected = selectDispatchMessagesForTrigger(
      [before, mentioned, followup],
      { result: { reason: "mention" }, message: mentioned },
    );

    expect(selected.map((message) => message.id)).toEqual(["m-mentioned", "m-followup"]);
  });

  test("includes same-author queued context before a bare mention", () => {
    const before = makePending("m-before", "user-1", null, 999);
    const mentioned = makePending("m-mentioned", "user-1", { reason: "mention" }, 1000);
    const selected = selectDispatchMessagesForTrigger(
      [before, mentioned],
      { result: { reason: "mention" }, message: mentioned },
    );

    expect(selected.map((message) => message.id)).toEqual(["m-before", "m-mentioned"]);
  });

  test("does not include an earlier handled trigger as queued context", () => {
    const previousTrigger = makePending("m-previous", "user-1", { reason: "mention" }, 998);
    const before = makePending("m-before", "user-1", null, 999);
    const mentioned = makePending("m-mentioned", "user-1", { reason: "mention" }, 1000);
    const selected = selectDispatchMessagesForTrigger(
      [previousTrigger, before, mentioned],
      { result: { reason: "mention" }, message: mentioned },
    );

    expect(selected.map((message) => message.id)).toEqual(["m-before", "m-mentioned"]);
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
        await sleep(60);
        return { coveredMessageIds: [currentId, "m-2"] };
      }
      return { coveredMessageIds: [currentId] };
    };

    const config = makeConfig({ mentionDebounceMs: 20, defaultDebounceMs: 20 });
    const dispatcher = createChannelDispatcher({ config, triggers: makeTriggers({ keywordDebounceMs: 20 }), handler });

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
    const dispatcher = createChannelDispatcher({ config, triggers: makeTriggers({ keywordDebounceMs: 20 }), handler });

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

  test("mention shortens debounce from default to mention timing when typing wait is disabled", async () => {
    const batches: PendingMessage[][] = [];
    const handler: DispatchHandler = (msgs) => { batches.push([...msgs]); return Promise.resolve(undefined); };

    const config = makeConfig({ mentionDebounceMs: 30, defaultDebounceMs: 200 });
    const dispatcher = createChannelDispatcher({ config, triggers: makeTriggers({ typingIdleMs: 0 }), handler });

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

  test("dispatches a divergent same-author reply outside the triggered turn", async () => {
    const calls: Array<{ ids: string[]; trigger: TriggerResult }> = [];
    const handler: DispatchHandler = (msgs, trigger) => {
      calls.push({ ids: msgs.map((message) => message.id), trigger: trigger?.result ?? null });
      return Promise.resolve(undefined);
    };

    const config = makeConfig({ defaultDebounceMs: 20 });
    const triggers = makeTriggers({ keywordDebounceMs: 20, typingIdleMs: 0 });
    const dispatcher = createChannelDispatcher({ config, triggers, handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-key"), { reason: "keyword", keyword: "туби" }, "user-1");
    enqueue(dispatcher, makeMessage("ch-1", "m-split"), null, "user-1");
    enqueue(dispatcher, makeMessage("ch-1", "m-other-branch", undefined, "m-other-user"), null, "user-1");

    await delay(100);

    expect(calls).toEqual([
      { ids: ["m-key", "m-split"], trigger: { reason: "keyword", keyword: "туби" } },
      { ids: ["m-other-branch"], trigger: null },
    ]);

    dispatcher.dispose();
  });

  test("runs multiple triggering messages from one debounce batch in order", async () => {
    const calls: Array<{ ids: string[]; trigger: TriggerResult }> = [];
    const handler: DispatchHandler = (msgs, trigger) => {
      calls.push({ ids: msgs.map((m) => m.id), trigger: trigger?.result ?? null });
      return Promise.resolve({ coveredMessageIds: [msgs[0]?.id ?? ""] });
    };

    const config = makeConfig({ mentionDebounceMs: 20 });
    const dispatcher = createChannelDispatcher({ config, triggers: makeTriggers({ keywordDebounceMs: 20 }), handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-first"), { reason: "mention" }, "user-1");
    enqueue(dispatcher, makeMessage("ch-1", "m-second"), { reason: "mention" }, "user-2");

    await delay(90);

    expect(calls).toEqual([
      { ids: ["m-first"], trigger: { reason: "mention" } },
      { ids: ["m-second"], trigger: { reason: "mention" } },
    ]);

    dispatcher.dispose();
  });

  test("keeps keyword follow-up together without swallowing a later trigger", async () => {
    const calls: Array<{ ids: string[]; trigger: TriggerResult }> = [];
    const handler: DispatchHandler = (msgs, trigger) => {
      calls.push({ ids: msgs.map((m) => m.id), trigger: trigger?.result ?? null });
      return Promise.resolve({ coveredMessageIds: [msgs[0]?.id ?? ""] });
    };

    const config = makeConfig({ mentionDebounceMs: 20 });
    const triggers = makeTriggers({ keywordDebounceMs: 20 });
    const dispatcher = createChannelDispatcher({ config, triggers, handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-key"), { reason: "keyword", keyword: "bot" }, "user-1");
    enqueue(dispatcher, makeMessage("ch-1", "m-followup"), null, "user-1");
    enqueue(dispatcher, makeMessage("ch-1", "m-mention"), { reason: "mention" }, "user-2");

    await delay(100);

    expect(calls).toEqual([
      { ids: ["m-key", "m-followup"], trigger: { reason: "keyword", keyword: "bot" } },
      { ids: ["m-mention"], trigger: { reason: "mention" } },
    ]);

    dispatcher.dispose();
  });

  test("keeps mention follow-up together without swallowing a later trigger", async () => {
    const calls: Array<{ ids: string[]; trigger: TriggerResult }> = [];
    const handler: DispatchHandler = (msgs, trigger) => {
      calls.push({ ids: msgs.map((m) => m.id), trigger: trigger?.result ?? null });
      return Promise.resolve({ coveredMessageIds: [msgs[0]?.id ?? ""] });
    };

    const config = makeConfig({ mentionDebounceMs: 20 });
    const dispatcher = createChannelDispatcher({ config, triggers: makeTriggers({ keywordDebounceMs: 20 }), handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-mention"), { reason: "mention" }, "user-1");
    enqueue(dispatcher, makeMessage("ch-1", "m-followup"), null, "user-1");
    enqueue(dispatcher, makeMessage("ch-1", "m-key"), { reason: "keyword", keyword: "bot" }, "user-2");

    await delay(100);

    expect(calls).toEqual([
      { ids: ["m-mention", "m-followup"], trigger: { reason: "mention" } },
      { ids: ["m-key"], trigger: { reason: "keyword", keyword: "bot" } },
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

  test("typing just before enqueue still delays a newer trigger message", async () => {
    let callCount = 0;
    const handler: DispatchHandler = () => {
      callCount++;
      return Promise.resolve(undefined);
    };

    const config = makeConfig({ defaultDebounceMs: 200 });
    const triggers = makeTriggers({ keywordDebounceMs: 20, typingIdleMs: 80, typingMaxWaitMs: 300 });
    const dispatcher = createChannelDispatcher({ config, triggers, handler });

    dispatcher.recordTyping("ch-1", "user-1");
    await delay(5);
    enqueue(dispatcher, makeMessage("ch-1", "m-key", activeTimers.nowMs - 20), { reason: "keyword", keyword: "туби" }, "user-1");

    await delay(50);
    expect(callCount).toBe(0);

    await delay(60);
    expect(callCount).toBe(1);

    dispatcher.dispose();
  });

  test("same-author keyword follow-up does not extend wait without typing", async () => {
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
    enqueue(dispatcher, makeMessage("ch-1", "m-followup"), null, "user-1");

    await delay(50);
    expect(callCount).toBe(1);

    dispatcher.dispose();
  });

  test("recent typing before same-author follow-up gets resume grace", async () => {
    let callCount = 0;
    const handler: DispatchHandler = () => {
      callCount++;
      return Promise.resolve(undefined);
    };

    const config = makeConfig({ defaultDebounceMs: 200 });
    const triggers = makeTriggers({ keywordDebounceMs: 20, typingIdleMs: 80, typingResumeGraceMs: 60, typingMaxWaitMs: 300 });
    const dispatcher = createChannelDispatcher({ config, triggers, handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-key"), { reason: "keyword", keyword: "туби" }, "user-1");
    await delay(5);
    dispatcher.recordTyping("ch-1", "user-1");
    await delay(5);
    enqueue(dispatcher, makeMessage("ch-1", "m-followup"), null, "user-1");

    await delay(45);
    expect(callCount).toBe(0);

    await delay(40);
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

  test("waits for mention triggering user to stop typing after short mention debounce window", async () => {
    let callCount = 0;
    const handler: DispatchHandler = () => {
      callCount++;
      return Promise.resolve(undefined);
    };

    const config = makeConfig({ mentionDebounceMs: 20, defaultDebounceMs: 200 });
    const triggers = makeTriggers({ keywordDebounceMs: 80, typingIdleMs: 50, typingMaxWaitMs: 200 });
    const dispatcher = createChannelDispatcher({ config, triggers, handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-mention"), { reason: "mention" }, "user-1");
    await delay(40);
    expect(callCount).toBe(0);
    dispatcher.recordTyping("ch-1", "user-1");

    await delay(30);
    expect(callCount).toBe(0);

    await delay(40);
    expect(callCount).toBe(1);

    dispatcher.dispose();
  });

  test("same-author mention follow-up does not extend wait without typing", async () => {
    const calls: Array<{ ids: string[]; trigger: TriggerResult }> = [];
    const handler: DispatchHandler = (msgs, trigger) => {
      calls.push({ ids: msgs.map((m) => m.id), trigger: trigger?.result ?? null });
      return Promise.resolve(undefined);
    };

    const config = makeConfig({ mentionDebounceMs: 20, defaultDebounceMs: 200 });
    const triggers = makeTriggers({ keywordDebounceMs: 20, typingIdleMs: 80, typingMaxWaitMs: 300 });
    const dispatcher = createChannelDispatcher({ config, triggers, handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-mention"), { reason: "mention" }, "user-1");
    await delay(5);
    enqueue(dispatcher, makeMessage("ch-1", "m-followup"), null, "user-1");

    await delay(50);
    expect(calls).toEqual([
      { ids: ["m-mention", "m-followup"], trigger: { reason: "mention" } },
    ]);

    dispatcher.dispose();
  });

  test("real typing after same-author follow-up still extends wait", async () => {
    let callCount = 0;
    const handler: DispatchHandler = () => {
      callCount++;
      return Promise.resolve(undefined);
    };

    const config = makeConfig({ mentionDebounceMs: 20, defaultDebounceMs: 200 });
    const triggers = makeTriggers({ keywordDebounceMs: 20, typingIdleMs: 80, typingMaxWaitMs: 300 });
    const dispatcher = createChannelDispatcher({ config, triggers, handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-mention"), { reason: "mention" }, "user-1");
    await delay(5);
    enqueue(dispatcher, makeMessage("ch-1", "m-followup"), null, "user-1");
    await delay(5);
    dispatcher.recordTyping("ch-1", "user-1");

    await delay(50);
    expect(callCount).toBe(0);

    await delay(70);
    expect(callCount).toBe(1);

    dispatcher.dispose();
  });

  test("typing max wait is capped from latest same-author follow-up", async () => {
    let callCount = 0;
    const handler: DispatchHandler = () => {
      callCount++;
      return Promise.resolve(undefined);
    };

    const config = makeConfig({ mentionDebounceMs: 20, defaultDebounceMs: 200 });
    const triggers = makeTriggers({ keywordDebounceMs: 20, typingIdleMs: 120, typingResumeGraceMs: 60, typingMaxWaitMs: 70 });
    const dispatcher = createChannelDispatcher({ config, triggers, handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-mention"), { reason: "mention" }, "user-1");
    await delay(5);
    dispatcher.recordTyping("ch-1", "user-1");
    await delay(45);
    enqueue(dispatcher, makeMessage("ch-1", "m-followup"), null, "user-1");
    await delay(10);
    dispatcher.recordTyping("ch-1", "user-1");

    await delay(35);
    expect(callCount).toBe(0);

    await delay(50);
    expect(callCount).toBe(1);

    dispatcher.dispose();
  });

  test("typing by other users does not delay mention trigger", async () => {
    let callCount = 0;
    const handler: DispatchHandler = () => {
      callCount++;
      return Promise.resolve(undefined);
    };

    const config = makeConfig({ mentionDebounceMs: 20, defaultDebounceMs: 200 });
    const triggers = makeTriggers({ keywordDebounceMs: 20, typingIdleMs: 80, typingMaxWaitMs: 300 });
    const dispatcher = createChannelDispatcher({ config, triggers, handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-mention"), { reason: "mention" }, "user-1");
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
      await sleep(80);
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
      await sleep(60);
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
      if (batches.length === 1) await sleep(100);
      return undefined;
    };

    const config = makeConfig({ mentionDebounceMs: 20, defaultDebounceMs: 20 });
    const dispatcher = createChannelDispatcher({ config, triggers: makeTriggers({ keywordDebounceMs: 20 }), handler });

    enqueue(dispatcher, makeMessage("ch-1", "m-1"), { reason: "mention" });
    await delay(30);

    enqueue(dispatcher, makeMessage("ch-1", "m-queued"), { reason: "keyword", keyword: "bot" });
    await delay(30);

    enqueue(dispatcher, makeMessage("ch-1", "m-late"), { reason: "mention" });
    await delay(180);

    expect(batches.map((batch) => batch.map((message) => message.id))).toEqual([
      ["m-1"],
      ["m-queued"],
      ["m-late"],
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

  test("drain flushes debounce work and refuses later enqueues", async () => {
    const batches: string[][] = [];
    const dispatcher = createChannelDispatcher({
      config: makeConfig({ defaultDebounceMs: 10_000 }),
      triggers: makeTriggers(),
      handler: (messages) => {
        batches.push(messages.map((message) => message.id));
        return Promise.resolve(undefined);
      },
    });
    enqueue(dispatcher, makeMessage("ch-1", "pending"));

    await dispatcher.drain();

    expect(batches).toEqual([["pending"]]);
    expect(dispatcher.enqueue(makeMessage("ch-1", "late"), {
      authorId: "user-1",
      triggerResult: { reason: "mention" },
    })).toBe(false);
    dispatcher.dispose();
  });

  test("drain waits for running work and processes messages queued behind it", async () => {
    const batches: string[][] = [];
    let releaseFirst: (() => void) | undefined;
    const dispatcher = createChannelDispatcher({
      config: makeConfig({ defaultDebounceMs: 20 }),
      triggers: makeTriggers(),
      handler: (messages) => {
        batches.push(messages.map((message) => message.id));
        if (batches.length !== 1) return Promise.resolve(undefined);
        return new Promise((resolve) => { releaseFirst = () => resolve(undefined); });
      },
    });
    enqueue(dispatcher, makeMessage("ch-1", "running"));
    await activeTimers.advance(20);
    enqueue(dispatcher, makeMessage("ch-1", "queued"));

    const draining = dispatcher.drain();
    await Promise.resolve();
    expect(batches).toEqual([["running"]]);
    releaseFirst?.();
    await draining;

    expect(batches).toEqual([["running"], ["queued"]]);
    dispatcher.dispose();
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
