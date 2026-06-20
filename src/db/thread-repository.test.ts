import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createDatabase, type Database } from "./database";
import {
  insertThread,
  upsertThread,
  getThread,
  updateThreadActivity,
  markBotParticipating,
  markThreadArchived,
  listThreadsForContext,
  getThreadMetadata,
} from "./thread-repository";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("insertThread", () => {
  test("inserts a thread with correct defaults", () => {
    insertThread(db, {
      threadId: "thread-1",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "msg-trigger",
      threadName: "Help Thread",
    });

    const row = getThread(db, "thread-1");
    expect(row).not.toBeNull();
    expect(row?.threadId).toBe("thread-1");
    expect(row?.guildId).toBe("guild-1");
    expect(row?.parentChatId).toBe("ch-1");
    expect(row?.starterMessageId).toBe("msg-trigger");
    expect(row?.threadName).toBe("Help Thread");
    expect(row?.messageCount).toBe(0);
    expect(row?.botParticipating).toBe(false);
    expect(row?.createdByBot).toBe(true);
    expect(row?.archivedAt).toBeNull();
    expect(row?.lastMessageId).toBeNull();
  });

  test("throws on duplicate thread_id", () => {
    insertThread(db, {
      threadId: "thread-dup",
      guildId: "g1",
      parentChatId: "c1",
      starterMessageId: "m1",
      threadName: "Thread",
    });

    expect(() =>
      insertThread(db, {
        threadId: "thread-dup",
        guildId: "g1",
        parentChatId: "c1",
        starterMessageId: "m2",
        threadName: "Thread 2",
      })
    ).toThrow();
  });
});

describe("getThread", () => {
  test("returns null for non-existent thread", () => {
    const row = getThread(db, "nonexistent");
    expect(row).toBeNull();
  });
});

describe("updateThreadActivity", () => {
  test("increments message count and updates last activity", () => {
    insertThread(db, {
      threadId: "thread-1",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "msg-trigger",
      threadName: "Thread",
    });

    const timestamp = Date.now() + 1000;
    const updated = updateThreadActivity(db, "thread-1", {
      lastActivityAt: timestamp,
      lastMessageId: "msg-1",
    });

    expect(updated).toBe(true);
    const row = getThread(db, "thread-1");
    expect(row?.messageCount).toBe(1);
    expect(row?.lastActivityAt).toBe(timestamp);
    expect(row?.lastMessageId).toBe("msg-1");
  });

  test("increments message count multiple times", () => {
    insertThread(db, {
      threadId: "thread-1",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "msg-trigger",
      threadName: "Thread",
    });

    const now = Date.now();
    updateThreadActivity(db, "thread-1", { lastActivityAt: now, lastMessageId: "msg-1" });
    updateThreadActivity(db, "thread-1", { lastActivityAt: now + 1, lastMessageId: "msg-2" });
    updateThreadActivity(db, "thread-1", { lastActivityAt: now + 2, lastMessageId: "msg-3" });

    const row = getThread(db, "thread-1");
    expect(row?.messageCount).toBe(3);
    expect(row?.lastMessageId).toBe("msg-3");
  });

  test("returns false for non-existent thread", () => {
    const updated = updateThreadActivity(db, "nonexistent", {
      lastActivityAt: Date.now(),
      lastMessageId: "msg-1",
    });
    expect(updated).toBe(false);
  });

  test("clears archived state when live activity is in an open thread", () => {
    insertThread(db, {
      threadId: "thread-1",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "msg-trigger",
      threadName: "Thread",
    });
    markThreadArchived(db, "thread-1", 1234);

    updateThreadActivity(db, "thread-1", {
      lastActivityAt: Date.now(),
      lastMessageId: "msg-1",
      archivedAt: null,
    });

    expect(getThread(db, "thread-1")?.archivedAt).toBeNull();
  });
});

describe("markBotParticipating", () => {
  test("sets bot_participating to true", () => {
    insertThread(db, {
      threadId: "thread-1",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "msg-trigger",
      threadName: "Thread",
    });

    expect(getThread(db, "thread-1")?.botParticipating).toBe(false);

    const updated = markBotParticipating(db, "thread-1");
    expect(updated).toBe(true);
    expect(getThread(db, "thread-1")?.botParticipating).toBe(true);
  });

  test("returns false for non-existent thread", () => {
    const updated = markBotParticipating(db, "nonexistent");
    expect(updated).toBe(false);
  });

  test("is idempotent", () => {
    insertThread(db, {
      threadId: "thread-1",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "msg-trigger",
      threadName: "Thread",
    });

    markBotParticipating(db, "thread-1");
    markBotParticipating(db, "thread-1");
    expect(getThread(db, "thread-1")?.botParticipating).toBe(true);
  });
});

describe("listThreadsForContext", () => {
  test("returns empty array when no threads exist", () => {
    const threads = listThreadsForContext(db, "ch-1");
    expect(threads).toEqual([]);
  });

  test("returns bot-created handoffs even before bot participation", () => {
    insertThread(db, {
      threadId: "thread-1",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "msg-1",
      threadName: "Participating Thread",
    });
    insertThread(db, {
      threadId: "thread-2",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "msg-2",
      threadName: "Non-Participating Thread",
    });

    markBotParticipating(db, "thread-1");

    const threads = listThreadsForContext(db, "ch-1");
    expect(threads).toHaveLength(2);
    const t = threads[0];
    if (t === undefined) throw new Error("unreachable");
    expect(threads.map((thread) => thread.threadId).sort()).toEqual(["thread-1", "thread-2"]);
  });

  test("does not return discovered non-bot threads until bot participates", () => {
    upsertThread(db, {
      threadId: "thread-1",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "thread-1",
      threadName: "Other Thread",
      createdByBot: false,
    });

    expect(listThreadsForContext(db, "ch-1")).toEqual([]);
    markBotParticipating(db, "thread-1");
    expect(listThreadsForContext(db, "ch-1")).toHaveLength(1);
  });

  test("filters by parent chat", () => {
    insertThread(db, {
      threadId: "thread-1",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "msg-1",
      threadName: "Thread in ch-1",
    });
    insertThread(db, {
      threadId: "thread-2",
      guildId: "guild-1",
      parentChatId: "ch-2",
      starterMessageId: "msg-2",
      threadName: "Thread in ch-2",
    });

    markBotParticipating(db, "thread-1");
    markBotParticipating(db, "thread-2");

    const threads = listThreadsForContext(db, "ch-1");
    expect(threads).toHaveLength(1);
    const t = threads[0];
    if (t === undefined) throw new Error("unreachable");
    expect(t.threadId).toBe("thread-1");
  });

  test("orders by last activity descending", () => {
    const now = Date.now();

    insertThread(db, {
      threadId: "thread-old",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "msg-1",
      threadName: "Old Thread",
    });
    insertThread(db, {
      threadId: "thread-new",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "msg-2",
      threadName: "New Thread",
    });

    markBotParticipating(db, "thread-old");
    markBotParticipating(db, "thread-new");

    updateThreadActivity(db, "thread-old", { lastActivityAt: now, lastMessageId: "m1" });
    updateThreadActivity(db, "thread-new", { lastActivityAt: now + 5000, lastMessageId: "m2" });

    const threads = listThreadsForContext(db, "ch-1");
    expect(threads).toHaveLength(2);
    const t0 = threads[0];
    const t1 = threads[1];
    if (t0 === undefined || t1 === undefined) throw new Error("unreachable");
    expect(t0.threadId).toBe("thread-new");
    expect(t1.threadId).toBe("thread-old");
  });

  test("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      insertThread(db, {
        threadId: `thread-${i}`,
        guildId: "guild-1",
        parentChatId: "ch-1",
        starterMessageId: `msg-${i}`,
        threadName: `Thread ${i}`,
      });
      markBotParticipating(db, `thread-${i}`);
    }

    const threads = listThreadsForContext(db, "ch-1", 3);
    expect(threads).toHaveLength(3);
  });

  test("returns correct fields", () => {
    const now = Date.now();
    insertThread(db, {
      threadId: "thread-1",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "msg-1",
      threadName: "Test Thread",
    });
    markBotParticipating(db, "thread-1");
    updateThreadActivity(db, "thread-1", { lastActivityAt: now + 1000, lastMessageId: "m1" });
    updateThreadActivity(db, "thread-1", { lastActivityAt: now + 2000, lastMessageId: "m2" });

    const threads = listThreadsForContext(db, "ch-1");
    expect(threads[0]).toEqual({
      threadId: "thread-1",
      threadName: "Test Thread",
      starterMessageId: "msg-1",
      messageCount: 2,
      lastActivityAt: now + 2000,
      lastMessageId: "m2",
      botParticipating: true,
      createdByBot: true,
      archivedAt: null,
    });
  });
});

describe("upsertThread", () => {
  test("inserts discovered non-bot thread metadata", () => {
    upsertThread(db, {
      threadId: "thread-live",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "thread-live",
      threadName: "Live Thread",
      createdByBot: false,
      messageCount: 3,
    });

    const row = getThread(db, "thread-live");
    expect(row?.createdByBot).toBe(false);
    expect(row?.messageCount).toBe(3);
  });

  test("preserves bot-created ownership on later live discovery", () => {
    insertThread(db, {
      threadId: "thread-1",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "msg-1",
      threadName: "Bot Thread",
    });

    upsertThread(db, {
      threadId: "thread-1",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "thread-1",
      threadName: "Renamed",
      createdByBot: false,
    });

    const row = getThread(db, "thread-1");
    expect(row?.threadName).toBe("Renamed");
    expect(row?.createdByBot).toBe(true);
  });
});

describe("markThreadArchived", () => {
  test("records archive time", () => {
    insertThread(db, {
      threadId: "thread-1",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "msg-1",
      threadName: "Thread",
    });

    expect(markThreadArchived(db, "thread-1", 1234)).toBe(true);
    expect(getThread(db, "thread-1")?.archivedAt).toBe(1234);
  });
});

describe("getThreadMetadata", () => {
  test("returns thread metadata", () => {
    insertThread(db, {
      threadId: "thread-1",
      guildId: "guild-1",
      parentChatId: "ch-1",
      starterMessageId: "msg-trigger",
      threadName: "Test Thread",
    });

    const metadata = getThreadMetadata(db, "thread-1");
    expect(metadata).not.toBeNull();
    expect(metadata?.parentChatId).toBe("ch-1");
    expect(metadata?.starterMessageId).toBe("msg-trigger");
    expect(metadata?.threadName).toBe("Test Thread");
    expect(metadata?.createdAt).toBeGreaterThan(0);
  });

  test("returns null for non-existent thread", () => {
    const metadata = getThreadMetadata(db, "nonexistent");
    expect(metadata).toBeNull();
  });
});
