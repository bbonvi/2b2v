import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { imageExtensionForMime, imageMimeFromBuffer, prepareImageBufferForContext } from "./image-buffer.ts";

async function createTestImage(width: number, height: number): Promise<Buffer> {
  return await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 128, g: 64, b: 32 },
    },
  }).png().toBuffer();
}

describe("image buffer utilities", () => {
  test("detects actual MIME types and maps extensions", async () => {
    const png = await createTestImage(10, 10);
    expect(imageMimeFromBuffer(png, "image/webp")).toBe("image/png");
    expect(imageExtensionForMime("image/jpeg")).toBe("jpg");
    expect(imageExtensionForMime("application/octet-stream")).toBe("bin");
  });

  test("creates a resized ephemeral JPEG", async () => {
    const input = await createTestImage(1200, 800);
    const result = await prepareImageBufferForContext(input, "image/png", 600);
    expect(result.mime).toBe("image/jpeg");
    expect(result.width).toBe(600);
    expect(result.height).toBe(400);
    expect((await sharp(result.data).metadata()).format).toBe("jpeg");
  });
});
