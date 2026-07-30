import { beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database.ts";
import {
  getLatestEligibleBotCursor,
  listRepertoireExchanges,
  normalizeRepertoireEmotes,
  renderRepertoireContext,
  type RepertoireSnapshotEntry,
} from "./exchanges.ts";

let db: Database;

function insertMessage(input: {
  id: string;
  guildId?: string;
  channelId?: string;
  userId?: string;
  content?: string;
  isBot?: boolean;
  createdAt: number;
  replyToId?: string | null;
  synthetic?: boolean;
  promptOnly?: boolean;
}): void {
  db.raw.prepare(
    `INSERT INTO messages
     (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content,
      is_bot, created_at, reply_to_id, is_synthetic, is_prompt_only)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.guildId ?? "g1",
    input.channelId ?? "c1",
    input.userId ?? "human",
    input.userId ?? "human",
    input.content ?? input.id,
    input.content ?? input.id,
    input.isBot === true ? 1 : 0,
    input.createdAt,
    input.replyToId ?? null,
    input.synthetic === true ? 1 : 0,
    input.promptOnly === true ? 1 : 0,
  );
}

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("repertoire exchange selection", () => {
  test("filters bot identity, ranks channels, grounds cues, and groups multi-send replies", () => {
    insertMessage({ id: "direct-cue", content: "old cue", createdAt: 100 });
    insertMessage({ id: "near-cue", content: "near cue", createdAt: 200 });
    insertMessage({ id: "b1", userId: "2b", isBot: true, content: "first", createdAt: 300, replyToId: "direct-cue" });
    insertMessage({ id: "other-bot", userId: "other", isBot: true, createdAt: 350 });
    insertMessage({ id: "b2", userId: "2b", isBot: true, content: "second", createdAt: 400 });
    insertMessage({ id: "cue-2", content: "next", createdAt: 500 });
    insertMessage({ id: "b3", userId: "2b", isBot: true, content: "third", createdAt: 600 });
    insertMessage({ id: "g2-cue", guildId: "g2", channelId: "c2", createdAt: 700 });
    insertMessage({ id: "g2-bot", guildId: "g2", channelId: "c2", userId: "2b", isBot: true, createdAt: 800 });
    insertMessage({ id: "no-cue", guildId: "g3", channelId: "c3", userId: "2b", isBot: true, createdAt: 900 });
    insertMessage({ id: "synthetic", userId: "2b", isBot: true, createdAt: 1_000, synthetic: true });
    insertMessage({ id: "prompt", userId: "2b", isBot: true, createdAt: 1_100, promptOnly: true });

    const through = getLatestEligibleBotCursor(db, "2b");
    expect(through).toEqual({ messageId: "no-cue", createdAt: 900 });
    const exchanges = listRepertoireExchanges(db, {
      botUserId: "2b",
      since: 0,
      through: through as NonNullable<typeof through>,
      mergeMessageGapSeconds: 120,
      maxCandidates: 10,
      maxSourceChannels: 3,
      maxEntriesPerChannel: 10,
      maxEntriesPerGuild: 10,
    });

    expect(exchanges.map((exchange) => exchange.id)).toEqual(["b1", "b3", "g2-bot"]);
    expect(exchanges[0]).toMatchObject({
      cue: { messageId: "direct-cue", text: "old cue" },
      responses: [
        { messageId: "b1", text: "first" },
        { messageId: "b2", text: "second" },
      ],
    });
    expect(exchanges.some((exchange) => exchange.id === "other-bot")).toBe(false);
    expect(exchanges.some((exchange) => exchange.id === "no-cue")).toBe(false);
  });

  test("applies ranked source-channel and diversity caps deterministically", () => {
    for (const [channelId, count] of [["busy", 3], ["quiet", 2]] as const) {
      for (let index = 0; index < count; index += 1) {
        const at = (channelId === "busy" ? 1_000 : 2_000) + index * 10;
        insertMessage({ id: `${channelId}-h${index}`, channelId, createdAt: at });
        insertMessage({
          id: `${channelId}-b${index}`,
          channelId,
          userId: "2b",
          isBot: true,
          createdAt: at + 1,
        });
      }
    }
    const through = getLatestEligibleBotCursor(db, "2b");
    const exchanges = listRepertoireExchanges(db, {
      botUserId: "2b",
      since: 0,
      through: through as NonNullable<typeof through>,
      mergeMessageGapSeconds: 1,
      maxCandidates: 10,
      maxSourceChannels: 1,
      maxEntriesPerChannel: 1,
      maxEntriesPerGuild: 10,
    });

    expect(exchanges.map((exchange) => exchange.id)).toEqual(["busy-b2"]);
  });

  test("uses an older visible reply target outside the fallback cue window", () => {
    insertMessage({ id: "old-cue", content: "grounded target", createdAt: 1 });
    insertMessage({ id: "near-cue", content: "nearby chatter", createdAt: 2_000_000 });
    insertMessage({
      id: "reply",
      userId: "2b",
      isBot: true,
      createdAt: 2_000_100,
      replyToId: "old-cue",
    });
    const through = getLatestEligibleBotCursor(db, "2b");
    const exchanges = listRepertoireExchanges(db, {
      botUserId: "2b",
      since: 2_000_000,
      through: through as NonNullable<typeof through>,
      mergeMessageGapSeconds: 120,
      maxCandidates: 1,
      maxSourceChannels: 1,
      maxEntriesPerChannel: 1,
      maxEntriesPerGuild: 1,
    });

    expect(exchanges[0]?.cue).toEqual({ messageId: "old-cue", text: "grounded target" });
  });

  test("caps candidates from each source guild", () => {
    for (const [guildId, channelId] of [["g1", "c1"], ["g2", "c2"]] as const) {
      for (let index = 0; index < 2; index += 1) {
        const at = (guildId === "g1" ? 1_000 : 2_000) + index * 10;
        insertMessage({ id: `${guildId}-h${index}`, guildId, channelId, createdAt: at });
        insertMessage({
          id: `${guildId}-b${index}`,
          guildId,
          channelId,
          userId: "2b",
          isBot: true,
          createdAt: at + 1,
        });
      }
    }
    const through = getLatestEligibleBotCursor(db, "2b");
    const exchanges = listRepertoireExchanges(db, {
      botUserId: "2b",
      since: 0,
      through: through as NonNullable<typeof through>,
      mergeMessageGapSeconds: 1,
      maxCandidates: 4,
      maxSourceChannels: 2,
      maxEntriesPerChannel: 2,
      maxEntriesPerGuild: 1,
    });

    expect(exchanges.map((exchange) => exchange.guildId).sort()).toEqual(["g1", "g2"]);
  });
});

describe("repertoire rendering", () => {
  const entry = (
    id: string,
    tier: "recent" | "anchor",
    guildId: string,
    channelId: string,
    position: number,
  ): RepertoireSnapshotEntry => ({
    tier,
    condition: tier === "anchor" ? "the room is teasing her" : null,
    position,
    exchange: {
      id,
      guildId,
      channelId,
      cue: { messageId: `${id}-cue`, text: "hello <:wave:123>" },
      responses: [{ messageId: id, text: `response ${id} <a:dance:456>` }],
      respondedAt: position,
    },
  });

  test("keeps local emotes, normalizes foreign emotes, and prioritizes anchors", () => {
    expect(normalizeRepertoireEmotes("<:wave:123> <a:dance:456>", "g1", "g1"))
      .toBe("<:wave:123> <a:dance:456>");
    expect(normalizeRepertoireEmotes("<:wave:123> <a:dance:456>", "g2", "g1"))
      .toBe(":wave: :dance:");

    const rendered = renderRepertoireContext({
      instruction: "## Examples\nContract.",
      entries: [
        entry("recent", "recent", "g1", "same", 0),
        entry("anchor", "anchor", "g2", "other", 0),
      ],
      currentGuildId: "g1",
      maxEntriesPerChannel: 1,
      maxChars: 2_000,
    });

    expect(rendered.indexOf("Anchor example")).toBeLessThan(rendered.indexOf("Recent example"));
    expect(rendered).toContain(":wave:");
    expect(rendered).toContain("<:wave:123>");
    expect(rendered.length).toBeLessThanOrEqual(2_000);
  });

  test("enforces one shared per-channel cap and the hard character limit", () => {
    const rendered = renderRepertoireContext({
      instruction: "Contract.",
      entries: [
        entry("anchor", "anchor", "g1", "same", 0),
        entry("recent", "recent", "g1", "same", 0),
      ],
      currentGuildId: "g1",
      maxEntriesPerChannel: 1,
      maxChars: 180,
    });

    expect(rendered).toContain("anchor");
    expect(rendered).not.toContain("response recent");
    expect(rendered.length).toBeLessThanOrEqual(180);
  });
});
