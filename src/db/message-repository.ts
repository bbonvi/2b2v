import type { Database } from "./database";

export interface MessageSearchFilter {
  guildId: string;
  userId?: string;
  channelId?: string;
  /** Epoch ms — only messages after this timestamp. */
  after?: number;
  /** Epoch ms — only messages before this timestamp. */
  before?: number;
  limit: number;
}

export interface MessageSearchResult {
  id: string;
  channelId: string;
  userId: string;
  authorUsername: string;
  translatedContent: string;
  createdAt: number;
  distance: number;
}

/**
 * Semantic search over message embeddings with metadata filters.
 *
 * Strategy: over-fetch from vec0 KNN (3x limit), then post-filter via
 * JOIN on the messages table. vec0 cannot apply WHERE on joined columns
 * during KNN scan, so over-fetching compensates for rows eliminated by filters.
 */
export function searchMessages(
  db: Database,
  queryVec: Float32Array,
  filter: MessageSearchFilter,
): MessageSearchResult[] {
  const overfetch = filter.limit * 3;

  // Phase 1: KNN candidates from vec0
  const candidates = db.raw
    .prepare(
      `SELECT message_id, distance
       FROM message_embeddings
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`
    )
    .all(queryVec, overfetch) as Array<{ message_id: string; distance: number }>;

  if (candidates.length === 0) return [];

  // Phase 2: filter via messages table
  const placeholders = candidates.map(() => "?").join(",");
  const conditions = [`m.id IN (${placeholders})`, "m.guild_id = ?"];
  const params: unknown[] = [...candidates.map((c) => c.message_id), filter.guildId];

  if (filter.userId !== undefined) {
    conditions.push("m.user_id = ?");
    params.push(filter.userId);
  }
  if (filter.channelId !== undefined) {
    conditions.push("m.channel_id = ?");
    params.push(filter.channelId);
  }
  if (filter.after !== undefined) {
    conditions.push("m.created_at > ?");
    params.push(filter.after);
  }
  if (filter.before !== undefined) {
    conditions.push("m.created_at < ?");
    params.push(filter.before);
  }

  const rows = db.raw
    .prepare(
      `SELECT m.id, m.channel_id, m.user_id, m.author_username, m.translated_content, m.created_at
       FROM messages m
       WHERE ${conditions.join(" AND ")}`
    )
    .all(...params) as Array<{
      id: string;
      channel_id: string;
      user_id: string;
      author_username: string;
      translated_content: string;
      created_at: number;
    }>;

  // Build distance lookup from candidates
  const distMap = new Map(candidates.map((c) => [c.message_id, c.distance]));

  // Merge and sort by distance
  const results: MessageSearchResult[] = rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    userId: r.user_id,
    authorUsername: r.author_username,
    translatedContent: r.translated_content,
    createdAt: r.created_at,
    distance: distMap.get(r.id)!,
  }));

  results.sort((a, b) => a.distance - b.distance);

  return results.slice(0, filter.limit);
}
