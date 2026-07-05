import { test, expect, describe, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { createQdrantClient, ensureCollection, qdrantCollectionName } from "../qdrant/client";
import { pointExists, searchPoints } from "../qdrant/adapter";
import { createEmbeddingQueue, type EmbeddingQueue } from "./queue";
import { createMockPipeline } from "./test-utils";
import type { EmbeddingPipeline } from "./pipeline";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://qdrant-test.orb.local:6333";
const TEST_COLLECTION = `embeddings_queue_${String(process.pid)}`;

let qdrant: QdrantClient;
let pipe: EmbeddingPipeline;
let queue: EmbeddingQueue;

beforeAll(async () => {
  qdrant = createQdrantClient({ url: QDRANT_URL, collectionName: TEST_COLLECTION });
  try { await qdrant.deleteCollection(qdrantCollectionName(qdrant)); } catch { /* expected */ }
  await ensureCollection(qdrant);
});

beforeEach(async () => {
  pipe = createMockPipeline();
  queue = createEmbeddingQueue(pipe, qdrant, { batchSize: 3, flushDelayMs: 10 });
  try { await qdrant.delete(qdrantCollectionName(qdrant), { wait: true, filter: {} }); } catch { /* expected */ }
});

afterEach(async () => {
  await queue.shutdown();
});

afterAll(async () => {
  try { await qdrant.deleteCollection(qdrantCollectionName(qdrant)); } catch { /* expected */ }
});

describe("enqueue and store", () => {
  test("stores a single memory embedding in Qdrant", async () => {
    await queue.enqueue({ id: "mem-1", text: "test content", target: "memory", metadata: { guild_id: "g1" } });
    await queue.flush();

    expect(await pointExists(qdrant, "mem-1")).toBe(true);
  });

  test("stores a single message embedding in Qdrant", async () => {
    await queue.enqueue({ id: "msg-1", text: "hello world", target: "message", metadata: { guild_id: "g1" } });
    await queue.flush();

    expect(await pointExists(qdrant, "msg-1")).toBe(true);
  });

  test("stores multiple items via enqueueBatch", async () => {
    await queue.enqueueBatch([
      { id: "mem-1", text: "first", target: "memory", metadata: { guild_id: "g1" } },
      { id: "mem-2", text: "second", target: "memory", metadata: { guild_id: "g1" } },
      { id: "msg-1", text: "third", target: "message", metadata: { guild_id: "g1" } },
    ]);
    await queue.flush();

    expect(await pointExists(qdrant, "mem-1")).toBe(true);
    expect(await pointExists(qdrant, "mem-2")).toBe(true);
    expect(await pointExists(qdrant, "msg-1")).toBe(true);
  });

  test("preserves metadata in Qdrant payload", async () => {
    const now = Date.now();
    await queue.enqueue({
      id: "msg-meta",
      text: "metadata test",
      target: "message",
      metadata: {
        guild_id: "g1",
        channel_id: "c1",
        user_id: "u1",
        created_at: now,
        last_created_at: now + 1,
        message_id: "m1",
        message_ids: ["m1", "m2"],
        first_message_id: "m1",
        last_message_id: "m2",
        message_count: 2,
        is_bot: false,
        source: "reindex",
        embedding_kind: "merged",
      },
    });
    await queue.flush();

    const vecs = await pipe.embed(["metadata test"]);
    const vec = vecs[0];
    if (vec === undefined) throw new Error("unreachable");
    const results = await searchPoints(qdrant, Array.from(vec), { guild_id: "g1" }, { type: "message" });
    expect(results.length).toBe(1);
    const first = results[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("unreachable");
    expect(first.payload).toMatchObject({
      guild_id: "g1",
      channel_id: "c1",
      user_id: "u1",
      created_at: now,
      last_created_at: now + 1,
      message_id: "m1",
      message_ids: ["m1", "m2"],
      first_message_id: "m1",
      last_message_id: "m2",
      message_count: 2,
      is_bot: false,
      source: "reindex",
      embedding_kind: "merged",
    });
  });
});

describe("batching behavior", () => {
  test("flushes automatically when batch size reached", async () => {
    const promises = [
      queue.enqueue({ id: "m1", text: "a", target: "memory", metadata: { guild_id: "g1" } }),
      queue.enqueue({ id: "m2", text: "b", target: "memory", metadata: { guild_id: "g1" } }),
      queue.enqueue({ id: "m3", text: "c", target: "memory", metadata: { guild_id: "g1" } }),
    ];
    await Promise.all(promises);

    expect(await pointExists(qdrant, "m1")).toBe(true);
    expect(await pointExists(qdrant, "m2")).toBe(true);
    expect(await pointExists(qdrant, "m3")).toBe(true);
  });

  test("flushes partial batch after delay", async () => {
    void queue.enqueue({ id: "m1", text: "delayed", target: "memory", metadata: { guild_id: "g1" } });
    await new Promise((r) => setTimeout(r, 50));
    await queue.flush();

    expect(await pointExists(qdrant, "m1")).toBe(true);
  });
});

describe("error handling", () => {
  test("rejects enqueue after shutdown", async () => {
    await queue.shutdown();
    expect(queue.enqueue({ id: "x", text: "fail", target: "memory" })).rejects.toThrow("shut down");
  });

  test("rejects all items in batch on pipeline error", async () => {
    const failPipe: EmbeddingPipeline = {
      embed() { throw new Error("model failure"); },
      async dispose() {},
    };
    const failQueue = createEmbeddingQueue(failPipe, qdrant, { batchSize: 2, flushDelayMs: 5 });

    const result = failQueue.enqueue({ id: "x", text: "fail", target: "memory" });
    await failQueue.flush();
    expect(result).rejects.toThrow("model failure");

    await failQueue.shutdown();
  });
});

describe("pending count", () => {
  test("returns 0 after flush", async () => {
    void queue.enqueue({ id: "m1", text: "a", target: "memory", metadata: { guild_id: "g1" } });
    await queue.flush();
    expect(queue.pending()).toBe(0);
  });
});
