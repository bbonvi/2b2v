import { Database as BunDatabase } from "bun:sqlite";

export interface Database {
  raw: BunDatabase;
  close(): void;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memories (
    id                TEXT PRIMARY KEY,
    scope             TEXT NOT NULL CHECK(scope IN ('user', 'guild_bot', 'global_bot', 'journal')),
    guild_id          TEXT,
    user_id           TEXT,
    content           TEXT NOT NULL DEFAULT '',
    short_description TEXT,
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
    created_at          INTEGER NOT NULL
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
`;

export function createDatabase(dbPath: string): Database {
  const raw = new BunDatabase(dbPath);

  // Performance pragmas
  raw.run("PRAGMA journal_mode = WAL");
  raw.run("PRAGMA foreign_keys = ON");
  raw.run("PRAGMA synchronous = NORMAL");

  // Create core tables
  raw.run(SCHEMA_SQL);

  return {
    raw,
    close() {
      raw.close();
    },
  };
}
