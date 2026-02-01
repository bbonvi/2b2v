import { test, expect, beforeEach, describe } from "bun:test";
import { createDatabase, type Database } from "./database";
import { storeMessageEmbedding } from "./embedding-repository";
import { searchMessages, type MessageSearchFilter, type MessageSearchResult } from "./message-repository";
import { createMockPipeline } from "../embeddings/test-utils";

let db: Database;
const mockPipeline = createMockPipeline();

const now = Date.now();
const hour = 60 * 60 * 1000;

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
      opts.isBot ? 1 : 0,
      opts.createdAt ?? now
    );
}

async function insertWithEmbedding(id: string, text: string, opts: Parameters<typeof insertMessage>[1] = {}) {
  insertMessage(id, { ...opts, translatedContent: text });
  const [vec] = await mockPipeline.embed([text]);
  storeMessageEmbedding(db, id, vec);
}

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("searchMessages", () => {
  test("returns results ordered by semantic distance", async () => {
    await insertWithEmbedding("m1", "cats and dogs playing together");
    await insertWithEmbedding("m2", "quantum physics lecture notes");
    await insertWithEmbedding("m3", "puppies and kittens having fun");

    const [queryVec] = await mockPipeline.embed(["cats and dogs"]);
    const results = searchMessages(db, queryVec, { guildId: "g1", limit: 10 });

    expect(results.length).toBe(3);
    // "cats and dogs playing together" should be closest to "cats and dogs"
    expect(results[0].id).toBe("m1");
  });

  test("filters by guild", async () => {
    await insertWithEmbedding("m1", "hello world", { guildId: "g1" });
    await insertWithEmbedding("m2", "hello world again", { guildId: "g2" });

    const [queryVec] = await mockPipeline.embed(["hello"]);
    const results = searchMessages(db, queryVec, { guildId: "g1", limit: 10 });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("m1");
  });

  test("filters by user", async () => {
    await insertWithEmbedding("m1", "programming tips", { userId: "u1" });
    await insertWithEmbedding("m2", "programming advice", { userId: "u2" });

    const [queryVec] = await mockPipeline.embed(["programming"]);
    const results = searchMessages(db, queryVec, { guildId: "g1", userId: "u1", limit: 10 });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("m1");
  });

  test("filters by channel", async () => {
    await insertWithEmbedding("m1", "music discussion", { channelId: "c1" });
    await insertWithEmbedding("m2", "music reviews", { channelId: "c2" });

    const [queryVec] = await mockPipeline.embed(["music"]);
    const results = searchMessages(db, queryVec, { guildId: "g1", channelId: "c1", limit: 10 });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("m1");
  });

  test("filters by time range (after)", async () => {
    await insertWithEmbedding("m1", "old message about food", { createdAt: now - 10 * hour });
    await insertWithEmbedding("m2", "recent message about food", { createdAt: now - 1 * hour });

    const [queryVec] = await mockPipeline.embed(["food"]);
    const results = searchMessages(db, queryVec, { guildId: "g1", after: now - 2 * hour, limit: 10 });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("m2");
  });

  test("filters by time range (before)", async () => {
    await insertWithEmbedding("m1", "old message about food", { createdAt: now - 10 * hour });
    await insertWithEmbedding("m2", "recent message about food", { createdAt: now - 1 * hour });

    const [queryVec] = await mockPipeline.embed(["food"]);
    const results = searchMessages(db, queryVec, { guildId: "g1", before: now - 5 * hour, limit: 10 });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("m1");
  });

  test("filters by combined time range", async () => {
    await insertWithEmbedding("m1", "early morning coffee", { createdAt: now - 10 * hour });
    await insertWithEmbedding("m2", "afternoon coffee break", { createdAt: now - 5 * hour });
    await insertWithEmbedding("m3", "evening coffee ritual", { createdAt: now - 1 * hour });

    const [queryVec] = await mockPipeline.embed(["coffee"]);
    const results = searchMessages(db, queryVec, {
      guildId: "g1",
      after: now - 8 * hour,
      before: now - 2 * hour,
      limit: 10,
    });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("m2");
  });

  test("respects limit", async () => {
    await insertWithEmbedding("m1", "alpha topic one");
    await insertWithEmbedding("m2", "alpha topic two");
    await insertWithEmbedding("m3", "alpha topic three");

    const [queryVec] = await mockPipeline.embed(["alpha"]);
    const results = searchMessages(db, queryVec, { guildId: "g1", limit: 2 });

    expect(results.length).toBe(2);
  });

  test("returns message metadata in results", async () => {
    await insertWithEmbedding("m1", "detailed content here", {
      channelId: "c5",
      userId: "u7",
      authorUsername: "bob",
      createdAt: now - 3 * hour,
    });

    const [queryVec] = await mockPipeline.embed(["detailed content"]);
    const results = searchMessages(db, queryVec, { guildId: "g1", limit: 10 });

    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({
      id: "m1",
      channelId: "c5",
      userId: "u7",
      authorUsername: "bob",
      translatedContent: "detailed content here",
      createdAt: now - 3 * hour,
    });
    expect(typeof results[0].distance).toBe("number");
  });

  test("returns empty array when no matches", async () => {
    const [queryVec] = await mockPipeline.embed(["anything"]);
    const results = searchMessages(db, queryVec, { guildId: "g1", limit: 10 });

    expect(results).toEqual([]);
  });

  test("combines all filters", async () => {
    // Target: guild g1, user u1, channel c1, within time range
    await insertWithEmbedding("target", "the answer is here", {
      guildId: "g1", userId: "u1", channelId: "c1", createdAt: now - 3 * hour,
    });
    // Wrong guild
    await insertWithEmbedding("wrong-guild", "the answer is here", {
      guildId: "g2", userId: "u1", channelId: "c1", createdAt: now - 3 * hour,
    });
    // Wrong user
    await insertWithEmbedding("wrong-user", "the answer is here", {
      guildId: "g1", userId: "u2", channelId: "c1", createdAt: now - 3 * hour,
    });
    // Wrong channel
    await insertWithEmbedding("wrong-channel", "the answer is here", {
      guildId: "g1", userId: "u1", channelId: "c2", createdAt: now - 3 * hour,
    });
    // Wrong time
    await insertWithEmbedding("wrong-time", "the answer is here", {
      guildId: "g1", userId: "u1", channelId: "c1", createdAt: now - 20 * hour,
    });

    const [queryVec] = await mockPipeline.embed(["the answer"]);
    const results = searchMessages(db, queryVec, {
      guildId: "g1",
      userId: "u1",
      channelId: "c1",
      after: now - 5 * hour,
      before: now - 1 * hour,
      limit: 10,
    });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe("target");
  });
});
