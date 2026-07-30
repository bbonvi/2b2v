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
  test("omits ReplyMsgID for the immediately previous visible message", () => {
    const first = message("1");
    const second = message("2", { replyToId: "1" });
    const result = resolveReplies({ older: [], newer: [first, second], latestUserMessage: null });
    expect(result.newer.get("2")).toMatchObject({
      targetAuthor: "user-1",
      replyMsgId: null,
      missingTarget: false,
    });
  });

  test("includes ReplyMsgID for a non-adjacent target", () => {
    const result = resolveReplies({
      older: [],
      newer: [message("1"), message("2"), message("3", { replyToId: "1" })],
      latestUserMessage: null,
    });
    expect(result.newer.get("3")).toMatchObject({
      targetAuthor: "user-1",
      replyMsgId: "1",
      missingTarget: false,
    });
  });

  test("resolves merged message aliases", () => {
    const target = message("1", { mergedMessageIds: ["1", "2"] });
    const result = resolveReplies({
      older: [],
      newer: [target, message("3", { replyToId: "2" })],
      latestUserMessage: null,
    });
    expect(result.newer.get("3")).toMatchObject({
      targetAuthor: "user-1",
      replyMsgId: null,
      missingTarget: false,
    });
  });

  test("omits ReplyMsgID only for the last message in a merged previous row", () => {
    const target = message("1", {
      content: "first [msg-break] second",
      mergedMessageIds: ["1", "2"],
    });
    const result = resolveReplies({
      older: [],
      newer: [target, message("3", { replyToId: "2" })],
      latestUserMessage: null,
      previousMessageIdByMessageId: new Map([["3", "2"]]),
    });

    expect(result.newer.get("3")).toMatchObject({ replyMsgId: null });
  });

  test("identifies an earlier message from a merged previous row", () => {
    const target = message("1", {
      content: "first [msg-break] second",
      mergedMessageIds: ["1", "2"],
    });
    const result = resolveReplies({
      older: [],
      newer: [target, message("3", { replyToId: "1" })],
      latestUserMessage: null,
      previousMessageIdByMessageId: new Map([["3", "2"]]),
    });

    expect(result.newer.get("3")).toMatchObject({ replyMsgId: "1" });
  });

  test("omits ReplyMsgID across the older and newer slice boundary", () => {
    const target = message("1");
    const reply = message("2", { replyToId: "1" });
    const result = resolveReplies({
      older: [target],
      newer: [reply],
      latestUserMessage: null,
      previousMessageIdByMessageId: new Map([["2", "1"]]),
    });

    expect(result.newer.get("2")).toMatchObject({ replyMsgId: null });
  });

  test("marks unavailable targets", () => {
    const result = resolveReplies({
      older: [],
      newer: [message("2", { replyToId: "999" })],
      latestUserMessage: null,
    });
    expect(result.newer.get("2")).toEqual({
      targetAuthor: "unknown",
      replyMsgId: "999",
      missingTarget: true,
    });
  });

  test("identifies fetched targets outside visible history", () => {
    const target = message("1");
    const olderReply = message("2", { replyToId: "1" });
    const newerReply = message("3", { replyToId: "1" });
    const result = resolveReplies({
      older: [olderReply],
      newer: [newerReply],
      latestUserMessage: null,
      extraLookup: [target],
    });
    expect(result.older.get("2")).toMatchObject({ targetAuthor: "user-1", replyMsgId: "1" });
    expect(result.newer.get("3")).toMatchObject({ targetAuthor: "user-1", replyMsgId: "1" });
  });

  test("keeps ReplyMsgID when the immediate target is outside visible history", () => {
    const result = resolveReplies({
      older: [],
      newer: [message("2", { replyToId: "1" })],
      latestUserMessage: null,
      previousMessageIdByMessageId: new Map([["2", "1"]]),
      extraLookup: [message("1")],
    });
    expect(result.newer.get("2")).toMatchObject({ replyMsgId: "1" });
  });

  test("resolves the detached latest user reply against the newer slice", () => {
    const latest = message("3", { replyToId: "1" });
    const result = resolveReplies({
      older: [],
      newer: [message("1"), message("2")],
      latestUserMessage: latest,
    });
    expect(result.latestUser).toMatchObject({ targetAuthor: "user-1", replyMsgId: "1" });
  });
});
