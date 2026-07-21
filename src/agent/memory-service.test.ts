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
  test("includes community and current-speaker memories only", () => {
    createMemory(db, { guildId: "g1", kind: "note", content: "Global note" });
    createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "preference", content: "Likes concise answers", confidence: 0.8 });
    createMemory(db, { guildId: "g1", aboutUserId: "u2", kind: "fact", content: "Other user fact" });

    const context = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u1",
      resolveUserId: (id) => id === "u1" ? "alice" : undefined,
    });

    expect(context).toContain("## Normal\n\n### community | this-guild | always\n\n1 note | Global note");
    expect(context).toContain("### @alice | anywhere | any(@alice)\n\n2 preference | Likes concise answers");
    expect(context).not.toContain("Other user fact");
  });

  test("includes self memories as bot continuity", () => {
    createMemory(db, { guildId: "g1", kind: "note", content: "Global note" });
    createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "preference", content: "Likes concise answers" });
    createMemory(db, { guildId: "g1", about: "self", kind: "journal", content: "Privately decided the server is worth returning to." });

    const context = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u1",
    });

    expect(context).toContain("### self | anywhere | always\n\n3 journal | Privately decided the server is worth returning to.");
  });

  test("loads targeted self memories only when a recall user is visible", () => {
    createMemory(db, { guildId: "g1", about: "self", kind: "journal", content: "General continuity." });
    createMemory(db, {
      guildId: "g1",
      about: "self",
      recallWhen: ["u2"],
      kind: "journal",
      content: "Use the stored reaction image when Bob starts baiting people.",
    });

    const withoutBob = buildMemoryContext({ db, guildId: "g1", currentUserId: "u1" });
    const withBob = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u1",
      visibleUserIds: ["u1", "u2"],
      resolveUserId: (id) => id === "u2" ? "bob" : undefined,
    });

    expect(withoutBob).toContain("General continuity.");
    expect(withoutBob).not.toContain("Bob starts baiting");
    expect(withBob).toContain("### self | anywhere | any(@bob)");
    expect(withBob).toContain("Bob starts baiting");
  });

  test("loads user preferences by recall trigger even when their subject is absent", () => {
    createMemory(db, {
      guildId: "g1",
      aboutUserId: "u-owner",
      recallWhen: "always",
      kind: "preference",
      content: "Owner requested a reaction available for everyone.",
    });
    createMemory(db, {
      guildId: "g1",
      aboutUserId: "u-owner",
      recallWhen: ["u-target"],
      kind: "preference",
      content: "Owner requested a reaction specifically around Target.",
    });

    const unrelated = buildMemoryContext({ db, guildId: "g1", currentUserId: "u-other" });
    const target = buildMemoryContext({ db, guildId: "g1", currentUserId: "u-target" });
    expect(unrelated).toContain("available for everyone");
    expect(unrelated).not.toContain("specifically around Target");
    expect(target).toContain("available for everyone");
    expect(target).toContain("specifically around Target");
  });

  test("omits cross-subject memories whose subject cannot be resolved", () => {
    createMemory(db, {
      guildId: "g1",
      aboutUserId: "u-owner",
      recallWhen: "always",
      kind: "constraint",
      content: "Owner requires direct permission before use.",
    });

    const unresolved = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u-other",
      resolveUserId: () => undefined,
    });
    const resolved = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u-other",
      resolveUserId: (userId) => userId === "u-owner" ? "owner" : undefined,
    });

    expect(unresolved).toBe("");
    expect(resolved).toContain("### @owner | anywhere | always\n\n1 constraint | Owner requires direct permission before use.");
  });

  test("renders future expiry relatively", () => {
    createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      kind: "scratchpad",
      content: "Alice is temporarily focused on launch prep.",
      expiresAt: Date.now() + (3 * 24 * 60 * 60 * 1000),
    });

    const context = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u1",
    });

    expect(context).toContain("scratchpad [expires in 3 days] | Alice is temporarily focused on launch prep.");
    expect(context).not.toContain("expiresAt");
  });

  test("renders newest capped memories at the bottom", () => {
    const old = createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "Older memory." });
    const fresh = createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "Fresh memory." });
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(100, old);
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(200, fresh);

    const context = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u1",
    });

    expect(context.indexOf("Older memory.")).toBeLessThan(context.indexOf("Fresh memory."));
    expect(context).toContain("#### fact\n\n1 | Older memory.\n2 | Fresh memory.");
  });

  test("keeps singleton kinds inline before repeated kind subgroups", () => {
    createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "Fact one." });
    createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "preference", content: "One preference." });
    createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "Fact two." });

    const context = buildMemoryContext({ db, guildId: "g1", currentUserId: "u1" });

    expect(context).toContain("### user:u1 | anywhere | any(user:u1)\n\n2 preference | One preference.\n\n#### fact\n\n1 | Fact one.\n3 | Fact two.");
  });

  test("shows visible memories out of total when capped", () => {
    const old = createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "Older memory." });
    const fresh = createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "Fresh memory." });
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(100, old);
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(200, fresh);

    const context = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u1",
      limit: 1,
    });

    expect(context).toContain("1/2 shown.");
    expect(context).toContain("Fresh memory.");
    expect(context).not.toContain("Older memory.");
  });

  test("keeps important capped memories and renders them at the bottom", () => {
    const important = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u1",
      kind: "fact",
      content: "Old important memory.",
      priority: 1,
    });
    const fresh = createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "Fresh normal memory." });
    const newest = createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "Newest normal memory." });
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(100, important);
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(200, fresh);
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(300, newest);

    const context = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u1",
      limit: 2,
    });

    expect(context).toContain("2/3 shown.");
    expect(context).toContain("Newest normal memory.");
    expect(context).toContain("## Important\n\n### user:u1 | anywhere | any(user:u1)\n\n1 fact | Old important memory.");
    expect(context.indexOf("Newest normal memory.")).toBeLessThan(context.indexOf("Old important memory."));
    expect(context).not.toContain("Fresh normal memory.");
  });

  test("keeps self memories inside the total memory cap", () => {
    createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "User memory one." });
    createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "User memory two." });
    createMemory(db, { guildId: "g1", about: "self", kind: "journal", content: "Self memory one." });
    createMemory(db, { guildId: "g1", about: "self", kind: "journal", content: "Self memory two." });

    const context = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u1",
      limit: 3,
    });

    expect(context).toContain("3/4 shown.");
    expect(context.match(/^\d+ /gm)).toHaveLength(3);
  });

  test("reserves a bounded slice for recent visible speakers", () => {
    createMemory(db, { guildId: "g1", aboutUserId: "u-current", kind: "fact", content: "Current memory one." });
    createMemory(db, { guildId: "g1", aboutUserId: "u-current", kind: "fact", content: "Current memory two." });
    const recentImportant = createMemory(db, {
      guildId: "g1",
      aboutUserId: "u-recent",
      kind: "preference",
      content: "Recent important memory.",
      priority: 1,
    });
    const recentMiddle = createMemory(db, { guildId: "g1", aboutUserId: "u-recent", kind: "fact", content: "Recent middle memory." });
    const recentNewest = createMemory(db, { guildId: "g1", aboutUserId: "u-recent", kind: "fact", content: "Recent newest memory." });
    createMemory(db, { guildId: "g1", aboutUserId: "u-second", kind: "interest", content: "Second speaker memory." });
    createMemory(db, { guildId: "g1", aboutUserId: "u-excluded", kind: "fact", content: "Excluded speaker memory." });
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(100, recentImportant);
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(200, recentMiddle);
    db.raw.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(300, recentNewest);

    const context = buildMemoryContext({
      db,
      guildId: "g1",
      currentUserId: "u-current",
      visibleUserIds: ["u-current", "u-recent", "u-second", "u-excluded"],
      resolveUserId: (id) => ({
        "u-current": "current",
        "u-recent": "recent",
        "u-second": "second",
        "u-excluded": "excluded",
      })[id],
      limit: 5,
      recentUserMaxUsers: 2,
      recentUserMaxMemoriesPerUser: 2,
      recentUserMaxRows: 3,
    });

    expect(context).toContain("5/6 shown.");
    expect(context.match(/^\d+ /gm)).toHaveLength(5);
    expect(context).toContain("Current memory two.");
    expect(context).toContain("## Important\n\n### @recent | anywhere | any(@recent)\n\n3 preference | Recent important memory.");
    expect(context).toContain("### @recent | anywhere | any(@recent)\n\n5 fact | Recent newest memory.");
    expect(context).not.toContain("Recent middle memory.");
    expect(context).toContain("### @second | anywhere | any(@second)\n\n6 interest | Second speaker memory.");
    expect(context).not.toContain("Excluded speaker memory.");
    expect(context.indexOf("Second speaker memory.")).toBeLessThan(context.indexOf("Recent important memory."));
  });
});

describe("buildVisibleUserMemoryContext", () => {
  test("hydrates newest visible users and newest memories within caps", () => {
    const newest = createMemory(db, { guildId: "g1", aboutUserId: "u-new", kind: "fact", content: "Newest visible-user memory." });
    const middle = createMemory(db, { guildId: "g1", aboutUserId: "u-new", kind: "fact", content: "Middle visible-user memory." });
    const oldest = createMemory(db, { guildId: "g1", aboutUserId: "u-new", kind: "fact", content: "Oldest visible-user memory." });
    const midUser = createMemory(db, { guildId: "g1", aboutUserId: "u-mid", kind: "interest", content: "Mid user memory." });
    createMemory(db, { guildId: "g1", aboutUserId: "u-old", kind: "fact", content: "Old visible-user memory." });
    createMemory(db, { guildId: "g1", aboutUserId: "u-current", kind: "preference", content: "Current user memory." });
    createMemory(db, { guildId: "g1", kind: "note", content: "Global memory." });
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
    expect(memories[0]?.expiresAt).toBeGreaterThanOrEqual(before + 90 * 60 * 1000);
    expect(memories[0]?.expiresAt).toBeLessThanOrEqual(after + 90 * 60 * 1000);
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

  test("rejects scratchpad creates without an expiry through a real tool", async () => {
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
          expiresIn: { amount: 2, unit: "days" },
        },
      ],
    });

    expect(listMemories(db, { guildId: "g1", aboutUserId: "u1" })).toHaveLength(0);
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
