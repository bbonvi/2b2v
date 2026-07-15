import { describe, test, expect } from "bun:test";
import { shouldRespond, shouldRespondDeliberately, type TriggerInput } from "./triggers.ts";
import type { TriggerConfig } from "../config/types.ts";

function makeTriggers(overrides: Partial<TriggerConfig> = {}): TriggerConfig {
  return {
    mention: true,
    keywords: [],
    randomChance: 0,
    keywordDebounceMs: 2500,
    typingIdleMs: 10000,
    typingResumeGraceMs: 3000,
    typingMaxWaitMs: 15000,
    ...overrides,
  };
}

function makeInput(overrides: Partial<TriggerInput> = {}): TriggerInput {
  return {
    content: "hello world",
    authorId: "user-1",
    botUserId: "bot-1",
    mentionedUserIds: [],
    ...overrides,
  };
}

describe("shouldRespond", () => {
  test("returns null when author is the bot", () => {
    const result = shouldRespond(
      makeInput({ authorId: "bot-1", botUserId: "bot-1" }),
      makeTriggers()
    );
    expect(result).toBeNull();
  });

  test("returns 'mention' when bot is mentioned and mention trigger enabled", () => {
    const result = shouldRespond(
      makeInput({ mentionedUserIds: ["bot-1"] }),
      makeTriggers({ mention: true })
    );
    expect(result).toEqual({ reason: "mention" });
  });

  test("allows deliberate mention and keyword triggers from other bots", () => {
    expect(shouldRespond(
      makeInput({ authorId: "other-bot", authorIsBot: true, mentionedUserIds: ["bot-1"] }),
      makeTriggers({ mention: true, randomChance: 1 }),
    )).toEqual({ reason: "mention" });

    expect(shouldRespond(
      makeInput({ authorId: "other-bot", authorIsBot: true, content: "hello 2B" }),
      makeTriggers({ keywords: ["2b"], randomChance: 1 }),
    )).toEqual({ reason: "keyword", keyword: "2b" });
  });

  test("returns 'mention' when message replies to the bot and mention trigger enabled", () => {
    const result = shouldRespond(
      makeInput({ repliedToBot: true }),
      makeTriggers({ mention: true })
    );
    expect(result).toEqual({ reason: "mention" });
  });

  test("returns null when bot is mentioned but mention trigger disabled", () => {
    const result = shouldRespond(
      makeInput({ mentionedUserIds: ["bot-1"] }),
      makeTriggers({ mention: false })
    );
    expect(result).toBeNull();
  });

  test("returns null when message replies to the bot but mention trigger disabled", () => {
    const result = shouldRespond(
      makeInput({ repliedToBot: true }),
      makeTriggers({ mention: false })
    );
    expect(result).toBeNull();
  });

  test("returns 'keyword' when content matches a keyword (case-insensitive)", () => {
    const result = shouldRespond(
      makeInput({ content: "Hey 2B, what do you think?" }),
      makeTriggers({ keywords: ["2b", "nier"] })
    );
    expect(result).toEqual({ reason: "keyword", keyword: "2b" });
  });

  test("returns null when no keywords match", () => {
    const result = shouldRespond(
      makeInput({ content: "hello world" }),
      makeTriggers({ keywords: ["2b", "nier"] })
    );
    expect(result).toBeNull();
  });

  test("keyword match requires word boundary", () => {
    const result = shouldRespond(
      makeInput({ content: "I went to 2beach" }),
      makeTriggers({ keywords: ["2b"] })
    );
    expect(result).toBeNull();
  });

  test("returns 'random' when random chance hits (seeded)", () => {
    // With chance 1.0, always triggers
    const result = shouldRespond(
      makeInput(),
      makeTriggers({ randomChance: 1.0 }),
      () => 0.5 // deterministic RNG
    );
    expect(result).toEqual({ reason: "random" });
  });

  test("returns null when random chance misses", () => {
    const result = shouldRespond(
      makeInput(),
      makeTriggers({ randomChance: 0.1 }),
      () => 0.9 // above threshold
    );
    expect(result).toBeNull();
  });

  test("never random-triggers for another bot author", () => {
    const result = shouldRespond(
      makeInput({ authorId: "other-bot", authorIsBot: true }),
      makeTriggers({ randomChance: 1 }),
      () => 0,
    );
    expect(result).toBeNull();
  });

  test("mention takes priority over keyword and random", () => {
    const result = shouldRespond(
      makeInput({
        content: "hey 2B",
        mentionedUserIds: ["bot-1"],
      }),
      makeTriggers({ mention: true, keywords: ["2b"], randomChance: 1.0 })
    );
    expect(result).toEqual({ reason: "mention" });
  });

  test("keyword takes priority over random", () => {
    const result = shouldRespond(
      makeInput({ content: "hey 2B" }),
      makeTriggers({ keywords: ["2b"], randomChance: 1.0 }),
      () => 0.5
    );
    expect(result).toEqual({ reason: "keyword", keyword: "2b" });
  });

  test("returns null when all triggers disabled and chance is 0", () => {
    const result = shouldRespond(
      makeInput(),
      makeTriggers({ mention: false, keywords: [], randomChance: 0 })
    );
    expect(result).toBeNull();
  });

  test("empty content does not crash keyword check", () => {
    const result = shouldRespond(
      makeInput({ content: "" }),
      makeTriggers({ keywords: ["2b"] })
    );
    expect(result).toBeNull();
  });

  test("matches Cyrillic keywords with word boundaries", () => {
    const result = shouldRespond(
      makeInput({ content: "привет туби как дела" }),
      makeTriggers({ keywords: ["туби"] })
    );
    expect(result).toEqual({ reason: "keyword", keyword: "туби" });
  });

  test("Cyrillic keyword at start of message", () => {
    const result = shouldRespond(
      makeInput({ content: "Туби, привет!" }),
      makeTriggers({ keywords: ["туби"] })
    );
    expect(result).toEqual({ reason: "keyword", keyword: "туби" });
  });

  test("Cyrillic keyword requires word boundary", () => {
    const result = shouldRespond(
      makeInput({ content: "приветтуби" }),
      makeTriggers({ keywords: ["туби"] })
    );
    expect(result).toBeNull();
  });

  test("Cyrillic keyword not matched as suffix", () => {
    const result = shouldRespond(
      makeInput({ content: "тубика" }),
      makeTriggers({ keywords: ["туби"] })
    );
    expect(result).toBeNull();
  });
});

describe("shouldRespondDeliberately", () => {
  test("preserves mentions, replies, and keywords while suppressing random triggers", () => {
    const triggers = makeTriggers({ keywords: ["2b"], randomChance: 1 });

    expect(shouldRespondDeliberately(makeInput({ mentionedUserIds: ["bot-1"] }), triggers))
      .toEqual({ reason: "mention" });
    expect(shouldRespondDeliberately(makeInput({ repliedToBot: true }), triggers))
      .toEqual({ reason: "mention" });
    expect(shouldRespondDeliberately(makeInput({ content: "hello 2b" }), triggers))
      .toEqual({ reason: "keyword", keyword: "2b" });
    expect(shouldRespondDeliberately(makeInput({ content: "ordinary message" }), triggers)).toBeNull();
  });
});
