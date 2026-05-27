import type { Database } from "../db/database.ts";
import type { HistoryMessage } from "./history-types.ts";

/** A Discord message as returned by the fetch callback. */
export interface FetchedDiscordMessage {
  id: string;
  authorId: string;
  authorUsername: string;
  content: string;
  /** Unix epoch ms. */
  timestamp: number;
  isBot: boolean;
  replyToId: string | null;
  attachments: Array<{
    url: string;
    contentType: string | null;
  }>;
  embeds?: Array<{
    image?: { url: string };
    thumbnail?: { url: string };
  }>;
}

/** Dependencies injected for testability. */
export interface ReplyFallbackDeps {
  db: Database;
  guildId: string;
  channelId: string;
  /** Fetch a single message from Discord by channel+message ID. Returns null on failure/not found. */
  fetchDiscordMessage: (channelId: string, messageId: string) => Promise<FetchedDiscordMessage | null>;
  /** Enqueue a message for embedding (fire-and-forget semantics). */
  enqueueEmbedding: (id: string, text: string, metadata: { guild_id: string; channel_id: string; user_id: string; created_at: number }) => Promise<void>;
  /** Process and store an image attachment (fire-and-forget semantics). */
  processImage: (url: string, contentType: string, messageId: string) => Promise<void>;
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

  const messageIds = rows.map((row) => row.id);
  const imagePlaceholders = messageIds.map(() => "?").join(",");
  const imageRows = deps.db.raw
    .prepare(
      `SELECT message_id, id, caption
       FROM images
       WHERE message_id IN (${imagePlaceholders})
       ORDER BY id ASC`
    )
    .all(...messageIds) as Array<{
      message_id: string;
      id: number;
      caption: string | null;
    }>;

  const imageMap = new Map<string, Array<{ id: number; caption: string | null }>>();
  for (const image of imageRows) {
    const existing = imageMap.get(image.message_id);
    if (existing !== undefined) {
      existing.push({ id: image.id, caption: image.caption });
    } else {
      imageMap.set(image.message_id, [{ id: image.id, caption: image.caption }]);
    }
  }

  const rowMap = new Map(rows.map((row) => [row.id, row]));
  const messages: HistoryMessage[] = [];
  for (const id of ids) {
    const row = rowMap.get(id);
    if (row === undefined) continue;
    const images = imageMap.get(row.id) ?? [];
    messages.push({
      id: row.id,
      author: row.author_username,
      authorId: row.user_id,
      content: row.translated_content,
      isBot: row.is_bot === 1,
      timestamp: row.created_at,
      replyToId: row.reply_to_id,
      imageIds: images.map((image) => image.id),
      captions: images.map((image) => image.caption ?? ""),
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
 * ingests image attachments, and enqueues for embedding.
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
  const toFetch = missingIdList.filter((id) => !foundInDb.has(id));

  // Fetch from Discord (sequential to avoid rate limits)
  for (const msgId of toFetch) {
    let discordMsg: FetchedDiscordMessage | null;
    try {
      discordMsg = await deps.fetchDiscordMessage(deps.channelId, msgId);
    } catch {
      continue; // Network error — skip
    }

    if (discordMsg === null) continue; // Deleted or no permissions

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
        discordMsg.content,
        discordMsg.content, // translated_content = raw for fetched messages (no translation context)
        discordMsg.isBot ? 1 : 0,
        discordMsg.timestamp,
        discordMsg.replyToId,
      );

    // Enqueue for embedding (fire-and-forget)
    void deps.enqueueEmbedding(discordMsg.id, discordMsg.content, {
      guild_id: deps.guildId,
      channel_id: deps.channelId,
      user_id: discordMsg.authorId,
      created_at: discordMsg.timestamp,
    }).catch(() => {
      // Embedding failure is non-fatal
    });

    // Ingest image attachments (fire-and-forget)
    for (const att of discordMsg.attachments) {
      const ct = att.contentType ?? "";
      if (!ct.startsWith("image/")) continue;
      void deps.processImage(att.url, ct, discordMsg.id).catch(() => {
        // Image ingest failure is non-fatal
      });
    }

    // Ingest embed images (Tenor/Giphy GIFs)
    for (const embed of discordMsg.embeds ?? []) {
      const embedUrl = embed.image?.url ?? embed.thumbnail?.url;
      if (embedUrl === undefined) continue;

      const mimeGuess = embedUrl.includes(".gif") ? "image/gif"
                      : embedUrl.includes(".webp") ? "image/webp"
                      : "image/png";

      void deps.processImage(embedUrl, mimeGuess, discordMsg.id).catch(() => {
        // Embed image ingest failure is non-fatal
      });
    }

    fetched.push({
      id: discordMsg.id,
      author: discordMsg.authorUsername,
      authorId: discordMsg.authorId,
      content: discordMsg.content,
      isBot: discordMsg.isBot,
      timestamp: discordMsg.timestamp,
      replyToId: discordMsg.replyToId,
      imageIds: [], // Images are ingested asynchronously; IDs not available yet
      captions: [],
      hasEmbeds: false,
      isSynthetic: false, // Fetched messages are real user messages
      relatedThreadId: null,
    });
  }

  return fetched;
}
