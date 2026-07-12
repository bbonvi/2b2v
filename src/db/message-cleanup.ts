import { unlinkSync } from "fs";
import type { Database } from "./database.ts";
import {
  deleteBotMessageState,
  deleteRecentMessages,
  markDiscordMessageDeleted,
} from "./message-repository.ts";

export interface CleanupResult {
  messagesDeleted: number;
  imagesDeleted: number;
}

export interface GuildWipeResult extends CleanupResult {
  memoriesDeleted: number;
}

export function deleteImageFiles(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {
      // Best effort: database rows are the source of truth; missing files should not break cleanup.
    }
  }
}

export function cleanupDeletedBotMessage(input: {
  db: Database;
  messageId: string;
  guildId: string;
  channelId: string;
  botUserId: string;
}): CleanupResult {
  const deleted = deleteBotMessageState(input.db, {
    id: input.messageId,
    guildId: input.guildId,
    channelId: input.channelId,
    botUserId: input.botUserId,
  });

  if (!deleted.deleted) return { messagesDeleted: 0, imagesDeleted: 0 };

  deleteImageFiles(deleted.imagePaths);
  return { messagesDeleted: 1, imagesDeleted: deleted.imageCount };
}

export function cleanupDeletedDiscordMessage(input: {
  db: Database;
  guildId: string;
  messageId: string;
}): CleanupResult {
  const deleted = markDiscordMessageDeleted(input.db, {
    id: input.messageId,
    guildId: input.guildId,
  });
  if (!deleted.deleted) return { messagesDeleted: 0, imagesDeleted: 0 };

  deleteImageFiles(deleted.imagePaths);
  return { messagesDeleted: 1, imagesDeleted: deleted.imageCount };
}

export function cleanupRecentMessages(input: {
  db: Database;
  channelId: string;
  count: number;
}): CleanupResult {
  const deleted = deleteRecentMessages(input.db, input.channelId, input.count);
  deleteImageFiles(deleted.imagePaths);
  return { messagesDeleted: deleted.messageIds.length, imagesDeleted: deleted.imagePaths.length };
}

export function cleanupGuildData(input: {
  db: Database;
  guildId: string;
}): GuildWipeResult {
  const imageRows = input.db.raw
    .prepare("SELECT path FROM images WHERE guild_id = ?")
    .all(input.guildId) as Array<{ path: string }>;

  const memoriesDeleted = (input.db.raw
    .prepare("DELETE FROM memories WHERE guild_id = ?")
    .run(input.guildId) as { changes: number }).changes;
  input.db.raw.prepare("DELETE FROM images WHERE guild_id = ?").run(input.guildId);
  input.db.raw.prepare("DELETE FROM message_assets WHERE guild_id = ?").run(input.guildId);
  input.db.raw.prepare("DELETE FROM asset_backfill_checkpoints WHERE guild_id = ?").run(input.guildId);
  input.db.raw.prepare("DELETE FROM message_reactions WHERE guild_id = ?").run(input.guildId);
  const messagesDeleted = (input.db.raw
    .prepare("DELETE FROM messages WHERE guild_id = ?")
    .run(input.guildId) as { changes: number }).changes;

  deleteImageFiles(imageRows.map((row) => row.path));
  return { memoriesDeleted, messagesDeleted, imagesDeleted: imageRows.length };
}
