import type { Database as BunDatabase } from "bun:sqlite";
import { sanitizeMemoryContent } from "./memory-content";
import { MEMORY_KIND_SQL_VALUES } from "./memory-kinds";
import { memoriesTableSql, memorySchemaHasCurrentChecks } from "./schema";

type TableColumn = { name: string; type: string };

const STRUCTURED_MEMORY_KIND_SQL = `CASE
  WHEN kind IN ('global_note', 'user_note') THEN 'note'
  WHEN kind IN (${MEMORY_KIND_SQL_VALUES}) THEN kind
  ELSE 'fact'
END`;

function ignoreExistingColumn(raw: BunDatabase, sql: string): void {
  try {
    raw.run(sql);
  } catch {
    // SQLite raises on duplicate columns; these migrations are intentionally idempotent.
  }
}

function runInTransaction(raw: BunDatabase, migrate: () => void): void {
  raw.run("BEGIN TRANSACTION");
  try {
    migrate();
    raw.run("COMMIT");
  } catch (e) {
    raw.run("ROLLBACK");
    throw e;
  }
}

function tableColumns(raw: BunDatabase, table: string): TableColumn[] {
  return raw.prepare(`PRAGMA table_info(${table})`).all() as TableColumn[];
}

function hasColumn(columns: readonly TableColumn[], name: string): boolean {
  return columns.some((column) => column.name === name);
}

function sanitizeExistingMemoryRows(raw: BunDatabase): void {
  const rows = raw.prepare("SELECT id, content FROM memories").all() as Array<{ id: number; content: string }>;
  if (rows.length === 0) return;
  const update = raw.prepare("UPDATE memories SET content = ? WHERE id = ?");
  runInTransaction(raw, () => {
    for (const row of rows) {
      const content = sanitizeMemoryContent(row.content);
      if (content !== "" && content !== row.content) {
        update.run(content, row.id);
      }
    }
  });
}

function tableExists(raw: BunDatabase, table: string): boolean {
  return raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null;
}

function createMemoryRecallTable(raw: BunDatabase): void {
  raw.run(`CREATE TABLE IF NOT EXISTS memory_recall_users (
    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    PRIMARY KEY (memory_id, user_id)
  )`);
  raw.run("CREATE INDEX IF NOT EXISTS idx_memory_recall_users_user ON memory_recall_users(user_id, memory_id)");
}

/**
 * Replace every legacy memory shape with the orthogonal about/where/when model.
 * IDs and recall-user links are copied inside one transaction so production
 * references remain stable and a failed copy leaves the old schema untouched.
 */
function migrateMemoryRecallModel(raw: BunDatabase, memoryColumns: readonly TableColumn[]): void {
  const memorySchema = raw
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'")
    .get() as { sql: string } | undefined;
  if (hasColumn(memoryColumns, "about_type") && memorySchemaHasCurrentChecks(memorySchema?.sql)) {
    createMemoryRecallTable(raw);
    return;
  }

  const hasStructuredSchema = hasColumn(memoryColumns, "subject_user_id")
    && hasColumn(memoryColumns, "content")
    && hasColumn(memoryColumns, "confidence")
    && hasColumn(memoryColumns, "deleted_at");
  const hasLegacyScope = hasColumn(memoryColumns, "scope");
  const recallRows = tableExists(raw, "memory_applicability")
    ? raw.prepare("SELECT memory_id, user_id FROM memory_applicability").all() as Array<{ memory_id: number; user_id: string }>
    : [];
  const provenanceExpression = hasColumn(memoryColumns, "provenance_json") ? "provenance_json" : "NULL";
  const priorityExpression = hasColumn(memoryColumns, "priority")
    ? "CASE WHEN priority < 0 THEN 0 ELSE COALESCE(priority, 0) END"
    : "0";
  const expectedMemoryCount = hasStructuredSchema
    ? (raw.prepare("SELECT COUNT(*) AS count FROM memories WHERE TRIM(content) <> ''").get() as { count: number }).count
    : (raw.prepare(`SELECT COUNT(*) AS count FROM memories
        WHERE COALESCE(TRIM(short_description), '') <> '' OR COALESCE(TRIM(long_description), '') <> ''`).get() as { count: number }).count;

  runInTransaction(raw, () => {
    raw.run("DROP TABLE IF EXISTS memories_new");
    raw.run(memoriesTableSql("memories_new"));
    if (hasStructuredSchema) {
      const recallModeExpression = hasColumn(memoryColumns, "applicability_mode")
        ? "CASE WHEN applicability_mode = 'users' THEN 'users' ELSE 'always' END"
        : hasLegacyScope
          ? "CASE WHEN scope = 'user' THEN 'users' ELSE 'always' END"
          : "CASE WHEN subject_user_id IS NOT NULL THEN 'users' ELSE 'always' END";
      const aboutExpression = hasLegacyScope
        ? "CASE WHEN scope = 'user' THEN 'user' WHEN scope = 'self' THEN 'self' ELSE 'community' END"
        : "CASE WHEN subject_user_id IS NOT NULL THEN 'user' ELSE 'community' END";
      const aboutUserExpression = hasLegacyScope
        ? "CASE WHEN scope = 'user' THEN subject_user_id ELSE NULL END"
        : "subject_user_id";
      const recallScopeExpression = hasLegacyScope
        ? "CASE WHEN scope = 'guild' THEN 'guild' ELSE 'anywhere' END"
        : "CASE WHEN subject_user_id IS NULL THEN 'guild' ELSE 'anywhere' END";
      const recallGuildExpression = hasLegacyScope
        ? "CASE WHEN scope = 'guild' THEN guild_id ELSE NULL END"
        : "CASE WHEN subject_user_id IS NULL THEN COALESCE(guild_id, '') ELSE NULL END";
      const validKindExpression = hasLegacyScope
        ? `CASE
            WHEN ${STRUCTURED_MEMORY_KIND_SQL} = 'journal' AND scope <> 'self' THEN 'fact'
            WHEN ${STRUCTURED_MEMORY_KIND_SQL} = 'scratchpad' AND expires_at IS NULL THEN 'note'
            ELSE ${STRUCTURED_MEMORY_KIND_SQL}
          END`
        : `CASE
            WHEN ${STRUCTURED_MEMORY_KIND_SQL} = 'journal' THEN 'fact'
            WHEN ${STRUCTURED_MEMORY_KIND_SQL} = 'scratchpad' AND expires_at IS NULL THEN 'note'
            ELSE ${STRUCTURED_MEMORY_KIND_SQL}
          END`;
      raw.run(`INSERT INTO memories_new (id, about_type, about_user_id, recall_scope, recall_guild_id, recall_mode, kind, content, source_message_id, provenance_json, confidence, priority, created_at, updated_at, expires_at, deleted_at)
        SELECT
          id,
          ${aboutExpression},
          ${aboutUserExpression},
          ${recallScopeExpression},
          ${recallGuildExpression},
          ${recallModeExpression},
          ${validKindExpression},
          TRIM(content),
          source_message_id,
          ${provenanceExpression},
          CASE WHEN confidence < 0 THEN 0 WHEN confidence > 1 THEN 1 ELSE COALESCE(confidence, 0.7) END,
          ${priorityExpression},
          created_at,
          updated_at,
          expires_at,
          deleted_at
        FROM memories
        WHERE TRIM(content) <> ''`);
    } else {
      raw.run(`INSERT INTO memories_new (about_type, about_user_id, recall_scope, recall_guild_id, recall_mode, kind, content, source_message_id, provenance_json, confidence, priority, created_at, updated_at, expires_at, deleted_at)
        SELECT
          CASE WHEN scope = 'user' THEN 'user' ELSE 'community' END,
          CASE WHEN scope = 'user' THEN user_id ELSE NULL END,
          CASE WHEN scope = 'user' THEN 'anywhere' ELSE 'guild' END,
          CASE WHEN scope = 'user' THEN NULL ELSE COALESCE(guild_id, '') END,
          CASE WHEN scope = 'user' THEN 'users' ELSE 'always' END,
          'note',
          TRIM(CASE
            WHEN COALESCE(TRIM(short_description), '') = '' THEN long_description
            WHEN COALESCE(TRIM(long_description), '') = '' THEN short_description
            ELSE short_description || ': ' || long_description
          END),
          source_message_id,
          NULL,
          0.7,
          0,
          created_at,
          updated_at,
          CASE WHEN expires_at IS NOT NULL AND expires_at > (strftime('%s','now') * 1000) THEN expires_at ELSE NULL END,
          CASE WHEN expires_at IS NOT NULL AND expires_at <= (strftime('%s','now') * 1000) THEN expires_at ELSE NULL END
        FROM memories
        WHERE COALESCE(TRIM(short_description), '') <> '' OR COALESCE(TRIM(long_description), '') <> ''`);
    }
    const copiedMemoryCount = (raw.prepare("SELECT COUNT(*) AS count FROM memories_new").get() as { count: number }).count;
    if (copiedMemoryCount !== expectedMemoryCount) {
      throw new Error(`Memory migration copied ${copiedMemoryCount} of ${expectedMemoryCount} rows.`);
    }

    raw.run("DROP TABLE IF EXISTS memory_recall_users");
    raw.run("DROP TABLE memories");
    raw.run("ALTER TABLE memories_new RENAME TO memories");
    createMemoryRecallTable(raw);
    const restoreRecall = raw.prepare(
      "INSERT OR IGNORE INTO memory_recall_users (memory_id, user_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM memories WHERE id = ? AND recall_mode = 'users')",
    );
    for (const row of recallRows) restoreRecall.run(row.memory_id, row.user_id, row.memory_id);
    raw.run(`INSERT OR IGNORE INTO memory_recall_users (memory_id, user_id)
      SELECT id, about_user_id FROM memories
      WHERE about_type = 'user' AND recall_mode = 'users' AND about_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM memory_recall_users WHERE memory_id = memories.id)`);
    for (const row of recallRows) {
      const shouldExist = raw.prepare("SELECT 1 FROM memories WHERE id = ? AND recall_mode = 'users'").get(row.memory_id) !== null;
      if (shouldExist && raw.prepare("SELECT 1 FROM memory_recall_users WHERE memory_id = ? AND user_id = ?").get(row.memory_id, row.user_id) === null) {
        throw new Error(`Memory migration lost recall user ${row.user_id} for row ${row.memory_id}.`);
      }
    }
    raw.run("DROP TABLE IF EXISTS memory_applicability");
    createMemoryIndexes(raw);
  });
}

function createMemoryIndexes(raw: BunDatabase): void {
  raw.run("CREATE INDEX IF NOT EXISTS idx_memories_about_user ON memories(about_type, about_user_id, deleted_at, updated_at)");
  raw.run("CREATE INDEX IF NOT EXISTS idx_memories_recall_guild ON memories(recall_scope, recall_guild_id, deleted_at, updated_at)");
}

/** Apply idempotent migrations needed by databases created by older bot versions. */
export function runDatabaseMigrations(raw: BunDatabase): void {
  for (const sql of [
    "ALTER TABLE messages ADD COLUMN reply_to_id TEXT",
    "ALTER TABLE messages ADD COLUMN is_synthetic INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE messages ADD COLUMN is_prompt_only INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE messages ADD COLUMN related_thread_id TEXT",
    "ALTER TABLE messages ADD COLUMN routed_from_guild_id TEXT",
    "ALTER TABLE messages ADD COLUMN routed_from_channel_id TEXT",
    "ALTER TABLE messages ADD COLUMN routed_from_message_id TEXT",
    "ALTER TABLE messages ADD COLUMN assets_indexed_at INTEGER",
    "ALTER TABLE messages ADD COLUMN deleted_at INTEGER",
    "ALTER TABLE threads ADD COLUMN created_by_bot INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE threads ADD COLUMN archived_at INTEGER",
    "ALTER TABLE memories ADD COLUMN expires_at INTEGER",
    "ALTER TABLE memories ADD COLUMN provenance_json TEXT",
    "ALTER TABLE memories ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK(priority >= 0)",
    "ALTER TABLE memory_extraction_checkpoints ADD COLUMN maintenance_cursor_id INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE schedules ADD COLUMN created_by_user_id TEXT",
    "ALTER TABLE schedules ADD COLUMN created_by_username TEXT",
    "ALTER TABLE schedules ADD COLUMN handoff_note TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE schedules ADD COLUMN fire_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE schedules ADD COLUMN expires_at INTEGER",
    "ALTER TABLE schedules ADD COLUMN max_fire_count INTEGER",
  ]) {
    ignoreExistingColumn(raw, sql);
  }

  raw.run("DROP TABLE IF EXISTS images");

  const memoryColumns = tableColumns(raw, "memories");
  migrateMemoryRecallModel(raw, memoryColumns);

  createMemoryIndexes(raw);
  raw.run("CREATE INDEX IF NOT EXISTS idx_memories_priority_active ON memories(priority, deleted_at, updated_at)");
  sanitizeExistingMemoryRows(raw);
}
