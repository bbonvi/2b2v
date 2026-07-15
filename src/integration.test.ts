import { beforeEach, describe, expect, test } from "bun:test";

import {
  buildDisplayNameContext,
  translateInbound,
  translateOutbound,
  type InboundResolvers,
  type OutboundResolvers,
} from "./discord/translation.ts";
import { createDatabase, type Database } from "./db/database.ts";
import { createMemory, getMemory, listMemories } from "./db/memory-repository.ts";
import { createSchedule, getSchedule, listSchedules } from "./db/schedule-repository.ts";
import { createScheduleTaskTool } from "./agent/schedule-tool.ts";
import { trimChatHistory } from "./agent/context-trimming.ts";
import type { ChatMessage } from "./agent/prompt.ts";
import type { TrimConfig } from "./config/types.ts";

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
    emoji: (name) => (name === "wave" ? { id: "555", animated: false } : undefined),
  };
}

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

describe("translation → message storage pipeline", () => {
  test("inbound translation + message insert + retrieval", () => {
    const raw = "Hey <@111>, check <#999> for info from <@&888>";
    const translated = translateInbound(raw, makeInboundResolvers());

    expect(translated).toBe("Hey @alice, check #general for info from @moderator");

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
  });

  test("display name context legend references automatic memory", () => {
    const ctx = buildDisplayNameContext([
      { username: "alice", displayName: "Alice W" },
      { username: "bob", displayName: "Bob X" },
    ]);
    expect(ctx).toContain("Legend: [@username] — [display name] — [memories]");
    expect(ctx).toContain("Memories are injected automatically");
  });

  test("roundtrip: inbound → outbound preserves resolvable entities", () => {
    const original = "Hello <@111>, see <#999> and <:wave:555>";
    const humanReadable = translateInbound(original, makeInboundResolvers());
    expect(humanReadable).toBe("Hello @alice, see #general and :wave:");

    const discord = translateOutbound(humanReadable, makeOutboundResolvers());
    expect(discord).toContain("<@111>");
    expect(discord).toContain("<#999>");
    expect(discord).toContain("<:wave:555>");
  });
});

describe("memory repository → DB roundtrip", () => {
  test("guild memories are isolated while user memories are portable", () => {
    createMemory(db, { kind: "note", guildId: "guild-A", content: "A data" });
    createMemory(db, { kind: "note", guildId: "guild-B", content: "B data" });
    createMemory(db, { kind: "note", guildId: "guild-A", aboutUserId: "user-1", content: "Portable data" });

    const listA = listMemories(db, { guildId: "guild-A" });
    const listB = listMemories(db, { guildId: "guild-B" });

    expect(listA[0]?.content).toBe("A data");
    expect(listB[0]?.content).toBe("B data");
    expect(listMemories(db, { guildId: "guild-B", aboutUserId: "user-1" })[0]?.content).toBe("Portable data");
  });

  test("subject-scoped memories are readable", () => {
    const id = createMemory(db, {
      kind: "preference",
      guildId: GUILD_ID,
      aboutUserId: USER_ID,
      content: "prefers concise answers",
      confidence: 0.9,
    });

    const row = getMemory(db, id);
    expect(row?.kind).toBe("preference");
    expect(row?.aboutUserId).toBe(USER_ID);
    expect(row?.confidence).toBe(0.9);
  });
});

describe("schedule tool → DB roundtrip", () => {
  test("schedule_task creates one-off schedule and notifies callback", async () => {
    const createdIds: string[] = [];
    const tool = createScheduleTaskTool({
      db,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      timezone: "UTC",
      onScheduleCreated: (id) => createdIds.push(id),
    });

    const result = await tool.execute("tc-1", {
      amount: 5,
      unit: "minutes",
      instructions: "Reminder: integration test",
    }, new AbortController().signal);

    const details = result.details as { scheduleId: string };
    expect(createdIds).toEqual([details.scheduleId]);
    expect(getSchedule(db, details.scheduleId)?.source).toBe("tool");
  });

  test("schedule_task rejects non-positive amount", async () => {
    const tool = createScheduleTaskTool({
      db,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      timezone: "UTC",
    });

    const result = await tool.execute("tc-2", {
      amount: -1,
      unit: "minutes",
      instructions: "bad",
    }, new AbortController().signal);

    expect((result.content[0] as { text: string }).text).toContain("positive");
    expect(listSchedules(db, { guildId: GUILD_ID })).toHaveLength(0);
  });

  test("admin and tool schedules coexist", () => {
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

    const sources = listSchedules(db, { guildId: GUILD_ID }).map((entry) => entry.source).sort();
    expect(sources).toEqual(["admin", "tool"]);
  });
});

describe("trigger → trimming pipeline", () => {
  test("context trimming preserves newest messages when over trigger", () => {
    const trim: TrimConfig = { trimTrigger: 10, trimTarget: 5, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50 };
    const messages: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
      author: `user-${index}`,
      content: `message-${index}`,
      isBot: index % 2 === 0,
    }));

    const trimmed = trimChatHistory(messages, trim);
    expect(trimmed).toHaveLength(5);
    expect(trimmed[0]?.content).toBe("message-7");
    expect(trimmed[4]?.content).toBe("message-11");
  });
});

describe("message storage and retrieval", () => {
  test("stores and filters messages by guild/channel/time", () => {
    const baseTime = 1700000000000;
    const insert = db.raw.prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run("m1", GUILD_ID, CHANNEL_ID, "u1", "alice", "raw1", "translated1", 0, baseTime);
    insert.run("m2", GUILD_ID, CHANNEL_ID, "u2", "bob", "raw2", "translated2", 0, baseTime + 1000);
    insert.run("m3", GUILD_ID, "other", "u1", "alice", "raw3", "translated3", 0, baseTime + 2000);

    const rows = db.raw
      .prepare("SELECT id FROM messages WHERE guild_id = ? AND channel_id = ? ORDER BY created_at")
      .all(GUILD_ID, CHANNEL_ID) as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(["m1", "m2"]);
  });

  test("soft-deleted memories are hidden by listMemories", () => {
    const deleted = createMemory(db, { kind: "note", guildId: GUILD_ID, aboutUserId: "user-1", content: "deleted" });
    createMemory(db, { kind: "note", guildId: GUILD_ID, aboutUserId: "user-1", content: "still valid" });
    db.raw.prepare("UPDATE memories SET deleted_at = ? WHERE id = ?").run(Date.now(), deleted);

    const visible = listMemories(db, { guildId: GUILD_ID, aboutUserId: "user-1" }).map((row) => row.content);
    expect(visible).toContain("still valid");
    expect(visible).not.toContain("deleted");
  });
});
