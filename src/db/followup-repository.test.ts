import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, type Database } from "./database";
import { getFollowUpMessages } from "./followup-repository";
import { unlinkSync } from "fs";

const TEST_DB_PATH = "/tmp/followup-repo-test.db";

let db: Database;

beforeEach(() => {
  try { unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  db = createDatabase(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  try { unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
});

function insertMessage(
  id: string,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  createdAt: number,
  isBot: boolean = false,
  isSynthetic: boolean = false,
): void {
  db.raw
    .prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, is_synthetic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, "guild-1", channelId, userId, username, content, content, isBot ? 1 : 0, createdAt, isSynthetic ? 1 : 0);
}

describe("getFollowUpMessages", () => {
  test("returns messages after timestamp", () => {
    insertMessage("msg-1", "ch-1", "user-1", "alice", "hello", 1000);
    insertMessage("msg-2", "ch-1", "user-1", "alice", "follow up", 2000);
    insertMessage("msg-3", "ch-1", "user-2", "bob", "me too", 3000);

    const results = getFollowUpMessages(db, "ch-1", 1500, new Set(), "bot-1");
    expect(results).toHaveLength(2);
    expect((results[0] as (typeof results)[0]).id).toBe("msg-2");
    expect((results[1] as (typeof results)[0]).id).toBe("msg-3");
  });

  test("excludes specified IDs", () => {
    insertMessage("msg-1", "ch-1", "user-1", "alice", "hello", 2000);
    insertMessage("msg-2", "ch-1", "user-2", "bob", "hi", 3000);

    const results = getFollowUpMessages(db, "ch-1", 1000, new Set(["msg-1"]), "bot-1");
    expect(results).toHaveLength(1);
    expect((results[0] as (typeof results)[0]).id).toBe("msg-2");
  });

  test("respects limit", () => {
    insertMessage("msg-1", "ch-1", "user-1", "alice", "one", 2000);
    insertMessage("msg-2", "ch-1", "user-1", "alice", "two", 3000);
    insertMessage("msg-3", "ch-1", "user-1", "alice", "three", 4000);

    const results = getFollowUpMessages(db, "ch-1", 1000, new Set(), "bot-1", 2);
    expect(results).toHaveLength(2);
    expect((results[0] as (typeof results)[0]).id).toBe("msg-1");
    expect((results[1] as (typeof results)[0]).id).toBe("msg-2");
  });

  test("returns empty for no matches", () => {
    insertMessage("msg-1", "ch-1", "user-1", "alice", "hello", 1000);

    const results = getFollowUpMessages(db, "ch-1", 5000, new Set(), "bot-1");
    expect(results).toHaveLength(0);
  });

  test("only returns messages from specified channel", () => {
    insertMessage("msg-1", "ch-1", "user-1", "alice", "in ch-1", 2000);
    insertMessage("msg-2", "ch-2", "user-1", "alice", "in ch-2", 3000);

    const results = getFollowUpMessages(db, "ch-1", 1000, new Set(), "bot-1");
    expect(results).toHaveLength(1);
    expect((results[0] as (typeof results)[0]).id).toBe("msg-1");
  });

  test("excludes synthetic messages", () => {
    insertMessage("msg-1", "ch-1", "user-1", "alice", "real", 2000, false, false);
    insertMessage("msg-2", "ch-1", "bot-1", "bot", "Event: Thread created", 3000, true, true);

    const results = getFollowUpMessages(db, "ch-1", 1000, new Set(), "bot-1");
    expect(results).toHaveLength(1);
    expect((results[0] as (typeof results)[0]).id).toBe("msg-1");
  });

  test("detects isMention when content contains bot mention", () => {
    insertMessage("msg-1", "ch-1", "user-1", "alice", "hey <@bot-1> help", 2000);
    insertMessage("msg-2", "ch-1", "user-2", "bob", "just chatting", 3000);

    const results = getFollowUpMessages(db, "ch-1", 1000, new Set(), "bot-1");
    expect(results).toHaveLength(2);
    expect((results[0] as (typeof results)[0]).isMention).toBe(true);
    expect((results[1] as (typeof results)[0]).isMention).toBe(false);
  });

  test("includes bot messages in results", () => {
    insertMessage("msg-1", "ch-1", "bot-1", "bot", "bot reply", 2000, true);
    insertMessage("msg-2", "ch-1", "user-1", "alice", "user msg", 3000, false);

    const results = getFollowUpMessages(db, "ch-1", 1000, new Set(), "bot-1");
    expect(results).toHaveLength(2);
    expect((results[0] as (typeof results)[0]).isBot).toBe(true);
    expect((results[1] as (typeof results)[0]).isBot).toBe(false);
  });

  test("returns correct field mapping", () => {
    insertMessage("msg-1", "ch-1", "user-42", "alice", "test content", 5000);

    const results = getFollowUpMessages(db, "ch-1", 1000, new Set(), "bot-1");
    expect(results).toHaveLength(1);
    const msg = results[0] as (typeof results)[0];
    expect(msg.id).toBe("msg-1");
    expect(msg.authorUsername).toBe("alice");
    expect(msg.userId).toBe("user-42");
    expect(msg.content).toBe("test content");
    expect(msg.createdAt).toBe(5000);
    expect(msg.isBot).toBe(false);
    expect(msg.isMention).toBe(false);
  });
});
