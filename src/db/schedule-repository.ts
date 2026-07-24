import type { Database } from "./database";

export type ScheduleSource = "admin" | "bot" | "tool";
export type ScheduleType = "cron" | "one_off";

export interface ScheduleRow {
  id: string;
  guildId: string;
  channelId: string;
  source: ScheduleSource;
  type: ScheduleType;
  cronExpression: string | null;
  runAt: number | null;
  timezone: string;
  messageContent: string;
  createdByUserId: string | null;
  createdByUsername: string | null;
  handoffNote: string;
  fireCount: number;
  expiresAt: number | null;
  maxFireCount: number | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateScheduleInput {
  guildId: string;
  channelId: string;
  source: ScheduleSource;
  type: ScheduleType;
  cronExpression?: string;
  runAt?: number;
  timezone: string;
  messageContent: string;
  createdByUserId?: string;
  createdByUsername?: string;
  handoffNote?: string;
  fireCount?: number;
  expiresAt?: number;
  maxFireCount?: number;
  enabled?: boolean;
}

export interface UpdateScheduleInput {
  cronExpression?: string;
  runAt?: number;
  timezone?: string;
  messageContent?: string;
  handoffNote?: string;
  fireCount?: number;
  expiresAt?: number | null;
  maxFireCount?: number | null;
  enabled?: boolean;
  channelId?: string;
}

export interface ListSchedulesFilter {
  guildId?: string;
  source?: ScheduleSource;
  enabled?: boolean;
  channelId?: string;
  createdByUserId?: string;
}

export interface PendingSchedulesFilter {
  guildId?: string;
  channelId?: string;
  createdByUserId?: string;
}

export function createSchedule(db: Database, input: CreateScheduleInput): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  const enabled = input.enabled ?? true;

  db.raw
    .prepare(
      `INSERT INTO schedules (id, guild_id, channel_id, source, type, cron_expression, run_at, timezone, message_content, created_by_user_id, created_by_username, handoff_note, fire_count, expires_at, max_fire_count, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.guildId,
      input.channelId,
      input.source,
      input.type,
      input.cronExpression ?? null,
      input.runAt ?? null,
      input.timezone,
      input.messageContent,
      input.createdByUserId ?? null,
      input.createdByUsername ?? null,
      input.handoffNote ?? "",
      input.fireCount ?? 0,
      input.expiresAt ?? null,
      input.maxFireCount ?? null,
      enabled ? 1 : 0,
      now,
      now
    );

  return id;
}

export function getSchedule(db: Database, id: string): ScheduleRow | null {
  const row = db.raw.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return mapRow(row);
}

export function updateSchedule(db: Database, id: string, input: UpdateScheduleInput): boolean {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (input.cronExpression !== undefined) {
    sets.push("cron_expression = ?");
    params.push(input.cronExpression);
  }
  if (input.runAt !== undefined) {
    sets.push("run_at = ?");
    params.push(input.runAt);
  }
  if (input.timezone !== undefined) {
    sets.push("timezone = ?");
    params.push(input.timezone);
  }
  if (input.messageContent !== undefined) {
    sets.push("message_content = ?");
    params.push(input.messageContent);
  }
  if (input.handoffNote !== undefined) {
    sets.push("handoff_note = ?");
    params.push(input.handoffNote);
  }
  if (input.fireCount !== undefined) {
    sets.push("fire_count = ?");
    params.push(input.fireCount);
  }
  if (input.expiresAt !== undefined) {
    sets.push("expires_at = ?");
    params.push(input.expiresAt);
  }
  if (input.maxFireCount !== undefined) {
    sets.push("max_fire_count = ?");
    params.push(input.maxFireCount);
  }
  if (input.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(input.enabled ? 1 : 0);
  }
  if (input.channelId !== undefined) {
    sets.push("channel_id = ?");
    params.push(input.channelId);
  }

  if (sets.length === 0) return false;

  sets.push("updated_at = ?");
  params.push(Date.now());
  params.push(id);

  const result = db.raw.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return result.changes > 0;
}

export function incrementScheduleFireCount(db: Database, id: string): ScheduleRow | null {
  db.raw.prepare("UPDATE schedules SET fire_count = fire_count + 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
  return getSchedule(db, id);
}

export function deleteSchedule(db: Database, id: string): boolean {
  const result = db.raw.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  return result.changes > 0;
}

export function deleteScheduleForGuild(db: Database, id: string, guildId: string): boolean {
  const result = db.raw
    .prepare("DELETE FROM schedules WHERE id = ? AND guild_id = ?")
    .run(id, guildId);
  return result.changes > 0;
}

export function deletePendingSchedule(db: Database, id: string, filter: PendingSchedulesFilter): boolean {
  if (filter.guildId === undefined) return false;
  const conditions = [
    "id = ?",
    "guild_id = ?",
    "enabled = 1",
    "(type = 'cron' OR (type = 'one_off' AND run_at IS NOT NULL AND run_at > ?))",
    "(expires_at IS NULL OR expires_at > ?)",
    "(max_fire_count IS NULL OR fire_count < max_fire_count)",
  ];
  const now = Date.now();
  const params: (string | number)[] = [id, filter.guildId, now, now];

  if (filter.channelId !== undefined) {
    conditions.push("channel_id = ?");
    params.push(filter.channelId);
  }
  if (filter.createdByUserId !== undefined) {
    conditions.push("created_by_user_id = ?");
    params.push(filter.createdByUserId);
  }

  const result = db.raw
    .prepare(`DELETE FROM schedules WHERE ${conditions.join(" AND ")}`)
    .run(...params);
  return result.changes > 0;
}

export function listSchedules(db: Database, filter: ListSchedulesFilter): ScheduleRow[] {
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (filter.guildId !== undefined) {
    conditions.push("guild_id = ?");
    params.push(filter.guildId);
  }

  if (filter.source !== undefined) {
    conditions.push("source = ?");
    params.push(filter.source);
  }
  if (filter.enabled !== undefined) {
    conditions.push("enabled = ?");
    params.push(filter.enabled ? 1 : 0);
  }
  if (filter.channelId !== undefined) {
    conditions.push("channel_id = ?");
    params.push(filter.channelId);
  }

  const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  const sql = `SELECT * FROM schedules ${where} ORDER BY created_at ASC`;
  const rows = db.raw.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/** List pending schedules. Cron schedules are pending while enabled; one-offs must still be in the future. */
export function listPendingSchedules(db: Database, filter: PendingSchedulesFilter): ScheduleRow[] {
  const conditions = [
    "enabled = 1",
    "(type = 'cron' OR (type = 'one_off' AND run_at IS NOT NULL AND run_at > ?))",
    "(expires_at IS NULL OR expires_at > ?)",
    "(max_fire_count IS NULL OR fire_count < max_fire_count)",
  ];
  const now = Date.now();
  const params: (string | number)[] = [now, now];

  if (filter.guildId !== undefined) {
    conditions.unshift("guild_id = ?");
    params.unshift(filter.guildId);
  }

  if (filter.channelId !== undefined) {
    conditions.push("channel_id = ?");
    params.push(filter.channelId);
  }

  const sql = `
    SELECT * FROM schedules
    WHERE ${conditions.join(" AND ")}
    ORDER BY
      CASE type WHEN 'one_off' THEN 0 ELSE 1 END ASC,
      COALESCE(run_at, 0) ASC,
      cron_expression ASC,
      id ASC
  `;
  const rows = db.raw.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/** List pending schedules for inclusion in LLM context. */
export function listUpcomingForContext(db: Database, guildId: string, channelId?: string): ScheduleRow[] {
  return listPendingSchedules(db, { guildId, channelId });
}

function mapRow(row: Record<string, unknown>): ScheduleRow {
  return {
    id: row.id as string,
    guildId: row.guild_id as string,
    channelId: row.channel_id as string,
    source: row.source as ScheduleSource,
    type: row.type as ScheduleType,
    cronExpression: row.cron_expression as string | null,
    runAt: row.run_at as number | null,
    timezone: row.timezone as string,
    messageContent: row.message_content as string,
    createdByUserId: row.created_by_user_id as string | null,
    createdByUsername: row.created_by_username as string | null,
    handoffNote: (row.handoff_note as string | null) ?? "",
    fireCount: (row.fire_count as number | null) ?? 0,
    expiresAt: row.expires_at as number | null,
    maxFireCount: row.max_fire_count as number | null,
    enabled: (row.enabled as number) === 1,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
