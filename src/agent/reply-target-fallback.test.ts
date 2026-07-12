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

const TARGET_ID = "100000000000000001";
const SECOND_TARGET_ID = "100000000000000002";
const MISSING_ID = "100000000000000003";

beforeEach(() => {
  db = createDatabase(":memory:");
});

function baseDeps(overrides: Partial<ReplyFallbackDeps> = {}): ReplyFallbackDeps {
  return {
    db,
    guildId: "g1",
    channelId: "ch1",
    fetchDiscordMessage: () => Promise.resolve(null),
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

  test("hydrates reply target when it exists in DB", async () => {
    // Pre-insert the target message into DB
    db.raw.prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("target-1", "g1", "ch1", "u99", "targetuser", "original", "translated", 0, 500, null);

    const messages = [makeMsg({ id: "2", replyToId: "target-1" })];
    const result = await fetchMissingReplyTargets(baseDeps(), messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("target-1");
    expect(result[0]?.author).toBe("targetuser");
    expect(result[0]?.content).toBe("translated");
  });

  test("fetches missing target from Discord and persists", async () => {
    const fetched: FetchedDiscordMessage = {
      id: TARGET_ID,
      authorId: "u99",
      authorUsername: "targetuser",
      content: "original content",
      timestamp: 500,
      isBot: false,
      replyToId: null,
      attachments: [],
    };

    const deps = baseDeps({
      fetchDiscordMessage: (_chId, msgId) =>
        msgId === TARGET_ID ? Promise.resolve(fetched) : Promise.resolve(null),
    });

    const messages = [makeMsg({ id: "2", replyToId: TARGET_ID })];
    const result = await fetchMissingReplyTargets(deps, messages);

    // Returns the fetched message as HistoryMessage
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(TARGET_ID);
    expect(result[0]?.author).toBe("targetuser");
    expect(result[0]?.content).toBe("original content");
    expect(result[0]?.timestamp).toBe(500);
    expect(result[0]?.replyToId).toBeNull();

    // Persisted in DB
    const row = db.raw.prepare("SELECT * FROM messages WHERE id = ?").get(TARGET_ID) as Record<string, unknown> | null;
    expect(row).not.toBeNull();
    expect(row?.translated_content).toBe("original content");
    expect(row?.author_username).toBe("targetuser");
    expect(row?.guild_id).toBe("g1");

  });

  test("gracefully handles fetch failure (deleted/no perms)", async () => {
    const deps = baseDeps({
      fetchDiscordMessage: () => Promise.resolve(null),
    });

    const messages = [makeMsg({ id: "2", replyToId: MISSING_ID })];
    const result = await fetchMissingReplyTargets(deps, messages);

    // Returns empty — missing target will be handled by resolveReplies missingTarget logic
    expect(result).toEqual([]);
  });

  test("gracefully handles fetch error (network)", async () => {
    const deps = baseDeps({
      fetchDiscordMessage: () => Promise.reject(new Error("network error")),
    });

    const messages = [makeMsg({ id: "2", replyToId: MISSING_ID })];
    const result = await fetchMissingReplyTargets(deps, messages);
    expect(result).toEqual([]);
  });

  test("does not fetch internal reply target IDs from Discord", async () => {
    let fetchCount = 0;
    const deps = baseDeps({
      fetchDiscordMessage: () => {
        fetchCount++;
        return Promise.resolve(null);
      },
    });

    const result = await fetchMissingReplyTargets(deps, [
      makeMsg({ id: "2", replyToId: "scheduled-task-123" }),
    ]);

    expect(result).toEqual([]);
    expect(fetchCount).toBe(0);
  });

  test("does not eagerly download attachments on fetched message", async () => {
    const processImageCalls: Array<{ url: string; messageId: string; sourceKind: string | undefined }> = [];

    const fetched: FetchedDiscordMessage = {
      id: TARGET_ID,
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
      processImage: (url, _contentType, messageId, sourceKind) => {
        processImageCalls.push({ url, messageId, sourceKind });
        return Promise.resolve();
      },
    });

    const messages = [makeMsg({ id: "2", replyToId: TARGET_ID })];
    await fetchMissingReplyTargets(deps, messages);

    expect(processImageCalls).toHaveLength(0);
  });

  test("adds sticker tags without eagerly downloading sticker previews", async () => {
    const processImageCalls: Array<{ url: string; sourceKind: string | undefined }> = [];

    const fetched: FetchedDiscordMessage = {
      id: TARGET_ID,
      authorId: "u99",
      authorUsername: "targetuser",
      content: "",
      timestamp: 500,
      isBot: false,
      replyToId: null,
      attachments: [],
      stickers: [{ name: "Blob Dance", url: "https://cdn.example.com/blob.png", format: 1 }],
    };

    const deps = baseDeps({
      fetchDiscordMessage: () => Promise.resolve(fetched),
      processImage: (url, _contentType, _messageId, sourceKind) => {
        processImageCalls.push({ url, sourceKind });
        return Promise.resolve();
      },
    });

    const result = await fetchMissingReplyTargets(deps, [makeMsg({ id: "2", replyToId: TARGET_ID })]);

    expect(result[0]?.content).toBe("<sticker>Blob Dance</sticker>");
    expect(processImageCalls).toEqual([]);
  });

  test("does not eagerly download GIF-like embed previews", async () => {
    const processImageCalls: Array<{ url: string; contentType: string; sourceKind: string | undefined }> = [];
    const fetched: FetchedDiscordMessage = {
      id: TARGET_ID,
      authorId: "u99",
      authorUsername: "targetuser",
      content: "https://tenor.com/view/dance",
      timestamp: 500,
      isBot: false,
      replyToId: null,
      attachments: [],
      embeds: [{
        provider: { name: "Tenor" },
        url: "https://tenor.com/view/dance",
        thumbnail: { url: "https://media.tenor.com/dance.webp" },
      }],
    };

    const deps = baseDeps({
      fetchDiscordMessage: () => Promise.resolve(fetched),
      processImage: (url, contentType, _messageId, sourceKind) => {
        processImageCalls.push({ url, contentType, sourceKind });
        return Promise.resolve();
      },
    });

    await fetchMissingReplyTargets(deps, [makeMsg({ id: "2", replyToId: TARGET_ID })]);

    expect(processImageCalls).toEqual([]);
  });

  test("does not eagerly download gifv embed previews", async () => {
    const processImageCalls: Array<{ url: string; sourceKind: string | undefined }> = [];
    const fetched: FetchedDiscordMessage = {
      id: TARGET_ID,
      authorId: "u99",
      authorUsername: "targetuser",
      content: "https://example.com/clip",
      timestamp: 500,
      isBot: false,
      replyToId: null,
      attachments: [],
      embeds: [{
        type: "gifv",
        url: "https://example.com/clip",
        image: { url: "https://cdn.example.com/clip.png" },
      }],
    };

    const deps = baseDeps({
      fetchDiscordMessage: () => Promise.resolve(fetched),
      processImage: (url, _contentType, _messageId, sourceKind) => {
        processImageCalls.push({ url, sourceKind });
        return Promise.resolve();
      },
    });

    await fetchMissingReplyTargets(deps, [makeMsg({ id: "2", replyToId: TARGET_ID })]);

    expect(processImageCalls).toEqual([]);
  });

  test("handles multiple missing targets", async () => {
    const fetched = new Map<string, FetchedDiscordMessage>([
      [TARGET_ID, {
        id: TARGET_ID, authorId: "u1", authorUsername: "alice",
        content: "first", timestamp: 100, isBot: false, replyToId: null, attachments: [],
      }],
      [SECOND_TARGET_ID, {
        id: SECOND_TARGET_ID, authorId: "u2", authorUsername: "bob",
        content: "second", timestamp: 200, isBot: false, replyToId: null, attachments: [],
      }],
    ]);

    const deps = baseDeps({
      fetchDiscordMessage: (_chId, msgId) => Promise.resolve(fetched.get(msgId) ?? null),
    });

    const messages = [
      makeMsg({ id: "3", replyToId: TARGET_ID }),
      makeMsg({ id: "4", replyToId: SECOND_TARGET_ID }),
    ];
    const result = await fetchMissingReplyTargets(deps, messages);

    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id).sort();
    expect(ids).toEqual([TARGET_ID, SECOND_TARGET_ID]);
  });

  test("deduplicates multiple references to same missing target", async () => {
    let fetchCount = 0;
    const fetched: FetchedDiscordMessage = {
      id: TARGET_ID, authorId: "u1", authorUsername: "alice",
      content: "msg", timestamp: 100, isBot: false, replyToId: null, attachments: [],
    };

    const deps = baseDeps({
      fetchDiscordMessage: () => {
        fetchCount++;
        return Promise.resolve(fetched);
      },
    });

    const messages = [
      makeMsg({ id: "2", replyToId: TARGET_ID }),
      makeMsg({ id: "3", replyToId: TARGET_ID }),
    ];
    const result = await fetchMissingReplyTargets(deps, messages);

    expect(result).toHaveLength(1);
    expect(fetchCount).toBe(1);
  });

  test("hydrates stored message instead of fetching when already inserted", async () => {
    // Pre-insert the target (simulating INSERT OR IGNORE race)
    db.raw.prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(TARGET_ID, "g1", "ch1", "u99", "other", "other content", "other content", 0, 500, null);

    const fetched: FetchedDiscordMessage = {
      id: TARGET_ID, authorId: "u99", authorUsername: "targetuser",
      content: "new content", timestamp: 500, isBot: false, replyToId: null, attachments: [],
    };

    const deps = baseDeps({
      fetchDiscordMessage: () => Promise.resolve(fetched),
    });

    const messages = [makeMsg({ id: "2", replyToId: TARGET_ID })];
    const result = await fetchMissingReplyTargets(deps, messages);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(TARGET_ID);
    expect(result[0]?.author).toBe("other");
    expect(result[0]?.content).toBe("other content");
  });

});
