import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database.ts";
import { getHistoryMessagesByIds } from "../db/message-repository.ts";
import { AgentJobStore } from "./job-runtime.ts";

const config = {
  imageTimeoutMs: 300_000,
  imageCancelGraceMs: 60_000,
  terminalVisibleMs: 600_000,
  maxImageReplacements: 2,
};

let db: Database;
let store: AgentJobStore;

beforeEach(() => {
  db = createDatabase(":memory:");
  store = new AgentJobStore(db, config);
});

afterEach(() => {
  db.close();
});

function enqueue(store: AgentJobStore, overrides: Partial<Parameters<AgentJobStore["enqueueImageJob"]>[0]> = {}) {
  return store.enqueueImageJob({
    guildId: "g1",
    channelId: "c1",
    requesterId: "u1",
    requesterUsername: "alice",
    sourceMessageId: "m1",
    sourceQuote: "make an image",
    prompt: "make an image",
    references: [],
    outputFormat: "png",
    is4k: false,
    ...overrides,
  });
}

describe("AgentJobStore", () => {
  test("allows independent active image jobs", () => {
    const first = enqueue(store);
    const second = enqueue(store);

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.reason).toBe("created");
    expect(second.job.id).not.toBe(first.job.id);
  });

  test("allows another image job with different input", () => {
    const first = enqueue(store);
    const second = enqueue(store, { prompt: "make another image" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);
  });

  test("retains ordered image references for the worker", () => {
    const references = [
      { type: "avatar" as const, userId: "123456789012345678" },
      { type: "url" as const, url: "https://example.com/reference.gif" },
    ];
    const result = enqueue(store, { references });
    expect(result.job.input.references).toEqual(references);
  });

  test("tracks source and delivery channels separately", () => {
    const result = enqueue(store, {
      guildId: "source-guild",
      channelId: "source-channel",
      deliveryGuildId: "delivery-guild",
      deliveryChannelId: "thread-channel",
    });

    expect(result.job.guildId).toBe("source-guild");
    expect(result.job.channelId).toBe("source-channel");
    expect(result.job.deliveryGuildId).toBe("delivery-guild");
    expect(result.job.deliveryChannelId).toBe("thread-channel");
    expect(store.listVisible("source-guild", "source-channel")).toHaveLength(1);
    expect(store.listVisible("delivery-guild", "thread-channel")).toHaveLength(1);
  });

  test("renders cross-channel delivery annotations with channel_id", () => {
    const result = enqueue(store, {
      guildId: "source-guild",
      channelId: "source-channel",
      deliveryGuildId: "delivery-guild",
      deliveryChannelId: "thread-channel",
    });

    expect(store.annotationForMessage("m1", "source-guild", "source-channel")).toEqual([
      `ImageJob: ${result.job.id} queued -> channel_id thread-channel`,
    ]);
  });

  test("rejects replacement cancellation after grace window", () => {
    const first = enqueue(store, { now: 1_000 });
    store.start(first.job.id, undefined, 1_000);

    const cancelled = store.cancel(first.job.id, {
      reason: "make it blue",
      mode: "replacement",
      now: 70_000,
    });

    expect(cancelled.ok).toBe(false);
    expect(store.get(first.job.id)?.status).toBe("running");
  });

  test("allows model-selected cancellation without requester authorization", () => {
    const first = enqueue(store, { now: 1_000 });
    store.start(first.job.id, undefined, 1_000);

    const cancelled = store.cancel(first.job.id, {
      reason: "include me too",
      mode: "replacement",
      now: 10_000,
    });

    expect(cancelled.ok).toBe(true);
    expect(store.get(first.job.id)?.status).toBe("dismissed");
  });

  test("keeps terminal jobs durable after the prompt visibility ttl", () => {
    const first = enqueue(store, { now: 1_000 });
    store.markFailed(first.job.id, "failed", 2_000);

    expect(store.listVisible("g1", "c1", 2_000 + config.terminalVisibleMs)).toHaveLength(1);
    expect(store.listVisible("g1", "c1", 2_001 + config.terminalVisibleMs)).toHaveLength(0);
    expect(store.get(first.job.id)?.status).toBe("failed");
    expect(store.list("g1", "c1", "terminal")).toHaveLength(1);
  });

  test("marks active jobs interrupted by a process restart as failed", () => {
    const first = enqueue(store, { now: 1_000 });
    store.start(first.job.id, undefined, 1_100);

    const restartedStore = new AgentJobStore(db, config);

    expect(restartedStore.get(first.job.id)).toMatchObject({
      status: "failed",
      error: "Interrupted before completion by a process restart.",
    });
  });

  test("persists generated asset provenance across store instances", () => {
    const job = enqueue(store).job;
    db.raw.prepare(`INSERT INTO messages
      (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
      VALUES ('sent-1', 'g1', 'c1', 'bot', '2b', '', '', 1, 1)`).run();
    db.raw.prepare(`INSERT INTO message_assets
      (message_id, guild_id, channel_id, source_kind, source_key, kind, filename, created_at)
      VALUES ('sent-1', 'g1', 'c1', 'attachment', 'discord-asset', 'image', 'generated.webp', 1)`).run();
    const assetId = (db.raw.prepare("SELECT id FROM message_assets WHERE message_id = 'sent-1'").get() as { id: number }).id;

    store.linkAsset(job.id, assetId);
    store.start(job.id, undefined, 1_500);
    store.markReady(job.id, { filename: "generated.webp" }, 1_900);
    store.markDelivered(job.id, "sent-1", { filename: "generated.webp" }, 2_000);
    const restartedStore = new AgentJobStore(db, config);

    expect(restartedStore.getForAsset(assetId)).toMatchObject({
      role: "output",
      job: { id: job.id, input: { prompt: "make an image" } },
    });
    expect(getHistoryMessagesByIds(db, ["sent-1"])[0]?.assets?.[0]?.jobId).toBe(job.id);
    expect(restartedStore.cleanup(31 * 24 * 60 * 60 * 1000)).toBe(0);
    expect(restartedStore.get(job.id)?.status).toBe("delivered");
  });

  test("removes unlinked terminal jobs after 30 days", () => {
    const job = enqueue(store, { now: 1_000 }).job;
    store.markFailed(job.id, "failed", 2_000);

    expect(store.cleanup(31 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(store.get(job.id)).toBeUndefined();
  });
});
