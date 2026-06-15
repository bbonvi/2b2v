import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TextContent } from "@mariozechner/pi-ai";
import { createDatabase, type Database } from "../db/database";
import { createMemory } from "../db/memory-repository";
import { createUserMemoryTool } from "./user-memory-tool";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function textOf(result: Awaited<ReturnType<ReturnType<typeof createUserMemoryTool>["execute"]>>): string {
  return (result.content[0] as TextContent).text;
}

describe("createUserMemoryTool", () => {
  test("returns get_user_memory AgentTool with expected metadata", () => {
    const tool = createUserMemoryTool({
      db,
      guildId: "g1",
      resolveUsername: () => Promise.resolve("u1"),
    });

    expect(tool.name).toBe("get_user_memory");
    expect(tool.description).toContain("global memories and memories for the user currently being replied to");
    expect(tool.description).toContain("leading @");
  });

  test("retrieves only user-scoped memories for the resolved guild user", async () => {
    createMemory(db, { guildId: "g1", kind: "global_note", content: "Global note" });
    createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "preference", content: "Likes concise answers" });
    createMemory(db, { guildId: "g1", subjectUserId: "u2", kind: "fact", content: "Other user fact" });
    createMemory(db, { guildId: "g2", subjectUserId: "u1", kind: "fact", content: "Other guild fact" });

    const tool = createUserMemoryTool({
      db,
      guildId: "g1",
      resolveUsername: (username) => Promise.resolve(username.toLowerCase() === "alice" ? "u1" : undefined),
    });
    const result = await tool.execute("tc1", { username: "@Alice" }, AbortSignal.timeout(5000));
    const text = textOf(result);

    expect(text).toContain("User-specific memories for @Alice:");
    expect(text).toContain("[preference] Likes concise answers");
    expect(text).not.toContain("Global note");
    expect(text).not.toContain("Other user fact");
    expect(text).not.toContain("Other guild fact");
    expect(result.details).toEqual({ userId: "u1", count: 1 });
  });

  test("limits returned memories", async () => {
    createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "fact", content: "First memory" });
    createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "fact", content: "Second memory" });

    const tool = createUserMemoryTool({
      db,
      guildId: "g1",
      resolveUsername: () => Promise.resolve("u1"),
    });
    const result = await tool.execute("tc1", { username: "alice", limit: 1 }, AbortSignal.timeout(5000));
    const text = textOf(result);

    expect(text).toContain("Second memory");
    expect(text).not.toContain("First memory");
    expect(result.details).toEqual({ userId: "u1", count: 1 });
  });

  test("reports no memories without returning global memories", async () => {
    createMemory(db, { guildId: "g1", kind: "global_note", content: "Global note" });

    const tool = createUserMemoryTool({
      db,
      guildId: "g1",
      resolveUsername: () => Promise.resolve("u1"),
    });
    const result = await tool.execute("tc1", { username: "alice" }, AbortSignal.timeout(5000));
    const text = textOf(result);

    expect(text).toContain("No user-specific memories found for @alice");
    expect(text).toContain("Global memories are already present");
    expect(text).not.toContain("Global note");
    expect(result.details).toEqual({ userId: "u1", count: 0 });
  });

  test("reports unknown users", async () => {
    const tool = createUserMemoryTool({
      db,
      guildId: "g1",
      resolveUsername: () => Promise.resolve(undefined),
    });
    const result = await tool.execute("tc1", { username: "@missing" }, AbortSignal.timeout(5000));

    expect(textOf(result)).toContain("User '@missing' not found");
    expect(result.details).toEqual({ error: true });
  });
});
