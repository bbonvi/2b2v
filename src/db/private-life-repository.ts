import type { Database } from "./database.ts";
import type {
  PrivateLifeDayPhase,
  PrivateLifeEpisodeSummary,
  PrivateLifeSelection,
} from "../private-life/types.ts";

export interface PrivateLifeEpisode {
  id: string;
  guildId: string;
  channelId: string;
  requestId: string | null;
  status: "running" | "complete" | "failed";
  dayPhase: PrivateLifeDayPhase;
  selection: PrivateLifeSelection;
  thoughts: string | null;
  summary: PrivateLifeEpisodeSummary | null;
  visibleOutput: string | null;
  visibleDelivered: boolean;
  createdAt: number;
  completedAt: number | null;
  error: string | null;
}

interface EpisodeRow {
  id: string;
  guild_id: string;
  channel_id: string;
  request_id: string | null;
  status: PrivateLifeEpisode["status"];
  day_phase: PrivateLifeDayPhase;
  origin: PrivateLifeSelection["origin"];
  mode: PrivateLifeSelection["mode"];
  territory: PrivateLifeSelection["territory"];
  action_scope: PrivateLifeSelection["actionScope"];
  candidate_seeds_json: string;
  continued_thread_id: string | null;
  thoughts_text: string | null;
  summary_label: string | null;
  theme_key: string | null;
  facets_json: string;
  visible_output: string | null;
  visible_delivered: number;
  created_at: number;
  completed_at: number | null;
  error: string | null;
}

function strings(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function fromRow(row: EpisodeRow): PrivateLifeEpisode {
  const label = row.summary_label?.trim() ?? "";
  const themeKey = row.theme_key?.trim() ?? "";
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    requestId: row.request_id,
    status: row.status,
    dayPhase: row.day_phase,
    selection: {
      origin: row.origin,
      mode: row.mode,
      territory: row.territory,
      actionScope: row.action_scope,
      candidateSeeds: strings(row.candidate_seeds_json),
      ...(row.continued_thread_id !== null ? { continuedThreadId: row.continued_thread_id } : {}),
    },
    thoughts: row.thoughts_text,
    summary: label !== "" && themeKey !== ""
      ? { label, themeKey, facets: strings(row.facets_json) }
      : null,
    visibleOutput: row.visible_output,
    visibleDelivered: row.visible_delivered === 1,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

export function createPrivateLifeEpisode(db: Database, input: {
  id: string;
  guildId: string;
  channelId: string;
  dayPhase: PrivateLifeDayPhase;
  selection: PrivateLifeSelection;
  createdAt?: number;
}): PrivateLifeEpisode {
  db.raw.prepare(`INSERT INTO private_life_episodes
    (id, guild_id, channel_id, status, day_phase, origin, mode, territory, action_scope,
     candidate_seeds_json, continued_thread_id, created_at)
    VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.id,
    input.guildId,
    input.channelId,
    input.dayPhase,
    input.selection.origin,
    input.selection.mode,
    input.selection.territory,
    input.selection.actionScope,
    JSON.stringify(input.selection.candidateSeeds),
    input.selection.continuedThreadId ?? null,
    input.createdAt ?? Date.now(),
  );
  const episode = getPrivateLifeEpisode(db, input.id);
  if (episode === null) throw new Error(`Failed to create private-life episode ${input.id}.`);
  return episode;
}

export function getPrivateLifeEpisode(db: Database, id: string): PrivateLifeEpisode | null {
  const row = db.raw.prepare("SELECT * FROM private_life_episodes WHERE id = ?").get(id) as EpisodeRow | null;
  return row === null ? null : fromRow(row);
}

export function completePrivateLifeEpisode(db: Database, input: {
  id: string;
  requestId?: string;
  thoughts?: string;
  visibleOutput?: string;
  visibleDelivered: boolean;
  completedAt?: number;
}): void {
  const thoughts = input.thoughts?.trim();
  const visibleOutput = input.visibleOutput?.trim();
  db.raw.prepare(`UPDATE private_life_episodes SET
    request_id = ?, status = 'complete', thoughts_text = ?, visible_output = ?,
    visible_delivered = ?, completed_at = ?, error = NULL
    WHERE id = ?`).run(
    input.requestId ?? null,
    thoughts !== undefined && thoughts !== "" ? thoughts : null,
    visibleOutput !== undefined && visibleOutput !== "" ? visibleOutput : null,
    input.visibleDelivered ? 1 : 0,
    input.completedAt ?? Date.now(),
    input.id,
  );
}

export function failPrivateLifeEpisode(db: Database, id: string, error: string, completedAt = Date.now()): void {
  db.raw.prepare(`UPDATE private_life_episodes
    SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`)
    .run(completedAt, error, id);
}

export function setPrivateLifeEpisodeSummary(
  db: Database,
  id: string,
  summary: PrivateLifeEpisodeSummary,
): void {
  db.raw.prepare(`UPDATE private_life_episodes SET
    summary_label = ?, theme_key = ?, facets_json = ? WHERE id = ?`).run(
    summary.label.trim(),
    summary.themeKey.trim(),
    JSON.stringify(summary.facets),
    id,
  );
}

export function listPrivateLifeEpisodes(db: Database, limit = 50): PrivateLifeEpisode[] {
  const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
  return (db.raw.prepare("SELECT * FROM private_life_episodes ORDER BY created_at DESC LIMIT ?")
    .all(bounded) as EpisodeRow[]).map(fromRow);
}

export function listRecentPrivateLifeSummaries(
  db: Database,
  limit: number,
): Array<PrivateLifeEpisodeSummary & { createdAt: number; territory: string; mode: string }> {
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = db.raw.prepare(`SELECT summary_label, theme_key, facets_json, created_at, territory, mode
    FROM private_life_episodes
    WHERE status = 'complete' AND summary_label IS NOT NULL AND theme_key IS NOT NULL
    ORDER BY created_at DESC LIMIT ?`).all(bounded) as Array<{
      summary_label: string;
      theme_key: string;
      facets_json: string;
      created_at: number;
      territory: string;
      mode: string;
    }>;
  return rows.map((row) => ({
    label: row.summary_label,
    themeKey: row.theme_key,
    facets: strings(row.facets_json),
    createdAt: row.created_at,
    territory: row.territory,
    mode: row.mode,
  }));
}

export function countPrivateLifeVisibleEpisodesSince(db: Database, since: number): number {
  const row = db.raw.prepare(`SELECT COUNT(*) AS count FROM private_life_episodes
    WHERE visible_delivered = 1 AND created_at >= ?`).get(since) as { count: number };
  return row.count;
}

export function clearExpiredPrivateLifeThoughts(db: Database, before: number): number {
  return db.raw.prepare(`UPDATE private_life_episodes SET thoughts_text = NULL
    WHERE thoughts_text IS NOT NULL AND created_at < ?`).run(before).changes;
}
