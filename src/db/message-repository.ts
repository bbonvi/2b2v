import type { Database } from "./database";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { searchPoints } from "../qdrant/adapter";
import type { HistoryMessage } from "../agent/history-types";

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
  replyToId: string | null;
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
      `SELECT id, channel_id, user_id, author_username, translated_content, created_at, reply_to_id
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
      reply_to_id: string | null;
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
      replyToId: row.reply_to_id,
      score: scoreMap.get(qr.id) ?? 0,
    });
  }

  return results;
}

/**
 * Direct message lookup by ID within a guild.
 * No Qdrant or embedding needed — pure SQLite.
 */
export function getMessageById(
  db: Database,
  messageId: string,
  guildId: string,
): MessageSearchResult | null {
  const row = db.raw
    .prepare(
      `SELECT id, channel_id, user_id, author_username, translated_content, created_at, reply_to_id
       FROM messages
       WHERE id = ? AND guild_id = ?`
    )
    .get(messageId, guildId) as {
      id: string;
      channel_id: string;
      user_id: string;
      author_username: string;
      translated_content: string;
      created_at: number;
      reply_to_id: string | null;
    } | null;

  if (row === null) return null;

  return {
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id,
    authorUsername: row.author_username,
    translatedContent: row.translated_content,
    createdAt: row.created_at,
    replyToId: row.reply_to_id,
    score: 1.0,
  };
}

/**
 * Fetch recent messages from a channel as HistoryMessage[], suitable for the
 * history processing pipeline.
 *
 * Two-query strategy: messages first, then batch image lookup.
 * Returns chronological order (oldest first).
 */
export function getHistoryMessages(
  db: Database,
  channelId: string,
  limit: number,
): HistoryMessage[] {
  const rows = db.raw
    .prepare(
      `SELECT id, author_username, user_id, translated_content, is_bot, created_at, reply_to_id
       FROM messages
       WHERE channel_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(channelId, limit) as Array<{
      id: string;
      author_username: string;
      user_id: string;
      translated_content: string;
      is_bot: number;
      created_at: number;
      reply_to_id: string | null;
    }>;

  // Reverse to chronological order
  rows.reverse();

  if (rows.length === 0) return [];

  // Batch fetch images for all messages
  const messageIds = rows.map((r) => r.id);
  const placeholders = messageIds.map(() => "?").join(",");
  const imageRows = db.raw
    .prepare(
      `SELECT message_id, id, caption
       FROM images
       WHERE message_id IN (${placeholders})
       ORDER BY id ASC`
    )
    .all(...messageIds) as Array<{
      message_id: string;
      id: number;
      caption: string | null;
    }>;

  // Group images by message_id
  const imageMap = new Map<string, Array<{ id: number; caption: string | null }>>();
  for (const img of imageRows) {
    let arr = imageMap.get(img.message_id);
    if (arr === undefined) {
      arr = [];
      imageMap.set(img.message_id, arr);
    }
    arr.push({ id: img.id, caption: img.caption });
  }

  return rows.map((r) => {
    const images = imageMap.get(r.id) ?? [];
    return {
      id: r.id,
      author: r.author_username,
      authorId: r.user_id,
      content: r.translated_content,
      isBot: r.is_bot === 1,
      timestamp: r.created_at,
      replyToId: r.reply_to_id,
      imageIds: images.map((i) => i.id),
      captions: images.map((i) => i.caption ?? ""),
      hasEmbeds: false,
    };
  });
}

/**
 * Literal keyword/phrase search over messages using SQLite LIKE.
 * Case-insensitive substring match. No Qdrant or embedding needed.
 * Results ordered by created_at ASC (chronological reading order).
 */
export function searchMessagesLiteral(
  db: Database,
  query: string,
  filter: MessageSearchFilter,
): MessageSearchResult[] {
  // Escape LIKE special characters, then wrap in % for substring match
  const escaped = query
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  const pattern = `%${escaped}%`;

  const conditions: string[] = ["guild_id = ?"];
  const params: (string | number)[] = [filter.guildId];

  conditions.push("translated_content LIKE ? ESCAPE '\\'");
  params.push(pattern);

  if (filter.channelId !== undefined) {
    conditions.push("channel_id = ?");
    params.push(filter.channelId);
  }
  if (filter.userId !== undefined) {
    conditions.push("user_id = ?");
    params.push(filter.userId);
  }
  if (filter.after !== undefined) {
    conditions.push("created_at > ?");
    params.push(filter.after);
  }
  if (filter.before !== undefined) {
    conditions.push("created_at < ?");
    params.push(filter.before);
  }

  const sql = `SELECT id, channel_id, user_id, author_username, translated_content, created_at, reply_to_id
    FROM messages
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at ASC
    LIMIT ?`;
  params.push(filter.limit);

  const rows = db.raw.prepare(sql).all(...params) as Array<{
    id: string;
    channel_id: string;
    user_id: string;
    author_username: string;
    translated_content: string;
    created_at: number;
    reply_to_id: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id,
    authorUsername: row.author_username,
    translatedContent: row.translated_content,
    createdAt: row.created_at,
    replyToId: row.reply_to_id,
    score: 1.0,
  }));
}
