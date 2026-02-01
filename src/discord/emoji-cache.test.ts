import { describe, test, expect, beforeEach } from "bun:test";
import {
  EmojiCache,
  buildEmojiContext,
  type EmojiEntry,
} from "./emoji-cache.ts";

function makeEmojis(): EmojiEntry[] {
  return [
    { name: "thumbsup", id: "111", animated: false },
    { name: "dance", id: "222", animated: true },
    { name: "wave", id: "333", animated: false },
  ];
}

describe("EmojiCache", () => {
  let cache: EmojiCache;

  beforeEach(() => {
    cache = new EmojiCache();
  });

  test("stores and retrieves emojis for a guild", () => {
    cache.set("guild1", makeEmojis());
    const result = cache.get("guild1");
    expect(result).toHaveLength(3);
    expect(result).toBeDefined();
    if (result === undefined) throw new Error("unreachable");
    const first = result[0];
    if (first === undefined) throw new Error("unreachable");
    expect(first.name).toBe("thumbsup");
  });

  test("returns undefined for unknown guild", () => {
    expect(cache.get("unknown")).toBeUndefined();
  });

  test("overwrites existing guild emojis", () => {
    cache.set("guild1", makeEmojis());
    cache.set("guild1", [{ name: "new", id: "444", animated: false }]);
    expect(cache.get("guild1")).toHaveLength(1);
    const updated = cache.get("guild1");
    expect(updated).toBeDefined();
    if (updated === undefined) throw new Error("unreachable");
    const firstUpdated = updated[0];
    if (firstUpdated === undefined) throw new Error("unreachable");
    expect(firstUpdated.name).toBe("new");
  });

  test("lookup finds emoji by name", () => {
    cache.set("guild1", makeEmojis());
    const emoji = cache.lookup("guild1", "dance");
    expect(emoji).toEqual({ id: "222", animated: true });
  });

  test("lookup returns undefined for unknown emoji", () => {
    cache.set("guild1", makeEmojis());
    expect(cache.lookup("guild1", "nope")).toBeUndefined();
  });

  test("lookup returns undefined for unknown guild", () => {
    expect(cache.lookup("unknown", "thumbsup")).toBeUndefined();
  });

  test("clear removes guild entry", () => {
    cache.set("guild1", makeEmojis());
    cache.clear("guild1");
    expect(cache.get("guild1")).toBeUndefined();
  });

  test("isStale returns true when no entry exists", () => {
    expect(cache.isStale("guild1", 60_000)).toBe(true);
  });

  test("isStale returns false for fresh entry", () => {
    cache.set("guild1", makeEmojis());
    expect(cache.isStale("guild1", 60_000)).toBe(false);
  });

  test("isStale returns true after TTL expires", () => {
    cache.set("guild1", makeEmojis());
    // Manually backdate the timestamp
    cache._setTimestamp("guild1", Date.now() - 120_000);
    expect(cache.isStale("guild1", 60_000)).toBe(true);
  });
});

describe("buildEmojiContext", () => {
  test("formats emoji list for LLM context", () => {
    const emojis: EmojiEntry[] = [
      { name: "thumbsup", id: "111", animated: false },
      { name: "dance", id: "222", animated: true },
    ];
    const result = buildEmojiContext(emojis);
    expect(result).toContain(":thumbsup:");
    expect(result).toContain(":dance:");
    // Each line should have the `:name: —` format
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/^:.+: —/);
    }
  });

  test("returns empty string for empty list", () => {
    expect(buildEmojiContext([])).toBe("");
  });

  test("marks animated emojis", () => {
    const emojis: EmojiEntry[] = [
      { name: "dance", id: "222", animated: true },
    ];
    const result = buildEmojiContext(emojis);
    expect(result).toContain("animated");
  });
});
