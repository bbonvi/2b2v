import { describe, expect, test } from "bun:test";
import { resolveReplies } from "./history-replies.ts";
import type { HistoryMessage } from "./history-types.ts";

function message(id: string, overrides: Partial<HistoryMessage> = {}): HistoryMessage {
  return {
    id,
    author: `user-${id}`,
    authorId: `uid-${id}`,
    content: `message ${id}`,
    isBot: false,
    timestamp: Number(id),
    replyToId: null,
    hasEmbeds: false,
    isSynthetic: false,
    relatedThreadId: null,
    ...overrides,
  };
}

describe("resolveReplies", () => {
  test("omits a quote for the immediately previous message", () => {
    const first = message("1");
    const second = message("2", { replyToId: "1" });
    const result = resolveReplies({ older: [], newer: [first, second], latestUserMessage: null, replyQuoteChars: 100 });
    expect(result.newer.get("2")).toMatchObject({ targetAuthor: "user-1", quote: null, missingTarget: false });
  });

  test("quotes non-adjacent targets and preserves lazy assets", () => {
    const target = message("1", { assets: [
      { id: 7, kind: "image", sourceKind: "attachment", filename: "cat.png", contentType: "image/png", size: 1, width: 1, height: 1, durationSeconds: null },
    ] });
    const result = resolveReplies({
      older: [],
      newer: [target, message("2"), message("3", { replyToId: "1" })],
      latestUserMessage: null,
      replyQuoteChars: 100,
    });
    expect(result.newer.get("3")).toMatchObject({
      targetAuthor: "user-1",
      quote: "message 1",
      replyAssets: [{ id: 7 }],
    });
  });

  test("resolves merged message aliases", () => {
    const target = message("1", { mergedMessageIds: ["1", "2"] });
    const result = resolveReplies({
      older: [],
      newer: [target, message("3", { replyToId: "2" })],
      latestUserMessage: null,
      replyQuoteChars: 100,
    });
    expect(result.newer.get("3")).toMatchObject({ targetAuthor: "user-1", missingTarget: false });
  });

  test("omits a quote only for the last message in a merged previous row", () => {
    const target = message("1", {
      content: "first [msg-break] second",
      mergedMessageIds: ["1", "2"],
    });
    const result = resolveReplies({
      older: [],
      newer: [target, message("3", { replyToId: "2" })],
      latestUserMessage: null,
      replyQuoteChars: 100,
      normalizedContentMap: new Map([
        ["1", "first"],
        ["2", "second"],
      ]),
      previousMessageIdByMessageId: new Map([["3", "2"]]),
    });

    expect(result.newer.get("3")).toMatchObject({ quote: null });
  });

  test("quotes only the selected earlier message from a merged previous row", () => {
    const target = message("1", {
      content: "first [msg-break] second",
      mergedMessageIds: ["1", "2"],
    });
    const result = resolveReplies({
      older: [],
      newer: [target, message("3", { replyToId: "1" })],
      latestUserMessage: null,
      replyQuoteChars: 100,
      normalizedContentMap: new Map([
        ["1", "first"],
        ["2", "second"],
      ]),
      previousMessageIdByMessageId: new Map([["3", "2"]]),
    });

    expect(result.newer.get("3")).toMatchObject({ quote: "first" });
  });

  test("omits a quote across the older and newer slice boundary", () => {
    const target = message("1");
    const reply = message("2", { replyToId: "1" });
    const result = resolveReplies({
      older: [target],
      newer: [reply],
      latestUserMessage: null,
      replyQuoteChars: 100,
      previousMessageIdByMessageId: new Map([["2", "1"]]),
    });

    expect(result.newer.get("2")).toMatchObject({ quote: null });
  });

  test("marks unavailable targets", () => {
    const result = resolveReplies({
      older: [],
      newer: [message("2", { replyToId: "999" })],
      latestUserMessage: null,
      replyQuoteChars: 100,
    });
    expect(result.newer.get("2")).toEqual({
      targetAuthor: "unknown",
      quote: null,
      replyMsgId: "999",
      missingTarget: true,
    });
  });

  test("keeps older replies unquoted and resolves fetched targets", () => {
    const target = message("1", { content: "fetched target" });
    const olderReply = message("2", { replyToId: "1" });
    const newerReply = message("3", { replyToId: "1" });
    const result = resolveReplies({
      older: [olderReply],
      newer: [newerReply],
      latestUserMessage: null,
      replyQuoteChars: 100,
      extraLookup: [target],
    });
    expect(result.older.get("2")).toMatchObject({ targetAuthor: "user-1", quote: null });
    expect(result.newer.get("3")).toMatchObject({ targetAuthor: "user-1", quote: "fetched target" });
  });

  test("normalizes and truncates quotes from untrimmed content", () => {
    const target = message("1", { content: "trimmed marker" });
    const result = resolveReplies({
      older: [],
      newer: [target, message("2"), message("3", { replyToId: "1" })],
      latestUserMessage: null,
      replyQuoteChars: 12,
      normalizedContentMap: new Map([["1", "original\nlong\tcontent"]]),
    });
    expect(result.newer.get("3")?.quote).toBe("original lon…");
  });

  test("resolves the detached latest user reply against the newer slice", () => {
    const latest = message("3", { replyToId: "1" });
    const result = resolveReplies({
      older: [],
      newer: [message("1"), message("2")],
      latestUserMessage: latest,
      replyQuoteChars: 100,
    });
    expect(result.latestUser).toMatchObject({ targetAuthor: "user-1", quote: "message 1" });
  });
});
