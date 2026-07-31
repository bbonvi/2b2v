import type { Database } from "./database";

import { PRIVATE_HANDOFF_MESSAGE_ID_PREFIX, PRIVATE_THOUGHT_MESSAGE_ID_PREFIX, type HistoryMessage } from "../agent/history-types";

import type { TrimConfig } from "../config/types";

import type { AssetKind, AssetSourceKind } from "./asset-repository.ts";

import type { HistoryAsset } from "../agent/history-types.ts";

import { isDiceRollHistoryEvent } from "../dice-roll-contract";

interface HistoryRow {
  id: string;
  author_username: string;
  user_id: string;
  translated_content: string;
  is_bot: number;
  webhook_id: string | null;
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
  const assetRows = db.raw.prepare(`SELECT message_id, id, kind, source_kind, filename, content_type, size, width, height, duration_seconds, original_asset_id,
      (SELECT job_id FROM agent_job_assets WHERE asset_id = message_assets.id ORDER BY job_id LIMIT 1) AS job_id
    FROM message_assets WHERE message_id IN (${placeholders}) ORDER BY id ASC`).all(...messageIds) as Array<{
      message_id: string; id: number; kind: AssetKind;
      source_kind: AssetSourceKind; filename: string | null;
      content_type: string | null; size: number | null; width: number | null; height: number | null; duration_seconds: number | null;
      original_asset_id: number | null;
      job_id: string | null;
    }>;
  const assetMap = new Map<string, HistoryAsset[]>();
  for (const asset of assetRows) {
    const values = assetMap.get(asset.message_id) ?? [];
    values.push({ id: asset.id, kind: asset.kind, sourceKind: asset.source_kind, filename: asset.filename,
      contentType: asset.content_type, size: asset.size, width: asset.width, height: asset.height, durationSeconds: asset.duration_seconds,
      ...(asset.original_asset_id !== null ? { originalAssetId: asset.original_asset_id } : {}),
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
      ...(r.webhook_id !== null ? { webhookId: r.webhook_id } : {}),
      timestamp: r.created_at,
      replyToId: r.reply_to_id,
      ...(assets.length > 0 ? { assets } : {}),
      hasEmbeds: false,
      isSynthetic: r.is_synthetic === 1 || isDiceRollHistoryEvent(r.translated_content),
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
  const rows = db.raw.prepare(`SELECT id, author_username, user_id, translated_content, is_bot, webhook_id, created_at,
      reply_to_id, is_synthetic, is_prompt_only, deleted_at, related_thread_id
    FROM messages WHERE id IN (${placeholders})`).all(...messageIds) as HistoryRow[];
  const byId = new Map(hydrateHistoryRows(db, rows).map((message) => [message.id, message]));
  return messageIds.flatMap((id) => {
    const message = byId.get(id);
    return message === undefined ? [] : [message];
  });
}

/** Apply indexed message/asset filters before an optional application-level regex scan. */

export function rebalanceContext<T>(
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


export function getHistoryMessages(
  db: Database,
  channelId: string,
  limit: number,
): HistoryMessage[] {
  const privateHandoffPattern = `${PRIVATE_HANDOFF_MESSAGE_ID_PREFIX}%`;
  const rows = db.raw
    .prepare(
      `SELECT id, author_username, user_id, translated_content, is_bot, webhook_id, created_at, reply_to_id, is_synthetic, is_prompt_only, deleted_at, related_thread_id
       FROM messages
       WHERE channel_id = ? AND id NOT LIKE ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(channelId, privateHandoffPattern, limit) as HistoryRow[];

  // Reverse to chronological order
  rows.reverse();

  return hydrateHistoryRows(db, [...rows, ...linkedPrivateHandoffRows(db, channelId, rows)]
    .sort(compareHistoryRows));
}

/** Count human channel messages by fixed time bucket for ambient activity baselines. */

function chunkedHistoryTakeCount(totalMessages: number, trim: TrimConfig): number {
  if (totalMessages < trim.trimTrigger) return totalMessages;
  const overage = totalMessages - trim.trimTarget;
  const dropCount = Math.floor(overage / trim.windowSize) * trim.windowSize;
  return totalMessages - dropCount;
}

function compareHistoryRows(left: HistoryRow, right: HistoryRow): number {
  const timeDiff = left.created_at - right.created_at;
  return timeDiff !== 0 ? timeDiff : left.id.localeCompare(right.id);
}

function linkedPrivateHandoffRows(
  db: Database,
  channelId: string,
  linkedRows: HistoryRow[],
): HistoryRow[] {
  const linkedMessageIds = linkedRows.map((row) => row.id);
  if (linkedMessageIds.length === 0) return [];
  return db.raw
    .prepare(
      `SELECT id, author_username, user_id, translated_content, is_bot, webhook_id, created_at, reply_to_id, is_synthetic, is_prompt_only, deleted_at, related_thread_id
       FROM messages
       WHERE channel_id = ? AND id LIKE ?
         AND reply_to_id IN (${linkedMessageIds.map(() => "?").join(",")})
       ORDER BY created_at ASC, id ASC`
    )
    .all(
      channelId,
      `${PRIVATE_HANDOFF_MESSAGE_ID_PREFIX}%`,
      ...linkedMessageIds,
    ) as HistoryRow[];
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
  const privateThoughtPattern = `${PRIVATE_THOUGHT_MESSAGE_ID_PREFIX}%`;
  const privateHandoffPattern = `${PRIVATE_HANDOFF_MESSAGE_ID_PREFIX}%`;
  const params = [channelId, privateThoughtPattern, privateHandoffPattern, ...excludedIds];
  const countRow = db.raw
    .prepare(`SELECT COUNT(*) AS count FROM messages
      WHERE channel_id = ? AND id NOT LIKE ? AND id NOT LIKE ?${excludeClause}`)
    .get(...params) as { count: number } | null;
  const totalMessages = countRow?.count ?? 0;
  const takeCount = chunkedHistoryTakeCount(totalMessages, trim);
  if (takeCount <= 0) return [];

  const rows = db.raw
    .prepare(
      `SELECT id, author_username, user_id, translated_content, is_bot, webhook_id, created_at, reply_to_id, is_synthetic, is_prompt_only, deleted_at, related_thread_id
       FROM messages
       WHERE channel_id = ? AND id NOT LIKE ? AND id NOT LIKE ?${excludeClause}
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(...params, takeCount) as HistoryRow[];

  rows.reverse();
  const oldestTimestamp = rows[0]?.created_at;
  if (oldestTimestamp === undefined) return [];
  const privateThoughtRows = db.raw
    .prepare(
      `SELECT id, author_username, user_id, translated_content, is_bot, webhook_id, created_at, reply_to_id, is_synthetic, is_prompt_only, deleted_at, related_thread_id
       FROM messages
       WHERE channel_id = ? AND id LIKE ? AND created_at >= ?
       ORDER BY created_at ASC, id ASC`
    )
    .all(channelId, privateThoughtPattern, oldestTimestamp) as HistoryRow[];
  const privateHandoffRows = linkedPrivateHandoffRows(db, channelId, rows);
  return hydrateHistoryRows(
    db,
    [...rows, ...privateThoughtRows, ...privateHandoffRows].sort(compareHistoryRows),
  );
}

/**
 * Literal keyword/phrase search over messages using SQLite LIKE.
 * Case-insensitive substring match.
 * Results ordered by created_at ASC (chronological reading order).
 */

export function getParentPreContext(
  db: Database,
  parentChatId: string,
  beforeTimestamp: number,
  limit: number,
): HistoryMessage[] {
  const privateHandoffPattern = `${PRIVATE_HANDOFF_MESSAGE_ID_PREFIX}%`;
  const rows = db.raw
    .prepare(
      `SELECT id, author_username, user_id, translated_content, is_bot, webhook_id, created_at, reply_to_id, is_synthetic, is_prompt_only, deleted_at, related_thread_id
       FROM messages
       WHERE channel_id = ? AND created_at < ? AND is_synthetic = 0 AND id NOT LIKE ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(parentChatId, beforeTimestamp, privateHandoffPattern, limit) as HistoryRow[];

  // Reverse to chronological order (oldest first)
  rows.reverse();

  return hydrateHistoryRows(
    db,
    [...rows, ...linkedPrivateHandoffRows(db, parentChatId, rows)].sort(compareHistoryRows),
  );
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
          `SELECT id, author_username, user_id, translated_content, is_bot, webhook_id, created_at, reply_to_id,
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
          `SELECT id, author_username, user_id, translated_content, is_bot, webhook_id, created_at, reply_to_id,
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
        `SELECT id, author_username, user_id, translated_content, is_bot, webhook_id, created_at, reply_to_id,
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


