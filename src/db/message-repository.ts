import type { Database } from "./database";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { searchPoints } from "../qdrant/adapter";

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
  score: number;
}

/**
 * Semantic search over messages using Qdrant for vector search
 * and SQLite for message metadata retrieval.
 *
 * Qdrant handles KNN + metadata filtering (guild, channel, user, time range).
 * SQLite provides translatedContent and authorUsername for display.
 */
export async function searchMessages(
  db: Database,
  qdrant: QdrantClient,
  queryVec: Float32Array,
  filter: MessageSearchFilter,
): Promise<MessageSearchResult[]> {
  const qdrantResults = await searchPoints(
    qdrant,
    Array.from(queryVec),
    {
      guild_id: filter.guildId,
      channel_id: filter.channelId,
      user_id: filter.userId,
      after: filter.after,
      before: filter.before,
    },
    { type: "message", limit: filter.limit },
  );

  if (qdrantResults.length === 0) return [];

  // Fetch message details from SQLite
  const ids = qdrantResults.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.raw
    .prepare(
      `SELECT id, channel_id, user_id, author_username, translated_content, created_at
       FROM messages
       WHERE id IN (${placeholders})`
    )
    .all(...ids) as Array<{
      id: string;
      channel_id: string;
      user_id: string;
      author_username: string;
      translated_content: string;
      created_at: number;
    }>;

  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const scoreMap = new Map(qdrantResults.map((r) => [r.id, r.score]));

  const results: MessageSearchResult[] = [];
  for (const qr of qdrantResults) {
    const row = rowMap.get(qr.id);
    if (!row) continue; // orphaned Qdrant point — skip
    results.push({
      id: row.id,
      channelId: row.channel_id,
      userId: row.user_id,
      authorUsername: row.author_username,
      translatedContent: row.translated_content,
      createdAt: row.created_at,
      score: scoreMap.get(qr.id) ?? 0,
    });
  }

  return results;
}
