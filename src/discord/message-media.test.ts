import { describe, expect, test } from "bun:test";
import {
  appendStickerTags,
  guessImageMimeFromUrl,
  imageKindForAttachment,
  imageKindForEmbed,
  stickerImagePreview,
} from "./message-media.ts";

describe("message media helpers", () => {
  test("appends sanitized sticker tags after original content", () => {
    expect(appendStickerTags("look", [{ name: "Wave\n<big>" }])).toBe("look <sticker>Wave big</sticker>");
  });

  test("uses sticker tag as content for sticker-only messages", () => {
    expect(appendStickerTags("", [{ name: "Blob Dance" }])).toBe("<sticker>Blob Dance</sticker>");
  });

  test("marks GIF attachments from MIME type or filename", () => {
    expect(imageKindForAttachment("image/gif", "x.png")).toBe("gif");
    expect(imageKindForAttachment("image/png", "https://cdn.example.com/funny.gif?ex=1")).toBe("gif");
    expect(imageKindForAttachment("image/png", "image.png")).toBe("image");
  });

  test("marks Tenor/Giphy embeds as GIF previews", () => {
    expect(imageKindForEmbed({ provider: { name: "Tenor" }, url: "https://tenor.com/view/a" }, "https://media.example.com/a.webp")).toBe("gif");
    expect(imageKindForEmbed({ type: "gifv" }, "https://media.example.com/a.png")).toBe("gif");
    expect(imageKindForEmbed({}, "https://media.example.com/a.png")).toBe("image");
  });

  test("builds sticker image previews for static and animated image formats", () => {
    expect(stickerImagePreview({ name: "Dance", url: "https://cdn.example.com/dance.gif", format: 4 })).toEqual({
      url: "https://cdn.example.com/dance.gif",
      mimeType: "image/gif",
      sourceKind: "sticker",
    });
    expect(stickerImagePreview({ name: "Smile", url: "https://cdn.example.com/smile.png", format: 1 })).toEqual({
      url: "https://cdn.example.com/smile.png",
      mimeType: "image/png",
      sourceKind: "sticker",
    });
    expect(stickerImagePreview({ name: "Vector", url: "https://cdn.example.com/vector.json", format: 3 })).toBeNull();
  });

  test("guesses image MIME type from URL", () => {
    expect(guessImageMimeFromUrl("https://cdn.example.com/a.webp?x=1")).toBe("image/webp");
    expect(guessImageMimeFromUrl("https://cdn.example.com/a.jpeg")).toBe("image/jpeg");
    expect(guessImageMimeFromUrl("https://cdn.example.com/a")).toBe("image/png");
  });
});
