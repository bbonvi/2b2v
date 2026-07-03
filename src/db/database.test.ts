import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createDatabase, type Database } from "./database";
import { Database as BunDatabase } from "bun:sqlite";
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

  test("creates memory expiry column", () => {
    const columns = db.raw.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "expires_at")).toBe(true);
  });

  test("creates messages table", () => {
    const info = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
      .get() as { name: string } | undefined;
    expect(info?.name).toBe("messages");
  });

  test("creates message reactions table", () => {
    const info = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_reactions'")
      .get() as { name: string } | undefined;
    expect(info?.name).toBe("message_reactions");
  });

  test("creates memory extraction checkpoints table", () => {
    const info = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_extraction_checkpoints'")
      .get() as { name: string } | undefined;
    expect(info?.name).toBe("memory_extraction_checkpoints");
  });

  test("creates relationship tables", () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('relationship_profiles', 'relationship_events')")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name).sort()).toEqual(["relationship_events", "relationship_profiles"]);
  });

});

describe("memories table", () => {
  test("inserts and retrieves a user memory", () => {
    const now = Date.now();
    const result = db.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", null, "user-1", "preference", "Prefers dark mode", "msg-42", 0.9, now, now, null);

    const memId = Number(result.lastInsertRowid);
    const row = db.raw.prepare("SELECT * FROM memories WHERE id = ?").get(memId) as Record<string, unknown>;
    expect(row.guild_id).toBeNull();
    expect(row.subject_user_id).toBe("user-1");
    expect(row.kind).toBe("preference");
    expect(row.content).toBe("Prefers dark mode");
    expect(row.source_message_id).toBe("msg-42");
    expect(row.confidence).toBe(0.9);
    expect(row.deleted_at).toBeNull();
  });

  test("inserts a global note without a subject user", () => {
    const now = Date.now();
    const result = db.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("guild", "guild-1", null, "global_note", "Movie night is every Friday", null, 0.8, now, now, null);

    const memId = Number(result.lastInsertRowid);
    const row = db.raw.prepare("SELECT * FROM memories WHERE id = ?").get(memId) as Record<string, unknown>;
    expect(row.guild_id).toBe("guild-1");
    expect(row.subject_user_id).toBeNull();
    expect(row.kind).toBe("global_note");
    expect(row.content).toBe("Movie night is every Friday");
  });

  test("rejects unknown memory kind due to CHECK constraint", () => {
    const now = Date.now();
    const insert = () =>
      db.raw
        .prepare(
          `INSERT INTO memories (scope, guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("guild", "guild-1", null, "unknown", "Movie night is every Friday", null, 0.8, now, now, null);

    expect(insert).toThrow();
  });

  test("accepts current memory kinds", () => {
    const now = Date.now();
    const insert = db.raw.prepare(
      `INSERT INTO memories (scope, guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, expires_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    insert.run("user", null, "user-1", "identity", "Preferred name is Sasha.", null, 0.8, now, now, null, null);
    insert.run("user", null, "user-1", "constraint", "Do not use voice replies.", null, 0.8, now, now, null, null);
    insert.run("user", null, "user-1", "interest", "Likes puzzle games.", null, 0.8, now, now, null, null);
    insert.run("self", null, null, "journal", "Privately decided the test room matters.", null, 0.8, now, now, null, null);
    insert.run("user", null, "user-1", "scratchpad", "Check auth headers next.", null, 0.8, now, now, now + 60_000, null);

    const rows = db.raw.prepare("SELECT kind FROM memories ORDER BY id").all() as Array<{ kind: string }>;
    expect(rows.map((row) => row.kind)).toEqual(["identity", "constraint", "interest", "journal", "scratchpad"]);
  });

  test("rejects legacy project memory kind", () => {
    const now = Date.now();
    const insert = () =>
      db.raw
        .prepare(
          `INSERT INTO memories (scope, guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("guild", "guild-1", null, "project", "Legacy project memory", null, 0.8, now, now, null);

    expect(insert).toThrow();
  });

  test("rejects scratchpad memory without expiry", () => {
    const now = Date.now();
    const insert = () =>
      db.raw
        .prepare(
          `INSERT INTO memories (scope, guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("user", null, "user-1", "scratchpad", "Missing expiry.", null, 0.8, now, now, null);

    expect(insert).toThrow();
  });

  test("rejects journal memories outside self scope", () => {
    const now = Date.now();
    const insert = () =>
      db.raw
        .prepare(
          `INSERT INTO memories (scope, guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("user", null, "user-1", "journal", "Wrong scope.", null, 0.8, now, now, null);

    expect(insert).toThrow();
  });

  test("rejects empty memory content due to CHECK constraint", () => {
    const now = Date.now();
    const insert = () =>
      db.raw
        .prepare(
          `INSERT INTO memories (scope, guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("guild", "guild-1", null, "global_note", "", null, 0.8, now, now, null);

    expect(insert).toThrow();
  });

  test("autoincrement produces unique sequential IDs", () => {
    const now = Date.now();
    const insert = db.raw.prepare(
      `INSERT INTO memories (scope, guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const r1 = insert.run("user", null, "u1", "fact", "first", null, 0.8, now, now, null);
    const r2 = insert.run("user", null, "u1", "fact", "second", null, 0.8, now, now, null);
    const r3 = insert.run("user", null, "u1", "fact", "third", null, 0.8, now, now, null);

    expect(Number(r1.lastInsertRowid)).toBe(1);
    expect(Number(r2.lastInsertRowid)).toBe(2);
    expect(Number(r3.lastInsertRowid)).toBe(3);
  });

  test("guild_subject index supports efficient queries", () => {
    const idx = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_guild_subject'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_memories_guild_subject");
  });

  test("scope index supports self-memory queries", () => {
    const idx = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_scope_active'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_memories_scope_active");
  });

  test("migrates old structured memory schema and drops project rows", () => {
    const legacyPath = path.join(tmpDir, "legacy-project.db");
    const legacy = new BunDatabase(legacyPath);
    const now = Date.now();
    legacy.run(`CREATE TABLE memories (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id          TEXT NOT NULL,
      subject_user_id   TEXT,
      kind              TEXT NOT NULL CHECK(kind IN ('global_note', 'user_note', 'preference', 'relationship', 'project', 'fact')),
      content           TEXT NOT NULL,
      source_message_id TEXT,
      confidence        REAL NOT NULL DEFAULT 0.7,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      expires_at        INTEGER,
      deleted_at        INTEGER
    )`);
    const insert = legacy.prepare(
      `INSERT INTO memories (guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, expires_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run("guild-1", null, "project", "Drop this legacy project.", null, 0.7, now, now, null, null);
    insert.run("guild-1", "user-1", "fact", "Keep this fact.", null, 0.7, now, now, null, null);
    legacy.close();

    const migrated = createDatabase(legacyPath);
    try {
      const rows = migrated.raw.prepare("SELECT kind, content FROM memories ORDER BY id").all() as Array<{ kind: string; content: string }>;
      const schema = migrated.raw
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'")
        .get() as { sql: string };

      expect(rows).toEqual([{ kind: "fact", content: "Keep this fact." }]);
      expect(schema.sql).toContain("'identity'");
      expect(schema.sql).toContain("'journal'");
      expect(schema.sql).toContain("scope IN ('guild', 'user', 'self')");
      expect(schema.sql).toContain("kind <> 'scratchpad' OR expires_at IS NOT NULL");
      expect(schema.sql).toContain("kind <> 'journal' OR scope = 'self'");
      expect(schema.sql).toContain("scope = 'user' AND subject_user_id IS NOT NULL AND guild_id IS NULL");
      expect(schema.sql).not.toContain("'project'");
    } finally {
      migrated.close();
    }
  });

  test("sanitizes existing malformed memory content on startup", () => {
    const dbPath = path.join(tmpDir, "malformed-memory.db");
    const existing = createDatabase(dbPath);
    const now = Date.now();
    existing.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, expires_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "user",
        null,
        "user-1",
        "preference",
        "In guild guild-1: 17 [user:user-1] [preference] Prefers concise answers.",
        null,
        0.7,
        now,
        now,
        null,
        null,
      );
    existing.close();

    const migrated = createDatabase(dbPath);
    try {
      const row = migrated.raw.prepare("SELECT content FROM memories").get() as { content: string };
      expect(row.content).toBe("Prefers concise answers.");
    } finally {
      migrated.close();
    }
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

  test("is_synthetic defaults to 0 for regular messages", () => {
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("msg-syn-1", "guild-1", "ch-1", "user-1", "alice", "Hi", "Hi", 0, now);

    const row = db.raw.prepare("SELECT is_synthetic, related_thread_id FROM messages WHERE id = ?").get("msg-syn-1") as { is_synthetic: number; related_thread_id: string | null };
    expect(row.is_synthetic).toBe(0);
    expect(row.related_thread_id).toBeNull();
  });

  test("synthetic message can be inserted with is_synthetic=1 and related_thread_id", () => {
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, is_synthetic, related_thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("msg-syn-2", "guild-1", "ch-1", "bot-id", "Bot", "Thread created", "Thread created", 1, now, 1, "thread-123");

    const row = db.raw.prepare("SELECT is_synthetic, related_thread_id FROM messages WHERE id = ?").get("msg-syn-2") as { is_synthetic: number; related_thread_id: string | null };
    expect(row.is_synthetic).toBe(1);
    expect(row.related_thread_id).toBe("thread-123");
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
    expect(row.source_kind).toBe("image");
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

  test("source_kind only accepts known media kinds", () => {
    expect(() => {
      db.raw
        .prepare(
          `INSERT INTO images (message_id, guild_id, channel_id, source_kind, path, mime, width, height, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("msg-bad", "g", "c", "video", "p.jpg", "image/jpeg", 100, 100, Date.now());
    }).toThrow();
  });
});

describe("threads table", () => {
  test("creates threads table", () => {
    const info = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'")
      .get() as { name: string } | undefined;
    expect(info?.name).toBe("threads");
  });

  test("inserts and retrieves a thread", () => {
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO threads (thread_id, guild_id, parent_chat_id, starter_message_id, thread_name, created_at, last_activity_at, message_count, bot_participating)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("thread-1", "guild-1", "ch-1", "msg-trigger", "Help Thread", now, now, 0, 0);

    const row = db.raw.prepare("SELECT * FROM threads WHERE thread_id = ?").get("thread-1") as Record<string, unknown>;
    expect(row.guild_id).toBe("guild-1");
    expect(row.parent_chat_id).toBe("ch-1");
    expect(row.starter_message_id).toBe("msg-trigger");
    expect(row.thread_name).toBe("Help Thread");
    expect(row.bot_participating).toBe(0);
    expect(row.message_count).toBe(0);
  });

  test("enforces unique thread_id", () => {
    const now = Date.now();
    const insert = () =>
      db.raw
        .prepare(
          `INSERT INTO threads (thread_id, guild_id, parent_chat_id, starter_message_id, thread_name, created_at, last_activity_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run("thread-dup", "g1", "c1", "m1", "Thread", now, now);

    insert();
    expect(insert).toThrow();
  });

  test("parent_chat index exists", () => {
    const idx = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_threads_parent_chat'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_threads_parent_chat");
  });

  test("guild index exists", () => {
    const idx = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_threads_guild'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_threads_guild");
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
