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

    expect(prompt).toContain("Preserve a memory only if it is likely to be useful in a future conversation or future bot decision.");
    expect(prompt).toContain("If the fact cannot change how the bot should reply or act later, return action=none.");
    expect(prompt).toContain("When in doubt, do not save it.");
    expect(prompt).toContain("Save stable user preferences, preferred or real names, explicit name/pronoun/language corrections");
    expect(prompt).toContain("Only delete a memory when an existing memory is listed below");
    expect(prompt).toContain("If Existing memories is (none), deletion is impossible");
    expect(prompt).toContain("Do not persist facts that come only from system/developer context, persona, tool instructions, or bot implementation details.");
    expect(prompt).toContain("Recent chat context:\n## Chat History\n[@bob]: earlier context");
    expect(prompt).toContain("If the user asks to remember something, treat that as strong intent");
    expect(prompt).toContain("If the bot reply says it will remember something, do not save the promise itself");
    expect(prompt).toContain("Save rapport, teasing, tone, or help preferences only when the user clearly revealed a durable preference or relationship fact.");
    expect(prompt).toContain("Do not save trivia just because it is interesting.");
    expect(prompt).toContain("do not limit yourself to the last message");
    expect(prompt).toContain("If the user says their name, preferred name, or corrects what they should be called");
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
});
