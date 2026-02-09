import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createDatabase, type Database } from "./database";
import {
  createMemory,
  deleteExpiredMemories,
  deleteMemory,
  getMemory,
  listMemories,
  updateMemory,
} from "./memory-repository";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

const DEFAULT_TTL_MS = 180 * 24 * 60 * 60 * 1000;

describe("createMemory", () => {
  test("stores content-only memory rows", () => {
    const id = createMemory(db, {
      scope: "journal",
      guildId: "g1",
      userId: "bot-1",
      content: "Deploy window is Friday 17:00 UTC.",
    });

    const row = getMemory(db, id);
    expect(row?.scope).toBe("journal");
    expect(row?.guildId).toBe("g1");
    expect(row?.userId).toBe("bot-1");
    expect(row?.content).toBe("Deploy window is Friday 17:00 UTC.");
  });

  test("applies default ttl", () => {
    const before = Date.now();
    const id = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      content: "User likes concise answers.",
    });

    const row = getMemory(db, id);
    expect(row?.expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_TTL_MS - 1000);
    expect(row?.expiresAt).toBeLessThanOrEqual(Date.now() + DEFAULT_TTL_MS + 1000);
  });

  test("accepts custom ttl and null ttl", () => {
    const customId = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      content: "Temporary note",
      ttlDays: 7,
    });
    const permanentId = createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      content: "Permanent note",
      ttlDays: null,
    });

    const custom = getMemory(db, customId);
    const permanent = getMemory(db, permanentId);
    expect(custom?.expiresAt).not.toBeNull();
    expect(permanent?.expiresAt).toBeNull();
  });
});

describe("updateMemory", () => {
  test("updates content field", () => {
    const id = createMemory(db, {
      scope: "journal",
      guildId: "g1",
      userId: "bot-1",
      content: "Old content",
    });

    const updated = updateMemory(db, id, { content: "New content" });
    expect(updated).toBe(true);
    expect(getMemory(db, id)?.content).toBe("New content");
  });

  test("returns false when row does not exist", () => {
    expect(updateMemory(db, 999999, { content: "nope" })).toBe(false);
  });
});

describe("deleteMemory", () => {
  test("deletes existing rows", () => {
    const id = createMemory(db, {
      scope: "journal",
      guildId: "g1",
      userId: "bot-1",
      content: "Remove me",
    });

    expect(deleteMemory(db, id)).toBe(true);
    expect(getMemory(db, id)).toBeNull();
  });

  test("returns false for missing rows", () => {
    expect(deleteMemory(db, 999999)).toBe(false);
  });
});

describe("listMemories", () => {
  test("filters by scope, guild, and optional user", () => {
    createMemory(db, { scope: "user", guildId: "g1", userId: "u1", content: "A" });
    createMemory(db, { scope: "user", guildId: "g1", userId: "u1", content: "B" });
    createMemory(db, { scope: "user", guildId: "g1", userId: "u2", content: "C" });
    createMemory(db, { scope: "journal", guildId: "g1", userId: "bot", content: "D" });

    const userRows = listMemories(db, { scope: "user", guildId: "g1", userId: "u1" });
    const journalRows = listMemories(db, { scope: "journal", guildId: "g1" });

    expect(userRows.map((row) => row.content).sort()).toEqual(["A", "B"]);
    expect(journalRows.map((row) => row.content)).toEqual(["D"]);
  });

  test("returns chronological order (oldest first)", () => {
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", "g1", "u1", "Oldest", null, null, now - 3000, now - 3000, null);
    db.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", "g1", "u1", "Middle", null, null, now - 2000, now - 2000, null);
    db.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", "g1", "u1", "Newest", null, null, now - 1000, now - 1000, null);

    const rows = listMemories(db, { scope: "user", guildId: "g1", userId: "u1" });
    expect(rows.map((row) => row.content)).toEqual(["Oldest", "Middle", "Newest"]);
  });

  test("excludes expired entries and enforces limit", () => {
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", "g1", "u1", "Expired", null, null, now - 100000, now - 100000, now - 1000);

    db.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", "g1", "u1", "One", null, null, now - 3000, now - 3000, now + 100000);
    db.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", "g1", "u1", "Two", null, null, now - 2000, now - 2000, now + 100000);
    db.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", "g1", "u1", "Three", null, null, now - 1000, now - 1000, now + 100000);

    const rows = listMemories(db, { scope: "user", guildId: "g1", userId: "u1", limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.content)).toEqual(["Two", "Three"]);
  });
});

describe("deleteExpiredMemories", () => {
  test("removes only expired rows", () => {
    const now = Date.now();
    const expired = db.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", "g1", "u1", "Expired", null, null, now, now, now - 1000);

    createMemory(db, {
      scope: "user",
      guildId: "g1",
      userId: "u1",
      content: "Still valid",
    });

    expect(deleteExpiredMemories(db)).toBe(1);
    expect(getMemory(db, Number(expired.lastInsertRowid))).toBeNull();
    expect(listMemories(db, { scope: "user", guildId: "g1", userId: "u1" })).toHaveLength(1);
  });
});
