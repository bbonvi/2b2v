import { describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database";
import { applyRelationshipSignals } from "./engine";
import { getRelationshipProfile } from "./repository";
import { buildPriorExchangesContext } from "./prior-exchanges";
import type { RelationshipConfig } from "./types";

const config: RelationshipConfig = {
  modelProfile: "main",
  enabled: true,
  promptInjection: true,
  maxAxisDeltaPerSignal: 200,
  maxToolCalls: 5,
};

function insertMessage(db: Database, input: {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  content: string;
  isBot: boolean;
  createdAt: number;
}): void {
  db.raw.prepare(
    `INSERT INTO messages
       (id, guild_id, channel_id, user_id, author_username, raw_content,
        translated_content, is_bot, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.guildId,
    input.channelId,
    input.userId,
    input.userId,
    input.content,
    input.content,
    input.isBot ? 1 : 0,
    input.createdAt,
  );
}

describe("prior exchanges context", () => {
  test("selects stable same-user cross-room exchanges without a cache", () => {
    const db = createDatabase(":memory:");
    for (let index = 0; index < 8; index += 1) {
      const guildId = index === 0 ? "g2" : "g1";
      const channelId = `old-${index}`;
      insertMessage(db, {
        id: `cue-${index}`,
        guildId,
        channelId,
        userId: "u1",
        content: index === 0 ? "linked <:wave:123>" : `ordinary ${index}`,
        isBot: false,
        createdAt: index * 10 + 1,
      });
      insertMessage(db, {
        id: `response-${index}`,
        guildId,
        channelId,
        userId: "bot",
        content: `reply ${index}`,
        isBot: true,
        createdAt: index * 10 + 2,
      });
    }
    insertMessage(db, {
      id: "other-cue",
      guildId: "g1",
      channelId: "other-user",
      userId: "u2",
      content: "do not include",
      isBot: false,
      createdAt: 100,
    });
    insertMessage(db, {
      id: "other-response",
      guildId: "g1",
      channelId: "other-user",
      userId: "bot",
      content: "wrong person",
      isBot: true,
      createdAt: 101,
    });
    insertMessage(db, {
      id: "current-cue",
      guildId: "g1",
      channelId: "current",
      userId: "u1",
      content: "already in current history",
      isBot: false,
      createdAt: 110,
    });
    insertMessage(db, {
      id: "current-response",
      guildId: "g1",
      channelId: "current",
      userId: "bot",
      content: "current reply",
      isBot: true,
      createdAt: 111,
    });

    applyRelationshipSignals(db, config, {
      source: "llm",
      scope: {
        guildId: "g2",
        channelId: "old-0",
        userId: "u1",
        sourceMessageId: "cue-0",
      },
      signals: [{
        summary: "A small new point of familiarity.",
        confidence: 0.9,
        axes: { familiarity: 0.1 },
      }],
      now: 3,
    });

    const base = {
      db,
      profile: getRelationshipProfile(db, "u1"),
      botUserId: "bot",
      currentUserId: "u1",
      currentGuildId: "g1",
      currentChannelId: "current",
    };
    const first = buildPriorExchangesContext({ ...base, now: 1 });
    const sameHour = buildPriorExchangesContext({ ...base, now: 30 * 60 * 1_000 });
    const nextHour = buildPriorExchangesContext({ ...base, now: 60 * 60 * 1_000 });

    expect(first).toBe(sameHour);
    expect(first).not.toBe(nextHour);
    expect(first).toContain("## Prior Exchanges With This Person");
    expect(first).toContain("User: linked :wave:");
    expect(first).toContain("2B: reply 0");
    expect(first).toContain("ordinary");
    expect(first).not.toContain("do not include");
    expect(first).not.toContain("already in current history");
    expect((first.match(/^User:/gmu) ?? [])).toHaveLength(6);
    db.close();
  });
});
