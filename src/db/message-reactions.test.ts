import { beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "./database";
import { getContextHistoryMessages } from "./message-repository";
import { deleteMessageEmojiReaction, deleteMessageReactions, upsertMessageReaction } from "./message-reactions";
import type { TrimConfig } from "../config/types";

let db: Database;
const now = Date.now();
const trim: TrimConfig = {
  trimTrigger: 10,
  trimTarget: 10,
  windowSize: 20,
  messageCharLimit: 200,
  replyQuoteChars: 50,
};

function insertMessage(id: string): void {
  db.raw
    .prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
       VALUES (?, 'g1', 'c1', 'u1', 'alice', ?, ?, 0, ?)`
    )
    .run(id, `raw ${id}`, `translated ${id}`, now);
}

describe("message reactions", () => {
  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  test("hydrates durable reaction summaries for known messages", () => {
    insertMessage("m1");

    expect(upsertMessageReaction(db, {
      messageId: "m1",
      guildId: "g1",
      channelId: "c1",
      emojiKey: "unicode:👍",
      emojiLabel: "👍",
      count: 3,
      updatedAt: now + 1,
    })).toBe(true);
    expect(upsertMessageReaction(db, {
      messageId: "m1",
      guildId: "g1",
      channelId: "c1",
      emojiKey: "custom:123",
      emojiLabel: ":party:",
      count: 1,
      updatedAt: now + 2,
    })).toBe(true);

    const rows = getContextHistoryMessages(db, "c1", trim);
    expect(rows[0]?.reactions).toBe("👍:3 :party::1");
  });

  test("ignores unknown messages and removes zero-count reactions", () => {
    insertMessage("m1");

    expect(upsertMessageReaction(db, {
      messageId: "missing",
      guildId: "g1",
      channelId: "c1",
      emojiKey: "unicode:👍",
      emojiLabel: "👍",
      count: 2,
    })).toBe(false);
    expect(upsertMessageReaction(db, {
      messageId: "m1",
      guildId: "g1",
      channelId: "c1",
      emojiKey: "unicode:👍",
      emojiLabel: "👍",
      count: 2,
    })).toBe(true);
    expect(upsertMessageReaction(db, {
      messageId: "m1",
      guildId: "g1",
      channelId: "c1",
      emojiKey: "unicode:👍",
      emojiLabel: "👍",
      count: 0,
    })).toBe(true);

    expect(getContextHistoryMessages(db, "c1", trim)[0]?.reactions).toBeUndefined();
  });

  test("deletes one emoji summary or all summaries for a message", () => {
    insertMessage("m1");
    upsertMessageReaction(db, {
      messageId: "m1",
      guildId: "g1",
      channelId: "c1",
      emojiKey: "unicode:👍",
      emojiLabel: "👍",
      count: 2,
    });
    upsertMessageReaction(db, {
      messageId: "m1",
      guildId: "g1",
      channelId: "c1",
      emojiKey: "custom:123",
      emojiLabel: ":party:",
      count: 1,
    });

    deleteMessageEmojiReaction(db, "m1", "custom:123", "g1");
    expect(getContextHistoryMessages(db, "c1", trim)[0]?.reactions).toBe("👍:2");

    deleteMessageReactions(db, "m1", "g1");
    expect(getContextHistoryMessages(db, "c1", trim)[0]?.reactions).toBeUndefined();
  });
});
