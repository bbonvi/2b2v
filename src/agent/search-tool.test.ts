import { test, expect, beforeEach, describe } from "bun:test";
import { createDatabase, type Database } from "../db/database";
import { storeMessageEmbedding } from "../db/embedding-repository";
import { createSearchTool, type SearchToolDeps } from "./search-tool";
import { createMockPipeline } from "../embeddings/test-utils";
import type { EmbeddingPipeline } from "../embeddings/pipeline";

let db: Database;
let pipeline: EmbeddingPipeline;

const now = Date.now();
const hour = 60 * 60 * 1000;

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

async function insertWithEmbedding(id: string, text: string, opts: Parameters<typeof insertMessage>[2] = {}) {
  insertMessage(id, text, opts);
  const [vec] = await pipeline.embed([text]);
  storeMessageEmbedding(db, id, vec);
}

beforeEach(() => {
  db = createDatabase(":memory:");
  pipeline = createMockPipeline();
});

describe("createSearchTool", () => {
  test("returns search_messages AgentTool with correct metadata", () => {
    const tool = createSearchTool({ db, guildId: "g1", embed: pipeline });
    expect(tool.name).toBe("search_messages");
    expect(tool.label).toBeDefined();
    expect(tool.description).toBeDefined();
    expect(tool.parameters).toBeDefined();
  });

  test("finds semantically similar messages", async () => {
    await insertWithEmbedding("m1", "cats and dogs playing");
    await insertWithEmbedding("m2", "quantum physics notes");

    const tool = createSearchTool({ db, guildId: "g1", embed: pipeline });
    const result = await tool.execute("tc1", { query: "cats and dogs" }, AbortSignal.timeout(5000));

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("cats and dogs playing");
    // "cats and dogs playing" should appear before "quantum physics notes"
    const catIdx = text.indexOf("cats and dogs playing");
    const quantumIdx = text.indexOf("quantum physics notes");
    expect(catIdx).toBeLessThan(quantumIdx);
  });

  test("auto-injects guildId for isolation", async () => {
    await insertWithEmbedding("m1", "secret guild one data", { guildId: "g1" });
    await insertWithEmbedding("m2", "secret guild two data", { guildId: "g2" });

    const tool = createSearchTool({ db, guildId: "g1", embed: pipeline });
    const result = await tool.execute("tc1", { query: "secret data" }, AbortSignal.timeout(5000));

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("guild one");
    expect(text).not.toContain("guild two");
  });

  test("passes optional filters through", async () => {
    await insertWithEmbedding("m1", "food topic", { userId: "u1", channelId: "c1" });
    await insertWithEmbedding("m2", "food topic again", { userId: "u2", channelId: "c1" });

    const tool = createSearchTool({ db, guildId: "g1", embed: pipeline });
    const result = await tool.execute("tc1", { query: "food", userId: "u1" }, AbortSignal.timeout(5000));

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("food topic");
    expect(text).not.toContain("food topic again");
  });

  test("returns informative message when no results found", async () => {
    const tool = createSearchTool({ db, guildId: "g1", embed: pipeline });
    const result = await tool.execute("tc1", { query: "anything" }, AbortSignal.timeout(5000));

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("No messages found");
  });

  test("includes metadata in results", async () => {
    await insertWithEmbedding("m1", "test content", { authorUsername: "bob", channelId: "c5" });

    const tool = createSearchTool({ db, guildId: "g1", embed: pipeline });
    const result = await tool.execute("tc1", { query: "test content" }, AbortSignal.timeout(5000));

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("bob");
    expect(result.details?.count).toBe(1);
  });
});
