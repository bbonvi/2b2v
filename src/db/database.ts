import { Database as BunDatabase } from "bun:sqlite";

export interface Database {
  raw: BunDatabase;
  close(): void;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memories (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    scope             TEXT NOT NULL CHECK(scope IN ('user', 'journal')),
    guild_id          TEXT,
    user_id           TEXT,
    short_description TEXT NOT NULL DEFAULT '',
    long_description  TEXT,
    source_message_id TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    expires_at        INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_memories_scope_guild_user
    ON memories(scope, guild_id, user_id);

  CREATE INDEX IF NOT EXISTS idx_memories_expires
    ON memories(expires_at)
    WHERE expires_at IS NOT NULL;

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
    reply_to_id         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_guild_channel_time
    ON messages(guild_id, channel_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_messages_user_guild
    ON messages(user_id, guild_id);

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

  CREATE TABLE IF NOT EXISTS images (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  TEXT NOT NULL,
    guild_id    TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    caption     TEXT,
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

  // Migration: remove content column from memories (replaced by short_description)
  try { raw.run("UPDATE memories SET short_description = content WHERE short_description IS NULL OR short_description = ''"); } catch { /* column may not exist */ }
  try { raw.run("ALTER TABLE memories DROP COLUMN content"); } catch { /* already dropped */ }

  // Migration: memories id TEXT → INTEGER AUTOINCREMENT
  const memIdCol = (raw.prepare("PRAGMA table_info(memories)").all() as { name: string; type: string }[])
    .find((c) => c.name === "id");
  if (memIdCol !== undefined && memIdCol.type === "TEXT") {
    raw.run("BEGIN TRANSACTION");
    try {
      raw.run(`CREATE TABLE memories_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        scope             TEXT NOT NULL CHECK(scope IN ('user', 'journal')),
        guild_id          TEXT,
        user_id           TEXT,
        short_description TEXT NOT NULL DEFAULT '',
        long_description  TEXT,
        source_message_id TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        expires_at        INTEGER
      )`);
      raw.run(`INSERT INTO memories_new (scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
        SELECT scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at FROM memories`);
      raw.run("DROP TABLE memories");
      raw.run("ALTER TABLE memories_new RENAME TO memories");
      raw.run("CREATE INDEX IF NOT EXISTS idx_memories_scope_guild_user ON memories(scope, guild_id, user_id)");
      raw.run("CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL");
      raw.run("COMMIT");
    } catch (e) {
      raw.run("ROLLBACK");
      throw e;
    }
  }

  return {
    raw,
    close() {
      raw.close();
    },
  };
}
