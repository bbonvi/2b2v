import type { Database } from "./database.ts";

export interface ImageRecord {
  id: number;
  messageId: string;
  guildId: string;
  channelId: string;
  caption: string | null;
  path: string;
  mime: string;
  width: number;
  height: number;
  createdAt: number;
}

export interface InsertImageInput {
  messageId: string;
  guildId: string;
  channelId: string;
  path: string;
  mime: string;
  width: number;
  height: number;
  createdAt: number;
  caption?: string;
}

/**
 * Insert an image record and return the full record with autoincrement ID.
 */
export function insertImage(db: Database, input: InsertImageInput): ImageRecord {
  const stmt = db.raw.prepare(
    `INSERT INTO images (message_id, guild_id, channel_id, caption, path, mime, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    input.messageId,
    input.guildId,
    input.channelId,
    input.caption ?? null,
    input.path,
    input.mime,
    input.width,
    input.height,
    input.createdAt,
  );

  const id = db.raw.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };

  return {
    id: id.id,
    messageId: input.messageId,
    guildId: input.guildId,
    channelId: input.channelId,
    caption: input.caption ?? null,
    path: input.path,
    mime: input.mime,
    width: input.width,
    height: input.height,
    createdAt: input.createdAt,
  };
}

/**
 * Get all images for a message, ordered by ID ascending.
 */
export function getImagesByMessageId(db: Database, messageId: string): ImageRecord[] {
  const rows = db.raw
    .prepare(
      `SELECT id, message_id, guild_id, channel_id, caption, path, mime, width, height, created_at
       FROM images WHERE message_id = ? ORDER BY id ASC`
    )
    .all(messageId) as Array<{
      id: number;
      message_id: string;
      guild_id: string;
      channel_id: string;
      caption: string | null;
      path: string;
      mime: string;
      width: number;
      height: number;
      created_at: number;
    }>;

  return rows.map(toRecord);
}

/**
 * Get a single image by its ID.
 */
export function getImageById(db: Database, imageId: number): ImageRecord | null {
  const row = db.raw
    .prepare(
      `SELECT id, message_id, guild_id, channel_id, caption, path, mime, width, height, created_at
       FROM images WHERE id = ?`
    )
    .get(imageId) as {
      id: number;
      message_id: string;
      guild_id: string;
      channel_id: string;
      caption: string | null;
      path: string;
      mime: string;
      width: number;
      height: number;
      created_at: number;
    } | null;

  return row !== null ? toRecord(row) : null;
}

function toRecord(row: {
  id: number;
  message_id: string;
  guild_id: string;
  channel_id: string;
  caption: string | null;
  path: string;
  mime: string;
  width: number;
  height: number;
  created_at: number;
}): ImageRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    caption: row.caption,
    path: row.path,
    mime: row.mime,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}
