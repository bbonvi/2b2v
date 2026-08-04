import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  EmojiCache,
  buildEmojiContext,
  resolveGuildEmoji,
  type EmojiEntry,
} from "./emoji-cache.ts";
import { Collection, type Client, type Guild, type GuildEmoji } from "discord.js";

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

describe("resolveGuildEmoji", () => {
  test("prefers the destination guild, then resolves from another guild", () => {
    const localWave = { name: "wave", id: "111", animated: false } as GuildEmoji;
    const remoteWave = { name: "wave", id: "222", animated: true } as GuildEmoji;
    const remoteDance = { name: "dance", id: "333", animated: true } as GuildEmoji;
    const destinationGuild = {
      emojis: { cache: new Collection([[localWave.id, localWave]]) },
    } as unknown as Guild;
    const client = {
      emojis: { cache: new Collection([
        [remoteWave.id, remoteWave],
        [remoteDance.id, remoteDance],
        [localWave.id, localWave],
      ]) },
    } as unknown as Client;

    expect(resolveGuildEmoji(client, destinationGuild, "wave")).toEqual({ id: "111", animated: false });
    expect(resolveGuildEmoji(client, destinationGuild, "dance")).toEqual({ id: "333", animated: true });
    expect(resolveGuildEmoji(client, destinationGuild, "missing")).toBeUndefined();
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
