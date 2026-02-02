import { test, expect, describe } from "bun:test";
import { mergeConsecutiveMessages } from "./history-merge.ts";
import type { HistoryMessage } from "./history-types.ts";

function msg(id: string, timestamp: number, overrides?: Partial<HistoryMessage>): HistoryMessage {
  return {
    id,
    author: "alice",
    authorId: "uid-alice",
    content: `content-${id}`,
    isBot: false,
    timestamp,
    replyToId: null,
    imageIds: [],
    captions: [],
    hasEmbeds: false,
    ...overrides,
  };
}

const GAP = 120; // seconds

describe("mergeConsecutiveMessages", () => {
  test("empty input returns empty", () => {
    expect(mergeConsecutiveMessages([], GAP)).toEqual([]);
  });

  test("single message returned as-is", () => {
    const result = mergeConsecutiveMessages([msg("1", 1000)], GAP);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("1");
  });

  test("merges two consecutive plain messages by same author within gap", () => {
    const msgs = [
      msg("1", 1000),
      msg("2", 1000 + 60_000), // 60s gap, within 120s
    ];
    const result = mergeConsecutiveMessages(msgs, GAP);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("content-1 [msg-break] content-2");
    expect(result[0]?.id).toBe("1"); // retains first message's ID
  });

  test("merges three consecutive messages", () => {
    const msgs = [
      msg("1", 1000),
      msg("2", 1000 + 30_000),
      msg("3", 1000 + 60_000),
    ];
    const result = mergeConsecutiveMessages(msgs, GAP);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("content-1 [msg-break] content-2 [msg-break] content-3");
  });

  test("does not merge messages from different authors", () => {
    const msgs = [
      msg("1", 1000),
      msg("2", 1000 + 30_000, { authorId: "uid-bob", author: "bob" }),
    ];
    const result = mergeConsecutiveMessages(msgs, GAP);
    expect(result).toHaveLength(2);
  });

  test("does not merge when gap exceeds threshold", () => {
    const msgs = [
      msg("1", 1000),
      msg("2", 1000 + 121_000), // 121s > 120s
    ];
    const result = mergeConsecutiveMessages(msgs, GAP);
    expect(result).toHaveLength(2);
  });

  test("does not merge reply messages", () => {
    const msgs = [
      msg("1", 1000),
      msg("2", 1000 + 30_000, { replyToId: "0" }),
    ];
    const result = mergeConsecutiveMessages(msgs, GAP);
    expect(result).toHaveLength(2);
  });

  test("does not merge messages with images", () => {
    const msgs = [
      msg("1", 1000),
      msg("2", 1000 + 30_000, { imageIds: [1] }),
    ];
    const result = mergeConsecutiveMessages(msgs, GAP);
    expect(result).toHaveLength(2);
  });

  test("does not merge messages with embeds", () => {
    const msgs = [
      msg("1", 1000),
      msg("2", 1000 + 30_000, { hasEmbeds: true }),
    ];
    const result = mergeConsecutiveMessages(msgs, GAP);
    expect(result).toHaveLength(2);
  });

  test("first message with images blocks merge even if second is plain", () => {
    const msgs = [
      msg("1", 1000, { imageIds: [1] }),
      msg("2", 1000 + 30_000),
    ];
    const result = mergeConsecutiveMessages(msgs, GAP);
    expect(result).toHaveLength(2);
  });

  test("collapses newlines in content to spaces", () => {
    const msgs = [
      msg("1", 1000, { content: "line1\nline2" }),
      msg("2", 1000 + 30_000, { content: "line3\tline4" }),
    ];
    const result = mergeConsecutiveMessages(msgs, GAP);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("line1 line2 [msg-break] line3 line4");
  });

  test("merges at exact gap boundary (equal)", () => {
    const msgs = [
      msg("1", 1000),
      msg("2", 1000 + 120_000), // exactly 120s
    ];
    const result = mergeConsecutiveMessages(msgs, GAP);
    expect(result).toHaveLength(1);
  });

  test("does not mutate input", () => {
    const msgs = [msg("1", 1000), msg("2", 1000 + 30_000)];
    const origContent = msgs[0]?.content;
    mergeConsecutiveMessages(msgs, GAP);
    expect(msgs[0]?.content).toBe(origContent);
    expect(msgs).toHaveLength(2);
  });

  test("mixed merge/no-merge sequence", () => {
    const msgs = [
      msg("1", 1000),                                        // merge with 2
      msg("2", 1000 + 30_000),                               // merge with 1
      msg("3", 1000 + 200_000, { authorId: "uid-bob", author: "bob" }), // different author
      msg("4", 1000 + 230_000, { authorId: "uid-bob", author: "bob" }), // merge with 3
    ];
    const result = mergeConsecutiveMessages(msgs, GAP);
    expect(result).toHaveLength(2);
    expect(result[0]?.content).toBe("content-1 [msg-break] content-2");
    expect(result[1]?.content).toBe("content-3 [msg-break] content-4");
  });
});
