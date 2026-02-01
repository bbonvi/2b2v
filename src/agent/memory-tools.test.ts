import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createDatabase, type Database } from "../db/database";
import { createMemoryTools } from "./memory-tools";
import { getMemory, listMemories } from "../db/memory-repository";
import type { AgentTool } from "@mariozechner/pi-agent-core";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function findTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`Tool ${name} not found`);
  return tool;
}

describe("save_memory tool", () => {
  test("creates a user memory via tool execution", async () => {
    const tools = createMemoryTools({ db, guildId: "g1" });
    const saveTool = findTool(tools, "save_memory");

    const result = await saveTool.execute("tc-1", {
      scope: "user",
      userId: "u1",
      content: "Prefers dark mode",
    }, new AbortController().signal);

    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Saved");

    // Verify in DB
    const memories = listMemories(db, { scope: "user", guildId: "g1", userId: "u1" });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toBe("Prefers dark mode");
  });

  test("creates a journal entry with descriptions", async () => {
    const tools = createMemoryTools({ db, guildId: "g1" });
    const saveTool = findTool(tools, "save_memory");

    await saveTool.execute("tc-2", {
      scope: "journal",
      content: "",
      shortDescription: "Follow up on Bob",
      longDescription: "Bob asked about the Rust project. Check in next week.",
    }, new AbortController().signal);

    const entries = listMemories(db, { scope: "journal" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.shortDescription).toBe("Follow up on Bob");
  });

  test("updates existing memory when id is provided", async () => {
    const tools = createMemoryTools({ db, guildId: "g1" });
    const saveTool = findTool(tools, "save_memory");

    // Create first
    const createResult = await saveTool.execute("tc-3", {
      scope: "guild_bot",
      content: "Original",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: string }).memoryId;

    // Update
    await saveTool.execute("tc-4", {
      scope: "guild_bot",
      content: "Updated",
      id,
    }, new AbortController().signal);

    const mem = getMemory(db, id);
    expect(mem).not.toBeNull();
    expect(mem?.content).toBe("Updated");
  });
});

describe("delete_memory tool", () => {
  test("deletes an existing memory", async () => {
    const tools = createMemoryTools({ db, guildId: "g1" });
    const saveTool = findTool(tools, "save_memory");
    const deleteTool = findTool(tools, "delete_memory");

    const createResult = await saveTool.execute("tc-5", {
      scope: "global_bot",
      content: "To delete",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: string }).memoryId;

    const deleteResult = await deleteTool.execute("tc-6", { id }, new AbortController().signal);
    const text = (deleteResult.content[0] as { text: string }).text;
    expect(text).toContain("Deleted");
    expect(getMemory(db, id)).toBeNull();
  });

  test("reports when memory not found", async () => {
    const tools = createMemoryTools({ db, guildId: "g1" });
    const deleteTool = findTool(tools, "delete_memory");

    const result = await deleteTool.execute("tc-7", { id: "nonexistent" }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not found");
  });
});

describe("list_memories tool", () => {
  test("lists user memories for current guild", async () => {
    const tools = createMemoryTools({ db, guildId: "g1" });
    const saveTool = findTool(tools, "save_memory");
    const listTool = findTool(tools, "list_memories");

    await saveTool.execute("tc-8", { scope: "user", userId: "u1", content: "Fact A" }, new AbortController().signal);
    await saveTool.execute("tc-9", { scope: "user", userId: "u1", content: "Fact B" }, new AbortController().signal);

    const result = await listTool.execute("tc-10", { scope: "user", userId: "u1" }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Fact A");
    expect(text).toContain("Fact B");
  });

  test("lists journal entries showing short descriptions", async () => {
    const tools = createMemoryTools({ db, guildId: "g1" });
    const saveTool = findTool(tools, "save_memory");
    const listTool = findTool(tools, "list_memories");

    await saveTool.execute("tc-11", {
      scope: "journal",
      content: "",
      shortDescription: "Task A",
      longDescription: "Details of task A",
    }, new AbortController().signal);

    const result = await listTool.execute("tc-12", { scope: "journal" }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Task A");
    // Long description not shown in list
    expect(text).not.toContain("Details of task A");
  });

  test("returns empty message when no memories found", async () => {
    const tools = createMemoryTools({ db, guildId: "g1" });
    const listTool = findTool(tools, "list_memories");

    const result = await listTool.execute("tc-13", { scope: "global_bot" }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No memories");
  });
});
