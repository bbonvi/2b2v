import { describe, expect, test } from "bun:test";
import { createDatabase } from "./database.ts";
import { getAssetById, recordAssetRepost, syncAssetBackfillPage, syncMessageAssets } from "./asset-repository.ts";
import { getHistoryMessagesByIds } from "./message-repository.ts";

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

  test("flattens repost lineage and carries generation provenance", () => {
    const db = createDatabase(":memory:");
    const makeAsset = (messageId: string, sourceKey: string) => {
      insertMessage(db, messageId);
      const [asset] = syncMessageAssets(db, { messageId, assets: [{
        messageId, guildId: "g", channelId: "c", sourceKind: "attachment", sourceKey,
        kind: "image", filename: "image.webp", contentType: "image/webp",
        size: 10, width: 1, height: 1, durationSeconds: null, createdAt: 1,
      }] });
      if (asset === undefined) throw new Error("test asset was not created");
      return asset;
    };
    const original = makeAsset("m1", "discord-1");
    const firstRepost = makeAsset("m2", "discord-2");
    const secondRepost = makeAsset("m3", "discord-3");
    db.raw.prepare(`INSERT INTO agent_jobs
      (id, kind, guild_id, channel_id, delivery_guild_id, delivery_channel_id,
       requester_id, requester_username, source_message_id, source_quote, status,
       input_json, created_at)
      VALUES ('img-1', 'image_generation', 'g', 'c', 'g', 'c',
       'u', 'alice', 'm0', '', 'delivered', '{"prompt":"moon"}', 1)`).run();
    db.raw.prepare("INSERT INTO agent_job_assets (job_id, asset_id, role) VALUES ('img-1', ?, 'output')")
      .run(original.id);

    expect(recordAssetRepost(db, firstRepost.id, original.id)).toBe(true);
    expect(recordAssetRepost(db, secondRepost.id, firstRepost.id)).toBe(true);

    expect(getAssetById(db, firstRepost.id)?.originalAssetId).toBe(original.id);
    expect(getAssetById(db, secondRepost.id)?.originalAssetId).toBe(original.id);
    expect(db.raw.prepare("SELECT job_id, role FROM agent_job_assets WHERE asset_id = ?").get(secondRepost.id))
      .toEqual({ job_id: "img-1", role: "output" });
    expect(getHistoryMessagesByIds(db, ["m3"])[0]?.assets?.[0]).toMatchObject({
      id: secondRepost.id,
      originalAssetId: original.id,
      jobId: "img-1",
    });
    db.close();
  });
});
