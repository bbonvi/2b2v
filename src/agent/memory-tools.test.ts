import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createDatabase, type Database } from "../db/database";
import { createMemoryTools, normalizeUsername, type MemoryToolsDeps } from "./memory-tools";
import { getMemory, listMemories } from "../db/memory-repository";

import type { AgentTool } from "@mariozechner/pi-agent-core";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

// Mock username → userId resolver
const mockUsers = new Map<string, string>([
  ["u1", "uid-1"],
  ["u2", "uid-2"],
  ["u999", "uid-999"],
  ["alice", "uid-alice"],
  ["bob", "uid-bob"],
]);
const mockResolveUsername = (username: string): string | undefined => mockUsers.get(username);

// Helper to create deps with common defaults
function makeDeps(overrides: Partial<MemoryToolsDeps> = {}): MemoryToolsDeps {
  return {
    db,
    guildId: "g1",
    botUserId: "bot-1",
    resolveUsername: mockResolveUsername,
    ...overrides,
  };
}

function findTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`Tool ${name} not found`);
  return tool;
}

// ---------------------------------------------------------------------------
// normalizeUsername helper
// ---------------------------------------------------------------------------
describe("normalizeUsername", () => {
  test("strips leading @", () => {
    expect(normalizeUsername("@foo")).toBe("foo");
  });

  test("passes through bare username unchanged", () => {
    expect(normalizeUsername("foo")).toBe("foo");
  });

  test("trims whitespace and strips leading @", () => {
    expect(normalizeUsername(" @foo ")).toBe("foo");
  });

  test("strips only one leading @", () => {
    expect(normalizeUsername("@@foo")).toBe("@foo");
  });

  test("trims whitespace without @", () => {
    expect(normalizeUsername("  bar  ")).toBe("bar");
  });
});

// ---------------------------------------------------------------------------
// save_journal_entry tool
// ---------------------------------------------------------------------------
describe("save_journal_entry tool", () => {
  test("creates a journal entry", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_journal_entry");

    const result = await saveTool.execute("tc-1", {
      title: "Follow up on project X",
      content: "Check status with team next week.",
    }, new AbortController().signal);

    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Saved new journal entry");

    const entries = listMemories(db, { scope: "journal", guildId: "g1", userId: "bot-1" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe("Follow up on project X");
  });

  test("creates a journal entry with title and content", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_journal_entry");

    await saveTool.execute("tc-2", {
      title: "Follow up on Bob",
      content: "Bob asked about the Rust project. Check in next week.",
    }, new AbortController().signal);

    const entries = listMemories(db, { scope: "journal", guildId: "g1", userId: "bot-1" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe("Follow up on Bob");
    expect(entries[0]?.content).toBe("Bob asked about the Rust project. Check in next week.");
  });

  test("auto-injects botUserId as userId in DB", async () => {
    const tools = createMemoryTools(makeDeps({ botUserId: "bot-xyz" }));
    const saveTool = findTool(tools, "save_journal_entry");

    await saveTool.execute("tc-3", {
      title: "Task note",
      content: "Details about the task.",
    }, new AbortController().signal);

    const entries = listMemories(db, { scope: "journal", guildId: "g1", userId: "bot-xyz" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.userId).toBe("bot-xyz");
    expect(entries[0]?.scope).toBe("journal");
  });

  test("updates existing journal entry when id is provided", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_journal_entry");

    // Create first
    const createResult = await saveTool.execute("tc-4", {
      title: "Original",
      content: "Original content.",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    // Update
    await saveTool.execute("tc-5", {
      title: "Updated",
      content: "Updated content.",
      id,
    }, new AbortController().signal);

    const mem = getMemory(db, id);
    expect(mem).not.toBeNull();
    expect(mem?.title).toBe("Updated");
    expect(mem?.content).toBe("Updated content.");
  });

  test("rejects update of journal belonging to another guild", async () => {
    const toolsG1 = createMemoryTools(makeDeps());
    const toolsG2 = createMemoryTools(makeDeps({ guildId: "g2" }));
    const saveG1 = findTool(toolsG1, "save_journal_entry");
    const saveG2 = findTool(toolsG2, "save_journal_entry");

    const createResult = await saveG1.execute("tc-6", {
      title: "G1 task",
      content: "G1 content.",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    // G2 tries to update G1's journal
    const updateResult = await saveG2.execute("tc-7", {
      title: "Hijacked",
      content: "Hijacked content.",
      id,
    }, new AbortController().signal);
    const text = (updateResult.content[0] as { text: string }).text;
    expect(text).toContain("not found");
    expect((updateResult.details as { success: boolean }).success).toBe(false);

    // Verify original unchanged
    const mem = getMemory(db, id);
    expect(mem?.title).toBe("G1 task");
  });

  test("rejects update of user memory ID", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveJournalTool = findTool(tools, "save_journal_entry");
    const saveUserTool = findTool(tools, "save_user_memory");

    // Create a user memory
    const userResult = await saveUserTool.execute("tc-1", {
      username: "u1",
      title: "User fact",
    }, new AbortController().signal);
    const userId = (userResult.details as { memoryId: number }).memoryId;

    // Try to update it via save_journal_entry
    const result = await saveJournalTool.execute("tc-2", {
      title: "Hijacked",
      content: "Hijacked content.",
      id: userId,
    }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not a journal entry");
    expect((result.details as { success: boolean }).success).toBe(false);
  });

  test("calls onMemoryChanged after create", async () => {
    const changed: { id: number; text: string }[] = [];
    const tools = createMemoryTools(makeDeps({
      onMemoryChanged: (id, text) => { changed.push({ id, text }); },
    }));
    const saveTool = findTool(tools, "save_journal_entry");

    await saveTool.execute("tc-8", {
      title: "Embed me",
      content: "Embed content.",
    }, new AbortController().signal);

    expect(changed).toHaveLength(1);
    expect(changed[0]?.text).toBe("Embed me\n\nEmbed content.");
  });

  test("calls onMemoryChanged after update", async () => {
    const changed: { id: number; text: string }[] = [];
    const tools = createMemoryTools(makeDeps({
      onMemoryChanged: (id, text) => { changed.push({ id, text }); },
    }));
    const saveTool = findTool(tools, "save_journal_entry");

    const createResult = await saveTool.execute("tc-9", {
      title: "Original",
      content: "Original content.",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    await saveTool.execute("tc-10", {
      title: "Updated",
      content: "Updated content.",
      id,
    }, new AbortController().signal);

    expect(changed).toHaveLength(2);
    expect(changed[1]?.text).toBe("Updated\n\nUpdated content.");
  });
});

// ---------------------------------------------------------------------------
// delete_journal_entries tool
// ---------------------------------------------------------------------------
describe("delete_journal_entries tool", () => {
  test("deletes an existing journal entry", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_journal_entry");
    const deleteTool = findTool(tools, "delete_journal_entries");

    const createResult = await saveTool.execute("tc-1", {
      title: "To delete",
      content: "Content to delete.",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    const deleteResult = await deleteTool.execute("tc-2", { ids: [id] }, new AbortController().signal);
    const text = (deleteResult.content[0] as { text: string }).text;
    expect(text).toContain("Deleted");
    expect(getMemory(db, id)).toBeNull();
  });

  test("rejects deletion of journal belonging to another guild", async () => {
    const toolsG1 = createMemoryTools(makeDeps());
    const toolsG2 = createMemoryTools(makeDeps({ guildId: "g2" }));
    const saveG1 = findTool(toolsG1, "save_journal_entry");
    const deleteG2 = findTool(toolsG2, "delete_journal_entries");

    const createResult = await saveG1.execute("tc-1", {
      title: "G1 task",
      content: "G1 content.",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    const deleteResult = await deleteG2.execute("tc-2", { ids: [id] }, new AbortController().signal);
    const text = (deleteResult.content[0] as { text: string }).text;
    expect(text).toContain("not found");

    // Verify still exists
    expect(getMemory(db, id)).not.toBeNull();
  });

  test("rejects deletion of user memory ID", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveUserTool = findTool(tools, "save_user_memory");
    const deleteJournalTool = findTool(tools, "delete_journal_entries");

    // Create a user memory
    const userResult = await saveUserTool.execute("tc-1", {
      username: "u1",
      title: "User fact",
    }, new AbortController().signal);
    const memId = (userResult.details as { memoryId: number }).memoryId;

    // Try to delete it via delete_journal_entries
    const result = await deleteJournalTool.execute("tc-2", { ids: [memId] }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not a journal entry");

    // Verify still exists
    expect(getMemory(db, memId)).not.toBeNull();
  });

  test("reports when journal not found", async () => {
    const tools = createMemoryTools(makeDeps());
    const deleteTool = findTool(tools, "delete_journal_entries");

    const result = await deleteTool.execute("tc-1", { ids: [999999] }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not found");
  });

  test("calls onMemoryDeleted after delete", async () => {
    const deleted: number[] = [];
    const tools = createMemoryTools(makeDeps({
      onMemoryDeleted: (id) => { deleted.push(id); },
    }));
    const saveTool = findTool(tools, "save_journal_entry");
    const deleteTool = findTool(tools, "delete_journal_entries");

    const createResult = await saveTool.execute("tc-1", {
      title: "To delete",
      content: "Content to delete.",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    await deleteTool.execute("tc-2", { ids: [id] }, new AbortController().signal);
    expect(deleted).toEqual([id]);
  });

  test("batch deletion of multiple journal entries", async () => {
    const deleted: number[] = [];
    const tools = createMemoryTools(makeDeps({
      onMemoryDeleted: (id) => { deleted.push(id); },
    }));
    const saveTool = findTool(tools, "save_journal_entry");
    const deleteTool = findTool(tools, "delete_journal_entries");

    const ids: number[] = [];
    for (const title of ["Entry A", "Entry B", "Entry C"]) {
      const r = await saveTool.execute("tc", { title, content: "c" }, new AbortController().signal);
      ids.push((r.details as { memoryId: number }).memoryId);
    }

    const result = await deleteTool.execute("tc-batch", { ids }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Deleted 3 of 3 journal entries");
    const details = result.details as { results: Array<{ id: number; deleted: boolean }> };
    expect(details.results).toHaveLength(3);
    expect(details.results.every((r) => r.deleted)).toBe(true);

    // All removed from DB
    for (const id of ids) {
      expect(getMemory(db, id)).toBeNull();
    }
    // All onMemoryDeleted callbacks fired
    expect(deleted.sort()).toEqual(ids.sort());
  });

  test("partial failure: mix of valid and nonexistent IDs", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_journal_entry");
    const deleteTool = findTool(tools, "delete_journal_entries");

    const r = await saveTool.execute("tc", { title: "Real", content: "c" }, new AbortController().signal);
    const realId = (r.details as { memoryId: number }).memoryId;

    const result = await deleteTool.execute("tc-partial", { ids: [realId, 999999] }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Deleted 1 of 2");
    expect(text).toContain("999999");
    expect(text).toContain("not found");

    expect(getMemory(db, realId)).toBeNull();
  });

  test("mixed scope rejection: user memory ID in journal batch", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveJournal = findTool(tools, "save_journal_entry");
    const saveUser = findTool(tools, "save_user_memory");
    const deleteTool = findTool(tools, "delete_journal_entries");

    const jr = await saveJournal.execute("tc", { title: "Journal", content: "c" }, new AbortController().signal);
    const journalId = (jr.details as { memoryId: number }).memoryId;

    const ur = await saveUser.execute("tc", { username: "u1", title: "User mem" }, new AbortController().signal);
    const userId = (ur.details as { memoryId: number }).memoryId;

    const result = await deleteTool.execute("tc-mixed", { ids: [journalId, userId] }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Deleted 1 of 2");
    expect(text).toContain("not a journal entry");

    // Journal deleted, user memory still exists
    expect(getMemory(db, journalId)).toBeNull();
    expect(getMemory(db, userId)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// save_user_memory tool
// ---------------------------------------------------------------------------
describe("save_user_memory tool", () => {
  test("creates a user memory via tool execution", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_user_memory");

    const result = await saveTool.execute("tc-1", {
      username: "u1",
      title: "Prefers dark mode",
    }, new AbortController().signal);

    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Saved");

    // Verify in DB (userId is resolved from username "u1" → "uid-1")
    const memories = listMemories(db, { scope: "user", guildId: "g1", userId: "uid-1" });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.title).toBe("Prefers dark mode");
  });

  test("resolves @username with leading @ via normalizeUsername", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_user_memory");

    const result = await saveTool.execute("tc-at", {
      username: "@u1",
      title: "At-prefixed save",
    }, new AbortController().signal);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Saved");

    const memories = listMemories(db, { scope: "user", guildId: "g1", userId: "uid-1" });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.title).toBe("At-prefixed save");
  });

  test("updates existing user memory when id is provided", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_user_memory");

    // Create first
    const createResult = await saveTool.execute("tc-4", {
      username: "u1",
      title: "Original",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    // Update
    await saveTool.execute("tc-5", {
      username: "u1",
      title: "Updated",
      id,
    }, new AbortController().signal);

    const mem = getMemory(db, id);
    expect(mem).not.toBeNull();
    expect(mem?.title).toBe("Updated");
  });

  test("rejects update of user memory belonging to another guild", async () => {
    const toolsG1 = createMemoryTools(makeDeps());
    const toolsG2 = createMemoryTools(makeDeps({ guildId: "g2" }));
    const saveG1 = findTool(toolsG1, "save_user_memory");
    const saveG2 = findTool(toolsG2, "save_user_memory");

    const createResult = await saveG1.execute("tc-6", {
      username: "u1",
      title: "G1 secret",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    // G2 tries to update G1's memory
    const updateResult = await saveG2.execute("tc-7", {
      username: "u1",
      title: "Hijacked",
      id,
    }, new AbortController().signal);
    const text = (updateResult.content[0] as { text: string }).text;
    expect(text).toContain("not found");
    expect((updateResult.details as { success: boolean }).success).toBe(false);

    // Verify original unchanged
    const mem = getMemory(db, id);
    expect(mem?.title).toBe("G1 secret");
  });

  test("rejects update of journal ID", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveJournalTool = findTool(tools, "save_journal_entry");
    const saveUserTool = findTool(tools, "save_user_memory");

    // Create a journal entry
    const journalResult = await saveJournalTool.execute("tc-1", {
      title: "Journal task",
      content: "Journal content.",
    }, new AbortController().signal);
    const journalId = (journalResult.details as { memoryId: number }).memoryId;

    // Try to update it via save_user_memory
    const result = await saveUserTool.execute("tc-2", {
      username: "u1",
      title: "Hijacked",
      id: journalId,
    }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not a user memory");
    expect((result.details as { success: boolean }).success).toBe(false);
  });

  test("calls onMemoryChanged after create", async () => {
    const changed: { id: number; text: string }[] = [];
    const tools = createMemoryTools(makeDeps({
      onMemoryChanged: (id, text) => { changed.push({ id, text }); },
    }));
    const saveTool = findTool(tools, "save_user_memory");

    await saveTool.execute("tc-8", {
      username: "u1",
      title: "Embed me",
    }, new AbortController().signal);

    expect(changed).toHaveLength(1);
    expect(changed[0]?.text).toBe("Embed me");
  });

  test("calls onMemoryChanged after update", async () => {
    const changed: { id: number; text: string }[] = [];
    const tools = createMemoryTools(makeDeps({
      onMemoryChanged: (id, text) => { changed.push({ id, text }); },
    }));
    const saveTool = findTool(tools, "save_user_memory");

    const createResult = await saveTool.execute("tc-9", {
      username: "u1",
      title: "Original",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    await saveTool.execute("tc-10", {
      username: "u1",
      title: "Updated",
      id,
    }, new AbortController().signal);

    expect(changed).toHaveLength(2);
    expect(changed[1]?.text).toBe("Updated");
  });
});

// ---------------------------------------------------------------------------
// delete_user_memories tool
// ---------------------------------------------------------------------------
describe("delete_user_memories tool", () => {
  test("deletes an existing user memory", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_user_memory");
    const deleteTool = findTool(tools, "delete_user_memories");

    const createResult = await saveTool.execute("tc-1", {
      username: "u1",
      title: "To delete",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    const deleteResult = await deleteTool.execute("tc-2", { ids: [id] }, new AbortController().signal);
    const text = (deleteResult.content[0] as { text: string }).text;
    expect(text).toContain("Deleted");
    expect(getMemory(db, id)).toBeNull();
  });

  test("rejects deletion of user memory belonging to another guild", async () => {
    const toolsG1 = createMemoryTools(makeDeps());
    const toolsG2 = createMemoryTools(makeDeps({ guildId: "g2" }));
    const saveG1 = findTool(toolsG1, "save_user_memory");
    const deleteG2 = findTool(toolsG2, "delete_user_memories");

    const createResult = await saveG1.execute("tc-11", {
      username: "u1",
      title: "G1 data",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    const deleteResult = await deleteG2.execute("tc-12", { ids: [id] }, new AbortController().signal);
    const text = (deleteResult.content[0] as { text: string }).text;
    expect(text).toContain("not found");

    // Verify still exists
    expect(getMemory(db, id)).not.toBeNull();
  });

  test("rejects deletion of journal ID", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveJournalTool = findTool(tools, "save_journal_entry");
    const deleteUserTool = findTool(tools, "delete_user_memories");

    // Create a journal entry
    const journalResult = await saveJournalTool.execute("tc-1", {
      title: "Journal task",
      content: "Journal content.",
    }, new AbortController().signal);
    const journalId = (journalResult.details as { memoryId: number }).memoryId;

    // Try to delete it via delete_user_memories
    const result = await deleteUserTool.execute("tc-2", { ids: [journalId] }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not a user memory");

    // Verify still exists
    expect(getMemory(db, journalId)).not.toBeNull();
  });

  test("reports when user memory not found", async () => {
    const tools = createMemoryTools(makeDeps());
    const deleteTool = findTool(tools, "delete_user_memories");

    const result = await deleteTool.execute("tc-15", { ids: [999999] }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not found");
  });

  test("calls onMemoryDeleted after delete", async () => {
    const deleted: number[] = [];
    const tools = createMemoryTools(makeDeps({
      onMemoryDeleted: (id) => { deleted.push(id); },
    }));
    const saveTool = findTool(tools, "save_user_memory");
    const deleteTool = findTool(tools, "delete_user_memories");

    const createResult = await saveTool.execute("tc-16", {
      username: "u1",
      title: "To delete",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    await deleteTool.execute("tc-17", { ids: [id] }, new AbortController().signal);
    expect(deleted).toEqual([id]);
  });

  test("batch deletion of multiple user memories", async () => {
    const deleted: number[] = [];
    const tools = createMemoryTools(makeDeps({
      onMemoryDeleted: (id) => { deleted.push(id); },
    }));
    const saveTool = findTool(tools, "save_user_memory");
    const deleteTool = findTool(tools, "delete_user_memories");

    const ids: number[] = [];
    for (const title of ["Mem A", "Mem B", "Mem C"]) {
      const r = await saveTool.execute("tc", { username: "u1", title }, new AbortController().signal);
      ids.push((r.details as { memoryId: number }).memoryId);
    }

    const result = await deleteTool.execute("tc-batch", { ids }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Deleted 3 of 3 user memories");
    const details = result.details as { results: Array<{ id: number; deleted: boolean }> };
    expect(details.results).toHaveLength(3);
    expect(details.results.every((r) => r.deleted)).toBe(true);

    for (const id of ids) {
      expect(getMemory(db, id)).toBeNull();
    }
    expect(deleted.sort()).toEqual(ids.sort());
  });

  test("partial failure: mix of valid and nonexistent IDs", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_user_memory");
    const deleteTool = findTool(tools, "delete_user_memories");

    const r = await saveTool.execute("tc", { username: "u1", title: "Real" }, new AbortController().signal);
    const realId = (r.details as { memoryId: number }).memoryId;

    const result = await deleteTool.execute("tc-partial", { ids: [realId, 999999] }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Deleted 1 of 2");
    expect(text).toContain("999999");
    expect(text).toContain("not found");

    expect(getMemory(db, realId)).toBeNull();
  });

  test("mixed scope rejection: journal ID in user memory batch", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveJournal = findTool(tools, "save_journal_entry");
    const saveUser = findTool(tools, "save_user_memory");
    const deleteTool = findTool(tools, "delete_user_memories");

    const ur = await saveUser.execute("tc", { username: "u1", title: "User mem" }, new AbortController().signal);
    const userId = (ur.details as { memoryId: number }).memoryId;

    const jr = await saveJournal.execute("tc", { title: "Journal", content: "c" }, new AbortController().signal);
    const journalId = (jr.details as { memoryId: number }).memoryId;

    const result = await deleteTool.execute("tc-mixed", { ids: [userId, journalId] }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Deleted 1 of 2");
    expect(text).toContain("not a user memory");

    // User memory deleted, journal still exists
    expect(getMemory(db, userId)).toBeNull();
    expect(getMemory(db, journalId)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recall_user_memories tool
// ---------------------------------------------------------------------------
describe("recall_user_memories tool", () => {
  test("lists user memories for current guild", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_user_memory");
    const recallTool = findTool(tools, "recall_user_memories");

    await saveTool.execute("tc-1", { username: "u1", title: "Fact A" }, new AbortController().signal);
    await saveTool.execute("tc-2", { username: "u1", title: "Fact B" }, new AbortController().signal);

    const result = await recallTool.execute("tc-3", { username: "u1" }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Fact A");
    expect(text).toContain("Fact B");
  });

  test("resolves @username with leading @ via normalizeUsername", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_user_memory");
    const recallTool = findTool(tools, "recall_user_memories");

    await saveTool.execute("tc-1", { username: "u1", title: "At-test fact" }, new AbortController().signal);

    const result = await recallTool.execute("tc-2", { username: "@u1" }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("At-test fact");
  });

  test("lists all user memories when userId not provided", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_user_memory");
    const recallTool = findTool(tools, "recall_user_memories");

    await saveTool.execute("tc-1", { username: "u1", title: "User 1 fact" }, new AbortController().signal);
    await saveTool.execute("tc-2", { username: "u2", title: "User 2 fact" }, new AbortController().signal);

    const result = await recallTool.execute("tc-3", {}, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("User 1 fact");
    expect(text).toContain("User 2 fact");
  });

  test("returns empty message when no user memories found", async () => {
    const tools = createMemoryTools(makeDeps());
    const recallTool = findTool(tools, "recall_user_memories");

    const result = await recallTool.execute("tc-1", {}, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No user memories");
  });

  test("returns specific message when no memories for user", async () => {
    const tools = createMemoryTools(makeDeps());
    const recallTool = findTool(tools, "recall_user_memories");

    const result = await recallTool.execute("tc-1", { username: "u999" }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No user memories found for @u999");
  });

  test("guild isolation: cannot see memories from other guilds", async () => {
    const toolsG1 = createMemoryTools(makeDeps());
    const toolsG2 = createMemoryTools(makeDeps({ guildId: "g2" }));
    const saveG1 = findTool(toolsG1, "save_user_memory");
    const recallG2 = findTool(toolsG2, "recall_user_memories");

    // Create user memory in G1
    await saveG1.execute("tc-1", { username: "u1", title: "G1 secret" }, new AbortController().signal);

    // Recall from G2 — should not see G1's memory
    const result = await recallG2.execute("tc-2", { username: "u1" }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No user memories");
  });

  test("does not include journal entries", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveJournalTool = findTool(tools, "save_journal_entry");
    const saveUserTool = findTool(tools, "save_user_memory");
    const recallTool = findTool(tools, "recall_user_memories");

    await saveJournalTool.execute("tc-1", { title: "Journal task", content: "Journal content." }, new AbortController().signal);
    await saveUserTool.execute("tc-2", { username: "u1", title: "User fact" }, new AbortController().signal);

    const result = await recallTool.execute("tc-3", {}, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("User fact");
    expect(text).not.toContain("Journal task");
  });
});

// ---------------------------------------------------------------------------
// recall_journal_entry tool
// ---------------------------------------------------------------------------
describe("recall_journal_entry tool", () => {
  test("retrieves journal entry by ID", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_journal_entry");
    const recallTool = findTool(tools, "recall_journal_entry");

    const createResult = await saveTool.execute("tc-1", {
      title: "Test entry",
      content: "Test content here.",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    const result = await recallTool.execute("tc-2", { id }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(`ID: ${id}`);
    expect(text).toContain("Title: Test entry");
    expect(text).toContain("Content: Test content here.");
    expect(text).toContain("Created:");
    expect(text).toContain("Updated:");
    expect((result.details as { found: boolean }).found).toBe(true);
  });

  test("reports not found for non-existent ID", async () => {
    const tools = createMemoryTools(makeDeps());
    const recallTool = findTool(tools, "recall_journal_entry");

    const result = await recallTool.execute("tc-1", { id: 999999 }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not found");
    expect((result.details as { found: boolean }).found).toBe(false);
  });

  test("rejects recall of journal from another guild", async () => {
    const toolsG1 = createMemoryTools(makeDeps());
    const toolsG2 = createMemoryTools(makeDeps({ guildId: "g2" }));
    const saveG1 = findTool(toolsG1, "save_journal_entry");
    const recallG2 = findTool(toolsG2, "recall_journal_entry");

    const createResult = await saveG1.execute("tc-1", {
      title: "G1 journal",
      content: "G1 content.",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    const result = await recallG2.execute("tc-2", { id }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not found");
    expect((result.details as { found: boolean }).found).toBe(false);
  });

  test("rejects recall of user memory ID", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveUserTool = findTool(tools, "save_user_memory");
    const recallJournalTool = findTool(tools, "recall_journal_entry");

    // Create a user memory
    const userResult = await saveUserTool.execute("tc-1", {
      username: "u1",
      title: "User fact",
    }, new AbortController().signal);
    const userId = (userResult.details as { memoryId: number }).memoryId;

    // Try to recall it via recall_journal_entry
    const result = await recallJournalTool.execute("tc-2", { id: userId }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not a journal entry");
    expect((result.details as { found: boolean }).found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Factory returns correct tools
// ---------------------------------------------------------------------------
describe("createMemoryTools factory", () => {
  test("returns all 6 tools", () => {
    const tools = createMemoryTools(makeDeps());
    expect(tools).toHaveLength(6);
    expect(tools.map(t => t.name).sort()).toEqual([
      "delete_journal_entries",
      "delete_user_memories",
      "recall_journal_entry",
      "recall_user_memories",
      "save_journal_entry",
      "save_user_memory",
    ]);
  });
});
