import { describe, expect, test } from "bun:test";
import { appendStickerTags } from "./message-media.ts";

describe("message media helpers", () => {
  test("appends sanitized sticker tags after original content", () => {
    expect(appendStickerTags("look", [{ name: "Wave\n<big>" }])).toBe("look <sticker>Wave big</sticker>");
  });

  test("uses sticker tag as content for sticker-only messages", () => {
    expect(appendStickerTags("", [{ name: "Blob Dance" }])).toBe("<sticker>Blob Dance</sticker>");
  });
});
