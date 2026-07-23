import { describe, expect, test } from "bun:test";
import { getAssetsByMessageId, syncMessageAssets } from "../src/db/asset-repository.ts";
import { createDatabase } from "../src/db/database.ts";
import { discordMessageToImportRow, insertRows } from "./import-legacy-channel-history.ts";

describe("legacy channel history import", () => {
  test("converts current Discord history metadata", () => {
    const row = discordMessageToImportRow({
      guildId: "guild",
      channelId: "channel",
      botUserId: "bot",
      createdAt: 123,
      message: {
        id: "message",
        author: { id: "bot", username: "2B", bot: true },
        content: "",
        timestamp: "2026-07-23T00:00:00.000Z",
        message_reference: { message_id: "parent" },
        components: [{ type: 17, components: [{ type: 10, content: "component text" }] }],
        attachments: [{
          id: "attachment",
          filename: "notes.txt",
          content_type: "text/plain",
          size: 42,
        }],
        embeds: [{
          type: "gifv",
          url: "https://example.com/post",
          provider: { name: "Tenor" },
          thumbnail: { url: "https://example.com/preview.gif", width: 10, height: 20 },
        }],
        sticker_items: [{ id: "sticker", name: "Wave", format_type: 1 }],
      },
    });

    expect(row.content).toBe("component text <sticker>Wave</sticker>");
    expect(row.replyToId).toBe("parent");
    expect(row.isBot).toBe(true);
    expect(row.assets.map((asset) => [asset.sourceKind, asset.kind])).toEqual([
      ["attachment", "text"],
      ["embed", "gif"],
      ["sticker", "image"],
    ]);
  });

  test("stores attachment-only messages and their reply and asset metadata", () => {
    const db = createDatabase(":memory:");
    const row = discordMessageToImportRow({
      guildId: "guild",
      channelId: "channel",
      botUserId: "bot",
      createdAt: 123,
      message: {
        id: "message",
        author: { id: "user", username: "A2" },
        content: "",
        timestamp: "2026-07-23T00:00:00.000Z",
        message_reference: { message_id: "parent" },
        attachments: [{
          id: "attachment",
          filename: "photo.png",
          content_type: "image/png",
          size: 42,
          width: 10,
          height: 20,
        }],
      },
    });

    insertRows(db, [row]);
    syncMessageAssets(db, { messageId: row.id, assets: row.assets });

    expect(db.raw.prepare(
      "SELECT raw_content, translated_content, reply_to_id, assets_indexed_at FROM messages WHERE id = ?",
    ).get(row.id)).toEqual({
      raw_content: "",
      translated_content: "",
      reply_to_id: "parent",
      assets_indexed_at: expect.any(Number),
    });
    expect(getAssetsByMessageId(db, row.id)).toMatchObject([{
      sourceKind: "attachment",
      sourceKey: "attachment",
      kind: "image",
      filename: "photo.png",
    }]);
    db.close();
  });
});
