import { test, expect, beforeAll, beforeEach, afterAll, describe } from "bun:test";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { createDatabase, type Database } from "./database";
import { createQdrantClient, ensureCollection, COLLECTION_NAME } from "../qdrant/client";
import { upsertPoint } from "../qdrant/adapter";
import { searchMessages, getMessageById, searchMessagesLiteral, getMessagesAroundMessage, getMessagesAroundTimestamp, getHistoryMessages, getContextHistoryMessages, insertSyntheticEvent, insertPromptOnlyBotMessage, getParentPreContext, getChatHistory } from "./message-repository";
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
    isSynthetic?: boolean;
    isPromptOnly?: boolean;
    relatedThreadId?: string | null;
  } = {}
) {
  db.raw
    .prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id, is_synthetic, is_prompt_only, related_thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      opts.replyToId ?? null,
      opts.isSynthetic === true ? 1 : 0,
      opts.isPromptOnly === true ? 1 : 0,
      opts.relatedThreadId ?? null
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
    last_created_at: createdAt,
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
    await insertWithEmbedding("m1", "cats and dogs playing together", { createdAt: now + hour });
    await insertWithEmbedding("m2", "quantum physics lecture notes", { createdAt: now - hour });
    await insertWithEmbedding("m3", "puppies and kittens having fun", { createdAt: now });

    const queryVec = await embedOne("cats and dogs");
    const results = await searchMessages(db, qdrant, queryVec, { guildId: "g1", limit: 10 });

    expect(results.length).toBe(3);
    if (!results[0] || !results[1] || !results[2]) throw new Error("unreachable");
    expect(results[0].id).toBe("m1");
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results[1].score).toBeGreaterThanOrEqual(results[2].score);
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

  test("excludes synthetic messages from semantic search", async () => {
    // Note: In production, synthetic messages are never embedded to Qdrant.
    // This test verifies the SQLite-side exclusion as a defense-in-depth measure.
    // We manually insert a synthetic row and verify it's excluded even if it
    // hypothetically made it into Qdrant (which it shouldn't).
    await insertWithEmbedding("real-msg", "important topic discussion");
    // Insert synthetic row directly (bypassing embedding since we're testing SQLite filter)
    insertMessage("synthetic-msg", {
      guildId: "g1",
      translatedContent: "important topic discussion",
      isSynthetic: true,
      relatedThreadId: "thread-1",
    });

    const queryVec = await embedOne("important topic");
    const results = await searchMessages(db, qdrant, queryVec, { guildId: "g1", limit: 10 });

    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("real-msg");
  });

  test("excludes prompt-only messages from semantic search", async () => {
    await insertWithEmbedding("real-msg", "private ignore reason visible topic");
    await insertWithEmbedding("prompt-only-msg", "private ignore reason visible topic", { isPromptOnly: true });

    const queryVec = await embedOne("private ignore reason");
    const results = await searchMessages(db, qdrant, queryVec, { guildId: "g1", limit: 10 });

    expect(results.map((r) => r.id)).toEqual(["real-msg"]);
  });

  test("skips empty semantic hits and continues to real messages", async () => {
    insertMessage("empty-hit", { guildId: "g1", translatedContent: "" });
    const queryVec = await embedOne("important topic");
    await upsertPoint(qdrant, "empty-hit", Array.from(queryVec), {
      type: "message",
      entity_id: "empty-hit",
      guild_id: "g1",
      channel_id: "c1",
      user_id: "u1",
      message_id: "empty-hit",
      created_at: now,
    });
    await insertWithEmbedding("real-msg", "important topic discussion");

    const results = await searchMessages(db, qdrant, queryVec, { guildId: "g1", limit: 10 });

    expect(results.map((r) => r.id)).toEqual(["real-msg"]);
  });

  test("resolves merged vector payloads back to underlying messages", async () => {
    insertMessage("m1", { translatedContent: "first half", createdAt: now - 1000 });
    insertMessage("m2", { translatedContent: "second half", createdAt: now });
    const vec = await embedOne("first half second half");
    await upsertPoint(qdrant, "msgblock:m1:m2", Array.from(vec), {
      type: "message",
      entity_id: "msgblock:m1:m2",
      guild_id: "g1",
      channel_id: "c1",
      user_id: "u1",
      message_id: "m1",
      message_ids: ["m1", "m2"],
      first_message_id: "m1",
      last_message_id: "m2",
      message_count: 2,
      created_at: now - 1000,
      last_created_at: now,
      embedding_kind: "merged",
      source: "reindex",
    });

    const results = await searchMessages(db, qdrant, vec, { guildId: "g1", limit: 10 });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("m1");
    expect(results[0]?.translatedContent).toBe("first half\nsecond half");
    expect(results[0]?.matchedMessageIds).toEqual(["m1", "m2"]);
    expect(results[0]?.messageCount).toBe(2);
    expect(results[0]?.embeddingKind).toBe("merged");
  });

  test("does not hydrate rows outside the requested guild from stale vector payloads", async () => {
    insertMessage("foreign", { guildId: "g2", translatedContent: "private foreign text" });
    const vec = await embedOne("private foreign text");
    await upsertPoint(qdrant, "stale-block", Array.from(vec), {
      type: "message",
      entity_id: "stale-block",
      guild_id: "g1",
      channel_id: "c1",
      user_id: "u1",
      message_id: "foreign",
      message_ids: ["foreign"],
      created_at: now,
      last_created_at: now,
    });

    const results = await searchMessages(db, qdrant, vec, { guildId: "g1", limit: 10 });

    expect(results).toEqual([]);
  });

  test("uses merged-block overlap for semantic time filters and hydrates only matching rows", async () => {
    insertMessage("old", { translatedContent: "old part", createdAt: now - 10 * hour });
    insertMessage("new", { translatedContent: "new part", createdAt: now - hour });
    const vec = await embedOne("old part new part");
    await upsertPoint(qdrant, "msgblock:old:new", Array.from(vec), {
      type: "message",
      entity_id: "msgblock:old:new",
      guild_id: "g1",
      channel_id: "c1",
      user_id: "u1",
      message_id: "old",
      message_ids: ["old", "new"],
      first_message_id: "old",
      last_message_id: "new",
      message_count: 2,
      created_at: now - 10 * hour,
      last_created_at: now - hour,
      embedding_kind: "merged",
      source: "reindex",
    });

    const results = await searchMessages(db, qdrant, vec, {
      guildId: "g1",
      after: now - 2 * hour,
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("new");
    expect(results[0]?.translatedContent).toBe("new part");
    expect(results[0]?.matchedMessageIds).toEqual(["new"]);
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

  test("returns null for prompt-only rows", () => {
    insertMessage("ignored-row", { guildId: "g1", translatedContent: "<ignore>no</ignore>", isPromptOnly: true });
    expect(getMessageById(db, "ignored-row", "g1")).toBeNull();
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

describe("message context search", () => {
  test("returns chronological context around a message id", () => {
    insertMessage("m1", { translatedContent: "one", createdAt: now - 3_000 });
    insertMessage("m2", { translatedContent: "two", createdAt: now - 2_000 });
    insertMessage("m3", { translatedContent: "three", createdAt: now - 1_000 });
    insertMessage("m4", { translatedContent: "four", createdAt: now });
    insertMessage("m5", { translatedContent: "five", createdAt: now + 1_000 });

    const results = getMessagesAroundMessage(db, "m3", { guildId: "g1", limit: 5 });

    expect(results?.map((r) => r.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  test("fills context from available side when one side is short", () => {
    insertMessage("m1", { translatedContent: "one", createdAt: now });
    insertMessage("m2", { translatedContent: "two", createdAt: now + 1_000 });
    insertMessage("m3", { translatedContent: "three", createdAt: now + 2_000 });
    insertMessage("m4", { translatedContent: "four", createdAt: now + 3_000 });

    const results = getMessagesAroundMessage(db, "m1", { guildId: "g1", limit: 3 });

    expect(results?.map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
  });

  test("filters context by guild and channel", () => {
    insertMessage("m1", { guildId: "g1", channelId: "c1", translatedContent: "one", createdAt: now });
    insertMessage("m2", { guildId: "g1", channelId: "c2", translatedContent: "two", createdAt: now + 1_000 });

    expect(getMessagesAroundMessage(db, "m1", { guildId: "g2", limit: 5 })).toBeNull();
    expect(getMessagesAroundMessage(db, "m1", { guildId: "g1", channelId: "c2", limit: 5 })).toBeNull();
  });

  test("excludes synthetic, prompt-only, and empty messages from message-id context", () => {
    insertMessage("m1", { translatedContent: "one", createdAt: now - 2_000 });
    insertMessage("empty", { translatedContent: "", createdAt: now - 1_000 });
    insertMessage("m2", { translatedContent: "two", createdAt: now });
    insertMessage("synthetic", { translatedContent: "event", createdAt: now + 1_000, isSynthetic: true });
    insertMessage("prompt-only", { translatedContent: "<ignore>skip</ignore>", createdAt: now + 2_000, isPromptOnly: true });
    insertMessage("m3", { translatedContent: "three", createdAt: now + 3_000 });

    const results = getMessagesAroundMessage(db, "m2", { guildId: "g1", limit: 5 });

    expect(results?.map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
  });

  test("returns chronological context around a timestamp", () => {
    insertMessage("m1", { channelId: "c1", translatedContent: "one", createdAt: now - 3_000 });
    insertMessage("m2", { channelId: "c1", translatedContent: "two", createdAt: now - 2_000 });
    insertMessage("m3", { channelId: "c1", translatedContent: "three", createdAt: now + 1_000 });
    insertMessage("m4", { channelId: "c1", translatedContent: "four", createdAt: now + 2_000 });
    insertMessage("other-channel", { channelId: "c2", translatedContent: "other", createdAt: now });

    const results = getMessagesAroundTimestamp(db, {
      guildId: "g1",
      channelId: "c1",
      around: now,
      limit: 4,
    });

    expect(results.map((r) => r.id)).toEqual(["m1", "m2", "m3", "m4"]);
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

  test("excludes synthetic messages from literal search", () => {
    insertMessage("real-msg", { guildId: "g1", translatedContent: "thread topic" });
    insertMessage("synthetic-msg", { guildId: "g1", translatedContent: "thread topic", isSynthetic: true, relatedThreadId: "thread-1" });
    const results = searchMessagesLiteral(db, "thread topic", { guildId: "g1", limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("real-msg");
  });

  test("excludes prompt-only messages from literal search", () => {
    insertMessage("real-msg", { guildId: "g1", translatedContent: "ignore reason topic" });
    insertMessage("prompt-only-msg", { guildId: "g1", translatedContent: "<ignore>ignore reason topic</ignore>", isPromptOnly: true });
    const results = searchMessagesLiteral(db, "ignore reason topic", { guildId: "g1", limit: 10 });
    expect(results.map((r) => r.id)).toEqual(["real-msg"]);
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
      sourceKind?: string;
    } = {}
  ): number {
    const result = db.raw
      .prepare(
        `INSERT INTO images (message_id, guild_id, channel_id, caption, source_kind, path, mime, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        messageId,
        opts.guildId ?? "g1",
        opts.channelId ?? "c1",
        opts.caption ?? null,
        opts.sourceKind ?? "image",
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
      isSynthetic: false,
      isPromptOnly: false,
      relatedThreadId: null,
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
    expect(msg1.imageSourceKinds).toEqual(["image", "image"]);

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

describe("getContextHistoryMessages", () => {
  test("keeps oldest included message stable until a full window chunk accumulates", () => {
    const trim = {
      trimTrigger: 10,
      trimTarget: 8,
      windowSize: 3,
      messageCharLimit: 200,
      replyQuoteChars: 50,
    };

    for (let i = 0; i < 10; i += 1) {
      insertMessage(`m${i}`, { channelId: "c1", createdAt: now + i });
    }

    const atTrigger = getContextHistoryMessages(db, "c1", trim);
    expect(atTrigger.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);

    insertMessage("m10", { channelId: "c1", createdAt: now + 10 });
    const beforeChunk = getContextHistoryMessages(db, "c1", trim);
    expect(beforeChunk.map((m) => m.id)).toEqual(["m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]);

    insertMessage("m11", { channelId: "c1", createdAt: now + 11 });
    const stillSameChunk = getContextHistoryMessages(db, "c1", trim);
    expect(stillSameChunk.map((m) => m.id)).toEqual(["m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11"]);

    insertMessage("m12", { channelId: "c1", createdAt: now + 12 });
    const nextChunk = getContextHistoryMessages(db, "c1", trim);
    expect(nextChunk.map((m) => m.id)).toEqual(["m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11", "m12"]);

    insertMessage("m13", { channelId: "c1", createdAt: now + 13 });
    const afterChunk = getContextHistoryMessages(db, "c1", trim);
    expect(afterChunk.map((m) => m.id)).toEqual(["m6", "m7", "m8", "m9", "m10", "m11", "m12", "m13"]);
  });

  test("excludes latest message before calculating the chunked context window", () => {
    const trim = {
      trimTrigger: 10,
      trimTarget: 8,
      windowSize: 3,
      messageCharLimit: 200,
      replyQuoteChars: 50,
    };

    for (let i = 0; i < 11; i += 1) {
      insertMessage(`m${i}`, { channelId: "c1", createdAt: now + i });
    }

    const withoutLatest = getContextHistoryMessages(db, "c1", trim, "m10");
    expect(withoutLatest.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
  });

  test("includes prompt-only bot rows in context history", () => {
    const trim = {
      trimTrigger: 10,
      trimTarget: 8,
      windowSize: 3,
      messageCharLimit: 200,
      replyQuoteChars: 50,
    };
    insertMessage("user-msg", { channelId: "c1", translatedContent: "hello", createdAt: now });
    insertPromptOnlyBotMessage(db, {
      id: "prompt-only:ignore:user-msg",
      guildId: "g1",
      channelId: "c1",
      botUserId: "bot-1",
      botUsername: "2b",
      content: "<ignore>not worth answering</ignore>",
      replyToId: "user-msg",
      createdAt: now + 1,
    });

    const rows = getContextHistoryMessages(db, "c1", trim);
    expect(rows.map((m) => [m.id, m.content, m.isPromptOnly])).toEqual([
      ["user-msg", "hello", false],
      ["prompt-only:ignore:user-msg", "<ignore>not worth answering</ignore>", true],
    ]);
  });
});

describe("getParentPreContext", () => {
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
      sourceKind?: string;
    } = {}
  ): number {
    const result = db.raw
      .prepare(
        `INSERT INTO images (message_id, guild_id, channel_id, caption, source_kind, path, mime, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        messageId,
        opts.guildId ?? "g1",
        opts.channelId ?? "parent-chan",
        opts.caption ?? null,
        opts.sourceKind ?? "image",
        opts.path ?? "/tmp/img.jpg",
        opts.mime ?? "image/jpeg",
        opts.width ?? 100,
        opts.height ?? 100,
        now
      );
    return Number(result.lastInsertRowid);
  }

  test("returns messages before the specified timestamp", () => {
    // Thread created at now - 2hr, so we want messages before that
    const threadCreatedAt = now - 2 * hour;

    insertMessage("m1", { channelId: "parent-chan", createdAt: now - 5 * hour });
    insertMessage("m2", { channelId: "parent-chan", createdAt: now - 3 * hour });
    insertMessage("m3", { channelId: "parent-chan", createdAt: now - 1 * hour }); // after thread, should be excluded

    const results = getParentPreContext(db, "parent-chan", threadCreatedAt, 20);

    expect(results.length).toBe(2);
    expect(results.map((r) => r.id)).toEqual(["m1", "m2"]);
  });

  test("returns messages in chronological order (oldest first)", () => {
    const threadCreatedAt = now;

    insertMessage("m1", { channelId: "parent-chan", createdAt: now - 1 * hour });
    insertMessage("m2", { channelId: "parent-chan", createdAt: now - 3 * hour });
    insertMessage("m3", { channelId: "parent-chan", createdAt: now - 2 * hour });

    const results = getParentPreContext(db, "parent-chan", threadCreatedAt, 20);

    expect(results.map((r) => r.id)).toEqual(["m2", "m3", "m1"]);
  });

  test("respects limit parameter", () => {
    const threadCreatedAt = now;

    insertMessage("m1", { channelId: "parent-chan", createdAt: now - 5 * hour });
    insertMessage("m2", { channelId: "parent-chan", createdAt: now - 4 * hour });
    insertMessage("m3", { channelId: "parent-chan", createdAt: now - 3 * hour });
    insertMessage("m4", { channelId: "parent-chan", createdAt: now - 2 * hour });
    insertMessage("m5", { channelId: "parent-chan", createdAt: now - 1 * hour });

    const results = getParentPreContext(db, "parent-chan", threadCreatedAt, 3);

    // Should get the 3 most recent before timestamp, then sorted chronologically
    expect(results.length).toBe(3);
    expect(results.map((r) => r.id)).toEqual(["m3", "m4", "m5"]);
  });

  test("excludes synthetic events", () => {
    const threadCreatedAt = now;

    insertMessage("real-1", { channelId: "parent-chan", createdAt: now - 3 * hour });
    insertMessage("synthetic-1", { channelId: "parent-chan", createdAt: now - 2 * hour, isSynthetic: true, relatedThreadId: "other-thread" });
    insertMessage("real-2", { channelId: "parent-chan", createdAt: now - 1 * hour });

    const results = getParentPreContext(db, "parent-chan", threadCreatedAt, 20);

    expect(results.length).toBe(2);
    expect(results.map((r) => r.id)).toEqual(["real-1", "real-2"]);
  });

  test("returns correct HistoryMessage shape", () => {
    const threadCreatedAt = now;

    insertMessage("m1", {
      channelId: "parent-chan",
      userId: "u1",
      authorUsername: "alice",
      translatedContent: "hello from parent",
      isBot: false,
      createdAt: now - 1 * hour,
      replyToId: "m0",
    });

    const results = getParentPreContext(db, "parent-chan", threadCreatedAt, 20);

    expect(results.length).toBe(1);
    const m = results[0];
    if (m === undefined) throw new Error("unreachable");
    expect(m).toEqual({
      id: "m1",
      author: "alice",
      authorId: "u1",
      content: "hello from parent",
      isBot: false,
      timestamp: now - 1 * hour,
      replyToId: "m0",
      imageIds: [],
      captions: [],
      hasEmbeds: false,
      isSynthetic: false,
      isPromptOnly: false,
      relatedThreadId: null,
    });
  });

  test("includes images grouped by message", () => {
    const threadCreatedAt = now;

    insertMessage("m1", { channelId: "parent-chan", createdAt: now - 2 * hour });
    insertMessage("m2", { channelId: "parent-chan", createdAt: now - 1 * hour });

    const imgId1 = insertImage("m1", { caption: "first image" });
    const imgId2 = insertImage("m1", { caption: "second image" });
    const imgId3 = insertImage("m2", { caption: null });

    const results = getParentPreContext(db, "parent-chan", threadCreatedAt, 20);

    expect(results.length).toBe(2);

    const msg1 = results[0];
    if (msg1 === undefined) throw new Error("unreachable");
    expect(msg1.imageIds).toEqual([imgId1, imgId2]);
    expect(msg1.captions).toEqual(["first image", "second image"]);

    const msg2 = results[1];
    if (msg2 === undefined) throw new Error("unreachable");
    expect(msg2.imageIds).toEqual([imgId3]);
    expect(msg2.captions).toEqual([""]);
  });

  test("returns empty array when no messages exist before timestamp", () => {
    const threadCreatedAt = now - 10 * hour;

    insertMessage("m1", { channelId: "parent-chan", createdAt: now - 5 * hour }); // after threadCreatedAt

    const results = getParentPreContext(db, "parent-chan", threadCreatedAt, 20);

    expect(results).toEqual([]);
  });

  test("filters by channelId only", () => {
    const threadCreatedAt = now;

    insertMessage("m1", { channelId: "parent-chan", createdAt: now - 2 * hour });
    insertMessage("m2", { channelId: "other-chan", createdAt: now - 1 * hour });

    const results = getParentPreContext(db, "parent-chan", threadCreatedAt, 20);

    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("m1");
  });
});

describe("insertSyntheticEvent", () => {
  test("inserts synthetic event with correct format and fields", () => {
    insertSyntheticEvent(db, {
      id: "syn-event-1",
      guildId: "g1",
      channelId: "c1",
      botUserId: "bot-123",
      botUsername: "TestBot",
      threadId: "thread-456",
      threadName: "Help Discussion",
    });

    const row = db.raw.prepare("SELECT * FROM messages WHERE id = ?").get("syn-event-1") as Record<string, unknown>;
    expect(row.guild_id).toBe("g1");
    expect(row.channel_id).toBe("c1");
    expect(row.user_id).toBe("bot-123");
    expect(row.author_username).toBe("TestBot");
    expect(row.is_bot).toBe(1);
    expect(row.is_synthetic).toBe(1);
    expect(row.related_thread_id).toBe("thread-456");
    expect(row.translated_content).toBe("Event: Thread created — request handed off to thread — Help Discussion (thread_id: thread-456)");
    expect(row.raw_content).toBe("Event: Thread created — request handed off to thread — Help Discussion (thread_id: thread-456)");
  });

  test("synthetic event is excluded from literal search", () => {
    insertSyntheticEvent(db, {
      id: "syn-event-2",
      guildId: "g1",
      channelId: "c1",
      botUserId: "bot-123",
      botUsername: "TestBot",
      threadId: "thread-789",
      threadName: "Bug Report Thread",
    });
    insertMessage("real-msg", { guildId: "g1", translatedContent: "Bug Report Thread discussion" });

    const results = searchMessagesLiteral(db, "Bug Report", { guildId: "g1", limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("real-msg");
  });
});

describe("getChatHistory", () => {
  test("returns messages in chronological order (oldest first)", () => {
    const now = Date.now();
    insertMessage("older", { guildId: "g1", channelId: "c1", createdAt: now - 2000 });
    insertMessage("newer", { guildId: "g1", channelId: "c1", createdAt: now - 1000 });
    insertMessage("newest", { guildId: "g1", channelId: "c1", createdAt: now });

    const results = getChatHistory(db, "g1", "c1", 10);
    expect(results.length).toBe(3);
    expect(results[0]?.id).toBe("older");
    expect(results[1]?.id).toBe("newer");
    expect(results[2]?.id).toBe("newest");
  });

  test("filters by guild and channel", () => {
    insertMessage("m1", { guildId: "g1", channelId: "c1" });
    insertMessage("m2", { guildId: "g1", channelId: "c2" });
    insertMessage("m3", { guildId: "g2", channelId: "c1" });

    const results = getChatHistory(db, "g1", "c1", 10);
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("m1");
  });

  test("respects limit (most recent N, then chronological)", () => {
    insertMessage("m1", { guildId: "g1", channelId: "c1", createdAt: Date.now() - 3000 });
    insertMessage("m2", { guildId: "g1", channelId: "c1", createdAt: Date.now() - 2000 });
    insertMessage("m3", { guildId: "g1", channelId: "c1", createdAt: Date.now() - 1000 });

    const results = getChatHistory(db, "g1", "c1", 2);
    expect(results.length).toBe(2);
    // Limit takes most recent 2, then reverses to chronological
    expect(results[0]?.id).toBe("m2");
    expect(results[1]?.id).toBe("m3");
  });

  test("includes synthetic events", () => {
    insertMessage("real-msg", { guildId: "g1", channelId: "c1", createdAt: Date.now() - 1000 });
    insertSyntheticEvent(db, {
      id: "syn-event",
      guildId: "g1",
      channelId: "c1",
      botUserId: "bot-123",
      botUsername: "TestBot",
      threadId: "thread-456",
      threadName: "Discussion Thread",
    });

    const results = getChatHistory(db, "g1", "c1", 10);
    expect(results.length).toBe(2);
    // Synthetic event should be included and formatted
    const syntheticResult = results.find((r) => r.id === "syn-event");
    expect(syntheticResult).toBeDefined();
    expect(syntheticResult?.content).toContain("Event: Thread created");
  });

  test("excludes prompt-only bot rows", () => {
    insertMessage("real-msg", { guildId: "g1", channelId: "c1", translatedContent: "visible" });
    insertPromptOnlyBotMessage(db, {
      id: "prompt-only:ignore:real-msg",
      guildId: "g1",
      channelId: "c1",
      botUserId: "bot-1",
      botUsername: "2b",
      content: "<ignore>private</ignore>",
      replyToId: "real-msg",
    });

    const results = getChatHistory(db, "g1", "c1", 10);
    expect(results.map((r) => r.id)).toEqual(["real-msg"]);
  });

  test("returns correct ChatHistoryRow structure", () => {
    insertMessage("m1", { guildId: "g1", channelId: "c1", authorUsername: "alice", translatedContent: "Hello world" });

    const results = getChatHistory(db, "g1", "c1", 10);
    expect(results.length).toBe(1);
    const row = results[0];
    expect(row?.id).toBe("m1");
    expect(row?.authorUsername).toBe("alice");
    expect(row?.content).toBe("Hello world");
    expect(typeof row?.createdAt).toBe("number");
  });
});
