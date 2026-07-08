import { describe, expect, test } from "bun:test";
import type { HistoryMessage } from "../agent/history-types.ts";
import { renderAmbientHistory } from "./runtime.ts";

function msg(overrides: Partial<HistoryMessage> = {}): HistoryMessage {
  return {
    id: "m1",
    author: "alice",
    authorId: "uid-alice",
    content: "hello",
    isBot: false,
    timestamp: Date.UTC(2026, 6, 7, 21, 10, 6, 846),
    replyToId: null,
    imageIds: [],
    captions: [],
    hasEmbeds: false,
    isSynthetic: false,
    relatedThreadId: null,
    ...overrides,
  };
}

describe("renderAmbientHistory", () => {
  test("renders local wall-clock timestamps and marks every trigger message", () => {
    const text = renderAmbientHistory({
      history: [
        msg({ id: "m1", content: "first" }),
        msg({ id: "m2", author: "bob", authorId: "uid-bob", content: "second", timestamp: Date.UTC(2026, 6, 7, 21, 11, 0) }),
      ],
      timezone: "UTC",
      triggerMessageIds: ["m1", "m2"],
    });

    expect(text).toContain("[2026-07-07 21:10] alice (uid-alice) <trigger>: first");
    expect(text).toContain("[2026-07-07 21:11] bob (uid-bob) <trigger>: second");
    expect(text).not.toContain("T21:10:06.846Z");
  });

  test("marks follow-up anchor separately", () => {
    const text = renderAmbientHistory({
      history: [
        msg({ id: "u1", content: "source" }),
        msg({ id: "b1", authorId: "bot-1", isBot: true, content: "previous reply", timestamp: Date.UTC(2026, 6, 7, 21, 12, 0), replyToId: "u1" }),
      ],
      timezone: "UTC",
      followUpAnchorMessageId: "b1",
    });

    expect(text).toContain("2B (bot-1) reply_to=u1 <follow_up_anchor>: previous reply");
    expect(text).not.toContain("<trigger>");
  });
});
