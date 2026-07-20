import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "./database.ts";
import {
  createStagedAsset,
  getStagedAsset,
  listStagedAssets,
  reconcileStagedAsset,
} from "./staged-asset-repository.ts";

describe("staged asset repository", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    db.raw.prepare(
      `INSERT INTO agent_jobs
        (id, kind, guild_id, channel_id, delivery_guild_id, delivery_channel_id,
         requester_id, requester_username, source_message_id, source_quote, status,
         input_json, created_at, replacement_count)
       VALUES ('img-1', 'image_generation', 'g1', 'c1', 'g1', 'c1',
         'u1', 'alice', 'm1', 'quote', 'ready', '{}', 1, 0)`,
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  test("survives as unresolved metadata until one delivery reconciliation", () => {
    createStagedAsset(db, {
      ref: "job_img1",
      jobId: "img-1",
      ownerGuildId: "g1",
      ownerChannelId: "c1",
      filename: "result.webp",
      contentType: "image/webp",
      storagePath: "/tmp/result.webp",
      createdAt: 10,
      expiresAt: 20,
    });

    expect(listStagedAssets(db, { unresolvedOnly: true })).toHaveLength(1);
    expect(reconcileStagedAsset(db, {
      ref: "job_img1",
      deliveredMessageId: "m2",
    })).toBe(true);
    expect(reconcileStagedAsset(db, {
      ref: "job_img1",
      deliveredMessageId: "m3",
    })).toBe(false);
    expect(getStagedAsset(db, "job_img1")?.deliveredMessageId).toBe("m2");
    expect(listStagedAssets(db, { unresolvedOnly: true })).toEqual([]);
  });
});
