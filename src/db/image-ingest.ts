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

const MIME_EXTENSION: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/tiff": "tiff",
  "image/webp": "webp",
};

function extensionForMime(mimeType: string): string {
  return MIME_EXTENSION[mimeType.toLowerCase()] ?? "bin";
}

/** Infer a stored image MIME type from file signatures, falling back to a provided MIME type. */
export function imageMimeFromBuffer(buffer: Buffer, fallbackMimeType: string): string {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  if (
    buffer.length >= 4
    && (
      buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
      || buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
    )
  ) {
    return "image/tiff";
  }
  return fallbackMimeType;
}

/** Return the deterministic file extension used for a stored image MIME type. */
export function imageExtensionForMime(mimeType: string): string {
  return extensionForMime(mimeType);
}

/**
 * Prepare a canonical user image for persistent storage.
 * Resizes only when the longest edge exceeds maxDimension and stores WebP q=90.
 * Pure transform — no IO.
 *
 * For animated formats (GIF, animated WebP), sharp extracts only the first
 * frame by default (pages=1, page=0). User uploads are stored as static
 * canonical sources for later model reads and image-generation references.
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

  pipeline = pipeline.webp({ quality: 90 });

  const outputBuffer = await pipeline.toBuffer();
  const outputMeta = await sharp(outputBuffer).metadata();

  return {
    data: Buffer.from(outputBuffer),
    mime: "image/webp",
    width: outputMeta.width,
    height: outputMeta.height,
  };
}

/**
 * Prepare an ephemeral image copy for LLM vision/context use.
 * The returned JPEG is intentionally not persisted.
 */
export async function prepareImageBufferForContext(
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

  const outputBuffer = await pipeline.jpeg({ quality: 85 }).toBuffer();
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
  return insertAndWriteImage(deps, input, processed, extensionForMime(processed.mime));
}

/** Persist an already generated image without lossy recompression. */
export async function storeImageBufferUnmodified(
  deps: Omit<ImageStoreDeps, "maxDimension">,
  input: ImageBufferStoreInput,
): Promise<ImageRecord> {
  const meta = await sharp(input.buffer).metadata();
  const actualMime = imageMimeFromBuffer(input.buffer, input.mimeType);
  const stored: ProcessedImage = {
    data: input.buffer,
    mime: actualMime,
    width: meta.width,
    height: meta.height,
  };
  return insertAndWriteImage(deps, input, stored, extensionForMime(actualMime));
}

function insertAndWriteImage(
  deps: Pick<ImageStoreDeps, "db" | "attachmentsDir">,
  input: ImageBufferStoreInput,
  stored: ProcessedImage,
  extension: string,
): ImageRecord {
  // Insert with a placeholder path to get the autoincrement ID
  const record = insertImage(deps.db, {
    messageId: input.messageId,
    guildId: input.guildId,
    channelId: input.channelId,
    path: "",
    mime: stored.mime,
    width: stored.width,
    height: stored.height,
    createdAt: Date.now(),
    caption: input.caption,
  });

  // Compute deterministic path from the ID
  const destPath = imagePath(deps.attachmentsDir, input.guildId, input.channelId, record.id, extension);

  // Write to disk
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, stored.data);

  // Update path in DB
  deps.db.raw.prepare("UPDATE images SET path = ? WHERE id = ?").run(destPath, record.id);
  record.path = destPath;

  return record;
}
