import { beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database.ts";
import { syncMessageAssets } from "../db/asset-repository.ts";
import { createSearchChannelMessagesTool } from "./search-channel-messages-tool.ts";

let db: Database;
const baseTime = Date.UTC(2026, 5, 1, 12);

function insertMessage(id: string, content: string, options: {
  guildId?: string;
  channelId?: string;
  userId?: string;
  username?: string;
  createdAt?: number;
  replyToId?: string | null;
} = {}): void {
  db.raw.prepare(`INSERT INTO messages
    (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(
      id,
      options.guildId ?? "g1",
      options.channelId ?? "c1",
      options.userId ?? "u1",
      options.username ?? "alice",
      content,
      content,
      options.createdAt ?? baseTime,
      options.replyToId ?? null,
    );
}

function addTextAsset(messageId: string, idSource: string, filename: string): number {
  const [asset] = syncMessageAssets(db, { messageId, assets: [{
    messageId,
    guildId: "g1",
    channelId: "c1",
    sourceKind: "attachment",
    sourceKey: idSource,
    kind: "text",
    filename,
    contentType: "text/plain",
    size: 2048,
    width: null,
    height: null,
    durationSeconds: null,
    createdAt: baseTime,
  }] });
  if (asset === undefined) throw new Error("asset missing");
  return asset.id;
}

function tool(overrides: Partial<Parameters<typeof createSearchChannelMessagesTool>[0]> = {}) {
  return createSearchChannelMessagesTool({
    db,
    guildId: "g1",
    currentChannelId: "c1",
    timezone: "UTC",
    ...overrides,
  });
}

function text(result: Awaited<ReturnType<ReturnType<typeof tool>["execute"]>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("search_channel_messages", () => {
  test("regex-searches message text and returns current history grammar", async () => {
    insertMessage("m1", "the Quick brown fox", { username: "bob" });
    const result = await tool().execute("tc", { pattern: "(?i)quick\\s+brown" }, AbortSignal.timeout(5000));
    expect(text(result)).toContain("Search results for /(?i)quick\\s+brown/");
    expect(text(result)).toContain("[@bob (MsgID: m1)]: the Quick brown fox");
    expect(text(result)).not.toContain("ChannelID:");
  });

  test("defaults to the current guild and channel", async () => {
    insertMessage("current", "needle current");
    insertMessage("other-channel", "needle other channel", { channelId: "c2" });
    insertMessage("other-guild", "needle other guild", { guildId: "g2" });
    const result = await tool().execute("tc", { pattern: "needle" }, AbortSignal.timeout(5000));
    expect(text(result)).toContain("needle current");
    expect(text(result)).not.toContain("needle other channel");
    expect(text(result)).not.toContain("needle other guild");
  });

  test("finds attachment filenames and always renders typed asset IDs", async () => {
    insertMessage("m1", "here");
    const assetId = addTextAsset("m1", "a1", "fragment.txt");
    const result = await tool().execute("tc", { pattern: "fragment\\.txt" }, AbortSignal.timeout(5000));
    expect(text(result)).toContain(`Text: #${assetId} fragment.txt (2.0KB)`);
  });

  test("accepts a hash-prefixed asset ID as an exact owner lookup", async () => {
    insertMessage("m1", "asset owner");
    const assetId = addTextAsset("m1", "a1", "notes.txt");
    const result = await tool().execute("tc", { asset_id: `#${assetId}` }, AbortSignal.timeout(5000));
    expect(text(result)).toContain("asset owner");
  });

  test("uses stored historical usernames and structured filters", async () => {
    insertMessage("old", "wanted", { username: "Departed", userId: "u-old", createdAt: baseTime });
    insertMessage("other", "wanted", { username: "someone", userId: "u2", createdAt: baseTime + 1000 });
    const result = await tool().execute("tc", {
      pattern: "wanted",
      username: "@departed",
      after: "2026-06-01 11:00",
      before: "2026-06-01 13:00",
    }, AbortSignal.timeout(5000));
    expect(text(result)).toContain("MsgID: old");
    expect(text(result)).not.toContain("MsgID: other");
  });

  test("supports user and asset filters without a regex", async () => {
    insertMessage("wanted", "file owner", { userId: "u1" });
    insertMessage("other", "no file", { userId: "u2" });
    addTextAsset("wanted", "a1", "notes.txt");
    const result = await tool().execute("tc", {
      user_id: "u1",
      has_assets: true,
      asset_kind: "text",
    }, AbortSignal.timeout(5000));
    expect(text(result)).toContain("MsgID: wanted");
    expect(text(result)).not.toContain("MsgID: other");
  });

  test("chooses newest matches, then renders them chronologically", async () => {
    insertMessage("old", "needle old", { createdAt: baseTime });
    insertMessage("middle", "needle middle", { createdAt: baseTime + 1000 });
    insertMessage("new", "needle new", { createdAt: baseTime + 2000 });
    const result = await tool().execute("tc", { pattern: "needle", limit: 2 }, AbortSignal.timeout(5000));
    const output = text(result);
    expect(output).not.toContain("needle old");
    expect(output.indexOf("needle middle")).toBeLessThan(output.indexOf("needle new"));
  });

  test("adds location metadata for a broader accessible search", async () => {
    insertMessage("m2", "remote match", { guildId: "g2", channelId: "c2" });
    const result = await tool({
      canAccessGuild: () => Promise.resolve(true),
      resolveChannel: (channelId) => Promise.resolve(channelId === "c2" ? { guildId: "g2", channelId } : null),
    }).execute("tc", { pattern: "remote", guild_id: "g2" }, AbortSignal.timeout(5000));
    expect(text(result)).toContain("GuildID: g2; ChannelID: c2");
  });

  test("removes inaccessible channels from broad guild searches", async () => {
    insertMessage("open", "needle open", { channelId: "open" });
    insertMessage("private", "needle private", { channelId: "private" });
    const result = await tool({
      resolveChannel: (channelId) => Promise.resolve(channelId === "open" ? { guildId: "g1", channelId } : null),
    }).execute("tc", { pattern: "needle", guild_id: "g1" }, AbortSignal.timeout(5000));
    expect(text(result)).toContain("needle open");
    expect(text(result)).not.toContain("needle private");
  });

  test("rejects inaccessible guilds and invalid date ranges", async () => {
    const inaccessible = await tool({ canAccessGuild: () => Promise.resolve(false) })
      .execute("tc", { pattern: "x", guild_id: "g2" }, AbortSignal.timeout(5000));
    expect(text(inaccessible)).toContain("not found or not accessible");
    const dates = await tool().execute("tc", {
      pattern: "x", after: "2026-06-02 00:00", before: "2026-06-01 00:00",
    }, AbortSignal.timeout(5000));
    expect(text(dates)).toContain("after must be earlier");
  });

  test("rejects an empty discovery call and invalid regex", async () => {
    const empty = await tool().execute("tc", {}, AbortSignal.timeout(5000));
    expect(text(empty)).toContain("Provide a regex pattern");
    const invalid = await tool().execute("tc", { pattern: "[" }, AbortSignal.timeout(5000));
    expect(text(invalid)).toContain("Invalid regex");
  });

  test("shows reply target and quote when available", async () => {
    insertMessage("parent", "quoted parent text", { username: "bob", createdAt: baseTime });
    insertMessage("reply", "needle reply", { username: "alice", createdAt: baseTime + 1000, replyToId: "parent" });
    const result = await tool().execute("tc", { pattern: "needle" }, AbortSignal.timeout(5000));
    expect(text(result)).toContain('[@alice to @bob (MsgID: reply; Quote: "quoted parent text")]');
  });
});
