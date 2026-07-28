import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { syncMessageAssets } from "../db/asset-repository.ts";
import { createDatabase, type Database } from "../db/database.ts";
import { createLogger } from "../logger.ts";
import { createStagedAsset, reconcileStagedAsset } from "../db/staged-asset-repository.ts";
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
    expect(attachments[0]?.sourceAssetId).toBe(asset.id);
  });

  test("uses a native sticker and keeps a typed image fallback", async () => {
    const [asset] = syncMessageAssets(db, {
      messageId: "sticker-message",
      assets: [{
        messageId: "sticker-message",
        guildId: "g",
        channelId: "c",
        sourceKind: "sticker",
        sourceKey: "sticker-1",
        kind: "image",
        filename: "хуйня",
        contentType: null,
        size: null,
        width: null,
        height: null,
        durationSeconds: null,
        createdAt: 1,
      }],
    });
    if (asset === undefined) throw new Error("test asset was not created");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const resolver = createStoredAssetAttachmentResolver({
      db,
      maxDownloadBytes: 1024,
      resolveSource: () => Promise.resolve({
        url: "https://cdn.test/sticker.png",
        contentType: null,
        filename: "хуйня",
      }),
      canSendSticker: () => Promise.resolve(true),
      logger: createLogger({ level: "error" }),
      fetchFn: (() => Promise.resolve(new Response(png))) as unknown as typeof fetch,
    });

    const attachments = await resolver([asset.id]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      filename: "хуйня.png",
      contentType: "image/png",
      stickerId: "sticker-1",
      sourceAssetId: asset.id,
    });
  });

  test("uploads an unavailable GIF sticker with a GIF extension", async () => {
    const [asset] = syncMessageAssets(db, {
      messageId: "sticker-message",
      assets: [{
        messageId: "sticker-message",
        guildId: "g",
        channelId: "c",
        sourceKind: "sticker",
        sourceKey: "sticker-1",
        kind: "gif",
        filename: "dance",
        contentType: null,
        size: null,
        width: null,
        height: null,
        durationSeconds: null,
        createdAt: 1,
      }],
    });
    if (asset === undefined) throw new Error("test asset was not created");
    const gif = Buffer.from("GIF89a");
    const resolver = createStoredAssetAttachmentResolver({
      db,
      maxDownloadBytes: 1024,
      resolveSource: () => Promise.resolve({
        url: "https://cdn.test/sticker.gif",
        contentType: null,
        filename: "dance",
      }),
      canSendSticker: () => Promise.resolve(false),
      logger: createLogger({ level: "error" }),
      fetchFn: (() => Promise.resolve(new Response(gif))) as unknown as typeof fetch,
    });

    const attachments = await resolver([asset.id]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      filename: "dance.gif",
      contentType: "image/gif",
      sourceAssetId: asset.id,
    });
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

  test("reposts a Link asset only when it resolves to media", async () => {
    const [asset] = syncMessageAssets(db, {
      messageId: "link-message",
      assets: [{
        messageId: "link-message",
        guildId: "g",
        channelId: "c",
        sourceKind: "url",
        sourceKey: "https://example.com/cat.png",
        kind: "link",
        filename: null,
        contentType: null,
        size: null,
        width: null,
        height: null,
        durationSeconds: null,
        createdAt: 1,
      }],
    });
    if (asset === undefined) throw new Error("test asset was not created");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const resolver = createStoredAssetAttachmentResolver({
      db,
      maxDownloadBytes: 1024,
      resolveSource: () => Promise.resolve({ url: asset.sourceKey, contentType: null, filename: null }),
      resolveLink: (input) => Promise.resolve({
        cacheMode: "prefer",
        cacheStatus: "hit",
        content: {
          kind: "image",
          requestedUrl: input.url,
          finalUrl: input.url,
          contentType: "image/png",
          fetchedAt: 1,
          preview: png,
          previewMimeType: "image/png",
          width: 1,
          height: 1,
          images: [],
        },
      }),
      logger: createLogger({ level: "error" }),
      fetchFn: (() => Promise.resolve(new Response(png))) as unknown as typeof fetch,
    });

    const attachments = await resolver([asset.id]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ contentType: "image/png", filename: `link-${asset.id}` });
  });

  test("does not repost a Link asset that resolves to a page", async () => {
    const [asset] = syncMessageAssets(db, {
      messageId: "page-message",
      assets: [{
        messageId: "page-message",
        guildId: "g",
        channelId: "c",
        sourceKind: "url",
        sourceKey: "https://example.com/post",
        kind: "link",
        filename: null,
        contentType: null,
        size: null,
        width: null,
        height: null,
        durationSeconds: null,
        createdAt: 1,
      }],
    });
    if (asset === undefined) throw new Error("test asset was not created");
    const resolver = createStoredAssetAttachmentResolver({
      db,
      maxDownloadBytes: 1024,
      resolveSource: () => Promise.resolve({ url: asset.sourceKey, contentType: null, filename: null }),
      resolveLink: (input) => Promise.resolve({
        cacheMode: "prefer",
        cacheStatus: "hit",
        content: {
          kind: "page",
          requestedUrl: input.url,
          finalUrl: input.url,
          contentType: "text/html",
          fetchedAt: 1,
          title: "Post",
          readableText: "post",
          rawText: "<p>post</p>",
          images: [],
        },
      }),
      logger: createLogger({ level: "error" }),
    });

    expect(await resolver([asset.id])).toEqual([]);
  });

  test("loads an in-scope staged handle from durable storage", async () => {
    const storagePath = `/tmp/2b2v-staged-${crypto.randomUUID()}.webp`;
    await Bun.write(storagePath, Buffer.from("staged-image"));
    db.raw.prepare(
      `INSERT INTO agent_jobs
        (id, kind, guild_id, channel_id, delivery_guild_id, delivery_channel_id,
         requester_id, requester_username, source_message_id, source_quote, status,
         input_json, created_at, replacement_count)
       VALUES ('img-stage', 'image_generation', 'g1', 'c1', 'g1', 'c1',
         'u1', 'alice', 'm1', 'quote', 'ready', '{}', 1, 0)`,
    ).run();
    createStagedAsset(db, {
      ref: "job_imgstage",
      jobId: "img-stage",
      ownerGuildId: "g1",
      ownerChannelId: "c1",
      filename: "result.webp",
      contentType: "image/webp",
      storagePath,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });
    const resolver = createStoredAssetAttachmentResolver({
      db,
      stagedGuildId: "g1",
      maxDownloadBytes: 1024,
      resolveSource: () => Promise.resolve(null),
      logger: createLogger({ level: "error" }),
    });

    const attachments = await resolver(["job_imgstage", "job_imgstage"]);
    await Bun.file(storagePath).delete();

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      id: "staged-job_imgstage",
      filename: "result.webp",
      contentType: "image/webp",
    });
    expect(attachments[0]?.buffer.toString()).toBe("staged-image");
  });

  test("does not resolve an already delivered staged handle", async () => {
    const storagePath = `/tmp/2b2v-delivered-${crypto.randomUUID()}.webp`;
    await Bun.write(storagePath, Buffer.from("staged-image"));
    db.raw.prepare(
      `INSERT INTO agent_jobs
        (id, kind, guild_id, channel_id, delivery_guild_id, delivery_channel_id,
         requester_id, requester_username, source_message_id, source_quote, status,
         input_json, created_at, replacement_count)
       VALUES ('img-delivered', 'image_generation', 'g1', 'c1', 'g1', 'c1',
         'u1', 'alice', 'm1', 'quote', 'delivered', '{}', 1, 0)`,
    ).run();
    createStagedAsset(db, {
      ref: "job_delivered",
      jobId: "img-delivered",
      ownerGuildId: "g1",
      ownerChannelId: "c1",
      filename: "result.webp",
      contentType: "image/webp",
      storagePath,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });
    reconcileStagedAsset(db, {
      ref: "job_delivered",
      deliveredMessageId: "outgoing-1",
    });
    const resolver = createStoredAssetAttachmentResolver({
      db,
      stagedGuildId: "g1",
      maxDownloadBytes: 1024,
      resolveSource: () => Promise.resolve(null),
      logger: createLogger({ level: "error" }),
    });

    expect(await resolver(["job_delivered"])).toEqual([]);
    await Bun.file(storagePath).delete();
  });
});
