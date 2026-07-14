import type { Database } from "../db/database.ts";

/** Read one persisted global or guild persona-mode context. */
export function getPersonaModeStateJson(db: Database, scopeKey: string): string | null {
  const row = db.raw.prepare("SELECT state_json FROM persona_mode_context_state WHERE scope_key = ?").get(scopeKey) as { state_json: string } | null;
  return row?.state_json ?? null;
}

/** Persist one global or guild persona-mode context atomically. */
export function setPersonaModeStateJson(db: Database, scopeKey: string, stateJson: string, now = Date.now()): void {
  db.raw.prepare(`
    INSERT INTO persona_mode_context_state (scope_key, state_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
  `).run(scopeKey, stateJson, now);
}
