import sharp from "sharp";
import type { ImageContent } from "@mariozechner/pi-ai";

/** Supported output formats for LLM multimodal blocks. */
const SUPPORTED_MIME = new Set(["image/png", "image/jpeg", "image/gif"]);

/**
 * Resize an image buffer to fit within maxDimension (longest side)
 * and return an ImageContent block ready for the LLM.
 *
 * Unsupported formats (e.g. webp) are converted to jpeg.
 */
export async function resizeImageToContent(
  buffer: Buffer,
  mimeType: string,
  maxDimension: number
): Promise<ImageContent> {
  let pipeline = sharp(buffer);
  const meta = await pipeline.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const longest = Math.max(width, height);
  if (longest > maxDimension) {
    pipeline = pipeline.resize({
      width: width >= height ? maxDimension : undefined,
      height: height > width ? maxDimension : undefined,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  // Convert unsupported formats to jpeg
  let outputMime = mimeType;
  if (!SUPPORTED_MIME.has(mimeType)) {
    pipeline = pipeline.jpeg();
    outputMime = "image/jpeg";
  }

  const outputBuffer = await pipeline.toBuffer();
  return {
    type: "image",
    data: outputBuffer.toString("base64"),
    mimeType: outputMime,
  };
}
