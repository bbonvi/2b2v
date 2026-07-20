import type { Database } from "./database.ts";

export type PersistedAgentJobState = "active" | "terminal" | "all";

/** Durable generic job row; kind-specific payloads remain serialized at this layer. */
export interface AgentJobRecord {
  id: string;
  kind: string;
  guildId: string;
  channelId: string;
  deliveryGuildId: string;
  deliveryChannelId: string;
  requesterId: string;
  requesterUsername: string;
  sourceMessageId: string;
  sourceQuote: string;
  status: string;
  inputJson: string;
  resultJson: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  sentMessageId: string | null;
  replacementRootJobId: string | null;
  replacesJobId: string | null;
  replacementCount: number;
  cancelReason: string | null;
}

export interface AgentJobRecordPatch {
  status?: string;
  resultJson?: string | null;
  error?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  sentMessageId?: string | null;
  cancelReason?: string | null;
}

const ACTIVE_JOB_STATUSES = ["queued", "running", "ready"] as const;

/** Insert a newly accepted agent job before its worker starts. */
export function createAgentJobRecord(db: Database, record: AgentJobRecord): void {
  db.raw.prepare(`INSERT INTO agent_jobs
    (id, kind, guild_id, channel_id, delivery_guild_id, delivery_channel_id,
     requester_id, requester_username, source_message_id, source_quote, status,
     input_json, result_json, error, created_at, started_at, completed_at,
     sent_message_id, replacement_root_job_id, replaces_job_id, replacement_count,
     cancel_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      record.id,
      record.kind,
      record.guildId,
      record.channelId,
      record.deliveryGuildId,
      record.deliveryChannelId,
      record.requesterId,
      record.requesterUsername,
      record.sourceMessageId,
      record.sourceQuote,
      record.status,
      record.inputJson,
      record.resultJson,
      record.error,
      record.createdAt,
      record.startedAt,
      record.completedAt,
      record.sentMessageId,
      record.replacementRootJobId,
      record.replacesJobId,
      record.replacementCount,
      record.cancelReason,
    );
}

/** Retrieve one durable job by its opaque ID. */
export function getAgentJobRecord(db: Database, id: string): AgentJobRecord | null {
  const row = db.raw.prepare("SELECT * FROM agent_jobs WHERE id = ?").get(id) as AgentJobRow | null;
  return row === null ? null : toRecord(row);
}

/** Update lifecycle fields without rewriting immutable request provenance. */
export function updateAgentJobRecord(db: Database, id: string, patch: AgentJobRecordPatch): boolean {
  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  const fields: Array<[keyof AgentJobRecordPatch, string]> = [
    ["status", "status"],
    ["resultJson", "result_json"],
    ["error", "error"],
    ["startedAt", "started_at"],
    ["completedAt", "completed_at"],
    ["sentMessageId", "sent_message_id"],
    ["cancelReason", "cancel_reason"],
  ];
  for (const [key, column] of fields) {
    const value = patch[key];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  if (assignments.length === 0) return false;
  values.push(id);
  return db.raw.prepare(`UPDATE agent_jobs SET ${assignments.join(", ")} WHERE id = ?`).run(...values).changes > 0;
}

/** List channel-visible jobs, optionally filtering active versus terminal lifecycle states. */
export function listAgentJobRecords(db: Database, input: {
  guildId: string;
  channelId: string;
  state?: PersistedAgentJobState;
  completedAfter?: number;
  limit?: number;
  newestFirst?: boolean;
}): AgentJobRecord[] {
  const conditions = [
    "((guild_id = ? AND channel_id = ?) OR (delivery_guild_id = ? AND delivery_channel_id = ?))",
  ];
  const params: Array<string | number> = [input.guildId, input.channelId, input.guildId, input.channelId];
  if (input.state === "active") {
    conditions.push(`status IN (${ACTIVE_JOB_STATUSES.map(() => "?").join(", ")})`);
    params.push(...ACTIVE_JOB_STATUSES);
  } else if (input.state === "terminal") {
    conditions.push(`status NOT IN (${ACTIVE_JOB_STATUSES.map(() => "?").join(", ")})`);
    params.push(...ACTIVE_JOB_STATUSES);
  }
  if (input.completedAfter !== undefined) {
    conditions.push("completed_at IS NOT NULL AND completed_at >= ?");
    params.push(input.completedAfter);
  }
  const direction = input.newestFirst === true ? "DESC" : "ASC";
  const limit = input.limit ?? 100;
  params.push(limit);
  const rows = db.raw.prepare(`SELECT * FROM agent_jobs
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at ${direction}, id ${direction}
    LIMIT ?`).all(...params) as AgentJobRow[];
  return rows.map(toRecord);
}

/** Mark process-owned work left active after a crash as terminal and inspectable. */
export function failInterruptedAgentJobs(db: Database, now = Date.now()): number {
  const result = db.raw.prepare(`UPDATE agent_jobs
    SET status = 'failed', completed_at = ?, error = ?
    WHERE status IN ('queued', 'running')`)
    .run(now, "Interrupted before completion by a process restart.");
  return result.changes;
}

/** Delete old terminal jobs only after all durable output-asset provenance is gone. */
export function deleteExpiredUnlinkedAgentJobs(db: Database, completedBefore: number): number {
  const result = db.raw.prepare(`DELETE FROM agent_jobs
    WHERE completed_at IS NOT NULL
      AND completed_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM agent_job_assets WHERE agent_job_assets.job_id = agent_jobs.id
      )`).run(completedBefore);
  return result.changes;
}

/** Attach a durable chat asset to the job that produced it. */
export function linkAgentJobAsset(db: Database, jobId: string, assetId: number, role: string): void {
  db.raw.prepare("INSERT OR IGNORE INTO agent_job_assets (job_id, asset_id, role) VALUES (?, ?, ?)")
    .run(jobId, assetId, role);
}

/** Return output/provenance assets for one job in stable asset-ID order. */
export function listAgentJobAssets(db: Database, jobId: string): Array<{ assetId: number; role: string }> {
  const rows = db.raw.prepare("SELECT asset_id, role FROM agent_job_assets WHERE job_id = ? ORDER BY asset_id ASC")
    .all(jobId) as Array<{ asset_id: number; role: string }>;
  return rows.map((row) => ({ assetId: row.asset_id, role: row.role }));
}

/** Find the job provenance linked to a stored chat asset. */
export function getAgentJobForAsset(db: Database, assetId: number): { record: AgentJobRecord; role: string } | null {
  const row = db.raw.prepare(`SELECT j.*, a.role AS asset_role
    FROM agent_job_assets a
    JOIN agent_jobs j ON j.id = a.job_id
    WHERE a.asset_id = ?
    ORDER BY j.created_at DESC
    LIMIT 1`).get(assetId) as (AgentJobRow & { asset_role: string }) | null;
  return row === null ? null : { record: toRecord(row), role: row.asset_role };
}

interface AgentJobRow {
  id: string;
  kind: string;
  guild_id: string;
  channel_id: string;
  delivery_guild_id: string;
  delivery_channel_id: string;
  requester_id: string;
  requester_username: string;
  source_message_id: string;
  source_quote: string;
  status: string;
  input_json: string;
  result_json: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  sent_message_id: string | null;
  replacement_root_job_id: string | null;
  replaces_job_id: string | null;
  replacement_count: number;
  cancel_reason: string | null;
}

function toRecord(row: AgentJobRow): AgentJobRecord {
  return {
    id: row.id,
    kind: row.kind,
    guildId: row.guild_id,
    channelId: row.channel_id,
    deliveryGuildId: row.delivery_guild_id,
    deliveryChannelId: row.delivery_channel_id,
    requesterId: row.requester_id,
    requesterUsername: row.requester_username,
    sourceMessageId: row.source_message_id,
    sourceQuote: row.source_quote,
    status: row.status,
    inputJson: row.input_json,
    resultJson: row.result_json,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    sentMessageId: row.sent_message_id,
    replacementRootJobId: row.replacement_root_job_id,
    replacesJobId: row.replaces_job_id,
    replacementCount: row.replacement_count,
    cancelReason: row.cancel_reason,
  };
}
