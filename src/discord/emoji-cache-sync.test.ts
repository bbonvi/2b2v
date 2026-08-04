import { describe, expect, test } from "bun:test";
import { Client, Collection, type Guild, type GuildEmoji } from "discord.js";
import { EmojiCache, type EmojiEntry } from "./emoji-cache.ts";
import { registerEmojiCacheSync } from "./emoji-cache-sync.ts";

function makeGuild(id: string, entries: EmojiEntry[]): Guild {
  const emojis = new Collection(
    entries.map((entry) => [entry.id, entry as unknown as GuildEmoji]),
  );
  return { id, emojis: { cache: emojis } } as unknown as Guild;
}

describe("registerEmojiCacheSync", () => {
  test("synchronizes the application cache after emoji gateway events", () => {
    const client = new Client({ intents: [] });
    const cache = new EmojiCache();
    registerEmojiCacheSync(client, cache);

    const createdGuild = makeGuild("guild1", [
      { name: "old", id: "1", animated: false },
      { name: "new", id: "2", animated: true },
    ]);
    client.emit("emojiCreate", { guild: createdGuild } as unknown as GuildEmoji);
    expect(cache.get("guild1")).toContainEqual({ name: "new", id: "2", animated: true });

    const updatedGuild = makeGuild("guild1", [
      { name: "renamed", id: "2", animated: true },
    ]);
    client.emit(
      "emojiUpdate",
      { guild: createdGuild } as unknown as GuildEmoji,
      { guild: updatedGuild } as unknown as GuildEmoji,
    );
    expect(cache.get("guild1")).not.toContainEqual(expect.objectContaining({ name: "new" }));
    expect(cache.get("guild1")).toContainEqual({ name: "renamed", id: "2", animated: true });

    const deletedGuild = makeGuild("guild1", []);
    client.emit("emojiDelete", { guild: deletedGuild } as unknown as GuildEmoji);
    expect(cache.get("guild1")).toEqual([]);
  });
});
