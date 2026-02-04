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
    imageIds: [],
    captions: [],
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
  imageCaptioningEnabled: false,
  replyQuoteChars: 80,
};

function makeDeps(db: Database): ReplyFallbackDeps {
  return {
    db,
    guildId: "g1",
    channelId: "c1",
    fetchDiscordMessage: () => Promise.resolve(null),
    enqueueEmbedding: () => Promise.resolve(),
    processImage: () => Promise.resolve(),
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
    expect(result.newerText).toContain("[@alice]: hi");
  });

  test("single message goes to newer slice", async () => {
    const m1 = msg({ id: "1", content: "first", timestamp: 1000 });
    const latest = msg({ id: "100", content: "latest", timestamp: 9000 });
    const result = await processHistory([m1], latest, defaultConfig, deps);

    expect(result.olderText).toBe("");
    expect(result.newerText).toStartWith("## Chat History\n");
    expect(result.newerText).toContain("[@alice]: first");
    expect(result.newerText).toContain("[@alice]: latest");
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
    // Date stamps use [DATE ...] format
    expect(result.olderText).toContain("[DATE");
    expect(result.newerText).toStartWith("## Chat History\n");
  });

  test("formatted lines use [@author]: content grammar", async () => {
    const m1 = msg({ id: "1", author: "bob", content: "yo", timestamp: 1000 });
    const latest = msg({ id: "100", content: "sup", timestamp: 9000 });
    const result = await processHistory([m1], latest, defaultConfig, deps);

    expect(result.newerText).toContain("[@bob]: yo");
    expect(result.newerText).toContain("[@alice]: sup");
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

    expect(result.newerText).toContain("ReplyMsgID: 1");
    expect(result.newerText).toContain("to @bob");
  });

  test("messages split correctly between older and newer with controlled config", async () => {
    // windowSize=2, trimTarget=5 → olderCount=3
    // 5 messages → older gets 3, newer gets 2
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

    // Older should have first 3 messages
    expect(result.olderText).toContain("content-0");
    expect(result.olderText).toContain("content-1");
    expect(result.olderText).toContain("content-2");
    expect(result.olderText).not.toContain("content-3");

    // Newer should have last 2 + latestUserMessage
    expect(result.newerText).toContain("content-3");
    expect(result.newerText).toContain("content-4");
    expect(result.newerText).toContain("latest");
    expect(result.newerText).not.toContain("content-2");
  });

  test("newer slice includes date stamps when temporal gaps exist", async () => {
    // Two messages 10 minutes apart in newer slice should get separate date stamps
    const m1 = msg({ id: "1", content: "first", timestamp: 1000 });
    const m2 = msg({ id: "2", content: "second", timestamp: 1000 + 10 * 60_000 }); // 10 min later
    const latest = msg({ id: "100", content: "last", timestamp: 1000 + 20 * 60_000 }); // 20 min later

    const result = await processHistory([m1, m2], latest, defaultConfig, deps);

    // Should have date stamps in newer slice (>= 5 min gaps)
    expect(result.newerText).toContain("[DATE");
    // Count date stamps - should be 3 (one for each message with >= 5 min gap)
    const dateMatches = result.newerText.match(/\[DATE/g);
    expect(dateMatches?.length).toBe(3);
  });

  test("newer slice has single date stamp when messages are close together", async () => {
    // Messages within 5 minutes should share a date stamp
    const m1 = msg({ id: "1", content: "first", timestamp: 1000 });
    const m2 = msg({ id: "2", content: "second", timestamp: 1000 + 2 * 60_000 }); // 2 min later
    const latest = msg({ id: "100", content: "last", timestamp: 1000 + 4 * 60_000 }); // 4 min later

    const result = await processHistory([m1, m2], latest, defaultConfig, deps);

    // Should have only one date stamp (all within 5 min of first)
    expect(result.newerText).toContain("[DATE");
    const dateMatches = result.newerText.match(/\[DATE/g);
    expect(dateMatches?.length).toBe(1);
  });
});
