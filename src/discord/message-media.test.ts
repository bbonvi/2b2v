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

  test("converts recognized dice cards to untranslated system history", () => {
    const components = [{
      toJSON: () => ({
        type: 17,
        id: 0x2b2d21,
        components: [{ type: 10, content: "# ❌ ПРОВАЛ `🎲 12`\n## Взлом ворот — Сложность `13`\n\n`Биш` `Сила (Атлетика)` `d20+2`" }],
      }),
    }];

    expect(messageDisplayContent("", components, "2B")).toBe(
      '<dice_roll source="2B" actor_name="Биш" lang="ru" visibility="public" notation="d20+2" mode="normal" total="12" label="Взлом ворот" trait="Сила (Атлетика)" target="13" outcome="failure"/>',
    );
  });

  test("preserves advantage dice in cross-bot history", () => {
    const components = [{
      toJSON: () => ({
        type: 17,
        id: 0x2b2d20,
        components: [{ type: 10, content: "# ✅ SUCCESS `🎲 21`\n## Pass quietly — Difficulty `14`\n\n`Bish` `Dexterity (Stealth)` `d20+5` `🟢 Advantage (🎲 9 🎲 16)`" }],
      }),
    }];

    expect(messageDisplayContent("", components, "Delamain")).toBe(
      '<dice_roll source="Delamain" actor_name="Bish" lang="en" visibility="public" notation="d20+5" mode="advantage" rolls="9,16" kept="16" total="21" label="Pass quietly" trait="Dexterity (Stealth)" target="14" outcome="success"/>',
    );
  });
});
