import type { Database } from "./database.ts";

export type PersistedAgentJobState = "active" | "terminal" | "all";

/** Durable generic job row; kind-specific payloads remain serialized at this layer. */
export interface AgentJobRecord {
  id: string;
  kind: string;
  parentJobId: string | null;
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
  checkpointJson: string | null;
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
  statusChangedAt: number;
  handoffNotifiedAt: number | null;
  readyNotificationPending: number;
}

export interface AgentJobRecordPatch {
  status?: string;
  checkpointJson?: string | null;
  resultJson?: string | null;
  error?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  sentMessageId?: string | null;
  cancelReason?: string | null;
  statusChangedAt?: number;
  handoffNotifiedAt?: number | null;
  readyNotificationPending?: number;
}

export interface AgentJobEventRecord {
  id: number;
  jobId: string;
  sourceJobId: string | null;
  kind: "message" | "child_result";
  payloadJson: string;
  createdAt: number;
  consumedAt: number | null;
}

const ACTIVE_JOB_STATUSES = ["queued", "running", "waiting_on_jobs", "ready", "yielded"] as const;

/** Insert a newly accepted job before its worker starts. */
export function createAgentJobRecord(db: Database, record: AgentJobRecord): void {
  db.raw.prepare(`INSERT INTO agent_jobs
    (id, kind, parent_job_id, guild_id, channel_id, delivery_guild_id, delivery_channel_id,
     requester_id, requester_username, source_message_id, source_quote, status,
     input_json, checkpoint_json, result_json, error, created_at, started_at, completed_at,
     sent_message_id, replacement_root_job_id, replaces_job_id, replacement_count,
     cancel_reason, status_changed_at, handoff_notified_at, ready_notification_pending)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      record.id,
      record.kind,
      record.parentJobId,
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
      record.checkpointJson,
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
      record.statusChangedAt,
      record.handoffNotifiedAt,
      record.readyNotificationPending,
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
    ["checkpointJson", "checkpoint_json"],
    ["resultJson", "result_json"],
    ["error", "error"],
    ["startedAt", "started_at"],
    ["completedAt", "completed_at"],
    ["sentMessageId", "sent_message_id"],
    ["cancelReason", "cancel_reason"],
    ["statusChangedAt", "status_changed_at"],
    ["handoffNotifiedAt", "handoff_notified_at"],
    ["readyNotificationPending", "ready_notification_pending"],
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

/** List jobs globally or within one source/delivery channel. */
export function listAgentJobRecords(db: Database, input: {
  guildId?: string;
  channelId?: string;
  imageGenerationRunId?: string;
  state?: PersistedAgentJobState;
  completedAfter?: number;
  limit?: number;
  newestFirst?: boolean;
}): AgentJobRecord[] {
  if ((input.guildId === undefined) !== (input.channelId === undefined)) {
    throw new Error("Agent job scope requires both guildId and channelId.");
  }
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (input.guildId !== undefined && input.channelId !== undefined) {
    conditions.push("((guild_id = ? AND channel_id = ?) OR (delivery_guild_id = ? AND delivery_channel_id = ?))");
    params.push(input.guildId, input.channelId, input.guildId, input.channelId);
  }
  if (input.imageGenerationRunId !== undefined) {
    conditions.push("kind = 'image_generation' AND json_extract(input_json, '$.generationRunId') = ?");
    params.push(input.imageGenerationRunId);
  }
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
  params.push(input.limit ?? 100);
  return (db.raw.prepare(`SELECT * FROM agent_jobs
    WHERE ${conditions.length > 0 ? conditions.join(" AND ") : "1 = 1"}
    ORDER BY created_at ${direction}, id ${direction}
    LIMIT ?`).all(...params) as AgentJobRow[]).map(toRecord);
}

/** List direct child jobs in stable creation order. */
export function listChildAgentJobRecords(db: Database, parentJobId: string): AgentJobRecord[] {
  return (db.raw.prepare(`SELECT * FROM agent_jobs
    WHERE parent_job_id = ? ORDER BY created_at ASC, id ASC`).all(parentJobId) as AgentJobRow[]).map(toRecord);
}

/** Add one durable follow-up. Child results are idempotent by source job. */
export function createAgentJobEvent(db: Database, input: {
  jobId: string;
  sourceJobId?: string;
  kind: AgentJobEventRecord["kind"];
  payloadJson: string;
  createdAt: number;
}): boolean {
  return db.raw.prepare(`INSERT OR IGNORE INTO agent_job_events
    (job_id, source_job_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(input.jobId, input.sourceJobId ?? null, input.kind, input.payloadJson, input.createdAt).changes > 0;
}

/** Return unread follow-ups without consuming them. */
export function listPendingAgentJobEvents(db: Database, jobId: string): AgentJobEventRecord[] {
  return (db.raw.prepare(`SELECT * FROM agent_job_events
    WHERE job_id = ? AND consumed_at IS NULL ORDER BY created_at ASC, id ASC`)
    .all(jobId) as AgentJobEventRow[]).map(toEventRecord);
}

/** Consume the exact events included in a persisted checkpoint. */
export function consumeAgentJobEvents(db: Database, jobId: string, ids: readonly number[], now: number): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  return db.raw.prepare(`UPDATE agent_job_events SET consumed_at = ?
    WHERE job_id = ? AND consumed_at IS NULL AND id IN (${placeholders})`)
    .run(now, jobId, ...ids).changes;
}

/** Close notified background agents after their continuation window. */
export function dismissStaleYieldedAgentJobs(
  db: Database,
  notificationDeliveredBefore: number,
  now = Date.now(),
): number {
  return db.raw.prepare(`UPDATE agent_jobs
    SET status = 'dismissed', completed_at = ?, status_changed_at = ?, cancel_reason = ?
    WHERE kind = 'background_agent'
      AND status = 'yielded'
      AND handoff_notified_at IS NOT NULL
      AND handoff_notified_at <= ?`)
    .run(now, now, "Automatically dismissed after the yielded agent stayed paused without a follow-up.", notificationDeliveredBefore)
    .changes;
}

/** Requeue work whose process ended before it reached a durable boundary. */
export function requeueInterruptedAgentJobs(db: Database, now = Date.now()): number {
  return db.raw.prepare(`UPDATE agent_jobs
    SET status = 'queued', started_at = NULL, completed_at = NULL, status_changed_at = ?, error = NULL
    WHERE status = 'running'`)
    .run(now).changes;
}

/** Delete old terminal jobs only after all durable output-asset provenance is gone. */
export function deleteExpiredUnlinkedAgentJobs(db: Database, completedBefore: number): number {
  return db.raw.prepare(`DELETE FROM agent_jobs
    WHERE completed_at IS NOT NULL AND completed_at < ?
      AND NOT EXISTS (SELECT 1 FROM agent_job_assets WHERE agent_job_assets.job_id = agent_jobs.id)`)
    .run(completedBefore).changes;
}

export function linkAgentJobAsset(db: Database, jobId: string, assetId: number, role: string): void {
  db.raw.prepare("INSERT OR IGNORE INTO agent_job_assets (job_id, asset_id, role) VALUES (?, ?, ?)")
    .run(jobId, assetId, role);
}

export function listAgentJobAssets(db: Database, jobId: string): Array<{ assetId: number; role: string }> {
  const rows = db.raw.prepare("SELECT asset_id, role FROM agent_job_assets WHERE job_id = ? ORDER BY asset_id ASC")
    .all(jobId) as Array<{ asset_id: number; role: string }>;
  return rows.map((row) => ({ assetId: row.asset_id, role: row.role }));
}

export function getAgentJobForAsset(db: Database, assetId: number): { record: AgentJobRecord; role: string } | null {
  const row = db.raw.prepare(`SELECT j.*, a.role AS asset_role
    FROM agent_job_assets a JOIN agent_jobs j ON j.id = a.job_id
    WHERE a.asset_id = ? ORDER BY j.created_at DESC LIMIT 1`)
    .get(assetId) as (AgentJobRow & { asset_role: string }) | null;
  return row === null ? null : { record: toRecord(row), role: row.asset_role };
}

interface AgentJobRow {
  id: string;
  kind: string;
  parent_job_id: string | null;
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
  checkpoint_json: string | null;
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
  status_changed_at: number;
  handoff_notified_at: number | null;
  ready_notification_pending: number;
}

interface AgentJobEventRow {
  id: number;
  job_id: string;
  source_job_id: string | null;
  kind: AgentJobEventRecord["kind"];
  payload_json: string;
  created_at: number;
  consumed_at: number | null;
}

function toRecord(row: AgentJobRow): AgentJobRecord {
  return {
    id: row.id,
    kind: row.kind,
    parentJobId: row.parent_job_id,
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
    checkpointJson: row.checkpoint_json,
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
    statusChangedAt: row.status_changed_at,
    handoffNotifiedAt: row.handoff_notified_at,
    readyNotificationPending: row.ready_notification_pending,
  };
}

function toEventRecord(row: AgentJobEventRow): AgentJobEventRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    sourceJobId: row.source_job_id,
    kind: row.kind,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
  };
}
