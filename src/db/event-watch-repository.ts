import type { Database } from "./database.ts";
import type {
  EventWatch,
  EventWatchPressure,
  NormalizedWatchEvent,
  WatchEvent,
  WatchSource,
} from "../event-watch/types.ts";

export interface CreateEventWatchInput {
  source: WatchSource;
  /** Resolved guild for channel/guild sources. */
  sourceGuildId?: string;
  runInGuildId: string;
  runInChannelId: string;
  timezone: string;
  event: WatchEvent;
  after?: string;
  occurrences?: { count: number; withinSeconds: number };
  instruction: string;
  handoffNote?: string;
  origin: EventWatch["origin"];
  once?: boolean;
  cooldownSeconds: number;
  maxFireCount?: number;
  expiresAt?: number;
}

export type EventWatchScope = "current_channel" | "current_guild" | "all_guilds";

export interface EventWatchFire {
  id: string;
  watchId: string;
  eventKey: string;
  sourceGuildId: string;
  sourceChannelId: string | null;
  state: "pending" | "running" | "silent" | "delivered" | "failed";
  event: NormalizedWatchEvent;
  suppressedCount: number;
  createdAt: number;
  updatedAt: number;
}

interface EventWatchDbRow extends Record<string, unknown> {
  id: string;
  source_scope: WatchSource["scope"];
  source_guild_id: string | null;
  source_channel_id: string | null;
  run_in_guild_id: string;
  run_in_channel_id: string;
  timezone: string;
  event_type: WatchEvent["type"];
  selector_user_id: string | null;
  selector_webhook_id: string | null;
  event_json: string;
  after_value: string | null;
  occurrence_count: number | null;
  occurrence_window_s: number | null;
  instruction: string;
  handoff_note: string;
  origin_json: string;
  once: number;
  cooldown_seconds: number;
  fire_count: number;
  max_fire_count: number | null;
  expires_at: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface FireDbRow extends Record<string, unknown> {
  id: string;
  watch_id: string;
  event_key: string;
  source_guild_id: string;
  source_channel_id: string | null;
  state: EventWatchFire["state"];
  event_json: string;
  suppressed_count: number;
  created_at: number;
  updated_at: number;
}

function sourceColumns(source: WatchSource): { guildId: string | null; channelId: string | null } {
  if (source.scope === "channel") {
    return { guildId: null, channelId: source.channelId ?? null };
  }
  if (source.scope === "guild") {
    return { guildId: source.guildId ?? null, channelId: null };
  }
  return { guildId: null, channelId: null };
}

function selectorColumns(event: WatchEvent): { userId: string | null; webhookId: string | null } {
  return {
    userId: "userId" in event ? event.userId ?? null : null,
    webhookId: event.type === "message" ? event.webhookId ?? null : null,
  };
}

export function createEventWatch(db: Database, input: CreateEventWatchInput): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  const source = sourceColumns(input.source);
  const sourceGuildId = input.source.scope === "all_guilds"
    ? null
    : input.sourceGuildId ?? source.guildId ?? input.runInGuildId;
  const selectors = selectorColumns(input.event);
  db.raw.prepare(`INSERT INTO event_watches (
    id, source_scope, source_guild_id, source_channel_id, run_in_guild_id, run_in_channel_id,
    timezone, event_type, selector_user_id, selector_webhook_id, event_json, after_value,
    occurrence_count, occurrence_window_s, instruction, handoff_note, origin_json, once,
    cooldown_seconds, fire_count, max_fire_count, expires_at, enabled, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)`).run(
    id,
    input.source.scope,
    sourceGuildId,
    source.channelId,
    input.runInGuildId,
    input.runInChannelId,
    input.timezone,
    input.event.type,
    selectors.userId,
    selectors.webhookId,
    JSON.stringify(input.event),
    input.after ?? null,
    input.occurrences?.count ?? null,
    input.occurrences?.withinSeconds ?? null,
    input.instruction,
    input.handoffNote ?? "",
    JSON.stringify(input.origin),
    input.once === true ? 1 : 0,
    input.cooldownSeconds,
    input.maxFireCount ?? null,
    input.expiresAt ?? null,
    now,
    now,
  );
  return id;
}

export function getEventWatch(db: Database, id: string): EventWatch | null {
  const row = db.raw.prepare("SELECT * FROM event_watches WHERE id = ?").get(id) as EventWatchDbRow | null;
  return row === null ? null : mapWatch(row);
}

export function listEventWatches(db: Database, input: {
  guildId: string;
  channelId: string;
  scope: EventWatchScope;
  enabledOnly?: boolean;
}): EventWatch[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (input.enabledOnly === true) conditions.push("enabled = 1");
  if (input.scope === "current_channel") {
    conditions.push("run_in_guild_id = ?", "run_in_channel_id = ?");
    params.push(input.guildId, input.channelId);
  } else if (input.scope === "current_guild") {
    conditions.push("run_in_guild_id = ?");
    params.push(input.guildId);
  }
  const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  const rows = db.raw.prepare(`SELECT * FROM event_watches ${where} ORDER BY created_at ASC`).all(...params) as EventWatchDbRow[];
  return rows.map(mapWatch);
}

export function listCandidateEventWatches(db: Database, event: NormalizedWatchEvent): EventWatch[] {
  const channelId = "channelId" in event ? event.channelId : null;
  const webhookId = event.type === "message" ? event.webhookId : null;
  const rows = db.raw.prepare(`SELECT * FROM event_watches
    WHERE enabled = 1 AND event_type = ?
      AND (expires_at IS NULL OR expires_at > ?)
      AND (max_fire_count IS NULL OR fire_count < max_fire_count)
      AND (selector_user_id IS NULL OR selector_user_id = ?)
      AND (selector_webhook_id IS NULL OR selector_webhook_id = ?)
      AND (
        source_scope = 'all_guilds'
        OR (source_scope = 'guild' AND source_guild_id = ?)
        OR (source_scope = 'channel' AND source_guild_id = ? AND source_channel_id = ?)
      )
    ORDER BY created_at ASC`).all(
    event.type,
    event.at,
    "userId" in event ? event.userId : "",
    webhookId,
    event.guildId,
    event.guildId,
    channelId,
  ) as EventWatchDbRow[];
  return rows.map(mapWatch);
}

export function updateEventWatch(db: Database, id: string, input: {
  handoffNote?: string;
  enabled?: boolean;
}): boolean {
  const sets: string[] = [];
  const params: Array<string | number> = [];
  if (input.handoffNote !== undefined) {
    sets.push("handoff_note = ?");
    params.push(input.handoffNote);
  }
  if (input.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(input.enabled ? 1 : 0);
  }
  if (sets.length === 0) return false;
  sets.push("updated_at = ?");
  params.push(Date.now(), id);
  return db.raw.prepare(`UPDATE event_watches SET ${sets.join(", ")} WHERE id = ?`).run(...params).changes > 0;
}

export function setEventWatchThresholdArmed(db: Database, id: string, armed: boolean): void {
  db.raw.prepare("UPDATE event_watches SET threshold_armed = ?, updated_at = ? WHERE id = ?")
    .run(armed ? 1 : 0, Date.now(), id);
}

export function deleteEventWatch(db: Database, id: string): boolean {
  return db.raw.prepare("DELETE FROM event_watches WHERE id = ?").run(id).changes > 0;
}

export function countActiveWatches(db: Database, guildId?: string): number {
  const row = guildId === undefined
    ? db.raw.prepare("SELECT COUNT(*) AS count FROM event_watches WHERE enabled = 1").get()
    : db.raw.prepare("SELECT COUNT(*) AS count FROM event_watches WHERE enabled = 1 AND run_in_guild_id = ?").get(guildId);
  return (row as { count: number }).count;
}

function countFiresSince(db: Database, input: { since: number; watchId?: string; guildId?: string }): number {
  const conditions = ["created_at >= ?"];
  const values: Array<string | number> = [input.since];
  if (input.watchId !== undefined) {
    conditions.push("watch_id = ?");
    values.push(input.watchId);
  }
  if (input.guildId !== undefined) {
    conditions.push("source_guild_id = ?");
    values.push(input.guildId);
  }
  const row = db.raw.prepare(`SELECT COUNT(*) AS count FROM event_watch_fires WHERE ${conditions.join(" AND ")}`).get(...values) as { count: number };
  return row.count;
}

function pressureAllowsFire(
  db: Database,
  watch: EventWatch,
  event: NormalizedWatchEvent,
  pressure: EventWatchPressure,
  now: number,
): boolean {
  const hour = now - 3_600_000;
  const day = now - 86_400_000;
  return countFiresSince(db, { since: hour, watchId: watch.id }) < pressure.maxWatchFiresPerHour
    && countFiresSince(db, { since: day, watchId: watch.id }) < pressure.maxWatchFiresPerDay
    && countFiresSince(db, { since: hour, guildId: event.guildId }) < pressure.maxGuildFiresPerHour
    && countFiresSince(db, { since: day, guildId: event.guildId }) < pressure.maxGuildFiresPerDay
    && countFiresSince(db, { since: hour }) < pressure.maxProfileFiresPerHour
    && countFiresSince(db, { since: day }) < pressure.maxProfileFiresPerDay;
}

function cooldownAllowsFire(db: Database, watch: EventWatch, now: number): boolean {
  if (watch.cooldownSeconds <= 0) return true;
  const row = db.raw.prepare(
    "SELECT created_at FROM event_watch_fires WHERE watch_id = ? ORDER BY created_at DESC LIMIT 1",
  ).get(watch.id) as { created_at: number } | null;
  return row === null || row.created_at + watch.cooldownSeconds * 1_000 <= now;
}

function rollingThresholdReached(db: Database, watch: EventWatch, event: NormalizedWatchEvent): boolean {
  if (watch.occurrences === undefined) return true;
  const sourceKey = watch.source.scope === "all_guilds"
    ? "all_guilds"
    : watch.source.scope === "guild"
      ? event.guildId
      : `${event.guildId}:${"channelId" in event ? event.channelId ?? "" : ""}`;
  const cutoff = event.at - watch.occurrences.withinSeconds * 1_000;
  db.raw.prepare("DELETE FROM event_watch_observations WHERE watch_id = ? AND observed_at < ?")
    .run(watch.id, cutoff);
  const before = (db.raw.prepare(
    "SELECT COUNT(*) AS count FROM event_watch_observations WHERE watch_id = ? AND source_key = ? AND observed_at >= ?",
  ).get(watch.id, sourceKey, cutoff) as { count: number }).count;
  if (before < watch.occurrences.count) {
    db.raw.prepare("UPDATE event_watches SET threshold_armed = 1 WHERE id = ?").run(watch.id);
  }
  db.raw.prepare(`INSERT OR IGNORE INTO event_watch_observations
    (watch_id, source_key, event_key, observed_at) VALUES (?, ?, ?, ?)`)
    .run(watch.id, sourceKey, event.eventKey, event.at);
  const after = (db.raw.prepare(
    "SELECT COUNT(*) AS count FROM event_watch_observations WHERE watch_id = ? AND source_key = ? AND observed_at >= ?",
  ).get(watch.id, sourceKey, cutoff) as { count: number }).count;
  const armed = (db.raw.prepare("SELECT threshold_armed FROM event_watches WHERE id = ?").get(watch.id) as { threshold_armed: number }).threshold_armed === 1;
  if (!armed || after < watch.occurrences.count) return false;
  db.raw.prepare("UPDATE event_watches SET threshold_armed = 0 WHERE id = ?").run(watch.id);
  return true;
}

function aggregateThresholdReached(db: Database, watch: EventWatch, event: NormalizedWatchEvent): boolean {
  if (watch.event.type !== "reaction" || watch.event.countAtLeast === undefined || event.type !== "reaction") return true;
  if (event.count < watch.event.countAtLeast) {
    setEventWatchThresholdArmed(db, watch.id, true);
    return false;
  }
  const row = db.raw.prepare("SELECT threshold_armed FROM event_watches WHERE id = ?").get(watch.id) as { threshold_armed: number };
  if (row.threshold_armed !== 1) return false;
  setEventWatchThresholdArmed(db, watch.id, false);
  return true;
}

/** Atomically claim one matching event. Pressure defers one-offs and coalesces recurring matches. */
export function claimEventWatchFire(
  db: Database,
  watch: EventWatch,
  event: NormalizedWatchEvent,
  pressure: EventWatchPressure,
): EventWatchFire | null {
  const now = Date.now();
  if (!watch.enabled || (watch.expiresAt !== null && watch.expiresAt <= event.at)) return null;
  db.raw.run("BEGIN IMMEDIATE");
  try {
    const latest = getEventWatch(db, watch.id);
    if (latest === null || !latest.enabled) {
      db.raw.run("COMMIT");
      return null;
    }
    if (!cooldownAllowsFire(db, latest, now)
        || !rollingThresholdReached(db, latest, event)
        || !aggregateThresholdReached(db, latest, event)
    ) {
      db.raw.run("COMMIT");
      return null;
    }
    const pressureAllowed = pressureAllowsFire(db, latest, event, pressure, now);
    const pendingCount = (db.raw.prepare(
      "SELECT COUNT(*) AS count FROM event_watch_fires WHERE state IN ('pending', 'running')",
    ).get() as { count: number }).count;
    const mustDefer = !pressureAllowed || pendingCount >= pressure.maxPendingProfile;
    const eventKey = mustDefer && !latest.once ? `coalesced:${latest.id}` : event.eventKey;
    const id = crypto.randomUUID();
    const insert = db.raw.prepare(`INSERT OR IGNORE INTO event_watch_fires
      (id, watch_id, event_key, source_guild_id, source_channel_id, state, event_json, suppressed_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)`).run(
      id,
      latest.id,
      eventKey,
      event.guildId,
      "channelId" in event ? event.channelId : null,
      JSON.stringify(event),
      now,
      now,
    );
    if (insert.changes === 0) {
      if (eventKey.startsWith("coalesced:")) {
        db.raw.prepare(`UPDATE event_watch_fires
          SET event_json = ?, suppressed_count = suppressed_count + 1, updated_at = ?
          WHERE watch_id = ? AND event_key = ? AND state = 'pending'`)
          .run(JSON.stringify(event), now, latest.id, eventKey);
      }
      db.raw.run("COMMIT");
      return null;
    }
    db.raw.prepare(`UPDATE event_watches
      SET fire_count = fire_count + 1,
          enabled = CASE WHEN once = 1 OR (max_fire_count IS NOT NULL AND fire_count + 1 >= max_fire_count) THEN 0 ELSE enabled END,
          updated_at = ?
      WHERE id = ?`).run(now, latest.id);
    db.raw.run("COMMIT");
    if (mustDefer) return null;
    return getEventWatchFire(db, id);
  } catch (error) {
    db.raw.run("ROLLBACK");
    throw error;
  }
}

/** Check whether a durable pending fire can enter execution pressure now. */
export function eventWatchFirePressureAllowsExecution(
  db: Database,
  fire: EventWatchFire,
  pressure: EventWatchPressure,
  now = Date.now(),
): boolean {
  const hour = now - 3_600_000;
  const day = now - 86_400_000;
  return countFiresSince(db, { since: hour, watchId: fire.watchId }) <= pressure.maxWatchFiresPerHour
    && countFiresSince(db, { since: day, watchId: fire.watchId }) <= pressure.maxWatchFiresPerDay
    && countFiresSince(db, { since: hour, guildId: fire.sourceGuildId }) <= pressure.maxGuildFiresPerHour
    && countFiresSince(db, { since: day, guildId: fire.sourceGuildId }) <= pressure.maxGuildFiresPerDay
    && countFiresSince(db, { since: hour }) <= pressure.maxProfileFiresPerHour
    && countFiresSince(db, { since: day }) <= pressure.maxProfileFiresPerDay;
}

export function getEventWatchFire(db: Database, id: string): EventWatchFire | null {
  const row = db.raw.prepare("SELECT * FROM event_watch_fires WHERE id = ?").get(id) as FireDbRow | null;
  return row === null ? null : mapFire(row);
}

export function listPendingEventWatchFires(db: Database, limit = 50): EventWatchFire[] {
  const rows = db.raw.prepare(
    "SELECT * FROM event_watch_fires WHERE state = 'pending' ORDER BY created_at ASC LIMIT ?",
  ).all(limit) as FireDbRow[];
  return rows.map(mapFire);
}

export function updateEventWatchFireState(db: Database, id: string, state: EventWatchFire["state"]): boolean {
  return db.raw.prepare("UPDATE event_watch_fires SET state = ?, updated_at = ? WHERE id = ?")
    .run(state, Date.now(), id).changes > 0;
}

export function markWatchMessageProcessed(db: Database, messageId: string): void {
  db.raw.prepare("UPDATE event_watch_message_inbox SET state = 'processed', updated_at = ? WHERE message_id = ?")
    .run(Date.now(), messageId);
}

export function listPendingWatchMessageIds(db: Database, limit = 500): string[] {
  const rows = db.raw.prepare(
    "SELECT message_id FROM event_watch_message_inbox WHERE state = 'pending' ORDER BY created_at ASC LIMIT ?",
  ).all(limit) as Array<{ message_id: string }>;
  return rows.map((row) => row.message_id);
}

function mapWatch(row: EventWatchDbRow): EventWatch {
  const source: WatchSource = row.source_scope === "channel"
    ? { scope: "channel", ...(row.source_channel_id === null ? {} : { channelId: row.source_channel_id }) }
    : row.source_scope === "guild"
      ? { scope: "guild", ...(row.source_guild_id === null ? {} : { guildId: row.source_guild_id }) }
      : { scope: "all_guilds" };
  const count = row.occurrence_count;
  const window = row.occurrence_window_s;
  return {
    id: row.id,
    source,
    runInGuildId: row.run_in_guild_id,
    runInChannelId: row.run_in_channel_id,
    timezone: row.timezone,
    event: JSON.parse(row.event_json) as WatchEvent,
    ...(row.after_value === null ? {} : { after: row.after_value }),
    ...(count === null || window === null ? {} : { occurrences: { count, withinSeconds: window } }),
    instruction: row.instruction,
    handoffNote: row.handoff_note,
    origin: JSON.parse(row.origin_json) as EventWatch["origin"],
    once: row.once === 1,
    cooldownSeconds: row.cooldown_seconds,
    fireCount: row.fire_count,
    maxFireCount: row.max_fire_count,
    expiresAt: row.expires_at,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFire(row: FireDbRow): EventWatchFire {
  return {
    id: row.id,
    watchId: row.watch_id,
    eventKey: row.event_key,
    sourceGuildId: row.source_guild_id,
    sourceChannelId: row.source_channel_id,
    state: row.state,
    event: JSON.parse(row.event_json) as NormalizedWatchEvent,
    suppressedCount: row.suppressed_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
