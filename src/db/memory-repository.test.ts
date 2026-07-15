import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createDatabase, type Database } from "./database";
import {
  countMemories,
  createMemory,
  countUserMemoriesByUser,
  deleteExpiredMemories,
  deleteMemory,
  getMemory,
  listMemoryMaintenanceBatch,
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
      aboutUserId: "u1",
      kind: "preference",
      content: "User likes concise answers.",
      sourceMessageId: "m1",
      confidence: 0.9,
    });

    const row = getMemory(db, id);
    expect(row?.recallIn).toBe("anywhere");
    expect(row?.aboutUserId).toBe("u1");
    expect(row?.recallWhen).toEqual(["u1"]);
    expect(row?.kind).toBe("preference");
    expect(row?.content).toBe("User likes concise answers.");
    expect(row?.sourceMessageId).toBe("m1");
    expect(row?.confidence).toBe(0.9);
    expect(row?.priority).toBe(0);
    expect(row?.expiresAt).toBeNull();
  });

  test("stores important memory priority", () => {
    const id = createMemory(db, {
      guildId: "g1",
      about: "self",
      kind: "journal",
      content: "Important self continuity.",
      priority: 1,
    });

    expect(getMemory(db, id)?.priority).toBe(1);
  });

  test("clamps confidence", () => {
    const id = createMemory(db, {
      guildId: "g1",
      kind: "note",
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

  test("stores self memories without guild or user ownership", () => {
    const id = createMemory(db, {
      guildId: "g1",
      about: "self",
      kind: "journal",
      content: "Privately decided the server is worth returning to.",
      confidence: 0.8,
    });

    const row = getMemory(db, id);
    expect(row?.about).toBe("self");
    expect(row?.recallIn).toBe("anywhere");
    expect(row?.aboutUserId).toBeNull();
    expect(row?.kind).toBe("journal");
  });

  test("stores independent recall triggers without changing the subject", () => {
    const id = createMemory(db, {
      guildId: "g1",
      about: "self",
      recallWhen: ["u2", "u3", "u2"],
      kind: "journal",
      content: "Alice asked me to use reaction images when Bob starts baiting people.",
    });

    const row = getMemory(db, id);
    expect(row?.about).toBe("self");
    expect(row?.aboutUserId).toBeNull();
    expect(row?.recallWhen).toEqual(["u2", "u3"]);
  });
});

describe("updateMemory", () => {
  test("updates content and clears deletion marker", () => {
    const id = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      kind: "note",
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
      aboutUserId: "u1",
      kind: "note",
      content: "Temporary content",
      expiresAt,
    });

    expect(getMemory(db, id)?.expiresAt).toBe(expiresAt);
    expect(updateMemory(db, id, { expiresAt: null })).toBe(true);
    expect(getMemory(db, id)?.expiresAt).toBeNull();
  });

  test("updates memory priority", () => {
    const id = createMemory(db, {
      guildId: "g1",
      kind: "note",
      content: "Normal priority.",
    });

    expect(updateMemory(db, id, { priority: 1 })).toBe(true);
    expect(getMemory(db, id)?.priority).toBe(1);
  });

  test("replaces exact recall triggers without implicitly adding the subject", () => {
    const selfId = createMemory(db, {
      guildId: "g1",
      about: "self",
      recallWhen: ["u1"],
      kind: "journal",
      content: "Targeted self memory.",
    });
    const userId = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      recallWhen: ["u2"],
      kind: "fact",
      content: "A fact about Alice.",
    });

    expect(updateMemory(db, selfId, { recallWhen: ["u2"] })).toBe(true);
    expect(getMemory(db, selfId)?.recallWhen).toEqual(["u2"]);
    expect(getMemory(db, userId)?.recallWhen).toEqual(["u2"]);
    expect(updateMemory(db, userId, { recallWhen: ["u3"] })).toBe(true);
    expect(getMemory(db, userId)?.recallWhen).toEqual(["u3"]);
  });

  test("rejects empty user-triggered recall before mutating the row", () => {
    const id = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      recallWhen: "always",
      kind: "fact",
      content: "Stable",
    });

    expect(() => updateMemory(db, id, { recallWhen: [] })).toThrow("requires at least one user ID");
    expect(getMemory(db, id)?.recallWhen).toBe("always");
  });

  test("updates what a memory is about only with required fields", () => {
    const id = createMemory(db, {
      guildId: "g1",
      kind: "note",
      content: "Old scope",
    });

    expect(() => updateMemory(db, id, { about: "user", content: "Invalid user scope" })).toThrow();
    expect(() => updateMemory(db, id, { aboutUserId: "u1" })).toThrow("requires about=user");

    expect(updateMemory(db, id, {
      about: "self",
      kind: "journal",
      content: "Moved to self journal.",
    })).toBe(true);

    const row = getMemory(db, id);
    expect(row?.about).toBe("self");
    expect(row?.recallIn).toEqual({ guildId: "g1" });
    expect(row?.aboutUserId).toBeNull();
    expect(row?.kind).toBe("journal");
  });

  test("rejects journal subject transitions before SQL constraints", () => {
    const selfJournal = createMemory(db, {
      guildId: "g1",
      about: "self",
      kind: "journal",
      content: "Self-only journal.",
    });
    const guildMemory = createMemory(db, {
      guildId: "g1",
      kind: "fact",
      content: "Guild fact.",
    });

    expect(() => updateMemory(db, selfJournal, {
      about: "community",
      recallIn: { guildId: "g1" },
      content: "Invalid journal move.",
    })).toThrow("Journal memories must be about self.");
    expect(() => updateMemory(db, guildMemory, {
      kind: "journal",
      content: "Invalid journal kind.",
    })).toThrow("Journal memories must be about self.");
  });

  test("returns false when row does not exist", () => {
    expect(updateMemory(db, 999999, { content: "nope" })).toBe(false);
  });
});

describe("deleteMemory", () => {
  test("soft-deletes existing rows", () => {
    const id = createMemory(db, {
      guildId: "g1",
      kind: "note",
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
  test("combines anywhere memories with only the current guild's local memories", () => {
    createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "Anywhere" });
    createMemory(db, { guildId: "g1", aboutUserId: "u1", recallIn: { guildId: "g1" }, kind: "fact", content: "Guild one" });
    createMemory(db, { guildId: "g2", aboutUserId: "u1", recallIn: { guildId: "g2" }, kind: "fact", content: "Guild two" });

    expect(listMemories(db, { guildId: "g1", aboutUserId: "u1" }).map((row) => row.content).sort()).toEqual(["Anywhere", "Guild one"]);
    expect(listMemories(db, { guildId: "g2", aboutUserId: "u1" }).map((row) => row.content).sort()).toEqual(["Anywhere", "Guild two"]);
  });

  test("filters portable user memories and current-guild rows together", () => {
    createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "preference", content: "A" });
    createMemory(db, { guildId: "g1", aboutUserId: "u2", kind: "fact", content: "B" });
    createMemory(db, { guildId: "g1", kind: "note", content: "C" });
    createMemory(db, { guildId: "g1", about: "self", kind: "journal", content: "E" });
    createMemory(db, { guildId: "g2", kind: "note", content: "D" });

    const rows = listMemories(db, {
      guildId: "g1",
      aboutUserId: "u1",
      includeCommunity: true,
    });

    expect(rows.map((row) => row.content).sort()).toEqual(["A", "C"]);
    expect(countMemories(db, { guildId: "g1", aboutUserId: "u1", includeCommunity: true })).toBe(2);
    expect(listMemories(db, { guildId: "g1", about: "self" }).map((row) => row.content)).toEqual(["E"]);
    expect(countMemories(db, { guildId: "g1", about: "self" })).toBe(1);
  });

  test("returns newest updated memories first and enforces limit", () => {
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO memories (about_type, about_user_id, recall_scope, recall_guild_id, recall_mode, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", "u1", "anywhere", null, "users", "note", "Oldest", null, 0.7, now - 3000, now - 3000, null);
    db.raw
      .prepare(
        `INSERT INTO memories (about_type, about_user_id, recall_scope, recall_guild_id, recall_mode, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", "u1", "anywhere", null, "users", "note", "Middle", null, 0.7, now - 2000, now - 2000, null);
    db.raw
      .prepare(
        `INSERT INTO memories (about_type, about_user_id, recall_scope, recall_guild_id, recall_mode, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", "u1", "anywhere", null, "users", "note", "Newest", null, 0.7, now - 1000, now - 1000, null);

    const rows = listMemories(db, { guildId: "g1", aboutUserId: "u1", limit: 2 });
    expect(rows.map((row) => row.content)).toEqual(["Newest", "Middle"]);
  });

  test("keeps always-relevant memories and filters user-triggered memories by relevant users", () => {
    createMemory(db, { guildId: "g1", about: "self", kind: "journal", content: "General self memory." });
    createMemory(db, {
      guildId: "g1",
      about: "self",
      recallWhen: ["u1"],
      kind: "journal",
      content: "Alice-specific self memory.",
    });
    createMemory(db, {
      guildId: "g1",
      about: "self",
      recallWhen: ["u2"],
      kind: "journal",
      content: "Bob-specific self memory.",
    });

    const filter = { guildId: "g1", about: "self" as const, relevantUserIds: ["u1"] };
    expect(listMemories(db, filter).map((row) => row.content).sort()).toEqual([
      "Alice-specific self memory.",
      "General self memory.",
    ]);
    expect(countMemories(db, filter)).toBe(2);
  });

  test("recalls a multi-user trigger when any listed user is relevant", () => {
    createMemory(db, {
      guildId: "g1",
      about: "self",
      recallWhen: ["u2", "u3"],
      kind: "journal",
      content: "Relevant around either user.",
    });

    expect(listMemories(db, { guildId: "g1", about: "self", relevantUserIds: ["u3"] })).toHaveLength(1);
    expect(listMemories(db, { guildId: "g1", about: "self", relevantUserIds: ["u4"] })).toHaveLength(0);
  });

  test("loads broadly applicable user memories independently of their subject", () => {
    createMemory(db, {
      guildId: "g1",
      aboutUserId: "u-owner",
      recallWhen: "always",
      kind: "preference",
      content: "Owner prefers this behavior for everyone.",
    });

    const rows = listMemories(db, {
      guildId: "g1",
      about: "user",
      relevantUserIds: ["u-other"],
      excludeAboutUserIds: ["u-other"],
    });
    expect(rows.map((row) => row.content)).toEqual(["Owner prefers this behavior for everyone."]);
    expect(rows[0]?.recallWhen).toBe("always");
  });

  test("returns important memories before newer normal memories", () => {
    const oldImportant = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      kind: "fact",
      content: "Old important",
      priority: 1,
    });
    const freshNormal = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      kind: "fact",
      content: "Fresh normal",
    });
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(100, oldImportant);
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(200, freshNormal);

    const rows = listMemories(db, { guildId: "g1", aboutUserId: "u1", limit: 1 });
    expect(rows.map((row) => row.content)).toEqual(["Old important"]);
  });

  test("excludes expired memories from active reads and counts", () => {
    const expired = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      kind: "fact",
      content: "Expired",
      expiresAt: Date.now() - 1,
    });
    const active = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      kind: "fact",
      content: "Active",
      expiresAt: Date.now() + 60_000,
    });

    expect(getMemory(db, expired)).toBeNull();
    expect(getMemory(db, active)?.content).toBe("Active");
    expect(listMemories(db, { guildId: "g1", aboutUserId: "u1" }).map((row) => row.content)).toEqual(["Active"]);
    expect(countUserMemoriesByUser(db, "g1").get("u1")).toBe(1);
  });
});

describe("listMemoryMaintenanceBatch", () => {
  test("rotates bounded maintainable rows and excludes foreign guild memories", () => {
    const first = createMemory(db, { guildId: "g1", kind: "note", content: "First" });
    const second = createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "Second" });
    createMemory(db, { guildId: "g2", kind: "note", content: "Foreign" });
    const fourth = createMemory(db, { guildId: "g1", about: "self", kind: "journal", content: "Fourth" });

    const initial = listMemoryMaintenanceBatch(db, { guildId: "g1", afterId: 0, limit: 2 });
    expect(initial.rows.map((row) => row.id)).toEqual([first, second]);
    expect(initial.nextCursorId).toBe(second);

    const next = listMemoryMaintenanceBatch(db, { guildId: "g1", afterId: initial.nextCursorId, limit: 2 });
    expect(next.rows.map((row) => row.id)).toEqual([fourth]);
    const wrapped = listMemoryMaintenanceBatch(db, { guildId: "g1", afterId: next.nextCursorId, limit: 2 });
    expect(wrapped.rows.map((row) => row.id)).toEqual([first, second]);
  });
});

describe("deleteExpiredMemories", () => {
  test("hard-deletes soft-deleted and expired rows", () => {
    const deleted = createMemory(db, { guildId: "g1", kind: "note", content: "gone" });
    const active = createMemory(db, { guildId: "g1", kind: "note", content: "active" });
    createMemory(db, {
      guildId: "g1",
      kind: "note",
      content: "expired",
      expiresAt: Date.now() - 1,
    });
    deleteMemory(db, deleted);

    expect(deleteExpiredMemories(db)).toBe(2);
    expect(listMemories(db, { guildId: "g1", includeDeleted: true }).map((row) => row.id)).toEqual([active]);
  });
});
