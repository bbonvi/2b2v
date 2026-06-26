import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database";
import { buildComputedContactContextForUser, buildComputedContactContexts } from "./contact-context";

const BOT_ID = "bot";
const NOW = Date.UTC(2026, 0, 20, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function insertMessage(input: {
  id: string;
  userId: string;
  username: string;
  createdAt: number;
  content: string;
  isBot?: boolean;
  channelId?: string;
  replyToId?: string;
}): void {
  db.raw.prepare(
    `INSERT INTO messages
       (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
     VALUES (?, 'g', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.channelId ?? "c",
    input.userId,
    input.username,
    input.content,
    input.content,
    input.isBot === true ? 1 : 0,
    input.createdAt,
    input.replyToId ?? null,
  );
}

function insertImage(messageId: string): void {
  db.raw.prepare(
    `INSERT INTO images (message_id, guild_id, channel_id, caption, source_kind, path, mime, width, height, created_at)
     VALUES (?, 'g', 'c', NULL, 'image', '/tmp/test.webp', 'image/webp', 100, 100, ?)`
  ).run(messageId, NOW);
}

describe("computed contact context", () => {
  test("renders no direct context for users without contact with 2B", () => {
    insertMessage({ id: "u1", userId: "u1", username: "alice", content: "hello room", createdAt: NOW - DAY });

    expect(buildComputedContactContextForUser({ db, botUserId: BOT_ID, userId: "u1", now: NOW })).toBeNull();
  });

  test("counts explicit address and bot adjacency as direct contact", () => {
    insertMessage({ id: "u1", userId: "u1", username: "alice", content: "2b, смотри", createdAt: NOW - 3 * DAY });
    insertMessage({ id: "b1", userId: BOT_ID, username: "2B", content: "вижу", createdAt: NOW - 3 * DAY + 60_000, isBot: true });
    insertMessage({ id: "u2", userId: "u1", username: "alice", content: "2b, еще раз", createdAt: NOW - 60_000 });

    const context = buildComputedContactContextForUser({ db, botUserId: BOT_ID, userId: "u1", now: NOW });

    expect(context).not.toBeNull();
    expect(context?.directContactEvents).toBe(3);
    expect(context?.activeContactDays).toBe(2);
    expect(context?.lastContactAt).toBe(NOW - 60_000);
    expect(context?.rendered).toContain("Computed contact context:");
    expect(context?.rendered).toContain("2B last replied");
  });

  test("merges same-author split messages into one contact turn", () => {
    insertMessage({ id: "u1", userId: "split", username: "split", content: "2b", createdAt: NOW - 60_000 });
    insertMessage({ id: "u2", userId: "split", username: "split", content: "подожди", createdAt: NOW - 50_000 });
    insertMessage({ id: "u3", userId: "split", username: "split", content: "еще строка", createdAt: NOW - 40_000 });
    insertMessage({ id: "b1", userId: BOT_ID, username: "2B", content: "что", createdAt: NOW - 30_000, isBot: true });
    insertMessage({ id: "b2", userId: BOT_ID, username: "2B", content: "говори", createdAt: NOW - 20_000, isBot: true });

    const context = buildComputedContactContextForUser({ db, botUserId: BOT_ID, userId: "split", now: NOW });

    expect(context?.totalMessages).toBe(1);
    expect(context?.directContactEvents).toBe(2);
    expect(context?.longestRunTurns).toBe(2);
  });

  test("keeps one-day bursts capped below long-running dialogue", () => {
    for (let i = 0; i < 10; i += 1) {
      insertMessage({
        id: `burst-u-${i}`,
        userId: "burst",
        username: "burst",
        content: i === 0 ? "2b" : `ping ${i}`,
        createdAt: NOW - 2 * DAY + i * 120_000,
      });
      insertMessage({
        id: `burst-b-${i}`,
        userId: BOT_ID,
        username: "2B",
        content: `reply ${i}`,
        createdAt: NOW - 2 * DAY + i * 120_000 + 60_000,
        isBot: true,
      });
    }

    for (let day = 8; day >= 1; day -= 1) {
      insertMessage({
        id: `steady-u-${day}`,
        userId: "steady",
        username: "steady",
        content: "2b check",
        createdAt: NOW - day * DAY,
      });
      insertMessage({
        id: `steady-b-${day}`,
        userId: BOT_ID,
        username: "2B",
        content: "ok",
        createdAt: NOW - day * DAY + 60_000,
        isBot: true,
      });
    }

    const contexts = buildComputedContactContexts({ db, botUserId: BOT_ID, now: NOW });
    const burst = contexts.find((item) => item.userId === "burst");
    const steady = contexts.find((item) => item.userId === "steady");

    expect(burst?.rendered).toContain("one burst");
    expect(steady?.familiarityScore).toBeGreaterThan(burst?.familiarityScore ?? 0);
    expect(steady?.rendered).toContain("Contact spans multiple days");
  });

  test("marks link and image bot replies as instrumental without inflating familiarity", () => {
    insertMessage({ id: "u1", userId: "toolish", username: "toolish", content: "2b find this", createdAt: NOW - 3 * DAY });
    insertMessage({ id: "b1", userId: BOT_ID, username: "2B", content: "https://example.com", createdAt: NOW - 3 * DAY + 60_000, isBot: true });
    insertMessage({ id: "u2", userId: "toolish", username: "toolish", content: "2b make image", createdAt: NOW - 2 * DAY });
    insertMessage({ id: "b2", userId: BOT_ID, username: "2B", content: "держи", createdAt: NOW - 2 * DAY + 60_000, isBot: true });
    insertImage("b2");

    const context = buildComputedContactContextForUser({ db, botUserId: BOT_ID, userId: "toolish", now: NOW });

    expect(context?.instrumentalBotReplies).toBe(2);
    expect(context?.rendered).toContain("links/images");
    expect(context?.rendered).toContain("service-like");
  });
});
