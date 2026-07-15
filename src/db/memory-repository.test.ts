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
    expect(row?.guildId).toBeNull();
    expect(row?.subjectUserId).toBe("u1");
    expect(row?.appliesToUserIds).toEqual(["u1"]);
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
      scope: "self",
      kind: "journal",
      content: "Important self continuity.",
      priority: 1,
    });

    expect(getMemory(db, id)?.priority).toBe(1);
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

  test("stores self memories without guild or user ownership", () => {
    const id = createMemory(db, {
      guildId: "g1",
      scope: "self",
      kind: "journal",
      content: "Privately decided the server is worth returning to.",
      confidence: 0.8,
    });

    const row = getMemory(db, id);
    expect(row?.scope).toBe("self");
    expect(row?.guildId).toBeNull();
    expect(row?.subjectUserId).toBeNull();
    expect(row?.kind).toBe("journal");
  });

  test("stores independent applicability without changing the subject", () => {
    const id = createMemory(db, {
      guildId: "g1",
      scope: "self",
      appliesToUserIds: ["u2", "u3", "u2"],
      kind: "journal",
      content: "Alice asked me to use reaction images when Bob starts baiting people.",
    });

    const row = getMemory(db, id);
    expect(row?.scope).toBe("self");
    expect(row?.subjectUserId).toBeNull();
    expect(row?.appliesToUserIds).toEqual(["u2", "u3"]);
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

  test("updates memory priority", () => {
    const id = createMemory(db, {
      guildId: "g1",
      kind: "global_note",
      content: "Normal priority.",
    });

    expect(updateMemory(db, id, { priority: 1 })).toBe(true);
    expect(getMemory(db, id)?.priority).toBe(1);
  });

  test("replaces applicability while keeping user subjects applicable", () => {
    const selfId = createMemory(db, {
      guildId: "g1",
      scope: "self",
      appliesToUserIds: ["u1"],
      kind: "journal",
      content: "Targeted self memory.",
    });
    const userId = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      appliesToUserIds: ["u2"],
      kind: "fact",
      content: "A fact about Alice.",
    });

    expect(updateMemory(db, selfId, { appliesToUserIds: ["u2"] })).toBe(true);
    expect(getMemory(db, selfId)?.appliesToUserIds).toEqual(["u2"]);
    expect(getMemory(db, userId)?.appliesToUserIds).toEqual(["u1", "u2"]);
    expect(updateMemory(db, userId, { appliesToUserIds: ["u3"] })).toBe(true);
    expect(getMemory(db, userId)?.appliesToUserIds).toEqual(["u1", "u3"]);
  });

  test("updates scope only with required ownership fields", () => {
    const id = createMemory(db, {
      guildId: "g1",
      kind: "global_note",
      content: "Old scope",
    });

    expect(() => updateMemory(db, id, { scope: "user", content: "Invalid user scope" })).toThrow();
    expect(() => updateMemory(db, id, { scope: "guild", content: "Invalid guild scope" })).toThrow();
    expect(() => updateMemory(db, id, { subjectUserId: "u1" })).toThrow("Changing memory scope fields requires scope.");
    expect(() => updateMemory(db, id, { guildId: "g2" })).toThrow("Changing memory scope fields requires scope.");

    expect(updateMemory(db, id, {
      scope: "self",
      kind: "journal",
      content: "Moved to self journal.",
    })).toBe(true);

    const row = getMemory(db, id);
    expect(row?.scope).toBe("self");
    expect(row?.guildId).toBeNull();
    expect(row?.subjectUserId).toBeNull();
    expect(row?.kind).toBe("journal");
  });

  test("rejects journal scope transitions before SQL constraints", () => {
    const selfJournal = createMemory(db, {
      guildId: "g1",
      scope: "self",
      kind: "journal",
      content: "Self-only journal.",
    });
    const guildMemory = createMemory(db, {
      guildId: "g1",
      kind: "fact",
      content: "Guild fact.",
    });

    expect(() => updateMemory(db, selfJournal, {
      scope: "guild",
      guildId: "g1",
      content: "Invalid journal move.",
    })).toThrow("Journal memories must use self scope.");
    expect(() => updateMemory(db, guildMemory, {
      kind: "journal",
      content: "Invalid journal kind.",
    })).toThrow("Journal memories must use self scope.");
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
  test("filters portable user memories and current-guild rows together", () => {
    createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "preference", content: "A" });
    createMemory(db, { guildId: "g1", subjectUserId: "u2", kind: "fact", content: "B" });
    createMemory(db, { guildId: "g1", kind: "global_note", content: "C" });
    createMemory(db, { guildId: "g1", scope: "self", kind: "journal", content: "E" });
    createMemory(db, { guildId: "g2", kind: "global_note", content: "D" });

    const rows = listMemories(db, {
      guildId: "g1",
      subjectUserId: "u1",
      includeGlobal: true,
    });

    expect(rows.map((row) => row.content).sort()).toEqual(["A", "C"]);
    expect(countMemories(db, { guildId: "g1", subjectUserId: "u1", includeGlobal: true })).toBe(2);
    expect(listMemories(db, { guildId: "g1", scope: "self" }).map((row) => row.content)).toEqual(["E"]);
    expect(countMemories(db, { guildId: "g1", scope: "self" })).toBe(1);
  });

  test("returns newest updated memories first and enforces limit", () => {
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", null, "u1", "user_note", "Oldest", null, 0.7, now - 3000, now - 3000, null);
    db.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", null, "u1", "user_note", "Middle", null, 0.7, now - 2000, now - 2000, null);
    db.raw
      .prepare(
        `INSERT INTO memories (scope, guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("user", null, "u1", "user_note", "Newest", null, 0.7, now - 1000, now - 1000, null);

    const rows = listMemories(db, { guildId: "g1", subjectUserId: "u1", limit: 2 });
    expect(rows.map((row) => row.content)).toEqual(["Newest", "Middle"]);
  });

  test("keeps untargeted memories and filters targeted memories by applicable users", () => {
    createMemory(db, { guildId: "g1", scope: "self", kind: "journal", content: "General self memory." });
    createMemory(db, {
      guildId: "g1",
      scope: "self",
      appliesToUserIds: ["u1"],
      kind: "journal",
      content: "Alice-specific self memory.",
    });
    createMemory(db, {
      guildId: "g1",
      scope: "self",
      appliesToUserIds: ["u2"],
      kind: "journal",
      content: "Bob-specific self memory.",
    });

    const filter = { guildId: "g1", scope: "self" as const, applicableToUserIds: ["u1"] };
    expect(listMemories(db, filter).map((row) => row.content).sort()).toEqual([
      "Alice-specific self memory.",
      "General self memory.",
    ]);
    expect(countMemories(db, filter)).toBe(2);
  });

  test("returns important memories before newer normal memories", () => {
    const oldImportant = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      kind: "fact",
      content: "Old important",
      priority: 1,
    });
    const freshNormal = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      kind: "fact",
      content: "Fresh normal",
    });
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(100, oldImportant);
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(200, freshNormal);

    const rows = listMemories(db, { guildId: "g1", subjectUserId: "u1", limit: 1 });
    expect(rows.map((row) => row.content)).toEqual(["Old important"]);
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
