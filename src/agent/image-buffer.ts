import sharp from "sharp";

export interface PreparedImage {
  data: Buffer;
  mime: string;
  width: number;
  height: number;
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

/** Infer an image MIME type from file signatures, falling back to the declared type. */
export function imageMimeFromBuffer(buffer: Buffer, fallbackMimeType: string): string {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
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
  if (buffer.length >= 4 && (
    buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
    || buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
  )) return "image/tiff";
  return fallbackMimeType;
}

/** Return the conventional file extension for an image MIME type. */
export function imageExtensionForMime(mimeType: string): string {
  return MIME_EXTENSION[mimeType.toLowerCase()] ?? "bin";
}

/** Prepare a resized ephemeral JPEG for model vision or image-reference input. */
export async function prepareImageBufferForContext(
  buffer: Buffer,
  _mimeType: string,
  maxDimension: number,
): Promise<PreparedImage> {
  let pipeline = sharp(buffer);
  const metadata = await pipeline.metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (Math.max(width, height) > maxDimension) {
    pipeline = pipeline.resize({
      width: width >= height ? maxDimension : undefined,
      height: height > width ? maxDimension : undefined,
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  const data = await pipeline.jpeg({ quality: 85 }).toBuffer();
  const output = await sharp(data).metadata();
  return {
    data: Buffer.from(data),
    mime: "image/jpeg",
    width: output.width,
    height: output.height,
  };
}
