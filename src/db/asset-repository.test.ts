import { describe, expect, test } from "bun:test";
import { createDatabase } from "./database.ts";
import { getAssetById, syncAssetBackfillPage, syncMessageAssets } from "./asset-repository.ts";

function insertMessage(db: ReturnType<typeof createDatabase>, id: string): void {
  db.raw.prepare(`INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, created_at)
    VALUES (?, 'g', 'c', 'u', 'alice', '', '', 1)`).run(id);
}

describe("message asset repository", () => {
  test("sync is idempotent and preserves short IDs", () => {
    const db = createDatabase(":memory:");
    insertMessage(db, "m1");
    const asset = { messageId: "m1", guildId: "g", channelId: "c", sourceKind: "attachment" as const,
      sourceKey: "discord-1", kind: "image" as const, filename: "a.png", contentType: "image/png",
      size: 10, width: 1, height: 2, durationSeconds: null, createdAt: 1 };
    const first = syncMessageAssets(db, { messageId: "m1", assets: [asset] });
    const second = syncMessageAssets(db, { messageId: "m1", assets: [{ ...asset, filename: "renamed.png" }] });
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(second[0]?.filename).toBe("renamed.png");
    db.close();
  });

  test("page sync advances checkpoint atomically and can repeat", () => {
    const db = createDatabase(":memory:");
    insertMessage(db, "m1");
    const asset = { messageId: "m1", guildId: "g", channelId: "c", sourceKind: "attachment" as const,
      sourceKey: "discord-1", kind: "text" as const, filename: "a.txt", contentType: "text/plain",
      size: 10, width: null, height: null, durationSeconds: null, createdAt: 1 };
    const page = { guildId: "g", channelId: "c", beforeMessageId: "m1", completed: false,
      messages: [{ messageId: "m1", assets: [asset] }] };
    syncAssetBackfillPage(db, page);
    syncAssetBackfillPage(db, page);
    expect(getAssetById(db, 1)?.sourceKey).toBe("discord-1");
    expect(db.raw.prepare("SELECT before_message_id FROM asset_backfill_checkpoints WHERE channel_id = 'c'").get())
      .toEqual({ before_message_id: "m1" });
    db.close();
  });
});
