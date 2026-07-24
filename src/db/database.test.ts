import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createDatabase, type Database } from "./database";
import { Database as BunDatabase } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMemory, getMemory } from "./memory-repository";
import { createStagedAsset, getStagedAsset } from "./staged-asset-repository.ts";

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

  test("creates memory priority column", () => {
    const columns = db.raw.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "priority")).toBe(true);
  });

  test("creates memory recall-user table and lookup index", () => {
    const table = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_recall_users'")
      .get() as { name: string } | undefined;
    const index = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_recall_users_user'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe("memory_recall_users");
    expect(index?.name).toBe("idx_memory_recall_users_user");
  });

  test("preserves always recall across restarts", () => {
    const dbPath = path.join(tmpDir, "always-recall.db");
    const existing = createDatabase(dbPath);
    const id = createMemory(existing, {
      guildId: "g1",
      aboutUserId: "u1",
      recallWhen: "always",
      kind: "preference",
      content: "Recall broadly.",
    });
    existing.close();

    const reopened = createDatabase(dbPath);
    try {
      expect(getMemory(reopened, id)?.recallWhen).toBe("always");
      expect(reopened.raw.prepare("SELECT user_id FROM memory_recall_users WHERE memory_id = ?").all(id)).toEqual([]);
    } finally {
      reopened.close();
    }
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

  test("adds current columns to existing dice audit tables", () => {
    const dbPath = path.join(tmpDir, "legacy-dice.db");
    const legacy = new BunDatabase(dbPath);
    legacy.run(`CREATE TABLE dice_rolls (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    legacy.close();

    const migrated = createDatabase(dbPath);
    try {
      const columns = migrated.raw.prepare("PRAGMA table_info(dice_rolls)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "target")).toBe(true);
      expect(columns.some((column) => column.name === "succeeded")).toBe(true);
      expect(columns.some((column) => column.name === "actor_name")).toBe(true);
      expect(columns.some((column) => column.name === "trait")).toBe(true);
      expect(columns.some((column) => column.name === "lang")).toBe(true);
      expect(columns.some((column) => column.name === "is_private")).toBe(true);
    } finally {
      migrated.close();
    }
  });

  test("creates durable agent job and asset provenance tables", () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_jobs', 'agent_job_assets')")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name).sort()).toEqual(["agent_job_assets", "agent_jobs"]);
  });

  test("migrates legacy staged asset room ownership without losing outputs", () => {
    const dbPath = path.join(tmpDir, "legacy-staged-assets.db");
    const existing = createDatabase(dbPath);
    existing.raw.run(`INSERT INTO agent_jobs
      (id, kind, guild_id, channel_id, delivery_guild_id, delivery_channel_id,
       requester_id, requester_username, source_message_id, source_quote, status,
       input_json, created_at, replacement_count)
      VALUES ('img-old', 'image_generation', 'g1', 'c1', 'g1', 'c1',
       'u1', 'alice', 'm1', 'quote', 'ready', '{}', 1, 0)`);
    createStagedAsset(existing, {
      ref: "job_imgold",
      jobId: "img-old",
      ownerGuildId: "g1",
      ownerChannelId: "c1",
      filename: "old.webp",
      contentType: "image/webp",
      storagePath: "/tmp/old.webp",
      createdAt: 10,
      expiresAt: 20,
    });
    existing.close();

    const legacy = new BunDatabase(dbPath);
    legacy.run(`CREATE TABLE staged_assets_legacy (
      ref TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES agent_jobs(id) ON DELETE CASCADE,
      owner_room_kind TEXT NOT NULL CHECK(owner_room_kind IN ('text', 'voice')),
      owner_guild_id TEXT NOT NULL,
      owner_channel_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      delivered_message_id TEXT,
      permanent_asset_id INTEGER REFERENCES message_assets(id),
      dismissed_at INTEGER
    )`);
    legacy.run(`INSERT INTO staged_assets_legacy
      SELECT ref, job_id, 'text', owner_guild_id, owner_channel_id, filename,
       content_type, storage_path, created_at, expires_at, delivered_message_id,
       permanent_asset_id, NULL
      FROM staged_assets`);
    legacy.run("DROP TABLE staged_assets");
    legacy.run("ALTER TABLE staged_assets_legacy RENAME TO staged_assets");
    legacy.close();

    const migrated = createDatabase(dbPath);
    try {
      const columns = migrated.raw.prepare("PRAGMA table_info(staged_assets)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "owner_room_kind")).toBe(false);
      expect(columns.some((column) => column.name === "dismissed_at")).toBe(false);
      expect(getStagedAsset(migrated, "job_imgold")).toMatchObject({
        jobId: "img-old",
        ownerGuildId: "g1",
        ownerChannelId: "c1",
        storagePath: "/tmp/old.webp",
      });

      migrated.raw.run(`INSERT INTO agent_jobs
        (id, kind, guild_id, channel_id, delivery_guild_id, delivery_channel_id,
         requester_id, requester_username, source_message_id, source_quote, status,
         input_json, created_at, replacement_count)
        VALUES ('img-new', 'image_generation', 'g1', 'c1', 'g1', 'c1',
         'u1', 'alice', 'm2', 'quote', 'ready', '{}', 2, 0)`);
      createStagedAsset(migrated, {
        ref: "job_imgnew",
        jobId: "img-new",
        ownerGuildId: "g1",
        ownerChannelId: "c1",
        filename: "new.webp",
        contentType: "image/webp",
        storagePath: "/tmp/new.webp",
        createdAt: 30,
        expiresAt: 40,
      });
      expect(getStagedAsset(migrated, "job_imgnew")?.jobId).toBe("img-new");
      expect(migrated.raw.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally {
      migrated.close();
    }
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

  test("drops the obsolete stored-images table", () => {
    const legacyPath = path.join(tmpDir, "legacy-images.db");
    const legacy = new BunDatabase(legacyPath);
    legacy.run("CREATE TABLE images (id INTEGER PRIMARY KEY, path TEXT NOT NULL)");
    legacy.run("INSERT INTO images (path) VALUES ('obsolete.webp')");
    legacy.close();

    const migrated = createDatabase(legacyPath);
    try {
      const table = migrated.raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='images'")
        .get();
      expect(table).toBeNull();
    } finally {
      migrated.close();
    }
  });

});

describe("memories table", () => {
  test("stores orthogonal about, recall location, and recall trigger fields", () => {
    const userId = createMemory(db, {
      guildId: "guild-1",
      aboutUserId: "user-1",
      kind: "preference",
      content: "Prefers dark mode",
    });
    const communityId = createMemory(db, {
      guildId: "guild-1",
      kind: "note",
      content: "Movie night is every Friday",
    });

    expect(getMemory(db, userId)).toMatchObject({
      about: "user",
      aboutUserId: "user-1",
      recallIn: "anywhere",
      recallWhen: ["user-1"],
    });
    expect(getMemory(db, communityId)).toMatchObject({
      about: "community",
      aboutUserId: null,
      recallIn: { guildId: "guild-1" },
      recallWhen: "always",
    });
  });

  test("enforces memory model invariants in SQLite", () => {
    const now = Date.now();
    const insert = db.raw.prepare(
      `INSERT INTO memories
        (about_type, about_user_id, recall_scope, recall_guild_id, recall_mode, kind, content, confidence, priority, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    );

    expect(() => insert.run("community", null, "anywhere", null, "always", "note", "Invalid community", 0.8, now, now, null)).toThrow();
    expect(() => insert.run("user", null, "anywhere", null, "always", "fact", "Missing user", 0.8, now, now, null)).toThrow();
    expect(() => insert.run("user", "user-1", "anywhere", null, "always", "journal", "Wrong subject", 0.8, now, now, null)).toThrow();
    expect(() => insert.run("user", "user-1", "anywhere", null, "always", "scratchpad", "Missing expiry", 0.8, now, now, null)).toThrow();
    expect(() => insert.run("community", null, "guild", "guild-1", "always", "unknown", "Unknown kind", 0.8, now, now, null)).toThrow();
    expect(() => insert.run("community", null, "guild", "guild-1", "always", "note", "", 0.8, now, now, null)).toThrow();
  });

  test("creates recall indexes", () => {
    const indexes = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_memories_about_user', 'idx_memories_recall_guild', 'idx_memory_recall_users_user')")
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name).sort()).toEqual([
      "idx_memories_about_user",
      "idx_memories_recall_guild",
      "idx_memory_recall_users_user",
    ]);
  });

  test("migrates the production-shaped schema without losing IDs, metadata, or recall links", () => {
    const legacyPath = path.join(tmpDir, "legacy-production-shape.db");
    const legacy = new BunDatabase(legacyPath);
    legacy.run(`CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL CHECK(scope IN ('guild', 'user', 'self')),
      guild_id TEXT,
      subject_user_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('global_note', 'user_note', 'preference', 'relationship', 'project', 'fact', 'identity', 'constraint', 'interest', 'journal', 'scratchpad')),
      content TEXT NOT NULL,
      source_message_id TEXT,
      provenance_json TEXT,
      confidence REAL NOT NULL DEFAULT 0.7,
      priority INTEGER NOT NULL DEFAULT 0,
      applicability_mode TEXT NOT NULL DEFAULT 'all' CHECK(applicability_mode IN ('all', 'users')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      deleted_at INTEGER
    )`);
    const insert = legacy.prepare(`INSERT INTO memories
      (id, scope, guild_id, subject_user_id, kind, content, source_message_id, provenance_json, confidence, priority, applicability_mode, created_at, updated_at, expires_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(41, "guild", "guild-1", null, "global_note", "Community fact", "m41", '{"source":"legacy"}', 0.91, 2, "all", 1001, 1002, null, null);
    insert.run(42, "user", null, "user-1", "user_note", "User fact", "m42", '{"sourceMessageIds":["m42"]}', 0.82, 0, "users", 2001, 2002, 9001, null);
    insert.run(43, "self", null, null, "journal", "Selective self memory", null, null, 0.73, 1, "users", 3001, 3002, null, 8001);
    insert.run(44, "guild", "guild-1", null, "project", "Legacy project context", null, null, 0.64, 0, "all", 4001, 4002, null, null);
    insert.run(45, "user", null, "user-5", "scratchpad", "Legacy non-expiring scratchpad", null, null, 0.55, 0, "users", 5001, 5002, null, null);
    legacy.run(`CREATE TABLE memory_applicability (
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      PRIMARY KEY (memory_id, user_id)
    )`);
    const link = legacy.prepare("INSERT INTO memory_applicability (memory_id, user_id) VALUES (?, ?)");
    link.run(42, "user-1");
    link.run(43, "user-2");
    link.run(43, "user-3");
    link.run(43, "user-4");
    legacy.close();

    const migrated = createDatabase(legacyPath);
    try {
      const rows = migrated.raw.prepare(`SELECT id, about_type, about_user_id, recall_scope, recall_guild_id, recall_mode,
        kind, content, source_message_id, provenance_json, confidence, priority, created_at, updated_at, expires_at, deleted_at
        FROM memories ORDER BY id`).all();
      expect(rows).toEqual([
        { id: 41, about_type: "community", about_user_id: null, recall_scope: "guild", recall_guild_id: "guild-1", recall_mode: "always", kind: "note", content: "Community fact", source_message_id: "m41", provenance_json: '{"source":"legacy"}', confidence: 0.91, priority: 2, created_at: 1001, updated_at: 1002, expires_at: null, deleted_at: null },
        { id: 42, about_type: "user", about_user_id: "user-1", recall_scope: "anywhere", recall_guild_id: null, recall_mode: "users", kind: "note", content: "User fact", source_message_id: "m42", provenance_json: '{"sourceMessageIds":["m42"]}', confidence: 0.82, priority: 0, created_at: 2001, updated_at: 2002, expires_at: 9001, deleted_at: null },
        { id: 43, about_type: "self", about_user_id: null, recall_scope: "anywhere", recall_guild_id: null, recall_mode: "users", kind: "journal", content: "Selective self memory", source_message_id: null, provenance_json: null, confidence: 0.73, priority: 1, created_at: 3001, updated_at: 3002, expires_at: null, deleted_at: 8001 },
        { id: 44, about_type: "community", about_user_id: null, recall_scope: "guild", recall_guild_id: "guild-1", recall_mode: "always", kind: "fact", content: "Legacy project context", source_message_id: null, provenance_json: null, confidence: 0.64, priority: 0, created_at: 4001, updated_at: 4002, expires_at: null, deleted_at: null },
        { id: 45, about_type: "user", about_user_id: "user-5", recall_scope: "anywhere", recall_guild_id: null, recall_mode: "users", kind: "note", content: "Legacy non-expiring scratchpad", source_message_id: null, provenance_json: null, confidence: 0.55, priority: 0, created_at: 5001, updated_at: 5002, expires_at: null, deleted_at: null },
      ]);
      expect(migrated.raw.prepare("SELECT memory_id, user_id FROM memory_recall_users ORDER BY memory_id, user_id").all()).toEqual([
        { memory_id: 42, user_id: "user-1" },
        { memory_id: 43, user_id: "user-2" },
        { memory_id: 43, user_id: "user-3" },
        { memory_id: 43, user_id: "user-4" },
        { memory_id: 45, user_id: "user-5" },
      ]);
      expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_applicability'").get()).toBeNull();
      expect(migrated.raw.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally {
      migrated.close();
    }

    const reopened = createDatabase(legacyPath);
    try {
      expect(reopened.raw.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({ count: 5 });
      expect(reopened.raw.prepare("SELECT COUNT(*) AS count FROM memory_recall_users").get()).toEqual({ count: 5 });
    } finally {
      reopened.close();
    }
  });

  test("sanitizes existing malformed memory content on startup", () => {
    const dbPath = path.join(tmpDir, "malformed-memory.db");
    const existing = createDatabase(dbPath);
    createMemory(existing, {
      guildId: "guild-1",
      aboutUserId: "user-1",
      kind: "preference",
      content: "In guild guild-1: 17 [user:user-1] [preference] Prefers concise answers.",
    });
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
    expect(row.webhook_id).toBeNull();
    expect(row.deleted_at).toBeNull();
  });

  test("stores a Discord webhook ID", () => {
    db.raw
      .prepare(
        `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, webhook_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("msg-webhook", "guild-1", "ch-1", "webhook-1", "GitHub", "PR opened", "PR opened", 1, "webhook-1", Date.now());

    expect(db.raw.prepare("SELECT webhook_id FROM messages WHERE id = ?").get("msg-webhook")).toEqual({
      webhook_id: "webhook-1",
    });
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

  test("message time indexes support keyset search scopes", () => {
    const indexes = db.raw
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index'
        AND name IN ('idx_messages_time', 'idx_messages_guild_time', 'idx_messages_guild_channel_time')
        ORDER BY name`)
      .all() as Array<{ name: string; sql: string }>;
    expect(indexes.map((index) => index.name)).toEqual([
      "idx_messages_guild_channel_time",
      "idx_messages_guild_time",
      "idx_messages_time",
    ]);
    for (const index of indexes) {
      expect(index.sql).toContain("created_at DESC, id DESC");
    }
  });

  test("replaces the legacy channel-time index definition once", () => {
    const dbPath = path.join(tmpDir, "legacy-message-index.db");
    const existing = createDatabase(dbPath);
    existing.raw.run("DROP INDEX idx_messages_guild_channel_time");
    existing.raw.run("CREATE INDEX idx_messages_guild_channel_time ON messages(guild_id, channel_id, created_at)");
    existing.close();

    const migrated = createDatabase(dbPath);
    try {
      const index = migrated.raw.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_guild_channel_time'",
      ).get() as { sql: string };
      expect(index.sql).toContain("created_at DESC, id DESC");
    } finally {
      migrated.close();
    }
  });

  test("user_guild index supports per-user queries", () => {
    const idx = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_user_guild'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_messages_user_guild");
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
