import { test, expect, describe } from "bun:test";
import { trimChatHistory } from "./context-trimming.ts";
import type { ChatMessage } from "./prompt.ts";
import type { TrimConfig } from "../config/types.ts";

function makeMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    author: `user${i}`,
    content: `message ${i}`,
    isBot: i % 3 === 0,
  }));
}

const defaultTrim: TrimConfig = { trimTrigger: 10, trimTarget: 6 };

describe("trimChatHistory", () => {
  test("returns messages unchanged when below trim_trigger", () => {
    const msgs = makeMessages(5);
    const result = trimChatHistory(msgs, defaultTrim);
    expect(result).toEqual(msgs);
    expect(result.length).toBe(5);
  });

  test("returns messages unchanged when exactly at trim_trigger - 1", () => {
    const msgs = makeMessages(9);
    const result = trimChatHistory(msgs, defaultTrim);
    expect(result).toEqual(msgs);
    expect(result.length).toBe(9);
  });

  test("trims to trim_target when count reaches trim_trigger", () => {
    const msgs = makeMessages(10);
    const result = trimChatHistory(msgs, defaultTrim);
    expect(result.length).toBe(6);
  });

  test("trims to trim_target when count exceeds trim_trigger", () => {
    const msgs = makeMessages(15);
    const result = trimChatHistory(msgs, defaultTrim);
    expect(result.length).toBe(6);
  });

  test("preserves the most recent messages (drops oldest)", () => {
    const msgs = makeMessages(10);
    const result = trimChatHistory(msgs, defaultTrim);
    // Should keep the last 6 messages (indices 4-9)
    expect(result[0]?.content).toBe("message 4");
    expect(result[5]?.content).toBe("message 9");
  });

  test("handles empty message array", () => {
    const result = trimChatHistory([], defaultTrim);
    expect(result).toEqual([]);
  });

  test("handles trim_target equal to trim_trigger", () => {
    const trim: TrimConfig = { trimTrigger: 5, trimTarget: 5 };
    const msgs = makeMessages(5);
    const result = trimChatHistory(msgs, trim);
    // At trigger, trims to target (same value) — keeps all
    expect(result.length).toBe(5);
  });

  test("does not mutate original array", () => {
    const msgs = makeMessages(10);
    const original = [...msgs];
    trimChatHistory(msgs, defaultTrim);
    expect(msgs).toEqual(original);
  });
});
