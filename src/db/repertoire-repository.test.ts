import { beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "./database.ts";
import {
  getRepertoireRefreshState,
  loadRepertoireAnchors,
  loadRepertoireSnapshot,
  markRepertoireRefreshAttempt,
  replaceRepertoireSnapshot,
} from "./repertoire-repository.ts";
import type { RepertoireExchange } from "../repertoire/exchanges.ts";

let db: Database;

function insertExchange(
  id: string,
  guildId: string,
  channelId: string,
  at: number,
): RepertoireExchange {
  const cueId = `${id}-cue`;
  db.raw.prepare(
    `INSERT INTO messages
     (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content,
      is_bot, created_at)
     VALUES (?, ?, ?, 'human', 'human', ?, ?, 0, ?)`,
  ).run(cueId, guildId, channelId, `cue ${id}`, `cue ${id}`, at);
  db.raw.prepare(
    `INSERT INTO messages
     (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content,
      is_bot, created_at, reply_to_id)
     VALUES (?, ?, ?, '2b', '2b', ?, ?, 1, ?, ?)`,
  ).run(id, guildId, channelId, `reply ${id}`, `reply ${id}`, at + 1, cueId);
  return {
    id,
    guildId,
    channelId,
    cue: { messageId: cueId, text: `cue ${id}` },
    responses: [{ messageId: id, text: `reply ${id}` }],
    respondedAt: at + 1,
  };
}

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("repertoire repository", () => {
  test("loads profile entries and only the current guild's scoped anchors", () => {
    const recent = insertExchange("recent", "g2", "c2", 10);
    const profile = insertExchange("profile", "g2", "c3", 20);
    const guild1 = insertExchange("guild-1", "g1", "c1", 30);
    const guild2 = insertExchange("guild-2", "g2", "c4", 40);
    replaceRepertoireSnapshot(db, {
      recent: [recent],
      anchors: [
        { exchange: profile, scope: "profile", condition: "any similar pressure" },
        { exchange: guild1, scope: "guild", condition: "local g1 front" },
        { exchange: guild2, scope: "guild", condition: "local g2 front" },
      ],
      through: { messageId: "guild-2", createdAt: 41 },
      now: 100,
    });

    expect(loadRepertoireSnapshot(db, {
      currentGuildId: "g1",
      botUserId: "2b",
      mergeMessageGapSeconds: 120,
    }).map((entry) => entry.exchange.id)).toEqual(["profile", "guild-1", "recent"]);
    expect(loadRepertoireSnapshot(db, {
      currentGuildId: "g2",
      botUserId: "2b",
      mergeMessageGapSeconds: 120,
    }).map((entry) => entry.exchange.id)).toEqual(["profile", "guild-2", "recent"]);
    expect(loadRepertoireAnchors(db, "2b", 120).map((anchor) => anchor.exchange.id))
      .toEqual(["profile", "guild-1", "guild-2"]);
  });

  test("drops an entry when a source message is deleted or missing", () => {
    const recent = insertExchange("recent", "g1", "c1", 10);
    replaceRepertoireSnapshot(db, {
      recent: [recent],
      anchors: [],
      through: { messageId: "recent", createdAt: 11 },
      now: 100,
    });
    db.raw.prepare("UPDATE messages SET deleted_at = 200 WHERE id = ?").run(recent.cue.messageId);

    expect(loadRepertoireSnapshot(db, {
      currentGuildId: "g1",
      botUserId: "2b",
      mergeMessageGapSeconds: 120,
    })).toEqual([]);
  });

  test("replaces atomically, retains anchor creation time, and advances only on success", () => {
    const retained = insertExchange("retained", "g1", "c1", 10);
    const fresh = insertExchange("fresh", "g1", "c1", 20);
    replaceRepertoireSnapshot(db, {
      recent: [],
      anchors: [{ exchange: retained, scope: "profile", condition: "first" }],
      through: { messageId: "retained", createdAt: 11 },
      now: 100,
    });
    markRepertoireRefreshAttempt(db, 150);
    expect(getRepertoireRefreshState(db)).toEqual({
      through: { messageId: "retained", createdAt: 11 },
      lastAttemptAt: 150,
      lastSuccessAt: 100,
    });

    replaceRepertoireSnapshot(db, {
      recent: [fresh],
      anchors: [{ exchange: retained, scope: "profile", condition: "updated" }],
      through: { messageId: "fresh", createdAt: 21 },
      now: 200,
    });
    expect(db.raw.prepare(
      "SELECT selected_at, last_selected_at FROM repertoire_entries WHERE id = 'retained'",
    ).get()).toEqual({ selected_at: 100, last_selected_at: 200 });
    expect(getRepertoireRefreshState(db)).toEqual({
      through: { messageId: "fresh", createdAt: 21 },
      lastAttemptAt: 200,
      lastSuccessAt: 200,
    });

    expect(() => replaceRepertoireSnapshot(db, {
      recent: [retained],
      anchors: [{ exchange: retained, scope: "profile", condition: "duplicate" }],
      through: { messageId: "retained", createdAt: 11 },
      now: 300,
    })).toThrow();
    expect(getRepertoireRefreshState(db).through).toEqual({ messageId: "fresh", createdAt: 21 });
    expect(db.raw.prepare("SELECT id FROM repertoire_entries ORDER BY id").all())
      .toEqual([{ id: "fresh" }, { id: "retained" }]);
  });
});
