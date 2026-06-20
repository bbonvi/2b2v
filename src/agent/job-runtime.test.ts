import { describe, expect, test } from "bun:test";
import { AgentJobStore } from "./job-runtime.ts";

const config = {
  imageTimeoutMs: 300_000,
  imageCancelGraceMs: 60_000,
  terminalVisibleMs: 600_000,
  maxImageReplacements: 2,
};

function enqueue(store: AgentJobStore, overrides: Partial<Parameters<AgentJobStore["enqueueImageJob"]>[0]> = {}) {
  return store.enqueueImageJob({
    guildId: "g1",
    channelId: "c1",
    requesterId: "u1",
    requesterUsername: "alice",
    sourceMessageId: "m1",
    sourceQuote: "make an image",
    prompt: "make an image",
    promptHash: "hash-1",
    imageIds: [],
    outputFormat: "png",
    is4k: false,
    separateJob: false,
    allowsGroupCorrections: false,
    ...overrides,
  });
}

describe("AgentJobStore", () => {
  test("allows duplicate active image jobs while hard dedupe is disabled", () => {
    const store = new AgentJobStore(config);
    const first = enqueue(store);
    const second = enqueue(store);

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.reason).toBe("created");
    expect(second.job.id).not.toBe(first.job.id);
  });

  test("allows explicit separate image jobs", () => {
    const store = new AgentJobStore(config);
    const first = enqueue(store);
    const second = enqueue(store, { separateJob: true, promptHash: "hash-2" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);
  });

  test("tracks source and delivery chats separately", () => {
    const store = new AgentJobStore(config);
    const result = enqueue(store, {
      guildId: "source-guild",
      channelId: "source-chat",
      deliveryGuildId: "delivery-guild",
      deliveryChannelId: "thread-chat",
    });

    expect(result.job.guildId).toBe("source-guild");
    expect(result.job.channelId).toBe("source-chat");
    expect(result.job.deliveryGuildId).toBe("delivery-guild");
    expect(result.job.deliveryChannelId).toBe("thread-chat");
    expect(store.listVisible("source-guild", "source-chat")).toHaveLength(1);
    expect(store.listVisible("delivery-guild", "thread-chat")).toHaveLength(1);
  });

  test("rejects replacement cancellation after grace window", () => {
    const store = new AgentJobStore(config);
    const first = enqueue(store, { now: 1_000 });
    store.start(first.job.id, undefined, 1_000);

    const cancelled = store.cancel(first.job.id, {
      requesterId: "u1",
      reason: "make it blue",
      mode: "replacement",
      now: 70_000,
    });

    expect(cancelled.ok).toBe(false);
    expect(store.get(first.job.id)?.status).toBe("running");
  });

  test("allows group correction cancellation by another participant", () => {
    const store = new AgentJobStore(config);
    const first = enqueue(store, { allowsGroupCorrections: true, now: 1_000 });
    store.start(first.job.id, undefined, 1_000);

    const cancelled = store.cancel(first.job.id, {
      requesterId: "u2",
      reason: "include me too",
      mode: "replacement",
      now: 10_000,
    });

    expect(cancelled.ok).toBe(true);
    expect(store.get(first.job.id)?.status).toBe("cancelled");
  });

  test("allows cancellation by another participant while requester guard is disabled", () => {
    const store = new AgentJobStore(config);
    const first = enqueue(store, { now: 1_000 });
    store.start(first.job.id, undefined, 1_000);

    const cancelled = store.cancel(first.job.id, {
      requesterId: "u2",
      reason: "fix it",
      mode: "replacement",
      now: 10_000,
    });

    expect(cancelled.ok).toBe(true);
    expect(store.get(first.job.id)?.status).toBe("cancelled");
  });

  test("keeps terminal jobs visible only for the configured ttl", () => {
    const store = new AgentJobStore(config);
    const first = enqueue(store, { now: 1_000 });
    store.markFailed(first.job.id, "failed", 2_000);

    expect(store.listVisible("g1", "c1", 2_000 + config.terminalVisibleMs)).toHaveLength(1);
    expect(store.cleanup(2_001 + config.terminalVisibleMs)).toBe(1);
    expect(store.listVisible("g1", "c1", 2_001 + config.terminalVisibleMs)).toHaveLength(0);
  });
});
