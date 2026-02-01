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
  enabled?: boolean;
}

export interface UpdateScheduleInput {
  cronExpression?: string;
  runAt?: number;
  timezone?: string;
  messageContent?: string;
  enabled?: boolean;
  channelId?: string;
}

export interface ListSchedulesFilter {
  guildId: string;
  source?: ScheduleSource;
  enabled?: boolean;
}

export function createSchedule(db: Database, input: CreateScheduleInput): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  const enabled = input.enabled ?? true;

  db.raw
    .prepare(
      `INSERT INTO schedules (id, guild_id, channel_id, source, type, cron_expression, run_at, timezone, message_content, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
  const params: unknown[] = [];

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

export function deleteSchedule(db: Database, id: string): boolean {
  const result = db.raw.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  return result.changes > 0;
}

export function listSchedules(db: Database, filter: ListSchedulesFilter): ScheduleRow[] {
  const conditions = ["guild_id = ?"];
  const params: unknown[] = [filter.guildId];

  if (filter.source !== undefined) {
    conditions.push("source = ?");
    params.push(filter.source);
  }
  if (filter.enabled !== undefined) {
    conditions.push("enabled = ?");
    params.push(filter.enabled ? 1 : 0);
  }

  const sql = `SELECT * FROM schedules WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`;
  const rows = db.raw.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/** List enabled schedules for inclusion in LLM context. */
export function listUpcomingForContext(db: Database, guildId: string): ScheduleRow[] {
  return listSchedules(db, { guildId, enabled: true });
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
    enabled: (row.enabled as number) === 1,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
