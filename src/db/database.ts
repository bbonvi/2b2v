import { Database as BunDatabase } from "bun:sqlite";
import { MEMORY_KIND_SQL_VALUES, MEMORY_KINDS } from "./memory-kinds";

export interface Database {
  raw: BunDatabase;
  close(): void;
}

const SCRATCHPAD_EXPIRY_CHECK_SQL = "CHECK(kind <> 'scratchpad' OR expires_at IS NOT NULL)";

function memoriesTableSql(tableName: string, ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${tableName} (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id          TEXT NOT NULL,
    subject_user_id   TEXT,
    kind              TEXT NOT NULL CHECK(kind IN (${MEMORY_KIND_SQL_VALUES})),
    content           TEXT NOT NULL CHECK(length(trim(content)) > 0),
    source_message_id TEXT,
    confidence        REAL NOT NULL DEFAULT 0.7 CHECK(confidence >= 0 AND confidence <= 1),
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    expires_at        INTEGER,
    deleted_at        INTEGER,
    ${SCRATCHPAD_EXPIRY_CHECK_SQL}
  )`;
}

function memorySchemaHasCurrentChecks(sql: string | undefined): boolean {
  return sql !== undefined
    && MEMORY_KINDS.every((kind) => sql.includes(`'${kind}'`))
    && !sql.includes("'project'")
    && sql.includes(SCRATCHPAD_EXPIRY_CHECK_SQL)
    && sql.includes("CHECK(length(trim(content)) > 0)");
}

const STRUCTURED_MEMORY_KIND_SQL = `
  CASE
    WHEN kind IN (${MEMORY_KIND_SQL_VALUES}) THEN kind
    ELSE 'fact'
  END
`;

const SCHEMA_SQL = `
  ${memoriesTableSql("memories", true)};

  CREATE TABLE IF NOT EXISTS messages (
    id                  TEXT PRIMARY KEY,
    guild_id            TEXT NOT NULL,
    channel_id          TEXT NOT NULL,
    user_id             TEXT NOT NULL,
    author_username     TEXT NOT NULL,
    raw_content         TEXT NOT NULL,
    translated_content  TEXT NOT NULL,
    is_bot              INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    reply_to_id         TEXT,
    is_synthetic        INTEGER NOT NULL DEFAULT 0,
    is_prompt_only      INTEGER NOT NULL DEFAULT 0,
    related_thread_id   TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_guild_channel_time
    ON messages(guild_id, channel_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_messages_user_guild
    ON messages(user_id, guild_id);

  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id    TEXT NOT NULL,
    guild_id      TEXT NOT NULL,
    channel_id    TEXT NOT NULL,
    emoji_key     TEXT NOT NULL,
    emoji_label   TEXT NOT NULL,
    count         INTEGER NOT NULL CHECK(count >= 0),
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (message_id, emoji_key)
  );

  CREATE INDEX IF NOT EXISTS idx_message_reactions_message
    ON message_reactions(message_id);

  CREATE TABLE IF NOT EXISTS memory_extraction_checkpoints (
    guild_id                 TEXT NOT NULL,
    channel_id               TEXT NOT NULL,
    last_message_id          TEXT,
    last_message_created_at  INTEGER NOT NULL DEFAULT 0,
    last_run_at              INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id                TEXT PRIMARY KEY,
    guild_id          TEXT NOT NULL,
    channel_id        TEXT NOT NULL,
    source            TEXT NOT NULL CHECK(source IN ('admin', 'bot', 'tool')),
    type              TEXT NOT NULL CHECK(type IN ('cron', 'one_off')),
    cron_expression   TEXT,
    run_at            INTEGER,
    timezone          TEXT NOT NULL DEFAULT 'UTC',
    message_content   TEXT NOT NULL,
    enabled           INTEGER NOT NULL DEFAULT 1,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_schedules_guild_enabled
    ON schedules(guild_id, enabled);

  CREATE INDEX IF NOT EXISTS idx_schedules_guild_channel_enabled
    ON schedules(guild_id, channel_id, enabled);

  CREATE TABLE IF NOT EXISTS images (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  TEXT NOT NULL,
    guild_id    TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    caption     TEXT,
    source_kind TEXT NOT NULL DEFAULT 'image' CHECK(source_kind IN ('image', 'gif', 'sticker')),
    path        TEXT NOT NULL,
    mime        TEXT NOT NULL DEFAULT 'image/jpeg',
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_images_message_id
    ON images(message_id);

  CREATE INDEX IF NOT EXISTS idx_images_guild_channel
    ON images(guild_id, channel_id);

  CREATE TABLE IF NOT EXISTS threads (
    thread_id           TEXT PRIMARY KEY,
    guild_id            TEXT NOT NULL,
    parent_chat_id      TEXT NOT NULL,
    starter_message_id  TEXT NOT NULL,
    thread_name         TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    last_activity_at    INTEGER NOT NULL,
    message_count       INTEGER NOT NULL DEFAULT 0,
    last_message_id     TEXT,
    bot_participating   INTEGER NOT NULL DEFAULT 0,
    created_by_bot      INTEGER NOT NULL DEFAULT 1,
    archived_at         INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_threads_parent_chat
    ON threads(parent_chat_id);

  CREATE INDEX IF NOT EXISTS idx_threads_guild
    ON threads(guild_id);
`;

export function createDatabase(dbPath: string): Database {
  const raw = new BunDatabase(dbPath);

  // Performance pragmas
  raw.run("PRAGMA journal_mode = WAL");
  raw.run("PRAGMA foreign_keys = ON");
  raw.run("PRAGMA synchronous = NORMAL");

  // Create core tables
  raw.run(SCHEMA_SQL);

  // Idempotent migration: add reply_to_id to existing databases
  try { raw.run("ALTER TABLE messages ADD COLUMN reply_to_id TEXT"); } catch { /* already exists */ }

  // Idempotent migration: add is_synthetic and related_thread_id to existing databases
  try { raw.run("ALTER TABLE messages ADD COLUMN is_synthetic INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try { raw.run("ALTER TABLE messages ADD COLUMN is_prompt_only INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try { raw.run("ALTER TABLE messages ADD COLUMN related_thread_id TEXT"); } catch { /* already exists */ }
  try { raw.run("ALTER TABLE images ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'image' CHECK(source_kind IN ('image', 'gif', 'sticker'))"); } catch { /* already exists */ }

  // Idempotent migration: thread ownership and close/archive state.
  try { raw.run("ALTER TABLE threads ADD COLUMN created_by_bot INTEGER NOT NULL DEFAULT 1"); } catch { /* already exists */ }
  try { raw.run("ALTER TABLE threads ADD COLUMN archived_at INTEGER"); } catch { /* already exists */ }

  // Idempotent migration: add optional expiry to memories before shape migrations can copy it.
  try { raw.run("ALTER TABLE memories ADD COLUMN expires_at INTEGER"); } catch { /* already exists */ }

  // Migration: legacy memory rows -> structured memories.
  const memoryColumns = raw.prepare("PRAGMA table_info(memories)").all() as { name: string; type: string }[];
  const hasStructuredMemorySchema = memoryColumns.some((c) => c.name === "subject_user_id")
    && memoryColumns.some((c) => c.name === "content")
    && memoryColumns.some((c) => c.name === "confidence")
    && memoryColumns.some((c) => c.name === "deleted_at");
  if (!hasStructuredMemorySchema) {
    raw.run("BEGIN TRANSACTION");
    try {
      raw.run(memoriesTableSql("memories_new"));
      raw.run(`INSERT INTO memories_new (guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, expires_at, deleted_at)
        SELECT
          COALESCE(guild_id, ''),
          CASE WHEN scope = 'user' THEN user_id ELSE NULL END,
          CASE WHEN scope = 'user' THEN 'user_note' ELSE 'global_note' END,
          CASE
            WHEN (short_description IS NULL OR TRIM(short_description) = '')
                 AND (long_description IS NULL OR TRIM(long_description) = '') THEN ''
            WHEN short_description IS NULL OR TRIM(short_description) = '' THEN long_description
            WHEN long_description IS NULL OR TRIM(long_description) = '' THEN short_description
            ELSE short_description || ': ' || long_description
          END,
          source_message_id,
          0.7,
          created_at,
          updated_at,
          CASE WHEN expires_at IS NOT NULL AND expires_at > (strftime('%s','now') * 1000) THEN expires_at ELSE NULL END,
          CASE WHEN expires_at IS NOT NULL AND expires_at <= (strftime('%s','now') * 1000) THEN expires_at ELSE NULL END
        FROM memories
        WHERE COALESCE(TRIM(short_description), '') <> '' OR COALESCE(TRIM(long_description), '') <> ''`);
      raw.run("DROP TABLE memories");
      raw.run("ALTER TABLE memories_new RENAME TO memories");
      raw.run("CREATE INDEX IF NOT EXISTS idx_memories_guild_subject ON memories(guild_id, subject_user_id)");
      raw.run("CREATE INDEX IF NOT EXISTS idx_memories_guild_active ON memories(guild_id, deleted_at)");
      raw.run("COMMIT");
    } catch (e) {
      raw.run("ROLLBACK");
      throw e;
    }
  }

  const memorySchema = raw
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'")
    .get() as { sql: string } | undefined;
  if (hasStructuredMemorySchema && !memorySchemaHasCurrentChecks(memorySchema?.sql)) {
    raw.run("BEGIN TRANSACTION");
    try {
      raw.run(memoriesTableSql("memories_new"));
      raw.run(`INSERT INTO memories_new (id, guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, expires_at, deleted_at)
        SELECT
          id,
          guild_id,
          subject_user_id,
          ${STRUCTURED_MEMORY_KIND_SQL},
          TRIM(content),
          source_message_id,
          CASE
            WHEN confidence < 0 THEN 0
            WHEN confidence > 1 THEN 1
            ELSE COALESCE(confidence, 0.7)
          END,
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
      raw.run("CREATE INDEX IF NOT EXISTS idx_memories_guild_subject ON memories(guild_id, subject_user_id)");
      raw.run("CREATE INDEX IF NOT EXISTS idx_memories_guild_active ON memories(guild_id, deleted_at)");
      raw.run("COMMIT");
    } catch (e) {
      raw.run("ROLLBACK");
      throw e;
    }
  }

  raw.run("CREATE INDEX IF NOT EXISTS idx_memories_guild_subject ON memories(guild_id, subject_user_id)");
  raw.run("CREATE INDEX IF NOT EXISTS idx_memories_guild_active ON memories(guild_id, deleted_at)");

  return {
    raw,
    close() {
      raw.close();
    },
  };
}
