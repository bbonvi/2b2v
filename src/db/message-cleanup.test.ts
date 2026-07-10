import { describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "./database.ts";
import { insertImage } from "./image-repository.ts";
import {
  cleanupDeletedBotMessage,
  cleanupDeletedDiscordMessage,
  cleanupGuildData,
  cleanupRecentMessages,
} from "./message-cleanup.ts";

function insertMessage(db: Database, id: string, overrides: {
  guildId?: string;
  channelId?: string;
  createdAt?: number;
  isBot?: boolean;
  userId?: string;
} = {}): void {
  db.raw
    .prepare(
      `INSERT INTO messages
       (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
       VALUES (?, ?, ?, ?, 'alice', 'raw', 'text', ?, ?)`,
    )
    .run(
      id,
      overrides.guildId ?? "g1",
      overrides.channelId ?? "c1",
      overrides.userId ?? "u1",
      overrides.isBot === true ? 1 : 0,
      overrides.createdAt ?? 1,
    );
}

function insertGuildMemory(db: Database, guildId: string): void {
  db.raw
    .prepare(
      `INSERT INTO memories (scope, guild_id, kind, content, created_at, updated_at)
       VALUES ('guild', ?, 'fact', 'memory', 1, 1)`,
    )
    .run(guildId);
}

describe("message cleanup", () => {
  test("returns no deletion when SQLite has no matching row", () => {
    const db = createDatabase(":memory:");

    const result = cleanupDeletedBotMessage({
      db,
      guildId: "g1",
      channelId: "c1",
      messageId: "missing",
      botUserId: "bot-1",
    });

    expect(result).toEqual({ messagesDeleted: 0, imagesDeleted: 0 });
    db.close();
  });

  test("marks a stored bot message deleted and removes images", () => {
    const db = createDatabase(":memory:");
    insertMessage(db, "bot-message", { isBot: true, userId: "bot-1" });
    insertImage(db, {
      messageId: "bot-message",
      guildId: "g1",
      channelId: "c1",
      path: "/tmp/missing-bot-image.png",
      mime: "image/png",
      width: 1,
      height: 1,
      createdAt: 1,
    });

    const result = cleanupDeletedBotMessage({
      db,
      guildId: "g1",
      channelId: "c1",
      messageId: "bot-message",
      botUserId: "bot-1",
    });

    expect(result).toEqual({ messagesDeleted: 1, imagesDeleted: 1 });
    expect(db.raw.prepare("SELECT translated_content, deleted_at FROM messages WHERE id = 'bot-message'").get())
      .toMatchObject({ translated_content: "text" });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM images").get()).toEqual({ count: 0 });
    db.close();
  });

  test("marks a Discord message deleted with images and reactions removed", () => {
    const db = createDatabase(":memory:");
    insertMessage(db, "m1");
    insertImage(db, {
      messageId: "m1",
      guildId: "g1",
      channelId: "c1",
      path: "/tmp/missing-test-image.png",
      mime: "image/png",
      width: 1,
      height: 1,
      createdAt: 1,
    });
    db.raw
      .prepare("INSERT INTO message_reactions (message_id, guild_id, channel_id, emoji_key, emoji_label, count, updated_at) VALUES ('m1', 'g1', 'c1', 'e', 'e', 1, 1)")
      .run();

    const result = cleanupDeletedDiscordMessage({
      db,
      guildId: "g1",
      messageId: "m1",
    });

    expect(result).toEqual({ messagesDeleted: 1, imagesDeleted: 1 });
    expect(db.raw.prepare("SELECT translated_content, deleted_at FROM messages WHERE id = 'm1'").get())
      .toMatchObject({ translated_content: "text" });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM images").get()).toEqual({ count: 0 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM message_reactions").get()).toEqual({ count: 0 });
    db.close();
  });

  test("recent cleanup only deletes newest messages in one channel", () => {
    const db = createDatabase(":memory:");
    insertMessage(db, "old", { createdAt: 1 });
    insertMessage(db, "new", { createdAt: 2 });
    insertMessage(db, "other-channel", { channelId: "c2", createdAt: 3 });

    const result = cleanupRecentMessages({
      db,
      channelId: "c1",
      count: 1,
    });

    expect(result).toEqual({ messagesDeleted: 1, imagesDeleted: 0 });
    const remaining = db.raw.prepare("SELECT id FROM messages ORDER BY id").all() as Array<{ id: string }>;
    expect(remaining.map((row) => row.id)).toEqual(["old", "other-channel"]);
    db.close();
  });

  test("guild cleanup removes guild memories, messages, images, and reactions", () => {
    const db = createDatabase(":memory:");
    insertGuildMemory(db, "g1");
    insertGuildMemory(db, "g2");
    insertMessage(db, "g1-message", { guildId: "g1" });
    insertMessage(db, "g2-message", { guildId: "g2" });
    insertImage(db, {
      messageId: "g1-message",
      guildId: "g1",
      channelId: "c1",
      path: "/tmp/missing-guild-image.png",
      mime: "image/png",
      width: 1,
      height: 1,
      createdAt: 1,
    });
    db.raw
      .prepare("INSERT INTO message_reactions (message_id, guild_id, channel_id, emoji_key, emoji_label, count, updated_at) VALUES ('g1-message', 'g1', 'c1', 'e', 'e', 1, 1)")
      .run();

    const result = cleanupGuildData({
      db,
      guildId: "g1",
    });

    expect(result).toEqual({ memoriesDeleted: 1, messagesDeleted: 1, imagesDeleted: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM messages WHERE guild_id = 'g1'").get()).toEqual({ count: 0 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM messages WHERE guild_id = 'g2'").get()).toEqual({ count: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM memories WHERE guild_id = 'g1'").get()).toEqual({ count: 0 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM memories WHERE guild_id = 'g2'").get()).toEqual({ count: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM images").get()).toEqual({ count: 0 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM message_reactions").get()).toEqual({ count: 0 });
    db.close();
  });
});
