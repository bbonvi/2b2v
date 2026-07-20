import sharp from "sharp";
import type { MessageAsset } from "../db/asset-repository.ts";
import type { ReferenceImageInput } from "./codex-image-tool.ts";
import type { ResolvedAssetSource } from "./read-asset-tool.ts";
import { fetchAssetBuffer } from "./read-asset-tool.ts";
import type { StagedAsset } from "../db/staged-asset-repository.ts";

/** Load an exact image attachment, or a static first frame for animated visual assets. */
export async function loadAssetReferenceImage(input: {
  asset: MessageAsset;
  source: ResolvedAssetSource;
  maxBytes: number;
}): Promise<ReferenceImageInput | null> {
  if (input.asset.kind !== "image" && input.asset.kind !== "gif") return null;
  let buffer = await fetchAssetBuffer(fetch, input.source.url, input.maxBytes);
  let mimeType = input.source.contentType ?? input.asset.contentType ?? "image/png";
  if (input.asset.kind === "gif") {
    buffer = await sharp(buffer, { pages: 1 }).png().toBuffer();
    mimeType = "image/png";
  }
  const metadata = await sharp(buffer).metadata();
  return {
    id: input.asset.id,
    data: buffer.toString("base64"),
    mimeType,
    width: metadata.width,
    height: metadata.height,
  };
}

/** Load a durable staged generated image before Discord delivery. */
export async function loadStagedAssetReferenceImage(input: {
  asset: StagedAsset;
  maxBytes: number;
}): Promise<ReferenceImageInput | null> {
  if (!input.asset.contentType.startsWith("image/")) return null;
  const file = Bun.file(input.asset.storagePath);
  if (!await file.exists() || file.size > input.maxBytes) return null;
  const buffer = Buffer.from(await file.arrayBuffer());
  const metadata = await sharp(buffer).metadata();
  return {
    id: input.asset.ref,
    data: buffer.toString("base64"),
    mimeType: input.asset.contentType,
    width: metadata.width,
    height: metadata.height,
  };
}
