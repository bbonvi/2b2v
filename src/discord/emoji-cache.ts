import type { Client, Guild } from "discord.js";

/** Per-guild custom emoji cache for model context and tool output. */

export interface EmojiEntry {
  name: string;
  id: string;
  animated: boolean;
}

interface CacheEntry {
  emojis: EmojiEntry[];
  updatedAt: number;
}

export class EmojiCache {
  private guilds = new Map<string, CacheEntry>();

  set(guildId: string, emojis: EmojiEntry[]): void {
    this.guilds.set(guildId, { emojis, updatedAt: Date.now() });
  }

  get(guildId: string): EmojiEntry[] | undefined {
    return this.guilds.get(guildId)?.emojis;
  }

  clear(guildId: string): void {
    this.guilds.delete(guildId);
  }

  /** Returns true if the guild has no cached emojis or the cache is older than ttlMs. */
  isStale(guildId: string, ttlMs: number): boolean {
    const entry = this.guilds.get(guildId);
    if (!entry) return true;
    return Date.now() - entry.updatedAt > ttlMs;
  }
}

/** Resolve from the destination guild first, then any other guild available to the bot. */
export function resolveGuildEmoji(
  client: Client,
  destinationGuild: Guild,
  name: string,
): Pick<EmojiEntry, "id" | "animated"> | undefined {
  const emoji = destinationGuild.emojis.cache.find((candidate) => candidate.name === name)
    ?? client.emojis.cache.find((candidate) => candidate.name === name);
  return emoji === undefined ? undefined : { id: emoji.id, animated: emoji.animated };
}

/**
 * Build emoji context string for LLM consumption.
 * Format: `:emoji_name: — description` per line.
 */
export function buildEmojiContext(emojis: EmojiEntry[]): string {
  if (emojis.length === 0) return "";
  return emojis
    .map((e) => `:${e.name}: — custom emoji${e.animated ? " (animated)" : ""}`)
    .join("\n");
}
