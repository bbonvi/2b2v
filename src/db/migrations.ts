import type { Database as BunDatabase } from "bun:sqlite";
import { sanitizeMemoryContent } from "./memory-content";
import { MEMORY_KIND_SQL_VALUES } from "./memory-kinds";
import { memoriesTableSql, memorySchemaHasCurrentChecks } from "./schema";

type TableColumn = { name: string; type: string };

const STRUCTURED_MEMORY_KIND_SQL = `
  CASE
    WHEN kind IN (${MEMORY_KIND_SQL_VALUES}) THEN kind
    ELSE 'fact'
  END
`;

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

function migrateLegacyMemoryRows(raw: BunDatabase, memoryColumns: readonly TableColumn[]): boolean {
  const hasStructuredMemorySchema = hasColumn(memoryColumns, "subject_user_id")
    && hasColumn(memoryColumns, "content")
    && hasColumn(memoryColumns, "confidence")
    && hasColumn(memoryColumns, "deleted_at");
  if (hasStructuredMemorySchema) return true;

  runInTransaction(raw, () => {
    raw.run(memoriesTableSql("memories_new"));
    raw.run(`INSERT INTO memories_new (scope, guild_id, subject_user_id, kind, content, source_message_id, provenance_json, confidence, priority, created_at, updated_at, expires_at, deleted_at)
      SELECT
        CASE WHEN scope = 'user' THEN 'user' ELSE 'guild' END,
        CASE WHEN scope = 'user' THEN NULL ELSE COALESCE(guild_id, '') END,
        CASE WHEN scope = 'user' THEN user_id ELSE NULL END,
        CASE WHEN scope = 'user' THEN 'user_note' ELSE 'global_note' END,
        CASE
          WHEN (short_description IS NULL OR TRIM(short_description) = '')
               AND (long_description IS NULL OR TRIM(long_description) = '') THEN ''
          WHEN scope = 'user' AND (short_description IS NULL OR TRIM(short_description) = '') THEN long_description
          WHEN scope = 'user' AND (long_description IS NULL OR TRIM(long_description) = '') THEN short_description
          WHEN scope = 'user' THEN short_description || ': ' || long_description
          WHEN short_description IS NULL OR TRIM(short_description) = '' THEN long_description
          WHEN long_description IS NULL OR TRIM(long_description) = '' THEN short_description
          ELSE short_description || ': ' || long_description
        END,
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
    raw.run("DROP TABLE memories");
    raw.run("ALTER TABLE memories_new RENAME TO memories");
    createMemoryIndexes(raw);
  });
  return false;
}

function migrateStructuredMemoryChecks(raw: BunDatabase, memoryColumns: readonly TableColumn[]): void {
  const memorySchema = raw
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'")
    .get() as { sql: string } | undefined;
  if (memorySchemaHasCurrentChecks(memorySchema?.sql)) return;

  const hasScopeColumn = hasColumn(memoryColumns, "scope");
  const provenanceExpression = hasColumn(memoryColumns, "provenance_json") ? "provenance_json" : "NULL";
  const priorityExpression = hasColumn(memoryColumns, "priority")
    ? "CASE WHEN priority < 0 THEN 0 ELSE COALESCE(priority, 0) END"
    : "0";
  const scopeExpression = hasScopeColumn
    ? "CASE WHEN scope IN ('guild', 'user', 'self') THEN scope WHEN subject_user_id IS NOT NULL THEN 'user' ELSE 'guild' END"
    : "CASE WHEN subject_user_id IS NOT NULL THEN 'user' ELSE 'guild' END";
  const kindExpression = `CASE WHEN ${STRUCTURED_MEMORY_KIND_SQL} = 'journal' AND ${scopeExpression} <> 'self' THEN 'fact' ELSE ${STRUCTURED_MEMORY_KIND_SQL} END`;

  runInTransaction(raw, () => {
    raw.run(memoriesTableSql("memories_new"));
    raw.run(`INSERT INTO memories_new (id, scope, guild_id, subject_user_id, kind, content, source_message_id, provenance_json, confidence, priority, created_at, updated_at, expires_at, deleted_at)
      SELECT
        id,
        ${scopeExpression},
        CASE
          WHEN ${scopeExpression} = 'self' THEN NULL
          WHEN subject_user_id IS NOT NULL THEN NULL
          ELSE guild_id
        END,
        CASE WHEN ${scopeExpression} = 'user' THEN subject_user_id ELSE NULL END,
        ${kindExpression},
        TRIM(content),
        source_message_id,
        ${provenanceExpression},
        CASE
          WHEN confidence < 0 THEN 0
          WHEN confidence > 1 THEN 1
          ELSE COALESCE(confidence, 0.7)
        END,
        ${priorityExpression},
        created_at,
        updated_at,
        expires_at,
        deleted_at
      FROM memories
      WHERE TRIM(content) <> ''
        AND (kind IS NULL OR kind <> 'project')
        AND (kind IS NULL OR kind <> 'scratchpad' OR expires_at IS NOT NULL)`);
    raw.run("DROP TABLE memories");
    raw.run("ALTER TABLE memories_new RENAME TO memories");
    createMemoryIndexes(raw);
  });
}

function createMemoryIndexes(raw: BunDatabase): void {
  raw.run("CREATE INDEX IF NOT EXISTS idx_memories_guild_subject ON memories(guild_id, subject_user_id)");
  raw.run("CREATE INDEX IF NOT EXISTS idx_memories_guild_active ON memories(guild_id, deleted_at)");
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
  const hasStructuredMemorySchema = migrateLegacyMemoryRows(raw, memoryColumns);
  if (hasStructuredMemorySchema) migrateStructuredMemoryChecks(raw, memoryColumns);

  createMemoryIndexes(raw);
  raw.run("CREATE INDEX IF NOT EXISTS idx_memories_scope_active ON memories(scope, deleted_at, updated_at)");
  raw.run("CREATE INDEX IF NOT EXISTS idx_memories_priority_active ON memories(priority, deleted_at, updated_at)");
  raw.run(`INSERT OR IGNORE INTO memory_applicability (memory_id, user_id)
    SELECT id, subject_user_id FROM memories
    WHERE scope = 'user' AND subject_user_id IS NOT NULL`);
  sanitizeExistingMemoryRows(raw);
}
