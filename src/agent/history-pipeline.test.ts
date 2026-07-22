import { test, expect, describe, beforeEach } from "bun:test";
import { createDatabase, type Database } from "../db/database.ts";
import { processHistory } from "./history-pipeline.ts";
import type { HistoryMessage } from "./history-types.ts";
import type { ReplyFallbackDeps } from "./reply-target-fallback.ts";
import { OLDER_LEGEND } from "./history-formatting.ts";

function msg(overrides?: Partial<HistoryMessage>): HistoryMessage {
  return {
    id: "1",
    author: "alice",
    authorId: "uid-alice",
    content: "hello",
    isBot: false,
    timestamp: 1000,
    replyToId: null,
    hasEmbeds: false,
    isSynthetic: false,
    relatedThreadId: null,
    ...overrides,
  };
}

const defaultConfig = {
  trim: {
    trimTrigger: 150,
    trimTarget: 100,
    windowSize: 30,
    messageCharLimit: 500,
    replyQuoteChars: 80,
  },
  mergeMessageGapSeconds: 120,
  timezone: "UTC",
  replyQuoteChars: 80,
};

function makeDeps(db: Database): ReplyFallbackDeps {
  return {
    db,
    guildId: "g1",
    channelId: "c1",
    fetchDiscordMessage: () => Promise.resolve(null),
  };
}

describe("processHistory", () => {
  let db: Database;
  let deps: ReplyFallbackDeps;

  beforeEach(() => {
    db = createDatabase(":memory:");
    deps = makeDeps(db);
  });

  test("empty history returns newerText with latestUserMessage only", async () => {
    const latest = msg({ id: "100", content: "hi", timestamp: 9000 });
    const result = await processHistory([], latest, defaultConfig, deps);

    expect(result.olderText).toBe("");
    expect(result.newerText).toStartWith("## Chat History\n");
    expect(result.newerText).toContain("[@alice (MsgID: 100)]: hi");
    expect(result.newerText).not.toContain("oldest_visible_message_id");
  });

  test("single message goes to newer slice", async () => {
    const m1 = msg({ id: "1", content: "first", timestamp: 1000 });
    const latest = msg({ id: "100", content: "latest", timestamp: 9000 });
    const result = await processHistory([m1], latest, defaultConfig, deps);

    expect(result.olderText).toBe("");
    expect(result.newerText).toStartWith("## Chat History\n");
    expect(result.newerText).toContain("History cursor: oldest_visible_message_id=1");
    expect(result.newerText).toContain("[@alice (MsgID: 1)]: first");
    expect(result.newerText).toContain("[@alice (MsgID: 100)]: latest");
  });

  test("can render current chronological history without appending a synthetic latest message", async () => {
    const messages = [
      msg({ id: "a", author: "alice", authorId: "uid-alice", content: "first ping", timestamp: 1000 }),
      msg({ id: "b", author: "bob", authorId: "uid-bob", content: "second ping", timestamp: 2000, historyAnnotations: ["<trigger>"] }),
      msg({ id: "bot-a", author: "2b", authorId: "bot-1", content: "reply to first", isBot: true, timestamp: 3000, replyToId: "a" }),
    ];
    const result = await processHistory(messages, null, defaultConfig, deps);

    expect(result.newerText.indexOf("MsgID: a")).toBeLessThan(result.newerText.indexOf("MsgID: b"));
    expect(result.newerText.indexOf("MsgID: b")).toBeLessThan(result.newerText.indexOf("MsgID: bot-a"));
    expect(result.newerText).toContain("[@bob (MsgID: b; <trigger>)]: second ping");
  });

  test("marks a merged current-turn span without removing message breaks", async () => {
    const messages = [
      msg({ id: "a", content: "first chunk", timestamp: 1000 }),
      msg({ id: "b", content: "second chunk", timestamp: 2000 }),
    ];
    const result = await processHistory(messages, null, {
      ...defaultConfig,
      triggerMessageIds: ["a", "b"],
    }, deps);

    expect(result.newerText).toContain(
      "[@alice (MsgIDs: [a, b]; <trigger>)]: first chunk [msg-break] second chunk",
    );
  });

  test("does not merge a trigger span into adjacent non-trigger history", async () => {
    const messages = [
      msg({ id: "before", content: "earlier message", timestamp: 1000 }),
      msg({ id: "a", content: "first trigger chunk", timestamp: 2000 }),
      msg({ id: "b", content: "second trigger chunk", timestamp: 3000 }),
    ];
    const result = await processHistory(messages, null, {
      ...defaultConfig,
      triggerMessageIds: ["a", "b"],
    }, deps);

    expect(result.newerText).toContain("[@alice (MsgID: before)]: earlier message");
    expect(result.newerText).toContain(
      "[@alice (MsgIDs: [a, b]; <trigger>)]: first trigger chunk [msg-break] second trigger chunk",
    );
  });

  test("newer slice includes current display names for authors and reply targets", async () => {
    const m1 = msg({ id: "1", author: "alice", authorId: "uid-alice", content: "first", timestamp: 1000 });
    const latest = msg({
      id: "100",
      author: "bob",
      authorId: "uid-bob",
      content: "reply",
      timestamp: 9000,
      replyToId: "1",
    });
    const result = await processHistory(
      [m1],
      latest,
      {
        ...defaultConfig,
        displayNamesByUserId: new Map([
          ["uid-alice", "Alice W"],
          ["uid-bob", "Bob X"],
        ]),
      },
      deps,
    );

    expect(result.olderText).toBe("");
    expect(result.newerText).toContain("Parenthesized names are current Discord display names");
    expect(result.newerText).toContain("[@alice (Alice W) (MsgID: 1)]: first");
    expect(result.newerText).toContain("[@bob (Bob X) to @alice (Alice W) (MsgID: 100)]: reply");
  });

  test("enough messages produce older slice with OLDER_LEGEND and date stamps", async () => {
    // With windowSize=30, trimTarget=100: olderCount=70
    // Need >30 messages so some go to older slice
    // Use small config: windowSize=3, trimTarget=10, so olderCount=7
    const config = {
      ...defaultConfig,
      trim: { ...defaultConfig.trim, trimTarget: 10, windowSize: 3, trimTrigger: 20 },
    };

    const messages: HistoryMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(
        msg({
          id: String(i + 1),
          content: `msg-${i}`,
          timestamp: 1000 + i * 600_000, // 10 min apart to get date stamps
        }),
      );
    }
    const latest = msg({ id: "100", content: "latest", timestamp: 1000 + 8 * 600_000 });

    const result = await processHistory(messages, latest, config, deps);

    expect(result.olderText).toStartWith("## Chat History \u2014 Older\n");
    expect(result.olderText).toContain(OLDER_LEGEND);
    expect(result.olderText).toContain("[1970-01-01");
    expect(result.newerText).toStartWith("## Chat History\n");
    expect(result.newerText).toContain("History cursor: oldest_visible_message_id=1");
  });

  test("older cached text remains stable while recent history grows inside a chunk", async () => {
    const config = {
      ...defaultConfig,
      trim: { ...defaultConfig.trim, trimTrigger: 400, trimTarget: 300, windowSize: 50 },
    };
    const latest = msg({ id: "latest", content: "latest", timestamp: 1000 + 80 * 600_000 });
    const baseMessages = Array.from({ length: 70 }, (_, i) => msg({
      id: String(i + 1),
      content: `msg-${i}`,
      timestamp: 1000 + i * 600_000,
    }));
    const grownMessages = [
      ...baseMessages,
      msg({ id: "71", content: "extra-1", timestamp: 1000 + 70 * 600_000 }),
      msg({ id: "72", content: "extra-2", timestamp: 1000 + 71 * 600_000 }),
    ];

    const before = await processHistory(baseMessages, latest, config, deps);
    const after = await processHistory(grownMessages, latest, config, deps);

    expect(before.olderText).toBe(after.olderText);
    expect(before.olderText).toContain("msg-0");
    expect(before.olderText).toContain("msg-49");
    expect(before.olderText).not.toContain("msg-50");
    expect(after.newerText).toContain("extra-2");
  });

  test("newer formatted lines include MsgID metadata", async () => {
    const m1 = msg({ id: "1", author: "bob", content: "yo", timestamp: 1000 });
    const latest = msg({ id: "100", content: "sup", timestamp: 9000 });
    const result = await processHistory([m1], latest, defaultConfig, deps);

    expect(result.newerText).toContain("[@bob (MsgID: 1)]: yo");
    expect(result.newerText).toContain("[@alice (MsgID: 100)]: sup");
  });

  test("merged messages contain [msg-break]", async () => {
    // Two messages by same author within merge gap (120s = 120000ms)
    const m1 = msg({ id: "1", content: "part one", timestamp: 1000 });
    const m2 = msg({ id: "2", content: "part two", timestamp: 50_000 }); // 49s gap
    const latest = msg({ id: "100", author: "bob", authorId: "uid-bob", content: "ok", timestamp: 200_000 });

    const result = await processHistory([m1, m2], latest, defaultConfig, deps);

    expect(result.newerText).toContain("[msg-break]");
    expect(result.newerText).toContain("part one [msg-break] part two");
  });

  test("newer messages are NOT trimmed", async () => {
    const longContent = "a".repeat(600);
    const m1 = msg({ id: "42", content: longContent, timestamp: 1000 });
    const latest = msg({ id: "100", content: "hi", timestamp: 9000 });

    const result = await processHistory([m1], latest, defaultConfig, deps);

    // Newer slice should preserve full content, no trimming marker
    expect(result.newerText).not.toContain("[trimmed");
    expect(result.newerText).toContain("a".repeat(600));
  });

  test("older messages ARE trimmed", async () => {
    // windowSize=2, trimTarget=5 → olderCount=3
    const config = {
      ...defaultConfig,
      trim: { ...defaultConfig.trim, trimTarget: 5, windowSize: 2, trimTrigger: 20, messageCharLimit: 50 },
    };

    const messages: HistoryMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(
        msg({
          id: String(i + 1),
          author: `user${i}`,
          authorId: `uid-${i}`,
          content: i === 0 ? "x".repeat(100) : `short-${i}`,
          timestamp: 1000 + i * 600_000,
        }),
      );
    }
    const latest = msg({ id: "100", content: "latest", timestamp: 1000 + 5 * 600_000 });

    const result = await processHistory(messages, latest, config, deps);

    // First message (in older slice) should be trimmed
    expect(result.olderText).toContain("[trimmed 50 chars; MsgID: 1]");
  });

  test("reply metadata present when replyToId points to message in history", async () => {
    const m1 = msg({ id: "1", author: "bob", authorId: "uid-bob", content: "hello there", timestamp: 1000 });
    const m2 = msg({ id: "2", content: "replying", timestamp: 2000, replyToId: "1" });
    const latest = msg({ id: "100", content: "ok", timestamp: 9000 });

    const result = await processHistory([m1, m2], latest, defaultConfig, deps);

    expect(result.newerText).toContain("to @bob");
    expect(result.newerText).not.toContain("ReplyMsgID");
  });

  test("bot reply metadata is shown when stored replyToId points to a user message", async () => {
    const user = msg({ id: "1", author: "bbonvi", authorId: "uid-bbonvi", content: "we won", timestamp: 1000 });
    const bot = msg({ id: "2", author: "2B", authorId: "bot-id", isBot: true, content: "On whom?", timestamp: 2000, replyToId: "1" });
    const latest = msg({ id: "100", content: "support", timestamp: 9000 });

    const result = await processHistory([user, bot], latest, defaultConfig, deps);

    expect(result.newerText).toContain("[@2B to @bbonvi (MsgID: 2)]: On whom?");
  });

  test("latest user reply resolves when target is second message in merged bot row", async () => {
    const m1 = msg({ id: "bot-1", author: "bot", authorId: "bot-id", isBot: true, content: "first bot chunk", timestamp: 1000 });
    const m2 = msg({ id: "bot-2", author: "bot", authorId: "bot-id", isBot: true, content: "second bot chunk", timestamp: 2000 });
    const latest = msg({ id: "user-1", author: "user", authorId: "user-id", content: "replying", timestamp: 3000, replyToId: "bot-2" });

    const result = await processHistory([m1, m2], latest, defaultConfig, deps);

    expect(result.newerText).toContain("[@bot (MsgIDs: [bot-1, bot-2])]: first bot chunk [msg-break] second bot chunk");
    expect(result.newerText).toContain("[@user to @bot (MsgID: user-1)]: replying");
    expect(result.newerText).not.toContain("MissingTarget");
  });

  test("messages split correctly between older and newer with controlled config", async () => {
    // windowSize=2, trimTarget=5 → olderCount=3, complete older chunk=2
    // 5 messages → older gets 2, newer gets 3
    const config = {
      ...defaultConfig,
      trim: { ...defaultConfig.trim, trimTarget: 5, windowSize: 2, trimTrigger: 20 },
    };

    const messages: HistoryMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(
        msg({
          id: String(i + 1),
          author: `user${i}`,
          authorId: `uid-${i}`,
          content: `content-${i}`,
          timestamp: 1000 + i * 600_000,
        }),
      );
    }
    const latest = msg({ id: "100", content: "latest", timestamp: 1000 + 5 * 600_000 });

    const result = await processHistory(messages, latest, config, deps);

    // Older should have first 2 messages
    expect(result.olderText).toContain("content-0");
    expect(result.olderText).toContain("content-1");
    expect(result.olderText).not.toContain("content-2");

    // Newer should have last 3 + latestUserMessage
    expect(result.newerText).toContain("content-2");
    expect(result.newerText).toContain("content-3");
    expect(result.newerText).toContain("content-4");
    expect(result.newerText).toContain("latest");
    expect(result.newerText).not.toContain("content-1");
  });

  test("returns visible human users newest first across older and newer history", async () => {
    const config = {
      ...defaultConfig,
      trim: { ...defaultConfig.trim, trimTarget: 5, windowSize: 2, trimTrigger: 20 },
    };
    const messages = [
      msg({ id: "1", author: "old", authorId: "uid-old", content: "old", timestamp: 1000 }),
      msg({ id: "2", author: "middle", authorId: "uid-middle", content: "middle", timestamp: 2000 }),
      msg({ id: "3", author: "bot", authorId: "bot-id", isBot: true, content: "bot", timestamp: 3000 }),
      msg({ id: "4", author: "old", authorId: "uid-old", content: "old again", timestamp: 4000 }),
    ];
    const latest = msg({ id: "100", author: "latest", authorId: "uid-latest", content: "latest", timestamp: 5000 });

    const result = await processHistory(messages, latest, config, deps);

    expect(result.visibleUserIds).toEqual(["uid-latest", "uid-old", "uid-middle"]);
  });

  test("newer slice includes date stamps when temporal gaps exist", async () => {
    // Two messages 10 minutes apart in newer slice should get separate date stamps
    const m1 = msg({ id: "1", content: "first", timestamp: 1000 });
    const m2 = msg({ id: "2", content: "second", timestamp: 1000 + 10 * 60_000 }); // 10 min later
    const latest = msg({ id: "100", content: "last", timestamp: 1000 + 20 * 60_000 }); // 20 min later

    const result = await processHistory([m1, m2], latest, defaultConfig, deps);

    expect(result.newerText).toContain("[1970-01-01]");
    const timeMatches = result.newerText.match(/\[\d{2}:\d{2}\]/g);
    expect(timeMatches?.length).toBe(3);
  });

  test("newer slice stamps minute-scale temporal gaps", async () => {
    // Recent history is uncached, so it can afford more frequent time markers.
    const m1 = msg({ id: "1", content: "first", timestamp: 1000 });
    const m2 = msg({ id: "2", content: "second", timestamp: 1000 + 3 * 60_000 }); // 3 min later
    const latest = msg({ id: "100", content: "last", timestamp: 1000 + 6 * 60_000 }); // 6 min later

    const result = await processHistory([m1, m2], latest, defaultConfig, deps);

    // Should have one time marker per message because each gap is >= 1 min.
    expect(result.newerText).toContain("[1970-01-01]");
    const timeMatches = result.newerText.match(/\[\d{2}:\d{2}\]/g);
    expect(timeMatches?.length).toBe(3);
  });

  test("newer slice uses standalone date and time markers without relative age", async () => {
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    const m1 = msg({ id: "1", content: "first", timestamp: base });
    const latest = msg({ id: "100", content: "last", timestamp: base + 10 * 60 * 60_000 });

    const result = await processHistory([m1], latest, defaultConfig, deps, latest.timestamp);

    expect(result.newerText).toContain("[2026-01-01]\n[12:00]");
    expect(result.newerText).toContain("[22:00]");
    expect(result.newerText).not.toContain("ago]");
  });
});
