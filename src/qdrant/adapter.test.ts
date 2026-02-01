import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { createQdrantClient, ensureCollection, COLLECTION_NAME } from "./client";
import {
  upsertPoint,
  upsertPoints,
  deletePoint,
  pointExists,
  searchPoints,
  toPointId,
  type PointPayload,
} from "./adapter";
import { createMockPipeline } from "../embeddings/test-utils";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://qdrant-test.orb.local:6333";
const pipeline = createMockPipeline();

let client: QdrantClient;

function vecToArray(v: Float32Array): number[] {
  return Array.from(v);
}

function assertDefined<T>(v: T | undefined, msg = "unreachable"): asserts v is T {
  expect(v).toBeDefined();
  if (v === undefined) throw new Error(msg);
}

async function embedOne(text: string): Promise<Float32Array> {
  const results = await pipeline.embed([text]);
  const v = results[0];
  assertDefined(v);
  return v;
}

async function embedMany(...texts: string[]): Promise<Float32Array[]> {
  const results = await pipeline.embed(texts);
  for (const r of results) assertDefined(r);
  return results;
}

beforeAll(async () => {
  client = createQdrantClient({ url: QDRANT_URL });
  try { await client.deleteCollection(COLLECTION_NAME); } catch { /* expected */ }
  await ensureCollection(client);
});

beforeEach(async () => {
  // Clear all points between tests
  try {
    await client.delete(COLLECTION_NAME, { wait: true, filter: {} });
  } catch { /* expected */ }
});

afterAll(async () => {
  try { await client.deleteCollection(COLLECTION_NAME); } catch { /* expected */ }
});

describe("toPointId", () => {
  test("produces valid UUID format", () => {
    const id = toPointId("123456789");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("is deterministic", () => {
    expect(toPointId("abc")).toBe(toPointId("abc"));
  });

  test("different inputs produce different UUIDs", () => {
    expect(toPointId("a")).not.toBe(toPointId("b"));
  });
});

describe("upsertPoint", () => {
  test("inserts a point retrievable by existence check", async () => {
    const vec = await embedOne("test content");
    const payload: PointPayload = {
      type: "message",
      entity_id: "m1",
      guild_id: "g1",
      channel_id: "c1",
      user_id: "u1",
      message_id: "m1",
      created_at: Date.now(),
    };

    await upsertPoint(client, "m1", vecToArray(vec), payload);
    expect(await pointExists(client, "m1")).toBe(true);
  });

  test("overwrites existing point on same id", async () => {
    const vec1 = await embedOne("original");
    const vec2 = await embedOne("updated");

    await upsertPoint(client, "m1", vecToArray(vec1), { type: "message", entity_id: "m1", guild_id: "g1" });
    await upsertPoint(client, "m1", vecToArray(vec2), { type: "message", entity_id: "m1", guild_id: "g1" });

    const results = await searchPoints(client, vecToArray(vec2), { guild_id: "g1" }, { type: "message" });
    expect(results.length).toBe(1);
    assertDefined(results[0]);
    expect(results[0].id).toBe("m1");
  });
});

describe("upsertPoints (batch)", () => {
  test("inserts multiple points in one call", async () => {
    const vecs = await embedMany("alpha", "beta", "gamma");
    const points = vecs.map((v, i) => ({
      id: `batch-${i}`,
      vector: vecToArray(v),
      payload: { type: "message" as const, entity_id: `batch-${i}`, guild_id: "g1" },
    }));

    await upsertPoints(client, points);

    expect(await pointExists(client, "batch-0")).toBe(true);
    expect(await pointExists(client, "batch-1")).toBe(true);
    expect(await pointExists(client, "batch-2")).toBe(true);
  });

  test("no-ops on empty array", async () => {
    await upsertPoints(client, []);
  });
});

describe("deletePoint", () => {
  test("removes an existing point", async () => {
    const vec = await embedOne("to-delete");
    await upsertPoint(client, "del-1", vecToArray(vec), { type: "memory", entity_id: "del-1", guild_id: "g1" });
    await deletePoint(client, "del-1");
    expect(await pointExists(client, "del-1")).toBe(false);
  });

  test("does not error when deleting non-existent point", async () => {
    await deletePoint(client, "nonexistent");
  });
});

describe("pointExists", () => {
  test("returns false for non-existent point", async () => {
    expect(await pointExists(client, "no-such-id")).toBe(false);
  });
});

describe("searchPoints", () => {
  test("returns results ordered by similarity", async () => {
    const targetVec = await embedOne("cats and dogs playing");
    const closeVec = await embedOne("cats and dogs running");
    const farVec = await embedOne("quantum physics lecture");

    await upsertPoint(client, "close", vecToArray(closeVec), { type: "message", entity_id: "close", guild_id: "g1" });
    await upsertPoint(client, "far", vecToArray(farVec), { type: "message", entity_id: "far", guild_id: "g1" });

    const results = await searchPoints(client, vecToArray(targetVec), { guild_id: "g1" }, { type: "message" });
    expect(results.length).toBe(2);
    assertDefined(results[0]);
    assertDefined(results[1]);
    expect(results[0].id).toBe("close");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  test("filters by guild_id", async () => {
    const vec = await embedOne("shared content");
    await upsertPoint(client, "g1-msg", vecToArray(vec), { type: "message", entity_id: "g1-msg", guild_id: "g1" });
    await upsertPoint(client, "g2-msg", vecToArray(vec), { type: "message", entity_id: "g2-msg", guild_id: "g2" });

    const results = await searchPoints(client, vecToArray(vec), { guild_id: "g1" }, { type: "message" });
    expect(results.length).toBe(1);
    assertDefined(results[0]);
    expect(results[0].id).toBe("g1-msg");
  });

  test("filters by channel_id", async () => {
    const vec = await embedOne("channel content");
    await upsertPoint(client, "c1-msg", vecToArray(vec), { type: "message", entity_id: "c1-msg", guild_id: "g1", channel_id: "c1" });
    await upsertPoint(client, "c2-msg", vecToArray(vec), { type: "message", entity_id: "c2-msg", guild_id: "g1", channel_id: "c2" });

    const results = await searchPoints(client, vecToArray(vec), { guild_id: "g1", channel_id: "c1" }, { type: "message" });
    expect(results.length).toBe(1);
    assertDefined(results[0]);
    expect(results[0].id).toBe("c1-msg");
  });

  test("filters by user_id", async () => {
    const vec = await embedOne("user content");
    await upsertPoint(client, "u1-msg", vecToArray(vec), { type: "message", entity_id: "u1-msg", guild_id: "g1", user_id: "u1" });
    await upsertPoint(client, "u2-msg", vecToArray(vec), { type: "message", entity_id: "u2-msg", guild_id: "g1", user_id: "u2" });

    const results = await searchPoints(client, vecToArray(vec), { guild_id: "g1", user_id: "u1" }, { type: "message" });
    expect(results.length).toBe(1);
    assertDefined(results[0]);
    expect(results[0].id).toBe("u1-msg");
  });

  test("filters by time range", async () => {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const vec = await embedOne("timed content");

    await upsertPoint(client, "old", vecToArray(vec), { type: "message", entity_id: "old", guild_id: "g1", created_at: now - 10 * hour });
    await upsertPoint(client, "recent", vecToArray(vec), { type: "message", entity_id: "recent", guild_id: "g1", created_at: now - 1 * hour });

    const results = await searchPoints(client, vecToArray(vec), { guild_id: "g1", after: now - 2 * hour }, { type: "message" });
    expect(results.length).toBe(1);
    assertDefined(results[0]);
    expect(results[0].id).toBe("recent");
  });

  test("filters by type (memory vs message)", async () => {
    const vec = await embedOne("typed content");
    await upsertPoint(client, "mem-1", vecToArray(vec), { type: "memory", entity_id: "mem-1", guild_id: "g1" });
    await upsertPoint(client, "msg-1", vecToArray(vec), { type: "message", entity_id: "msg-1", guild_id: "g1" });

    const memResults = await searchPoints(client, vecToArray(vec), { guild_id: "g1" }, { type: "memory" });
    expect(memResults.length).toBe(1);
    assertDefined(memResults[0]);
    expect(memResults[0].id).toBe("mem-1");

    const msgResults = await searchPoints(client, vecToArray(vec), { guild_id: "g1" }, { type: "message" });
    expect(msgResults.length).toBe(1);
    assertDefined(msgResults[0]);
    expect(msgResults[0].id).toBe("msg-1");
  });

  test("respects limit", async () => {
    const vecs = await embedMany("a", "b", "c", "d", "e");
    for (let i = 0; i < 5; i++) {
      const v = vecs[i];
      assertDefined(v);
      await upsertPoint(client, `lim-${i}`, vecToArray(v), { type: "message", entity_id: `lim-${i}`, guild_id: "g1" });
    }

    const queryVec = await embedOne("a");
    const results = await searchPoints(client, vecToArray(queryVec), { guild_id: "g1" }, { type: "message", limit: 2 });
    expect(results.length).toBe(2);
  });

  test("returns payload in results", async () => {
    const now = Date.now();
    const vec = await embedOne("payload test");
    await upsertPoint(client, "pay-1", vecToArray(vec), {
      type: "message",
      entity_id: "pay-1",
      guild_id: "g1",
      channel_id: "c5",
      user_id: "u7",
      message_id: "pay-1",
      created_at: now,
    });

    const results = await searchPoints(client, vecToArray(vec), { guild_id: "g1" }, { type: "message" });
    expect(results.length).toBe(1);
    assertDefined(results[0]);
    expect(results[0].payload).toMatchObject({
      type: "message",
      entity_id: "pay-1",
      guild_id: "g1",
      channel_id: "c5",
      user_id: "u7",
      message_id: "pay-1",
      created_at: now,
    });
  });

  test("returns empty array when no matches", async () => {
    const vec = await embedOne("nothing");
    const results = await searchPoints(client, vecToArray(vec), { guild_id: "nonexistent" }, { type: "message" });
    expect(results).toEqual([]);
  });
});
