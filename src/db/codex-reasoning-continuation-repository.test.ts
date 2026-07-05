import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "./database";
import {
  deleteExpiredCodexReasoningContinuations,
  getCodexReasoningContinuation,
  upsertCodexReasoningContinuation,
} from "./codex-reasoning-continuation-repository";

let db: Database;

describe("codex reasoning continuation repository", () => {
  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("stores and loads latest non-stale native content", () => {
    const providerNativeContent = [{
      type: "thinking" as const,
      thinking: "",
      thinkingSignature: "{\"type\":\"reasoning\",\"encrypted_content\":\"sealed\"}",
    }];
    upsertCodexReasoningContinuation(db, {
      guildId: "g",
      channelId: "c",
      userId: "u",
      provider: "openai-codex",
      model: "gpt-5.5",
      sessionId: "s",
      sourceMessageId: "m1",
      providerNativeContent,
      createdAt: 1000,
    });

    expect(getCodexReasoningContinuation(db, {
      guildId: "g",
      channelId: "c",
      userId: "u",
      provider: "openai-codex",
      model: "gpt-5.5",
      sessionId: "s",
      maxAgeMs: 500,
      now: 1200,
    })?.providerNativeContent).toEqual(providerNativeContent);

    expect(getCodexReasoningContinuation(db, {
      guildId: "g",
      channelId: "c",
      userId: "u",
      provider: "openai-codex",
      model: "gpt-5.5",
      sessionId: "s",
      maxAgeMs: 100,
      now: 1200,
    })).toBeNull();
  });

  test("deletes expired rows", () => {
    upsertCodexReasoningContinuation(db, {
      guildId: "g",
      channelId: "c",
      userId: "u",
      provider: "openai-codex",
      model: "gpt-5.5",
      sessionId: "s",
      providerNativeContent: [{ type: "text", text: "hello" }],
      createdAt: 1000,
    });

    expect(deleteExpiredCodexReasoningContinuations(db, 100, 1200)).toBe(1);
  });
});
