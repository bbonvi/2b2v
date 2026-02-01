import { test, expect, beforeAll, beforeEach, afterAll, describe } from "bun:test";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { createDatabase, type Database } from "./database";
import { createQdrantClient, ensureCollection, COLLECTION_NAME } from "../qdrant/client";
import { upsertPoint } from "../qdrant/adapter";
import { searchMessages } from "./message-repository";
import { createMockPipeline } from "../embeddings/test-utils";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://qdrant-test.orb.local:6333";
const mockPipeline = createMockPipeline();

async function embedOne(text: string): Promise<Float32Array> {
  const vecs = await mockPipeline.embed([text]);
  const vec = vecs[0];
  if (!vec) throw new Error("unreachable: embed returned empty");
  return vec;
}

let db: Database;
let qdrant: QdrantClient;

const now = Date.now();
const hour = 60 * 60 * 1000;

beforeAll(async () => {
  qdrant = createQdrantClient({ url: QDRANT_URL });
  try { await qdrant.deleteCollection(COLLECTION_NAME); } catch { /* expected */ }
  await ensureCollection(qdrant);
});

function insertMessage(
  id: string,
  opts: {
    guildId?: string;
    channelId?: string;
    userId?: string;
    authorUsername?: string;
    rawContent?: string;
    translatedContent?: string;
    isBot?: boolean;
    createdAt?: number;
  } = {}
) {
  db.raw
    .prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      opts.guildId ?? "g1",
      opts.channelId ?? "c1",
      opts.userId ?? "u1",
      opts.authorUsername ?? "alice",
      opts.rawContent ?? `raw ${id}`,
      opts.translatedContent ?? `translated ${id}`,
      opts.isBot === true ? 1 : 0,
      opts.createdAt ?? now
    );
}

async function insertWithEmbedding(id: string, text: string, opts: Parameters<typeof insertMessage>[1] = {}) {
  insertMessage(id, { ...opts, translatedContent: text });
  const vecs = await mockPipeline.embed([text]);
  const vec = vecs[0];
  if (!vec) throw new Error("unreachable: embed returned empty");
  const guildId = opts.guildId ?? "g1";
  const channelId = opts.channelId ?? "c1";
  const userId = opts.userId ?? "u1";
  const createdAt = opts.createdAt ?? now;
  await upsertPoint(qdrant, id, Array.from(vec), {
    type: "message",
    entity_id: id,
    guild_id: guildId,
    channel_id: channelId,
    user_id: userId,
    message_id: id,
    created_at: createdAt,
  });
}

beforeEach(async () => {
  db = createDatabase(":memory:");
  try { await qdrant.delete(COLLECTION_NAME, { wait: true, filter: {} }); } catch { /* expected */ }
});

afterAll(async () => {
  try { await qdrant.deleteCollection(COLLECTION_NAME); } catch { /* expected */ }
});

describe("searchMessages", () => {
  test("returns results ordered by semantic similarity", async () => {
    await insertWithEmbedding("m1", "cats and dogs playing together");
    await insertWithEmbedding("m2", "quantum physics lecture notes");
    await insertWithEmbedding("m3", "puppies and kittens having fun");

    const queryVec = await embedOne("cats and dogs");
    const results = await searchMessages(db, qdrant, queryVec, { guildId: "g1", limit: 10 });

    expect(results.length).toBe(3);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("m1");
  });

  test("filters by guild", async () => {
    await insertWithEmbedding("m1", "hello world", { guildId: "g1" });
    await insertWithEmbedding("m2", "hello world again", { guildId: "g2" });

    const queryVec = await embedOne("hello");
    const results = await searchMessages(db, qdrant, queryVec, { guildId: "g1", limit: 10 });

    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("m1");
  });

  test("filters by user", async () => {
    await insertWithEmbedding("m1", "programming tips", { userId: "u1" });
    await insertWithEmbedding("m2", "programming advice", { userId: "u2" });

    const queryVec = await embedOne("programming");
    const results = await searchMessages(db, qdrant, queryVec, { guildId: "g1", userId: "u1", limit: 10 });

    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("m1");
  });

  test("filters by channel", async () => {
    await insertWithEmbedding("m1", "music discussion", { channelId: "c1" });
    await insertWithEmbedding("m2", "music reviews", { channelId: "c2" });

    const queryVec = await embedOne("music");
    const results = await searchMessages(db, qdrant, queryVec, { guildId: "g1", channelId: "c1", limit: 10 });

    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("m1");
  });

  test("filters by time range (after)", async () => {
    await insertWithEmbedding("m1", "old message about food", { createdAt: now - 10 * hour });
    await insertWithEmbedding("m2", "recent message about food", { createdAt: now - 1 * hour });

    const queryVec = await embedOne("food");
    const results = await searchMessages(db, qdrant, queryVec, { guildId: "g1", after: now - 2 * hour, limit: 10 });

    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("m2");
  });

  test("filters by time range (before)", async () => {
    await insertWithEmbedding("m1", "old message about food", { createdAt: now - 10 * hour });
    await insertWithEmbedding("m2", "recent message about food", { createdAt: now - 1 * hour });

    const queryVec = await embedOne("food");
    const results = await searchMessages(db, qdrant, queryVec, { guildId: "g1", before: now - 5 * hour, limit: 10 });

    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("m1");
  });

  test("filters by combined time range", async () => {
    await insertWithEmbedding("m1", "early morning coffee", { createdAt: now - 10 * hour });
    await insertWithEmbedding("m2", "afternoon coffee break", { createdAt: now - 5 * hour });
    await insertWithEmbedding("m3", "evening coffee ritual", { createdAt: now - 1 * hour });

    const queryVec = await embedOne("coffee");
    const results = await searchMessages(db, qdrant, queryVec, {
      guildId: "g1",
      after: now - 8 * hour,
      before: now - 2 * hour,
      limit: 10,
    });

    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("m2");
  });

  test("respects limit", async () => {
    await insertWithEmbedding("m1", "alpha topic one");
    await insertWithEmbedding("m2", "alpha topic two");
    await insertWithEmbedding("m3", "alpha topic three");

    const queryVec = await embedOne("alpha");
    const results = await searchMessages(db, qdrant, queryVec, { guildId: "g1", limit: 2 });

    expect(results.length).toBe(2);
  });

  test("returns message metadata in results", async () => {
    await insertWithEmbedding("m1", "detailed content here", {
      channelId: "c5",
      userId: "u7",
      authorUsername: "bob",
      createdAt: now - 3 * hour,
    });

    const queryVec = await embedOne("detailed content");
    const results = await searchMessages(db, qdrant, queryVec, { guildId: "g1", limit: 10 });

    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0]).toMatchObject({
      id: "m1",
      channelId: "c5",
      userId: "u7",
      authorUsername: "bob",
      translatedContent: "detailed content here",
      createdAt: now - 3 * hour,
    });
    expect(typeof results[0].score).toBe("number");
  });

  test("returns empty array when no matches", async () => {
    const queryVec = await embedOne("anything");
    const results = await searchMessages(db, qdrant, queryVec, { guildId: "g1", limit: 10 });

    expect(results).toEqual([]);
  });

  test("combines all filters", async () => {
    await insertWithEmbedding("target", "the answer is here", {
      guildId: "g1", userId: "u1", channelId: "c1", createdAt: now - 3 * hour,
    });
    await insertWithEmbedding("wrong-guild", "the answer is here", {
      guildId: "g2", userId: "u1", channelId: "c1", createdAt: now - 3 * hour,
    });
    await insertWithEmbedding("wrong-user", "the answer is here", {
      guildId: "g1", userId: "u2", channelId: "c1", createdAt: now - 3 * hour,
    });
    await insertWithEmbedding("wrong-channel", "the answer is here", {
      guildId: "g1", userId: "u1", channelId: "c2", createdAt: now - 3 * hour,
    });
    await insertWithEmbedding("wrong-time", "the answer is here", {
      guildId: "g1", userId: "u1", channelId: "c1", createdAt: now - 20 * hour,
    });

    const queryVec = await embedOne("the answer");
    const results = await searchMessages(db, qdrant, queryVec, {
      guildId: "g1",
      userId: "u1",
      channelId: "c1",
      after: now - 5 * hour,
      before: now - 1 * hour,
      limit: 10,
    });

    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("target");
  });
});
