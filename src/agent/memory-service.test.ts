import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database";
import { createMemory, getMemory, listMemories } from "../db/memory-repository";
import { buildMemoryContext, extractAndApplyMemories } from "./memory-service";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("buildMemoryContext", () => {
  test("includes global and current-user memories only", () => {
    createMemory(db, { guildId: "g1", kind: "global_note", content: "Global note" });
    createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "preference", content: "Likes concise answers" });
    createMemory(db, { guildId: "g1", subjectUserId: "u2", kind: "fact", content: "Other user fact" });

    const context = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u1",
      resolveUserId: (id) => id === "u1" ? "alice" : undefined,
    });

    expect(context).toContain("[global] [global_note] Global note");
    expect(context).toContain("[@alice] [preference] Likes concise answers");
    expect(context).not.toContain("Other user fact");
  });
});

describe("extractAndApplyMemories", () => {
  test("applies upsert and delete actions", async () => {
    const existing = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      kind: "preference",
      content: "old preference",
    });
    const removed = createMemory(db, {
      guildId: "g1",
      kind: "global_note",
      content: "stale",
    });

    await extractAndApplyMemories({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
      userMessage: "remember that I prefer short replies",
      assistantReply: "got it",
      recentContext: "",
      apiKey: "key",
      model: "model",
      promptCaching: { enabled: false },
      completeChat: () => Promise.resolve({
        text: JSON.stringify({
          actions: [
            {
              action: "upsert",
              id: existing,
              subject: "current_user",
              kind: "preference",
              content: "Prefers short replies.",
              confidence: 0.95,
            },
            {
              action: "upsert",
              subject: "global",
              kind: "project",
              content: "The server is testing the bot rewrite.",
            },
            { action: "delete", id: removed },
          ],
        }),
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    expect(getMemory(db, existing)?.content).toBe("Prefers short replies.");
    expect(getMemory(db, existing)?.confidence).toBe(0.95);
    expect(getMemory(db, removed)).toBeNull();
    expect(listMemories(db, { guildId: "g1" }).some((row) => row.kind === "project")).toBe(true);
  });

  test("ignores update and delete actions outside the current guild/user scope", async () => {
    const otherGuild = createMemory(db, {
      guildId: "g2",
      subjectUserId: "u1",
      kind: "preference",
      content: "foreign guild",
    });
    const otherUser = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u2",
      kind: "fact",
      content: "other user fact",
    });

    await extractAndApplyMemories({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
      userMessage: "hello",
      assistantReply: "hello",
      recentContext: "",
      apiKey: "key",
      model: "model",
      promptCaching: { enabled: false },
      completeChat: () => Promise.resolve({
        text: JSON.stringify({
          actions: [
            {
              action: "upsert",
              id: otherGuild,
              subject: "current_user",
              kind: "preference",
              content: "modified",
            },
            { action: "delete", id: otherUser },
          ],
        }),
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    expect(getMemory(db, otherGuild)?.content).toBe("foreign guild");
    expect(getMemory(db, otherUser)?.content).toBe("other user fact");
  });

  test("preserves existing memory scope when updating by id", async () => {
    const userMemory = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      kind: "preference",
      content: "old user memory",
    });
    const globalMemory = createMemory(db, {
      guildId: "g1",
      kind: "global_note",
      content: "old global memory",
    });

    await extractAndApplyMemories({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
      userMessage: "hello",
      assistantReply: "hello",
      recentContext: "",
      apiKey: "key",
      model: "model",
      promptCaching: { enabled: false },
      completeChat: () => Promise.resolve({
        text: JSON.stringify({
          actions: [
            {
              action: "upsert",
              id: userMemory,
              subject: "global",
              kind: "preference",
              content: "updated user memory",
            },
            {
              action: "upsert",
              id: globalMemory,
              subject: "current_user",
              kind: "global_note",
              content: "updated global memory",
            },
          ],
        }),
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    expect(getMemory(db, userMemory)?.subjectUserId).toBe("u1");
    expect(getMemory(db, userMemory)?.content).toBe("updated user memory");
    expect(getMemory(db, globalMemory)?.subjectUserId).toBeNull();
    expect(getMemory(db, globalMemory)?.content).toBe("updated global memory");
  });
});
