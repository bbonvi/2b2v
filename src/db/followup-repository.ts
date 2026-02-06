import type { Database } from "./database";

export interface FollowUpMessage {
  id: string;
  authorUsername: string;
  userId: string;
  content: string;
  createdAt: number;
  isBot: boolean;
  isMention: boolean;
}

/**
 * Query for messages that arrived after a given timestamp in a channel.
 * Used to detect follow-up messages during agent processing.
 * Filters out synthetic messages and excluded IDs (bot's own sends, trigger message).
 */
export function getFollowUpMessages(
  db: Database,
  channelId: string,
  afterTimestamp: number,
  excludeIds: Set<string>,
  botUserId: string,
  limit: number = 10,
): FollowUpMessage[] {
  const rows = db.raw
    .prepare(
      `SELECT id, author_username, user_id, translated_content, is_bot, created_at
       FROM messages
       WHERE channel_id = ? AND created_at > ? AND is_synthetic = 0
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(channelId, afterTimestamp, limit + excludeIds.size) as Array<{
      id: string;
      author_username: string;
      user_id: string;
      translated_content: string;
      is_bot: number;
      created_at: number;
    }>;

  // Filter excludeIds in JS (small sets)
  const botMentionPattern = `<@${botUserId}>`;
  return rows
    .filter((r) => !excludeIds.has(r.id))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      authorUsername: r.author_username,
      userId: r.user_id,
      content: r.translated_content,
      createdAt: r.created_at,
      isBot: r.is_bot === 1,
      isMention: r.translated_content.includes(botMentionPattern),
    }));
}
