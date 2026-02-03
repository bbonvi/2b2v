import { describe, test, expect, beforeEach } from "bun:test";
import { createDatabase, type Database } from "./db/database.ts";
import { translateInbound, translateOutbound, buildDisplayNameContext, type InboundResolvers, type OutboundResolvers } from "./discord/translation.ts";
import { createMemory, listMemories, getMemory } from "./db/memory-repository.ts";
import { createSchedule, getSchedule, listSchedules } from "./db/schedule-repository.ts";
import { createMemoryTools } from "./agent/memory-tools.ts";
import { createScheduleTool } from "./agent/schedule-tool.ts";
import { assembleSystemPrompt, type PromptContext, type ChatMessage } from "./agent/prompt.ts";
import { trimChatHistory } from "./agent/context-trimming.ts";
import { shouldRespond, type TriggerInput } from "./agent/triggers.ts";
import type { TriggerConfig, TrimConfig } from "./config/types.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const GUILD_ID = "guild-integration-1";
const CHANNEL_ID = "channel-1";
const USER_ID = "user-42";

function makeInboundResolvers(): InboundResolvers {
  return {
    user: (id) => {
      if (id === "111") return { username: "alice", displayName: "Alice W" };
      if (id === "222") return { username: "bob", displayName: "Bob X" };
      return undefined;
    },
    channel: (id) => (id === "999" ? "general" : undefined),
    role: (id) => (id === "888" ? "moderator" : undefined),
  };
}

function makeOutboundResolvers(): OutboundResolvers {
  return {
    user: (username) => (username === "alice" ? "111" : undefined),
    channel: (name) => (name === "general" ? "999" : undefined),
    emoji: (name) =>
      name === "wave" ? { id: "555", animated: false } : undefined,
  };
}

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

// ---------------------------------------------------------------------------
// 1. Translation → DB Storage Pipeline
// ---------------------------------------------------------------------------
describe("translation → message storage pipeline", () => {
  test("inbound translation + message insert + retrieval", () => {
    const raw = "Hey <@111>, check <#999> for info from <@&888>";
    const translated = translateInbound(raw, makeInboundResolvers());

    expect(translated).toBe("Hey @alice, check #general for info from @moderator");

    // Store in messages table
    const msgId = "msg-001";
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(msgId, GUILD_ID, CHANNEL_ID, USER_ID, "alice", raw, translated, 0, now);

    const row = db.raw.prepare("SELECT * FROM messages WHERE id = ?").get(msgId) as Record<string, unknown>;
    expect(row.raw_content).toBe(raw);
    expect(row.translated_content).toBe(translated);
    expect(row.guild_id).toBe(GUILD_ID);
    expect(row.is_bot).toBe(0);
  });

  test("outbound translation resolves known entities and warns on unknowns", () => {
    const llmOutput = "Hi @alice, check #general and greet @unknown with :wave: and :missing:";
    const warnings: string[] = [];
    const result = translateOutbound(llmOutput, makeOutboundResolvers(), warnings);

    expect(result).toContain("<@111>");
    expect(result).toContain("<#999>");
    expect(result).toContain("<:wave:555>");
    expect(result).toContain("@unknown"); // left as-is
    expect(result).toContain(":missing:"); // left as-is
    expect(warnings.length).toBe(2);
  });

  test("roundtrip: inbound → outbound preserves resolvable entities", () => {
    const original = "Hello <@111>, see <#999> and <:wave:555>";
    const humanReadable = translateInbound(original, makeInboundResolvers());
    expect(humanReadable).toBe("Hello @alice, see #general and :wave:");

    const backToDiscord = translateOutbound(humanReadable, makeOutboundResolvers());
    expect(backToDiscord).toContain("<@111>");
    expect(backToDiscord).toContain("<#999>");
    expect(backToDiscord).toContain("<:wave:555>");
  });

  test("display name context builds correctly from user data", () => {
    const ctx = buildDisplayNameContext([
      { username: "alice", displayName: "Alice W" },
      { username: "bob", displayName: "Bob X" },
    ]);
    // Legend + user entries
    expect(ctx).toContain("Legend: [@username] — [display name] — [memories]");
    expect(ctx).toContain("recall_user_memories(username)");
    expect(ctx).toContain("@alice — Alice W");
    expect(ctx).toContain("@bob — Bob X");
  });
});

// ---------------------------------------------------------------------------
// 2. Memory Tools → DB Roundtrip
// ---------------------------------------------------------------------------

function findTool(tools: ReturnType<typeof createMemoryTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

// Mock username → userId resolver for tests
const mockUsers = new Map<string, string>([
  ["user-42", "uid-42"],
  ["testuser", USER_ID],
]);
const mockResolveUsername = (username: string): string | undefined => mockUsers.get(username);

describe("memory tools → DB roundtrip", () => {
  test("save_user_memory creates entry, recall_user_memories retrieves, delete_user_memory removes", async () => {
    const tools = createMemoryTools({ db, guildId: GUILD_ID, botUserId: "bot-1", resolveUsername: mockResolveUsername });
    const saveTool = findTool(tools, "save_user_memory");
    const deleteTool = findTool(tools, "delete_user_memory");
    const recallTool = findTool(tools, "recall_user_memories");

    // Create
    const saveResult = await saveTool.execute("tc-1", {
      shortDescription: "Integration test memory",
      username: "user-42",
    });
    const memoryId = (saveResult.details as { memoryId: number }).memoryId;
    expect(memoryId).toBeTruthy();

    // Verify in DB directly
    const dbRow = getMemory(db, memoryId);
    expect(dbRow).not.toBeNull();
    expect(dbRow?.shortDescription).toBe("Integration test memory");
    expect(dbRow?.scope).toBe("user");
    expect(dbRow?.guildId).toBe(GUILD_ID);

    // Recall via tool
    const recallResult = await recallTool.execute("tc-2", {
      username: "user-42",
    });
    expect((recallResult.details as { count: number } | undefined)?.count).toBe(1);

    // Delete via tool
    await deleteTool.execute("tc-3", { id: memoryId });
    expect(getMemory(db, memoryId)).toBeNull();
  });

  test("save_user_memory with id param updates existing entry", async () => {
    const tools = createMemoryTools({ db, guildId: GUILD_ID, botUserId: "bot-1", resolveUsername: mockResolveUsername });
    const saveTool = findTool(tools, "save_user_memory");

    // Create
    const r1 = await saveTool.execute("tc-1", {
      shortDescription: "original",
      username: "testuser",
    });
    const id = (r1.details as { memoryId: number }).memoryId;

    // Update
    await saveTool.execute("tc-2", {
      shortDescription: "updated",
      username: "testuser",
      id,
    });

    const row = getMemory(db, id);
    expect(row?.shortDescription).toBe("updated");
  });

  test("save_journal gets 180d TTL by default", async () => {
    const tools = createMemoryTools({ db, guildId: GUILD_ID, botUserId: "bot-1", resolveUsername: mockResolveUsername });
    const saveTool = findTool(tools, "save_journal");

    const before = Date.now();
    const r = await saveTool.execute("tc-1", {
      shortDescription: "Test journal",
      longDescription: "Detailed entry for integration test",
    });
    const id = (r.details as { memoryId: number }).memoryId;
    const row = getMemory(db, id);
    expect(row?.expiresAt).not.toBeNull();
    // Verify it's approximately 180 days from now
    const expectedExpiry = before + 180 * 24 * 60 * 60 * 1000;
    const actualExpiry = row?.expiresAt ?? 0;
    expect(actualExpiry).toBeGreaterThanOrEqual(expectedExpiry - 1000); // 1s tolerance
    expect(actualExpiry).toBeLessThanOrEqual(expectedExpiry + 1000);
    expect(row?.shortDescription).toBe("Test journal");
  });

  test("guild isolation: memories scoped to different guilds are independent", () => {
    createMemory(db, { scope: "user", guildId: "guild-A", userId: "user-1", shortDescription: "A data" });
    createMemory(db, { scope: "user", guildId: "guild-B", userId: "user-1", shortDescription: "B data" });

    const listA = listMemories(db, { scope: "user", guildId: "guild-A" });
    const listB = listMemories(db, { scope: "user", guildId: "guild-B" });

    expect(listA.length).toBe(1);
    expect(listA[0]?.shortDescription).toBe("A data");
    expect(listB.length).toBe(1);
    expect(listB[0]?.shortDescription).toBe("B data");
  });
});

// ---------------------------------------------------------------------------
// 3. Schedule Tool → DB Roundtrip
// ---------------------------------------------------------------------------
describe("schedule tool → DB roundtrip", () => {
  test("schedule_message creates one-off schedule in DB and notifies engine", async () => {
    const createdIds: string[] = [];
    const tool = createScheduleTool({
      db,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      timezone: "UTC",
      onScheduleCreated: (id) => createdIds.push(id),
    });

    const before = Date.now();
    const result = await tool.execute("tc-1", {
      amount: 5,
      unit: "minutes",
      message: "Reminder: integration test",
    });

    const details = result.details as { scheduleId: string; runAt: number };
    expect(details.scheduleId).toBeTruthy();
    expect(details.runAt).toBeGreaterThanOrEqual(before + 5 * 60_000);

    // Verify callback fired
    expect(createdIds).toEqual([details.scheduleId]);

    // Verify DB state
    const row = getSchedule(db, details.scheduleId);
    expect(row).not.toBeNull();
    expect(row?.guildId).toBe(GUILD_ID);
    expect(row?.channelId).toBe(CHANNEL_ID);
    expect(row?.source).toBe("tool");
    expect(row?.type).toBe("one_off");
    expect(row?.messageContent).toBe("Reminder: integration test");
    expect(row?.enabled).toBe(true);
  });

  test("schedule_message rejects non-positive amount", async () => {
    const tool = createScheduleTool({
      db,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      timezone: "UTC",
    });

    const result = await tool.execute("tc-1", {
      amount: -1,
      unit: "minutes",
      message: "bad",
    });

    const firstContent = result.content[0];
    expect(firstContent?.type).toBe("text");
    expect((firstContent as { type: "text"; text: string }).text).toContain("positive");
    const schedules = listSchedules(db, { guildId: GUILD_ID });
    expect(schedules.length).toBe(0);
  });

  test("admin and tool schedules coexist in same guild", () => {
    createSchedule(db, {
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      source: "admin",
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      messageContent: "Good morning",
    });
    createSchedule(db, {
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      source: "tool",
      type: "one_off",
      runAt: Date.now() + 60_000,
      timezone: "UTC",
      messageContent: "Reminder",
    });

    const all = listSchedules(db, { guildId: GUILD_ID });
    expect(all.length).toBe(2);
    const sources = all.map((s) => s.source).sort();
    expect(sources).toEqual(["admin", "tool"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Trigger → Prompt Assembly → Context Trimming Pipeline
// ---------------------------------------------------------------------------
describe("trigger → prompt assembly → trimming pipeline", () => {
  test("mention trigger + prompt assembly includes all context sections", () => {
    const input: TriggerInput = {
      content: "Hey bot",
      authorId: "user-1",
      botUserId: "bot-1",
      mentionedUserIds: ["bot-1"],
    };
    const triggers: TriggerConfig = { mention: true, keywords: [], randomChance: 0 };

    const result = shouldRespond(input, triggers);
    expect(result).toEqual({ reason: "mention" });

    // Build full prompt context
    const ctx: PromptContext = {
      persona: "You are TestBot, a friendly assistant.",
      emojiContext: ":wave: — greeting wave\n:fire: — excitement",
      displayNameContext: "@alice — Alice W\n@bob — Bob X",
      journalSummaries: ["User alice prefers short answers"],
      upcomingSchedules: ["Daily standup in 2 hours"],
      chatHistory: [
        { author: "alice", content: "Hello!", isBot: false },
        { author: "TestBot", content: "Hi Alice!", isBot: true },
      ],
      guildId: "g1",
      channelId: "c1",
      timestamp: "2025-01-01T00:00:00.000Z",
    };

    const prompt = assembleSystemPrompt(ctx);

    // Verify all sections present in correct order
    expect(prompt).toContain("You are TestBot");
    expect(prompt).toContain("## Available Emojis");
    expect(prompt).toContain(":wave: — greeting wave");
    expect(prompt).toContain("## Server Members");
    expect(prompt).toContain("@alice — Alice W");
    expect(prompt).toContain("## Journal");
    expect(prompt).toContain("User alice prefers short answers");
    expect(prompt).toContain("## Upcoming Schedules");
    expect(prompt).toContain("Daily standup in 2 hours");
    expect(prompt).toContain("## Chat History");
    expect(prompt).toContain("alice: Hello!");

    // Verify section ordering (use "\n## X\n" pattern to match actual sections, not TOOL_INSTRUCTIONS references)
    const emojiIdx = prompt.indexOf("\n## Available Emojis\n");
    const membersIdx = prompt.indexOf("\n## Server Members\n");
    const journalIdx = prompt.indexOf("\n## Journal\n");
    const schedulesIdx = prompt.indexOf("\n## Upcoming Schedules\n");
    const historyIdx = prompt.indexOf("\n## Chat History\n");
    expect(emojiIdx).toBeLessThan(membersIdx);
    expect(membersIdx).toBeLessThan(journalIdx);
    expect(journalIdx).toBeLessThan(schedulesIdx);
    expect(schedulesIdx).toBeLessThan(historyIdx);
  });

  test("context trimming activates at trigger threshold and preserves newest", () => {
    const trim: TrimConfig = { trimTrigger: 10, trimTarget: 5, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 };
    const messages: ChatMessage[] = Array.from({ length: 12 }, (_, i) => ({
      author: `user-${i}`,
      content: `message-${i}`,
      isBot: i % 2 === 0,
    }));

    const trimmed = trimChatHistory(messages, trim);
    expect(trimmed.length).toBe(5);
    // Should keep the newest 5 (indices 7-11)
    expect(trimmed[0]?.content).toBe("message-7");
    expect(trimmed[4]?.content).toBe("message-11");
  });

  test("trimmed history integrates into assembled prompt", () => {
    const trim: TrimConfig = { trimTrigger: 5, trimTarget: 3, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 };
    const fullHistory: ChatMessage[] = Array.from({ length: 6 }, (_, i) => ({
      author: `user-${i}`,
      content: `msg-${i}`,
      isBot: false,
    }));

    const trimmed = trimChatHistory(fullHistory, trim);
    expect(trimmed.length).toBe(3);

    const prompt = assembleSystemPrompt({
      persona: "Bot persona",
      emojiContext: "",
      displayNameContext: "",
      journalSummaries: [],
      upcomingSchedules: [],
      chatHistory: trimmed,
      guildId: "g1",
      channelId: "c1",
      timestamp: "2025-01-01T00:00:00.000Z",
    });

    // Only trimmed messages appear
    expect(prompt).not.toContain("msg-0");
    expect(prompt).not.toContain("msg-2");
    expect(prompt).toContain("msg-3");
    expect(prompt).toContain("msg-5");
  });

  test("empty optional sections are omitted from prompt", () => {
    const prompt = assembleSystemPrompt({
      persona: "Minimal bot",
      emojiContext: "",
      displayNameContext: "",
      journalSummaries: [],
      upcomingSchedules: [],
      chatHistory: [],
      guildId: "g1",
      channelId: "c1",
      timestamp: "2025-01-01T00:00:00.000Z",
    });

    expect(prompt).toStartWith("Minimal bot");
    expect(prompt).toContain("send_message");
    // Use "\n## X\n" pattern to check for actual sections (not TOOL_INSTRUCTIONS references)
    expect(prompt).not.toContain("\n## Available Emojis\n");
    expect(prompt).not.toContain("\n## Server Members\n");
    expect(prompt).not.toContain("\n## Journal\n");
    expect(prompt).not.toContain("\n## Chat History\n");
  });
});


// ---------------------------------------------------------------------------
// 6. Message Storage → Retrieval Integration
// ---------------------------------------------------------------------------
describe("message storage and retrieval", () => {
  test("stores multiple messages and queries by guild+channel+time", () => {
    const baseTime = 1700000000000;
    const messages = [
      { id: "m1", guildId: GUILD_ID, channelId: CHANNEL_ID, userId: "u1", author: "alice", raw: "raw1", translated: "translated1", isBot: 0, createdAt: baseTime },
      { id: "m2", guildId: GUILD_ID, channelId: CHANNEL_ID, userId: "u2", author: "bob", raw: "raw2", translated: "translated2", isBot: 0, createdAt: baseTime + 1000 },
      { id: "m3", guildId: GUILD_ID, channelId: "other-channel", userId: "u1", author: "alice", raw: "raw3", translated: "translated3", isBot: 0, createdAt: baseTime + 2000 },
      { id: "m4", guildId: "other-guild", channelId: CHANNEL_ID, userId: "u1", author: "alice", raw: "raw4", translated: "translated4", isBot: 0, createdAt: baseTime + 3000 },
    ];

    const stmt = db.raw.prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const m of messages) {
      stmt.run(m.id, m.guildId, m.channelId, m.userId, m.author, m.raw, m.translated, m.isBot, m.createdAt);
    }

    // Query by guild + channel
    const rows = db.raw
      .prepare("SELECT * FROM messages WHERE guild_id = ? AND channel_id = ? ORDER BY created_at")
      .all(GUILD_ID, CHANNEL_ID) as Array<{ id: string }>;
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.id)).toEqual(["m1", "m2"]);

    // Query by guild only
    const guildRows = db.raw
      .prepare("SELECT * FROM messages WHERE guild_id = ? ORDER BY created_at")
      .all(GUILD_ID) as Array<{ id: string }>;
    expect(guildRows.length).toBe(3);

    // Time-range query
    const timeRows = db.raw
      .prepare("SELECT * FROM messages WHERE guild_id = ? AND created_at > ? ORDER BY created_at")
      .all(GUILD_ID, baseTime) as Array<{ id: string }>;
    expect(timeRows.length).toBe(2);
    expect(timeRows.map((r) => r.id)).toEqual(["m2", "m3"]);
  });

  test("message retention: expired memories cleaned up correctly", () => {
    createMemory(db, { scope: "user", guildId: GUILD_ID, userId: "user-1", shortDescription: "expired", ttlDays: -1 });
    createMemory(db, { scope: "user", guildId: GUILD_ID, userId: "user-1", shortDescription: "still valid" });

    // listMemories filters expired; ttlDays=-1 means expiry = now - 1 day (past)
    const all = listMemories(db, { scope: "user", guildId: GUILD_ID });
    const contents = all.map((m) => m.shortDescription);
    expect(contents).toContain("still valid");
    expect(contents).not.toContain("expired");
  });
});

// ---------------------------------------------------------------------------
// 7. Cross-Cutting: Translation → Trimming → Prompt → Sender Pipeline
// ---------------------------------------------------------------------------
describe("full pipeline: translate → trim → assemble → send", () => {
  test("end-to-end message processing pipeline", () => {
    // 1. Simulate incoming Discord messages
    const rawMessages = [
      "Hey <@111>, what's up?",
      "Not much <@222>, just chillin in <#999>",
      "Cool, see you later!",
    ];

    const resolvers = makeInboundResolvers();
    const translated = rawMessages.map((raw) => translateInbound(raw, resolvers));

    expect(translated[0]).toBe("Hey @alice, what's up?");
    expect(translated[1]).toBe("Not much @bob, just chillin in #general");
    expect(translated[2]).toBe("Cool, see you later!");

    // 2. Build chat history from translated messages
    const chatHistory: ChatMessage[] = translated.map((content, i) => ({
      author: i === 0 ? "alice" : i === 1 ? "bob" : "alice",
      content,
      isBot: false,
    }));

    // 3. Trim (threshold not reached, so no trim)
    const trimConfig: TrimConfig = { trimTrigger: 10, trimTarget: 5, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 };
    const trimmed = trimChatHistory(chatHistory, trimConfig);
    expect(trimmed.length).toBe(3);

    // 4. Assemble system prompt
    const prompt = assembleSystemPrompt({
      persona: "You are TestBot.",
      emojiContext: "",
      displayNameContext: "@alice — Alice W\n@bob — Bob X",
      journalSummaries: [],
      upcomingSchedules: [],
      chatHistory: trimmed,
      guildId: "g1",
      channelId: "c1",
      timestamp: "2025-01-01T00:00:00.000Z",
    });

    expect(prompt).toContain("You are TestBot.");
    expect(prompt).toContain("@alice — Alice W");
    expect(prompt).toContain("alice: Hey @alice, what's up?");
    expect(prompt).toContain("bob: Not much @bob, just chillin in #general");

    // 5. Simulate outbound translation of an LLM response
    const llmResponse = "Hey @alice, I'll check #general for you!";
    const discordResponse = translateOutbound(llmResponse, makeOutboundResolvers());
    expect(discordResponse).toContain("<@111>");
    expect(discordResponse).toContain("<#999>");
  });
});
