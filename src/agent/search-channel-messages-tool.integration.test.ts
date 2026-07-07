import { test, expect, beforeAll, beforeEach, afterAll, describe } from "bun:test";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { createDatabase, type Database } from "../db/database";
import { createQdrantClient, ensureCollection, qdrantCollectionName } from "../qdrant/client";
import { upsertPoint } from "../qdrant/adapter";
import { createSearchChannelMessagesTool } from "./search-channel-messages-tool";
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
const TEST_COLLECTION = `embeddings_search_tool_${String(process.pid)}`;

let db: Database;
let qdrant: QdrantClient;
let pipeline: EmbeddingPipeline;

const now = Date.now();
const _hour = 60 * 60 * 1000;

// Mock username → userId resolver (identity for tests)
const mockResolveUsername = (username: string): string | undefined => username;

function createTestSearchTool(deps: Omit<Parameters<typeof createSearchChannelMessagesTool>[0], "currentChannelId"> & { currentChannelId?: string }) {
  return createSearchChannelMessagesTool({ currentChannelId: "c1", ...deps });
}

beforeAll(async () => {
  qdrant = createQdrantClient({ url: QDRANT_URL, collectionName: TEST_COLLECTION });
  try { await qdrant.deleteCollection(qdrantCollectionName(qdrant)); } catch { /* expected */ }
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
  try { await qdrant.delete(qdrantCollectionName(qdrant), { wait: true, filter: {} }); } catch { /* expected */ }
});

afterAll(async () => {
  try { await qdrant.deleteCollection(qdrantCollectionName(qdrant)); } catch { /* expected */ }
});

describe("createSearchChannelMessagesTool", () => {
  test("returns search_channel_messages AgentTool with correct metadata", () => {
    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    expect(tool.name).toBe("search_channel_messages");
    expect(tool.label).toBeDefined();
    expect(tool.description).toBeDefined();
    expect(tool.parameters).toBeDefined();
  });

  test("finds semantically similar messages", async () => {
    await insertWithEmbedding("m1", "cats and dogs playing");
    await insertWithEmbedding("m2", "quantum physics notes");

    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
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

    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "secret data" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("guild one");
    expect(text).not.toContain("guild two");
  });

  test("rejects broad searches in inaccessible guilds", async () => {
    await insertWithEmbedding("m2", "secret guild two data", { guildId: "g2" });

    const tool = createTestSearchTool({
      db,
      qdrant,
      guildId: "g1",
      timezone: "UTC",
      embed: pipeline,
      resolveUsername: mockResolveUsername,
      canAccessGuild: () => Promise.resolve(false),
    });
    const result = await tool.execute("tc1", { query: "secret data", guild_id: "g2" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("not found or not accessible");
    expect(text).not.toContain("secret guild two data");
  });

  test("filters broad guild searches to currently accessible channels", async () => {
    insertMessage("m-open", "shared topic public", { guildId: "g2", channelId: "c-open" });
    insertMessage("m-secret", "shared topic private", { guildId: "g2", channelId: "c-secret" });

    const tool = createTestSearchTool({
      db,
      qdrant,
      guildId: "g1",
      timezone: "UTC",
      embed: pipeline,
      resolveUsername: mockResolveUsername,
      canAccessGuild: () => Promise.resolve(true),
      resolveChannel: (channelId) => Promise.resolve(channelId === "c-open" ? { guildId: "g2", channelId } : null),
    });
    const result = await tool.execute("tc1", { query: "shared topic", mode: "literal", guild_id: "g2" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("shared topic public");
    expect(text).not.toContain("shared topic private");
    expect(result.details.count).toBe(1);
  });

  test("passes optional filters through", async () => {
    await insertWithEmbedding("m1", "food topic", { authorUsername: "u1", channelId: "c1" });
    await insertWithEmbedding("m2", "food topic again", { userId: "u2", channelId: "c1" });

    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "food", username: "u1" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("food topic");
    expect(text).not.toContain("food topic again");
  });

  test("returns informative message when no results found", async () => {
    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "anything" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("No messages found");
  });

  test("includes metadata in results", async () => {
    await insertWithEmbedding("m1", "test content", { authorUsername: "bob", channelId: "c1" });

    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "test content" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("bob");
    expect(text).toContain("[id m1]");
    expect(text).not.toContain("[channel_id");
    expect(result.details.count).toBe(1);
  });

  test("defaults searches to the current channel", async () => {
    await insertWithEmbedding("m1", "same phrase current channel", { channelId: "c1" });
    await insertWithEmbedding("m2", "same phrase other channel", { channelId: "c2" });

    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "same phrase" }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("same phrase current channel");
    expect(text).not.toContain("same phrase other channel");
    expect(text).not.toContain("[channel_id");
  });

  test("returns semantic results in rank order with scores", async () => {
    await insertWithEmbedding("newer", "cats and dogs exact match", { createdAt: now + 2_000 });
    await insertWithEmbedding("older", "quantum physics unrelated", { createdAt: now + 1_000 });

    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "cats and dogs", limit: 10 }, AbortSignal.timeout(5000)) as unknown as SearchResult;

    const text = getResultText(result);
    expect(text).toContain("Semantic search results are ranked by similarity");
    expect(text).toContain("[score ");
    expect(text.indexOf("cats and dogs exact match")).toBeLessThan(text.indexOf("quantum physics unrelated"));
  });

  test("filters out messages already present in prompt context without exhausting small limits", async () => {
    await insertWithEmbedding("current", "needle context current", { createdAt: now + 2_000 });
    await insertWithEmbedding("older", "needle context older", { createdAt: now + 1_000 });

    const tool = createTestSearchTool({
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
    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "m-reply", mode: "id" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("(reply to m-parent)");
    expect(text).toContain("replying here");
  });

  test("omits reply tag when not a reply", async () => {
    insertMessage("m-solo", "standalone message");
    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "m-solo", mode: "id" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).not.toContain("reply to");
    expect(text).toContain("standalone message");
  });
});

describe("createSearchChannelMessagesTool attachment support", () => {
  test("does not fetch attachment info by default", async () => {
    await insertWithEmbedding("m1", "check this diagram");
    let called = false;

    const fetchMessage = (_chId: string, _msgId: string) => {
      called = true;
      return Promise.resolve({
        attachments: [{ name: "architecture.png", contentType: "image/png" as string | null, size: 245000 }],
      });
    };

    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername, fetchMessage });
    const result = await tool.execute("tc1", { query: "diagram" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("check this diagram");
    expect(text).not.toContain("📎");
    expect(called).toBe(false);
  });

  test("includes attachment info when explicitly requested", async () => {
    await insertWithEmbedding("m1", "check this diagram");

    const fetchMessage = (_chId: string, _msgId: string) => Promise.resolve({
      attachments: [
        { name: "architecture.png", contentType: "image/png" as string | null, size: 245000 },
        { name: "notes.pdf", contentType: "application/pdf" as string | null, size: 1200000 },
      ],
    });

    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername, fetchMessage });
    const result = await tool.execute("tc1", { query: "diagram", include_attachments: true }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("check this diagram");
    expect(text).toContain("📎 architecture.png (image/png, 239.3KB)");
    expect(text).toContain("📎 notes.pdf (application/pdf, 1.1MB)");
  });

  test("gracefully handles fetchMessage failure", async () => {
    await insertWithEmbedding("m1", "some message");

    const fetchMessage = (): Promise<{ attachments: Array<{ name: string; contentType: string | null; size: number }> } | null> => Promise.reject(new Error("Discord API error"));

    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername, fetchMessage });
    const result = await tool.execute("tc1", { query: "some message", include_attachments: true }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("some message");
    expect(text).not.toContain("📎");
  });

  test("shows text only when fetchMessage returns null", async () => {
    await insertWithEmbedding("m1", "deleted msg content");

    const fetchMessage = (): Promise<{ attachments: Array<{ name: string; contentType: string | null; size: number }> } | null> => Promise.resolve(null);

    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername, fetchMessage });
    const result = await tool.execute("tc1", { query: "deleted msg", include_attachments: true }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("deleted msg content");
    expect(text).not.toContain("📎");
  });

  test("shows text only when no attachments", async () => {
    await insertWithEmbedding("m1", "plain text message");

    const fetchMessage = (): Promise<{ attachments: Array<{ name: string; contentType: string | null; size: number }> } | null> => Promise.resolve({ attachments: [] });

    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername, fetchMessage });
    const result = await tool.execute("tc1", { query: "plain text", include_attachments: true }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("plain text message");
    expect(text).not.toContain("📎");
  });
});

describe("search mode: literal", () => {
  test("finds keyword match without Qdrant", async () => {
    insertMessage("m1", "the quick brown fox");
    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
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
    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "topic", mode: "literal", username: "u1" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("topic here");
    expect(result.details.count).toBe(1);
  });

  test("omits repeated channel_id when search is scoped to a channel", async () => {
    insertMessage("m1", "topic here", { channelId: "c1" });
    insertMessage("m2", "topic here", { channelId: "c2" });
    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "topic", mode: "literal", channel_id: "c1" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("[id m1]");
    expect(text).not.toContain("[channel_id");
    expect(text).not.toContain("[id m2]");
  });

  test("returns no-match message for literal mode", async () => {
    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "nonexistent", mode: "literal" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("No messages found");
  });

  test("literal mode filters out context messages", async () => {
    insertMessage("current", "exact phrase current");
    insertMessage("older", "exact phrase older");
    const tool = createTestSearchTool({
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
    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "m1", mode: "id" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("target content");
    expect(result.details.count).toBe(1);
  });

  test("ID lookup can expand a message already visible in prompt context", async () => {
    insertMessage("m1", "full target content that was trimmed in context");
    const tool = createTestSearchTool({
      db,
      qdrant,
      guildId: "g1",
      timezone: "UTC",
      embed: pipeline,
      resolveUsername: mockResolveUsername,
      excludedMessageIds: ["m1"],
    });
    const result = await tool.execute("tc1", { query: "m1", mode: "id" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("full target content");
    expect(result.details.count).toBe(1);
  });

  test("ID lookup accepts message_id", async () => {
    insertMessage("m1", "target content via message_id");
    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { message_id: "m1", mode: "id" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("target content via message_id");
    expect(result.details.count).toBe(1);
  });

  test("returns not found for missing ID", async () => {
    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "missing", mode: "id" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("not found");
  });

  test("enforces guild isolation for ID lookup", async () => {
    insertMessage("m1", "secret content", { guildId: "g2" });
    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "m1", mode: "id" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("not found");
  });
});

describe("search mode: context", () => {
  test("returns chronological context around a message id", async () => {
    const anchorMs = Date.UTC(2026, 4, 28, 14, 12);
    insertMessage("m1", "before context", { createdAt: anchorMs - 60_000 });
    insertMessage("m2", "anchor context", { createdAt: anchorMs });
    insertMessage("m3", "after context", { createdAt: anchorMs + 60_000 });

    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { mode: "context", message_id: "m2", limit: 3 }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("Surrounding channel context around message id m2 in channel c1");
    expect(text.indexOf("[id m1]")).toBeLessThan(text.indexOf("[id m2]"));
    expect(text.indexOf("[id m2]")).toBeLessThan(text.indexOf("[id m3]"));
    expect(text).not.toContain("[channel_id");
    expect(result.details.count).toBe(3);
  });

  test("returns chronological context around a timestamp", async () => {
    const aroundMs = Date.UTC(2026, 4, 28, 14, 12);
    insertMessage("m1", "before timestamp", { channelId: "c1", createdAt: aroundMs - 60_000 });
    insertMessage("m2", "after timestamp", { channelId: "c1", createdAt: aroundMs + 60_000 });
    insertMessage("m3", "wrong channel", { channelId: "c2", createdAt: aroundMs });

    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { mode: "context", channel_id: "c1", around: "2026-05-28 14:12", limit: 2 }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);

    expect(text).toContain("Surrounding channel context around 2026-05-28 14:12 in channel c1");
    expect(text).toContain("[id m1]");
    expect(text).toContain("[id m2]");
    expect(text).not.toContain("[id m3]");
  });

  test("defaults timestamp context to current channel", async () => {
    const aroundMs = Date.UTC(2026, 4, 28, 14, 12);
    insertMessage("m1", "current channel timestamp", { channelId: "c1", createdAt: aroundMs });
    insertMessage("m2", "other channel timestamp", { channelId: "c2", createdAt: aroundMs });

    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { mode: "context", around: "2026-05-28 14:12" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("current channel timestamp");
    expect(text).not.toContain("other channel timestamp");
    expect(text).not.toContain("[channel_id");
  });
});

describe("search mode: default", () => {
  test("omitted mode defaults to semantic search", async () => {
    await insertWithEmbedding("m1", "cats playing with yarn");
    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "cats playing" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("cats playing with yarn");
  });

  test("explicit semantic mode works same as default", async () => {
    await insertWithEmbedding("m1", "dogs running in park");
    const tool = createTestSearchTool({ db, qdrant, guildId: "g1", timezone: "UTC", embed: pipeline, resolveUsername: mockResolveUsername });
    const result = await tool.execute("tc1", { query: "dogs running", mode: "semantic" }, AbortSignal.timeout(5000)) as unknown as SearchResult;
    const text = getResultText(result);
    expect(text).toContain("dogs running in park");
  });
});
