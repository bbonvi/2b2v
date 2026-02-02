import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createDatabase, type Database } from "./database.ts";
import { processAndStoreImage, processImageBuffer, type ImageIngestDeps } from "./image-ingest.ts";
import { getImagesByMessageId } from "./image-repository.ts";
import { imagePath } from "./image-storage.ts";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync } from "fs";
import sharp from "sharp";

function tmpDb(): Database {
  return createDatabase(join(tmpdir(), `test-ingest-${randomUUID()}.db`));
}

function tmpAttachmentsDir(): string {
  const dir = join(tmpdir(), `attachments-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function createTestImage(width: number, height: number, format: "png" | "jpeg" | "webp" = "png"): Promise<Buffer> {
  const pipeline = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 128, g: 64, b: 32 },
    },
  });
  if (format === "png") return Buffer.from(await pipeline.png().toBuffer());
  if (format === "webp") return Buffer.from(await pipeline.webp().toBuffer());
  return Buffer.from(await pipeline.jpeg().toBuffer());
}

describe("processImageBuffer", () => {
  test("converts PNG to JPEG q=85 and resizes", async () => {
    const input = await createTestImage(1200, 800);
    const result = await processImageBuffer(input, "image/png", 600);

    expect(result.mime).toBe("image/jpeg");
    const meta = await sharp(result.data).metadata();
    expect(meta.format).toBe("jpeg");
    // Longest side should be <= 600
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(600);
    expect(meta.width).toBe(600);
  });

  test("converts WebP to JPEG", async () => {
    const input = await createTestImage(400, 300, "webp");
    const result = await processImageBuffer(input, "image/webp", 800);

    expect(result.mime).toBe("image/jpeg");
    const meta = await sharp(result.data).metadata();
    expect(meta.format).toBe("jpeg");
    // Under max dimension — no resize
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
  });

  test("converts JPEG input to JPEG q=85 (recompresses)", async () => {
    const input = await createTestImage(300, 200, "jpeg");
    const result = await processImageBuffer(input, "image/jpeg", 800);

    expect(result.mime).toBe("image/jpeg");
    expect(result.width).toBe(300);
    expect(result.height).toBe(200);
  });

  test("resizes tall image by height", async () => {
    const input = await createTestImage(400, 1200);
    const result = await processImageBuffer(input, "image/png", 600);

    expect(result.height).toBeLessThanOrEqual(600);
    expect(result.width).toBeLessThan(400);
  });

  test("does not enlarge small images", async () => {
    const input = await createTestImage(100, 80);
    const result = await processImageBuffer(input, "image/png", 600);

    expect(result.width).toBe(100);
    expect(result.height).toBe(80);
  });
});

describe("processAndStoreImage", () => {
  let db: Database;
  let attachmentsDir: string;

  beforeEach(() => {
    db = tmpDb();
    attachmentsDir = tmpAttachmentsDir();
  });

  afterEach(() => {
    db.close();
  });

  test("downloads, processes, writes to disk, and inserts DB record", async () => {
    const testBuffer = await createTestImage(800, 600);
    const fakeFetch = (_url: string) => Promise.resolve({
      ok: true as const,
      arrayBuffer: () => Promise.resolve(testBuffer.buffer.slice(testBuffer.byteOffset, testBuffer.byteOffset + testBuffer.byteLength)),
    });

    const deps: ImageIngestDeps = {
      db,
      attachmentsDir,
      maxDimension: 500,
      fetchFn: fakeFetch as ImageIngestDeps["fetchFn"],
    };

    const record = await processAndStoreImage(deps, {
      url: "https://cdn.discord.com/test.png",
      mimeType: "image/png",
      messageId: "msg-1",
      guildId: "g1",
      channelId: "c1",
    });

    // DB record created
    expect(record.id).toBeGreaterThan(0);
    expect(record.mime).toBe("image/jpeg");
    expect(record.width).toBeLessThanOrEqual(500);

    // File written to disk at deterministic path
    const expectedPath = imagePath(attachmentsDir, "g1", "c1", record.id);
    expect(record.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    // File is valid JPEG
    const diskMeta = await sharp(readFileSync(expectedPath)).metadata();
    expect(diskMeta.format).toBe("jpeg");

    // DB query returns the record
    const fromDb = getImagesByMessageId(db, "msg-1");
    expect(fromDb).toHaveLength(1);
    expect(fromDb[0]?.id).toBe(record.id);
  });

  test("creates directory structure if missing", async () => {
    const testBuffer = await createTestImage(200, 200);
    const fakeFetch = (_url: string) => Promise.resolve({
      ok: true as const,
      arrayBuffer: () => Promise.resolve(testBuffer.buffer.slice(testBuffer.byteOffset, testBuffer.byteOffset + testBuffer.byteLength)),
    });

    const freshDir = join(tmpdir(), `fresh-${randomUUID()}`);
    // Do NOT create the directory — pipeline should handle it

    const deps: ImageIngestDeps = {
      db,
      attachmentsDir: freshDir,
      maxDimension: 800,
      fetchFn: fakeFetch as ImageIngestDeps["fetchFn"],
    };

    const record = await processAndStoreImage(deps, {
      url: "https://example.com/img.jpg",
      mimeType: "image/jpeg",
      messageId: "msg-2",
      guildId: "g2",
      channelId: "c2",
    });

    expect(existsSync(record.path)).toBe(true);
  });

  test("throws on fetch failure", () => {
    const fakeFetch = (_url: string) => Promise.resolve({
      ok: false as const,
      status: 404,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    const deps: ImageIngestDeps = {
      db,
      attachmentsDir,
      maxDimension: 800,
      fetchFn: fakeFetch as ImageIngestDeps["fetchFn"],
    };

    expect(
      processAndStoreImage(deps, {
        url: "https://example.com/missing.png",
        mimeType: "image/png",
        messageId: "msg-3",
        guildId: "g1",
        channelId: "c1",
      })
    ).rejects.toThrow("fetch failed");
  });

  test("multiple images for same message get sequential IDs", async () => {
    const testBuffer = await createTestImage(100, 100);
    const fakeFetch = (_url: string) => Promise.resolve({
      ok: true as const,
      arrayBuffer: () => Promise.resolve(testBuffer.buffer.slice(testBuffer.byteOffset, testBuffer.byteOffset + testBuffer.byteLength)),
    });

    const deps: ImageIngestDeps = {
      db,
      attachmentsDir,
      maxDimension: 800,
      fetchFn: fakeFetch as ImageIngestDeps["fetchFn"],
    };

    const a = await processAndStoreImage(deps, {
      url: "https://example.com/1.png",
      mimeType: "image/png",
      messageId: "msg-1",
      guildId: "g1",
      channelId: "c1",
    });
    const b = await processAndStoreImage(deps, {
      url: "https://example.com/2.png",
      mimeType: "image/png",
      messageId: "msg-1",
      guildId: "g1",
      channelId: "c1",
    });

    expect(b.id).toBe(a.id + 1);
    expect(a.path).not.toBe(b.path);

    const all = getImagesByMessageId(db, "msg-1");
    expect(all).toHaveLength(2);
  });
});
