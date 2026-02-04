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
}

export interface CreateThreadInput {
  threadId: string;
  guildId: string;
  parentChatId: string;
  starterMessageId: string;
  threadName: string;
}

export interface UpdateThreadActivityInput {
  lastActivityAt: number;
  lastMessageId: string;
}

/** Insert a new thread record. bot_participating starts as false. */
export function insertThread(db: Database, input: CreateThreadInput): void {
  const now = Date.now();
  db.raw
    .prepare(
      `INSERT INTO threads (thread_id, guild_id, parent_chat_id, starter_message_id, thread_name, created_at, last_activity_at, message_count, bot_participating)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.threadId,
      input.guildId,
      input.parentChatId,
      input.starterMessageId,
      input.threadName,
      now,
      now,
      0,
      0
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
 * Update thread activity: increment message_count, update last_activity_at and last_message_id.
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
         last_message_id = ?
       WHERE thread_id = ?`
    )
    .run(input.lastActivityAt, input.lastMessageId, threadId);
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

/** Thread info for context assembly (limited fields). */
export interface ThreadContextInfo {
  threadId: string;
  threadName: string;
  messageCount: number;
  lastActivityAt: number;
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
       FROM threads
       WHERE parent_chat_id = ? AND bot_participating = 1
       ORDER BY last_activity_at DESC
       LIMIT ?`
    )
    .all(parentChatId, limit) as Array<{
      thread_id: string;
      thread_name: string;
      message_count: number;
      last_activity_at: number;
    }>;

  return rows.map((r) => ({
    threadId: r.thread_id,
    threadName: r.thread_name,
    messageCount: r.message_count,
    lastActivityAt: r.last_activity_at,
  }));
}

/**
 * Get thread metadata for thread context assembly.
 * Returns null if thread not found.
 */
export function getThreadMetadata(
  db: Database,
  threadId: string
): { parentChatId: string; starterMessageId: string; threadName: string; createdAt: number } | null {
  const row = db.raw
    .prepare("SELECT parent_chat_id, starter_message_id, thread_name, created_at FROM threads WHERE thread_id = ?")
    .get(threadId) as {
      parent_chat_id: string;
      starter_message_id: string;
      thread_name: string;
      created_at: number;
    } | null;

  if (row === null) return null;
  return {
    parentChatId: row.parent_chat_id,
    starterMessageId: row.starter_message_id,
    threadName: row.thread_name,
    createdAt: row.created_at,
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
  };
}
