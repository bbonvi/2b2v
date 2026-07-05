import type { Database } from "./database";

export interface UpsertMessageReactionInput {
  messageId: string;
  guildId: string;
  channelId: string;
  emojiKey: string;
  emojiLabel: string;
  count: number;
  updatedAt?: number;
}

/**
 * Persist the current aggregate count for one emoji reaction on a stored message.
 * Returns false when the message is not known to SQLite.
 */
export function upsertMessageReaction(db: Database, input: UpsertMessageReactionInput): boolean {
  const message = db.raw
    .prepare("SELECT guild_id, channel_id FROM messages WHERE id = ? AND guild_id = ? LIMIT 1")
    .get(input.messageId, input.guildId) as { guild_id: string; channel_id: string } | null;
  if (message === null) return false;

  if (input.count <= 0) {
    db.raw
      .prepare("DELETE FROM message_reactions WHERE message_id = ? AND emoji_key = ?")
      .run(input.messageId, input.emojiKey);
    return true;
  }

  db.raw
    .prepare(
      `INSERT INTO message_reactions (message_id, guild_id, channel_id, emoji_key, emoji_label, count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id, emoji_key)
       DO UPDATE SET emoji_label = excluded.emoji_label, count = excluded.count, updated_at = excluded.updated_at`
    )
    .run(
      input.messageId,
      message.guild_id,
      message.channel_id,
      input.emojiKey,
      input.emojiLabel,
      input.count,
      input.updatedAt ?? Date.now(),
    );
  return true;
}

/** Delete all stored reactions for one known message. */
export function deleteMessageReactions(db: Database, messageId: string, guildId?: string): void {
  if (guildId === undefined) {
    db.raw.prepare("DELETE FROM message_reactions WHERE message_id = ?").run(messageId);
    return;
  }
  db.raw
    .prepare("DELETE FROM message_reactions WHERE message_id = ? AND guild_id = ?")
    .run(messageId, guildId);
}

/** Delete one stored emoji reaction summary from one message. */
export function deleteMessageEmojiReaction(
  db: Database,
  messageId: string,
  emojiKey: string,
  guildId?: string,
): void {
  if (guildId === undefined) {
    db.raw
      .prepare("DELETE FROM message_reactions WHERE message_id = ? AND emoji_key = ?")
      .run(messageId, emojiKey);
    return;
  }
  db.raw
    .prepare("DELETE FROM message_reactions WHERE message_id = ? AND guild_id = ? AND emoji_key = ?")
    .run(messageId, guildId, emojiKey);
}
