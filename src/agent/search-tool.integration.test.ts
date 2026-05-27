import { test, expect, beforeAll, beforeEach, afterAll, describe } from "bun:test";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { createDatabase, type Database } from "../db/database";
import { createQdrantClient, ensureCollection, COLLECTION_NAME } from "../qdrant/client";
import { upsertPoint } from "../qdrant/adapter";
import { createSearchTool } from "./search-tool";
import { createMockPipeline } from "../embeddings/test-utils";
import type { EmbeddingPipeline } from "../embeddings/pipeline";
interface SearchResult {
  content: { type: string; text: string }[];
  details: { count: number };
}

function getResultText(result: SearchResult): string {
  const first = result.content[0];
  if (first === undefined) return "";
  return first.type === "text" ? first.text : "";
}

const QDRANT_URL = process.env.QDRANT_URL ?? "http://qdrant-test.orb.local:6333";

let db: Database;
let qdrant: QdrantClient;
let pipeline: EmbeddingPipeline;

const now = Date.now();
const _hour = 60 * 60 * 1000;

// Mock username → userId resolver (identity for tests)
const mockResolveUsername = (username: string): string | undefined => username;

beforeAll(async () => {
  qdrant = createQdrantClient({ url: QDRANT_URL });
  try { await qdrant.deleteCollection(COLLECTION_NAME); } catch { /* expected */ }
  await ensureCollection(qdrant);
});

function insertMessage(
  id: string,
  text: string,
  opts: { guildId?: string; channelId?: string; userId?: string; authorUsername?: string; createdAt?: number; replyToId?: string | null } = {}
) {
  db.raw
    .prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      id,
      opts.guildId ?? "g1",
      opts.channelId ?? "c1",
      opts.userId ?? "u1",
      opts.authorUsername ?? "alice",
      `raw ${id}`,
      text,
      opts.createdAt ?? now,
      opts.replyToId ?? null
    );
}

async function insertWithEmbedding(id: string, text: string, opts: NonNullable<Parameters<typeof insertMessage>[2]> = {}) {
  insertMessage(id, text, opts);
  const embedResult = await pipeline.embed([text]);
  const vec = embedResult[0];
  if (vec === undefined) throw new Error("embed returned empty");
  await upsertPoint(qdrant, id, Array.from(vec), {
    type: "message",
    entity_id: id,
    guild_id: opts.guildId ?? "g1",
    channel_id: opts.channelId ?? "c1",
    user_id: opts.userId ?? "u1",
    message_id: id,
    created_at: opts.createdAt ?? now,
  });
}

beforeEach(async () => {
  db = createDatabase(":memory:");
  pipeline = createMockPipeline();
  try { await qdrant.delete(COLLECTION_NAME, { wait: true, filter: {} }); } catch { /* expected */ }
});

afterAll(async () => {
  try { await qdrant.deleteCollection(COLLECTION_NAME); } catch { /* expected */ }
});

describe("createSearchTool", () => {
  test("returns search_messages AgentTool with correct metadata", () => {
    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    expect(tool.name).toBe("search_messages");
    expect(tool.label).toBeDefined();
    expect(tool.description).toBeDefined();
    expect(tool.parameters).toBeDefined();
  });

  test("finds semantically similar messages", async () => {
    await insertWithEmbedding("m1", "cats and dogs playing");
    await insertWithEmbedding("m2", "quantum physics notes");

    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "cats and dogs" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("cats and dogs playing");
    const catIdx = text.indexOf("cats and dogs playing");
    const quantumIdx = text.indexOf("quantum physics notes");
    expect(catIdx).toBeLessThan(quantumIdx);
  });

  test("auto-injects guildId for isolation", async () => {
    await insertWithEmbedding("m1", "secret guild one data", { guildId: "g1" });
    await insertWithEmbedding("m2", "secret guild two data", { guildId: "g2" });

    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "secret data" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("guild one");
    expect(text).not.toContain("guild two");
  });

  test("passes optional filters through", async () => {
    await insertWithEmbedding("m1", "food topic", { authorUsername: "u1", channelId: "c1" });
    await insertWithEmbedding("m2", "food topic again", { userId: "u2", channelId: "c1" });

    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "food", username: "u1" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("food topic");
    expect(text).not.toContain("food topic again");
  });

  test("returns informative message when no results found", async () => {
    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "anything" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("No messages found");
  });

  test("includes metadata in results", async () => {
    await insertWithEmbedding("m1", "test content", { authorUsername: "bob", channelId: "c5" });

    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "test content" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("bob");
    expect(result.details.count).toBe(1);
  });

  test("returns semantic results in rank order with scores", async () => {
    await insertWithEmbedding("newer", "cats and dogs exact match", { createdAt: now + 2_000 });
    await insertWithEmbedding("older", "quantum physics unrelated", { createdAt: now + 1_000 });

    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "cats and dogs", limit: 10 }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("Semantic search results are ranked by similarity");
    expect(text).toContain("[score ");
    expect(text.indexOf("cats and dogs exact match")).toBeLessThan(text.indexOf("quantum physics unrelated"));
  });

  test("filters out messages already present in prompt context without exhausting small limits", async () => {
    await insertWithEmbedding("current", "needle context current", { createdAt: now + 2_000 });
    await insertWithEmbedding("older", "needle context older", { createdAt: now + 1_000 });

    const tool = createSearchTool({
      db,
      qdrant,
      guildId: "g1",
      timezone: "UTC",
      embed: pipeline,
      resolveUsername: mockResolveUsername,
      excludedMessageIds: ["current"],
    });
    const result = await tool.execute("tc1", { query: "needle context", limit: 1 }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("needle context older");
    expect(text).not.toContain("needle context current");
    expect(result.details.count).toBe(1);
  });
});

describe("reply-to display", () => {
  test("shows reply-to ID in formatted output", async () => {
    insertMessage("m-parent", "parent message");
    insertMessage("m-reply", "replying here", { replyToId: "m-parent" });
    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "m-reply", mode: "id" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("(reply to m-parent)");
    expect(text).toContain("replying here");
  });

  test("omits reply tag when not a reply", async () => {
    insertMessage("m-solo", "standalone message");
    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "m-solo", mode: "id" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).not.toContain("reply to");
    expect(text).toContain("standalone message");
  });
});

describe("createSearchTool attachment support", () => {
  test("includes attachment info when fetchMessage provided", async () => {
    await insertWithEmbedding("m1", "check this diagram");

    const fetchMessage = (_chId: string, _msgId: string) => Promise.resolve({
      attachments: [
        { name: "architecture.png", contentType: "image/png" as string | null, size: 245000 },
        { name: "notes.pdf", contentType: "application/pdf" as string | null, size: 1200000 },
      ],
    });

    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername, fetchMessage });
    const result = await tool.execute("tc1", { query: "diagram" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("check this diagram");
    expect(text).toContain("📎 architecture.png (image/png, 239.3KB)");
    expect(text).toContain("📎 notes.pdf (application/pdf, 1.1MB)");
  });

  test("gracefully handles fetchMessage failure", async () => {
    await insertWithEmbedding("m1", "some message");

    const fetchMessage = (): Promise<{ attachments: Array<{ name: string; contentType: string | null; size: number }> } | null> => Promise.reject(new Error("Discord API error"));

    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername, fetchMessage });
    const result = await tool.execute("tc1", { query: "some message" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("some message");
    expect(text).not.toContain("📎");
  });

  test("shows text only when fetchMessage returns null", async () => {
    await insertWithEmbedding("m1", "deleted msg content");

    const fetchMessage = (): Promise<{ attachments: Array<{ name: string; contentType: string | null; size: number }> } | null> => Promise.resolve(null);

    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername, fetchMessage });
    const result = await tool.execute("tc1", { query: "deleted msg" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("deleted msg content");
    expect(text).not.toContain("📎");
  });

  test("shows text only when no attachments", async () => {
    await insertWithEmbedding("m1", "plain text message");

    const fetchMessage = (): Promise<{ attachments: Array<{ name: string; contentType: string | null; size: number }> } | null> => Promise.resolve({ attachments: [] });

    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername, fetchMessage });
    const result = await tool.execute("tc1", { query: "plain text" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("plain text message");
    expect(text).not.toContain("📎");
  });
});

describe("search mode: literal", () => {
  test("finds keyword match without Qdrant", async () => {
    insertMessage("m1", "the quick brown fox");
    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "quick brown", mode: "literal" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("Literal search results are exact text matches ordered oldest to newest");
    expect(text).not.toContain("[score ");
    expect(text).toContain("the quick brown fox");
    expect(result.details.count).toBe(1);
  });

  test("respects filters in literal mode", async () => {
    insertMessage("m1", "topic here", { userId: "u1" });
    insertMessage("m2", "topic here", { userId: "u2" });
    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "topic", mode: "literal", username: "u1" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("topic here");
    expect(result.details.count).toBe(1);
  });

  test("returns no-match message for literal mode", async () => {
    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "nonexistent", mode: "literal" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("No messages found");
  });

  test("literal mode filters out context messages", async () => {
    insertMessage("current", "exact phrase current");
    insertMessage("older", "exact phrase older");
    const tool = createSearchTool({
      db,
      qdrant,
      guildId: "g1",
      timezone: "UTC",
      embed: pipeline,
      resolveUsername: mockResolveUsername,
      excludedMessageIds: ["current"],
    });
    const result = await tool.execute("tc1", { query: "exact phrase", mode: "literal" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("exact phrase older");
    expect(text).not.toContain("exact phrase current");
  });
});

describe("search mode: id", () => {
  test("returns single message by ID", async () => {
    insertMessage("m1", "target content");
    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "m1", mode: "id" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("target content");
    expect(result.details.count).toBe(1);
  });

  test("returns not found for missing ID", async () => {
    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "missing", mode: "id" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("not found");
  });

  test("enforces guild isolation for ID lookup", async () => {
    insertMessage("m1", "secret content", { guildId: "g2" });
    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "m1", mode: "id" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("not found");
  });
});

describe("search mode: default", () => {
  test("omitted mode defaults to semantic search", async () => {
    await insertWithEmbedding("m1", "cats playing with yarn");
    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "cats playing" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("cats playing with yarn");
  });

  test("explicit semantic mode works same as default", async () => {
    await insertWithEmbedding("m1", "dogs running in park");
    const tool = createSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "dogs running", mode: "semantic" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("dogs running in park");
  });
});
