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

function insertBotSeries(
  db: Database,
  input: {
    guildId: string;
    channelId: string;
    prefix: string;
    count: number;
    startAt: number;
    gapMs?: number;
  },
): void {
  for (let index = 0; index < input.count; index += 1) {
    insertMessage(db, {
      id: `${input.prefix}-${index + 1}`,
      guildId: input.guildId,
      channelId: input.channelId,
      userId: "2b",
      content: `${input.prefix} ${index + 1}`,
      createdAt: input.startAt + index * (input.gapMs ?? 100_000),
      isBot: true,
    });
  }
}

describe("buildRepertoireContext", () => {
  test("samples grounded excerpts and keeps multi-send rhythm", () => {
    const db = createDatabase(":memory:");
    const now = 2_000_160_000;
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
        createdAt: now - 2_000_000,
      });
      insertMessage(db, {
        id: "foreign-bot-1",
        guildId: "foreign-guild",
        channelId: "foreign-room",
        userId: "2b",
        content: "first beat",
        createdAt: now - 1_999_000,
        isBot: true,
      });
      insertMessage(db, {
        id: "foreign-bot-2",
        guildId: "foreign-guild",
        channelId: "foreign-room",
        userId: "2b",
        content: "second beat",
        createdAt: now - 1_998_500,
        isBot: true,
      });
      insertMessage(db, {
        id: "foreign-standalone",
        guildId: "foreign-guild",
        channelId: "foreign-room",
        userId: "2b",
        content: "unprompted thought",
        createdAt: now - 1_800_000,
        isBot: true,
      });
      insertBotSeries(db, {
        guildId: "foreign-guild",
        channelId: "foreign-room",
        prefix: "foreign-fill",
        count: 6,
        startAt: now - 1_600_000,
        gapMs: 200_000,
      });
      insertMessage(db, {
        id: "reply-cue",
        guildId: "current-guild",
        channelId: "other-room",
        userId: "bob",
        content: "old direct question",
        createdAt: now - 500_000,
      });
      insertMessage(db, {
        id: "intervening-bot",
        guildId: "current-guild",
        channelId: "other-room",
        userId: "other-bot",
        content: "noise",
        createdAt: now - 499_000,
        isBot: true,
      });
      insertMessage(db, {
        id: "direct-reply",
        guildId: "current-guild",
        channelId: "other-room",
        userId: "2b",
        content: "direct answer <:local:456>",
        createdAt: now - 498_000,
        isBot: true,
        replyToId: "reply-cue",
      });
      insertBotSeries(db, {
        guildId: "current-guild",
        channelId: "other-room",
        prefix: "local-fill",
        count: 3,
        startAt: now - 350_000,
      });

      const input = {
        db,
        config: CONFIG,
        instruction: "## Examples\nUse these as examples.",
        botUserId: "2b",
        currentGuildId: "current-guild",
        currentChannelId: "current-room",
        mergeMessageGapSeconds: 90,
        random: () => 0.999,
      };
      const first = buildRepertoireContext({ ...input, now });
      expect(first).toContain("User: <@2b> look :wave:");
      expect(first).toContain("2B: first beat\n2B: second beat");
      expect(first).toContain("2B: unprompted thought");
      expect(first).toContain("User: old direct question");
      expect(first).toContain("2B: direct answer <:local:456>");
      expect(first).not.toContain("never include current room");
    } finally {
      db.close();
    }
  });

  test("gives the largest source room proportionally more examples", () => {
    const db = createDatabase(":memory:");
    const now = 3_000_000_000;
    try {
      insertBotSeries(db, {
        guildId: "g",
        channelId: "smaller-room",
        prefix: "smaller",
        count: 4,
        startAt: now - 2_000_000,
      });
      insertBotSeries(db, {
        guildId: "g",
        channelId: "largest-room",
        prefix: "largest",
        count: 8,
        startAt: now - 1_000_000,
      });

      const context = buildRepertoireContext({
        db,
        config: { ...CONFIG, maxSourceChannels: 2, maxMessages: 4 },
        instruction: "## Examples",
        botUserId: "2b",
        currentGuildId: "g",
        currentChannelId: "ranking-target",
        mergeMessageGapSeconds: 90,
        now,
        random: () => 0.999,
      });
      const lines = context.split("\n").filter((line) => line.startsWith("2B: "));
      expect(lines.filter((line) => line.startsWith("2B: largest"))).toHaveLength(2);
      expect(lines.filter((line) => line.startsWith("2B: smaller"))).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("doubles the lookback when the primary pool cannot support the requested size", () => {
    const db = createDatabase(":memory:");
    const now = 4_000_080_000;
    try {
      insertBotSeries(db, {
        guildId: "g",
        channelId: "fallback-source",
        prefix: "older",
        count: 4,
        startAt: now - 72 * 60 * 60 * 1_000,
      });
      insertBotSeries(db, {
        guildId: "g",
        channelId: "fallback-source",
        prefix: "recent",
        count: 4,
        startAt: now - 4 * 60 * 60 * 1_000,
      });

      const context = buildRepertoireContext({
        db,
        config: { ...CONFIG, maxMessages: 2 },
        instruction: "## Examples",
        botUserId: "2b",
        currentGuildId: "g",
        currentChannelId: "fallback-target",
        mergeMessageGapSeconds: 90,
        now,
        random: () => 0.999,
      });

      expect(context).toContain("2B: older");
    } finally {
      db.close();
    }
  });

  test("omits source rooms with fewer than four excerpts", () => {
    const db = createDatabase(":memory:");
    const now = 5_000_000_000;
    try {
      insertBotSeries(db, {
        guildId: "g",
        channelId: "weak-source",
        prefix: "weak",
        count: 3,
        startAt: now - 300_000,
      });

      const context = buildRepertoireContext({
        db,
        config: CONFIG,
        instruction: "## Examples",
        botUserId: "2b",
        currentGuildId: "g",
        currentChannelId: "weak-target",
        mergeMessageGapSeconds: 90,
        now,
      });

      expect(context).toBe("");
    } finally {
      db.close();
    }
  });

  test("keeps a stable partition across recomputation and rotates without overlap", () => {
    const db = createDatabase(":memory:");
    const now = 5_000_160_000;
    try {
      insertBotSeries(db, {
        guildId: "g",
        channelId: "rotation-source",
        prefix: "rotation",
        count: 8,
        startAt: now - 1_000_000,
      });

      const input = {
        db,
        config: { ...CONFIG, maxMessages: 2 },
        botUserId: "2b",
        currentGuildId: "g",
        currentChannelId: "rotation-target",
        mergeMessageGapSeconds: 90,
      };
      const first = buildRepertoireContext({
        ...input,
        instruction: "## Examples\nfirst",
        now,
      });
      const recomputed = buildRepertoireContext({
        ...input,
        instruction: "## Examples\nrecomputed",
        now: now + 1,
      });
      const rotated = buildRepertoireContext({
        ...input,
        instruction: "## Examples\nrecomputed",
        now: now + 60_002,
      });
      const lines = (context: string): string[] =>
        context.split("\n").filter((line) => line.startsWith("2B: "));
      const firstLines = lines(first);
      const rotatedLines = lines(rotated);

      expect(lines(recomputed)).toEqual(firstLines);
      expect(rotatedLines).toHaveLength(2);
      expect(rotatedLines.some((line) => firstLines.includes(line))).toBe(false);
    } finally {
      db.close();
    }
  });
});
