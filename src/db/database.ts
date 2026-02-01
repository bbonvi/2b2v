import { Database as BunDatabase } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

export interface Database {
  raw: BunDatabase;
  close(): void;
}

const EMBEDDING_DIMENSIONS = 1024; // bge-m3 output size

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
`;

export function createDatabase(dbPath: string): Database {
  const raw = new BunDatabase(dbPath);

  // Load sqlite-vec extension
  sqliteVec.load(raw);

  // Performance pragmas
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA synchronous = NORMAL");

  // Create core tables
  raw.exec(SCHEMA_SQL);

  // Create vec0 virtual tables for embeddings
  raw.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding float[${EMBEDDING_DIMENSIONS}]
    );
  `);

  raw.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS message_embeddings USING vec0(
      message_id TEXT PRIMARY KEY,
      embedding float[${EMBEDDING_DIMENSIONS}]
    );
  `);

  return {
    raw,
    close() {
      raw.close();
    },
  };
}
