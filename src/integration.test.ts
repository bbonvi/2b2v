import { describe, test, expect, beforeEach } from "bun:test";
import { createDatabase, type Database } from "./db/database.ts";
import { translateInbound, translateOutbound, buildDisplayNameContext, type InboundResolvers, type OutboundResolvers } from "./discord/translation.ts";
import { createMemory, listMemories, getMemory } from "./db/memory-repository.ts";
import { createSchedule, getSchedule, listSchedules } from "./db/schedule-repository.ts";
import { createMemoryTools } from "./agent/memory-tools.ts";
import { createScheduleTool } from "./agent/schedule-tool.ts";
import { assembleSystemPrompt, type PromptContext, type ChatMessage } from "./agent/prompt.ts";
import { trimChatHistory } from "./agent/context-trimming.ts";
import { createMultiMessageSender, type ChannelActions, type MessageDelayConfig } from "./agent/multi-message.ts";
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
    expect(ctx).toBe("@alice — Alice W\n@bob — Bob X");
  });
});

// ---------------------------------------------------------------------------
// 2. Memory Tools → DB Roundtrip
// ---------------------------------------------------------------------------
describe("memory tools → DB roundtrip", () => {
  test("save_memory creates entry, list_memories retrieves, delete_memory removes", async () => {
    const tools = createMemoryTools({ db, guildId: GUILD_ID });
    const [saveTool, deleteTool, listTool] = tools;
    if (!saveTool || !deleteTool || !listTool) throw new Error("Tools not created");

    // Create
    const saveResult = await saveTool.execute("tc-1", {
      scope: "guild_bot",
      content: "Integration test memory",
    });
    const memoryId = (saveResult.details as { memoryId: string }).memoryId;
    expect(memoryId).toBeTruthy();

    // Verify in DB directly
    const dbRow = getMemory(db, memoryId);
    expect(dbRow).not.toBeNull();
    expect(dbRow?.content).toBe("Integration test memory");
    expect(dbRow?.scope).toBe("guild_bot");
    expect(dbRow?.guildId).toBe(GUILD_ID);

    // List via tool
    const listResult = await listTool.execute("tc-2", {
      scope: "guild_bot",
    });
    expect((listResult.details as { count: number } | undefined)?.count).toBe(1);

    // Delete via tool
    await deleteTool.execute("tc-3", { id: memoryId });
    expect(getMemory(db, memoryId)).toBeNull();
  });

  test("save_memory with id param updates existing entry", async () => {
    const tools = createMemoryTools({ db, guildId: GUILD_ID });
    const [saveTool] = tools;
    if (!saveTool) throw new Error("Tool not created");

    // Create
    const r1 = await saveTool.execute("tc-1", {
      scope: "user",
      content: "original",
      userId: USER_ID,
    });
    const id = (r1.details as { memoryId: string }).memoryId;

    // Update
    await saveTool.execute("tc-2", {
      scope: "user",
      content: "updated",
      id,
    });

    const row = getMemory(db, id);
    expect(row?.content).toBe("updated");
  });

  test("journal memory gets null expiry by default", async () => {
    const tools = createMemoryTools({ db, guildId: GUILD_ID });
    const [saveTool] = tools;
    if (!saveTool) throw new Error("Tool not created");

    const r = await saveTool.execute("tc-1", {
      scope: "journal",
      content: "",
      shortDescription: "Test journal",
      longDescription: "Detailed entry for integration test",
    });
    const id = (r.details as { memoryId: string }).memoryId;
    const row = getMemory(db, id);
    expect(row?.expiresAt).toBeNull();
    expect(row?.shortDescription).toBe("Test journal");
  });

  test("guild isolation: memories scoped to different guilds are independent", () => {
    createMemory(db, { scope: "guild_bot", guildId: "guild-A", content: "A data" });
    createMemory(db, { scope: "guild_bot", guildId: "guild-B", content: "B data" });

    const listA = listMemories(db, { scope: "guild_bot", guildId: "guild-A" });
    const listB = listMemories(db, { scope: "guild_bot", guildId: "guild-B" });

    expect(listA.length).toBe(1);
    expect(listA[0]?.content).toBe("A data");
    expect(listB.length).toBe(1);
    expect(listB[0]?.content).toBe("B data");
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

    // Verify section ordering
    const emojiIdx = prompt.indexOf("## Available Emojis");
    const membersIdx = prompt.indexOf("## Server Members");
    const journalIdx = prompt.indexOf("## Journal");
    const schedulesIdx = prompt.indexOf("## Upcoming Schedules");
    const historyIdx = prompt.indexOf("## Chat History");
    expect(emojiIdx).toBeLessThan(membersIdx);
    expect(membersIdx).toBeLessThan(journalIdx);
    expect(journalIdx).toBeLessThan(schedulesIdx);
    expect(schedulesIdx).toBeLessThan(historyIdx);
  });

  test("context trimming activates at trigger threshold and preserves newest", () => {
    const trim: TrimConfig = { trimTrigger: 10, trimTarget: 5 };
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
    const trim: TrimConfig = { trimTrigger: 5, trimTarget: 3 };
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
    });

    expect(prompt).toBe("Minimal bot");
    expect(prompt).not.toContain("##");
  });
});

// ---------------------------------------------------------------------------
// 5. Multi-Message Sender Pipeline
// ---------------------------------------------------------------------------
describe("multi-message sender pipeline", () => {
  test("first message is reply, subsequent are normal messages with typing", async () => {
    const log: string[] = [];
    const actions: ChannelActions = {
      sendReply: (text) => { log.push(`reply:${text}`); return Promise.resolve("id-1"); },
      sendMessage: (text) => { log.push(`msg:${text}`); return Promise.resolve(`id-${log.length}`); },
      startTyping: () => { log.push("typing"); },
      delay: () => { log.push("delay"); return Promise.resolve(); },
    };

    const config: MessageDelayConfig = { base: 0, perChar: 0 };
    const sender = createMultiMessageSender(actions, config);

    const result = await sender([
      { text: "Hello!" },
      { text: "Follow up" },
      { text: "Third message" },
    ]);

    expect(result.sentMessageIds.length).toBe(3);

    // First message: typing → reply (no delay before first)
    expect(log[0]).toBe("typing");
    expect(log[1]).toBe("reply:Hello!");
    // Second: delay → typing → msg
    expect(log[2]).toBe("delay");
    expect(log[3]).toBe("typing");
    expect(log[4]).toBe("msg:Follow up");
    // Third: delay → typing → msg
    expect(log[5]).toBe("delay");
    expect(log[6]).toBe("typing");
    expect(log[7]).toBe("msg:Third message");
  });

  test("abort signal stops sending mid-sequence", async () => {
    const controller = new AbortController();
    const sentTexts: string[] = [];

    const actions: ChannelActions = {
      sendReply: (text) => { sentTexts.push(text); return Promise.resolve("id-1"); },
      sendMessage: (text) => { sentTexts.push(text); return Promise.resolve("id-2"); },
      startTyping: () => {},
      delay: () => { controller.abort(); return Promise.resolve(); },
    };

    const sender = createMultiMessageSender(actions, { base: 100, perChar: 0 });
    const result = await sender(
      [{ text: "First" }, { text: "Second" }, { text: "Third" }],
      controller.signal
    );

    // Only first message sent; abort fires during delay before second
    expect(sentTexts).toEqual(["First"]);
    expect(result.sentMessageIds.length).toBe(1);
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
    createMemory(db, { scope: "guild_bot", guildId: GUILD_ID, content: "expired", ttlDays: -1 });
    createMemory(db, { scope: "guild_bot", guildId: GUILD_ID, content: "still valid" });

    // listMemories filters expired; ttlDays=-1 means expiry = now - 1 day (past)
    const all = listMemories(db, { scope: "guild_bot", guildId: GUILD_ID });
    const contents = all.map((m) => m.content);
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
    const trimConfig: TrimConfig = { trimTrigger: 10, trimTarget: 5 };
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
