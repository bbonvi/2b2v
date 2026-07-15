import type { Database } from "./database";

export interface RestartRecoveryState {
  cutoffAt: number;
  createdAt: number;
}

export interface RecentDiscordChannel {
  guildId: string;
  channelId: string;
  lastActivityAt: number;
}

/** Persist the point after which inbound Discord events are deliberately ignored for shutdown. */
export function setRestartRecoveryCutoff(db: Database, cutoffAt = Date.now()): RestartRecoveryState {
  db.raw.prepare(`INSERT INTO restart_recovery (singleton, cutoff_at, created_at)
    VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET cutoff_at = excluded.cutoff_at, created_at = excluded.created_at`)
    .run(cutoffAt, cutoffAt);
  return { cutoffAt, createdAt: cutoffAt };
}

/** Read the pending coordinated-restart recovery marker, if one exists. */
export function getRestartRecoveryState(db: Database): RestartRecoveryState | null {
  const row = db.raw.prepare("SELECT cutoff_at, created_at FROM restart_recovery WHERE singleton = 1")
    .get() as { cutoff_at: number; created_at: number } | null;
  return row === null ? null : { cutoffAt: row.cutoff_at, createdAt: row.created_at };
}

/** Clear a recovery marker after its bounded Discord catch-up scan completes. */
export function clearRestartRecoveryState(db: Database): void {
  db.raw.prepare("DELETE FROM restart_recovery WHERE singleton = 1").run();
}

/** List the most recently active real Discord channels known to local history. */
export function listRecentDiscordChannels(db: Database, limit: number): RecentDiscordChannel[] {
  const rows = db.raw.prepare(`SELECT guild_id, channel_id, MAX(created_at) AS last_activity_at
    FROM messages
    WHERE is_synthetic = 0 AND is_prompt_only = 0 AND id GLOB '[0-9]*'
    GROUP BY guild_id, channel_id
    ORDER BY last_activity_at DESC, channel_id ASC
    LIMIT ?`).all(limit) as Array<{ guild_id: string; channel_id: string; last_activity_at: number }>;
  return rows.map((row) => ({
    guildId: row.guild_id,
    channelId: row.channel_id,
    lastActivityAt: row.last_activity_at,
  }));
}
