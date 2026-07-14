import { describe, expect, test } from "bun:test";
import type { HistoryMessage } from "../agent/history-types.ts";
import { DEFAULT_AMBIENT_ATTENTION } from "../config/defaults.ts";
import { createDatabase, type Database } from "../db/database.ts";
import {
  applyAmbientInitiativeBotPressure,
  ensureAmbientInitiativeBotMention,
  renderAmbientHistory,
  resolveLocalChannelShape,
  shouldDeferAmbientCandidateForTyping,
} from "./runtime.ts";

function msg(overrides: Partial<HistoryMessage> = {}): HistoryMessage {
  return {
    id: "m1",
    author: "alice",
    authorId: "uid-alice",
    content: "hello",
    isBot: false,
    timestamp: Date.UTC(2026, 6, 7, 21, 10, 6, 846),
    replyToId: null,
    hasEmbeds: false,
    isSynthetic: false,
    relatedThreadId: null,
    ...overrides,
  };
}

function insertStoredMessage(
  db: Database,
  id: string,
  opts: {
    guildId?: string;
    channelId?: string;
    userId?: string;
    isBot?: boolean;
    createdAt: number;
  },
): void {
  db.raw
    .prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      opts.guildId ?? "g1",
      opts.channelId ?? "c1",
      opts.userId ?? "u1",
      `user-${opts.userId ?? "u1"}`,
      id,
      id,
      opts.isBot === true ? 1 : 0,
      opts.createdAt,
    );
}

function groupHistory(now: number, count: number): HistoryMessage[] {
  return Array.from({ length: count }, (_, index) => msg({
    id: `h-${index}`,
    authorId: `u${index % 5}`,
    timestamp: now - index * 1000,
  }));
}

function insertBurst(db: Database, prefix: string, count: number, createdAt: number): void {
  for (let item = 0; item < count; item += 1) {
    insertStoredMessage(db, `${prefix}-${item}`, {
      userId: `u${item % 5}`,
      createdAt: createdAt - item,
    });
  }
}

function insertHourlyBaseline(db: Database, now: number): void {
  for (let bucket = 1; bucket <= 10; bucket += 1) {
    insertBurst(db, `old-${bucket}`, 20, now - bucket * 2 * 60 * 60 * 1000);
  }
}

describe("renderAmbientHistory", () => {
  test("renders local wall-clock timestamps and marks every trigger message", () => {
    const text = renderAmbientHistory({
      history: [
        msg({ id: "m1", content: "first" }),
        msg({ id: "m2", author: "bob", authorId: "uid-bob", content: "second", timestamp: Date.UTC(2026, 6, 7, 21, 11, 0) }),
      ],
      timezone: "UTC",
      triggerMessageIds: ["m1", "m2"],
    });

    expect(text).toContain("[2026-07-07 21:10] alice (uid-alice) <trigger>: first");
    expect(text).toContain("[2026-07-07 21:11] bob (uid-bob) <trigger>: second");
    expect(text).not.toContain("T21:10:06.846Z");
  });

  test("marks follow-up anchor separately", () => {
    const text = renderAmbientHistory({
      history: [
        msg({ id: "u1", content: "source" }),
        msg({ id: "b1", author: "Delamain", authorId: "bot-1", isBot: true, content: "previous reply", timestamp: Date.UTC(2026, 6, 7, 21, 12, 0), replyToId: "u1" }),
      ],
      timezone: "UTC",
      followUpAnchorMessageId: "b1",
    });

    expect(text).toContain("Delamain (bot-1) reply_to=u1 <follow_up_anchor>: previous reply");
    expect(text).not.toContain("<trigger>");
  });

  test("appends deleted marker without hiding message content", () => {
    const text = renderAmbientHistory({
      history: [msg({ isDeleted: true, content: "removed text" })],
      timezone: "UTC",
    });

    expect(text).toContain("removed text [deleted]");
  });
});

describe("bot-audience ambient initiative", () => {
  test("applies signed bot pressure only to bot-directed initiative", () => {
    expect(applyAmbientInitiativeBotPressure(0.5, true, 0.2)).toBe(0.7);
    expect(applyAmbientInitiativeBotPressure(0.5, true, -0.3)).toBe(0.2);
    expect(applyAmbientInitiativeBotPressure(0.5, false, 0.2)).toBe(0.5);
    expect(applyAmbientInitiativeBotPressure(0.9, true, 0.5)).toBe(1);
    expect(applyAmbientInitiativeBotPressure(0.1, true, -0.5)).toBe(0);
  });

  test("adds exactly one explicit Discord mention for the target bot", () => {
    expect(ensureAmbientInitiativeBotMention("A thought.", "123")).toBe("<@123> A thought.");
    expect(ensureAmbientInitiativeBotMention("<@123> A thought.", "123")).toBe("<@123> A thought.");
    expect(ensureAmbientInitiativeBotMention("<@!123> A thought.", "123")).toBe("<@!123> A thought.");
    expect(ensureAmbientInitiativeBotMention("", "123")).toBe("<@123>");
  });
});

describe("shouldDeferAmbientCandidateForTyping", () => {
  test("keeps lingering attention through typing at either gate", () => {
    expect(shouldDeferAmbientCandidateForTyping("lingering_attention", "evaluate", "user typing active")).toBe(true);
    expect(shouldDeferAmbientCandidateForTyping("lingering_attention", "pre_send", "user typing active")).toBe(true);
  });

  test("does not revive unrelated drops or stale ambient pickup generation", () => {
    expect(shouldDeferAmbientCandidateForTyping("lingering_attention", "pre_send", "candidate stale")).toBe(false);
    expect(shouldDeferAmbientCandidateForTyping("ambient_pickup", "pre_send", "user typing active")).toBe(false);
    expect(shouldDeferAmbientCandidateForTyping("follow_up", "evaluate", "user typing active")).toBe(false);
  });
});

describe("resolveLocalChannelShape", () => {
  test("keeps active group chat below its own recent peak out of busy bucket", () => {
    const db = createDatabase(":memory:");
    const now = Date.UTC(2026, 6, 8, 12, 0, 0);
    const config = { ...DEFAULT_AMBIENT_ATTENTION, busyWindowMs: 60 * 60 * 1000, busyMessageLimit: 8 };
    try {
      insertHourlyBaseline(db, now);
      insertBurst(db, "current", 13, now);

      expect(resolveLocalChannelShape({
        db,
        guildId: "g1",
        channelId: "c1",
        botUserId: "bot-1",
        config,
        history: groupHistory(now, 13),
        userId: "u0",
        now,
      })).toBe("group_chat_not_busy");
    } finally {
      db.close();
    }
  });

  test("marks busy group chat when current activity reaches channel baseline", () => {
    const db = createDatabase(":memory:");
    const now = Date.UTC(2026, 6, 8, 12, 0, 0);
    const config = { ...DEFAULT_AMBIENT_ATTENTION, busyWindowMs: 60 * 60 * 1000, busyMessageLimit: 8 };
    try {
      insertHourlyBaseline(db, now);
      insertBurst(db, "current", 17, now);

      expect(resolveLocalChannelShape({
        db,
        guildId: "g1",
        channelId: "c1",
        botUserId: "bot-1",
        config,
        history: groupHistory(now, 17),
        userId: "u0",
        now,
      })).toBe("busy_group_chat");
    } finally {
      db.close();
    }
  });

  test("does not let one rare historical burst hide current busy activity", () => {
    const db = createDatabase(":memory:");
    const now = Date.UTC(2026, 6, 8, 12, 0, 0);
    const config = { ...DEFAULT_AMBIENT_ATTENTION, busyWindowMs: 60_000, busyMessageLimit: 8 };
    try {
      insertBurst(db, "old", 20, now - 24 * 60 * 60 * 1000);
      insertBurst(db, "current", 13, now);

      expect(resolveLocalChannelShape({
        db,
        guildId: "g1",
        channelId: "c1",
        botUserId: "bot-1",
        config,
        history: groupHistory(now, 13),
        userId: "u0",
        now,
      })).toBe("busy_group_chat");
    } finally {
      db.close();
    }
  });

  test("does not count an external bot as the persona's own participation", () => {
    const db = createDatabase(":memory:");
    const now = Date.UTC(2026, 6, 8, 12, 0, 0);
    try {
      expect(resolveLocalChannelShape({
        db,
        guildId: "g1",
        channelId: "c1",
        botUserId: "bot-1",
        config: DEFAULT_AMBIENT_ATTENTION,
        history: [
          msg({ id: "human", authorId: "u1", timestamp: now - 1000 }),
          msg({ id: "external", authorId: "other-bot", isBot: true, timestamp: now }),
        ],
        userId: "u1",
        now,
      })).toBe("mostly_one_user");
    } finally {
      db.close();
    }
  });
});
