import type { Database } from "./database";

export interface ThreadRow {
  threadId: string;
  guildId: string;
  parentChatId: string;
  starterMessageId: string;
  threadName: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  lastMessageId: string | null;
  botParticipating: boolean;
  createdByBot: boolean;
  archivedAt: number | null;
}

export interface CreateThreadInput {
  threadId: string;
  guildId: string;
  parentChatId: string;
  starterMessageId: string;
  threadName: string;
  createdByBot?: boolean;
  createdAt?: number;
  lastActivityAt?: number;
  messageCount?: number;
  lastMessageId?: string | null;
  botParticipating?: boolean;
  archivedAt?: number | null;
}

export interface UpdateThreadActivityInput {
  lastActivityAt: number;
  lastMessageId: string;
  archivedAt?: number | null;
}

/** Insert a new thread record. bot_participating starts as false. */
export function insertThread(db: Database, input: CreateThreadInput): void {
  const now = input.createdAt ?? Date.now();
  db.raw
    .prepare(
      `INSERT INTO threads (thread_id, guild_id, parent_chat_id, starter_message_id, thread_name, created_at, last_activity_at, message_count, last_message_id, bot_participating, created_by_bot, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.threadId,
      input.guildId,
      input.parentChatId,
      input.starterMessageId,
      input.threadName,
      now,
      input.lastActivityAt ?? now,
      input.messageCount ?? 0,
      input.lastMessageId ?? null,
      input.botParticipating === true ? 1 : 0,
      input.createdByBot === false ? 0 : 1,
      input.archivedAt ?? null
    );
}

/** Upsert live or bot-created thread metadata without losing participation or ownership state. */
export function upsertThread(db: Database, input: CreateThreadInput): void {
  const now = Date.now();
  const createdAt = input.createdAt ?? now;
  const lastActivityAt = input.lastActivityAt ?? createdAt;
  db.raw
    .prepare(
      `INSERT INTO threads (
         thread_id, guild_id, parent_chat_id, starter_message_id, thread_name,
         created_at, last_activity_at, message_count, last_message_id,
         bot_participating, created_by_bot, archived_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         guild_id = excluded.guild_id,
         parent_chat_id = excluded.parent_chat_id,
         starter_message_id = excluded.starter_message_id,
         thread_name = excluded.thread_name,
         created_at = MIN(threads.created_at, excluded.created_at),
         last_activity_at = MAX(threads.last_activity_at, excluded.last_activity_at),
         message_count = MAX(threads.message_count, excluded.message_count),
         last_message_id = COALESCE(excluded.last_message_id, threads.last_message_id),
         bot_participating = CASE WHEN threads.bot_participating = 1 OR excluded.bot_participating = 1 THEN 1 ELSE 0 END,
         created_by_bot = CASE WHEN threads.created_by_bot = 1 OR excluded.created_by_bot = 1 THEN 1 ELSE 0 END,
         archived_at = excluded.archived_at`
    )
    .run(
      input.threadId,
      input.guildId,
      input.parentChatId,
      input.starterMessageId,
      input.threadName,
      createdAt,
      lastActivityAt,
      input.messageCount ?? 0,
      input.lastMessageId ?? null,
      input.botParticipating === true ? 1 : 0,
      input.createdByBot === true ? 1 : 0,
      input.archivedAt ?? null
    );
}

/** Get a thread by ID. Returns null if not found. */
export function getThread(db: Database, threadId: string): ThreadRow | null {
  const row = db.raw
    .prepare("SELECT * FROM threads WHERE thread_id = ?")
    .get(threadId) as Record<string, unknown> | null;
  if (row === null) return null;
  return mapRow(row);
}

/**
 * Update thread activity: increment message_count, update last_activity_at, last_message_id,
 * and optionally refresh archived status from live Discord metadata.
 * Returns true if the row existed.
 */
export function updateThreadActivity(
  db: Database,
  threadId: string,
  input: UpdateThreadActivityInput
): boolean {
  const result = db.raw
    .prepare(
      `UPDATE threads SET
         message_count = message_count + 1,
         last_activity_at = ?,
         last_message_id = ?,
         archived_at = CASE WHEN ? = 1 THEN ? ELSE archived_at END
       WHERE thread_id = ?`
    )
    .run(
      input.lastActivityAt,
      input.lastMessageId,
      input.archivedAt !== undefined ? 1 : 0,
      input.archivedAt ?? null,
      threadId
    );
  return result.changes > 0;
}

/**
 * Mark bot_participating = true for a thread.
 * Called after the bot sends its first message in a thread.
 * Returns true if the row existed.
 */
export function markBotParticipating(db: Database, threadId: string): boolean {
  const result = db.raw
    .prepare("UPDATE threads SET bot_participating = 1 WHERE thread_id = ?")
    .run(threadId);
  return result.changes > 0;
}

/** Mark a bot-created thread as archived/closed in local metadata. */
export function markThreadArchived(db: Database, threadId: string, archivedAt = Date.now()): boolean {
  const result = db.raw
    .prepare("UPDATE threads SET archived_at = ? WHERE thread_id = ?")
    .run(archivedAt, threadId);
  return result.changes > 0;
}

/** Thread info for context assembly (limited fields). */
export interface ThreadContextInfo {
  threadId: string;
  threadName: string;
  starterMessageId: string;
  messageCount: number;
  lastActivityAt: number;
  lastMessageId: string | null;
  botParticipating: boolean;
  createdByBot: boolean;
  archivedAt: number | null;
}

/**
 * List bot-participating threads for a parent chat, ordered by last activity DESC.
 * Used for "Threads In This Chat" context section.
 */
export function listThreadsForContext(
  db: Database,
  parentChatId: string,
  limit = 10
): ThreadContextInfo[] {
  const rows = db.raw
    .prepare(
      `SELECT thread_id, thread_name, message_count, last_activity_at
        , starter_message_id, last_message_id, bot_participating, created_by_bot, archived_at
       FROM threads
       WHERE parent_chat_id = ? AND (bot_participating = 1 OR created_by_bot = 1)
       ORDER BY last_activity_at DESC
       LIMIT ?`
    )
    .all(parentChatId, limit) as Array<{
      thread_id: string;
      thread_name: string;
      starter_message_id: string;
      message_count: number;
      last_activity_at: number;
      last_message_id: string | null;
      bot_participating: number;
      created_by_bot: number;
      archived_at: number | null;
    }>;

  return rows.map((r) => ({
    threadId: r.thread_id,
    threadName: r.thread_name,
    starterMessageId: r.starter_message_id,
    messageCount: r.message_count,
    lastActivityAt: r.last_activity_at,
    lastMessageId: r.last_message_id,
    botParticipating: r.bot_participating === 1,
    createdByBot: r.created_by_bot === 1,
    archivedAt: r.archived_at,
  }));
}

/**
 * Get thread metadata for thread context assembly.
 * Returns null if thread not found.
 */
export function getThreadMetadata(
  db: Database,
  threadId: string
): { parentChatId: string; starterMessageId: string; threadName: string; createdAt: number; createdByBot: boolean; archivedAt: number | null } | null {
  const row = db.raw
    .prepare("SELECT parent_chat_id, starter_message_id, thread_name, created_at, created_by_bot, archived_at FROM threads WHERE thread_id = ?")
    .get(threadId) as {
      parent_chat_id: string;
      starter_message_id: string;
      thread_name: string;
      created_at: number;
      created_by_bot: number;
      archived_at: number | null;
    } | null;

  if (row === null) return null;
  return {
    parentChatId: row.parent_chat_id,
    starterMessageId: row.starter_message_id,
    threadName: row.thread_name,
    createdAt: row.created_at,
    createdByBot: row.created_by_bot === 1,
    archivedAt: row.archived_at,
  };
}

function mapRow(row: Record<string, unknown>): ThreadRow {
  return {
    threadId: row.thread_id as string,
    guildId: row.guild_id as string,
    parentChatId: row.parent_chat_id as string,
    starterMessageId: row.starter_message_id as string,
    threadName: row.thread_name as string,
    createdAt: row.created_at as number,
    lastActivityAt: row.last_activity_at as number,
    messageCount: row.message_count as number,
    lastMessageId: row.last_message_id as string | null,
    botParticipating: (row.bot_participating as number) === 1,
    createdByBot: (row.created_by_bot as number) === 1,
    archivedAt: row.archived_at as number | null,
  };
}
