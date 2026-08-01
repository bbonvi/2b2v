import { expect, test } from "bun:test";
import { createChannelDispatcher } from "./channel-dispatcher.ts";

test("queued user messages run before background tasks", async () => {
  const order: string[] = [];
  const dispatcher = createChannelDispatcher({
    config: { enabled: true, mentionDebounceMs: 1_000, defaultDebounceMs: 1_000 },
    triggers: {
      mention: true,
      keywords: [],
      randomChance: 0,
      keywordDebounceMs: 1_000,
      typingIdleMs: 0,
      typingResumeGraceMs: 0,
      typingMaxWaitMs: 0,
    },
    handler: () => {
      order.push("message");
      return Promise.resolve(undefined);
    },
  });
  dispatcher.enqueue({ channelId: "c1", id: "m1" }, {
    authorId: "u1",
    triggerResult: { reason: "mention" },
  });
  dispatcher.enqueueTask("c1", () => {
    order.push("task");
    return Promise.resolve();
  });

  await dispatcher.drain();

  expect(order).toEqual(["message", "task"]);
  dispatcher.dispose();
});

test("a message arriving during a background task runs after it", async () => {
  const order: string[] = [];
  let release: (() => void) | undefined;
  const dispatcher = createChannelDispatcher({
    config: { enabled: true, mentionDebounceMs: 0, defaultDebounceMs: 0 },
    triggers: {
      mention: true,
      keywords: [],
      randomChance: 0,
      keywordDebounceMs: 0,
      typingIdleMs: 0,
      typingResumeGraceMs: 0,
      typingMaxWaitMs: 0,
    },
    handler: () => {
      order.push("message");
      return Promise.resolve(undefined);
    },
  });
  dispatcher.enqueueTask("c1", () => new Promise<void>((resolve) => {
    order.push("task");
    release = resolve;
  }));
  dispatcher.enqueue({ channelId: "c1", id: "m1" }, {
    authorId: "u1",
    triggerResult: { reason: "mention" },
  });
  await new Promise((resolve) => setTimeout(resolve, 1));
  release?.();

  await dispatcher.drain();

  expect(order).toEqual(["task", "message"]);
  dispatcher.dispose();
});
