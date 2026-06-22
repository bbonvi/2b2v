import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database";
import { createMemory, getMemory, listMemories } from "../db/memory-repository";
import { buildMemoryContext, buildVisibleUserMemoryContext, createRecordMemoryTool, extractAndApplyMemories } from "./memory-service";

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
    createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "preference", content: "Likes concise answers", confidence: 0.8 });
    createMemory(db, { guildId: "g1", subjectUserId: "u2", kind: "fact", content: "Other user fact" });

    const context = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u1",
      resolveUserId: (id) => id === "u1" ? "alice" : undefined,
    });

    expect(context).toContain("Showing 2/2 memories.");
    expect(context).toContain("Number after scope is confidence");
    expect(context).toContain("[global] [0.7] [global_note] Global note");
    expect(context).toContain("[@alice] [0.8] [preference] Likes concise answers");
    expect(context).not.toContain("Other user fact");
  });

  test("renders future expiry relatively", () => {
    createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      kind: "scratchpad",
      content: "Alice is temporarily focused on launch prep.",
      expiresAt: Date.now() + (3 * 24 * 60 * 60 * 1000),
    });

    const context = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u1",
    });

    expect(context).toContain("[scratchpad] [expires in 3 days] Alice is temporarily focused on launch prep.");
    expect(context).not.toContain("expiresAt");
  });

  test("renders newest capped memories at the bottom", () => {
    const old = createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "fact", content: "Older memory." });
    const fresh = createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "fact", content: "Fresh memory." });
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(100, old);
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(200, fresh);

    const context = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u1",
    });

    expect(context).toContain("Showing 2/2 memories.");
    expect(context.indexOf("Older memory.")).toBeLessThan(context.indexOf("Fresh memory."));
  });

  test("shows visible memories out of total when capped", () => {
    const old = createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "fact", content: "Older memory." });
    const fresh = createMemory(db, { guildId: "g1", subjectUserId: "u1", kind: "fact", content: "Fresh memory." });
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(100, old);
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(200, fresh);

    const context = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u1",
      limit: 1,
    });

    expect(context).toContain("Showing 1/2 memories.");
    expect(context).toContain("Fresh memory.");
    expect(context).not.toContain("Older memory.");
  });
});

describe("buildVisibleUserMemoryContext", () => {
  test("hydrates newest visible users and newest memories within caps", () => {
    const newest = createMemory(db, { guildId: "g1", subjectUserId: "u-new", kind: "fact", content: "Newest visible-user memory." });
    const middle = createMemory(db, { guildId: "g1", subjectUserId: "u-new", kind: "fact", content: "Middle visible-user memory." });
    const oldest = createMemory(db, { guildId: "g1", subjectUserId: "u-new", kind: "fact", content: "Oldest visible-user memory." });
    const midUser = createMemory(db, { guildId: "g1", subjectUserId: "u-mid", kind: "interest", content: "Mid user memory." });
    createMemory(db, { guildId: "g1", subjectUserId: "u-old", kind: "fact", content: "Old visible-user memory." });
    createMemory(db, { guildId: "g1", subjectUserId: "u-current", kind: "preference", content: "Current user memory." });
    createMemory(db, { guildId: "g1", kind: "global_note", content: "Global memory." });
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(300, newest);
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(200, middle);
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(100, oldest);
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(250, midUser);

    const context = buildVisibleUserMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u-current",
      visibleUserIds: ["u-new", "u-mid", "u-old", "u-current"],
      resolveUserId: (id) => ({ "u-new": "new", "u-mid": "mid", "u-old": "old" })[id],
      maxUsers: 2,
      maxMemoriesPerUser: 2,
      maxRows: 3,
    });

    expect(context).toContain("## Existing Memories For Other Visible Users");
    expect(context).toContain("### @new");
    expect(context).toContain("Newest visible-user memory.");
    expect(context).toContain("Middle visible-user memory.");
    expect(context).not.toContain("Oldest visible-user memory.");
    expect(context).toContain("### @mid");
    expect(context).toContain("Mid user memory.");
    expect(context).not.toContain("### @old");
    expect(context).not.toContain("Current user memory.");
    expect(context).not.toContain("Global memory.");
    expect(context.indexOf("### @mid")).toBeLessThan(context.indexOf("### @new"));
    expect(context.indexOf("Middle visible-user memory.")).toBeLessThan(context.indexOf("Newest visible-user memory."));
  });
});

describe("extractAndApplyMemories", () => {
  test("normalizes sloppy add-array output from unsupported structured output providers", async () => {
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
            action: "add",
            subject: "current_user",
            content: "Is the creator of the bot 2B.",
          },
        ]),
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    const memories = listMemories(db, { guildId: "g1", subjectUserId: "u1" });
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
            action: "upsert",
            subject: "current_user",
            kind: "identity",
            content: "Preferred name is Sasha.",
          }],
        }),
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    const memories = listMemories(db, { guildId: "g1", subjectUserId: "u1" });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toBe("Preferred name is Sasha.");
  });

  test("does not create duplicate memory rows for identical content", async () => {
    createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
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
            action: "upsert",
            subject: "current_user",
            kind: "fact",
            content: "Is the creator of the bot 2B.",
          }],
        }),
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    expect(listMemories(db, { guildId: "g1", subjectUserId: "u1" })).toHaveLength(1);
  });

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
            action: "upsert",
            subject: "current_user",
            kind: "project",
            content: "Legacy project kind should not be coerced.",
          }],
        }),
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    expect(listMemories(db, { guildId: "g1", subjectUserId: "u1" })).toHaveLength(0);
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
            action: "upsert",
            subject: "current_user",
            kind: "fact",
            content: "Alice is at the conference today.",
            expiresIn: { amount: 2, unit: "hours" },
          }],
        }),
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    const expiresAt = listMemories(db, { guildId: "g1", subjectUserId: "u1" })[0]?.expiresAt;
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
            action: "upsert",
            subject: "current_user",
            kind: "fact",
            content: "Alice is at the conference today.",
            expiresAt: Date.now() + 2 * 60 * 60 * 1000,
          }],
        }),
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    expect(listMemories(db, { guildId: "g1", subjectUserId: "u1" })).toHaveLength(0);
  });

  test("ignores impossible delete ids from sloppy providers", async () => {
    const existing = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
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
    expect(getMemory(db, otherUser)).toBeNull();
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

describe("createRecordMemoryTool", () => {
  test("applies memory updates through a real tool", async () => {
    const before = Date.now();
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [{
        action: "upsert",
        subject: "current_user",
        kind: "preference",
        content: "Prefers concise answers.",
        expiresIn: { amount: 90, unit: "minutes" },
      }],
    });

    const memories = listMemories(db, { guildId: "g1", subjectUserId: "u1" });
    const after = Date.now();
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toBe("Prefers concise answers.");
    expect(memories[0]?.expiresAt).toBeGreaterThanOrEqual(before + 90 * 60 * 1000);
    expect(memories[0]?.expiresAt).toBeLessThanOrEqual(after + 90 * 60 * 1000);
  });

  test("clears and prolongs memory expiry through a real tool", async () => {
    const temporary = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      kind: "fact",
      content: "Temporary launch focus.",
      expiresAt: Date.now() + 60_000,
    });
    const prolonged = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      kind: "scratchpad",
      content: "Temporary dashboard focus.",
      expiresAt: Date.now() + 60_000,
    });
    const before = Date.now();
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [
        {
          action: "upsert",
          id: temporary,
          subject: "current_user",
          kind: "fact",
          content: "Launch focus is now durable context.",
          expiresIn: null,
        },
        {
          action: "upsert",
          id: prolonged,
          subject: "current_user",
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
      subjectUserId: "u1",
      kind: "scratchpad",
      content: "Check dashboard auth next.",
      expiresAt,
    });
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [{
        action: "upsert",
        id: scratchpad,
        subject: "current_user",
        kind: "scratchpad",
        content: "Check dashboard auth headers next.",
      }],
    });

    expect(getMemory(db, scratchpad)?.content).toBe("Check dashboard auth headers next.");
    expect(getMemory(db, scratchpad)?.expiresAt).toBe(expiresAt);
  });

  test("rejects scratchpad upserts without an expiry through a real tool", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [
        {
          action: "upsert",
          subject: "current_user",
          kind: "scratchpad",
          content: "Missing expiry.",
        },
        {
          action: "upsert",
          subject: "current_user",
          kind: "scratchpad",
          content: "Null expiry.",
          expiresIn: null,
        },
        {
          action: "upsert",
          subject: "current_user",
          kind: "scratchpad",
          content: "Too long.",
          expiresIn: { amount: 2, unit: "days" },
        },
      ],
    });

    expect(listMemories(db, { guildId: "g1", subjectUserId: "u1" })).toHaveLength(0);
  });

  test("rejects explicit legacy project kind through a real tool", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [{
        action: "upsert",
        subject: "current_user",
        kind: "project",
        content: "Legacy project kind should not be coerced.",
      }],
    });

    expect(listMemories(db, { guildId: "g1", subjectUserId: "u1" })).toHaveLength(0);
  });

  test("skips upserts with non-positive expiresIn through a real tool", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [{
        action: "upsert",
        subject: "current_user",
        kind: "fact",
        content: "This already expired.",
        expiresIn: { amount: 0, unit: "hours" },
      }],
    });

    expect(listMemories(db, { guildId: "g1", subjectUserId: "u1" })).toHaveLength(0);
  });

  test("skips upserts with raw expiresAt through a real tool", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      sourceMessageId: "m1",
    });

    await tool.execute("call-1", {
      actions: [{
        action: "upsert",
        subject: "current_user",
        kind: "fact",
        content: "This attempts timestamp expiry.",
        expiresAt: Date.now() + 60_000,
      }],
    });

    expect(listMemories(db, { guildId: "g1", subjectUserId: "u1" })).toHaveLength(0);
  });

  test("records memories for another user by username", async () => {
    const tool = createRecordMemoryTool({
      db,
      guildId: "g1",
      currentUserId: "u1",
      sourceMessageId: "m1",
      resolveUsername: (username) => Promise.resolve(username === "bob" ? "u2" : undefined),
    });

    await tool.execute("call-1", {
      actions: [{
        action: "upsert",
        subject: "user",
        username: "@bob",
        kind: "fact",
        content: "Bob is working on the dashboard.",
        confidence: 0.6,
      }],
    });

    const memories = listMemories(db, { guildId: "g1", subjectUserId: "u2" });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toBe("Bob is working on the dashboard.");
    expect(memories[0]?.confidence).toBe(0.6);
  });
});
