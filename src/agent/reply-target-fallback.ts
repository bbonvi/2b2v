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

/**
 * Fetch missing reply targets from Discord API and persist them.
 *
 * Given a list of history messages, identifies reply_to_ids that are:
 * 1. Not present in the message list itself
 * 2. Not present in the database
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
  const knownIds = new Set(messages.map((m) => m.id));
  const missingIds = new Set<string>();

  for (const m of messages) {
    if (m.replyToId !== null && !knownIds.has(m.replyToId)) {
      missingIds.add(m.replyToId);
    }
  }

  if (missingIds.size === 0) return [];

  // Check which are already in DB
  const toFetch: string[] = [];
  for (const id of missingIds) {
    const row = deps.db.raw
      .prepare("SELECT id FROM messages WHERE id = ? AND guild_id = ?")
      .get(id, deps.guildId) as { id: string } | null;
    if (row === null) {
      toFetch.push(id);
    }
  }

  if (toFetch.length === 0) return [];

  // Fetch from Discord (sequential to avoid rate limits)
  const fetched: HistoryMessage[] = [];

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
