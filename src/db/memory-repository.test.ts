import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createDatabase, type Database } from "./database";
import {
  countMemories,
  createMemory,
  countUserMemoriesByUser,
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

describe("createMemory", () => {
  test("stores structured memory rows", () => {
    const id = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      kind: "preference",
      content: "User likes concise answers.",
      sourceMessageId: "m1",
      confidence: 0.9,
    });

    const row = getMemory(db, id);
    expect(row?.guildId).toBe("g1");
    expect(row?.subjectUserId).toBe("u1");
    expect(row?.kind).toBe("preference");
    expect(row?.content).toBe("User likes concise answers.");
    expect(row?.sourceMessageId).toBe("m1");
    expect(row?.confidence).toBe(0.9);
    expect(row?.expiresAt).toBeNull();
  });

  test("clamps confidence", () => {
    const id = createMemory(db, {
      guildId: "g1",
      kind: "global_note",
      content: "Global",
      confidence: 99,
    });

    expect(getMemory(db, id)?.confidence).toBe(1);
  });

  test("stores scratchpad rows only with expiry", () => {
    const expiresAt = Date.now() + 60_000;
    const id = createMemory(db, {
      guildId: "g1",
      kind: "scratchpad",
      content: "Check dashboard headers next.",
      expiresAt,
    });

    const row = getMemory(db, id);
    expect(row?.kind).toBe("scratchpad");
    expect(row?.expiresAt).toBe(expiresAt);
  });
});

describe("updateMemory", () => {
  test("updates content and clears deletion marker", () => {
    const id = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      kind: "user_note",
      content: "Old content",
    });

    expect(updateMemory(db, id, {
      kind: "fact",
      content: "New content",
      deletedAt: null,
    })).toBe(true);
    const row = getMemory(db, id);
    expect(row?.kind).toBe("fact");
    expect(row?.content).toBe("New content");
  });

  test("updates and clears expiry", () => {
    const expiresAt = Date.now() + 60_000;
    const id = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      kind: "user_note",
      content: "Temporary content",
      expiresAt,
    });

    expect(getMemory(db, id)?.expiresAt).toBe(expiresAt);
    expect(updateMemory(db, id, { expiresAt: null })).toBe(true);
    expect(getMemory(db, id)?.expiresAt).toBeNull();
  });

  test("returns false when row does not exist", () => {
    expect(updateMemory(db, 999999, { content: "nope" })).toBe(false);
  });
});

describe("deleteMemory", () => {
  test("soft-deletes existing rows", () => {
    const id = createMemory(db, {
      guildId: "g1",
      kind: "global_note",
      content: "Remove me",
    });

    expect(deleteMemory(db, id)).toBe(true);
    expect(getMemory(db, id)).toBeNull();
    expect(listMemories(db, { guildId: "g1", includeDeleted: true })).toHaveLength(1);
  });

  test("returns false for missing rows", () => {
    expect(deleteMemory(db, 999999)).toBe(false);
  });
});

describe("listMemories", () => {
  test("filters by guild and optional subject with global rows", () => {
    createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "preference", content: "A" });
    createMemory(db, { guildId: "g1", subjectUserId: "u2", kind: "fact", content: "B" });
    createMemory(db, { guildId: "g1", kind: "global_note", content: "C" });
    createMemory(db, { guildId: "g2", kind: "global_note", content: "D" });

    const rows = listMemories(db, {
      guildId: "g1",
      subjectUserId: "u1",
      includeGlobal: true,
    });

    expect(rows.map((row) => row.content).sort()).toEqual(["A", "C"]);
    expect(countMemories(db, { guildId: "g1", subjectUserId: "u1", includeGlobal: true })).toBe(2);
  });

  test("returns newest updated memories first and enforces limit", () => {
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO memories (guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("g1", "u1", "user_note", "Oldest", null, 0.7, now - 3000, now - 3000, null);
    db.raw
      .prepare(
        `INSERT INTO memories (guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("g1", "u1", "user_note", "Middle", null, 0.7, now - 2000, now - 2000, null);
    db.raw
      .prepare(
        `INSERT INTO memories (guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("g1", "u1", "user_note", "Newest", null, 0.7, now - 1000, now - 1000, null);

    const rows = listMemories(db, { guildId: "g1", subjectUserId: "u1", limit: 2 });
    expect(rows.map((row) => row.content)).toEqual(["Newest", "Middle"]);
  });

  test("excludes expired memories from active reads and counts", () => {
    const expired = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      kind: "fact",
      content: "Expired",
      expiresAt: Date.now() - 1,
    });
    const active = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      kind: "fact",
      content: "Active",
      expiresAt: Date.now() + 60_000,
    });

    expect(getMemory(db, expired)).toBeNull();
    expect(getMemory(db, active)?.content).toBe("Active");
    expect(listMemories(db, { guildId: "g1", subjectUserId: "u1" }).map((row) => row.content)).toEqual(["Active"]);
    expect(countUserMemoriesByUser(db, "g1").get("u1")).toBe(1);
  });
});

describe("deleteExpiredMemories", () => {
  test("hard-deletes soft-deleted and expired rows", () => {
    const deleted = createMemory(db, { guildId: "g1", kind: "global_note", content: "gone" });
    const active = createMemory(db, { guildId: "g1", kind: "global_note", content: "active" });
    createMemory(db, {
      guildId: "g1",
      kind: "global_note",
      content: "expired",
      expiresAt: Date.now() - 1,
    });
    deleteMemory(db, deleted);

    expect(deleteExpiredMemories(db)).toBe(2);
    expect(listMemories(db, { guildId: "g1", includeDeleted: true }).map((row) => row.id)).toEqual([active]);
  });
});
