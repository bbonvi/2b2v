import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";

import { createDatabase, type Database } from "../db/database";
import { getMemory } from "../db/memory-repository";
import { createMemoryTools, normalizeUsername, type MemoryToolsDeps } from "./memory-tools";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

const users = new Map<string, string>([
  ["alice", "uid-alice"],
  ["bob", "uid-bob"],
  ["@literal", "uid-literal"],
]);

function makeDeps(overrides: Partial<MemoryToolsDeps> = {}): MemoryToolsDeps {
  return {
    db,
    guildId: "g1",
    botUserId: "bot-1",
    resolveUsername: (username) => users.get(username),
    resolveUserId: (userId) => {
      for (const [username, id] of users.entries()) {
        if (id === userId) return username.startsWith("@") ? username.slice(1) : username;
      }
      return undefined;
    },
    ...overrides,
  };
}

function findTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`tool ${name} not found`);
  return tool;
}

describe("normalizeUsername", () => {
  test("strips one leading @ and trims whitespace", () => {
    expect(normalizeUsername(" @alice ")).toBe("alice");
    expect(normalizeUsername("@@alice")).toBe("@alice");
    expect(normalizeUsername("bob")).toBe("bob");
  });
});

describe("createMemoryTools factory", () => {
  test("returns only unified journal tools", () => {
    const names = createMemoryTools(makeDeps()).map((tool) => tool.name).sort();
    expect(names).toEqual([
      "delete_journal_entries",
      "get_journal_entries",
      "save_journal_entry",
    ]);
  });
});

describe("save_journal_entry", () => {
  test("creates global entries when username is omitted", async () => {
    const saveTool = findTool(createMemoryTools(makeDeps()), "save_journal_entry");
    const result = await saveTool.execute("tc-1", {
      content: "Global context note.",
    }, new AbortController().signal);

    const id = (result.details as { memoryId: number }).memoryId;
    const row = getMemory(db, id);
    expect(row?.scope).toBe("journal");
    expect(row?.userId).toBe("bot-1");
    expect(row?.content).toBe("Global context note.");
    expect((result.content[0] as { text: string }).text).toContain("(global)");
  });

  test("creates user-scoped entries when username is provided", async () => {
    const saveTool = findTool(createMemoryTools(makeDeps()), "save_journal_entry");
    const result = await saveTool.execute("tc-2", {
      username: "alice",
      content: "Alice prefers concise status updates.",
    }, new AbortController().signal);

    const id = (result.details as { memoryId: number }).memoryId;
    const row = getMemory(db, id);
    expect(row?.scope).toBe("user");
    expect(row?.userId).toBe("uid-alice");
    expect((result.content[0] as { text: string }).text).toContain("@alice");
  });

  test("resolves username with raw then @-stripped fallback", async () => {
    const saveTool = findTool(createMemoryTools(makeDeps()), "save_journal_entry");
    const result = await saveTool.execute("tc-3", {
      username: "@alice",
      content: "Fallback resolution works.",
    }, new AbortController().signal);

    const id = (result.details as { memoryId: number }).memoryId;
    expect(getMemory(db, id)?.userId).toBe("uid-alice");
  });

  test("returns clear error when user does not exist", async () => {
    const saveTool = findTool(createMemoryTools(makeDeps()), "save_journal_entry");
    const result = await saveTool.execute("tc-4", {
      username: "@missing",
      content: "This should fail.",
    }, new AbortController().signal);

    expect((result.content[0] as { text: string }).text).toContain("does not exist");
    expect((result.details as { success: boolean }).success).toBe(false);
  });

  test("updates existing entry with scope guard", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_journal_entry");

    const globalResult = await saveTool.execute("tc-5", {
      content: "Original global",
    }, new AbortController().signal);
    const globalId = (globalResult.details as { memoryId: number }).memoryId;

    await saveTool.execute("tc-6", {
      id: globalId,
      content: "Updated global",
    }, new AbortController().signal);
    expect(getMemory(db, globalId)?.content).toBe("Updated global");

    const mismatch = await saveTool.execute("tc-7", {
      id: globalId,
      username: "alice",
      content: "Wrong update",
    }, new AbortController().signal);
    expect((mismatch.content[0] as { text: string }).text).toContain("global");
    expect((mismatch.details as { success: boolean }).success).toBe(false);
  });
});

describe("get_journal_entries", () => {
  test("returns global and user-scoped entries when username is omitted", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_journal_entry");
    const getTool = findTool(tools, "get_journal_entries");

    const first = await saveTool.execute("tc-1", {
      content: "Global context",
    }, new AbortController().signal);
    const second = await saveTool.execute("tc-2", {
      username: "alice",
      content: "Alice context",
    }, new AbortController().signal);
    const third = await saveTool.execute("tc-3", {
      username: "bob",
      content: "Bob context",
    }, new AbortController().signal);

    const firstId = (first.details as { memoryId: number }).memoryId;
    const secondId = (second.details as { memoryId: number }).memoryId;
    const thirdId = (third.details as { memoryId: number }).memoryId;

    const result = await getTool.execute("tc-4", {}, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(`ID: ${firstId}`);
    expect(text).toContain(`ID: ${secondId}`);
    expect(text).toContain(`ID: ${thirdId}`);
    expect(text).toContain("Scope: global");
    expect(text).toContain("Scope: @alice");
    expect(text).toContain("Scope: @bob");
    expect(text).toContain("Content: Global context");
    expect(text).toContain("Content: Alice context");
    expect(text).toContain("Content: Bob context");
    expect((result.details as { count: number }).count).toBe(3);
    expect((result.details as { ids: number[] }).ids).toEqual([
      firstId,
      secondId,
      thirdId,
    ]);
  });

  test("returns only resolved user scope when username is provided", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_journal_entry");
    const getTool = findTool(tools, "get_journal_entries");

    await saveTool.execute("tc-5", {
      content: "Global entry",
    }, new AbortController().signal);
    await saveTool.execute("tc-6", {
      username: "alice",
      content: "Scoped content",
    }, new AbortController().signal);
    await saveTool.execute("tc-7", {
      username: "bob",
      content: "Other user content",
    }, new AbortController().signal);

    const result = await getTool.execute("tc-8", { username: "@alice" }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("Scope: @alice");
    expect(text).toContain("Content: Scoped content");
    expect(text).not.toContain("Scope: global");
    expect(text).not.toContain("Content: Other user content");
    expect((result.details as { count: number }).count).toBe(1);
    expect((result.details as { scope: string }).scope).toBe("@alice");
  });

  test("returns explicit error for unknown user", async () => {
    const tools = createMemoryTools(makeDeps());
    const getTool = findTool(tools, "get_journal_entries");

    const result = await getTool.execute("tc-9", { username: "@missing" }, new AbortController().signal);
    expect((result.content[0] as { text: string }).text).toContain("does not exist");
    expect((result.details as { count: number }).count).toBe(0);
  });

  test("returns deterministic empty message when no entries are found", async () => {
    const tools = createMemoryTools(makeDeps());
    const getTool = findTool(tools, "get_journal_entries");

    const result = await getTool.execute("tc-10", { username: "alice" }, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("No journal entries found for @alice.");
    expect((result.details as { count: number }).count).toBe(0);
    expect((result.details as { scope: string }).scope).toBe("@alice");
    expect((result.details as { ids: number[] }).ids).toEqual([]);
  });
});

describe("delete_journal_entries", () => {
  test("deletes entries and reports scope in single-delete output", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_journal_entry");
    const deleteTool = findTool(tools, "delete_journal_entries");

    const createResult = await saveTool.execute("tc-1", {
      username: "alice",
      content: "To delete",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    const result = await deleteTool.execute("tc-2", { ids: [id], username: "alice" }, new AbortController().signal);
    expect((result.content[0] as { text: string }).text).toContain("@alice");
    expect(getMemory(db, id)).toBeNull();
  });

  test("enforces optional username scope filter", async () => {
    const tools = createMemoryTools(makeDeps());
    const saveTool = findTool(tools, "save_journal_entry");
    const deleteTool = findTool(tools, "delete_journal_entries");

    const createResult = await saveTool.execute("tc-3", {
      username: "alice",
      content: "Scoped delete guard",
    }, new AbortController().signal);
    const id = (createResult.details as { memoryId: number }).memoryId;

    const mismatch = await deleteTool.execute("tc-4", {
      ids: [id],
      username: "bob",
    }, new AbortController().signal);

    expect((mismatch.content[0] as { text: string }).text).toContain("different user");
    expect(getMemory(db, id)).not.toBeNull();
  });
});

describe("callbacks", () => {
  test("fires onMemoryChanged and onMemoryDeleted", async () => {
    const changed: Array<{ id: number; text: string }> = [];
    const deleted: number[] = [];
    const tools = createMemoryTools(makeDeps({
      onMemoryChanged: (id, text) => { changed.push({ id, text }); },
      onMemoryDeleted: (id) => { deleted.push(id); },
    }));

    const saveTool = findTool(tools, "save_journal_entry");
    const deleteTool = findTool(tools, "delete_journal_entries");

    const create = await saveTool.execute("tc-1", {
      content: "Callbacks content",
    }, new AbortController().signal);
    const id = (create.details as { memoryId: number }).memoryId;

    await saveTool.execute("tc-2", {
      id,
      content: "Callbacks content updated",
    }, new AbortController().signal);
    await deleteTool.execute("tc-3", { ids: [id] }, new AbortController().signal);

    expect(changed.map((item) => item.text)).toEqual([
      "Callbacks content",
      "Callbacks content updated",
    ]);
    expect(deleted).toEqual([id]);
  });
});
