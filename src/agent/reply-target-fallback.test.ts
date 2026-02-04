import { test, expect, describe, beforeEach } from "bun:test";
import { createDatabase, type Database } from "../db/database.ts";
import { fetchMissingReplyTargets, type ReplyFallbackDeps, type FetchedDiscordMessage } from "./reply-target-fallback.ts";
import type { HistoryMessage } from "./history-types.ts";

function makeMsg(overrides: Partial<HistoryMessage> & { id: string }): HistoryMessage {
  return {
    author: "user",
    authorId: "u1",
    content: "hello",
    isBot: false,
    timestamp: 1000,
    replyToId: null,
    imageIds: [],
    captions: [],
    hasEmbeds: false,
    isSynthetic: false,
    relatedThreadId: null,
    ...overrides,
  };
}

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

function baseDeps(overrides: Partial<ReplyFallbackDeps> = {}): ReplyFallbackDeps {
  return {
    db,
    guildId: "g1",
    channelId: "ch1",
    fetchDiscordMessage: () => Promise.resolve(null),
    enqueueEmbedding: () => Promise.resolve(),
    processImage: () => Promise.resolve(),
    ...overrides,
  };
}

describe("fetchMissingReplyTargets", () => {
  test("returns empty when no messages have reply_to_id", async () => {
    const messages = [makeMsg({ id: "1" }), makeMsg({ id: "2" })];
    const result = await fetchMissingReplyTargets(baseDeps(), messages);
    expect(result).toEqual([]);
  });

  test("returns empty when reply target already in message list", async () => {
    const messages = [
      makeMsg({ id: "1" }),
      makeMsg({ id: "2", replyToId: "1" }),
    ];
    const result = await fetchMissingReplyTargets(baseDeps(), messages);
    expect(result).toEqual([]);
  });

  test("returns empty when reply target exists in DB", async () => {
    // Pre-insert the target message into DB
    db.raw.prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("target-1", "g1", "ch1", "u99", "targetuser", "original", "translated", 0, 500, null);

    const messages = [makeMsg({ id: "2", replyToId: "target-1" })];
    const result = await fetchMissingReplyTargets(baseDeps(), messages);
    expect(result).toEqual([]);
  });

  test("fetches missing target from Discord and persists", async () => {
    const fetched: FetchedDiscordMessage = {
      id: "target-1",
      authorId: "u99",
      authorUsername: "targetuser",
      content: "original content",
      timestamp: 500,
      isBot: false,
      replyToId: null,
      attachments: [],
    };

    const enqueueCalls: Array<{ id: string; text: string }> = [];

    const deps = baseDeps({
      fetchDiscordMessage: (_chId, msgId) =>
        msgId === "target-1" ? Promise.resolve(fetched) : Promise.resolve(null),
      enqueueEmbedding: (id, text) => {
        enqueueCalls.push({ id, text });
        return Promise.resolve();
      },
    });

    const messages = [makeMsg({ id: "2", replyToId: "target-1" })];
    const result = await fetchMissingReplyTargets(deps, messages);

    // Returns the fetched message as HistoryMessage
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("target-1");
    expect(result[0]?.author).toBe("targetuser");
    expect(result[0]?.content).toBe("original content");
    expect(result[0]?.timestamp).toBe(500);
    expect(result[0]?.replyToId).toBeNull();

    // Persisted in DB
    const row = db.raw.prepare("SELECT * FROM messages WHERE id = ?").get("target-1") as Record<string, unknown> | null;
    expect(row).not.toBeNull();
    expect(row?.translated_content).toBe("original content");
    expect(row?.author_username).toBe("targetuser");
    expect(row?.guild_id).toBe("g1");

    // Enqueued for embedding
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]?.id).toBe("target-1");
  });

  test("gracefully handles fetch failure (deleted/no perms)", async () => {
    const deps = baseDeps({
      fetchDiscordMessage: () => Promise.resolve(null),
    });

    const messages = [makeMsg({ id: "2", replyToId: "missing-1" })];
    const result = await fetchMissingReplyTargets(deps, messages);

    // Returns empty — missing target will be handled by resolveReplies missingTarget logic
    expect(result).toEqual([]);
  });

  test("gracefully handles fetch error (network)", async () => {
    const deps = baseDeps({
      fetchDiscordMessage: () => Promise.reject(new Error("network error")),
    });

    const messages = [makeMsg({ id: "2", replyToId: "missing-1" })];
    const result = await fetchMissingReplyTargets(deps, messages);
    expect(result).toEqual([]);
  });

  test("processes attachments on fetched message", async () => {
    const processImageCalls: Array<{ url: string; messageId: string }> = [];

    const fetched: FetchedDiscordMessage = {
      id: "target-1",
      authorId: "u99",
      authorUsername: "targetuser",
      content: "check this image",
      timestamp: 500,
      isBot: false,
      replyToId: null,
      attachments: [
        { url: "https://cdn.example.com/img1.png", contentType: "image/png" },
        { url: "https://cdn.example.com/doc.pdf", contentType: "application/pdf" },
      ],
    };

    const deps = baseDeps({
      fetchDiscordMessage: () => Promise.resolve(fetched),
      processImage: (url, _contentType, messageId) => {
        processImageCalls.push({ url, messageId });
        return Promise.resolve();
      },
    });

    const messages = [makeMsg({ id: "2", replyToId: "target-1" })];
    await fetchMissingReplyTargets(deps, messages);

    // Only image attachments are processed, not PDFs
    expect(processImageCalls).toHaveLength(1);
    expect(processImageCalls[0]?.url).toBe("https://cdn.example.com/img1.png");
    expect(processImageCalls[0]?.messageId).toBe("target-1");
  });

  test("handles multiple missing targets", async () => {
    const fetched = new Map<string, FetchedDiscordMessage>([
      ["target-1", {
        id: "target-1", authorId: "u1", authorUsername: "alice",
        content: "first", timestamp: 100, isBot: false, replyToId: null, attachments: [],
      }],
      ["target-2", {
        id: "target-2", authorId: "u2", authorUsername: "bob",
        content: "second", timestamp: 200, isBot: false, replyToId: null, attachments: [],
      }],
    ]);

    const deps = baseDeps({
      fetchDiscordMessage: (_chId, msgId) => Promise.resolve(fetched.get(msgId) ?? null),
    });

    const messages = [
      makeMsg({ id: "3", replyToId: "target-1" }),
      makeMsg({ id: "4", replyToId: "target-2" }),
    ];
    const result = await fetchMissingReplyTargets(deps, messages);

    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id).sort();
    expect(ids).toEqual(["target-1", "target-2"]);
  });

  test("deduplicates multiple references to same missing target", async () => {
    let fetchCount = 0;
    const fetched: FetchedDiscordMessage = {
      id: "target-1", authorId: "u1", authorUsername: "alice",
      content: "msg", timestamp: 100, isBot: false, replyToId: null, attachments: [],
    };

    const deps = baseDeps({
      fetchDiscordMessage: () => {
        fetchCount++;
        return Promise.resolve(fetched);
      },
    });

    const messages = [
      makeMsg({ id: "2", replyToId: "target-1" }),
      makeMsg({ id: "3", replyToId: "target-1" }),
    ];
    const result = await fetchMissingReplyTargets(deps, messages);

    expect(result).toHaveLength(1);
    expect(fetchCount).toBe(1);
  });

  test("does not persist if message already inserted by concurrent fetch", async () => {
    // Pre-insert the target (simulating INSERT OR IGNORE race)
    db.raw.prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("target-1", "g1", "ch1", "u99", "other", "other content", "other content", 0, 500, null);

    const fetched: FetchedDiscordMessage = {
      id: "target-1", authorId: "u99", authorUsername: "targetuser",
      content: "new content", timestamp: 500, isBot: false, replyToId: null, attachments: [],
    };

    const deps = baseDeps({
      fetchDiscordMessage: () => Promise.resolve(fetched),
    });

    const messages = [makeMsg({ id: "2", replyToId: "target-1" })];
    // Should still return the message (using fetched data) even with INSERT OR IGNORE
    const result = await fetchMissingReplyTargets(deps, messages);

    // The DB check happens first, so this should return empty (already in DB)
    expect(result).toEqual([]);
  });

  test("embedding enqueue failure does not prevent return", async () => {
    const fetched: FetchedDiscordMessage = {
      id: "target-1", authorId: "u1", authorUsername: "alice",
      content: "msg", timestamp: 100, isBot: false, replyToId: null, attachments: [],
    };

    const deps = baseDeps({
      fetchDiscordMessage: () => Promise.resolve(fetched),
      enqueueEmbedding: () => Promise.reject(new Error("qdrant down")),
    });

    const messages = [makeMsg({ id: "2", replyToId: "target-1" })];
    const result = await fetchMissingReplyTargets(deps, messages);

    // Still returns the fetched message despite embedding failure
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("target-1");
  });
});
