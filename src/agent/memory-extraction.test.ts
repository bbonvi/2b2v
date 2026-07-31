import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database.ts";
import { createMemory, getMemory, listMemories, updateMemory } from "../db/memory-repository.ts";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

import {
  createRecordMemoryTool,
  extractAndApplyMemories,
} from "./memory-extraction.ts";

describe("extractAndApplyMemories", () => {
  test("normalizes array output from unsupported structured output providers", async () => {
    await extractAndApplyMemories({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
      userMessage: "i made this bot",
      assistantReply: "noted",
      recentContext: "",
      apiKey: "key",
      model: "model",
      promptCaching: { enabled: false },
      completeChat: () => Promise.resolve({
        text: JSON.stringify([
          {
            action: "create",
            about: "user", recall_in: "anywhere",
            username: "@alice",
            content: "Is the creator of the bot 2B.",
          },
        ]),
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    const memories = listMemories(db, { guildId: "g1", aboutUserId: "u1" });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.kind).toBe("fact");
    expect(memories[0]?.content).toBe("Is the creator of the bot 2B.");
  });

  test("records explicit preferred-name memories when the extractor returns one", async () => {
    await extractAndApplyMemories({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
      userMessage: "my real name is Sasha",
      assistantReply: "got it",
      recentContext: "",
      apiKey: "key",
      model: "model",
      promptCaching: { enabled: false },
      completeChat: () => Promise.resolve({
        text: JSON.stringify({
          actions: [{
            action: "create",
            about: "user", recall_in: "anywhere",
            username: "@alice",
            kind: "identity",
            content: "Preferred name is Sasha.",
          }],
        }),
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    const memories = listMemories(db, { guildId: "g1", aboutUserId: "u1" });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toBe("Preferred name is Sasha.");
  });

  test("updates an existing row without creating a duplicate", async () => {
    const existing = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      kind: "fact",
      content: "Is the creator of the bot 2B.",
    });

    await extractAndApplyMemories({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m2",
      userMessage: "i made this bot",
      assistantReply: "noted",
      recentContext: "",
      apiKey: "key",
      model: "model",
      promptCaching: { enabled: false },
      completeChat: () => Promise.resolve({
        text: JSON.stringify({
          actions: [{
            action: "update",
            id: existing,
            about: "user", recall_in: "anywhere",
            username: "@alice",
            kind: "fact",
            content: "Is the creator of the bot 2B.",
          }],
        }),
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    expect(listMemories(db, { guildId: "g1", aboutUserId: "u1" })).toHaveLength(1);
  });

  test("upgrades duplicate memory priority when important is set", async () => {
    const existing = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      kind: "fact",
      content: "2B is still angry about the slur.",
    });

    await extractAndApplyMemories({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m2",
      userMessage: "sorry",
      assistantReply: "<ignore>not enough</ignore>",
      recentContext: "",
      apiKey: "key",
      model: "model",
      promptCaching: { enabled: false },
      completeChat: () => Promise.resolve({
        text: JSON.stringify({
          actions: [{
            action: "update",
            id: existing,
            about: "user", recall_in: "anywhere",
            username: "@alice",
            kind: "fact",
            content: "2B is still angry about the slur.",
            important: true,
          }],
        }),
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    expect(listMemories(db, { guildId: "g1", aboutUserId: "u1" })).toHaveLength(1);
    expect(getMemory(db, existing)?.priority).toBe(1);
  });

  test("applies create, update, and delete actions", async () => {
    const existing = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      kind: "preference",
      content: "old preference",
    });
    const removed = createMemory(db, {
      guildId: "g1",
      kind: "note",
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
              action: "update",
              id: existing,
              about: "user", recall_in: "anywhere",
              username: "@alice",
              kind: "preference",
              content: "Prefers short replies.",
              confidence: 0.95,
            },
            {
              action: "create",
              about: "community", recall_in: "current_guild",
              kind: "interest",
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
    expect(listMemories(db, { guildId: "g1" }).some((row) => row.kind === "interest")).toBe(true);
  });

  test("ignores explicit legacy project kind from sloppy providers", async () => {
    await extractAndApplyMemories({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
      userMessage: "remember the rewrite project",
      assistantReply: "got it",
      recentContext: "",
      apiKey: "key",
      model: "model",
      promptCaching: { enabled: false },
      completeChat: () => Promise.resolve({
        text: JSON.stringify({
          actions: [{
              action: "update",
            about: "user", recall_in: "anywhere",
            username: "@alice",
            kind: "project",
            content: "Legacy project kind should not be coerced.",
          }],
        }),
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    expect(listMemories(db, { guildId: "g1", aboutUserId: "u1" })).toHaveLength(0);
  });

  test("applies relative expiresIn from extractor output", async () => {
    const before = Date.now();
    await extractAndApplyMemories({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
      userMessage: "remember I'm at the conference until tonight",
      assistantReply: "got it",
      recentContext: "",
      apiKey: "key",
      model: "model",
      promptCaching: { enabled: false },
      completeChat: () => Promise.resolve({
        text: JSON.stringify({
          actions: [{
            action: "create",
            about: "user", recall_in: "anywhere",
            username: "@alice",
            kind: "fact",
            content: "Alice is at the conference today.",
            expiresIn: { amount: 2, unit: "hours" },
          }],
        }),
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    const expiresAt = listMemories(db, { guildId: "g1", aboutUserId: "u1" })[0]?.expiresAt;
    const after = Date.now();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 2 * 60 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 2 * 60 * 60 * 1000);
  });

  test("ignores extractor output that tries to use raw expiresAt", async () => {
    await extractAndApplyMemories({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
      userMessage: "remember I'm at the conference until tonight",
      assistantReply: "got it",
      recentContext: "",
      apiKey: "key",
      model: "model",
      promptCaching: { enabled: false },
      completeChat: () => Promise.resolve({
        text: JSON.stringify({
          actions: [{
            action: "create",
            about: "user", recall_in: "anywhere",
            username: "@alice",
            kind: "fact",
            content: "Alice is at the conference today.",
            expiresAt: Date.now() + 2 * 60 * 60 * 1000,
          }],
        }),
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    expect(listMemories(db, { guildId: "g1", aboutUserId: "u1" })).toHaveLength(0);
  });

  test("ignores impossible delete ids from sloppy providers", async () => {
    const existing = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      kind: "fact",
      content: "Keep this memory.",
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
        text: JSON.stringify([{ action: "delete", id: 0 }]),
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    expect(getMemory(db, existing)?.content).toBe("Keep this memory.");
  });

  test("ignores update actions outside the current guild while allowing same-guild user targets", async () => {
    const otherGuild = createMemory(db, {
      guildId: "g2",
      kind: "note",
      content: "foreign guild",
    });
    const otherUser = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u2",
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
            action: "create",
              id: otherGuild,
              about: "user", recall_in: "anywhere",
              username: "@alice",
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
    expect(getMemory(db, otherUser)).toBeNull();
  });

  test("changes memory subject and scope when explicitly updated", async () => {
    const userMemory = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      kind: "preference",
      content: "old user memory",
    });
    const globalMemory = createMemory(db, {
      guildId: "g1",
      kind: "note",
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
              action: "update",
              id: userMemory,
              about: "community", recall_in: "current_guild",
              kind: "preference",
              content: "updated user memory",
            },
            {
              action: "update",
              id: globalMemory,
              about: "user", recall_in: "anywhere",
              username: "@alice",
              kind: "note",
              content: "updated global memory",
            },
          ],
        }),
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    expect(getMemory(db, userMemory)?.about).toBe("community");
    expect(getMemory(db, userMemory)?.aboutUserId).toBeNull();
    expect(getMemory(db, userMemory)?.content).toBe("updated user memory");
    expect(getMemory(db, globalMemory)?.about).toBe("user");
    expect(getMemory(db, globalMemory)?.aboutUserId).toBe("u1");
    expect(getMemory(db, globalMemory)?.content).toBe("updated global memory");
  });
});

describe("createRecordMemoryTool", () => {
  test("applies a mixed action batch atomically", async () => {
    const updated = createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "Old" });
    const deleted = createMemory(db, { guildId: "g1", kind: "note", content: "Delete me" });
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
    });

    const result = await tool.execute("call-1", { actions: [
      { action: "update", id: updated, about: "user", recall_in: "anywhere", username: "alice", recall_when: "always", kind: "fact", content: "New" },
      { action: "delete", id: deleted },
      { action: "create", about: "self", recall_in: "anywhere", recall_when: "always", kind: "journal", content: "A new coherent self memory." },
    ] });

    expect(result.details).toEqual({ applied: 3, requested: 3 });
    expect(getMemory(db, updated)?.content).toBe("New");
    expect(getMemory(db, updated)?.recallWhen).toBe("always");
    expect(getMemory(db, deleted)).toBeNull();
    expect(listMemories(db, { guildId: "g1", about: "self" })).toHaveLength(1);
  });

  test("rejects the whole batch when any action is invalid", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
      resolveUsername: () => Promise.resolve(undefined),
    });

    const result = await tool.execute("call-1", { actions: [
      { action: "create", about: "user", recall_in: "anywhere", username: "alice", recall_when: { users_present: ["alice"] }, kind: "fact", content: "Would be valid alone." },
      { action: "create", about: "user", recall_in: "anywhere", username: "missing", recall_when: { users_present: ["missing"] }, kind: "fact", content: "Cannot resolve." },
    ] });

    expect(result.details).toEqual({ error: true });
    expect(listMemories(db, { guildId: "g1", about: "user" })).toHaveLength(0);
  });

  test("applies memory updates through a real tool", async () => {
    const before = Date.now();
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [{
        action: "create",
        about: "user",
        username: "@alice",
        kind: "preference",
        content: "Prefers concise answers.",
        important: true,
        importantUntil: { amount: 30, unit: "minutes" },
        expiresIn: { amount: 90, unit: "minutes" },
      }],
    });

    const memories = listMemories(db, { guildId: "g1", aboutUserId: "u1" });
    const after = Date.now();
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toBe("Prefers concise answers.");
    expect(memories[0]?.recallIn).toBe("anywhere");
    expect(memories[0]?.recallWhen).toEqual(["u1"]);
    expect(memories[0]?.priority).toBe(1);
    expect(memories[0]?.importantUntil).toBeGreaterThanOrEqual(before + 30 * 60 * 1000);
    expect(memories[0]?.importantUntil).toBeLessThanOrEqual(after + 30 * 60 * 1000);
    expect(memories[0]?.expiresAt).toBeGreaterThanOrEqual(before + 90 * 60 * 1000);
    expect(memories[0]?.expiresAt).toBeLessThanOrEqual(after + 90 * 60 * 1000);
  });

  test("rejects importantUntil on a normal memory", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
    });

    const result = await tool.execute("call-1", {
      actions: [{
        action: "create",
        about: "user",
        username: "@alice",
        kind: "fact",
        content: "Normal memory with an invalid priority deadline.",
        importantUntil: { amount: 1, unit: "days" },
      }],
    });

    expect(result.details).toEqual({ error: true });
    expect(listMemories(db, { guildId: "g1", aboutUserId: "u1" })).toHaveLength(0);
  });

  test("uses only explicit source message IDs and supports preserve, replace, and clear", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "trigger-message",
    });

    await tool.execute("create", {
      actions: [
        {
          action: "create",
          about: "self",
          recall_in: "anywhere",
          recall_when: "always",
          kind: "journal",
          content: "Has no message evidence.",
        },
        {
          action: "create",
          about: "user",
          username: "@alice",
          recall_in: "anywhere",
          recall_when: { users_present: ["@alice"] },
          kind: "fact",
          content: "Has explicit message evidence.",
          source_message_id: "evidence-1",
        },
      ],
    });

    const noSource = listMemories(db, { guildId: "g1", about: "self" })[0];
    const sourced = listMemories(db, { guildId: "g1", aboutUserId: "u1" })[0];
    expect(noSource?.sourceMessageId).toBeNull();
    expect(sourced?.sourceMessageId).toBe("evidence-1");
    if (sourced === undefined) return;

    const update = {
      action: "update",
      id: sourced.id,
      about: "user",
      username: "@alice",
      recall_in: "anywhere",
      recall_when: { users_present: ["@alice"] },
      kind: "fact",
      content: "Has explicit message evidence.",
    } as const;

    await tool.execute("preserve", { actions: [update] });
    expect(getMemory(db, sourced.id)?.sourceMessageId).toBe("evidence-1");

    await tool.execute("replace", {
      actions: [{ ...update, source_message_id: "evidence-2" }],
    });
    expect(getMemory(db, sourced.id)?.sourceMessageId).toBe("evidence-2");

    await tool.execute("clear", {
      actions: [{ ...update, source_message_id: null }],
    });
    expect(getMemory(db, sourced.id)?.sourceMessageId).toBeNull();
  });

  test("sanitizes copied memory metadata and raw guild id prefixes", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [{
        action: "create",
        about: "user", recall_in: "anywhere",
        username: "@alice",
        recall_when: { users_present: ["@alice"] },
        kind: "preference",
        content: "In guild 427489527263789058: 17 [user:209563208199962625] [preference] Prefers concise answers.",
      }],
    });

    const memories = listMemories(db, { guildId: "g1", aboutUserId: "u1" });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toBe("Prefers concise answers.");
  });

  test("clears and prolongs memory expiry through a real tool", async () => {
    const temporary = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      kind: "fact",
      content: "Temporary launch focus.",
      expiresAt: Date.now() + 60_000,
    });
    const prolonged = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      kind: "scratchpad",
      content: "Temporary dashboard focus.",
      expiresAt: Date.now() + 60_000,
    });
    const before = Date.now();
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [
        {
          action: "update",
          id: temporary,
          about: "user", recall_in: "anywhere",
          username: "@alice",
          recall_when: { users_present: ["@alice"] },
          kind: "fact",
          content: "Launch focus is now durable context.",
          expiresIn: null,
        },
        {
          action: "update",
          id: prolonged,
          about: "user", recall_in: "anywhere",
          username: "@alice",
          recall_when: { users_present: ["@alice"] },
          kind: "scratchpad",
          content: "Temporary dashboard focus lasts through tonight.",
          expiresIn: { amount: 3, unit: "hours" },
        },
      ],
    });

    const prolongedExpiresAt = getMemory(db, prolonged)?.expiresAt;
    const after = Date.now();
    expect(getMemory(db, temporary)?.expiresAt).toBeNull();
    expect(prolongedExpiresAt).toBeGreaterThanOrEqual(before + 3 * 60 * 60 * 1000);
    expect(prolongedExpiresAt).toBeLessThanOrEqual(after + 3 * 60 * 60 * 1000);
  });

  test("preserves existing scratchpad expiry when update omits expiresIn", async () => {
    const expiresAt = Date.now() + 60_000;
    const scratchpad = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      kind: "scratchpad",
      content: "Check dashboard auth next.",
      expiresAt,
    });
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [{
        action: "update",
        id: scratchpad,
        about: "user", recall_in: "anywhere",
        username: "@alice",
        recall_when: { users_present: ["@alice"] },
        kind: "scratchpad",
        content: "Check dashboard auth headers next.",
      }],
    });

    expect(getMemory(db, scratchpad)?.content).toBe("Check dashboard auth headers next.");
    expect(getMemory(db, scratchpad)?.expiresAt).toBe(expiresAt);
  });

  test("accepts scratchpad expiry up to seven days and rejects invalid expiry through a real tool", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
    });

    const accepted = await tool.execute("call-1", {
      actions: [{
        action: "create",
        about: "user", recall_in: "anywhere",
        username: "@alice",
        recall_when: { users_present: ["@alice"] },
        kind: "scratchpad",
        content: "Valid for one week.",
        expiresIn: { amount: 1, unit: "weeks" },
      }],
    });

    expect(accepted.details).toEqual({ applied: 1, requested: 1 });
    expect(listMemories(db, { guildId: "g1", aboutUserId: "u1" })).toHaveLength(1);

    const rejected = await tool.execute("call-2", {
      actions: [
        {
          action: "create",
          about: "user", recall_in: "anywhere",
          username: "@alice",
          recall_when: { users_present: ["@alice"] },
          kind: "scratchpad",
          content: "Missing expiry.",
        },
        {
          action: "create",
          about: "user", recall_in: "anywhere",
          username: "@alice",
          recall_when: { users_present: ["@alice"] },
          kind: "scratchpad",
          content: "Null expiry.",
          expiresIn: null,
        },
        {
          action: "create",
          about: "user", recall_in: "anywhere",
          username: "@alice",
          recall_when: { users_present: ["@alice"] },
          kind: "scratchpad",
          content: "Too long.",
          expiresIn: { amount: 8, unit: "days" },
        },
      ],
    });

    expect(rejected.details).toEqual({ error: true });
    expect(rejected.content[0]).toEqual({
      type: "text",
      text: "Memory update rejected: Scratchpad memories require expiresIn of at most seven days.",
    });
    expect(listMemories(db, { guildId: "g1", aboutUserId: "u1" })).toHaveLength(1);
  });

  test("rejects explicit legacy project kind through a real tool", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [{
        action: "create",
        about: "user", recall_in: "anywhere",
        username: "@alice",
        recall_when: { users_present: ["@alice"] },
        kind: "project",
        content: "Legacy project kind should not be coerced.",
      }],
    });

    expect(listMemories(db, { guildId: "g1", aboutUserId: "u1" })).toHaveLength(0);
  });

  test("rejects creates with non-positive expiresIn through a real tool", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [{
        action: "create",
        about: "user", recall_in: "anywhere",
        username: "@alice",
        recall_when: { users_present: ["@alice"] },
        kind: "fact",
        content: "This already expired.",
        expiresIn: { amount: 0, unit: "hours" },
      }],
    });

    expect(listMemories(db, { guildId: "g1", aboutUserId: "u1" })).toHaveLength(0);
  });

  test("rejects creates with raw expiresAt through a real tool", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [{
        action: "create",
        about: "user", recall_in: "anywhere",
        username: "@alice",
        recall_when: { users_present: ["@alice"] },
        kind: "fact",
        content: "This attempts timestamp expiry.",
        expiresAt: Date.now() + 60_000,
      }],
    });

    expect(listMemories(db, { guildId: "g1", aboutUserId: "u1" })).toHaveLength(0);
  });

  test("records memories for another user by username", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
      resolveUsername: (username) => Promise.resolve(username === "bob" ? "u2" : undefined),
    });

    await tool.execute("call-1", {
      actions: [{
        action: "create",
        about: "user", recall_in: "anywhere",
        username: "@bob",
        recall_when: { users_present: ["@bob"] },
        kind: "fact",
        content: "Bob is working on the dashboard.",
        confidence: 0.6,
      }],
    });

    const memories = listMemories(db, { guildId: "g1", aboutUserId: "u2" });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toBe("Bob is working on the dashboard.");
    expect(memories[0]?.confidence).toBe(0.6);
  });

  test("records self journal memories", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [{
        action: "create",
        about: "self", recall_in: "anywhere",
        recall_when: "always",
        kind: "journal",
        content: "Told the server she keeps cheap red wine for bad nights.",
        confidence: 0.85,
      }],
    });

    const memories = listMemories(db, { guildId: "g1", about: "self" });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.about).toBe("self");
    expect(memories[0]?.aboutUserId).toBeNull();
    expect(memories[0]?.recallIn).toBe("anywhere");
    expect(memories[0]?.content).toBe("Told the server she keeps cheap red wine for bad nights.");
  });

  test("records exact multi-user recall triggers", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
      resolveUsername: (username) => Promise.resolve(({ bob: "u2", charlie: "u3" })[username]),
    });
    await tool.execute("call-1", { actions: [{
      action: "create",
      about: "self", recall_in: "anywhere",
      recall_when: { users_present: ["@bob", "charlie"] },
      kind: "journal",
      content: "Alice asked me to use reaction images when the named user starts baiting people.",
    }] });

    const memories = listMemories(db, { guildId: "g1", about: "self" });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.aboutUserId).toBeNull();
    expect(memories[0]?.recallWhen).toEqual(["u2", "u3"]);
  });

  test("rejects non-self journal memories", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [{
        action: "create",
        about: "user", recall_in: "anywhere",
        username: "@alice",
        recall_when: { users_present: ["@alice"] },
        kind: "journal",
        content: "This should not become a user journal.",
      }],
    });

    expect(listMemories(db, { guildId: "g1", aboutUserId: "u1" })).toHaveLength(0);
    expect(listMemories(db, { guildId: "g1", about: "self" })).toHaveLength(0);
  });
});

