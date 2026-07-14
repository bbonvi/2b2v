import type { Database } from "./database";
import type { HistoryMessage } from "../agent/history-types";

export interface MemoryExtractionCheckpoint {
  guildId: string;
  channelId: string;
  lastMessageId: string | null;
  lastMessageCreatedAt: number;
  lastRunAt: number;
}

interface CheckpointRow {
  guild_id: string;
  channel_id: string;
  last_message_id: string | null;
  last_message_created_at: number;
  last_run_at: number;
}

interface MessageCursor {
  id: string;
  created_at: number;
}

/**
 * Read the ambient memory checkpoint for one channel.
 * Missing rows mean no successful memory pass has reset the channel timer yet.
 */
export function getMemoryExtractionCheckpoint(
  db: Database,
  guildId: string,
  channelId: string,
): MemoryExtractionCheckpoint | null {
  const row = db.raw
    .prepare(
      `SELECT guild_id, channel_id, last_message_id, last_message_created_at, last_run_at
       FROM memory_extraction_checkpoints
       WHERE guild_id = ? AND channel_id = ?`,
    )
    .get(guildId, channelId) as CheckpointRow | null;

  return row === null ? null : {
    guildId: row.guild_id,
    channelId: row.channel_id,
    lastMessageId: row.last_message_id,
    lastMessageCreatedAt: row.last_message_created_at,
    lastRunAt: row.last_run_at,
  };
}

/**
 * Reset the ambient memory timer to a persisted message.
 * The row is ignored if the message is absent or belongs to another guild/channel.
 */
export function markMemoryExtractionCheckpointAtMessage(
  db: Database,
  input: {
    guildId: string;
    channelId: string;
    messageId: string;
    now?: number;
  },
): boolean {
  const message = db.raw
    .prepare(
      `SELECT id, created_at
       FROM messages
       WHERE id = ? AND guild_id = ? AND channel_id = ?`,
    )
    .get(input.messageId, input.guildId, input.channelId) as MessageCursor | null;
  if (message === null) return false;

  markMemoryExtractionCheckpoint(db, {
    guildId: input.guildId,
    channelId: input.channelId,
    lastMessageId: message.id,
    lastMessageCreatedAt: message.created_at,
    now: input.now,
  });
  return true;
}

/**
 * Reset the ambient memory timer to a known channel message cursor.
 */
export function markMemoryExtractionCheckpoint(
  db: Database,
  input: {
    guildId: string;
    channelId: string;
    lastMessageId: string;
    lastMessageCreatedAt: number;
    now?: number;
  },
): void {
  db.raw
    .prepare(
      `INSERT INTO memory_extraction_checkpoints
         (guild_id, channel_id, last_message_id, last_message_created_at, last_run_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, channel_id) DO UPDATE SET
         last_message_id = excluded.last_message_id,
         last_message_created_at = excluded.last_message_created_at,
         last_run_at = excluded.last_run_at`,
    )
    .run(
      input.guildId,
      input.channelId,
      input.lastMessageId,
      input.lastMessageCreatedAt,
      input.now ?? Date.now(),
    );
}

function checkpointFilter(checkpoint: MemoryExtractionCheckpoint | null): string {
  if (checkpoint === null || checkpoint.lastMessageId === null) return "";
  return "AND (created_at > ? OR (created_at = ? AND id > ?))";
}

function checkpointParams(checkpoint: MemoryExtractionCheckpoint | null): Array<string | number> {
  if (checkpoint === null || checkpoint.lastMessageId === null) return [];
  return [checkpoint.lastMessageCreatedAt, checkpoint.lastMessageCreatedAt, checkpoint.lastMessageId];
}

/**
 * Count human, non-synthetic messages since the last successful memory pass.
 */
export function countMessagesSinceMemoryExtraction(
  db: Database,
  input: {
    guildId: string;
    channelId: string;
    checkpoint: MemoryExtractionCheckpoint | null;
  },
): number {
  const row = db.raw
    .prepare(
      `SELECT COUNT(*) AS count
       FROM messages
       WHERE guild_id = ?
         AND channel_id = ?
         AND is_bot = 0
         AND is_synthetic = 0
         AND deleted_at IS NULL
         AND TRIM(translated_content) <> ''
         ${checkpointFilter(input.checkpoint)}`,
    )
    .get(input.guildId, input.channelId, ...checkpointParams(input.checkpoint)) as { count: number } | null;
  return row?.count ?? 0;
}

/**
 * Fetch the chronological ambient extraction batch after the current checkpoint.
 */
export function getMessagesSinceMemoryExtraction(
  db: Database,
  input: {
    guildId: string;
    channelId: string;
    checkpoint: MemoryExtractionCheckpoint | null;
    limit: number;
  },
): HistoryMessage[] {
  const rows = db.raw
    .prepare(
      `SELECT id, author_username, user_id, translated_content, is_bot, created_at, reply_to_id, is_synthetic, related_thread_id
       FROM messages
       WHERE guild_id = ?
         AND channel_id = ?
         AND is_bot = 0
         AND is_synthetic = 0
         AND deleted_at IS NULL
         AND TRIM(translated_content) <> ''
         ${checkpointFilter(input.checkpoint)}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(
      input.guildId,
      input.channelId,
      ...checkpointParams(input.checkpoint),
      input.limit,
    ) as Array<{
      id: string;
      author_username: string;
      user_id: string;
      translated_content: string;
      is_bot: number;
      created_at: number;
      reply_to_id: string | null;
      is_synthetic: number;
      related_thread_id: string | null;
    }>;

  return rows.map((row) => ({
    id: row.id,
    author: row.author_username,
    authorId: row.user_id,
    content: row.translated_content,
    isBot: row.is_bot === 1,
    timestamp: row.created_at,
    replyToId: row.reply_to_id,
    hasEmbeds: false,
    isSynthetic: row.is_synthetic === 1,
    relatedThreadId: row.related_thread_id,
  }));
}
