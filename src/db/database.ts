import { Database as BunDatabase } from "bun:sqlite";
import { runDatabaseMigrations } from "./migrations";
import { SCHEMA_SQL } from "./schema";

export interface Database {
  raw: BunDatabase;
  close(): void;
}

/** Open SQLite, create the current schema, and apply idempotent legacy migrations. */
export function createDatabase(dbPath: string): Database {
  const raw = new BunDatabase(dbPath);

  // Performance pragmas
  raw.run("PRAGMA journal_mode = WAL");
  raw.run("PRAGMA foreign_keys = ON");
  raw.run("PRAGMA synchronous = NORMAL");

  // Create core tables
  raw.run(SCHEMA_SQL);

  runDatabaseMigrations(raw);

  return {
    raw,
    close() {
      raw.close();
    },
  };
}
