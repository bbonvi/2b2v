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

beforeAll(async () => {
  qdrant = createQdrantClient({ url: QDRANT_URL });
  try { await qdrant.deleteCollection(COLLECTION_NAME); } catch { /* expected */ }
  await ensureCollection(qdrant);
});

function insertMessage(
  id: string,
  text: string,
  opts: { guildId?: string; channelId?: string; userId?: string; authorUsername?: string; createdAt?: number } = {}
) {
  db.raw
    .prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(
      id,
      opts.guildId ?? "g1",
      opts.channelId ?? "c1",
      opts.userId ?? "u1",
      opts.authorUsername ?? "alice",
      `raw ${id}`,
      text,
      opts.createdAt ?? now
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
    const tool = createSearchTool({ db, qdrant, guildId: "g1", embed: pipeline });
    expect(tool.name).toBe("search_messages");
    expect(tool.label).toBeDefined();
    expect(tool.description).toBeDefined();
    expect(tool.parameters).toBeDefined();
  });

  test("finds semantically similar messages", async () => {
    await insertWithEmbedding("m1", "cats and dogs playing");
    await insertWithEmbedding("m2", "quantum physics notes");

    const tool = createSearchTool({ db, qdrant, guildId: "g1", embed: pipeline });
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

    const tool = createSearchTool({ db, qdrant, guildId: "g1", embed: pipeline });
    const result = await tool.execute("tc1", { query: "secret data" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("guild one");
    expect(text).not.toContain("guild two");
  });

  test("passes optional filters through", async () => {
    await insertWithEmbedding("m1", "food topic", { userId: "u1", channelId: "c1" });
    await insertWithEmbedding("m2", "food topic again", { userId: "u2", channelId: "c1" });

    const tool = createSearchTool({ db, qdrant, guildId: "g1", embed: pipeline });
    const result = await tool.execute("tc1", { query: "food", userId: "u1" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("food topic");
    expect(text).not.toContain("food topic again");
  });

  test("returns informative message when no results found", async () => {
    const tool = createSearchTool({ db, qdrant, guildId: "g1", embed: pipeline });
    const result = await tool.execute("tc1", { query: "anything" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("No messages found");
  });

  test("includes metadata in results", async () => {
    await insertWithEmbedding("m1", "test content", { authorUsername: "bob", channelId: "c5" });

    const tool = createSearchTool({ db, qdrant, guildId: "g1", embed: pipeline });
    const result = await tool.execute("tc1", { query: "test content" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("bob");
    expect(result.details.count).toBe(1);
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

    const tool = createSearchTool({ db, qdrant, guildId: "g1", embed: pipeline, fetchMessage });
    const result = await tool.execute("tc1", { query: "diagram" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("check this diagram");
    expect(text).toContain("📎 architecture.png (image/png, 239.3KB)");
    expect(text).toContain("📎 notes.pdf (application/pdf, 1.1MB)");
  });

  test("gracefully handles fetchMessage failure", async () => {
    await insertWithEmbedding("m1", "some message");

    const fetchMessage = (): Promise<{ attachments: Array<{ name: string; contentType: string | null; size: number }> } | null> => Promise.reject(new Error("Discord API error"));

    const tool = createSearchTool({ db, qdrant, guildId: "g1", embed: pipeline, fetchMessage });
    const result = await tool.execute("tc1", { query: "some message" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("some message");
    expect(text).not.toContain("📎");
  });

  test("shows text only when fetchMessage returns null", async () => {
    await insertWithEmbedding("m1", "deleted msg content");

    const fetchMessage = (): Promise<{ attachments: Array<{ name: string; contentType: string | null; size: number }> } | null> => Promise.resolve(null);

    const tool = createSearchTool({ db, qdrant, guildId: "g1", embed: pipeline, fetchMessage });
    const result = await tool.execute("tc1", { query: "deleted msg" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("deleted msg content");
    expect(text).not.toContain("📎");
  });

  test("shows text only when no attachments", async () => {
    await insertWithEmbedding("m1", "plain text message");

    const fetchMessage = (): Promise<{ attachments: Array<{ name: string; contentType: string | null; size: number }> } | null> => Promise.resolve({ attachments: [] });

    const tool = createSearchTool({ db, qdrant, guildId: "g1", embed: pipeline, fetchMessage });
    const result = await tool.execute("tc1", { query: "plain text" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("plain text message");
    expect(text).not.toContain("📎");
  });
});
