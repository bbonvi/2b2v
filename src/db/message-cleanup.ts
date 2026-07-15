import type { Database } from "./database.ts";
import {
  deleteBotMessageState,
  deleteRecentMessages,
  markDiscordMessageDeleted,
} from "./message-repository.ts";

export interface CleanupResult {
  messagesDeleted: number;
}

export interface GuildWipeResult extends CleanupResult {
  memoriesDeleted: number;
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

  return { messagesDeleted: deleted.deleted ? 1 : 0 };
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
  return { messagesDeleted: deleted.deleted ? 1 : 0 };
}

export function cleanupRecentMessages(input: {
  db: Database;
  channelId: string;
  count: number;
}): CleanupResult {
  const deleted = deleteRecentMessages(input.db, input.channelId, input.count);
  return { messagesDeleted: deleted.messageIds.length };
}

export function cleanupGuildData(input: {
  db: Database;
  guildId: string;
}): GuildWipeResult {
  const memoriesDeleted = (input.db.raw
    .prepare("DELETE FROM memories WHERE recall_scope = 'guild' AND recall_guild_id = ?")
    .run(input.guildId) as { changes: number }).changes;
  input.db.raw.prepare("DELETE FROM agent_jobs WHERE guild_id = ? OR delivery_guild_id = ?")
    .run(input.guildId, input.guildId);
  input.db.raw.prepare("DELETE FROM message_assets WHERE guild_id = ?").run(input.guildId);
  input.db.raw.prepare("DELETE FROM asset_backfill_checkpoints WHERE guild_id = ?").run(input.guildId);
  input.db.raw.prepare("DELETE FROM message_reactions WHERE guild_id = ?").run(input.guildId);
  const messagesDeleted = (input.db.raw
    .prepare("DELETE FROM messages WHERE guild_id = ?")
    .run(input.guildId) as { changes: number }).changes;

  return { memoriesDeleted, messagesDeleted };
}
