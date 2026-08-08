import { describe, expect, test } from "bun:test";
import type { ContextHistoryConfig } from "../config/types.ts";
import { sliceHistory, sortMessages } from "./history-slicing.ts";
import type { HistoryMessage } from "./history-types.ts";

function msg(id: string, timestamp: number): HistoryMessage {
  return {
    id,
    author: `user-${id}`,
    authorId: `uid-${id}`,
    content: `content-${id}`,
    isBot: false,
    timestamp,
    replyToId: null,
    hasEmbeds: false,
    isSynthetic: false,
    relatedThreadId: null,
  };
}

const config: ContextHistoryConfig = {
  retainedMessages: 8,
  recentMessages: 3,
  messageCharLimit: 200,
};

describe("sortMessages", () => {
  test("sorts by timestamp and then message ID without mutating input", () => {
    const messages = [msg("c", 200), msg("b", 100), msg("a", 100)];
    expect(sortMessages(messages).map((message) => message.id)).toEqual(["a", "b", "c"]);
    expect(messages.map((message) => message.id)).toEqual(["c", "b", "a"]);
  });
});

describe("sliceHistory", () => {
  test.each([
    { total: 0, older: 0, newer: 0, firstOlder: undefined },
    { total: 3, older: 0, newer: 3, firstOlder: undefined },
    { total: 6, older: 3, newer: 3, firstOlder: "0" },
    { total: 8, older: 5, newer: 3, firstOlder: "0" },
    { total: 10, older: 5, newer: 5, firstOlder: "0" },
    { total: 11, older: 5, newer: 3, firstOlder: "3" },
    { total: 12, older: 5, newer: 4, firstOlder: "3" },
    { total: 14, older: 5, newer: 3, firstOlder: "6" },
  ])("keeps a recent tail and rolls over only at batch boundaries: $total", ({ total, older, newer, firstOlder }) => {
    const result = sliceHistory(
      Array.from({ length: total }, (_, index) => msg(String(index), index)),
      config,
    );

    expect(result.older).toHaveLength(older);
    expect(result.newer).toHaveLength(newer);
    expect(result.older[0]?.id).toBe(firstOlder);
  });

  test("keeps the cached older prefix stable between rollovers", () => {
    const atEight = sliceHistory(Array.from({ length: 8 }, (_, index) => msg(String(index), index)), config);
    const atTen = sliceHistory(Array.from({ length: 10 }, (_, index) => msg(String(index), index)), config);

    expect(atEight.older.map((message) => message.id)).toEqual(atTen.older.map((message) => message.id));
  });
});
