import type { Database } from "../db/database.ts";
import { getAssetsByMessageId } from "../db/asset-repository.ts";
import type { HistoryMessage } from "./history-types.ts";
import { appendStickerTags, type StickerLike } from "../discord/message-media.ts";

/** A Discord message as returned by the fetch callback. */
export interface FetchedDiscordMessage {
  id: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName?: string;
  content: string;
  /** Unix epoch ms. */
  timestamp: number;
  isBot: boolean;
  replyToId: string | null;
  attachments: Array<{
    id?: string;
    name?: string;
    url: string;
    contentType: string | null;
    size?: number;
    width?: number | null;
    height?: number | null;
    durationSeconds?: number | null;
  }>;
  embeds?: Array<{
    type?: string | null;
    url?: string | null;
    provider?: { name?: string | null } | null;
    image?: { url: string };
    thumbnail?: { url: string };
  }>;
  stickers?: StickerLike[];
}

/** Dependencies injected for testability. */
export interface ReplyFallbackDeps {
  db: Database;
  guildId: string;
  channelId: string;
  /** Fetch a single message from Discord by channel+message ID. Returns null on failure/not found. */
  fetchDiscordMessage: (channelId: string, messageId: string) => Promise<FetchedDiscordMessage | null>;
  /** Persist generalized lazy asset metadata for a fetched reply target. */
  syncAssets?: (message: FetchedDiscordMessage) => void;
}

function loadStoredMessages(deps: ReplyFallbackDeps, ids: string[]): HistoryMessage[] {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => "?").join(",");
  const rows = deps.db.raw
    .prepare(
      `SELECT id, user_id, author_username, translated_content, is_bot, created_at, reply_to_id, is_synthetic, related_thread_id
       FROM messages
       WHERE guild_id = ? AND id IN (${placeholders})`
    )
    .all(deps.guildId, ...ids) as Array<{
      id: string;
      user_id: string;
      author_username: string;
      translated_content: string;
      is_bot: number;
      created_at: number;
      reply_to_id: string | null;
      is_synthetic: number;
      related_thread_id: string | null;
    }>;

  if (rows.length === 0) return [];

  const rowMap = new Map(rows.map((row) => [row.id, row]));
  const messages: HistoryMessage[] = [];
  for (const id of ids) {
    const row = rowMap.get(id);
    if (row === undefined) continue;
    const assets = getAssetsByMessageId(deps.db, row.id);
    messages.push({
      id: row.id,
      author: row.author_username,
      authorId: row.user_id,
      content: row.translated_content,
      isBot: row.is_bot === 1,
      timestamp: row.created_at,
      replyToId: row.reply_to_id,
      ...(assets.length > 0 ? { assets: assets.map((asset) => ({
        id: asset.id, kind: asset.kind, sourceKind: asset.sourceKind, filename: asset.filename,
        contentType: asset.contentType, size: asset.size, width: asset.width, height: asset.height,
        durationSeconds: asset.durationSeconds,
      })) } : {}),
      hasEmbeds: false,
      isSynthetic: row.is_synthetic === 1,
      relatedThreadId: row.related_thread_id,
    });
  }

  return messages;
}

/**
 * Fetch missing reply targets from Discord API and persist them.
 *
 * Given a list of history messages, identifies reply_to_ids that are:
 * 1. Not present in the message list itself
 * 2. Hydrated from the database when already stored
 * 3. Fetched from Discord when not yet stored
 *
 * For each missing target, fetches from Discord, persists to SQLite,
 * and indexes lazy attachment metadata.
 *
 * Returns the fetched messages as HistoryMessage[] for inclusion in history.
 * On fetch failure, the message is silently skipped (resolveReplies handles missingTarget).
 */
export async function fetchMissingReplyTargets(
  deps: ReplyFallbackDeps,
  messages: HistoryMessage[],
): Promise<HistoryMessage[]> {
  // Collect unique reply_to_ids not present in the message list
  const knownIds = new Set<string>();
  for (const m of messages) {
    knownIds.add(m.id);
    for (const id of m.mergedMessageIds ?? []) {
      knownIds.add(id);
    }
  }
  const missingIds = new Set<string>();

  for (const m of messages) {
    if (m.replyToId !== null && !knownIds.has(m.replyToId)) {
      missingIds.add(m.replyToId);
    }
  }

  if (missingIds.size === 0) return [];

  const missingIdList = [...missingIds];
  const fetched = loadStoredMessages(deps, missingIdList);
  const foundInDb = new Set(fetched.map((m) => m.id));
  const toFetch = missingIdList.filter((id) => !foundInDb.has(id) && /^\d{17,20}$/u.test(id));

  // Fetch from Discord (sequential to avoid rate limits)
  for (const msgId of toFetch) {
    let discordMsg: FetchedDiscordMessage | null;
    try {
      discordMsg = await deps.fetchDiscordMessage(deps.channelId, msgId);
    } catch {
      continue; // Network error — skip
    }

    if (discordMsg === null) continue; // Deleted or no permissions

    const visibleContent = appendStickerTags(discordMsg.content, discordMsg.stickers ?? []);

    // Persist to SQLite
    deps.db.raw
      .prepare(
        `INSERT OR IGNORE INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        discordMsg.id,
        deps.guildId,
        deps.channelId,
        discordMsg.authorId,
        discordMsg.authorUsername,
        visibleContent,
        visibleContent, // translated_content = raw for fetched messages (no translation context)
        discordMsg.isBot ? 1 : 0,
        discordMsg.timestamp,
        discordMsg.replyToId,
      );

    deps.syncAssets?.(discordMsg);

    const assets = getAssetsByMessageId(deps.db, discordMsg.id);
    fetched.push({
      id: discordMsg.id,
      author: discordMsg.authorUsername,
      authorDisplayName: discordMsg.authorDisplayName,
      authorId: discordMsg.authorId,
      content: visibleContent,
      isBot: discordMsg.isBot,
      timestamp: discordMsg.timestamp,
      replyToId: discordMsg.replyToId,
      ...(assets.length > 0 ? { assets: assets.map((asset) => ({
        id: asset.id, kind: asset.kind, sourceKind: asset.sourceKind, filename: asset.filename,
        contentType: asset.contentType, size: asset.size, width: asset.width, height: asset.height,
        durationSeconds: asset.durationSeconds,
      })) } : {}),
      hasEmbeds: false,
      isSynthetic: false, // Fetched messages are real user messages
      relatedThreadId: null,
    });
  }

  return fetched;
}
