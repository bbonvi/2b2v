import { test, expect, describe } from "bun:test";
import { normalizeWhitespace, trimMessageContent, trimMessages } from "./history-trimming.ts";
import type { HistoryMessage } from "./history-types.ts";

function msg(id: string, content: string): HistoryMessage {
  return {
    id,
    author: "alice",
    authorId: "uid-alice",
    content,
    isBot: false,
    timestamp: 1000,
    replyToId: null,
    hasEmbeds: false,
    isSynthetic: false,
    relatedThreadId: null,
  };
}

describe("normalizeWhitespace", () => {
  test("collapses newlines to space", () => {
    expect(normalizeWhitespace("a\nb\nc")).toBe("a b c");
  });

  test("collapses tabs to space", () => {
    expect(normalizeWhitespace("a\tb")).toBe("a b");
  });

  test("collapses carriage returns", () => {
    expect(normalizeWhitespace("a\r\nb")).toBe("a b");
  });

  test("leaves regular spaces unchanged", () => {
    expect(normalizeWhitespace("a b")).toBe("a b");
  });
});

describe("trimMessageContent", () => {
  test("does not trim content within limit", () => {
    const m = msg("1", "hello");
    const result = trimMessageContent(m, 200);
    expect(result.content).toBe("hello");
  });

  test("does not trim content at exact limit", () => {
    const content = "x".repeat(200);
    const result = trimMessageContent(msg("1", content), 200);
    expect(result.content).toBe(content);
  });

  test("trims content exceeding limit with marker", () => {
    const content = "x".repeat(250);
    const result = trimMessageContent(msg("42", content), 200);
    expect(result.content).toBe("x".repeat(200) + "… [trimmed 50 chars; MsgID: 42]");
  });

  test("normalizes whitespace before trimming", () => {
    // 10 chars with newlines → after normalization, still measures correctly
    const content = "abcd\nefgh\nijkl"; // normalized: "abcd efgh ijkl" = 14 chars
    const result = trimMessageContent(msg("5", content), 10);
    expect(result.content).toBe("abcd efgh … [trimmed 4 chars; MsgID: 5]");
  });

  test("preserves reply metadata (replyToId unchanged)", () => {
    const m = msg("1", "x".repeat(300));
    m.replyToId = "99";
    const result = trimMessageContent(m, 200);
    expect(result.replyToId).toBe("99");
  });

  test("does not mutate input", () => {
    const m = msg("1", "x".repeat(300));
    const origContent = m.content;
    trimMessageContent(m, 200);
    expect(m.content).toBe(origContent);
  });

  test("deterministic for identical inputs", () => {
    const m = msg("1", "x".repeat(300));
    const r1 = trimMessageContent(m, 200);
    const r2 = trimMessageContent(m, 200);
    expect(r1.content).toBe(r2.content);
  });
});

describe("trimMessages", () => {
  test("trims all messages in array", () => {
    const msgs = [
      msg("1", "x".repeat(300)),
      msg("2", "short"),
      msg("3", "y".repeat(250)),
    ];
    const result = trimMessages(msgs, 200);
    expect(result).toHaveLength(3);
    expect(result[0]?.content).toContain("trimmed");
    expect(result[1]?.content).toBe("short");
    expect(result[2]?.content).toContain("trimmed");
  });

  test("returns new array", () => {
    const msgs = [msg("1", "hello")];
    const result = trimMessages(msgs, 200);
    expect(result).not.toBe(msgs);
  });
});
