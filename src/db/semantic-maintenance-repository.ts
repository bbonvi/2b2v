import type { Database } from "./database";

export interface SemanticMaintenanceSweepState {
  lastAt: number;
  memoryId: number;
  relationshipOffset: number;
  threadOffset: number;
}

/** Read one durable profile-wide or guild-local sweep cursor. */
export function getSemanticMaintenanceSweepState(
  db: Database,
  scopeKey: string,
): SemanticMaintenanceSweepState | null {
  const row = db.raw.prepare(`SELECT last_at, memory_cursor_id, relationship_offset, thread_offset
    FROM semantic_maintenance_sweep_state WHERE scope_key = ?`).get(scopeKey) as {
      last_at: number;
      memory_cursor_id: number;
      relationship_offset: number;
      thread_offset: number;
    } | null;
  return row === null ? null : {
    lastAt: row.last_at,
    memoryId: row.memory_cursor_id,
    relationshipOffset: row.relationship_offset,
    threadOffset: row.thread_offset,
  };
}

/** Persist one sweep cursor after successful maintenance. */
export function setSemanticMaintenanceSweepState(
  db: Database,
  scopeKey: string,
  state: SemanticMaintenanceSweepState,
): void {
  db.raw.prepare(`INSERT INTO semantic_maintenance_sweep_state
    (scope_key, last_at, memory_cursor_id, relationship_offset, thread_offset)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET
      last_at = excluded.last_at,
      memory_cursor_id = excluded.memory_cursor_id,
      relationship_offset = excluded.relationship_offset,
      thread_offset = excluded.thread_offset`)
    .run(scopeKey, state.lastAt, state.memoryId, state.relationshipOffset, state.threadOffset);
}
