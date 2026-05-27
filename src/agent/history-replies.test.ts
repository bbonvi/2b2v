import { test, expect, describe } from "bun:test";
import { resolveReplies } from "./history-replies.ts";
import type { HistoryMessage } from "./history-types.ts";
import type { ReplyContext } from "./history-formatting.ts";

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

describe("resolveReplies", () => {
  // --- Newer slice: immediate previous reply → no quote ---

  test("newer: reply to immediately previous message has no quote", () => {
    const m1 = msg({ id: "100", author: "alice", content: "first msg" });
    const m2 = msg({ id: "101", author: "bob", replyToId: "100", content: "reply" });
    const result = resolveReplies({
      older: [],
      newer: [m1, m2],
      latestUserMessage: null,
      replyQuoteChars: 50,
      captioningEnabled: false,
    });
    expect(result.newer.get("101")).toEqual<ReplyContext>({
      targetAuthor: "alice",
      quote: null,
      replyMsgId: "100",
      missingTarget: false,
      replyImageIds: [],
      replyCaptions: [],
    });
  });

  // --- Newer slice: reply to non-immediate → include quote ---

  test("newer: reply to non-immediate message includes quote", () => {
    const m1 = msg({ id: "100", author: "alice", content: "original text here" });
    const m2 = msg({ id: "101", author: "carol", content: "filler" });
    const m3 = msg({ id: "102", author: "bob", replyToId: "100", content: "reply" });
    const result = resolveReplies({
      older: [],
      newer: [m1, m2, m3],
      latestUserMessage: null,
      replyQuoteChars: 50,
      captioningEnabled: false,
    });
    expect(result.newer.get("102")).toEqual<ReplyContext>({
      targetAuthor: "alice",
      quote: "original text here",
      replyMsgId: "100",
      missingTarget: false,
      replyImageIds: [],
      replyCaptions: [],
    });
  });

  // --- Newer slice: reply to message in older slice → include quote ---

  test("newer: reply to message in older slice includes quote", () => {
    const o1 = msg({ id: "50", author: "dan", content: "old message content" });
    const n1 = msg({ id: "200", author: "bob", replyToId: "50", content: "reply" });
    const result = resolveReplies({
      older: [o1],
      newer: [n1],
      latestUserMessage: null,
      replyQuoteChars: 50,
      captioningEnabled: false,
    });
    expect(result.newer.get("200")).toEqual<ReplyContext>({
      targetAuthor: "dan",
      quote: "old message content",
      replyMsgId: "50",
      missingTarget: false,
      replyImageIds: [],
      replyCaptions: [],
    });
  });

  // --- Older slice: reply → no quote, include target author and ID ---

  test("older: reply includes target author and ID but no quote", () => {
    const o1 = msg({ id: "10", author: "alice", content: "old stuff" });
    const o2 = msg({ id: "11", author: "bob", replyToId: "10", content: "reply" });
    const result = resolveReplies({
      older: [o1, o2],
      newer: [],
      latestUserMessage: null,
      replyQuoteChars: 50,
      captioningEnabled: false,
    });
    expect(result.older.get("11")).toEqual<ReplyContext>({
      targetAuthor: "alice",
      quote: null,
      replyMsgId: "10",
      missingTarget: false,
      replyImageIds: [],
      replyCaptions: [],
    });
  });

  // --- Missing target ---

  test("missing target sets missingTarget flag", () => {
    const m1 = msg({ id: "200", author: "bob", replyToId: "999", content: "reply" });
    const result = resolveReplies({
      older: [],
      newer: [m1],
      latestUserMessage: null,
      replyQuoteChars: 50,
      captioningEnabled: false,
    });
    expect(result.newer.get("200")).toEqual<ReplyContext>({
      targetAuthor: "unknown",
      quote: null,
      replyMsgId: "999",
      missingTarget: true,
      replyImageIds: [],
      replyCaptions: [],
    });
  });

  // --- Quote truncation ---

  test("quote is truncated to replyQuoteChars", () => {
    const m1 = msg({ id: "100", author: "alice", content: "a".repeat(100) });
    const m2 = msg({ id: "101", author: "carol", content: "filler" });
    const m3 = msg({ id: "102", author: "bob", replyToId: "100", content: "reply" });
    const result = resolveReplies({
      older: [],
      newer: [m1, m2, m3],
      latestUserMessage: null,
      replyQuoteChars: 30,
      captioningEnabled: false,
    });
    const ctx = result.newer.get("102");
    expect(ctx?.quote).toBe("a".repeat(30) + "…");
  });

  test("quote not truncated when within limit", () => {
    const m1 = msg({ id: "100", author: "alice", content: "short" });
    const m2 = msg({ id: "101", author: "carol", content: "filler" });
    const m3 = msg({ id: "102", author: "bob", replyToId: "100", content: "reply" });
    const result = resolveReplies({
      older: [],
      newer: [m1, m2, m3],
      latestUserMessage: null,
      replyQuoteChars: 50,
      captioningEnabled: false,
    });
    expect(result.newer.get("102")?.quote).toBe("short");
  });

  // --- Reply target image metadata ---

  test("reply target image IDs propagated", () => {
    const m1 = msg({ id: "100", author: "alice", content: "pic", imageIds: [5, 6], captions: ["cat", "dog"] });
    const m2 = msg({ id: "101", author: "carol", content: "filler" });
    const m3 = msg({ id: "102", author: "bob", replyToId: "100", content: "reply" });
    const result = resolveReplies({
      older: [],
      newer: [m1, m2, m3],
      latestUserMessage: null,
      replyQuoteChars: 50,
      captioningEnabled: true,
    });
    const ctx = result.newer.get("102");
    expect(ctx?.replyImageIds).toEqual([5, 6]);
    expect(ctx?.replyCaptions).toEqual(["cat", "dog"]);
  });

  test("reply target captions empty when captioning disabled", () => {
    const m1 = msg({ id: "100", author: "alice", content: "pic", imageIds: [5], captions: ["cat"] });
    const m2 = msg({ id: "101", author: "carol", content: "filler" });
    const m3 = msg({ id: "102", author: "bob", replyToId: "100", content: "reply" });
    const result = resolveReplies({
      older: [],
      newer: [m1, m2, m3],
      latestUserMessage: null,
      replyQuoteChars: 50,
      captioningEnabled: false,
    });
    const ctx = result.newer.get("102");
    expect(ctx?.replyImageIds).toEqual([5]);
    expect(ctx?.replyCaptions).toEqual([]);
  });

  // --- No reply → not in map ---

  test("messages without replyToId are not in the map", () => {
    const m1 = msg({ id: "100", content: "hello" });
    const result = resolveReplies({
      older: [m1],
      newer: [],
      latestUserMessage: null,
      replyQuoteChars: 50,
      captioningEnabled: false,
    });
    expect(result.older.has("100")).toBe(false);
  });

  // --- Latest user message ---

  test("latest user message: reply to immediate previous in newer has no quote", () => {
    const n1 = msg({ id: "300", author: "carol", content: "hey" });
    const latest = msg({ id: "301", author: "user", replyToId: "300", content: "replying" });
    const result = resolveReplies({
      older: [],
      newer: [n1],
      latestUserMessage: latest,
      replyQuoteChars: 50,
      captioningEnabled: false,
    });
    expect(result.latestUser).toEqual<ReplyContext>({
      targetAuthor: "carol",
      quote: null,
      replyMsgId: "300",
      missingTarget: false,
      replyImageIds: [],
      replyCaptions: [],
    });
  });

  test("latest user message: reply to non-last newer message includes quote", () => {
    const n1 = msg({ id: "300", author: "carol", content: "target msg" });
    const n2 = msg({ id: "301", author: "dan", content: "filler" });
    const latest = msg({ id: "302", author: "user", replyToId: "300", content: "replying" });
    const result = resolveReplies({
      older: [],
      newer: [n1, n2],
      latestUserMessage: latest,
      replyQuoteChars: 50,
      captioningEnabled: false,
    });
    expect(result.latestUser?.quote).toBe("target msg");
  });

  test("latest user message: no reply → latestUser is null", () => {
    const latest = msg({ id: "400", author: "user", content: "just a message" });
    const result = resolveReplies({
      older: [],
      newer: [],
      latestUserMessage: latest,
      replyQuoteChars: 50,
      captioningEnabled: false,
    });
    expect(result.latestUser).toBeNull();
  });

  // --- Older slice: missing target still flagged ---

  test("older: missing target flagged", () => {
    const o1 = msg({ id: "10", author: "bob", replyToId: "999", content: "reply" });
    const result = resolveReplies({
      older: [o1],
      newer: [],
      latestUserMessage: null,
      replyQuoteChars: 50,
      captioningEnabled: false,
    });
    expect(result.older.get("10")?.missingTarget).toBe(true);
    expect(result.older.get("10")?.targetAuthor).toBe("unknown");
  });

  // --- Edge: reply to itself (degenerate) ---

  test("reply to self is treated as non-immediate (includes quote)", () => {
    const m1 = msg({ id: "100", author: "alice", replyToId: "100", content: "self-reply" });
    const result = resolveReplies({
      older: [],
      newer: [m1],
      latestUserMessage: null,
      replyQuoteChars: 50,
      captioningEnabled: false,
    });
    // Target is found (itself), but "immediately previous" check fails (no previous message)
    // so it includes a quote
    expect(result.newer.get("100")?.quote).toBe("self-reply");
  });

  // --- normalizedContentMap: pre-trimmed content for quotes ---

  test("normalizedContentMap overrides target content for quote extraction", () => {
    // Simulate: m1 has been trimmed in the slice, but original content is in the map
    const m1 = msg({ id: "100", author: "alice", content: "trimmed… [trimmed 50 chars; MsgID: 100]" });
    const m2 = msg({ id: "101", author: "carol", content: "filler" });
    const m3 = msg({ id: "102", author: "bob", replyToId: "100", content: "reply" });
    const contentMap = new Map([["100", "the original full content before trimming"]]);
    const result = resolveReplies({
      older: [],
      newer: [m1, m2, m3],
      latestUserMessage: null,
      replyQuoteChars: 50,
      captioningEnabled: false,
      normalizedContentMap: contentMap,
    });
    expect(result.newer.get("102")?.quote).toBe("the original full content before trimming");
  });

  test("normalizedContentMap falls back to target.content when ID not in map", () => {
    const m1 = msg({ id: "100", author: "alice", content: "fallback content" });
    const m2 = msg({ id: "101", author: "carol", content: "filler" });
    const m3 = msg({ id: "102", author: "bob", replyToId: "100", content: "reply" });
    const contentMap = new Map<string, string>(); // empty map
    const result = resolveReplies({
      older: [],
      newer: [m1, m2, m3],
      latestUserMessage: null,
      replyQuoteChars: 50,
      captioningEnabled: false,
      normalizedContentMap: contentMap,
    });
    expect(result.newer.get("102")?.quote).toBe("fallback content");
  });

  // --- Whitespace normalization in quotes ---

  test("quote content is whitespace-normalized", () => {
    const m1 = msg({ id: "100", author: "alice", content: "line1\nline2\ttab" });
    const m2 = msg({ id: "101", author: "carol", content: "filler" });
    const m3 = msg({ id: "102", author: "bob", replyToId: "100", content: "reply" });
    const result = resolveReplies({
      older: [],
      newer: [m1, m2, m3],
      latestUserMessage: null,
      replyQuoteChars: 50,
      captioningEnabled: false,
    });
    expect(result.newer.get("102")?.quote).toBe("line1 line2 tab");
  });

  test("newer: reply resolves via extraLookup for fetched reply targets", () => {
    // m1 is only in extraLookup (fetched from Discord, not in any slice)
    // m2 is in newer and replies to m1
    const m1 = msg({ id: "100", author: "alice", content: "the original message" });
    const m2 = msg({ id: "200", author: "bob", replyToId: "100", content: "reply to alice" });
    const result = resolveReplies({
      older: [],
      newer: [m2],
      latestUserMessage: null,
      replyQuoteChars: 80,
      captioningEnabled: false,
      extraLookup: [m1],
    });
    const ctx = result.newer.get("200");
    if (ctx === undefined) throw new Error("unreachable");
    expect(ctx.targetAuthor).toBe("alice");
    expect(ctx.quote).toBe("the original message");
    expect(ctx.missingTarget).toBe(false);
    expect(ctx.replyMsgId).toBe("100");
  });

  test("latest user reply resolves to merged previous message by component ID", () => {
    const merged = msg({
      id: "100",
      mergedMessageIds: ["100", "101"],
      author: "bot",
      content: "first [msg-break] second",
    });
    const latest = msg({ id: "200", author: "user", replyToId: "101", content: "replying" });
    const result = resolveReplies({
      older: [],
      newer: [merged],
      latestUserMessage: latest,
      replyQuoteChars: 80,
      captioningEnabled: false,
    });
    expect(result.latestUser).toEqual<ReplyContext>({
      targetAuthor: "bot",
      quote: null,
      replyMsgId: "101",
      missingTarget: false,
      replyImageIds: [],
      replyCaptions: [],
    });
  });
});
