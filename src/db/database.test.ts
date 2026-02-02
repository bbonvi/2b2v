import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createDatabase, type Database } from "./database";
import * as fs from "node:fs";
import * as path from "node:path";

let db: Database;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync("/tmp/2bv2-db-test-");
  db = createDatabase(path.join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("database initialization", () => {
  test("creates database file on disk", () => {
    expect(fs.existsSync(path.join(tmpDir, "test.db"))).toBe(true);
  });

  test("enables WAL mode for file-based db", () => {
    const result = db.raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe("wal");
  });

  test("creates memories table", () => {
    const info = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
      .get() as { name: string } | undefined;
    expect(info?.name).toBe("memories");
  });

  test("creates messages table", () => {
    const info = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
      .get() as { name: string } | undefined;
    expect(info?.name).toBe("messages");
  });

});

describe("memories table", () => {
  test("inserts and retrieves a user-scoped memory", () => {
    const now = Date.now();
    const expiresAt = now + 180 * 24 * 60 * 60 * 1000; // 6 months
    db.raw
      .prepare(
        `INSERT INTO memories (id, scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("mem-1", "user", "guild-1", "user-1", "Prefers dark mode", null, "msg-42", now, now, expiresAt);

    const row = db.raw.prepare("SELECT * FROM memories WHERE id = ?").get("mem-1") as Record<string, unknown>;
    expect(row.scope).toBe("user");
    expect(row.guild_id).toBe("guild-1");
    expect(row.user_id).toBe("user-1");
    expect(row.short_description).toBe("Prefers dark mode");
    expect(row.source_message_id).toBe("msg-42");
    expect(row.expires_at).toBe(expiresAt);
  });

  test("inserts a journal entry with short and long descriptions", () => {
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO memories (id, scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("j-1", "journal", "guild-1", "user-1", "Follow up on Alice's project", "Alice mentioned she's working on a Rust compiler. Check in next week.", null, now, now, null);

    const row = db.raw.prepare("SELECT * FROM memories WHERE id = ?").get("j-1") as Record<string, unknown>;
    expect(row.scope).toBe("journal");
    expect(row.short_description).toBe("Follow up on Alice's project");
    expect(row.long_description).toContain("Rust compiler");
    expect(row.guild_id).toBe("guild-1");
    expect(row.user_id).toBe("user-1");
    expect(row.expires_at).toBeNull();
  });

  test("rejects guild_bot scope due to CHECK constraint", () => {
    const now = Date.now();
    const insert = () =>
      db.raw
        .prepare(
          `INSERT INTO memories (id, scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("gb-1", "guild_bot", "guild-1", null, "Movie night is every Friday", null, null, now, now, null);

    expect(insert).toThrow();
  });

  test("rejects global_bot scope due to CHECK constraint", () => {
    const now = Date.now();
    const insert = () =>
      db.raw
        .prepare(
          `INSERT INTO memories (id, scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("glb-1", "global_bot", null, null, "Users generally prefer concise answers", null, null, now, now, null);

    expect(insert).toThrow();
  });

  test("enforces unique id constraint", () => {
    const now = Date.now();
    const insert = () =>
      db.raw
        .prepare(
          `INSERT INTO memories (id, scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("dup-1", "user", "g1", "u1", "test", null, null, now, now, null);

    insert();
    expect(insert).toThrow();
  });

  test("scope_guild_user index supports efficient queries", () => {
    // Verify index exists
    const idx = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_scope_guild_user'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_memories_scope_guild_user");
  });
});

describe("messages table", () => {
  test("inserts and retrieves a message", () => {
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("msg-1", "guild-1", "ch-1", "user-1", "alice", "Hello <@123>!", "Hello @bob!", 0, now);

    const row = db.raw.prepare("SELECT * FROM messages WHERE id = ?").get("msg-1") as Record<string, unknown>;
    expect(row.guild_id).toBe("guild-1");
    expect(row.raw_content).toBe("Hello <@123>!");
    expect(row.translated_content).toBe("Hello @bob!");
    expect(row.is_bot).toBe(0);
  });

  test("enforces unique message id", () => {
    const now = Date.now();
    const insert = () =>
      db.raw
        .prepare(
          `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("msg-dup", "g1", "c1", "u1", "user", "hi", "hi", 0, now);

    insert();
    expect(insert).toThrow();
  });

  test("guild_channel_time index supports efficient queries", () => {
    const idx = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_guild_channel_time'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_messages_guild_channel_time");
  });

  test("user_guild index supports per-user queries", () => {
    const idx = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_user_guild'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_messages_user_guild");
  });
});

describe("images table", () => {
  test("creates images table", () => {
    const info = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='images'")
      .get() as { name: string } | undefined;
    expect(info?.name).toBe("images");
  });

  test("inserts an image with autoincrement ID", () => {
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO images (message_id, guild_id, channel_id, caption, path, mime, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("msg-1", "guild-1", "ch-1", null, "attachments/guild-1-ch-1/images/1.jpg", "image/jpeg", 768, 512, now);

    const row = db.raw.prepare("SELECT * FROM images WHERE message_id = ?").get("msg-1") as Record<string, unknown>;
    expect(row.id).toBe(1);
    expect(row.guild_id).toBe("guild-1");
    expect(row.width).toBe(768);
    expect(row.caption).toBeNull();
  });

  test("autoincrement produces sequential IDs", () => {
    const now = Date.now();
    const insert = db.raw.prepare(
      `INSERT INTO images (message_id, guild_id, channel_id, path, mime, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run("msg-1", "g", "c", "p1.jpg", "image/jpeg", 100, 100, now);
    insert.run("msg-2", "g", "c", "p2.jpg", "image/jpeg", 100, 100, now);
    insert.run("msg-3", "g", "c", "p3.jpg", "image/jpeg", 100, 100, now);

    const rows = db.raw.prepare("SELECT id FROM images ORDER BY id").all() as { id: number }[];
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  test("multiple images per message", () => {
    const now = Date.now();
    const insert = db.raw.prepare(
      `INSERT INTO images (message_id, guild_id, channel_id, path, mime, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run("msg-1", "g", "c", "p1.jpg", "image/jpeg", 100, 100, now);
    insert.run("msg-1", "g", "c", "p2.jpg", "image/jpeg", 200, 200, now);

    const rows = db.raw.prepare("SELECT * FROM images WHERE message_id = ? ORDER BY id").all("msg-1") as { id: number }[];
    expect(rows).toHaveLength(2);
  });

  test("message_id index exists", () => {
    const idx = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_images_message_id'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_images_message_id");
  });
});

describe("in-memory database", () => {
  test("creates database in memory with :memory:", () => {
    const memDb = createDatabase(":memory:");
    const row = memDb.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("memories");
    memDb.close();
  });
});

describe("idempotent initialization", () => {
  test("calling createDatabase twice on same file does not error", () => {
    const dbPath = path.join(tmpDir, "test.db");
    // db already created in beforeEach on different file; create second on same
    const db2 = createDatabase(dbPath);
    const row = db2.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("memories");
    db2.close();
  });
});
