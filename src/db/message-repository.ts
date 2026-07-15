import type { Database } from "./database";
import type { HistoryMessage } from "../agent/history-types";
import type { TrimConfig } from "../config/types";
import type { AssetKind, AssetSourceKind } from "./asset-repository.ts";
import type { HistoryAsset } from "../agent/history-types.ts";

export interface DeleteRecentResult {
  messageIds: string[];
}

export interface StoredBotMessageState {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  authorUsername: string;
  translatedContent: string;
  createdAt: number;
  replyToId: string | null;
}

export interface RoutedMessageSource {
  routedFromGuildId: string;
  routedFromChannelId: string;
  routedFromMessageId: string;
}

export interface UpsertBotMessageContentInput {
  id: string;
  guildId: string;
  channelId: string;
  botUserId: string;
  botUsername: string;
  rawContent: string;
  translatedContent: string;
  createdAt: number;
  replyToId: string | null;
  routedFrom?: RoutedMessageSource | null;
}

export interface DeleteBotMessageStateResult {
  deleted: boolean;
}

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

export interface SearchMessageCandidate {
  guildId: string;
  channelId: string;
  messageId: string;
  content: string;
  assetSearchText: string;
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
  limit?: number;
}

export interface MessageActivity {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  authorUsername: string;
  createdAt: number;
  isBot: boolean;
}

export interface ChannelActivityBucket {
  bucketIndex: number;
  messageCount: number;
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
  deleted_at: number | null;
  related_thread_id: string | null;
}

interface ReactionRow {
  message_id: string;
  emoji_label: string;
  count: number;
}

function hydrateHistoryRows(db: Database, rows: HistoryRow[]): HistoryMessage[] {
  if (rows.length === 0) return [];

  const messageIds = rows.map((r) => r.id);
  const placeholders = messageIds.map(() => "?").join(",");
  const assetRows = db.raw.prepare(`SELECT message_id, id, kind, source_kind, filename, content_type, size, width, height, duration_seconds,
      (SELECT job_id FROM agent_job_assets WHERE asset_id = message_assets.id ORDER BY job_id LIMIT 1) AS job_id
    FROM message_assets WHERE message_id IN (${placeholders}) ORDER BY id ASC`).all(...messageIds) as Array<{
      message_id: string; id: number; kind: AssetKind;
      source_kind: AssetSourceKind; filename: string | null;
      content_type: string | null; size: number | null; width: number | null; height: number | null; duration_seconds: number | null;
      job_id: string | null;
    }>;
  const assetMap = new Map<string, HistoryAsset[]>();
  for (const asset of assetRows) {
    const values = assetMap.get(asset.message_id) ?? [];
    values.push({ id: asset.id, kind: asset.kind, sourceKind: asset.source_kind, filename: asset.filename,
      contentType: asset.content_type, size: asset.size, width: asset.width, height: asset.height, durationSeconds: asset.duration_seconds,
      ...(asset.job_id !== null ? { jobId: asset.job_id } : {}) });
    assetMap.set(asset.message_id, values);
  }

  const reactionRows = db.raw
    .prepare(
      `SELECT message_id, emoji_label, count
       FROM message_reactions
       WHERE message_id IN (${placeholders}) AND count > 0
       ORDER BY count DESC, emoji_label COLLATE NOCASE ASC`
    )
    .all(...messageIds) as ReactionRow[];

  const reactionMap = new Map<string, string[]>();
  for (const reaction of reactionRows) {
    let arr = reactionMap.get(reaction.message_id);
    if (arr === undefined) {
      arr = [];
      reactionMap.set(reaction.message_id, arr);
    }
    arr.push(`${reaction.emoji_label}:${reaction.count}`);
  }

  return rows.map((r) => {
    const assets = assetMap.get(r.id) ?? [];
    return {
      id: r.id,
      author: r.author_username,
      authorId: r.user_id,
      content: r.translated_content,
      isBot: r.is_bot === 1,
      timestamp: r.created_at,
      replyToId: r.reply_to_id,
      ...(assets.length > 0 ? { assets } : {}),
      hasEmbeds: false,
      isSynthetic: r.is_synthetic === 1,
      isPromptOnly: r.is_prompt_only === 1,
      isDeleted: r.deleted_at !== null,
      relatedThreadId: r.related_thread_id,
      reactions: reactionMap.get(r.id)?.join(" "),
    };
  });
}

/** Hydrate stored messages by ID while preserving caller order. */
export function getHistoryMessagesByIds(db: Database, messageIds: readonly string[]): HistoryMessage[] {
  if (messageIds.length === 0) return [];
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = db.raw.prepare(`SELECT id, author_username, user_id, translated_content, is_bot, created_at,
      reply_to_id, is_synthetic, is_prompt_only, deleted_at, related_thread_id
    FROM messages WHERE id IN (${placeholders})`).all(...messageIds) as HistoryRow[];
  const byId = new Map(hydrateHistoryRows(db, rows).map((message) => [message.id, message]));
  return messageIds.flatMap((id) => {
    const message = byId.get(id);
    return message === undefined ? [] : [message];
  });
}

/** Apply indexed message/asset filters before an optional application-level regex scan. */
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
  const rows = db.raw.prepare(`SELECT m.id, m.guild_id, m.channel_id, m.translated_content,
      COALESCE((SELECT GROUP_CONCAT(COALESCE(a.filename, '') || CHAR(31) || COALESCE(a.content_type, ''), CHAR(30))
        FROM message_assets a WHERE a.message_id = m.id), '') AS asset_search_text
    FROM messages m
    WHERE ${conditions.join(" AND ")}
    ORDER BY m.created_at DESC, m.id DESC${limitClause}`).all(...params) as Array<{
      id: string;
      guild_id: string;
      channel_id: string;
      translated_content: string;
      asset_search_text: string;
    }>;
  return rows.map((row) => ({
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.id,
    content: row.translated_content,
    assetSearchText: row.asset_search_text,
  }));
}

function storedBotMessageFromRow(row: {
  id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  author_username: string;
  translated_content: string;
  created_at: number;
  reply_to_id: string | null;
}): StoredBotMessageState {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    userId: row.user_id,
    authorUsername: row.author_username,
    translatedContent: row.translated_content,
    createdAt: row.created_at,
    replyToId: row.reply_to_id,
  };
}

/**
 * Store the latest content for a real bot-authored Discord message.
 *
 * Existing rows keep their created/reply/thread metadata; missing rows are
 * inserted from live Discord metadata so search/history can recover.
 */
export function upsertBotMessageContent(
  db: Database,
  input: UpsertBotMessageContentInput,
): StoredBotMessageState {
  const existing = db.raw
    .prepare(
      `SELECT id, guild_id, channel_id, user_id, author_username, translated_content, created_at, reply_to_id,
              is_bot, is_synthetic, is_prompt_only
       FROM messages
       WHERE id = ? AND guild_id = ? AND channel_id = ?`
    )
    .get(input.id, input.guildId, input.channelId) as ({
      id: string;
      guild_id: string;
      channel_id: string;
      user_id: string;
      author_username: string;
      translated_content: string;
      created_at: number;
      reply_to_id: string | null;
      is_bot: number;
      is_synthetic: number;
      is_prompt_only: number;
    } | null);

  if (existing !== null) {
    if (existing.user_id !== input.botUserId || existing.is_bot !== 1 || existing.is_synthetic !== 0 || existing.is_prompt_only !== 0) {
      throw new Error("Refusing to update a non-bot or non-real message row.");
    }
    db.raw
      .prepare(
        `UPDATE messages
         SET raw_content = ?, translated_content = ?, author_username = ?, reply_to_id = COALESCE(?, reply_to_id),
             routed_from_guild_id = COALESCE(?, routed_from_guild_id),
             routed_from_channel_id = COALESCE(?, routed_from_channel_id),
             routed_from_message_id = COALESCE(?, routed_from_message_id)
         WHERE id = ? AND guild_id = ? AND channel_id = ? AND user_id = ? AND is_bot = 1
           AND is_synthetic = 0 AND is_prompt_only = 0`
      )
      .run(
        input.rawContent,
        input.translatedContent,
        input.botUsername,
        input.replyToId,
        input.routedFrom?.routedFromGuildId ?? null,
        input.routedFrom?.routedFromChannelId ?? null,
        input.routedFrom?.routedFromMessageId ?? null,
        input.id,
        input.guildId,
        input.channelId,
        input.botUserId,
      );
  } else {
    db.raw
      .prepare(
        `INSERT INTO messages
           (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id,
            routed_from_guild_id, routed_from_channel_id, routed_from_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.guildId,
        input.channelId,
        input.botUserId,
        input.botUsername,
        input.rawContent,
        input.translatedContent,
        input.createdAt,
        input.replyToId,
        input.routedFrom?.routedFromGuildId ?? null,
        input.routedFrom?.routedFromChannelId ?? null,
        input.routedFrom?.routedFromMessageId ?? null,
      );
  }

  const row = db.raw
    .prepare(
      `SELECT id, guild_id, channel_id, user_id, author_username, translated_content, created_at, reply_to_id
       FROM messages
       WHERE id = ? AND guild_id = ? AND channel_id = ?`
    )
    .get(input.id, input.guildId, input.channelId) as {
      id: string;
      guild_id: string;
      channel_id: string;
      user_id: string;
      author_username: string;
      translated_content: string;
      created_at: number;
      reply_to_id: string | null;
    };

  return storedBotMessageFromRow(row);
}

/** Return source channel breadcrumbs for a bot message sent from another channel context. */
export function getRoutedMessageSource(
  db: Database,
  input: { messageId: string; guildId: string; channelId: string },
): RoutedMessageSource | null {
  const row = db.raw
    .prepare(
      `SELECT routed_from_guild_id, routed_from_channel_id, routed_from_message_id
       FROM messages
       WHERE id = ? AND guild_id = ? AND channel_id = ?
         AND is_bot = 1 AND is_synthetic = 0 AND is_prompt_only = 0`
    )
    .get(input.messageId, input.guildId, input.channelId) as {
      routed_from_guild_id: string | null;
      routed_from_channel_id: string | null;
      routed_from_message_id: string | null;
    } | null;

  if (
    row === null
    || row.routed_from_guild_id === null
    || row.routed_from_channel_id === null
    || row.routed_from_message_id === null
  ) {
    return null;
  }
  return {
    routedFromGuildId: row.routed_from_guild_id,
    routedFromChannelId: row.routed_from_channel_id,
    routedFromMessageId: row.routed_from_message_id,
  };
}

/** Mark a stored Discord message as deleted while dropping asset and reaction metadata. */
export function markDiscordMessageDeleted(
  db: Database,
  input: { id: string; guildId: string; channelId?: string; botUserId?: string },
): DeleteBotMessageStateResult {
  const channelCondition = input.channelId !== undefined ? " AND channel_id = ?" : "";
  const botCondition = input.botUserId !== undefined ? " AND user_id = ? AND is_bot = 1" : "";
  const params = [
    input.id,
    input.guildId,
    ...(input.channelId !== undefined ? [input.channelId] : []),
    ...(input.botUserId !== undefined ? [input.botUserId] : []),
  ];
  const existing = db.raw
    .prepare(
      `SELECT id FROM messages
       WHERE id = ? AND guild_id = ?${channelCondition}${botCondition}
         AND is_synthetic = 0 AND is_prompt_only = 0`
    )
    .get(...params) as { id: string } | null;
  if (existing === null) {
    return { deleted: false };
  }

  const metadataScope = input.channelId !== undefined
    ? "message_id = ? AND guild_id = ? AND channel_id = ?"
    : "message_id = ? AND guild_id = ?";
  const metadataParams = input.channelId !== undefined
    ? [input.id, input.guildId, input.channelId]
    : [input.id, input.guildId];
  db.raw.prepare(`DELETE FROM message_assets WHERE ${metadataScope}`).run(...metadataParams);
  db.raw
    .prepare(`DELETE FROM message_reactions WHERE ${metadataScope}`)
    .run(...metadataParams);
  db.raw
    .prepare(
      `UPDATE messages
       SET deleted_at = COALESCE(deleted_at, ?)
       WHERE id = ? AND guild_id = ?${channelCondition}${botCondition}
         AND is_synthetic = 0 AND is_prompt_only = 0`
    )
    .run(Date.now(), ...params);

  return { deleted: true };
}

/** Mark a real bot-authored message row as deleted. */
export function deleteBotMessageState(
  db: Database,
  input: { id: string; guildId: string; channelId: string; botUserId: string },
): DeleteBotMessageStateResult {
  return markDiscordMessageDeleted(db, input);
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
export function getLatestMessageActivityBefore(
  db: Database,
  filter: {
    beforeCreatedAt: number;
    beforeMessageId?: string;
    guildId?: string;
    channelId?: string;
    userId?: string;
    isBot?: boolean;
  },
): MessageActivity | null {
  const conditions = [
    "is_synthetic = 0",
    "is_prompt_only = 0",
    "(created_at < ? OR (created_at = ? AND id < ?))",
  ];
  const params: Array<string | number> = [
    filter.beforeCreatedAt,
    filter.beforeCreatedAt,
    filter.beforeMessageId ?? "",
  ];

  if (filter.guildId !== undefined) {
    conditions.push("guild_id = ?");
    params.push(filter.guildId);
  }
  if (filter.channelId !== undefined) {
    conditions.push("channel_id = ?");
    params.push(filter.channelId);
  }
  if (filter.userId !== undefined) {
    conditions.push("user_id = ?");
    params.push(filter.userId);
  }
  if (filter.isBot !== undefined) {
    conditions.push("is_bot = ?");
    params.push(filter.isBot ? 1 : 0);
  }

  const row = db.raw
    .prepare(
      `SELECT id, guild_id, channel_id, user_id, author_username, created_at, is_bot
       FROM messages
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(...params) as {
      id: string;
      guild_id: string;
      channel_id: string;
      user_id: string;
      author_username: string;
      created_at: number;
      is_bot: number;
    } | null;

  if (row === null) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    userId: row.user_id,
    authorUsername: row.author_username,
    createdAt: row.created_at,
    isBot: row.is_bot === 1,
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
export function getHistoryMessages(
  db: Database,
  channelId: string,
  limit: number,
): HistoryMessage[] {
  const rows = db.raw
    .prepare(
      `SELECT id, author_username, user_id, translated_content, is_bot, created_at, reply_to_id, is_synthetic, is_prompt_only, deleted_at, related_thread_id
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

/** Count human channel messages by fixed time bucket for ambient activity baselines. */
export function getChannelHumanActivityBuckets(
  db: Database,
  guildId: string,
  channelId: string,
  after: number,
  before: number,
  bucketMs: number,
): ChannelActivityBucket[] {
  if (before <= after || bucketMs <= 0) return [];
  return db.raw
    .prepare(
      `SELECT CAST((created_at - ?) / ? AS INTEGER) AS bucketIndex, COUNT(*) AS messageCount
       FROM messages
       WHERE guild_id = ?
         AND channel_id = ?
         AND is_bot = 0
         AND is_synthetic = 0
         AND is_prompt_only = 0
         AND created_at >= ?
         AND created_at < ?
       GROUP BY bucketIndex
       ORDER BY bucketIndex ASC`
    )
    .all(after, bucketMs, guildId, channelId, after, before) as ChannelActivityBucket[];
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
  excludeMessageIds?: string | readonly string[],
): HistoryMessage[] {
  const excludedIds = typeof excludeMessageIds === "string"
    ? [excludeMessageIds]
    : [...(excludeMessageIds ?? [])];
  const excludeClause = excludedIds.length > 0 ? ` AND id NOT IN (${excludedIds.map(() => "?").join(",")})` : "";
  const params = [channelId, ...excludedIds];
  const countRow = db.raw
    .prepare(`SELECT COUNT(*) AS count FROM messages WHERE channel_id = ?${excludeClause}`)
    .get(...params) as { count: number } | null;
  const totalMessages = countRow?.count ?? 0;
  const takeCount = chunkedHistoryTakeCount(totalMessages, trim);
  if (takeCount <= 0) return [];

  const rows = db.raw
    .prepare(
      `SELECT id, author_username, user_id, translated_content, is_bot, created_at, reply_to_id, is_synthetic, is_prompt_only, deleted_at, related_thread_id
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
 * Case-insensitive substring match.
 * Results ordered by created_at ASC (chronological reading order).
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
export function getParentPreContext(
  db: Database,
  parentChatId: string,
  beforeTimestamp: number,
  limit: number,
): HistoryMessage[] {
  const rows = db.raw
    .prepare(
      `SELECT id, author_username, user_id, translated_content, is_bot, created_at, reply_to_id, is_synthetic, is_prompt_only, deleted_at, related_thread_id
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
      deleted_at: number | null;
      related_thread_id: string | null;
    }>;

  // Reverse to chronological order (oldest first)
  rows.reverse();

  return hydrateHistoryRows(db, rows);
}

export type ChannelMessageRow = HistoryMessage;

export interface ListChannelMessagesOptions {
  limit: number;
  beforeMessageId?: string;
  afterMessageId?: string;
  aroundMessageId?: string;
}

/**
 * Fetch channel history for the list_channel_messages tool.
 * Returns chronological order (oldest first).
 *
 * Note: Includes synthetic events (thread creation, etc.) but excludes
 * prompt-only assistant traces that should be visible only in assembled context.
 */
export function listChannelMessages(
  db: Database,
  guildId: string,
  channelId: string,
  options: ListChannelMessagesOptions,
): ChannelMessageRow[] | null {
  const limit = Math.max(1, options.limit);
  if (options.aroundMessageId !== undefined) {
    const anchor = db.raw.prepare(`SELECT id, created_at FROM messages
      WHERE id = ? AND guild_id = ? AND channel_id = ? AND is_prompt_only = 0`)
      .get(options.aroundMessageId, guildId, channelId) as { id: string; created_at: number } | null;
    if (anchor === null) return null;
    const sideLimit = limit - 1;
    const before = db.raw.prepare(`SELECT id FROM messages
      WHERE guild_id = ? AND channel_id = ? AND is_prompt_only = 0
        AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(guildId, channelId, anchor.created_at, anchor.created_at, anchor.id, sideLimit) as Array<{ id: string }>;
    before.reverse();
    const after = db.raw.prepare(`SELECT id FROM messages
      WHERE guild_id = ? AND channel_id = ? AND is_prompt_only = 0
        AND (created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at ASC, id ASC LIMIT ?`)
      .all(guildId, channelId, anchor.created_at, anchor.created_at, anchor.id, sideLimit) as Array<{ id: string }>;
    const balanced = rebalanceContext(before, after, Math.floor(sideLimit / 2), sideLimit);
    return getHistoryMessagesByIds(db, [
      ...balanced.before.map((row) => row.id),
      anchor.id,
      ...balanced.after.map((row) => row.id),
    ]);
  }
  const cursorId = options.beforeMessageId ?? options.afterMessageId;
  const anchor = cursorId === undefined
    ? null
    : db.raw
      .prepare(
        `SELECT id, created_at
         FROM messages
         WHERE id = ? AND guild_id = ? AND channel_id = ? AND is_prompt_only = 0`
      )
      .get(cursorId, guildId, channelId) as { id: string; created_at: number } | null;
  if (cursorId !== undefined && anchor === null) return null;

  const rows = (() => {
    if (options.beforeMessageId !== undefined && anchor !== null) {
      return db.raw
        .prepare(
          `SELECT id, author_username, user_id, translated_content, is_bot, created_at, reply_to_id,
              is_synthetic, is_prompt_only, deleted_at, related_thread_id
           FROM messages
           WHERE guild_id = ? AND channel_id = ? AND is_prompt_only = 0
             AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        )
        .all(guildId, channelId, anchor.created_at, anchor.created_at, anchor.id, limit);
    }
    if (options.afterMessageId !== undefined && anchor !== null) {
      return db.raw
        .prepare(
          `SELECT id, author_username, user_id, translated_content, is_bot, created_at, reply_to_id,
              is_synthetic, is_prompt_only, deleted_at, related_thread_id
           FROM messages
           WHERE guild_id = ? AND channel_id = ? AND is_prompt_only = 0
             AND (created_at > ? OR (created_at = ? AND id > ?))
           ORDER BY created_at ASC, id ASC
           LIMIT ?`
        )
        .all(guildId, channelId, anchor.created_at, anchor.created_at, anchor.id, limit);
    }
    return db.raw
      .prepare(
        `SELECT id, author_username, user_id, translated_content, is_bot, created_at, reply_to_id,
            is_synthetic, is_prompt_only, deleted_at, related_thread_id
         FROM messages
         WHERE guild_id = ? AND channel_id = ? AND is_prompt_only = 0
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .all(guildId, channelId, limit);
  })() as HistoryRow[];

  if (options.afterMessageId === undefined) rows.reverse();

  return hydrateHistoryRows(db, rows);
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
  /** Thread channel ID this event references. */
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
 * Insert a synthetic "Event" row for thread creation/handoff.
 * Stored in the parent channel with is_synthetic=1 and related_thread_id set.
 * Excluded from search results.
 */
export function insertSyntheticEvent(db: Database, input: InsertSyntheticEventInput): void {
  const now = Date.now();
  const content = `Event: Thread created — request handed off to thread — ${input.threadName} (channel_id: ${input.threadId})`;

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
 * Repository search/tool reads filter prompt-only rows out.
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
 * Returns deleted message IDs.
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
    return { messageIds: [] };
  }

  const messageIds = messageRows.map((r) => r.id);
  const placeholders = messageIds.map(() => "?").join(",");

  // Delete associated metadata before messages.
  db.raw.prepare(`DELETE FROM message_assets WHERE message_id IN (${placeholders})`).run(...messageIds);
  db.raw.prepare(`DELETE FROM message_reactions WHERE message_id IN (${placeholders})`).run(...messageIds);
  db.raw.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...messageIds);

  return { messageIds };
}
