import type { Database } from "./database";

import { PRIVATE_HANDOFF_MESSAGE_ID_PREFIX } from "../agent/history-types";

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
  /** Private routed-message context, when the sending turn supplied it. */
  handoff?: string;
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
      `SELECT messages.routed_from_guild_id, messages.routed_from_channel_id, messages.routed_from_message_id,
              handoff.translated_content AS handoff_content
       FROM messages
       LEFT JOIN messages AS handoff
         ON handoff.id = ? || messages.id AND handoff.is_prompt_only = 1
       WHERE messages.id = ? AND messages.guild_id = ? AND messages.channel_id = ?
         AND messages.is_bot = 1 AND messages.is_synthetic = 0 AND messages.is_prompt_only = 0`
    )
    .get(
      `${PRIVATE_HANDOFF_MESSAGE_ID_PREFIX}destination:`,
      input.messageId,
      input.guildId,
      input.channelId,
    ) as {
      routed_from_guild_id: string | null;
      routed_from_channel_id: string | null;
      routed_from_message_id: string | null;
      handoff_content: string | null;
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
    ...(row.handoff_content !== null ? { handoff: row.handoff_content } : {}),
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

export interface InsertPromptOnlyMessageHandoffInput {
  sourceGuildId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  destinationGuildId: string;
  destinationChannelId: string;
  routedMessageId: string;
  botUserId: string;
  botUsername: string;
  handoff: string;
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Persist one authored handoff beside its source and delivered Discord messages. */
export function insertPromptOnlyMessageHandoff(
  db: Database,
  input: InsertPromptOnlyMessageHandoffInput,
): void {
  const content = [
    "<handoff",
    `  source_guild_id="${escapeXml(input.sourceGuildId)}"`,
    `  source_channel_id="${escapeXml(input.sourceChannelId)}"`,
    `  source_message_id="${escapeXml(input.sourceMessageId)}"`,
    `  destination_guild_id="${escapeXml(input.destinationGuildId)}"`,
    `  destination_channel_id="${escapeXml(input.destinationChannelId)}"`,
    `  routed_message_id="${escapeXml(input.routedMessageId)}">`,
    escapeXml(input.handoff),
    "</handoff>",
  ].join("\n");
  const common = {
    botUserId: input.botUserId,
    botUsername: input.botUsername,
    content,
  };
  insertPromptOnlyBotMessage(db, {
    ...common,
    id: `${PRIVATE_HANDOFF_MESSAGE_ID_PREFIX}source:${input.routedMessageId}`,
    guildId: input.sourceGuildId,
    channelId: input.sourceChannelId,
    replyToId: input.sourceMessageId,
  });
  insertPromptOnlyBotMessage(db, {
    ...common,
    id: `${PRIVATE_HANDOFF_MESSAGE_ID_PREFIX}destination:${input.routedMessageId}`,
    guildId: input.destinationGuildId,
    channelId: input.destinationChannelId,
    replyToId: input.routedMessageId,
  });
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

