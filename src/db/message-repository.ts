import type { Database } from "./database";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { searchPoints, type SearchResult } from "../qdrant/adapter";
import type { HistoryMessage } from "../agent/history-types";
import type { TrimConfig } from "../config/types";

export interface DeleteRecentResult {
  messageIds: string[];
  imagePaths: string[];
}

export interface MessageSearchFilter {
  guildId: string;
  userId?: string;
  channelId?: string;
  /** Epoch ms — only messages after this timestamp. */
  after?: number;
  /** Epoch ms — only messages before this timestamp. */
  before?: number;
  /** Message IDs already present in the prompt context and therefore not useful to return. */
  excludeIds?: readonly string[];
  /** Filter bot-authored or human-authored vectors when semantic search can use payloads. */
  isBot?: boolean;
  /** Filter vector source such as live, backfill, or reindex. */
  source?: string;
  /** Filter vector granularity. Merged blocks usually improve semantic recall for chat. */
  embeddingKind?: "single" | "merged";
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
  matchedMessageIds?: string[];
  messageCount?: number;
  embeddingKind?: string;
  source?: string;
}

interface MessageSearchRow {
  id: string;
  channel_id: string;
  user_id: string;
  author_username: string;
  translated_content: string;
  created_at: number;
  reply_to_id: string | null;
}

interface HistoryRow {
  id: string;
  author_username: string;
  user_id: string;
  translated_content: string;
  is_bot: number;
  created_at: number;
  reply_to_id: string | null;
  is_synthetic: number;
  is_prompt_only: number;
  related_thread_id: string | null;
}

function hydrateHistoryRows(db: Database, rows: HistoryRow[]): HistoryMessage[] {
  if (rows.length === 0) return [];

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
      isSynthetic: r.is_synthetic === 1,
      isPromptOnly: r.is_prompt_only === 1,
      relatedThreadId: r.related_thread_id,
    };
  });
}

function messageIdsFromPayload(result: SearchResult): string[] {
  const payload = result.payload;
  if (Array.isArray(payload.message_ids)) return payload.message_ids.filter((id) => id !== "");
  if (payload.message_id !== undefined && payload.message_id !== "") return [payload.message_id];
  return [result.id];
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
  const excludeIds = new Set(filter.excludeIds ?? []);
  const qdrantLimit = Math.min(
    500,
    Math.max(filter.limit * 10, filter.limit + excludeIds.size),
  );
  const qdrantResults = await searchPoints(
    qdrant,
    Array.from(queryVec),
    {
      guild_id: filter.guildId,
      channel_id: filter.channelId,
      user_id: filter.userId,
      after: filter.after,
      before: filter.before,
      is_bot: filter.isBot,
      source: filter.source,
      embedding_kind: filter.embeddingKind,
    },
    { type: "message", limit: qdrantLimit },
  );

  if (qdrantResults.length === 0) return [];

  // Fetch message details from SQLite, excluding synthetic messages (defense-in-depth).
  // Overfetch before filtering so a small search limit does not become empty
  // just because top hits are already visible in the prompt context.
  const candidates = qdrantResults
    .filter((r) => !messageIdsFromPayload(r).some((id) => excludeIds.has(id)));
  if (candidates.length === 0) return [];

  const ids = [...new Set(candidates.flatMap(messageIdsFromPayload))];
  const placeholders = ids.map(() => "?").join(",");
  const rowConditions = [
    `id IN (${placeholders})`,
    "guild_id = ?",
    "is_synthetic = 0",
    "is_prompt_only = 0",
    "TRIM(translated_content) <> ''",
  ];
  const rowParams: Array<string | number> = [...ids, filter.guildId];
  if (filter.channelId !== undefined) {
    rowConditions.push("channel_id = ?");
    rowParams.push(filter.channelId);
  }
  if (filter.userId !== undefined) {
    rowConditions.push("user_id = ?");
    rowParams.push(filter.userId);
  }
  if (filter.after !== undefined) {
    rowConditions.push("created_at > ?");
    rowParams.push(filter.after);
  }
  if (filter.before !== undefined) {
    rowConditions.push("created_at < ?");
    rowParams.push(filter.before);
  }
  const rows = db.raw
    .prepare(
      `SELECT id, channel_id, user_id, author_username, translated_content, created_at, reply_to_id
       FROM messages
       WHERE ${rowConditions.join(" AND ")}`
    )
    .all(...rowParams) as Array<{
      id: string;
      channel_id: string;
      user_id: string;
      author_username: string;
      translated_content: string;
      created_at: number;
      reply_to_id: string | null;
    }>;

  const rowMap = new Map(rows.map((r) => [r.id, r]));

  const results: MessageSearchResult[] = [];
  for (const qr of candidates) {
    const messageIds = messageIdsFromPayload(qr);
    const matchedRows = messageIds
      .map((id) => rowMap.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
    if (matchedRows.length === 0) continue; // orphaned Qdrant point — skip
    const row = matchedRows[0];
    if (row === undefined) continue;
    const content = matchedRows.map((r) => r.translated_content).join("\n");
    results.push({
      id: row.id,
      channelId: row.channel_id,
      userId: row.user_id,
      authorUsername: row.author_username,
      translatedContent: content,
      createdAt: row.created_at,
      replyToId: row.reply_to_id,
      score: qr.score,
      matchedMessageIds: matchedRows.map((r) => r.id),
      messageCount: qr.payload.message_count ?? matchedRows.length,
      embeddingKind: qr.payload.embedding_kind,
      source: qr.payload.source,
    });
    if (results.length >= filter.limit) break;
  }

  return results;
}

function toMessageSearchResult(row: MessageSearchRow, score = 1.0): MessageSearchResult {
  return {
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id,
    authorUsername: row.author_username,
    translatedContent: row.translated_content,
    createdAt: row.created_at,
    replyToId: row.reply_to_id,
    score,
  };
}

function queryVisibleMessages(
  db: Database,
  sql: string,
  params: Array<string | number>,
): MessageSearchResult[] {
  const rows = db.raw.prepare(sql).all(...params) as MessageSearchRow[];
  return rows.map((row) => toMessageSearchResult(row));
}

function rebalanceContext<T>(
  before: T[],
  after: T[],
  beforeTarget: number,
  total: number,
): { before: T[]; after: T[] } {
  const beforeTakeInitial = Math.min(beforeTarget, before.length);
  const afterTarget = total - beforeTakeInitial;
  const afterTake = Math.min(afterTarget, after.length);
  const beforeTake = Math.min(before.length, total - afterTake);

  return {
    before: before.slice(before.length - beforeTake),
    after: after.slice(0, afterTake),
  };
}

function contextBeforeMessage(
  db: Database,
  guildId: string,
  channelId: string,
  createdAt: number,
  messageId: string,
  limit: number,
): MessageSearchResult[] {
  if (limit <= 0) return [];
  const rows = queryVisibleMessages(
    db,
    `SELECT id, channel_id, user_id, author_username, translated_content, created_at, reply_to_id
     FROM messages
     WHERE guild_id = ? AND channel_id = ?
       AND is_synthetic = 0 AND is_prompt_only = 0 AND TRIM(translated_content) <> ''
       AND (created_at < ? OR (created_at = ? AND id < ?))
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [guildId, channelId, createdAt, createdAt, messageId, limit],
  );
  rows.reverse();
  return rows;
}

function contextAfterMessage(
  db: Database,
  guildId: string,
  channelId: string,
  createdAt: number,
  messageId: string,
  limit: number,
): MessageSearchResult[] {
  if (limit <= 0) return [];
  return queryVisibleMessages(
    db,
    `SELECT id, channel_id, user_id, author_username, translated_content, created_at, reply_to_id
     FROM messages
     WHERE guild_id = ? AND channel_id = ?
       AND is_synthetic = 0 AND is_prompt_only = 0 AND TRIM(translated_content) <> ''
       AND (created_at > ? OR (created_at = ? AND id > ?))
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
    [guildId, channelId, createdAt, createdAt, messageId, limit],
  );
}

function contextBeforeTimestamp(
  db: Database,
  guildId: string,
  channelId: string,
  around: number,
  limit: number,
): MessageSearchResult[] {
  if (limit <= 0) return [];
  const rows = queryVisibleMessages(
    db,
    `SELECT id, channel_id, user_id, author_username, translated_content, created_at, reply_to_id
     FROM messages
     WHERE guild_id = ? AND channel_id = ?
       AND is_synthetic = 0 AND is_prompt_only = 0 AND TRIM(translated_content) <> ''
       AND created_at < ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [guildId, channelId, around, limit],
  );
  rows.reverse();
  return rows;
}

function contextAfterTimestamp(
  db: Database,
  guildId: string,
  channelId: string,
  around: number,
  limit: number,
): MessageSearchResult[] {
  if (limit <= 0) return [];
  return queryVisibleMessages(
    db,
    `SELECT id, channel_id, user_id, author_username, translated_content, created_at, reply_to_id
     FROM messages
     WHERE guild_id = ? AND channel_id = ?
       AND is_synthetic = 0 AND is_prompt_only = 0 AND TRIM(translated_content) <> ''
       AND created_at >= ?
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
    [guildId, channelId, around, limit],
  );
}

/**
 * Fetch chronological chat context around a specific message ID.
 *
 * The returned window includes the anchor message and is limited to visible,
 * non-synthetic messages from the anchor's chat.
 */
export function getMessagesAroundMessage(
  db: Database,
  messageId: string,
  filter: { guildId: string; channelId?: string; limit: number },
): MessageSearchResult[] | null {
  const limit = Math.max(1, filter.limit);
  const channelClause = filter.channelId !== undefined ? " AND channel_id = ?" : "";
  const params = filter.channelId !== undefined
    ? [messageId, filter.guildId, filter.channelId]
    : [messageId, filter.guildId];

  const anchor = db.raw
    .prepare(
      `SELECT id, channel_id, user_id, author_username, translated_content, created_at, reply_to_id
       FROM messages
       WHERE id = ? AND guild_id = ?${channelClause}
         AND is_synthetic = 0 AND is_prompt_only = 0 AND TRIM(translated_content) <> ''`
    )
    .get(...params) as MessageSearchRow | null;

  if (anchor === null) return null;

  const sideLimit = limit - 1;
  const before = contextBeforeMessage(db, filter.guildId, anchor.channel_id, anchor.created_at, anchor.id, sideLimit);
  const after = contextAfterMessage(db, filter.guildId, anchor.channel_id, anchor.created_at, anchor.id, sideLimit);
  const { before: keptBefore, after: keptAfter } = rebalanceContext(
    before,
    after,
    Math.floor(sideLimit / 2),
    sideLimit,
  );

  return [...keptBefore, toMessageSearchResult(anchor), ...keptAfter];
}

/**
 * Fetch chronological chat context around a local timestamp in a specific chat.
 *
 * Timestamp context has no exact anchor, so the limit is split across messages
 * before and at/after the timestamp, with spare capacity rebalanced to the
 * other side.
 */
export function getMessagesAroundTimestamp(
  db: Database,
  filter: { guildId: string; channelId: string; around: number; limit: number },
): MessageSearchResult[] {
  const limit = Math.max(1, filter.limit);
  const before = contextBeforeTimestamp(db, filter.guildId, filter.channelId, filter.around, limit);
  const after = contextAfterTimestamp(db, filter.guildId, filter.channelId, filter.around, limit);
  const { before: keptBefore, after: keptAfter } = rebalanceContext(
    before,
    after,
    Math.floor(limit / 2),
    limit,
  );

  return [...keptBefore, ...keptAfter];
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
       WHERE id = ? AND guild_id = ? AND is_prompt_only = 0`
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

  return toMessageSearchResult(row);
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
      `SELECT id, author_username, user_id, translated_content, is_bot, created_at, reply_to_id, is_synthetic, is_prompt_only, related_thread_id
       FROM messages
       WHERE channel_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(channelId, limit) as HistoryRow[];

  // Reverse to chronological order
  rows.reverse();

  return hydrateHistoryRows(db, rows);
}

function chunkedHistoryTakeCount(totalMessages: number, trim: TrimConfig): number {
  if (totalMessages < trim.trimTrigger) return totalMessages;
  const overage = totalMessages - trim.trimTarget;
  const dropCount = Math.floor(overage / trim.windowSize) * trim.windowSize;
  return totalMessages - dropCount;
}

/**
 * Fetch the channel history window for prompt context.
 *
 * Unlike getHistoryMessages(limit), this keeps the oldest included row stable
 * while new messages arrive, and only advances the context window in
 * windowSize chunks. That keeps the cached older-history prompt block from
 * being invalidated on every user reply once a channel is past trimTrigger.
 */
export function getContextHistoryMessages(
  db: Database,
  channelId: string,
  trim: TrimConfig,
  excludeMessageId?: string,
): HistoryMessage[] {
  const excludeClause = excludeMessageId !== undefined ? " AND id != ?" : "";
  const params = excludeMessageId !== undefined ? [channelId, excludeMessageId] : [channelId];
  const countRow = db.raw
    .prepare(`SELECT COUNT(*) AS count FROM messages WHERE channel_id = ?${excludeClause}`)
    .get(...params) as { count: number } | null;
  const totalMessages = countRow?.count ?? 0;
  const takeCount = chunkedHistoryTakeCount(totalMessages, trim);
  if (takeCount <= 0) return [];

  const rows = db.raw
    .prepare(
      `SELECT id, author_username, user_id, translated_content, is_bot, created_at, reply_to_id, is_synthetic, is_prompt_only, related_thread_id
       FROM messages
       WHERE channel_id = ?${excludeClause}
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(...params, takeCount) as HistoryRow[];

  rows.reverse();
  return hydrateHistoryRows(db, rows);
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

  // Exclude synthetic messages (thread creation events, etc.)
  conditions.push("is_synthetic = 0");
  conditions.push("is_prompt_only = 0");
  conditions.push("TRIM(translated_content) <> ''");

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
  if (filter.excludeIds !== undefined && filter.excludeIds.length > 0) {
    const placeholders = filter.excludeIds.map(() => "?").join(",");
    conditions.push(`id NOT IN (${placeholders})`);
    params.push(...filter.excludeIds);
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

/**
 * Fetch parent channel messages before a timestamp for thread pre-context.
 * Used to show recent parent chat activity when the bot is responding in a thread.
 *
 * Returns messages in chronological order (oldest first), excludes synthetic events.
 */
export function getParentPreContext(
  db: Database,
  parentChatId: string,
  beforeTimestamp: number,
  limit: number,
): HistoryMessage[] {
  const rows = db.raw
    .prepare(
      `SELECT id, author_username, user_id, translated_content, is_bot, created_at, reply_to_id, is_synthetic, is_prompt_only, related_thread_id
       FROM messages
       WHERE channel_id = ? AND created_at < ? AND is_synthetic = 0
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(parentChatId, beforeTimestamp, limit) as Array<{
      id: string;
      author_username: string;
      user_id: string;
      translated_content: string;
      is_bot: number;
      created_at: number;
      reply_to_id: string | null;
      is_synthetic: number;
      is_prompt_only: number;
      related_thread_id: string | null;
    }>;

  // Reverse to chronological order (oldest first)
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
      isSynthetic: r.is_synthetic === 1,
      isPromptOnly: r.is_prompt_only === 1,
      relatedThreadId: r.related_thread_id,
    };
  });
}

export interface ChatHistoryRow {
  id: string;
  authorUsername: string;
  content: string;
  createdAt: number;
}

/**
 * Fetch chat history for the chat_history tool.
 * Returns chronological order (oldest first).
 *
 * Note: Includes synthetic events (thread creation, etc.) but excludes
 * prompt-only assistant traces that should be visible only in assembled context.
 */
export function getChatHistory(
  db: Database,
  guildId: string,
  chatId: string,
  limit: number,
): ChatHistoryRow[] {
  const rows = db.raw
    .prepare(
      `SELECT id, author_username, translated_content, created_at
       FROM messages
       WHERE guild_id = ? AND channel_id = ? AND is_prompt_only = 0
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(guildId, chatId, limit) as Array<{
      id: string;
      author_username: string;
      translated_content: string;
      created_at: number;
    }>;

  // Reverse to chronological order (oldest first)
  rows.reverse();

  return rows.map((r) => ({
    id: r.id,
    authorUsername: r.author_username,
    content: r.translated_content,
    createdAt: r.created_at,
  }));
}

export interface InsertSyntheticEventInput {
  /** Unique ID for the synthetic event (e.g., generated UUID). */
  id: string;
  guildId: string;
  /** Parent channel where the event is recorded. */
  channelId: string;
  /** Bot user ID as the author. */
  botUserId: string;
  /** Bot username for display. */
  botUsername: string;
  /** Thread ID this event references. */
  threadId: string;
  /** Thread name for the event content. */
  threadName: string;
}

export interface InsertPromptOnlyBotMessageInput {
  /** Stable row ID; use a deterministic source-derived ID for idempotency. */
  id: string;
  guildId: string;
  channelId: string;
  botUserId: string;
  botUsername: string;
  /** Prompt-rendered assistant content, e.g. <ignore>reason</ignore>. */
  content: string;
  /** User message this prompt-only trace responded to, when available. */
  replyToId?: string | null;
  createdAt?: number;
}

/**
 * Insert a synthetic "Event" row for thread creation.
 * Stored in the parent chat with is_synthetic=1 and related_thread_id set.
 * Never embedded or included in search results.
 */
export function insertSyntheticEvent(db: Database, input: InsertSyntheticEventInput): void {
  const now = Date.now();
  const content = `Event: Thread created — ${input.threadName} (thread_id: ${input.threadId})`;

  db.raw
    .prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, is_synthetic, related_thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.guildId,
      input.channelId,
      input.botUserId,
      input.botUsername,
      content,
      content,
      1,
      now,
      1,
      input.threadId
    );
}

/**
 * Insert a bot-authored row that is visible in prompt history only.
 * Prompt-only rows are never embedded and repository search/tool reads filter them out.
 */
export function insertPromptOnlyBotMessage(db: Database, input: InsertPromptOnlyBotMessageInput): void {
  db.raw
    .prepare(
      `INSERT OR IGNORE INTO messages
         (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id, is_prompt_only)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      input.id,
      input.guildId,
      input.channelId,
      input.botUserId,
      input.botUsername,
      input.content,
      input.content,
      1,
      input.createdAt ?? Date.now(),
      input.replyToId ?? null,
    );
}

/**
 * Delete the N most recent messages from a channel.
 * Returns the deleted message IDs and their associated image file paths
 * for cleanup by the caller (Qdrant points, file system).
 */
export function deleteRecentMessages(
  db: Database,
  channelId: string,
  count: number,
): DeleteRecentResult {
  // Get message IDs (newest first)
  const messageRows = db.raw
    .prepare(
      `SELECT id FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(channelId, count) as Array<{ id: string }>;

  if (messageRows.length === 0) {
    return { messageIds: [], imagePaths: [] };
  }

  const messageIds = messageRows.map((r) => r.id);
  const placeholders = messageIds.map(() => "?").join(",");

  // Get image paths before deletion
  const imageRows = db.raw
    .prepare(`SELECT path FROM images WHERE message_id IN (${placeholders})`)
    .all(...messageIds) as Array<{ path: string }>;

  // Delete images then messages (foreign key order)
  db.raw.prepare(`DELETE FROM images WHERE message_id IN (${placeholders})`).run(...messageIds);
  db.raw.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...messageIds);

  return { messageIds, imagePaths: imageRows.map((r) => r.path) };
}
