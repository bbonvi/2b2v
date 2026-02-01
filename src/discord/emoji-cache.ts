/**
 * Per-guild custom emoji cache with TTL-based staleness detection.
 * Provides emoji lookup for outbound translation and context generation for LLM.
 */

export interface EmojiEntry {
  name: string;
  id: string;
  animated: boolean;
}

interface CacheEntry {
  emojis: EmojiEntry[];
  /** Map of emoji name → entry for O(1) lookup. */
  byName: Map<string, EmojiEntry>;
  updatedAt: number;
}

export class EmojiCache {
  private guilds = new Map<string, CacheEntry>();

  set(guildId: string, emojis: EmojiEntry[]): void {
    const byName = new Map<string, EmojiEntry>();
    for (const e of emojis) byName.set(e.name, e);
    this.guilds.set(guildId, { emojis, byName, updatedAt: Date.now() });
  }

  get(guildId: string): EmojiEntry[] | undefined {
    return this.guilds.get(guildId)?.emojis;
  }

  /** Fast name-based lookup for outbound translation. */
  lookup(
    guildId: string,
    name: string
  ): { id: string; animated: boolean } | undefined {
    const entry = this.guilds.get(guildId)?.byName.get(name);
    if (!entry) return undefined;
    return { id: entry.id, animated: entry.animated };
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

  /** Test helper — backdate the cache timestamp. */
  _setTimestamp(guildId: string, ts: number): void {
    const entry = this.guilds.get(guildId);
    if (entry) entry.updatedAt = ts;
  }
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
