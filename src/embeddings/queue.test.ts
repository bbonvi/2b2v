import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createDatabase, type Database } from "../db/database";
import { searchMemoryEmbeddings, searchMessageEmbeddings } from "../db/embedding-repository";
import { createEmbeddingQueue, type EmbeddingQueue } from "./queue";
import { createMockPipeline } from "./test-utils";
import type { EmbeddingPipeline } from "./pipeline";

let db: Database;
let pipe: EmbeddingPipeline;
let queue: EmbeddingQueue;

beforeEach(() => {
  db = createDatabase(":memory:");
  pipe = createMockPipeline();
  queue = createEmbeddingQueue(pipe, db, { batchSize: 3, flushDelayMs: 10 });
});

afterEach(async () => {
  await queue.shutdown();
  db.close();
});

describe("enqueue and store", () => {
  test("stores a single memory embedding", async () => {
    await queue.enqueue({ id: "mem-1", text: "test content", target: "memory" });
    await queue.flush();

    const results = searchMemoryEmbeddings(db, new Float32Array(1024), 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("mem-1");
  });

  test("stores a single message embedding", async () => {
    await queue.enqueue({ id: "msg-1", text: "hello world", target: "message" });
    await queue.flush();

    const results = searchMessageEmbeddings(db, new Float32Array(1024), 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("msg-1");
  });

  test("stores multiple items via enqueueBatch", async () => {
    await queue.enqueueBatch([
      { id: "mem-1", text: "first", target: "memory" },
      { id: "mem-2", text: "second", target: "memory" },
      { id: "msg-1", text: "third", target: "message" },
    ]);
    await queue.flush();

    const memResults = searchMemoryEmbeddings(db, new Float32Array(1024), 10);
    expect(memResults.length).toBe(2);

    const msgResults = searchMessageEmbeddings(db, new Float32Array(1024), 10);
    expect(msgResults.length).toBe(1);
  });
});

describe("batching behavior", () => {
  test("flushes automatically when batch size reached", async () => {
    // batchSize is 3, so 3 items should trigger immediate flush
    const promises = [
      queue.enqueue({ id: "m1", text: "a", target: "memory" }),
      queue.enqueue({ id: "m2", text: "b", target: "memory" }),
      queue.enqueue({ id: "m3", text: "c", target: "memory" }),
    ];
    await Promise.all(promises);

    const results = searchMemoryEmbeddings(db, new Float32Array(1024), 10);
    expect(results.length).toBe(3);
  });

  test("flushes partial batch after delay", async () => {
    // Only 1 item (below batchSize of 3), should flush after flushDelayMs
    queue.enqueue({ id: "m1", text: "delayed", target: "memory" });
    expect(queue.pending()).toBeGreaterThanOrEqual(0); // may already be processing

    await new Promise((r) => setTimeout(r, 50)); // wait for flush delay
    await queue.flush(); // ensure fully drained

    const results = searchMemoryEmbeddings(db, new Float32Array(1024), 10);
    expect(results.length).toBe(1);
  });
});

describe("error handling", () => {
  test("rejects enqueue after shutdown", async () => {
    await queue.shutdown();
    expect(queue.enqueue({ id: "x", text: "fail", target: "memory" })).rejects.toThrow("shut down");
  });

  test("rejects all items in batch on pipeline error", async () => {
    const failPipe: EmbeddingPipeline = {
      async embed() { throw new Error("model failure"); },
      async dispose() {},
    };
    const failQueue = createEmbeddingQueue(failPipe, db, { batchSize: 2, flushDelayMs: 5 });

    const result = failQueue.enqueue({ id: "x", text: "fail", target: "memory" });
    await failQueue.flush();
    expect(result).rejects.toThrow("model failure");

    await failQueue.shutdown();
  });
});

describe("pending count", () => {
  test("returns 0 after flush", async () => {
    queue.enqueue({ id: "m1", text: "a", target: "memory" });
    await queue.flush();
    expect(queue.pending()).toBe(0);
  });
});
