import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createDatabase, type Database } from "./database";
import {
  createMemory,
  updateMemory,
  deleteMemory,
  getMemory,
  listMemories,
  deleteExpiredMemories,
} from "./memory-repository";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

const DEFAULT_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 6 months

describe("createMemory", () => {
  test("creates a user-scoped memory with default TTL", () => {
    const before = Date.now();
    const id = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      title: "Likes pizza",
    });

    const mem = getMemory(db, id);
    expect(mem).not.toBeNull();
    expect(mem?.scope).toBe("user");
    expect(mem?.guildId).toBe("g1");
    expect(mem?.userId).toBe("u1");
    expect(mem?.title).toBe("Likes pizza");
    expect(mem?.expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_TTL_MS - 1000);
    expect(mem?.expiresAt).toBeLessThanOrEqual(Date.now() + DEFAULT_TTL_MS + 1000);
  });

  test("user scope requires guildId and userId", () => {
    const id = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      title: "Test memory",
    });

    const mem = getMemory(db, id);
    expect(mem?.scope).toBe("user");
    expect(mem?.guildId).toBe("g1");
    expect(mem?.userId).toBe("u1");
  });

  test("user scope supports title and content", () => {
    const id = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      title: "Short summary",
      content: "Detailed explanation of the memory",
    });

    const mem = getMemory(db, id);
    expect(mem?.title).toBe("Short summary");
    expect(mem?.content).toBe("Detailed explanation of the memory");
  });

  test("user scope has 180d default TTL", () => {
    const before = Date.now();
    const id = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      title: "Test",
    });

    const mem = getMemory(db, id);
    expect(mem?.expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_TTL_MS - 1000);
    expect(mem?.expiresAt).toBeLessThanOrEqual(Date.now() + DEFAULT_TTL_MS + 1000);
  });

  test("creates a journal entry with guildId and userId", () => {
    const id = createMemory(db, {
      scope: "journal",
      guildId: "g1",
      userId: "u1",
      title: "Check on Alice",
      content: "Alice mentioned a Rust project last Tuesday. Follow up.",
    });

    const mem = getMemory(db, id);
    expect(mem?.scope).toBe("journal");
    expect(mem?.guildId).toBe("g1");
    expect(mem?.userId).toBe("u1");
    expect(mem?.title).toBe("Check on Alice");
    expect(mem?.content).toContain("Rust project");
  });

  test("journal scope requires guildId and userId", () => {
    const id = createMemory(db, {
      scope: "journal",
      guildId: "g1",
      userId: "u1",
      title: "Journal entry",
    });

    const mem = getMemory(db, id);
    expect(mem?.scope).toBe("journal");
    expect(mem?.guildId).toBe("g1");
    expect(mem?.userId).toBe("u1");
  });

  test("journal scope supports title and content", () => {
    const id = createMemory(db, {
      scope: "journal",
      guildId: "g1",
      userId: "u1",
      title: "Meeting notes",
      content: "Discussed project timeline and deliverables for Q1",
    });

    const mem = getMemory(db, id);
    expect(mem?.title).toBe("Meeting notes");
    expect(mem?.content).toContain("timeline");
  });

  test("journal scope has 180d default TTL", () => {
    const before = Date.now();
    const id = createMemory(db, {
      scope: "journal",
      guildId: "g1",
      userId: "u1",
      title: "Short",
      content: "Long",
    });

    const mem = getMemory(db, id);
    expect(mem?.expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_TTL_MS - 1000);
    expect(mem?.expiresAt).toBeLessThanOrEqual(Date.now() + DEFAULT_TTL_MS + 1000);
  });

  test("accepts custom TTL in days", () => {
    const before = Date.now();
    const id = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      title: "Temporary note",
      ttlDays: 30,
    });

    const mem = getMemory(db, id);
    const expectedExpiry = before + 30 * 24 * 60 * 60 * 1000;
    expect(mem?.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 1000);
    expect(mem?.expiresAt).toBeLessThanOrEqual(expectedExpiry + 1000);
  });

  test("accepts null TTL to disable expiry", () => {
    const id = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      title: "Permanent note",
      ttlDays: null,
    });

    const mem = getMemory(db, id);
    expect(mem?.expiresAt).toBeNull();
  });

  test("stores source_message_id when provided", () => {
    const id = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      title: "From a specific message",
      sourceMessageId: "msg-99",
    });

    const mem = getMemory(db, id);
    expect(mem?.sourceMessageId).toBe("msg-99");
  });
});

describe("updateMemory", () => {
  test("updates content of an existing memory", () => {
    const id = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      title: "Old content",
    });

    const updated = updateMemory(db, id, { title: "New content" });
    expect(updated).toBe(true);

    const mem = getMemory(db, id);
    expect(mem).not.toBeNull();
    if (!mem) throw new Error("unreachable");
    expect(mem.title).toBe("New content");
    expect(mem.updatedAt).toBeGreaterThanOrEqual(mem.createdAt);
  });

  test("updates journal descriptions", () => {
    const id = createMemory(db, {
      scope: "journal",
      guildId: "g1",
      userId: "u1",
      title: "Old short",
      content: "Old long",
    });

    updateMemory(db, id, {
      title: "New short",
      content: "New long",
    });

    const mem = getMemory(db, id);
    expect(mem?.title).toBe("New short");
    expect(mem?.content).toBe("New long");
  });

  test("updates user memory descriptions", () => {
    const id = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      title: "Old short",
      content: "Old long",
    });

    updateMemory(db, id, {
      title: "New short",
      content: "New long",
    });

    const mem = getMemory(db, id);
    expect(mem?.title).toBe("New short");
    expect(mem?.content).toBe("New long");
  });

  test("updates TTL", () => {
    const id = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      title: "test",
    });

    updateMemory(db, id, { ttlDays: 7 });

    const mem = getMemory(db, id);
    const expected = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(mem?.expiresAt).toBeGreaterThanOrEqual(expected - 1000);
    expect(mem?.expiresAt).toBeLessThanOrEqual(expected + 1000);
  });

  test("returns false for non-existent id", () => {
    const result = updateMemory(db, 999999, { title: "x" });
    expect(result).toBe(false);
  });
});

describe("deleteMemory", () => {
  test("deletes an existing memory", () => {
    const id = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      title: "To be deleted",
    });

    const deleted = deleteMemory(db, id);
    expect(deleted).toBe(true);
    expect(getMemory(db, id)).toBeNull();
  });

  test("returns false for non-existent id", () => {
    expect(deleteMemory(db, 999999)).toBe(false);
  });
});

describe("listMemories", () => {
  test("lists user memories for a specific guild and user", () => {
    createMemory(db, { scope: "user", guildId: "g1", userId: "u1", title: "A" });
    createMemory(db, { scope: "user", guildId: "g1", userId: "u1", title: "B" });
    createMemory(db, { scope: "user", guildId: "g1", userId: "u2", title: "C" });

    const results = listMemories(db, { scope: "user", guildId: "g1", userId: "u1" });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.title).sort()).toEqual(["A", "B"]);
  });

  test("lists journal entries for a guild", () => {
    createMemory(db, { scope: "journal", guildId: "g1", userId: "u1", title: "X" });
    createMemory(db, { scope: "journal", guildId: "g2", userId: "u2", title: "Y" });

    const results = listMemories(db, { scope: "journal", guildId: "g1" });
    expect(results).toHaveLength(1);
    expect(results[0]).toBeDefined();
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].title).toBe("X");
  });

  test("lists journal entries with descriptions", () => {
    createMemory(db, {
      scope: "journal",
      guildId: "g1",
      userId: "u1",
      title: "Short A",
      content: "Long A",
    });

    const results = listMemories(db, { scope: "journal", guildId: "g1" });
    expect(results).toHaveLength(1);
    expect(results[0]).toBeDefined();
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].title).toBe("Short A");
  });

  test("filters journal by userId when provided", () => {
    createMemory(db, { scope: "journal", guildId: "g1", userId: "u1", title: "Entry 1" });
    createMemory(db, { scope: "journal", guildId: "g1", userId: "u2", title: "Entry 2" });

    const results = listMemories(db, { scope: "journal", guildId: "g1", userId: "u1" });
    expect(results).toHaveLength(1);
    expect(results[0]).toBeDefined();
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].title).toBe("Entry 1");
  });

  test("excludes expired memories", () => {
    // Insert a memory that expired in the past
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", "g1", "u1", "Old", null, null, now - 100000, now - 100000, now - 1000);

    createMemory(db, { scope: "user", guildId: "g1", userId: "u1", title: "Current" });

    const results = listMemories(db, { scope: "user", guildId: "g1", userId: "u1" });
    expect(results).toHaveLength(1);
    expect(results[0]).toBeDefined();
    if (!results[0]) throw new Error("unreachable");
    expect(results[0].title).toBe("Current");
  });

  test("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      createMemory(db, { scope: "user", guildId: "g1", userId: "u1", title: `Item ${i}` });
    }

    const results = listMemories(db, { scope: "user", guildId: "g1", userId: "u1", limit: 3 });
    expect(results).toHaveLength(3);
  });
});

describe("deleteExpiredMemories", () => {
  test("removes memories past their expiry", () => {
    const now = Date.now();
    const expResult = db.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", "g1", "u1", "Expired", null, null, now, now, now - 1000);
    const expiredId = Number(expResult.lastInsertRowid);

    createMemory(db, { scope: "user", guildId: "g1", userId: "u1", title: "Still valid" });

    const count = deleteExpiredMemories(db);
    expect(count).toBe(1);
    expect(getMemory(db, expiredId)).toBeNull();

    const remaining = listMemories(db, { scope: "user", guildId: "g1", userId: "u1" });
    expect(remaining).toHaveLength(1);
  });
});
