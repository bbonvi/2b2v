import type { Database } from "./database";

import { rebalanceContext } from "./message-history-repository";

import type { AssetKind } from "./asset-repository.ts";

export interface MessageSearchFilter {
  guildId: string;
  userId?: string;
  channelId?: string;
  /** Restrict search to channels already authorized by the caller. */
  channelIds?: readonly string[];
  /** Epoch ms — only messages after this timestamp. */
  after?: number;
  /** Epoch ms — only messages before this timestamp. */
  before?: number;
  /** Message IDs already present in the prompt context and therefore not useful to return. */
  excludeIds?: readonly string[];
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
}

export interface SearchMessageMatch {
  guildId: string;
  channelId: string;
  messageId: string;
  createdAt: number;
}

export interface SearchMessageCandidate extends SearchMessageMatch {
  content: string;
  assetSearchText: string;
}

export interface MessageSearchCursor {
  messageId: string;
  createdAt: number;
}

export interface SearchMessageCandidatesFilter {
  guildId?: string;
  channelId?: string;
  channelIds?: readonly string[];
  username?: string;
  userId?: string;
  assetId?: number;
  hasAssets?: boolean;
  assetKind?: AssetKind;
  after?: number;
  before?: number;
  cursor?: MessageSearchCursor;
  limit?: number;
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


export function findMessageSearchCandidates(
  db: Database,
  filter: SearchMessageCandidatesFilter,
): SearchMessageCandidate[] {
  if (filter.channelIds !== undefined && filter.channelIds.length === 0) return [];
  const conditions = [
    "m.is_synthetic = 0",
    "m.is_prompt_only = 0",
    "m.deleted_at IS NULL",
  ];
  const params: Array<string | number> = [];
  if (filter.guildId !== undefined) {
    conditions.unshift("m.guild_id = ?");
    params.push(filter.guildId);
  }
  if (filter.channelId !== undefined) {
    conditions.push("m.channel_id = ?");
    params.push(filter.channelId);
  }
  if (filter.channelIds !== undefined) {
    conditions.push(`m.channel_id IN (${filter.channelIds.map(() => "?").join(",")})`);
    params.push(...filter.channelIds);
  }
  if (filter.username !== undefined) {
    conditions.push("m.author_username = ? COLLATE NOCASE");
    params.push(filter.username);
  }
  if (filter.userId !== undefined) {
    conditions.push("m.user_id = ?");
    params.push(filter.userId);
  }
  if (filter.after !== undefined) {
    conditions.push("m.created_at > ?");
    params.push(filter.after);
  }
  if (filter.before !== undefined) {
    conditions.push("m.created_at < ?");
    params.push(filter.before);
  }
  if (filter.cursor !== undefined) {
    conditions.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
    params.push(filter.cursor.createdAt, filter.cursor.createdAt, filter.cursor.messageId);
  }
  if (filter.assetId !== undefined) {
    conditions.push("EXISTS (SELECT 1 FROM message_assets a WHERE a.message_id = m.id AND a.id = ?)");
    params.push(filter.assetId);
  }
  if (filter.hasAssets !== undefined) {
    conditions.push(`${filter.hasAssets ? "" : "NOT "}EXISTS (SELECT 1 FROM message_assets a WHERE a.message_id = m.id)`);
  }
  if (filter.assetKind !== undefined) {
    conditions.push("EXISTS (SELECT 1 FROM message_assets a WHERE a.message_id = m.id AND a.kind = ?)");
    params.push(filter.assetKind);
  }
  const limitClause = filter.limit === undefined ? "" : " LIMIT ?";
  if (filter.limit !== undefined) params.push(filter.limit);
  const rows = db.raw.prepare(`SELECT m.id, m.guild_id, m.channel_id, m.translated_content, m.created_at,
      COALESCE((SELECT GROUP_CONCAT(COALESCE(a.filename, '') || CHAR(31) || COALESCE(a.content_type, ''), CHAR(30))
        FROM message_assets a WHERE a.message_id = m.id), '') AS asset_search_text
    FROM messages m
    WHERE ${conditions.join(" AND ")}
    ORDER BY m.created_at DESC, m.id DESC${limitClause}`).all(...params) as Array<{
      id: string;
      guild_id: string;
      channel_id: string;
      translated_content: string;
      created_at: number;
      asset_search_text: string;
    }>;
  return rows.map((row) => ({
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.id,
    content: row.translated_content,
    assetSearchText: row.asset_search_text,
    createdAt: row.created_at,
  }));
}

/** Resolve one stable message ID to its chronological search position. */
export function getMessageSearchCursor(db: Database, messageId: string): MessageSearchCursor | null {
  const row = db.raw.prepare("SELECT id, created_at FROM messages WHERE id = ?")
    .get(messageId) as { id: string; created_at: number } | null;
  return row === null ? null : { messageId: row.id, createdAt: row.created_at };
}

/** Resolve matched message IDs to locations while preserving match order. */
export function getMessageSearchMatchesByIds(db: Database, messageIds: readonly string[]): SearchMessageMatch[] {
  if (messageIds.length === 0) return [];
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = db.raw.prepare(
    `SELECT id, guild_id, channel_id, created_at FROM messages WHERE id IN (${placeholders})`,
  ).all(...messageIds) as Array<{
    id: string;
    guild_id: string;
    channel_id: string;
    created_at: number;
  }>;
  const byId = new Map(rows.map((row) => [row.id, {
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.id,
    createdAt: row.created_at,
  }]));
  return messageIds.flatMap((messageId) => {
    const match = byId.get(messageId);
    return match === undefined ? [] : [match];
  });
}


function toMessageSearchResult(row: MessageSearchRow): MessageSearchResult {
  return {
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id,
    authorUsername: row.author_username,
    translatedContent: row.translated_content,
    createdAt: row.created_at,
    replyToId: row.reply_to_id,
  };
}

/** Return the latest visible message activity before a known message/time. */

function queryVisibleMessages(
  db: Database,
  sql: string,
  params: Array<string | number>,
): MessageSearchResult[] {
  const rows = db.raw.prepare(sql).all(...params) as MessageSearchRow[];
  return rows.map((row) => toMessageSearchResult(row));
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
 * Pure SQLite lookup.
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

export function searchMessagesLiteral(
  db: Database,
  query: string,
  filter: MessageSearchFilter,
): MessageSearchResult[] {
  if (filter.channelIds !== undefined && filter.channelIds.length === 0) return [];
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
  conditions.push("deleted_at IS NULL");
  conditions.push("TRIM(translated_content) <> ''");

  conditions.push("translated_content LIKE ? ESCAPE '\\'");
  params.push(pattern);

  if (filter.channelId !== undefined) {
    conditions.push("channel_id = ?");
    params.push(filter.channelId);
  }
  if (filter.channelIds !== undefined) {
    conditions.push(`channel_id IN (${filter.channelIds.map(() => "?").join(",")})`);
    params.push(...filter.channelIds);
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
  }));
}

/**
 * Fetch parent channel messages before a timestamp for thread pre-context.
 * Used to show recent parent chat activity when the bot is responding in a thread.
 *
 * Returns messages in chronological order (oldest first), excludes synthetic events.
 */

