import { describe, expect, test } from "bun:test";
import { appendStickerTags, messageDisplayContent } from "./message-media.ts";

describe("message media helpers", () => {
  test("appends sanitized sticker tags after original content", () => {
    expect(appendStickerTags("look", [{ name: "Wave\n<big>" }])).toBe("look <sticker>Wave big</sticker>");
  });

  test("uses sticker tag as content for sticker-only messages", () => {
    expect(appendStickerTags("", [{ name: "Blob Dance" }])).toBe("<sticker>Blob Dance</sticker>");
  });

  test("extracts nested Components V2 text for cross-bot history", () => {
    const components = [{
      toJSON: () => ({
        type: 17,
        components: [
          { type: 10, content: "## 🎲 Initiative" },
          { type: 9, components: [{ type: 10, content: "Result: 20" }] },
        ],
      }),
    }];

    expect(messageDisplayContent("", components)).toBe("## 🎲 Initiative\nResult: 20");
    expect(messageDisplayContent("prefix", components)).toBe("prefix\n## 🎲 Initiative\nResult: 20");
  });
});
