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
      content: "Likes pizza",
    });

    const mem = getMemory(db, id);
    expect(mem).not.toBeNull();
    expect(mem?.scope).toBe("user");
    expect(mem?.guildId).toBe("g1");
    expect(mem?.userId).toBe("u1");
    expect(mem?.content).toBe("Likes pizza");
    expect(mem?.expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_TTL_MS - 1000);
    expect(mem?.expiresAt).toBeLessThanOrEqual(Date.now() + DEFAULT_TTL_MS + 1000);
  });

  test("creates a guild_bot memory", () => {
    const id = createMemory(db, {
      scope: "guild_bot",
      guildId: "g1",
      content: "Movie night is Fridays",
    });

    const mem = getMemory(db, id);
    expect(mem?.scope).toBe("guild_bot");
    expect(mem?.guildId).toBe("g1");
    expect(mem?.userId).toBeNull();
  });

  test("creates a global_bot memory", () => {
    const id = createMemory(db, {
      scope: "global_bot",
      content: "Users prefer concise answers",
    });

    const mem = getMemory(db, id);
    expect(mem?.scope).toBe("global_bot");
    expect(mem?.guildId).toBeNull();
  });

  test("creates a journal entry with short and long descriptions", () => {
    const id = createMemory(db, {
      scope: "journal",
      content: "",
      shortDescription: "Check on Alice",
      longDescription: "Alice mentioned a Rust project last Tuesday. Follow up.",
    });

    const mem = getMemory(db, id);
    expect(mem?.scope).toBe("journal");
    expect(mem?.shortDescription).toBe("Check on Alice");
    expect(mem?.longDescription).toContain("Rust project");
    // Journal entries have no TTL by default
    expect(mem?.expiresAt).toBeNull();
  });

  test("accepts custom TTL in days", () => {
    const before = Date.now();
    const id = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      content: "Temporary note",
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
      content: "Permanent note",
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
      content: "From a specific message",
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
      content: "Old content",
    });

    const updated = updateMemory(db, id, { content: "New content" });
    expect(updated).toBe(true);

    const mem = getMemory(db, id);
    expect(mem?.content).toBe("New content");
    expect(mem?.updatedAt).toBeGreaterThanOrEqual(mem?.createdAt);
  });

  test("updates journal descriptions", () => {
    const id = createMemory(db, {
      scope: "journal",
      content: "",
      shortDescription: "Old short",
      longDescription: "Old long",
    });

    updateMemory(db, id, {
      shortDescription: "New short",
      longDescription: "New long",
    });

    const mem = getMemory(db, id);
    expect(mem?.shortDescription).toBe("New short");
    expect(mem?.longDescription).toBe("New long");
  });

  test("updates TTL", () => {
    const id = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      content: "test",
    });

    updateMemory(db, id, { ttlDays: 7 });

    const mem = getMemory(db, id);
    const expected = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(mem?.expiresAt).toBeGreaterThanOrEqual(expected - 1000);
    expect(mem?.expiresAt).toBeLessThanOrEqual(expected + 1000);
  });

  test("returns false for non-existent id", () => {
    const result = updateMemory(db, "nonexistent", { content: "x" });
    expect(result).toBe(false);
  });
});

describe("deleteMemory", () => {
  test("deletes an existing memory", () => {
    const id = createMemory(db, {
      scope: "global_bot",
      content: "To be deleted",
    });

    const deleted = deleteMemory(db, id);
    expect(deleted).toBe(true);
    expect(getMemory(db, id)).toBeNull();
  });

  test("returns false for non-existent id", () => {
    expect(deleteMemory(db, "nonexistent")).toBe(false);
  });
});

describe("listMemories", () => {
  test("lists user memories for a specific guild and user", () => {
    createMemory(db, { scope: "user", guildId: "g1", userId: "u1", content: "A" });
    createMemory(db, { scope: "user", guildId: "g1", userId: "u1", content: "B" });
    createMemory(db, { scope: "user", guildId: "g1", userId: "u2", content: "C" });

    const results = listMemories(db, { scope: "user", guildId: "g1", userId: "u1" });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.content).sort()).toEqual(["A", "B"]);
  });

  test("lists guild_bot memories for a guild", () => {
    createMemory(db, { scope: "guild_bot", guildId: "g1", content: "X" });
    createMemory(db, { scope: "guild_bot", guildId: "g2", content: "Y" });

    const results = listMemories(db, { scope: "guild_bot", guildId: "g1" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("X");
  });

  test("lists global_bot memories", () => {
    createMemory(db, { scope: "global_bot", content: "G1" });
    createMemory(db, { scope: "global_bot", content: "G2" });

    const results = listMemories(db, { scope: "global_bot" });
    expect(results).toHaveLength(2);
  });

  test("lists journal entries with descriptions", () => {
    createMemory(db, {
      scope: "journal",
      content: "",
      shortDescription: "Short A",
      longDescription: "Long A",
    });

    const results = listMemories(db, { scope: "journal" });
    expect(results).toHaveLength(1);
    expect(results[0].shortDescription).toBe("Short A");
  });

  test("excludes expired memories", () => {
    // Insert a memory that expired in the past
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO memories (id, scope, guild_id, user_id, content, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("expired-1", "global_bot", null, null, "Old", null, null, null, now - 100000, now - 100000, now - 1000);

    createMemory(db, { scope: "global_bot", content: "Current" });

    const results = listMemories(db, { scope: "global_bot" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Current");
  });

  test("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      createMemory(db, { scope: "global_bot", content: `Item ${i}` });
    }

    const results = listMemories(db, { scope: "global_bot", limit: 3 });
    expect(results).toHaveLength(3);
  });
});

describe("deleteExpiredMemories", () => {
  test("removes memories past their expiry", () => {
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO memories (id, scope, guild_id, user_id, content, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("exp-1", "user", "g1", "u1", "Expired", null, null, null, now, now, now - 1000);

    createMemory(db, { scope: "global_bot", content: "Still valid" });

    const count = deleteExpiredMemories(db);
    expect(count).toBe(1);
    expect(getMemory(db, "exp-1")).toBeNull();

    const remaining = listMemories(db, { scope: "global_bot" });
    expect(remaining).toHaveLength(1);
  });
});
