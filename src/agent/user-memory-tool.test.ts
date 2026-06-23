import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TextContent } from "@mariozechner/pi-ai";
import { createDatabase, type Database } from "../db/database";
import { createMemory } from "../db/memory-repository";
import { createMemoryListTool } from "./user-memory-tool";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function textOf(result: Awaited<ReturnType<ReturnType<typeof createMemoryListTool>["execute"]>>): string {
  return (result.content[0] as TextContent).text;
}

describe("createMemoryListTool", () => {
  test("returns list_memories AgentTool with expected metadata", () => {
    const tool = createMemoryListTool({
      db,
      currentGuildId: "g1",
      resolveUsername: () => Promise.resolve("u1"),
    });

    expect(tool.name).toBe("list_memories");
    expect(tool.description).toBe("Retrieve bot memories.");
  });

  test("retrieves portable user memories for the resolved guild user", async () => {
    createMemory(db, { guildId: "g1", kind: "global_note", content: "Global note" });
    createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "preference", content: "Likes concise answers" });
    createMemory(db, { guildId: "g1", subjectUserId: "u2", kind: "fact", content: "Other user fact" });
    createMemory(db, { guildId: "g2", subjectUserId: "u1", kind: "fact", content: "Other guild fact" });

    const tool = createMemoryListTool({
      db,
      currentGuildId: "g1",
      resolveUsername: (username, guildId) => Promise.resolve(username.toLowerCase() === "alice" && guildId === "g1" ? "u1" : undefined),
    });
    const result = await tool.execute("tc1", { target: "user", username: "@Alice" }, AbortSignal.timeout(5000));
    const text = textOf(result);

    expect(text).toContain("Portable user memories for @Alice (user:u1) (2/2 shown):");
    expect(text).toContain("[preference] Likes concise answers");
    expect(text).toContain("[fact] Other guild fact");
    expect(text).not.toContain("[user:u1]");
    expect(text).not.toContain("Global note");
    expect(text).not.toContain("Other user fact");
    expect(result.details).toEqual({ target: "user", userId: "u1", count: 2, total: 2 });
  });

  test("limits returned memories", async () => {
    createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "fact", content: "First memory" });
    createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "fact", content: "Second memory" });

    const tool = createMemoryListTool({
      db,
      currentGuildId: "g1",
      resolveUsername: () => Promise.resolve("u1"),
    });
    const result = await tool.execute("tc1", { target: "user", username: "alice", limit: 1 }, AbortSignal.timeout(5000));
    const text = textOf(result);

    expect(text).toContain("Second memory");
    expect(text).not.toContain("First memory");
    expect(text).toContain("Portable user memories for @alice (user:u1) (1/2 shown):");
    expect(result.details).toEqual({ target: "user", userId: "u1", count: 1, total: 2 });
  });

  test("defaults returned memories to 30", async () => {
    for (let i = 1; i <= 31; i += 1) {
      createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "fact", content: `Memory ${i}` });
    }

    const tool = createMemoryListTool({
      db,
      currentGuildId: "g1",
      resolveUsername: () => Promise.resolve("u1"),
    });
    const result = await tool.execute("tc1", { target: "user", username: "alice" }, AbortSignal.timeout(5000));
    const text = textOf(result);

    expect(text).toContain("Portable user memories for @alice (user:u1) (30/31 shown):");
    expect(text).toContain("Memory 31");
    expect(text).not.toContain("[fact] Memory 1\n");
    expect(result.details).toEqual({ target: "user", userId: "u1", count: 30, total: 31 });
  });

  test("reports no user memories without returning guild memories", async () => {
    createMemory(db, { guildId: "g1", kind: "global_note", content: "Global note" });

    const tool = createMemoryListTool({
      db,
      currentGuildId: "g1",
      resolveUsername: () => Promise.resolve("u1"),
    });
    const result = await tool.execute("tc1", { target: "user", username: "alice" }, AbortSignal.timeout(5000));
    const text = textOf(result);

    expect(text).toContain("No portable user memories found for @alice (user:u1)");
    expect(text).toContain("target=guild");
    expect(text).not.toContain("Global note");
    expect(result.details).toEqual({ target: "user", userId: "u1", count: 0, total: 0 });
  });

  test("shows raw user id only in the user memories header", async () => {
    createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "fact", content: "Portable user note" });

    const tool = createMemoryListTool({
      db,
      currentGuildId: "g1",
      resolveUsername: () => Promise.resolve(undefined),
      isUserInGuild: () => Promise.resolve(true),
    });
    const result = await tool.execute("tc1", { target: "user", user_id: "u1" }, AbortSignal.timeout(5000));
    const text = textOf(result);

    expect(text).toContain("Portable user memories for user:u1 (1/1 shown):");
    expect(text).toContain("- 1 [0.7] [fact] Portable user note");
    expect(text).not.toContain("[user:u1]");
    expect(result.details).toEqual({ target: "user", userId: "u1", count: 1, total: 1 });
  });

  test("retrieves guild memories by guild id", async () => {
    createMemory(db, { guildId: "g1", kind: "global_note", content: "Current guild note" });
    createMemory(db, { guildId: "g2", kind: "global_note", content: "Other guild note" });
    createMemory(db, { guildId: "g2", subjectUserId: "u1", kind: "fact", content: "Portable user note" });

    const tool = createMemoryListTool({
      db,
      currentGuildId: "g1",
      resolveUsername: () => Promise.resolve(undefined),
      resolveGuildName: (guildId) => guildId === "g2" ? "Guild Two" : undefined,
    });
    const result = await tool.execute("tc1", { target: "guild", guild_id: "g2" }, AbortSignal.timeout(5000));
    const text = textOf(result);

    expect(text).toContain("Guild memories for Guild Two (g2) (1/1 shown):");
    expect(text).toContain("Other guild note");
    expect(text).not.toContain("Current guild note");
    expect(text).not.toContain("Portable user note");
    expect(result.details).toEqual({ target: "guild", guildId: "g2", count: 1, total: 1 });
  });

  test("retrieves self memories", async () => {
    createMemory(db, { guildId: "g1", scope: "self", kind: "journal", content: "Privately decided the room matters." });
    createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "fact", content: "Portable user note" });
    createMemory(db, { guildId: "g1", kind: "global_note", content: "Guild note" });

    const tool = createMemoryListTool({
      db,
      currentGuildId: "g1",
      resolveUsername: () => Promise.resolve(undefined),
    });
    const result = await tool.execute("tc1", { target: "self" }, AbortSignal.timeout(5000));
    const text = textOf(result);

    expect(text).toContain("Self memories (1/1 shown):");
    expect(text).toContain("[self] [0.7] [journal] Privately decided the room matters.");
    expect(text).not.toContain("Portable user note");
    expect(text).not.toContain("Guild note");
    expect(result.details).toEqual({ target: "self", count: 1, total: 1 });
  });

  test("rejects inaccessible guild memory reads", async () => {
    createMemory(db, { guildId: "g2", kind: "global_note", content: "Other guild note" });

    const tool = createMemoryListTool({
      db,
      currentGuildId: "g1",
      resolveUsername: () => Promise.resolve(undefined),
      canAccessGuild: () => Promise.resolve(false),
    });
    const result = await tool.execute("tc1", { target: "guild", guild_id: "g2" }, AbortSignal.timeout(5000));

    expect(textOf(result)).toContain("not found or not accessible");
    expect(textOf(result)).not.toContain("Other guild note");
    expect(result.details).toEqual({ error: true });
  });

  test("rejects raw user id reads when the user is not in the selected guild", async () => {
    createMemory(db, { guildId: "g1", subjectUserId: "u2", kind: "fact", content: "Portable user note" });

    const tool = createMemoryListTool({
      db,
      currentGuildId: "g1",
      resolveUsername: () => Promise.resolve(undefined),
      isUserInGuild: () => Promise.resolve(false),
    });
    const result = await tool.execute("tc1", { target: "user", user_id: "u2" }, AbortSignal.timeout(5000));

    expect(textOf(result)).toContain("User 'u2' not found in guild g1");
    expect(textOf(result)).not.toContain("Portable user note");
    expect(result.details).toEqual({ error: true });
  });

  test("reports unknown users", async () => {
    const tool = createMemoryListTool({
      db,
      currentGuildId: "g1",
      resolveUsername: () => Promise.resolve(undefined),
    });
    const result = await tool.execute("tc1", { target: "user", username: "@missing" }, AbortSignal.timeout(5000));

    expect(textOf(result)).toContain("User '@missing' not found");
    expect(result.details).toEqual({ error: true });
  });
});
