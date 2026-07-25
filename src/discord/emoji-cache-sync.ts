import type { Client, Guild } from "discord.js";
import type { EmojiCache, EmojiEntry } from "./emoji-cache.ts";

export function guildEmojiEntries(guild: Guild): EmojiEntry[] {
  return guild.emojis.cache.map((emoji) => ({
    name: emoji.name,
    id: emoji.id,
    animated: emoji.animated,
  }));
}

export function syncGuildEmojiCache(cache: EmojiCache, guild: Guild): void {
  cache.set(guild.id, guildEmojiEntries(guild));
}

/** Keep the application emoji snapshot aligned with discord.js gateway updates. */
export function registerEmojiCacheSync(client: Client, cache: EmojiCache): void {
  client.on("emojiCreate", (emoji) => syncGuildEmojiCache(cache, emoji.guild));
  client.on("emojiUpdate", (_oldEmoji, newEmoji) => syncGuildEmojiCache(cache, newEmoji.guild));
  client.on("emojiDelete", (emoji) => syncGuildEmojiCache(cache, emoji.guild));
}
