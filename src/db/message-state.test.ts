import { beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "./database";
import { deleteBotMessageState, getRoutedMessageSource, insertPromptOnlyMessageHandoff, upsertBotMessageContent } from "./message-repository";
import { upsertMessageReaction } from "./message-reactions";

let db: Database;

function insertMessage(input: {
  id: string;
  userId: string;
  isBot: boolean;
  content?: string;
  replyToId?: string | null;
  relatedThreadId?: string | null;
}) {
  db.raw
    .prepare(
      `INSERT INTO messages
         (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id, related_thread_id)
       VALUES (?, 'g1', 'c1', ?, 'author', ?, ?, ?, 100, ?, ?)`
    )
    .run(
      input.id,
      input.userId,
      input.content ?? "old raw",
      input.content ?? "old text",
      input.isBot ? 1 : 0,
      input.replyToId ?? null,
      input.relatedThreadId ?? null,
    );
}

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("bot message state helpers", () => {
  test("upsertBotMessageContent updates content while preserving reply and thread metadata", () => {
    insertMessage({
      id: "m1",
      userId: "bot-1",
      isBot: true,
      replyToId: "user-msg",
      relatedThreadId: "thread-1",
    });

    const row = upsertBotMessageContent(db, {
      id: "m1",
      guildId: "g1",
      channelId: "c1",
      botUserId: "bot-1",
      botUsername: "2b",
      rawContent: "new raw",
      translatedContent: "new text",
      createdAt: 999,
      replyToId: null,
    });

    expect(row.translatedContent).toBe("new text");
    expect(row.createdAt).toBe(100);
    expect(row.replyToId).toBe("user-msg");
    const dbRow = db.raw
      .prepare("SELECT raw_content, translated_content, related_thread_id FROM messages WHERE id = 'm1'")
      .get() as { raw_content: string; translated_content: string; related_thread_id: string | null };
    expect(dbRow).toEqual({
      raw_content: "new raw",
      translated_content: "new text",
      related_thread_id: "thread-1",
    });
  });

  test("upsertBotMessageContent fills missing reply metadata from the live message", () => {
    insertMessage({
      id: "m1",
      userId: "bot-1",
      isBot: true,
      replyToId: null,
    });

    const row = upsertBotMessageContent(db, {
      id: "m1",
      guildId: "g1",
      channelId: "c1",
      botUserId: "bot-1",
      botUsername: "2b",
      rawContent: "new raw",
      translatedContent: "new text",
      createdAt: 999,
      replyToId: "live-reply",
    });

    expect(row.replyToId).toBe("live-reply");
  });

  test("upsertBotMessageContent stores routed source metadata for bot messages", () => {
    upsertBotMessageContent(db, {
      id: "m1",
      guildId: "g2",
      channelId: "c2",
      botUserId: "bot-1",
      botUsername: "2b",
      rawContent: "cross-channel raw",
      translatedContent: "cross-channel text",
      createdAt: 999,
      replyToId: null,
      routedFrom: {
        routedFromGuildId: "g1",
        routedFromChannelId: "c1",
        routedFromMessageId: "source-msg",
      },
    });

    expect(getRoutedMessageSource(db, { messageId: "m1", guildId: "g2", channelId: "c2" })).toEqual({
      routedFromGuildId: "g1",
      routedFromChannelId: "c1",
      routedFromMessageId: "source-msg",
    });
  });

  test("persists escaped source and destination handoffs and returns the destination handoff", () => {
    upsertBotMessageContent(db, {
      id: "routed",
      guildId: "g2",
      channelId: "c2",
      botUserId: "bot-1",
      botUsername: "2b",
      rawContent: "visible",
      translatedContent: "visible",
      createdAt: 999,
      replyToId: null,
      routedFrom: {
        routedFromGuildId: "g1",
        routedFromChannelId: "c1",
        routedFromMessageId: "source-msg",
      },
    });
    insertPromptOnlyMessageHandoff(db, {
      sourceGuildId: "g1",
      sourceChannelId: "c1",
      sourceMessageId: "source-msg",
      destinationGuildId: "g2",
      destinationChannelId: "c2",
      routedMessageId: "routed",
      botUserId: "bot-1",
      botUsername: "2b",
      handoff: "Line one\n2 < 3 & \"quoted\".",
    });

    const expectedHandoff = [
      "<handoff",
      '  source_guild_id="g1"',
      '  source_channel_id="c1"',
      '  source_message_id="source-msg"',
      '  destination_guild_id="g2"',
      '  destination_channel_id="c2"',
      '  routed_message_id="routed">',
      "Line one",
      "2 &lt; 3 &amp; &quot;quoted&quot;.",
      "</handoff>",
    ].join("\n");
    const rows = db.raw.prepare(
      "SELECT id, guild_id, channel_id, translated_content, reply_to_id, is_prompt_only FROM messages WHERE id LIKE 'prompt-only:handoff:%' ORDER BY id",
    ).all() as Array<Record<string, string | number>>;
    expect(rows).toEqual([
      {
        id: "prompt-only:handoff:destination:routed",
        guild_id: "g2",
        channel_id: "c2",
        translated_content: expectedHandoff,
        reply_to_id: "routed",
        is_prompt_only: 1,
      },
      {
        id: "prompt-only:handoff:source:routed",
        guild_id: "g1",
        channel_id: "c1",
        translated_content: expectedHandoff,
        reply_to_id: "source-msg",
        is_prompt_only: 1,
      },
    ]);
    expect(getRoutedMessageSource(db, { messageId: "routed", guildId: "g2", channelId: "c2" }))
      .toEqual({
        routedFromGuildId: "g1",
        routedFromChannelId: "c1",
        routedFromMessageId: "source-msg",
        handoff: expectedHandoff,
      });
    expect(db.raw.prepare("SELECT translated_content FROM messages WHERE id = 'routed'").get())
      .toEqual({ translated_content: "visible" });
  });

  test("upsertBotMessageContent refuses to update user-authored rows", () => {
    insertMessage({ id: "m1", userId: "user-1", isBot: false });

    expect(() => upsertBotMessageContent(db, {
      id: "m1",
      guildId: "g1",
      channelId: "c1",
      botUserId: "bot-1",
      botUsername: "2b",
      rawContent: "new raw",
      translatedContent: "new text",
      createdAt: 999,
      replyToId: null,
    })).toThrow("Refusing");
  });

  test("deleteBotMessageState marks only the bot message deleted and removes its own asset metadata", () => {
    insertMessage({ id: "bot-msg", userId: "bot-1", isBot: true });
    insertMessage({ id: "user-msg", userId: "user-1", isBot: false });
    const insertAsset = db.raw.prepare(`INSERT INTO message_assets
      (message_id, guild_id, channel_id, source_kind, source_key, kind, filename, created_at)
      VALUES (?, 'g1', 'c1', 'attachment', ?, 'image', ?, 100)`);
    insertAsset.run("bot-msg", "bot-asset", "bot.webp");
    insertAsset.run("user-msg", "user-asset", "user.webp");
    expect(upsertMessageReaction(db, {
      messageId: "bot-msg",
      guildId: "g1",
      channelId: "c1",
      emojiKey: "thumbsup",
      emojiLabel: "👍",
      count: 2,
      updatedAt: 100,
    })).toBe(true);
    expect(upsertMessageReaction(db, {
      messageId: "user-msg",
      guildId: "g1",
      channelId: "c1",
      emojiKey: "heart",
      emojiLabel: "❤️",
      count: 1,
      updatedAt: 100,
    })).toBe(true);

    const result = deleteBotMessageState(db, {
      id: "bot-msg",
      guildId: "g1",
      channelId: "c1",
      botUserId: "bot-1",
    });

    expect(result).toEqual({ deleted: true });
    expect(db.raw.prepare("SELECT translated_content, deleted_at FROM messages WHERE id = 'bot-msg'").get())
      .toMatchObject({ translated_content: "old text" });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = 'user-msg'").get()).toEqual({ count: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM message_assets WHERE message_id = 'bot-msg'").get()).toEqual({ count: 0 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM message_assets WHERE message_id = 'user-msg'").get()).toEqual({ count: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = 'bot-msg'").get()).toEqual({ count: 0 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = 'user-msg'").get()).toEqual({ count: 1 });
  });
});
