import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TextContent } from "@earendil-works/pi-ai";
import { createDatabase, type Database } from "../db/database";
import { createMemory } from "../db/memory-repository";
import { createSearchMemoriesTool } from "./search-memories-tool";

const ALICE_ID = "100000000000000001";
const BOB_ID = "100000000000000002";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function textOf(result: Awaited<ReturnType<ReturnType<typeof createSearchMemoriesTool>["execute"]>>): string {
  return (result.content[0] as TextContent).text;
}

function tool(overrides: Partial<Parameters<typeof createSearchMemoriesTool>[0]> = {}): ReturnType<typeof createSearchMemoriesTool> {
  return createSearchMemoriesTool({
    db,
    currentGuildId: "g1",
    resolveUsername: (username, guildId) => Promise.resolve(
      guildId === "g1" && username.toLowerCase() === "alice" ? ALICE_ID : undefined,
    ),
    resolveUsernameById: (userId) => userId === ALICE_ID ? "alice" : userId === BOB_ID ? "bob" : undefined,
    isUserInGuild: () => Promise.resolve(true),
    ...overrides,
  });
}

describe("createSearchMemoriesTool", () => {
  test("creates the compact search_memories tool", () => {
    const search = tool();
    const parameters = search.parameters as { properties?: Record<string, unknown> };

    expect(search.name).toBe("search_memories");
    expect(search.description).toBe("List or regex-search available memories.");
    expect(Object.keys(parameters.properties ?? {})).toEqual(["pattern", "user", "guild_id", "limit", "cursor"]);
  });

  test("lists all available memory subjects in flat rows without confidence", async () => {
    createMemory(db, { guildId: "g1", kind: "note", content: "Community note" });
    createMemory(db, { guildId: "g1", about: "self", kind: "journal", content: "Self note", confidence: 0.8 });
    createMemory(db, {
      guildId: "g1",
      aboutUserId: ALICE_ID,
      kind: "preference",
      content: "User note",
      sourceMessageId: "123456789012345678",
      confidence: 0.9,
    });

    const result = await tool().execute("tc1", {}, AbortSignal.timeout(5000));
    const text = textOf(result);

    expect(text).toContain("Memory search in current guild — 3/3 shown.");
    expect(text).toContain("[about:community] [in:this-guild] [when:always] [note]");
    expect(text).toContain("[about:self] [in:anywhere] [when:always] [journal]");
    expect(text).toContain("[about:@alice] [in:anywhere] [when:any(@alice)] [preference]");
    expect(text).toContain("Legend: a final bare [DiscordMsgID] is the optional source message.");
    expect(text).toContain("[123456789012345678] User note");
    expect(text).not.toContain("[0.8]");
    expect(text).not.toContain("[0.9]");
    expect(result.details).toEqual({ guildId: "g1", count: 3, total: 3, hasMore: false });
  });

  test("matches memories about or triggered by one resolved user", async () => {
    createMemory(db, { guildId: "g1", aboutUserId: ALICE_ID, kind: "fact", content: "About Alice" });
    createMemory(db, {
      guildId: "g1",
      about: "self",
      recallWhen: [ALICE_ID, BOB_ID],
      kind: "journal",
      content: "Triggered by Alice",
    });
    createMemory(db, { guildId: "g1", kind: "note", content: "Always community" });
    createMemory(db, { guildId: "g1", aboutUserId: BOB_ID, kind: "fact", content: "About Bob" });

    const result = await tool().execute("tc1", { user: "@Alice" }, AbortSignal.timeout(5000));
    const text = textOf(result);

    expect(text).toContain("About Alice");
    expect(text).toContain("Triggered by Alice");
    expect(text).not.toContain("Always community");
    expect(text).not.toContain("About Bob");
    expect(result.details).toEqual({ guildId: "g1", userId: ALICE_ID, count: 2, total: 2, hasMore: false });
  });

  test("accepts a raw Discord user ID", async () => {
    createMemory(db, { guildId: "g1", aboutUserId: ALICE_ID, kind: "fact", content: "Portable user note" });

    const result = await tool().execute("tc1", { user: ALICE_ID }, AbortSignal.timeout(5000));

    expect(textOf(result)).toContain("Portable user note");
    expect(result.details).toMatchObject({ userId: ALICE_ID, count: 1 });
  });

  test("regex-searches formatted metadata and content", async () => {
    createMemory(db, { guildId: "g1", kind: "note", content: "Friday voice chat" });
    createMemory(db, { guildId: "g1", aboutUserId: ALICE_ID, kind: "preference", content: "Likes espresso" });
    createMemory(db, { guildId: "g1", about: "self", kind: "journal", content: "Quiet room" });

    const result = await tool().execute("tc1", { pattern: "(?i)espresso|about:self" }, AbortSignal.timeout(5000));
    const text = textOf(result);

    expect(text).toContain("Likes espresso");
    expect(text).toContain("Quiet room");
    expect(text).not.toContain("Friday voice chat");
    expect(result.details).toMatchObject({ count: 2, total: 2 });
  });

  test("combines user and pattern filters", async () => {
    createMemory(db, { guildId: "g1", aboutUserId: ALICE_ID, kind: "fact", content: "Likes espresso" });
    createMemory(db, { guildId: "g1", aboutUserId: ALICE_ID, kind: "fact", content: "Likes tea" });
    createMemory(db, { guildId: "g1", aboutUserId: BOB_ID, kind: "fact", content: "Likes espresso" });

    const result = await tool().execute("tc1", { user: "alice", pattern: "espresso" }, AbortSignal.timeout(5000));
    const text = textOf(result);

    expect(text).toContain("Likes espresso");
    expect(text).not.toContain("Likes tea");
    expect(text.match(/Likes espresso/g)).toHaveLength(1);
  });

  test("returns stable cursor pages without duplicates", async () => {
    for (let index = 1; index <= 3; index += 1) {
      createMemory(db, { guildId: "g1", kind: "note", content: `Memory ${index}` });
    }

    const search = tool();
    const first = await search.execute("tc1", { limit: 1 }, AbortSignal.timeout(5000));
    const firstDetails = first.details as unknown;
    if (firstDetails === null || typeof firstDetails !== "object" || Array.isArray(firstDetails)) {
      throw new Error("Expected first memory page cursor.");
    }
    const nextCursor = (firstDetails as Record<string, unknown>).nextCursor;
    if (typeof nextCursor !== "string") throw new Error("Expected first memory page cursor.");
    const second = await search.execute("tc2", { limit: 1, cursor: nextCursor }, AbortSignal.timeout(5000));

    expect(first.details).toMatchObject({ count: 1, total: 3, hasMore: true });
    expect(second.details).toMatchObject({ count: 1, total: 3, hasMore: true });
    expect(textOf(first)).toContain("Memory 3");
    expect(textOf(second)).toContain("Memory 2");
    expect(textOf(second)).not.toContain("Memory 3");
  });

  test("rejects invalid regex and cursors", async () => {
    createMemory(db, { guildId: "g1", kind: "note", content: "Memory" });
    const search = tool();

    const regex = await search.execute("tc1", { pattern: "(" }, AbortSignal.timeout(5000));
    const cursor = await search.execute("tc2", { cursor: "not-a-cursor" }, AbortSignal.timeout(5000));

    expect(textOf(regex)).toContain("Invalid regex");
    expect(regex.details).toEqual({ error: true });
    expect(textOf(cursor)).toBe("Invalid memory cursor.");
    expect(cursor.details).toEqual({ error: true });
  });

  test("rejects inaccessible guild overrides", async () => {
    createMemory(db, { guildId: "g2", kind: "note", content: "Foreign note" });

    const result = await tool({ canAccessGuild: () => Promise.resolve(false) })
      .execute("tc1", { guild_id: "g2" }, AbortSignal.timeout(5000));

    expect(textOf(result)).toContain("not found or not accessible");
    expect(textOf(result)).not.toContain("Foreign note");
    expect(result.details).toEqual({ error: true });
  });

  test("reports unknown users", async () => {
    const result = await tool().execute("tc1", { user: "@missing" }, AbortSignal.timeout(5000));

    expect(textOf(result)).toContain("User '@missing' not found");
    expect(result.details).toEqual({ error: true });
  });
});
