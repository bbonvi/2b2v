import type { Database } from "./database.ts";

export interface StagedAsset {
  ref: string;
  jobId: string;
  ownerGuildId: string;
  ownerChannelId: string;
  filename: string;
  contentType: string;
  storagePath: string;
  createdAt: number;
  expiresAt: number;
  deliveredMessageId?: string;
  permanentAssetId?: number;
}

interface StagedAssetRow {
  ref: string;
  job_id: string;
  owner_guild_id: string;
  owner_channel_id: string;
  filename: string;
  content_type: string;
  storage_path: string;
  created_at: number;
  expires_at: number;
  delivered_message_id: string | null;
  permanent_asset_id: number | null;
}

function fromRow(row: StagedAssetRow): StagedAsset {
  return {
    ref: row.ref,
    jobId: row.job_id,
    ownerGuildId: row.owner_guild_id,
    ownerChannelId: row.owner_channel_id,
    filename: row.filename,
    contentType: row.content_type,
    storagePath: row.storage_path,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.delivered_message_id !== null
      ? { deliveredMessageId: row.delivered_message_id }
      : {}),
    ...(row.permanent_asset_id !== null ? { permanentAssetId: row.permanent_asset_id } : {}),
  };
}

/** Persist a generated output before any discretionary delivery turn starts. */
export function createStagedAsset(db: Database, asset: StagedAsset): void {
  db.raw.prepare(
    `INSERT INTO staged_assets
      (ref, job_id, owner_guild_id, owner_channel_id, filename, content_type,
       storage_path, created_at, expires_at, delivered_message_id, permanent_asset_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    asset.ref,
    asset.jobId,
    asset.ownerGuildId,
    asset.ownerChannelId,
    asset.filename,
    asset.contentType,
    asset.storagePath,
    asset.createdAt,
    asset.expiresAt,
    asset.deliveredMessageId ?? null,
    asset.permanentAssetId ?? null,
  );
}

export function getStagedAsset(db: Database, ref: string): StagedAsset | null {
  const row = db.raw.prepare("SELECT * FROM staged_assets WHERE ref = ?")
    .get(ref) as StagedAssetRow | null;
  return row === null ? null : fromRow(row);
}

export function getStagedAssetForJob(db: Database, jobId: string): StagedAsset | null {
  const row = db.raw.prepare("SELECT * FROM staged_assets WHERE job_id = ?")
    .get(jobId) as StagedAssetRow | null;
  return row === null ? null : fromRow(row);
}

export function listStagedAssets(
  db: Database,
  input: { guildId?: string; channelId?: string; unresolvedOnly?: boolean; limit?: number } = {},
): StagedAsset[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (input.guildId !== undefined) {
    conditions.push("owner_guild_id = ?");
    params.push(input.guildId);
  }
  if (input.channelId !== undefined) {
    conditions.push("owner_channel_id = ?");
    params.push(input.channelId);
  }
  if (input.unresolvedOnly === true) conditions.push("delivered_message_id IS NULL");
  params.push(input.limit ?? 100);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return (db.raw.prepare(
    `SELECT * FROM staged_assets ${where} ORDER BY created_at DESC, ref DESC LIMIT ?`,
  ).all(...params) as StagedAssetRow[]).map(fromRow);
}

export function reconcileStagedAsset(
  db: Database,
  input: {
    ref: string;
    deliveredMessageId: string;
    permanentAssetId?: number;
  },
): boolean {
  return db.raw.prepare(
    `UPDATE staged_assets
     SET delivered_message_id = ?, permanent_asset_id = ?
     WHERE ref = ? AND delivered_message_id IS NULL`,
  ).run(
    input.deliveredMessageId,
    input.permanentAssetId ?? null,
    input.ref,
  ).changes > 0;
}

export function deleteStagedAsset(db: Database, ref: string): boolean {
  return db.raw.prepare("DELETE FROM staged_assets WHERE ref = ?").run(ref).changes > 0;
}
