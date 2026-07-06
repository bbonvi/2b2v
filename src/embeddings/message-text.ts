import type { Database } from "../db/database.ts";

const MAX_EMBED_TEXT_CHARS = 2000;
const DEFAULT_MERGE_GAP_MS = 120_000;

export interface MessageEmbeddingSource {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  content: string;
  createdAt: number;
  isBot: boolean;
}

export interface MessageEmbeddingBlock {
  id: string;
  text: string;
  messageIds: string[];
  firstMessageId: string;
  lastMessageId: string;
  messageCount: number;
  guildId: string;
  channelId: string;
  userId: string;
  createdAt: number;
  lastCreatedAt: number;
  isBot: boolean;
}

/**
 * Normalize Discord message text for embeddings while preserving ordinary short text.
 * Metadata such as username/channel/time stays in vector payloads, not embedded text.
 */
export function normalizeMessageForEmbedding(text: string): string {
  const normalized = text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/<a?:([A-Za-z0-9_~-]{1,64}):\d+>/g, ":$1:")
    .replace(/<@!?\d+>/g, "@mention")
    .replace(/<@&\d+>/g, "@role")
    .replace(/<#\d+>/g, "#channel")
    .replace(/https?:\/\/[^\s<>)]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return `[link ${parsed.hostname.replace(/^www\./, "")}]`;
      } catch {
        return "[link]";
      }
    })
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length > MAX_EMBED_TEXT_CHARS
    ? normalized.slice(0, MAX_EMBED_TEXT_CHARS).trim()
    : normalized;
}

export function buildMessageEmbeddingBlocks(
  messages: readonly MessageEmbeddingSource[],
  mergeGapMs = DEFAULT_MERGE_GAP_MS,
): MessageEmbeddingBlock[] {
  const sorted = [...messages].sort((a, b) => {
    const guildDiff = a.guildId.localeCompare(b.guildId);
    if (guildDiff !== 0) return guildDiff;
    const channelDiff = a.channelId.localeCompare(b.channelId);
    if (channelDiff !== 0) return channelDiff;
    const timeDiff = a.createdAt - b.createdAt;
    if (timeDiff !== 0) return timeDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const blocks: MessageEmbeddingBlock[] = [];
  let current: MessageEmbeddingBlock | undefined;

  for (const message of sorted) {
    const normalized = normalizeMessageForEmbedding(message.content);
    if (normalized === "") continue;

    const mergedTextLength = current === undefined ? normalized.length : current.text.length + 1 + normalized.length;
    const canMerge = current !== undefined
      && current.guildId === message.guildId
      && current.channelId === message.channelId
      && current.userId === message.userId
      && current.isBot === message.isBot
      && message.createdAt - current.lastCreatedAt <= mergeGapMs
      && mergedTextLength <= MAX_EMBED_TEXT_CHARS;

    if (canMerge && current !== undefined) {
      current.text = `${current.text}\n${normalized}`;
      current.messageIds.push(message.id);
      current.lastMessageId = message.id;
      current.messageCount += 1;
      current.lastCreatedAt = message.createdAt;
      continue;
    }

    current = {
      id: message.id,
      text: normalized,
      messageIds: [message.id],
      firstMessageId: message.id,
      lastMessageId: message.id,
      messageCount: 1,
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.userId,
      createdAt: message.createdAt,
      lastCreatedAt: message.createdAt,
      isBot: message.isBot,
    };
    blocks.push(current);
  }

  for (const block of blocks) {
    if (block.messageCount > 1) {
      block.id = `msgblock:${block.firstMessageId}:${block.lastMessageId}`;
    }
  }

  return blocks;
}

export function rowsToEmbeddingSources(rows: Array<{
  id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  translated_content: string;
  created_at: number;
  is_bot: number;
}>): MessageEmbeddingSource[] {
  return rows.map((row) => ({
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    userId: row.user_id,
    content: row.translated_content,
    createdAt: row.created_at,
    isBot: row.is_bot === 1,
  }));
}

export function fetchMessageEmbeddingSources(
  db: Database,
  filter: { guildId: string; channelId?: string; since?: number; before?: number },
): MessageEmbeddingSource[] {
  const conditions = [
    "guild_id = ?",
    "is_synthetic = 0",
    "is_prompt_only = 0",
    "deleted_at IS NULL",
    "TRIM(translated_content) <> ''",
  ];
  const params: (string | number)[] = [filter.guildId];
  if (filter.channelId !== undefined) {
    conditions.push("channel_id = ?");
    params.push(filter.channelId);
  }
  if (filter.since !== undefined) {
    conditions.push("created_at >= ?");
    params.push(filter.since);
  }
  if (filter.before !== undefined) {
    conditions.push("created_at < ?");
    params.push(filter.before);
  }

  const rows = db.raw
    .prepare(
      `SELECT id, guild_id, channel_id, user_id, translated_content, created_at, is_bot
       FROM messages
       WHERE ${conditions.join(" AND ")}
       ORDER BY channel_id ASC, created_at ASC, id ASC`,
    )
    .all(...params) as Array<{
      id: string;
      guild_id: string;
      channel_id: string;
      user_id: string;
      translated_content: string;
      created_at: number;
      is_bot: number;
    }>;

  return rowsToEmbeddingSources(rows);
}
