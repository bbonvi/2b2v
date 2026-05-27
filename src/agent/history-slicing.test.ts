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
    isSynthetic: false,
    relatedThreadId: null,
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
  // olderCount = 8 - 3 = 5, max complete chunked older size = 3

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

  test("N == trimTarget → older uses complete chunks, newer keeps the in-progress chunk", () => {
    // N=8, complete older chunk=3, newer=5 because olderCount=5 is not a complete chunk
    const msgs = Array.from({ length: 8 }, (_, i) => msg(String(i), i * 100));
    const result = sliceHistory(msgs, trim);
    expect(result.older).toHaveLength(3);
    expect(result.newer).toHaveLength(5);
    expect(result.older[0]?.id).toBe("0");
    expect(result.newer[0]?.id).toBe("3");
  });

  test("trimTarget < N < trimTrigger → older stable, newer grows", () => {
    // N=9, complete older chunk=3 (stable), newer=6 (grows)
    const msgs = Array.from({ length: 9 }, (_, i) => msg(String(i), i * 100));
    const result = sliceHistory(msgs, trim);
    expect(result.older).toHaveLength(3);
    expect(result.newer).toHaveLength(6);
    expect(result.older.map((m) => m.id)).toEqual(["0", "1", "2"]);
    expect(result.newer.map((m) => m.id)).toEqual(["3", "4", "5", "6", "7", "8"]);
  });

  test("N == trimTrigger → keeps older stable and lets newer grow", () => {
    // N=10, overage=2 < windowSize, drop 0 → older=3, newer=7
    const msgs = Array.from({ length: 10 }, (_, i) => msg(String(i), i * 100));
    const result = sliceHistory(msgs, trim);
    expect(result.older).toHaveLength(3);
    expect(result.newer).toHaveLength(7);
    expect(result.older[0]?.id).toBe("0");
    expect(result.newer[6]?.id).toBe("9");
  });

  test("N > trimTrigger → drops old messages only in window-sized chunks", () => {
    // N=12, overage=4, windowSize=3, drop 3 → remaining 9 → older=3, newer=6
    const msgs = Array.from({ length: 12 }, (_, i) => msg(String(i), i * 100));
    const result = sliceHistory(msgs, trim);
    expect(result.older).toHaveLength(3);
    expect(result.newer).toHaveLength(6);
    expect(result.older[0]?.id).toBe("3");
    expect(result.newer[5]?.id).toBe("11");
  });

  test("newer is never empty when N > 0", () => {
    for (let n = 1; n <= 15; n++) {
      const msgs = Array.from({ length: n }, (_, i) => msg(String(i), i * 100));
      const result = sliceHistory(msgs, trim);
      expect(result.newer.length).toBeGreaterThan(0);
    }
  });

  test("older stays stable as N grows from trimTarget to trimTrigger-1", () => {
    // As N grows from 8 to 9, older should remain the same complete chunk.
    const msgs8 = Array.from({ length: 8 }, (_, i) => msg(String(i), i * 100));
    const msgs9 = Array.from({ length: 9 }, (_, i) => msg(String(i), i * 100));
    const r8 = sliceHistory(msgs8, trim);
    const r9 = sliceHistory(msgs9, trim);
    expect(r8.older.map((m) => m.id)).toEqual(r9.older.map((m) => m.id));
  });

  test("older does not grow one message at a time below trimTarget", () => {
    const wideTrim: TrimConfig = {
      trimTrigger: 400,
      trimTarget: 300,
      windowSize: 50,
      messageCharLimit: 200,
      replyQuoteChars: 50,
    };

    const r70 = sliceHistory(Array.from({ length: 70 }, (_, i) => msg(String(i), i * 100)), wideTrim);
    const r72 = sliceHistory(Array.from({ length: 72 }, (_, i) => msg(String(i), i * 100)), wideTrim);
    const r100 = sliceHistory(Array.from({ length: 100 }, (_, i) => msg(String(i), i * 100)), wideTrim);

    expect(r70.older.map((m) => m.id)).toEqual(Array.from({ length: 50 }, (_, i) => String(i)));
    expect(r72.older.map((m) => m.id)).toEqual(r70.older.map((m) => m.id));
    expect(r100.older.map((m) => m.id)).toEqual(r70.older.map((m) => m.id));
  });

  test("older uses only complete chunks when olderCount is not divisible by windowSize", () => {
    const unevenTrim: TrimConfig = {
      trimTrigger: 200,
      trimTarget: 150,
      windowSize: 20,
      messageCharLimit: 200,
      replyQuoteChars: 50,
    };

    const r149 = sliceHistory(Array.from({ length: 149 }, (_, i) => msg(String(i), i * 100)), unevenTrim);
    const r150 = sliceHistory(Array.from({ length: 150 }, (_, i) => msg(String(i), i * 100)), unevenTrim);

    expect(r149.older).toHaveLength(120);
    expect(r150.older).toHaveLength(120);
    expect(r150.newer).toHaveLength(30);
  });

  test("older stays stable until a full newer-window chunk accumulates", () => {
    const r8 = sliceHistory(Array.from({ length: 8 }, (_, i) => msg(String(i), i * 100)), trim);
    const r9 = sliceHistory(Array.from({ length: 9 }, (_, i) => msg(String(i), i * 100)), trim);
    const r10 = sliceHistory(Array.from({ length: 10 }, (_, i) => msg(String(i), i * 100)), trim);
    const r11 = sliceHistory(Array.from({ length: 11 }, (_, i) => msg(String(i), i * 100)), trim);

    expect(r8.older.map((m) => m.id)).toEqual(["0", "1", "2"]);
    expect(r9.older.map((m) => m.id)).toEqual(r8.older.map((m) => m.id));
    expect(r10.older.map((m) => m.id)).toEqual(r8.older.map((m) => m.id));
    expect(r11.older.map((m) => m.id)).toEqual(["3", "4", "5"]);
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
