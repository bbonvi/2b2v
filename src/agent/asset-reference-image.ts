import sharp from "sharp";
import type { MessageAsset } from "../db/asset-repository.ts";
import type { ReferenceImageInput } from "./codex-image-tool.ts";
import type { ResolvedAssetSource } from "./read-asset-tool.ts";
import { fetchAssetBuffer } from "./read-asset-tool.ts";

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
