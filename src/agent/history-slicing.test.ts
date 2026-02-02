import { test, expect, describe } from "bun:test";
import { sortMessages, sliceHistory } from "./history-slicing.ts";
import type { HistoryMessage } from "./history-types.ts";
import type { TrimConfig } from "../config/types.ts";

function msg(id: string, timestamp: number, overrides?: Partial<HistoryMessage>): HistoryMessage {
  return {
    id,
    author: `user-${id}`,
    authorId: `uid-${id}`,
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

const trim: TrimConfig = {
  trimTrigger: 10,
  trimTarget: 8,
  windowSize: 3,
  messageCharLimit: 200,
  replyQuoteChars: 50,
};

describe("sortMessages", () => {
  test("sorts by timestamp ascending", () => {
    const msgs = [msg("3", 300), msg("1", 100), msg("2", 200)];
    const sorted = sortMessages(msgs);
    expect(sorted.map((m) => m.id)).toEqual(["1", "2", "3"]);
  });

  test("breaks ties by message ID ascending", () => {
    const msgs = [msg("c", 100), msg("a", 100), msg("b", 100)];
    const sorted = sortMessages(msgs);
    expect(sorted.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  test("does not mutate input", () => {
    const msgs = [msg("2", 200), msg("1", 100)];
    const original = [...msgs];
    sortMessages(msgs);
    expect(msgs.map((m) => m.id)).toEqual(original.map((m) => m.id));
  });
});

describe("sliceHistory", () => {
  // olderCount = 8 - 3 = 5

  test("N == 0 → both slices empty", () => {
    const result = sliceHistory([], trim);
    expect(result.older).toEqual([]);
    expect(result.newer).toEqual([]);
  });

  test("N == 1 → newer has 1, older empty", () => {
    const result = sliceHistory([msg("1", 100)], trim);
    expect(result.older).toHaveLength(0);
    expect(result.newer).toHaveLength(1);
    expect(result.newer[0]?.id).toBe("1");
  });

  test("N < windowSize → all in newer", () => {
    const msgs = [msg("1", 100), msg("2", 200)];
    const result = sliceHistory(msgs, trim);
    expect(result.older).toHaveLength(0);
    expect(result.newer).toHaveLength(2);
  });

  test("N == windowSize → all in newer", () => {
    const msgs = [msg("1", 100), msg("2", 200), msg("3", 300)];
    const result = sliceHistory(msgs, trim);
    expect(result.older).toHaveLength(0);
    expect(result.newer).toHaveLength(3);
  });

  test("N == trimTarget → older = olderCount, newer = windowSize", () => {
    // N=8, olderCount=5, newer=3
    const msgs = Array.from({ length: 8 }, (_, i) => msg(String(i), i * 100));
    const result = sliceHistory(msgs, trim);
    expect(result.older).toHaveLength(5);
    expect(result.newer).toHaveLength(3);
    expect(result.older[0]?.id).toBe("0");
    expect(result.newer[0]?.id).toBe("5");
  });

  test("trimTarget < N < trimTrigger → older stable, newer grows", () => {
    // N=9, olderCount=5 (stable), newer=4 (grows)
    const msgs = Array.from({ length: 9 }, (_, i) => msg(String(i), i * 100));
    const result = sliceHistory(msgs, trim);
    expect(result.older).toHaveLength(5);
    expect(result.newer).toHaveLength(4);
    // older is first 5
    expect(result.older.map((m) => m.id)).toEqual(["0", "1", "2", "3", "4"]);
    expect(result.newer.map((m) => m.id)).toEqual(["5", "6", "7", "8"]);
  });

  test("N == trimTrigger → drop oldest, split to trimTarget", () => {
    // N=10, drop 2, remaining 8 → older=5, newer=3
    const msgs = Array.from({ length: 10 }, (_, i) => msg(String(i), i * 100));
    const result = sliceHistory(msgs, trim);
    expect(result.older).toHaveLength(5);
    expect(result.newer).toHaveLength(3);
    // dropped 0,1 → older starts at 2
    expect(result.older[0]?.id).toBe("2");
    expect(result.newer[2]?.id).toBe("9");
  });

  test("N > trimTrigger → drop oldest, split to trimTarget", () => {
    // N=12, drop 4, remaining 8 → older=5, newer=3
    const msgs = Array.from({ length: 12 }, (_, i) => msg(String(i), i * 100));
    const result = sliceHistory(msgs, trim);
    expect(result.older).toHaveLength(5);
    expect(result.newer).toHaveLength(3);
    expect(result.older[0]?.id).toBe("4");
    expect(result.newer[2]?.id).toBe("11");
  });

  test("newer is never empty when N > 0", () => {
    for (let n = 1; n <= 15; n++) {
      const msgs = Array.from({ length: n }, (_, i) => msg(String(i), i * 100));
      const result = sliceHistory(msgs, trim);
      expect(result.newer.length).toBeGreaterThan(0);
    }
  });

  test("older stays stable as N grows from trimTarget to trimTrigger-1", () => {
    // As N grows from 8 to 9, older should remain the same 5 messages
    const msgs8 = Array.from({ length: 8 }, (_, i) => msg(String(i), i * 100));
    const msgs9 = Array.from({ length: 9 }, (_, i) => msg(String(i), i * 100));
    const r8 = sliceHistory(msgs8, trim);
    const r9 = sliceHistory(msgs9, trim);
    expect(r8.older.map((m) => m.id)).toEqual(r9.older.map((m) => m.id));
  });

  test("total messages in both slices never exceeds input", () => {
    for (let n = 0; n <= 15; n++) {
      const msgs = Array.from({ length: n }, (_, i) => msg(String(i), i * 100));
      const result = sliceHistory(msgs, trim);
      expect(result.older.length + result.newer.length).toBeLessThanOrEqual(n);
    }
  });

  test("deterministic for identical inputs", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => msg(String(i), i * 100));
    const r1 = sliceHistory(msgs, trim);
    const r2 = sliceHistory(msgs, trim);
    expect(r1.older.map((m) => m.id)).toEqual(r2.older.map((m) => m.id));
    expect(r1.newer.map((m) => m.id)).toEqual(r2.newer.map((m) => m.id));
  });
});
