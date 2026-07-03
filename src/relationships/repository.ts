import type { Database } from "../db/database";
import type { RelationshipEvent, RelationshipEventSource, RelationshipProfile, RelationshipScope, RelationshipVisibility } from "./types";
import { emptyRelationshipProfile } from "./state";

interface RelationshipProfileRow {
  user_id: string;
  axes_json: string;
  notes_json: string;
  boundaries_json: string;
  open_loops_json: string;
  recent_json: string;
  updated_at: number;
}

interface RelationshipEventRow {
  id: string;
  type: "relationship_signal";
  at_ms: number;
  source: RelationshipEventSource;
  visibility: RelationshipVisibility;
  guild_id: string | null;
  channel_id: string | null;
  user_id: string | null;
  summary: string;
  payload_json: string;
  created_at: number;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapProfile(row: RelationshipProfileRow): RelationshipProfile {
  const fallback = emptyRelationshipProfile(row.user_id, row.updated_at);
  return {
    userId: row.user_id,
    axes: { ...fallback.axes, ...parseJson(row.axes_json, {}) },
    notes: parseJson(row.notes_json, []),
    boundaries: parseJson(row.boundaries_json, []),
    openLoops: parseJson(row.open_loops_json, []),
    recent: parseJson(row.recent_json, []),
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: RelationshipEventRow): RelationshipEvent {
  return {
    id: row.id,
    type: row.type,
    at: row.at_ms,
    source: row.source,
    visibility: row.visibility,
    guildId: row.guild_id,
    channelId: row.channel_id,
    userId: row.user_id,
    summary: row.summary,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

export function getRelationshipProfile(db: Database, userId: string): RelationshipProfile {
  const row = db.raw.prepare("SELECT * FROM relationship_profiles WHERE user_id = ?").get(userId) as RelationshipProfileRow | null;
  return row === null ? emptyRelationshipProfile(userId) : mapProfile(row);
}

export function listRelationshipProfiles(db: Database, limit = 100): RelationshipProfile[] {
  return (db.raw
    .prepare("SELECT * FROM relationship_profiles ORDER BY updated_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(500, limit))) as RelationshipProfileRow[]).map(mapProfile);
}

export function saveRelationshipProfile(db: Database, profile: RelationshipProfile): void {
  db.raw.prepare(
    `INSERT INTO relationship_profiles
      (user_id, axes_json, notes_json, boundaries_json, open_loops_json, recent_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       axes_json = excluded.axes_json,
       notes_json = excluded.notes_json,
       boundaries_json = excluded.boundaries_json,
       open_loops_json = excluded.open_loops_json,
       recent_json = excluded.recent_json,
       updated_at = excluded.updated_at`,
  ).run(
    profile.userId,
    JSON.stringify(profile.axes),
    JSON.stringify(profile.notes),
    JSON.stringify(profile.boundaries),
    JSON.stringify(profile.openLoops),
    JSON.stringify(profile.recent),
    profile.updatedAt,
  );
}

export function appendRelationshipEvent(db: Database, input: {
  at?: number;
  source: RelationshipEventSource;
  visibility: RelationshipVisibility;
  scope?: RelationshipScope;
  summary: string;
  payload?: Record<string, unknown>;
}, now = Date.now()): RelationshipEvent {
  const id = crypto.randomUUID();
  const at = Math.floor(input.at ?? now);
  const createdAt = Math.floor(now);
  db.raw.prepare(
    `INSERT INTO relationship_events
      (id, type, at_ms, source, visibility, guild_id, channel_id, user_id, summary, payload_json, created_at)
     VALUES (?, 'relationship_signal', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    at,
    input.source,
    input.visibility,
    input.scope?.guildId ?? null,
    input.scope?.channelId ?? null,
    input.scope?.userId ?? null,
    input.summary.trim(),
    JSON.stringify(input.payload ?? {}),
    createdAt,
  );
  const row = db.raw.prepare("SELECT * FROM relationship_events WHERE id = ?").get(id) as RelationshipEventRow | null;
  if (row === null) throw new Error("Created relationship event could not be loaded.");
  return mapEvent(row);
}

export function listRelationshipEvents(db: Database, input: { limit?: number; userId?: string } = {}): RelationshipEvent[] {
  const limit = Math.max(1, Math.min(500, input.limit ?? 100));
  if (input.userId !== undefined) {
    return (db.raw
      .prepare("SELECT * FROM relationship_events WHERE user_id = ? ORDER BY at_ms DESC, created_at DESC LIMIT ?")
      .all(input.userId, limit) as RelationshipEventRow[]).map(mapEvent);
  }
  return (db.raw
    .prepare("SELECT * FROM relationship_events ORDER BY at_ms DESC, created_at DESC LIMIT ?")
    .all(limit) as RelationshipEventRow[]).map(mapEvent);
}

export function resetRelationships(db: Database): void {
  db.raw.run("BEGIN TRANSACTION");
  try {
    db.raw.prepare("DELETE FROM relationship_events").run();
    db.raw.prepare("DELETE FROM relationship_profiles").run();
    db.raw.run("COMMIT");
  } catch (error) {
    db.raw.run("ROLLBACK");
    throw error;
  }
}
