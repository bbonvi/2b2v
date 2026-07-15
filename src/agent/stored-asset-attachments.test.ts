import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { syncMessageAssets } from "../db/asset-repository.ts";
import { createDatabase, type Database } from "../db/database.ts";
import { createLogger } from "../logger.ts";
import { createStoredAssetAttachmentResolver } from "./stored-asset-attachments.ts";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("stored asset attachments", () => {
  test("reposts an asset from another guild when its live source is accessible", async () => {
    const [asset] = syncMessageAssets(db, {
      messageId: "source-message",
      assets: [{
        messageId: "source-message",
        guildId: "other-guild",
        channelId: "other-channel",
        sourceKind: "attachment",
        sourceKey: "attachment-1",
        kind: "image",
        filename: "reaction.png",
        contentType: "image/png",
        size: 3,
        width: 1,
        height: 1,
        durationSeconds: null,
        createdAt: 1,
      }],
    });
    if (asset === undefined) throw new Error("test asset was not created");
    const resolver = createStoredAssetAttachmentResolver({
      db,
      maxDownloadBytes: 1024,
      resolveSource: () => Promise.resolve({
        url: "https://cdn.test/reaction.png",
        contentType: "image/png",
        filename: "reaction.png",
      }),
      logger: createLogger({ level: "error" }),
      fetchFn: (() => Promise.resolve(new Response(Buffer.from("png")))) as unknown as typeof fetch,
    });

    const attachments = await resolver([asset.id]);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.filename).toBe("reaction.png");
    expect(attachments[0]?.buffer.toString()).toBe("png");
  });

  test("does not repost when the live source is inaccessible", async () => {
    const [asset] = syncMessageAssets(db, {
      messageId: "source-message",
      assets: [{
        messageId: "source-message",
        guildId: "other-guild",
        channelId: "private-channel",
        sourceKind: "attachment",
        sourceKey: "attachment-1",
        kind: "image",
        filename: "private.png",
        contentType: "image/png",
        size: 3,
        width: 1,
        height: 1,
        durationSeconds: null,
        createdAt: 1,
      }],
    });
    if (asset === undefined) throw new Error("test asset was not created");
    const resolver = createStoredAssetAttachmentResolver({
      db,
      maxDownloadBytes: 1024,
      resolveSource: () => Promise.resolve(null),
      logger: createLogger({ level: "error" }),
    });

    expect(await resolver([asset.id])).toEqual([]);
  });
});
