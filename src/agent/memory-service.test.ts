import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database";
import { createMemory, getMemory, listMemories } from "../db/memory-repository";
import type { OpenRouterChatRequest } from "../llm/openrouter-chat";
import { buildMemoryContext, createRecordMemoryTool, extractAndApplyMemories } from "./memory-service";

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

    expect(context).toContain("The number after scope is confidence");
    expect(context).toContain("[global] [0.7] [global_note] Global note");
    expect(context).toContain("[@alice] [0.8] [preference] Likes concise answers");
    expect(context).not.toContain("Other user fact");
  });

  test("renders future expiry relatively", () => {
    createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      kind: "project",
      content: "Alice is temporarily focused on launch prep.",
      expiresAt: Date.now() + (3 * 24 * 60 * 60 * 1000),
    });

    const context = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u1",
    });

    expect(context).toContain("[project] [expires in 3 days] Alice is temporarily focused on launch prep.");
    expect(context).not.toContain("expiresAt");
  });
});

describe("extractAndApplyMemories", () => {
  test("emphasizes future usefulness before preserving memories", async () => {
    let prompt = "";

    await extractAndApplyMemories({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
      userMessage: "lol that was funny",
      assistantReply: "yeah",
      recentContext: "## Chat History\n[@bob]: earlier context",
      timezone: "America/New_York",
      apiKey: "key",
      model: "model",
      promptCaching: { enabled: false },
      completeChat: (request: OpenRouterChatRequest) => {
        const firstMessage = request.messages[0];
        prompt = typeof firstMessage?.content === "string" ? firstMessage.content : "";
        return Promise.resolve({
          text: JSON.stringify({ actions: [{ action: "none" }] }),
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      },
    });

    expect(prompt).toContain("future conversation or future bot decision");
    expect(prompt).toContain("strongly implied durable facts");
    expect(prompt).toContain("standalone factual note");
    expect(prompt).toContain("narrowest correct scope");
    expect(prompt).toContain("expiresAt");
    expect(prompt).toContain("Current time for expiresAt calculations:");
    expect(prompt).toContain("Timezone: America/New_York");
    expect(prompt).toContain("Current Unix epoch milliseconds:");
    expect(prompt).toContain("Recent chat context:\n## Chat History\n[@bob]: earlier context");
  });

  test("omits recent chat context when none is provided", async () => {
    let prompt = "";

    await extractAndApplyMemories({
      db,
      guildId: "g1",
      currentUserId: "u1",
      currentUsername: "alice",
      sourceMessageId: "m1",
      userMessage: "hello",
      assistantReply: "hi",
      recentContext: "",
      apiKey: "key",
      model: "model",
      promptCaching: { enabled: false },
      completeChat: (request: OpenRouterChatRequest) => {
        const firstMessage = request.messages[0];
        prompt = typeof firstMessage?.content === "string" ? firstMessage.content : "";
        return Promise.resolve({
          text: JSON.stringify({ actions: [{ action: "none" }] }),
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      },
    });

    expect(prompt).not.toContain("Recent chat context:");
  });

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
            kind: "fact",
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

  test("applies expiresAt from extractor output", async () => {
    const expiresAt = Date.now() + 2 * 60 * 60 * 1000;
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
            expiresAt,
          }],
        }),
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      }),
    });

    expect(listMemories(db, { guildId: "g1", subjectUserId: "u1" })[0]?.expiresAt).toBe(expiresAt);
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
      }],
    });

    const memories = listMemories(db, { guildId: "g1", subjectUserId: "u1" });
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toBe("Prefers concise answers.");
  });

  test("clears and prolongs memory expiry through a real tool", async () => {
    const temporary = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      kind: "project",
      content: "Temporary launch focus.",
      expiresAt: Date.now() + 60_000,
    });
    const prolonged = createMemory(db, {
      guildId: "g1",
      subjectUserId: "u1",
      kind: "project",
      content: "Temporary dashboard focus.",
      expiresAt: Date.now() + 60_000,
    });
    const later = Date.now() + 3 * 60 * 60 * 1000;
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
          kind: "project",
          content: "Launch focus is now a durable project preference.",
          expiresAt: null,
        },
        {
          action: "upsert",
          id: prolonged,
          subject: "current_user",
          kind: "project",
          content: "Temporary dashboard focus lasts through tonight.",
          expiresAt: later,
        },
      ],
    });

    expect(getMemory(db, temporary)?.expiresAt).toBeNull();
    expect(getMemory(db, prolonged)?.expiresAt).toBe(later);
  });

  test("skips upserts with non-future expiresAt through a real tool", async () => {
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
        expiresAt: Date.now() - 1,
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
