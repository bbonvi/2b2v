import type { Database as BunDatabase } from "bun:sqlite";
import { sanitizeMemoryContent } from "./memory-content";
import { MEMORY_KIND_SQL_VALUES } from "./memory-kinds";
import { memoriesTableSql, memorySchemaHasCurrentChecks, stagedAssetsTableSql } from "./schema";

type TableColumn = { name: string; type: string; notnull: number };
type ForeignKey = {
  table: string;
  from: string;
  on_delete: string;
};
type RelationshipAxisKey = "trust" | "warmth" | "respect" | "tension" | "attraction" | "intimacy";

const RELATIONSHIP_AXIS_CORRECTION_ID = "relationship-axis-correction-2026-07-31";

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

function numericAxis(axes: Record<string, unknown>, axis: RelationshipAxisKey): number {
  const value = axes[axis];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function roundedAxis(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Correct historic relationship drift once. The migration preserves source
 * events and profile recency because this is calibration, not a new encounter.
 */
function migrateRelationshipAxisCorrection(raw: BunDatabase): void {
  if (raw.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(RELATIONSHIP_AXIS_CORRECTION_ID) !== null) {
    return;
  }
  const rows = raw.prepare("SELECT user_id, axes_json FROM relationship_profiles")
    .all() as Array<{ user_id: string; axes_json: string }>;
  const update = raw.prepare("UPDATE relationship_profiles SET axes_json = ? WHERE user_id = ?");
  runInTransaction(raw, () => {
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.axes_json) as unknown;
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const axes = parsed as Record<string, unknown>;
      const corrected = { ...axes };
      let changed = false;
      const warmth = numericAxis(axes, "warmth");
      const intimacy = numericAxis(axes, "intimacy");
      const attraction = numericAxis(axes, "attraction");
      const tension = numericAxis(axes, "tension");
      const respect = numericAxis(axes, "respect");
      const trust = numericAxis(axes, "trust");

      if (warmth >= 40 && intimacy > 0) {
        const nextAttraction = roundedAxis(Math.max(attraction, intimacy * 0.9));
        if (nextAttraction !== attraction) {
          corrected.attraction = nextAttraction;
          changed = true;
        }
      }
      if ((warmth >= 20 && tension > 0) || tension > 30) {
        corrected.tension = roundedAxis(tension / 3);
        changed = true;
      }
      if (respect < -30) {
        corrected.respect = roundedAxis(respect / 3);
        changed = true;
      }
      if (trust < -30) {
        corrected.trust = roundedAxis(trust / 2);
        changed = true;
      }

      if (changed) update.run(JSON.stringify(corrected), row.user_id);
    }
    raw.prepare("INSERT INTO data_migrations (id, applied_at) VALUES (?, ?)")
      .run(RELATIONSHIP_AXIS_CORRECTION_ID, Date.now());
  });
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
  const importantUntilExpression = hasColumn(memoryColumns, "important_until") ? "important_until" : "NULL";
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
      raw.run(`INSERT INTO memories_new (id, about_type, about_user_id, recall_scope, recall_guild_id, recall_mode, kind, content, source_message_id, provenance_json, confidence, priority, important_until, created_at, updated_at, expires_at, deleted_at)
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
          ${importantUntilExpression},
          created_at,
          updated_at,
          expires_at,
          deleted_at
        FROM memories
        WHERE TRIM(content) <> ''`);
    } else {
      raw.run(`INSERT INTO memories_new (about_type, about_user_id, recall_scope, recall_guild_id, recall_mode, kind, content, source_message_id, provenance_json, confidence, priority, important_until, created_at, updated_at, expires_at, deleted_at)
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
          NULL,
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

function createStagedAssetIndexes(raw: BunDatabase): void {
  raw.run("CREATE INDEX IF NOT EXISTS idx_staged_assets_owner ON staged_assets(owner_guild_id, owner_channel_id, created_at)");
  raw.run("CREATE INDEX IF NOT EXISTS idx_staged_assets_expiry ON staged_assets(expires_at)");
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function ensureIndex(raw: BunDatabase, name: string, sql: string): void {
  const existing = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name) as { sql: string | null } | null;
  if (existing?.sql !== null && existing?.sql !== undefined
      && normalizedSql(existing.sql) === normalizedSql(sql)) {
    return;
  }
  raw.run(`DROP INDEX IF EXISTS ${name}`);
  raw.run(sql);
}

function createMessageSearchIndexes(raw: BunDatabase): void {
  ensureIndex(
    raw,
    "idx_messages_guild_channel_time",
    "CREATE INDEX idx_messages_guild_channel_time ON messages(guild_id, channel_id, created_at DESC, id DESC)",
  );
  ensureIndex(
    raw,
    "idx_messages_guild_time",
    "CREATE INDEX idx_messages_guild_time ON messages(guild_id, created_at DESC, id DESC)",
  );
  ensureIndex(
    raw,
    "idx_messages_time",
    "CREATE INDEX idx_messages_time ON messages(created_at DESC, id DESC)",
  );
  ensureIndex(
    raw,
    "idx_messages_user_bot_time",
    "CREATE INDEX idx_messages_user_bot_time ON messages(user_id, is_bot, created_at DESC, id DESC)",
  );
}

function messageAssetsSupportLinks(raw: BunDatabase): boolean {
  const row = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_assets'")
    .get() as { sql: string | null } | null;
  const sql = row?.sql ?? "";
  return sql.includes("'url'") && sql.includes("'link'");
}

/** Expand the checked asset unions while preserving stable IDs and child references. */
function migrateMessageAssets(raw: BunDatabase): void {
  if (messageAssetsSupportLinks(raw)) return;
  const expectedCount = (raw.prepare("SELECT COUNT(*) AS count FROM message_assets").get() as { count: number }).count;
  raw.run("PRAGMA foreign_keys = OFF");
  try {
    runInTransaction(raw, () => {
      raw.run("DROP TABLE IF EXISTS message_assets_new");
      raw.run(`CREATE TABLE message_assets_new (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id            TEXT NOT NULL,
        guild_id              TEXT NOT NULL,
        channel_id            TEXT NOT NULL,
        source_kind           TEXT NOT NULL CHECK(source_kind IN ('attachment', 'embed', 'sticker', 'url')),
        source_key            TEXT NOT NULL,
        kind                  TEXT NOT NULL CHECK(kind IN ('image', 'gif', 'audio', 'video', 'text', 'file', 'link')),
        filename              TEXT,
        content_type          TEXT,
        size                  INTEGER,
        width                 INTEGER,
        height                INTEGER,
        duration_seconds      REAL,
        extracted_text        TEXT,
        extraction_provider   TEXT,
        extracted_at          INTEGER,
        created_at            INTEGER NOT NULL,
        UNIQUE(message_id, source_kind, source_key)
      )`);
      raw.run(`INSERT INTO message_assets_new
        (id, message_id, guild_id, channel_id, source_kind, source_key, kind, filename, content_type,
         size, width, height, duration_seconds, extracted_text, extraction_provider, extracted_at, created_at)
        SELECT id, message_id, guild_id, channel_id, source_kind, source_key, kind, filename, content_type,
         size, width, height, duration_seconds, extracted_text, extraction_provider, extracted_at, created_at
        FROM message_assets`);
      const copiedCount = (raw.prepare("SELECT COUNT(*) AS count FROM message_assets_new").get() as { count: number }).count;
      if (copiedCount !== expectedCount) {
        throw new Error(`Message asset migration copied ${copiedCount} of ${expectedCount} rows.`);
      }
      raw.run("DROP TABLE message_assets");
      raw.run("ALTER TABLE message_assets_new RENAME TO message_assets");
      raw.run("CREATE INDEX idx_message_assets_message ON message_assets(message_id)");
      raw.run("CREATE INDEX idx_message_assets_guild_channel ON message_assets(guild_id, channel_id)");
    });
  } finally {
    raw.run("PRAGMA foreign_keys = ON");
  }
  const violation = raw.prepare("PRAGMA foreign_key_check").get();
  if (violation !== null) throw new Error(`Message asset migration left a foreign-key violation: ${JSON.stringify(violation)}`);
}

function stagedAssetReferenceUsesSetNull(raw: BunDatabase): boolean {
  const foreignKeys = raw.prepare("PRAGMA foreign_key_list(staged_assets)").all() as ForeignKey[];
  return foreignKeys.some((foreignKey) =>
    foreignKey.table === "message_assets"
    && foreignKey.from === "permanent_asset_id"
    && foreignKey.on_delete.toUpperCase() === "SET NULL"
  );
}

/** Rebuild legacy staged assets without retired columns or blocking asset references. */
function migrateStagedAssets(raw: BunDatabase): void {
  const columns = tableColumns(raw, "staged_assets");
  const jobIdColumn = columns.find((column) => column.name === "job_id");
  if (
    !hasColumn(columns, "owner_room_kind")
    && !hasColumn(columns, "dismissed_at")
    && stagedAssetReferenceUsesSetNull(raw)
    && jobIdColumn?.notnull === 0
  ) {
    createStagedAssetIndexes(raw);
    return;
  }
  const expectedCount = (raw.prepare("SELECT COUNT(*) AS count FROM staged_assets").get() as { count: number }).count;
  runInTransaction(raw, () => {
    raw.run("DROP TABLE IF EXISTS staged_assets_new");
    raw.run(stagedAssetsTableSql("staged_assets_new"));
    raw.run(`INSERT INTO staged_assets_new
      (ref, job_id, owner_guild_id, owner_channel_id, filename, content_type,
       storage_path, created_at, expires_at, delivered_message_id, permanent_asset_id)
      SELECT ref, job_id, owner_guild_id, owner_channel_id, filename, content_type,
       storage_path, created_at, expires_at, delivered_message_id, permanent_asset_id
      FROM staged_assets`);
    const copiedCount = (raw.prepare("SELECT COUNT(*) AS count FROM staged_assets_new").get() as { count: number }).count;
    if (copiedCount !== expectedCount) {
      throw new Error(`Staged asset migration copied ${copiedCount} of ${expectedCount} rows.`);
    }
    raw.run("DROP TABLE staged_assets");
    raw.run("ALTER TABLE staged_assets_new RENAME TO staged_assets");
    createStagedAssetIndexes(raw);
  });
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
    "ALTER TABLE messages ADD COLUMN webhook_id TEXT",
    "ALTER TABLE threads ADD COLUMN created_by_bot INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE threads ADD COLUMN archived_at INTEGER",
    "ALTER TABLE memories ADD COLUMN expires_at INTEGER",
    "ALTER TABLE memories ADD COLUMN provenance_json TEXT",
    "ALTER TABLE memories ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK(priority >= 0)",
    "ALTER TABLE memories ADD COLUMN important_until INTEGER",
    "ALTER TABLE memory_extraction_checkpoints ADD COLUMN maintenance_cursor_id INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE schedules ADD COLUMN created_by_user_id TEXT",
    "ALTER TABLE schedules ADD COLUMN created_by_username TEXT",
    "ALTER TABLE schedules ADD COLUMN handoff_note TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE schedules ADD COLUMN fire_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE schedules ADD COLUMN expires_at INTEGER",
    "ALTER TABLE schedules ADD COLUMN max_fire_count INTEGER",
    "ALTER TABLE dice_rolls ADD COLUMN target INTEGER",
    "ALTER TABLE dice_rolls ADD COLUMN succeeded INTEGER CHECK(succeeded IS NULL OR succeeded IN (0, 1))",
    "ALTER TABLE dice_rolls ADD COLUMN actor_name TEXT",
    "ALTER TABLE dice_rolls ADD COLUMN trait TEXT",
    "ALTER TABLE dice_rolls ADD COLUMN lang TEXT NOT NULL DEFAULT 'en' CHECK(lang IN ('en', 'ru'))",
    "ALTER TABLE dice_rolls ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0 CHECK(is_private IN (0, 1))",
    "ALTER TABLE private_life_episodes ADD COLUMN action_scope TEXT NOT NULL DEFAULT 'reflect-only'",
    "ALTER TABLE voice_participants ADD COLUMN present_at_start INTEGER NOT NULL DEFAULT 0 CHECK(present_at_start IN (0, 1))",
    "ALTER TABLE voice_output_turns ADD COLUMN trigger_segment_id INTEGER REFERENCES voice_transcript_segments(id)",
    "ALTER TABLE voice_sessions ADD COLUMN handoff_json TEXT",
    "ALTER TABLE agent_jobs ADD COLUMN parent_job_id TEXT REFERENCES agent_jobs(id) ON DELETE CASCADE",
    "ALTER TABLE agent_jobs ADD COLUMN checkpoint_json TEXT",
    "ALTER TABLE agent_jobs ADD COLUMN status_changed_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE agent_jobs ADD COLUMN handoff_notified_at INTEGER",
  ]) {
    ignoreExistingColumn(raw, sql);
  }

  raw.run(`CREATE TABLE IF NOT EXISTS voice_runtime_events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id         TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    trigger_segment_id INTEGER REFERENCES voice_transcript_segments(id),
    output_turn_id     TEXT REFERENCES voice_output_turns(id) ON DELETE CASCADE,
    phase              TEXT NOT NULL,
    occurred_at        INTEGER NOT NULL,
    duration_ms        INTEGER,
    detail_json        TEXT
  )`);
  raw.run(`CREATE INDEX IF NOT EXISTS idx_voice_runtime_events_session_time
    ON voice_runtime_events(session_id, occurred_at, id)`);
  raw.run(`CREATE TABLE IF NOT EXISTS voice_stt_usage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    provider    TEXT NOT NULL CHECK(provider IN ('elevenlabs', 'faster-whisper')),
    model       TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    audio_ms    INTEGER NOT NULL CHECK(audio_ms >= 0),
    outcome     TEXT NOT NULL CHECK(outcome IN ('committed', 'failed')),
    error       TEXT
  )`);
  raw.run(`CREATE INDEX IF NOT EXISTS idx_voice_stt_usage_provider_time
    ON voice_stt_usage(provider, started_at)`);
  raw.run(`CREATE INDEX IF NOT EXISTS idx_voice_stt_usage_session_time
    ON voice_stt_usage(session_id, started_at)`);

  raw.run(`UPDATE agent_jobs
    SET status_changed_at = COALESCE(completed_at, started_at, created_at)
    WHERE status_changed_at = 0`);
  raw.run("CREATE INDEX IF NOT EXISTS idx_agent_jobs_parent ON agent_jobs(parent_job_id, created_at)");
  raw.run(`CREATE TABLE IF NOT EXISTS agent_job_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id        TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
    source_job_id TEXT REFERENCES agent_jobs(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK(kind IN ('message', 'child_result')),
    payload_json  TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    consumed_at   INTEGER,
    UNIQUE(job_id, source_job_id, kind)
  )`);
  raw.run(`CREATE INDEX IF NOT EXISTS idx_agent_job_events_pending
    ON agent_job_events(job_id, consumed_at, created_at, id)`);

  raw.run(`UPDATE voice_output_turns AS output
    SET trigger_segment_id = (
      SELECT segment.id FROM voice_transcript_segments AS segment
      WHERE segment.session_id = output.session_id
        AND segment.started_at <= output.started_at
      ORDER BY segment.started_at DESC, segment.id DESC
      LIMIT 1
    )
    WHERE output.trigger_segment_id IS NULL`);

  raw.run("DROP TABLE IF EXISTS images");

  const memoryColumns = tableColumns(raw, "memories");
  migrateMemoryRecallModel(raw, memoryColumns);

  createMemoryIndexes(raw);
  raw.run("CREATE INDEX IF NOT EXISTS idx_memories_priority_active ON memories(priority, deleted_at, updated_at)");
  createMessageSearchIndexes(raw);
  sanitizeExistingMemoryRows(raw);
  migrateMessageAssets(raw);
  ignoreExistingColumn(
    raw,
    "ALTER TABLE message_assets ADD COLUMN original_asset_id INTEGER REFERENCES message_assets(id) ON DELETE SET NULL",
  );
  migrateStagedAssets(raw);
  migrateRelationshipAxisCorrection(raw);
}
