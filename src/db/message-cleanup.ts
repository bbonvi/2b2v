import { unlinkSync } from "fs";
import type { QdrantClient } from "@qdrant/js-client-rest";
import type { Database } from "./database.ts";
import {
  deleteBotMessageState,
  deleteRecentMessages,
  markDiscordMessageDeleted,
} from "./message-repository.ts";
import { deleteMessagePointsByGuildId, deleteMessagePointsByMessageId } from "../qdrant/adapter.ts";

export interface CleanupResult {
  messagesDeleted: number;
  imagesDeleted: number;
}

export interface GuildWipeResult extends CleanupResult {
  memoriesDeleted: number;
}

export type DeleteMessagePoints = (guildId: string, messageId: string) => Promise<void>;
export type DeleteGuildMessagePoints = (guildId: string) => Promise<void>;

export function deleteImageFiles(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {
      // Best effort: rows/vectors are the source of truth; missing files should not break cleanup.
    }
  }
}

function qdrantDeleter(qdrant: QdrantClient): DeleteMessagePoints {
  return (guildId, messageId) => deleteMessagePointsByMessageId(qdrant, { guildId, messageId });
}

function qdrantGuildDeleter(qdrant: QdrantClient): DeleteGuildMessagePoints {
  return (guildId) => deleteMessagePointsByGuildId(qdrant, guildId);
}

async function deleteVectorPoints(
  guildId: string,
  messageIds: readonly string[],
  deleteMessagePoints: DeleteMessagePoints,
): Promise<void> {
  await Promise.all(messageIds.map((messageId) => deleteMessagePoints(guildId, messageId)));
}

export async function cleanupDeletedBotMessage(input: {
  db: Database;
  qdrant: QdrantClient;
  messageId: string;
  guildId: string;
  channelId: string;
  botUserId: string;
  deleteMessagePoints?: DeleteMessagePoints;
}): Promise<CleanupResult> {
  const deleted = deleteBotMessageState(input.db, {
    id: input.messageId,
    guildId: input.guildId,
    channelId: input.channelId,
    botUserId: input.botUserId,
  });

  await (input.deleteMessagePoints ?? qdrantDeleter(input.qdrant))(input.guildId, input.messageId);
  if (!deleted.deleted) return { messagesDeleted: 0, imagesDeleted: 0 };

  deleteImageFiles(deleted.imagePaths);
  return { messagesDeleted: 1, imagesDeleted: deleted.imageCount };
}

export async function cleanupDeletedDiscordMessage(input: {
  db: Database;
  qdrant: QdrantClient;
  guildId: string;
  messageId: string;
  deleteMessagePoints?: DeleteMessagePoints;
}): Promise<CleanupResult> {
  const deleted = markDiscordMessageDeleted(input.db, {
    id: input.messageId,
    guildId: input.guildId,
  });
  if (!deleted.deleted) return { messagesDeleted: 0, imagesDeleted: 0 };

  await (input.deleteMessagePoints ?? qdrantDeleter(input.qdrant))(input.guildId, input.messageId);
  deleteImageFiles(deleted.imagePaths);
  return { messagesDeleted: 1, imagesDeleted: deleted.imageCount };
}

export async function cleanupRecentMessages(input: {
  db: Database;
  qdrant: QdrantClient;
  guildId: string;
  channelId: string;
  count: number;
  deleteMessagePoints?: DeleteMessagePoints;
}): Promise<CleanupResult> {
  const deleted = deleteRecentMessages(input.db, input.channelId, input.count);
  await deleteVectorPoints(
    input.guildId,
    deleted.messageIds,
    input.deleteMessagePoints ?? qdrantDeleter(input.qdrant),
  );
  deleteImageFiles(deleted.imagePaths);
  return { messagesDeleted: deleted.messageIds.length, imagesDeleted: deleted.imagePaths.length };
}

export async function cleanupGuildData(input: {
  db: Database;
  qdrant: QdrantClient;
  guildId: string;
  deleteGuildMessagePoints?: DeleteGuildMessagePoints;
}): Promise<GuildWipeResult> {
  const imageRows = input.db.raw
    .prepare("SELECT path FROM images WHERE guild_id = ?")
    .all(input.guildId) as Array<{ path: string }>;

  const memoriesDeleted = (input.db.raw
    .prepare("DELETE FROM memories WHERE guild_id = ?")
    .run(input.guildId) as { changes: number }).changes;
  input.db.raw.prepare("DELETE FROM images WHERE guild_id = ?").run(input.guildId);
  input.db.raw.prepare("DELETE FROM message_reactions WHERE guild_id = ?").run(input.guildId);
  const messagesDeleted = (input.db.raw
    .prepare("DELETE FROM messages WHERE guild_id = ?")
    .run(input.guildId) as { changes: number }).changes;

  await (input.deleteGuildMessagePoints ?? qdrantGuildDeleter(input.qdrant))(input.guildId);
  deleteImageFiles(imageRows.map((row) => row.path));
  return { memoriesDeleted, messagesDeleted, imagesDeleted: imageRows.length };
}
