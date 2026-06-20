import { describe, expect, test } from "bun:test";
import { resolveReactionEmojiInput } from "./reaction-emoji.ts";

describe("resolveReactionEmojiInput", () => {
  const lookup = (name: string) => {
    if (name === "thumbsup") return { id: "111", animated: false };
    if (name === "dance") return { id: "222", animated: true };
    return undefined;
  };

  test("keeps unicode emoji intact", () => {
    expect(resolveReactionEmojiInput(" 👍 ", lookup)).toBe("👍");
  });

  test("keeps Discord custom emoji markup intact", () => {
    expect(resolveReactionEmojiInput("<:thumbsup:111>", lookup)).toBe("<:thumbsup:111>");
    expect(resolveReactionEmojiInput("<a:dance:222>", lookup)).toBe("<a:dance:222>");
  });

  test("resolves colon-wrapped custom emoji names", () => {
    expect(resolveReactionEmojiInput(":thumbsup:", lookup)).toBe("<:thumbsup:111>");
    expect(resolveReactionEmojiInput(":dance:", lookup)).toBe("<a:dance:222>");
  });

  test("resolves plain custom emoji names", () => {
    expect(resolveReactionEmojiInput("thumbsup", lookup)).toBe("<:thumbsup:111>");
  });

  test("falls back to trimmed input for unknown names", () => {
    expect(resolveReactionEmojiInput(":unknown:", lookup)).toBe(":unknown:");
  });

  test("returns null for blank input", () => {
    expect(resolveReactionEmojiInput("   ", lookup)).toBeNull();
  });
});
