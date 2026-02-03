import { test, expect, beforeAll, beforeEach, afterAll, describe } from "bun:test";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { createDatabase, type Database } from "./database";
import { createQdrantClient, ensureCollection, COLLECTION_NAME } from "../qdrant/client";
import { upsertPoint } from "../qdrant/adapter";
import { searchMessages, getMessageById, searchMessagesLiteral, getHistoryMessages } from "./message-repository";
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
    replyToId?: string | null;
  } = {}
) {
  db.raw
    .prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      opts.createdAt ?? now,
      opts.replyToId ?? null
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

describe("getMessageById", () => {
  test("returns message when found in guild", () => {
    insertMessage("m1", { guildId: "g1", channelId: "c1", userId: "u1", authorUsername: "alice", translatedContent: "hello world", createdAt: now });
    const result = getMessageById(db, "m1", "g1");
    if (result === null) throw new Error("unreachable");
    expect(result.id).toBe("m1");
    expect(result.channelId).toBe("c1");
    expect(result.userId).toBe("u1");
    expect(result.authorUsername).toBe("alice");
    expect(result.translatedContent).toBe("hello world");
    expect(result.createdAt).toBe(now);
    expect(result.score).toBe(1.0);
  });

  test("returns null for wrong guild", () => {
    insertMessage("m1", { guildId: "g1" });
    const result = getMessageById(db, "m1", "g2");
    expect(result).toBeNull();
  });

  test("returns null for missing ID", () => {
    const result = getMessageById(db, "nonexistent", "g1");
    expect(result).toBeNull();
  });

  test("returns replyToId when message is a reply", () => {
    insertMessage("m1", { guildId: "g1", translatedContent: "original" });
    insertMessage("m2", { guildId: "g1", translatedContent: "reply", replyToId: "m1" });
    const result = getMessageById(db, "m2", "g1");
    if (result === null) throw new Error("unreachable");
    expect(result.replyToId).toBe("m1");
  });

  test("returns null replyToId when message is not a reply", () => {
    insertMessage("m1", { guildId: "g1", translatedContent: "standalone" });
    const result = getMessageById(db, "m1", "g1");
    if (result === null) throw new Error("unreachable");
    expect(result.replyToId).toBeNull();
  });
});

describe("searchMessagesLiteral", () => {
  test("finds exact match", () => {
    insertMessage("m1", { guildId: "g1", translatedContent: "hello world" });
    const results = searchMessagesLiteral(db, "hello world", { guildId: "g1", limit: 10 });
    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("m1");
    expect(results[0].score).toBe(1.0);
  });

  test("finds substring match", () => {
    insertMessage("m1", { guildId: "g1", translatedContent: "I love cats and dogs" });
    const results = searchMessagesLiteral(db, "cats", { guildId: "g1", limit: 10 });
    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("m1");
  });

  test("case-insensitive matching", () => {
    insertMessage("m1", { guildId: "g1", translatedContent: "Hello World" });
    const results = searchMessagesLiteral(db, "hello world", { guildId: "g1", limit: 10 });
    expect(results.length).toBe(1);
  });

  test("guild isolation", () => {
    insertMessage("m1", { guildId: "g1", translatedContent: "secret data" });
    insertMessage("m2", { guildId: "g2", translatedContent: "secret data" });
    const results = searchMessagesLiteral(db, "secret", { guildId: "g1", limit: 10 });
    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("m1");
  });

  test("filters by userId", () => {
    insertMessage("m1", { guildId: "g1", userId: "u1", translatedContent: "topic A" });
    insertMessage("m2", { guildId: "g1", userId: "u2", translatedContent: "topic A" });
    const results = searchMessagesLiteral(db, "topic", { guildId: "g1", userId: "u1", limit: 10 });
    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("m1");
  });

  test("filters by channelId", () => {
    insertMessage("m1", { guildId: "g1", channelId: "c1", translatedContent: "topic B" });
    insertMessage("m2", { guildId: "g1", channelId: "c2", translatedContent: "topic B" });
    const results = searchMessagesLiteral(db, "topic", { guildId: "g1", channelId: "c1", limit: 10 });
    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("m1");
  });

  test("filters by time range", () => {
    insertMessage("m1", { guildId: "g1", translatedContent: "old msg", createdAt: now - 10 * hour });
    insertMessage("m2", { guildId: "g1", translatedContent: "new msg", createdAt: now - 1 * hour });
    const results = searchMessagesLiteral(db, "msg", { guildId: "g1", after: now - 2 * hour, limit: 10 });
    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("m2");
  });

  test("respects limit", () => {
    insertMessage("m1", { guildId: "g1", translatedContent: "alpha one", createdAt: now - 3 * hour });
    insertMessage("m2", { guildId: "g1", translatedContent: "alpha two", createdAt: now - 2 * hour });
    insertMessage("m3", { guildId: "g1", translatedContent: "alpha three", createdAt: now - 1 * hour });
    const results = searchMessagesLiteral(db, "alpha", { guildId: "g1", limit: 2 });
    expect(results.length).toBe(2);
  });

  test("returns results in chronological order (oldest first)", () => {
    insertMessage("m1", { guildId: "g1", translatedContent: "alpha first", createdAt: now - 3 * hour });
    insertMessage("m2", { guildId: "g1", translatedContent: "alpha second", createdAt: now - 1 * hour });
    insertMessage("m3", { guildId: "g1", translatedContent: "alpha third", createdAt: now - 2 * hour });
    const results = searchMessagesLiteral(db, "alpha", { guildId: "g1", limit: 10 });
    expect(results.map((r) => r.id)).toEqual(["m1", "m3", "m2"]);
  });

  test("escapes special LIKE characters % and _", () => {
    insertMessage("m1", { guildId: "g1", translatedContent: "100% done" });
    insertMessage("m2", { guildId: "g1", translatedContent: "100 done" });
    const results = searchMessagesLiteral(db, "100%", { guildId: "g1", limit: 10 });
    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("m1");
  });

  test("returns empty array when no matches", () => {
    const results = searchMessagesLiteral(db, "nonexistent", { guildId: "g1", limit: 10 });
    expect(results).toEqual([]);
  });

  test("returns replyToId in literal search results", () => {
    insertMessage("m1", { guildId: "g1", translatedContent: "original msg" });
    insertMessage("m2", { guildId: "g1", translatedContent: "reply msg", replyToId: "m1" });
    const results = searchMessagesLiteral(db, "reply msg", { guildId: "g1", limit: 10 });
    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].replyToId).toBe("m1");
  });

  test("combines all filters", () => {
    insertMessage("target", { guildId: "g1", userId: "u1", channelId: "c1", translatedContent: "findme", createdAt: now - 3 * hour });
    insertMessage("wrong-guild", { guildId: "g2", userId: "u1", channelId: "c1", translatedContent: "findme", createdAt: now - 3 * hour });
    insertMessage("wrong-user", { guildId: "g1", userId: "u2", channelId: "c1", translatedContent: "findme", createdAt: now - 3 * hour });
    insertMessage("wrong-channel", { guildId: "g1", userId: "u1", channelId: "c2", translatedContent: "findme", createdAt: now - 3 * hour });
    insertMessage("wrong-time", { guildId: "g1", userId: "u1", channelId: "c1", translatedContent: "findme", createdAt: now - 20 * hour });
    const results = searchMessagesLiteral(db, "findme", {
      guildId: "g1", userId: "u1", channelId: "c1",
      after: now - 5 * hour, before: now - 1 * hour, limit: 10,
    });
    expect(results.length).toBe(1);
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].id).toBe("target");
  });
});

describe("getHistoryMessages", () => {
  function insertImage(
    messageId: string,
    opts: {
      guildId?: string;
      channelId?: string;
      caption?: string | null;
      path?: string;
      mime?: string;
      width?: number;
      height?: number;
    } = {}
  ): number {
    const result = db.raw
      .prepare(
        `INSERT INTO images (message_id, guild_id, channel_id, caption, path, mime, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        messageId,
        opts.guildId ?? "g1",
        opts.channelId ?? "c1",
        opts.caption ?? null,
        opts.path ?? "/tmp/img.jpg",
        opts.mime ?? "image/jpeg",
        opts.width ?? 100,
        opts.height ?? 100,
        now
      );
    return Number(result.lastInsertRowid);
  }

  test("returns correct HistoryMessage shape with all fields mapped", () => {
    insertMessage("m1", {
      channelId: "c1",
      userId: "u1",
      authorUsername: "alice",
      translatedContent: "hello world",
      isBot: false,
      createdAt: now - 1 * hour,
      replyToId: "m0",
    });

    const results = getHistoryMessages(db, "c1", 10);
    expect(results.length).toBe(1);

    const m = results[0];
    if (m === undefined) throw new Error("unreachable");
    expect(m).toEqual({
      id: "m1",
      author: "alice",
      authorId: "u1",
      content: "hello world",
      isBot: false,
      timestamp: now - 1 * hour,
      replyToId: "m0",
      imageIds: [],
      captions: [],
      hasEmbeds: false,
    });
  });

  test("images grouped correctly per message (imageIds + captions parallel arrays)", () => {
    insertMessage("m1", { channelId: "c1", createdAt: now - 2 * hour });
    insertMessage("m2", { channelId: "c1", createdAt: now - 1 * hour });

    const imgId1 = insertImage("m1", { caption: "cat photo" });
    const imgId2 = insertImage("m1", { caption: "dog photo" });
    const imgId3 = insertImage("m2", { caption: "bird photo" });

    const results = getHistoryMessages(db, "c1", 10);
    expect(results.length).toBe(2);

    const msg1 = results[0];
    if (msg1 === undefined) throw new Error("unreachable");
    expect(msg1.id).toBe("m1");
    expect(msg1.imageIds).toEqual([imgId1, imgId2]);
    expect(msg1.captions).toEqual(["cat photo", "dog photo"]);

    const msg2 = results[1];
    if (msg2 === undefined) throw new Error("unreachable");
    expect(msg2.id).toBe("m2");
    expect(msg2.imageIds).toEqual([imgId3]);
    expect(msg2.captions).toEqual(["bird photo"]);
  });

  test("messages without images have empty imageIds/captions", () => {
    insertMessage("m1", { channelId: "c1", createdAt: now });

    const results = getHistoryMessages(db, "c1", 10);
    expect(results.length).toBe(1);

    const m = results[0];
    if (m === undefined) throw new Error("unreachable");
    expect(m.imageIds).toEqual([]);
    expect(m.captions).toEqual([]);
  });

  test("respects limit parameter", () => {
    insertMessage("m1", { channelId: "c1", createdAt: now - 3 * hour });
    insertMessage("m2", { channelId: "c1", createdAt: now - 2 * hour });
    insertMessage("m3", { channelId: "c1", createdAt: now - 1 * hour });

    const results = getHistoryMessages(db, "c1", 2);
    expect(results.length).toBe(2);
    // Limit takes most recent, then reverses to chronological
    expect(results.map((r) => r.id)).toEqual(["m2", "m3"]);
  });

  test("chronological order (oldest first)", () => {
    insertMessage("m1", { channelId: "c1", createdAt: now - 1 * hour });
    insertMessage("m2", { channelId: "c1", createdAt: now - 3 * hour });
    insertMessage("m3", { channelId: "c1", createdAt: now - 2 * hour });

    const results = getHistoryMessages(db, "c1", 10);
    expect(results.map((r) => r.id)).toEqual(["m2", "m3", "m1"]);
  });

  test("hasEmbeds is always false", () => {
    insertMessage("m1", { channelId: "c1", createdAt: now });
    insertMessage("m2", { channelId: "c1", createdAt: now - 1 * hour });
    insertImage("m1", { caption: "with image" });

    const results = getHistoryMessages(db, "c1", 10);
    for (const msg of results) {
      expect(msg.hasEmbeds).toBe(false);
    }
  });
});
