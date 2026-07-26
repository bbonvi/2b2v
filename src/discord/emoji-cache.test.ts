import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
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

  afterEach(() => {
    setSystemTime();
  });

  test("stores and retrieves emojis for a guild", () => {
    cache.set("guild1", makeEmojis());
    const result = cache.get("guild1");
    expect(result).toHaveLength(3);
    expect(result?.[0]?.name).toBe("thumbsup");
  });

  test("returns undefined for unknown guild", () => {
    expect(cache.get("unknown")).toBeUndefined();
  });

  test("overwrites existing guild emojis", () => {
    cache.set("guild1", makeEmojis());
    cache.set("guild1", [{ name: "new", id: "444", animated: false }]);
    const updated = cache.get("guild1");
    expect(updated).toEqual([{ name: "new", id: "444", animated: false }]);
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
    const now = Date.now();
    setSystemTime(now);
    cache.set("guild1", makeEmojis());
    setSystemTime(now + 120_000);
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
