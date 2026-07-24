import { test, expect, beforeEach, describe } from "bun:test";
import { createDatabase, type Database } from "./database";
import { getMessageById, searchMessagesLiteral, getMessagesAroundMessage, getMessagesAroundTimestamp, getHistoryMessages, getContextHistoryMessages, getLatestMessageActivityBefore, insertSyntheticEvent, insertPromptOnlyBotMessage, getParentPreContext, listBotChannelActivityUsage, listBotChannelUsage, listDiscordChannelUsage, listChannelMessages, markDiscordMessageDeleted } from "./message-repository";

let db: Database;

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
    webhookId?: string;
    createdAt?: number;
    replyToId?: string | null;
    isSynthetic?: boolean;
    isPromptOnly?: boolean;
    relatedThreadId?: string | null;
  } = {}
) {
  db.raw
    .prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, webhook_id, created_at, reply_to_id, is_synthetic, is_prompt_only, related_thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      opts.webhookId ?? null,
      opts.createdAt ?? now,
      opts.replyToId ?? null,
      opts.isSynthetic === true ? 1 : 0,
      opts.isPromptOnly === true ? 1 : 0,
      opts.relatedThreadId ?? null
    );
}

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("listBotChannelUsage", () => {
  test("ranks channels by real visible messages from the selected bot", () => {
    insertMessage("b1", { guildId: "g1", channelId: "c1", userId: "bot", isBot: true, createdAt: now });
    insertMessage("b2", { guildId: "g1", channelId: "c1", userId: "bot", isBot: true, createdAt: now + 1 });
    insertMessage("b3", { guildId: "g2", channelId: "c2", userId: "bot", isBot: true, createdAt: now + 2 });
    insertMessage("human-c1", { guildId: "g1", channelId: "c1", userId: "human", createdAt: now + 3 });
    insertMessage("other-bot", { guildId: "g3", channelId: "c3", userId: "other", isBot: true });
    insertMessage("human", { guildId: "g3", channelId: "c3", userId: "human" });
    insertMessage("synthetic", { guildId: "g3", channelId: "c4", userId: "bot", isBot: true, isSynthetic: true });
    insertMessage("prompt-only", { guildId: "g3", channelId: "c4", userId: "bot", isBot: true, isPromptOnly: true });
    insertMessage("deleted", { guildId: "g3", channelId: "c4", userId: "bot", isBot: true });
    markDiscordMessageDeleted(db, { id: "deleted", guildId: "g3", botUserId: "bot" });

    expect(listBotChannelUsage(db, "bot", 5)).toEqual([
      { guildId: "g1", channelId: "c1", messageCount: 2 },
      { guildId: "g2", channelId: "c2", messageCount: 1 },
    ]);
    expect(listBotChannelActivityUsage(db, "bot", 5)).toEqual([
      { guildId: "g1", channelId: "c1", messageCount: 2, lastHumanActivityAt: now + 3 },
      { guildId: "g2", channelId: "c2", messageCount: 1, lastHumanActivityAt: null },
    ]);
  });

  test("adds recent bot activity and unique seven-day human posters", () => {
    const day = 24 * hour;
    insertMessage("recent-bot-1", { guildId: "g1", channelId: "c1", userId: "bot", isBot: true, createdAt: now - hour });
    insertMessage("recent-bot-2", { guildId: "g1", channelId: "c1", userId: "bot", isBot: true, createdAt: now - 2 * hour });
    insertMessage("old-bot", { guildId: "g1", channelId: "c1", userId: "bot", isBot: true, createdAt: now - 2 * day });
    insertMessage("alice-1", { guildId: "g1", channelId: "c1", userId: "alice", createdAt: now - day });
    insertMessage("alice-2", { guildId: "g1", channelId: "c1", userId: "alice", createdAt: now - 2 * day });
    insertMessage("bob", { guildId: "g1", channelId: "c1", userId: "bob", createdAt: now - 6 * day });
    insertMessage("old-human", { guildId: "g1", channelId: "c1", userId: "carol", createdAt: now - 8 * day });
    insertMessage("synthetic-human", { guildId: "g1", channelId: "c1", userId: "dave", createdAt: now, isSynthetic: true });

    expect(listDiscordChannelUsage(db, {
      botUserId: "bot",
      limit: 5,
      recentBotSince: now - day,
      activeHumanSince: now - 7 * day,
    })).toEqual([{
      guildId: "g1",
      channelId: "c1",
      messageCount: 3,
      recentBotMessageCount: 2,
      activeHumanPosterCount: 2,
    }]);
  });
});

describe("getLatestMessageActivityBefore", () => {
  test("finds latest visible activity with optional scope filters", () => {
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    insertMessage("current", { guildId: "g1", channelId: "c1", userId: "u1", createdAt: base });
    insertMessage("older-channel", { guildId: "g1", channelId: "c1", userId: "u2", createdAt: base - hour });
    insertMessage("older-user-anywhere", { guildId: "g2", channelId: "c9", userId: "u1", createdAt: base - 2 * hour });
    insertMessage("newer-after-current", { guildId: "g1", channelId: "c1", userId: "u3", createdAt: base + hour });

    expect(getLatestMessageActivityBefore(db, {
      beforeCreatedAt: base,
      beforeMessageId: "current",
      guildId: "g1",
      channelId: "c1",
    })?.id).toBe("older-channel");

    expect(getLatestMessageActivityBefore(db, {
      beforeCreatedAt: base,
      beforeMessageId: "current",
      userId: "u1",
      isBot: false,
    })?.id).toBe("older-user-anywhere");
  });

  test("ignores synthetic and prompt-only rows", () => {
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    insertMessage("current", { guildId: "g1", channelId: "c1", createdAt: base });
    insertMessage("prompt-only", { guildId: "g1", channelId: "c1", createdAt: base - 10, isPromptOnly: true });
    insertMessage("synthetic", { guildId: "g1", channelId: "c1", createdAt: base - 20, isSynthetic: true });

    expect(getLatestMessageActivityBefore(db, {
      beforeCreatedAt: base,
      beforeMessageId: "current",
      guildId: "g1",
      channelId: "c1",
    })).toBeNull();
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

  test("excludes deleted messages from literal search", () => {
    insertMessage("real-msg", { guildId: "g1", translatedContent: "delete reason topic" });
    insertMessage("deleted-msg", { guildId: "g1", translatedContent: "delete reason topic" });
    markDiscordMessageDeleted(db, { id: "deleted-msg", guildId: "g1", channelId: "c1" });
    const results = searchMessagesLiteral(db, "delete reason topic", { guildId: "g1", limit: 10 });
    expect(results.map((r) => r.id)).toEqual(["real-msg"]);
  });
});

describe("getHistoryMessages", () => {
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
      hasEmbeds: false,
      isSynthetic: false,
      isPromptOnly: false,
      isDeleted: false,
      relatedThreadId: null,
    });
  });

  test("treats searchable dice records as system-level prompt events", () => {
    const event = '<dice_roll source="2B" actor_name="V" lang="en" notation="1d20" total="20"/>';
    insertMessage("roll-1", { translatedContent: event, isBot: true });

    expect(getHistoryMessages(db, "c1", 10)[0]).toMatchObject({ content: event, isSynthetic: true });
    expect(searchMessagesLiteral(db, "dice_roll", { guildId: "g1", limit: 10 }).map((result) => result.id)).toEqual(["roll-1"]);
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

    const results = getHistoryMessages(db, "c1", 10);
    for (const msg of results) {
      expect(msg.hasEmbeds).toBe(false);
    }
  });

  test("hydrates webhook identity", () => {
    insertMessage("webhook-message", {
      authorUsername: "GitHub",
      userId: "webhook-1",
      isBot: true,
      webhookId: "webhook-1",
    });

    expect(getHistoryMessages(db, "c1", 10)[0]).toMatchObject({
      author: "GitHub",
      webhookId: "webhook-1",
    });
  });
});

describe("getContextHistoryMessages", () => {
  const trim = {
    trimTrigger: 10,
    trimTarget: 8,
    windowSize: 3,
    messageCharLimit: 200,
    replyQuoteChars: 50,
  };

  test("keeps oldest included message stable until a full window chunk accumulates", () => {
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
    for (let i = 0; i < 11; i += 1) {
      insertMessage(`m${i}`, { channelId: "c1", createdAt: now + i });
    }

    const withoutLatest = getContextHistoryMessages(db, "c1", trim, "m10");
    expect(withoutLatest.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
  });

  test("excludes all current-turn messages before calculating context", () => {
    for (let i = 0; i < 12; i += 1) {
      insertMessage(`m${i}`, { channelId: "c1", createdAt: now + i });
    }

    const withoutCurrentTurn = getContextHistoryMessages(db, "c1", trim, ["m9", "m10", "m11"]);
    expect(withoutCurrentTurn.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]);
  });

  test("includes prompt-only bot rows in context history", () => {
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

  test("keeps deleted message content in context history", () => {
    insertMessage("deleted-msg", { channelId: "c1", translatedContent: "remove me", createdAt: now });
    markDiscordMessageDeleted(db, { id: "deleted-msg", guildId: "g1", channelId: "c1" });

    const rows = getContextHistoryMessages(db, "c1", trim);
    expect(rows.map((m) => [m.id, m.content, m.isDeleted])).toEqual([
      ["deleted-msg", "remove me", true],
    ]);
  });

});

describe("getParentPreContext", () => {
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
      hasEmbeds: false,
      isSynthetic: false,
      isPromptOnly: false,
      isDeleted: false,
      relatedThreadId: null,
      reactions: undefined,
    });
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
    expect(row.translated_content).toBe("Event: Thread created — request handed off to thread — Help Discussion (channel_id: thread-456)");
    expect(row.raw_content).toBe("Event: Thread created — request handed off to thread — Help Discussion (channel_id: thread-456)");
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

describe("listChannelMessages", () => {
  test("returns messages in chronological order (oldest first)", () => {
    const now = Date.now();
    insertMessage("older", { guildId: "g1", channelId: "c1", createdAt: now - 2000 });
    insertMessage("newer", { guildId: "g1", channelId: "c1", createdAt: now - 1000 });
    insertMessage("newest", { guildId: "g1", channelId: "c1", createdAt: now });

    const results = listChannelMessages(db, "g1", "c1", { limit: 10 }) ?? [];
    expect(results.length).toBe(3);
    expect(results[0]?.id).toBe("older");
    expect(results[1]?.id).toBe("newer");
    expect(results[2]?.id).toBe("newest");
  });

  test("filters by guild and channel", () => {
    insertMessage("m1", { guildId: "g1", channelId: "c1" });
    insertMessage("m2", { guildId: "g1", channelId: "c2" });
    insertMessage("m3", { guildId: "g2", channelId: "c1" });

    const results = listChannelMessages(db, "g1", "c1", { limit: 10 }) ?? [];
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("m1");
  });

  test("respects limit (most recent N, then chronological)", () => {
    insertMessage("m1", { guildId: "g1", channelId: "c1", createdAt: Date.now() - 3000 });
    insertMessage("m2", { guildId: "g1", channelId: "c1", createdAt: Date.now() - 2000 });
    insertMessage("m3", { guildId: "g1", channelId: "c1", createdAt: Date.now() - 1000 });

    const results = listChannelMessages(db, "g1", "c1", { limit: 2 }) ?? [];
    expect(results.length).toBe(2);
    // Limit takes most recent 2, then reverses to chronological
    expect(results[0]?.id).toBe("m2");
    expect(results[1]?.id).toBe("m3");
  });

  test("pages older messages before a cursor", () => {
    const now = Date.now();
    insertMessage("m1", { guildId: "g1", channelId: "c1", createdAt: now - 4000 });
    insertMessage("m2", { guildId: "g1", channelId: "c1", createdAt: now - 3000 });
    insertMessage("m3", { guildId: "g1", channelId: "c1", createdAt: now - 2000 });
    insertMessage("m4", { guildId: "g1", channelId: "c1", createdAt: now - 1000 });

    const results = listChannelMessages(db, "g1", "c1", { limit: 2, beforeMessageId: "m4" }) ?? [];

    expect(results.map((r) => r.id)).toEqual(["m2", "m3"]);
  });

  test("pages newer messages after a cursor", () => {
    const now = Date.now();
    insertMessage("m1", { guildId: "g1", channelId: "c1", createdAt: now - 4000 });
    insertMessage("m2", { guildId: "g1", channelId: "c1", createdAt: now - 3000 });
    insertMessage("m3", { guildId: "g1", channelId: "c1", createdAt: now - 2000 });
    insertMessage("m4", { guildId: "g1", channelId: "c1", createdAt: now - 1000 });

    const results = listChannelMessages(db, "g1", "c1", { limit: 2, afterMessageId: "m1" }) ?? [];

    expect(results.map((r) => r.id)).toEqual(["m2", "m3"]);
  });

  test("returns chronological context around an anchor", () => {
    const now = Date.now();
    for (let i = 1; i <= 5; i++) {
      insertMessage(`m${i}`, { guildId: "g1", channelId: "c1", createdAt: now + i });
    }

    const results = listChannelMessages(db, "g1", "c1", { limit: 3, aroundMessageId: "m3" }) ?? [];

    expect(results.map((r) => r.id)).toEqual(["m2", "m3", "m4"]);
  });

  test("around context includes attachment-only anchors and synthetic neighbors", () => {
    const now = Date.now();
    insertMessage("before", { guildId: "g1", channelId: "c1", createdAt: now });
    insertMessage("anchor", { guildId: "g1", channelId: "c1", translatedContent: "", createdAt: now + 1 });
    insertMessage("event", { guildId: "g1", channelId: "c1", isSynthetic: true, createdAt: now + 2 });

    const results = listChannelMessages(db, "g1", "c1", { limit: 3, aroundMessageId: "anchor" }) ?? [];

    expect(results.map((r) => r.id)).toEqual(["before", "anchor", "event"]);
  });

  test("returns null for missing cursor", () => {
    const results = listChannelMessages(db, "g1", "c1", { limit: 2, beforeMessageId: "missing" });

    expect(results).toBeNull();
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

    const results = listChannelMessages(db, "g1", "c1", { limit: 10 }) ?? [];
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

    const results = listChannelMessages(db, "g1", "c1", { limit: 10 }) ?? [];
    expect(results.map((r) => r.id)).toEqual(["real-msg"]);
  });

  test("returns correct ChannelMessageRow structure", () => {
    insertMessage("m1", { guildId: "g1", channelId: "c1", authorUsername: "alice", translatedContent: "Hello world" });

    const results = listChannelMessages(db, "g1", "c1", { limit: 10 }) ?? [];
    expect(results.length).toBe(1);
    const row = results[0];
    expect(row?.id).toBe("m1");
    expect(row?.author).toBe("alice");
    expect(row?.content).toBe("Hello world");
    expect(typeof row?.timestamp).toBe("number");
  });
});
