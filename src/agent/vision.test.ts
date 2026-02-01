import { test, expect, describe } from "bun:test";
import { resizeImageToContent } from "./vision.ts";
import sharp from "sharp";

/** Create a test image buffer of given dimensions. */
async function makeImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
}

describe("resizeImageToContent", () => {
  test("returns base64 data and correct mimeType for png", async () => {
    const buf = await makeImage(100, 100);
    const result = await resizeImageToContent(buf, "image/png", 768);
    expect(result.type).toBe("image");
    expect(result.mimeType).toBe("image/png");
    expect(typeof result.data).toBe("string");
    // data should be valid base64
    expect(() => Buffer.from(result.data, "base64")).not.toThrow();
  });

  test("does not resize images within max dimension", async () => {
    const buf = await makeImage(500, 300);
    const result = await resizeImageToContent(buf, "image/png", 768);
    const meta = await sharp(Buffer.from(result.data, "base64")).metadata();
    expect(meta.width).toBe(500);
    expect(meta.height).toBe(300);
  });

  test("resizes landscape image exceeding max dimension", async () => {
    const buf = await makeImage(1536, 1024);
    const result = await resizeImageToContent(buf, "image/png", 768);
    const meta = await sharp(Buffer.from(result.data, "base64")).metadata();
    expect(meta.width).toBe(768);
    expect(meta.height).toBe(512);
  });

  test("resizes portrait image exceeding max dimension", async () => {
    const buf = await makeImage(600, 1200);
    const result = await resizeImageToContent(buf, "image/jpeg", 768);
    const meta = await sharp(Buffer.from(result.data, "base64")).metadata();
    expect(meta.width).toBe(384);
    expect(meta.height).toBe(768);
  });

  test("preserves jpeg mimeType", async () => {
    const buf = await makeImage(100, 100);
    const jpegBuf = await sharp(buf).jpeg().toBuffer();
    const result = await resizeImageToContent(jpegBuf, "image/jpeg", 768);
    expect(result.mimeType).toBe("image/jpeg");
  });

  test("handles exact max dimension without resizing", async () => {
    const buf = await makeImage(768, 512);
    const result = await resizeImageToContent(buf, "image/png", 768);
    const meta = await sharp(Buffer.from(result.data, "base64")).metadata();
    expect(meta.width).toBe(768);
    expect(meta.height).toBe(512);
  });

  test("converts webp to jpeg for LLM compatibility", async () => {
    const buf = await makeImage(100, 100);
    const webpBuf = await sharp(buf).webp().toBuffer();
    const result = await resizeImageToContent(webpBuf, "image/webp", 768);
    expect(result.mimeType).toBe("image/jpeg");
  });
});
