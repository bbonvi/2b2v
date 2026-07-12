import type { Database } from "./database.ts";

export type AssetSourceKind = "attachment" | "embed" | "sticker";
export type AssetKind = "image" | "gif" | "audio" | "video" | "text" | "file";

export interface MessageAsset {
  id: number;
  messageId: string;
  guildId: string;
  channelId: string;
  sourceKind: AssetSourceKind;
  sourceKey: string;
  kind: AssetKind;
  filename: string | null;
  contentType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  extractedText: string | null;
  extractionProvider: string | null;
  extractedAt: number | null;
  createdAt: number;
}

export type UpsertMessageAsset = Omit<MessageAsset, "id" | "extractedText" | "extractionProvider" | "extractedAt">;

/** Replace one message's asset metadata while preserving stable local IDs for unchanged sources. */
export function syncMessageAssets(db: Database, input: {
  messageId: string;
  assets: readonly UpsertMessageAsset[];
  indexedAt?: number;
}): MessageAsset[] {
  db.raw.run("BEGIN TRANSACTION");
  try {
    syncMessageAssetsInTransaction(db, input);
    db.raw.run("COMMIT");
  } catch (error) {
    db.raw.run("ROLLBACK");
    throw error;
  }
  return getAssetsByMessageId(db, input.messageId);
}

function syncMessageAssetsInTransaction(db: Database, input: {
  messageId: string;
  assets: readonly UpsertMessageAsset[];
  indexedAt?: number;
}): void {
  const upsert = db.raw.prepare(`INSERT INTO message_assets
    (message_id, guild_id, channel_id, source_kind, source_key, kind, filename, content_type, size, width, height, duration_seconds, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id, source_kind, source_key) DO UPDATE SET
      guild_id = excluded.guild_id,
      channel_id = excluded.channel_id,
      kind = excluded.kind,
      filename = excluded.filename,
      content_type = excluded.content_type,
      size = excluded.size,
      width = excluded.width,
      height = excluded.height,
      duration_seconds = excluded.duration_seconds`);
  const keep = new Set<string>();
  for (const asset of input.assets) {
      upsert.run(
        asset.messageId, asset.guildId, asset.channelId, asset.sourceKind, asset.sourceKey,
        asset.kind, asset.filename, asset.contentType, asset.size, asset.width, asset.height,
        asset.durationSeconds, asset.createdAt,
      );
      keep.add(`${asset.sourceKind}\0${asset.sourceKey}`);
  }
  const existing = db.raw.prepare("SELECT id, source_kind, source_key FROM message_assets WHERE message_id = ?")
      .all(input.messageId) as Array<{ id: number; source_kind: AssetSourceKind; source_key: string }>;
    const remove = db.raw.prepare("DELETE FROM message_assets WHERE id = ?");
  for (const row of existing) {
    if (!keep.has(`${row.source_kind}\0${row.source_key}`)) remove.run(row.id);
  }
  db.raw.prepare("UPDATE messages SET assets_indexed_at = ? WHERE id = ?")
    .run(input.indexedAt ?? Date.now(), input.messageId);
}

/** Atomically index one Discord history page and advance its resumable channel cursor. */
export function syncAssetBackfillPage(db: Database, input: {
  guildId: string;
  channelId: string;
  beforeMessageId: string | null;
  completed: boolean;
  messages: ReadonlyArray<{ messageId: string; assets: readonly UpsertMessageAsset[] }>;
}): void {
  const now = Date.now();
  db.raw.run("BEGIN TRANSACTION");
  try {
    for (const message of input.messages) {
      syncMessageAssetsInTransaction(db, { messageId: message.messageId, assets: message.assets, indexedAt: now });
    }
    db.raw.prepare(`INSERT INTO asset_backfill_checkpoints (channel_id, guild_id, before_message_id, completed_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET before_message_id = excluded.before_message_id,
        completed_at = excluded.completed_at, updated_at = excluded.updated_at`)
      .run(input.channelId, input.guildId, input.beforeMessageId, input.completed ? now : null, now);
    db.raw.run("COMMIT");
  } catch (error) {
    db.raw.run("ROLLBACK");
    throw error;
  }
}

/** Retrieve assets for one stored Discord message in stable ID order. */
export function getAssetsByMessageId(db: Database, messageId: string): MessageAsset[] {
  return (db.raw.prepare("SELECT * FROM message_assets WHERE message_id = ? ORDER BY id ASC").all(messageId) as AssetRow[]).map(toAsset);
}

/** Retrieve one asset by its short prompt-visible ID. */
export function getAssetById(db: Database, id: number): MessageAsset | null {
  const row = db.raw.prepare("SELECT * FROM message_assets WHERE id = ?").get(id) as AssetRow | null;
  return row === null ? null : toAsset(row);
}

/** Cache immutable extracted text or a paid transcript for later paginated reads. */
export function cacheAssetExtraction(db: Database, id: number, text: string, provider: string): void {
  db.raw.prepare("UPDATE message_assets SET extracted_text = ?, extraction_provider = ?, extracted_at = ? WHERE id = ?")
    .run(text, provider, Date.now(), id);
}

interface AssetRow {
  id: number;
  message_id: string;
  guild_id: string;
  channel_id: string;
  source_kind: AssetSourceKind;
  source_key: string;
  kind: AssetKind;
  filename: string | null;
  content_type: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  extracted_text: string | null;
  extraction_provider: string | null;
  extracted_at: number | null;
  created_at: number;
}

function toAsset(row: AssetRow): MessageAsset {
  return {
    id: row.id, messageId: row.message_id, guildId: row.guild_id, channelId: row.channel_id,
    sourceKind: row.source_kind, sourceKey: row.source_key, kind: row.kind, filename: row.filename,
    contentType: row.content_type, size: row.size, width: row.width, height: row.height,
    durationSeconds: row.duration_seconds, extractedText: row.extracted_text,
    extractionProvider: row.extraction_provider, extractedAt: row.extracted_at, createdAt: row.created_at,
  };
}
