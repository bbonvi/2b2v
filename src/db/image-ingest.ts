import sharp from "sharp";
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { insertImage, type ImageRecord } from "./image-repository.ts";
import { imagePath } from "./image-storage.ts";
import type { Database } from "./database.ts";

export interface ProcessedImage {
  data: Buffer;
  mime: string;
  width: number;
  height: number;
}

export interface ImageIngestDeps {
  db: Database;
  attachmentsDir: string;
  maxDimension: number;
  fetchFn: (url: string) => Promise<{ ok: boolean; status?: number; arrayBuffer(): Promise<ArrayBuffer> }>;
}

export interface ImageStoreDeps {
  db: Database;
  attachmentsDir: string;
  maxDimension: number;
}

export interface ImageIngestInput {
  url: string;
  mimeType: string;
  messageId: string;
  guildId: string;
  channelId: string;
}

export interface ImageBufferStoreInput {
  buffer: Buffer;
  mimeType: string;
  messageId: string;
  guildId: string;
  channelId: string;
  caption?: string;
}

/**
 * Process an image buffer: resize to maxDimension, convert to JPEG q=85.
 * Pure transform — no IO.
 *
 * For animated formats (GIF, animated WebP), sharp extracts only the first
 * frame by default (pages=1, page=0). This is intentional — the bot stores
 * static snapshots for LLM context, not playable animations.
 */
export async function processImageBuffer(
  buffer: Buffer,
  _mimeType: string,
  maxDimension: number,
): Promise<ProcessedImage> {
  let pipeline = sharp(buffer);
  const meta = await pipeline.metadata();
  const w = meta.width;
  const h = meta.height;

  const longest = Math.max(w, h);
  if (longest > maxDimension) {
    pipeline = pipeline.resize({
      width: w >= h ? maxDimension : undefined,
      height: h > w ? maxDimension : undefined,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  // Always output JPEG q=85 per spec
  pipeline = pipeline.jpeg({ quality: 85 });

  const outputBuffer = await pipeline.toBuffer();
  const outputMeta = await sharp(outputBuffer).metadata();

  return {
    data: Buffer.from(outputBuffer),
    mime: "image/jpeg",
    width: outputMeta.width,
    height: outputMeta.height,
  };
}

/**
 * Full ingest pipeline: fetch → process → write to disk → insert DB record.
 *
 * The image is first inserted into the DB to obtain its autoincrement ID,
 * then written to disk at the deterministic path derived from that ID.
 * Finally the DB record is updated with the correct path.
 */
export async function processAndStoreImage(
  deps: ImageIngestDeps,
  input: ImageIngestInput,
): Promise<ImageRecord> {
  const response = await deps.fetchFn(input.url);
  if (!response.ok) {
    throw new Error(`image fetch failed (status: ${response.status ?? "unknown"})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return processAndStoreImageBuffer(deps, {
    buffer: Buffer.from(arrayBuffer),
    mimeType: input.mimeType,
    messageId: input.messageId,
    guildId: input.guildId,
    channelId: input.channelId,
  });
}

/** Process and persist an already downloaded image buffer. */
export async function processAndStoreImageBuffer(
  deps: ImageStoreDeps,
  input: ImageBufferStoreInput,
): Promise<ImageRecord> {
  const processed = await processImageBuffer(input.buffer, input.mimeType, deps.maxDimension);

  // Insert with a placeholder path to get the autoincrement ID
  const record = insertImage(deps.db, {
    messageId: input.messageId,
    guildId: input.guildId,
    channelId: input.channelId,
    path: "",
    mime: processed.mime,
    width: processed.width,
    height: processed.height,
    createdAt: Date.now(),
    caption: input.caption,
  });

  // Compute deterministic path from the ID
  const destPath = imagePath(deps.attachmentsDir, input.guildId, input.channelId, record.id);

  // Write to disk
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, processed.data);

  // Update path in DB
  deps.db.raw.prepare("UPDATE images SET path = ? WHERE id = ?").run(destPath, record.id);
  record.path = destPath;

  return record;
}
