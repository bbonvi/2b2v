import { describe, expect, test } from "bun:test";
import type { RepertoireConfig } from "../config/types.ts";
import { createDatabase, type Database } from "../db/database.ts";
import { buildRepertoireContext } from "./repertoire-context.ts";

const CONFIG: RepertoireConfig = {
  enabled: true,
  lookbackHours: 48,
  refreshMinutes: 1,
  maxSourceChannels: 4,
  maxMessages: 15,
  maxChars: 10_000,
};

function insertMessage(
  db: Database,
  input: {
    id: string;
    guildId: string;
    channelId: string;
    userId: string;
    content: string;
    createdAt: number;
    isBot?: boolean;
    rawContent?: string;
    replyToId?: string;
  },
): void {
  db.raw.prepare(
    `INSERT INTO messages
       (id, guild_id, channel_id, user_id, author_username, raw_content,
        translated_content, is_bot, created_at, reply_to_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.guildId,
    input.channelId,
    input.userId,
    input.userId,
    input.rawContent ?? input.content,
    input.content,
    input.isBot === true ? 1 : 0,
    input.createdAt,
    input.replyToId ?? null,
  );
}

describe("buildRepertoireContext", () => {
  test("rotates grounded excerpts from other rooms and keeps multi-send rhythm", () => {
    const db = createDatabase(":memory:");
    const now = 2_000_000_000;
    try {
      insertMessage(db, {
        id: "current-bot",
        guildId: "current-guild",
        channelId: "current-room",
        userId: "2b",
        content: "never include current room",
        createdAt: now - 1_000,
        isBot: true,
      });
      insertMessage(db, {
        id: "mention",
        guildId: "foreign-guild",
        channelId: "foreign-room",
        userId: "alice",
        content: "<@2b> look <:wave:123>",
        createdAt: now - 400_000,
      });
      insertMessage(db, {
        id: "foreign-bot-1",
        guildId: "foreign-guild",
        channelId: "foreign-room",
        userId: "2b",
        content: "first beat",
        createdAt: now - 399_000,
        isBot: true,
      });
      insertMessage(db, {
        id: "foreign-bot-2",
        guildId: "foreign-guild",
        channelId: "foreign-room",
        userId: "2b",
        content: "second beat",
        createdAt: now - 398_500,
        isBot: true,
      });
      insertMessage(db, {
        id: "foreign-standalone",
        guildId: "foreign-guild",
        channelId: "foreign-room",
        userId: "2b",
        content: "unprompted thought",
        createdAt: now - 200_000,
        isBot: true,
      });
      insertMessage(db, {
        id: "reply-cue",
        guildId: "current-guild",
        channelId: "other-room",
        userId: "bob",
        content: "old direct question",
        createdAt: now - 150_000,
      });
      insertMessage(db, {
        id: "intervening-bot",
        guildId: "current-guild",
        channelId: "other-room",
        userId: "other-bot",
        content: "noise",
        createdAt: now - 149_000,
        isBot: true,
      });
      insertMessage(db, {
        id: "direct-reply",
        guildId: "current-guild",
        channelId: "other-room",
        userId: "2b",
        content: "direct answer <:local:456>",
        createdAt: now - 148_000,
        isBot: true,
        replyToId: "reply-cue",
      });

      const input = {
        db,
        config: CONFIG,
        instruction: "## Repertoire\nUse these as examples.",
        botUserId: "2b",
        currentGuildId: "current-guild",
        currentChannelId: "current-room",
        mergeMessageGapSeconds: 90,
        random: () => 0,
      };
      const first = buildRepertoireContext({ ...input, now });
      expect(first).toContain("Participant: <@2b> look :wave:");
      expect(first).toContain("2B: first beat\n2B: second beat");
      expect(first).toContain("2B: unprompted thought");
      expect(first).toContain("Participant: old direct question");
      expect(first).toContain("2B: direct answer <:local:456>");
      expect(first).not.toContain("never include current room");

      insertMessage(db, {
        id: "new-after-cache",
        guildId: "current-guild",
        channelId: "other-room",
        userId: "2b",
        content: "new rotation",
        createdAt: now,
        isBot: true,
      });
      expect(buildRepertoireContext({ ...input, now: now + 1 })).not.toContain("new rotation");
      expect(buildRepertoireContext({ ...input, now: now + 60_001 })).toContain("new rotation");
    } finally {
      db.close();
    }
  });

  test("ranks source rooms by the persona's own activity", () => {
    const db = createDatabase(":memory:");
    const now = 3_000_000_000;
    try {
      insertMessage(db, {
        id: "noisy-human-1",
        guildId: "g",
        channelId: "human-noisy",
        userId: "u1",
        content: "noise one",
        createdAt: now - 5_000,
      });
      insertMessage(db, {
        id: "noisy-human-2",
        guildId: "g",
        channelId: "human-noisy",
        userId: "u2",
        content: "noise two",
        createdAt: now - 4_000,
      });
      insertMessage(db, {
        id: "noisy-bot",
        guildId: "g",
        channelId: "human-noisy",
        userId: "2b",
        content: "low persona activity",
        createdAt: now - 3_000,
        isBot: true,
      });
      insertMessage(db, {
        id: "rich-bot-1",
        guildId: "g",
        channelId: "persona-rich",
        userId: "2b",
        content: "high activity one",
        createdAt: now - 2_000,
        isBot: true,
      });
      insertMessage(db, {
        id: "rich-bot-2",
        guildId: "g",
        channelId: "persona-rich",
        userId: "2b",
        content: "high activity two",
        createdAt: now - 1_000,
        isBot: true,
      });

      const context = buildRepertoireContext({
        db,
        config: { ...CONFIG, maxSourceChannels: 1 },
        instruction: "## Repertoire",
        botUserId: "2b",
        currentGuildId: "g",
        currentChannelId: "ranking-target",
        mergeMessageGapSeconds: 90,
        now,
        random: () => 0,
      });
      expect(context).toContain("high activity one");
      expect(context).toContain("high activity two");
      expect(context).not.toContain("low persona activity");
    } finally {
      db.close();
    }
  });
});
