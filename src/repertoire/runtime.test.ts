import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadGlobalConfig } from "../config/loader.ts";
import { createDatabase, type Database } from "../db/database.ts";
import { getRepertoireRefreshState } from "../db/repertoire-repository.ts";
import { RequestLogStore } from "../dashboard/store.ts";
import type { Logger } from "../logger.ts";
import type { OpenRouterChatRequest, OpenRouterChatResult } from "../llm/types.ts";
import {
  maybeRefreshRepertoire,
  validateRepertoireRefreshResult,
  type MaybeRefreshRepertoireInput,
  type RepertoireCompleteChat,
} from "./runtime.ts";

const TEST_DIR = join(import.meta.dir, "../../.test-repertoire-runtime");
let db: Database;

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  logTokenUsage: () => {},
  child: () => logger,
};

function config() {
  const path = join(TEST_DIR, "config.yaml");
  writeFileSync(path, [
    "modelProfiles:",
    "  main:",
    "    provider: openai-codex",
    "    model: gpt-5.6-sol",
    "  maintenance:",
    "    provider: openai-codex",
    "    model: gpt-5.6-terra",
    "modelProfile: main",
    "repertoire:",
    "  enabled: true",
    "  modelProfile: maintenance",
    "  refreshAfterBotMessages: 40",
    "  refreshAfterMinutes: 240",
    "  retryCooldownMinutes: 30",
  ].join("\n"));
  return loadGlobalConfig({ DISCORD_TOKEN: "test" }, path);
}

function insertExchange(id: string, at: number, channelId = "c1"): void {
  db.raw.prepare(
    `INSERT INTO messages
     (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content,
      is_bot, created_at)
     VALUES (?, 'g1', ?, 'human', 'human', 'cue', 'cue', 0, ?)`,
  ).run(`${id}-cue`, channelId, at);
  db.raw.prepare(
    `INSERT INTO messages
     (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content,
      is_bot, created_at, reply_to_id)
     VALUES (?, 'g1', ?, '2b', '2b', 'reply', 'reply', 1, ?, ?)`,
  ).run(id, channelId, at + 1, `${id}-cue`);
}

function result(text: string): OpenRouterChatResult {
  return {
    text,
    toolCalls: [],
    stopReason: "stop",
    messageForLogs: {
      role: "assistant",
      model: "gpt-5.6-terra",
      content: text,
      stopReason: "stop",
      usage: { input: 10, output: 5, totalTokens: 15 },
    },
    rawResponse: {},
  };
}

function fakeCompletion(
  select: (request: OpenRouterChatRequest) => string,
): RepertoireCompleteChat {
  return (request) => {
    request.onPayload?.({ model: request.model, messages: request.messages });
    return Promise.resolve(result(select(request)));
  };
}

function runtimeInput(
  now: number,
  completeChat: RepertoireCompleteChat,
): MaybeRefreshRepertoireInput {
  return {
    db,
    globalConfig: config(),
    botUserId: "2b",
    guildId: "g1",
    channelId: "c1",
    mergeMessageGapSeconds: 120,
    llmOutputTimeoutMs: 5_000,
    systemPrompt: "system",
    personaPrompt: "persona",
    runtimePrompt: "runtime",
    decisionInstruction: "decision",
    requestLogStore: new RequestLogStore(),
    log: logger,
    now,
    completeChat,
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("repertoire refresh validation", () => {
  test("rejects unknown, duplicate, malformed, and over-cap selections", () => {
    const limits = {
      recentCandidateIds: new Set(["recent"]),
      anchorCandidateIds: new Set(["recent", "anchor"]),
      maxRecentEntries: 1,
      maxAnchorEntries: 1,
    };
    expect(validateRepertoireRefreshResult({
      recentIds: ["unknown"],
      anchors: [],
    }, limits)).toBeNull();
    expect(validateRepertoireRefreshResult({
      recentIds: ["recent"],
      anchors: [{ candidateId: "recent", scope: "profile", condition: "similar pressure" }],
    }, limits)).toBeNull();
    expect(validateRepertoireRefreshResult({
      recentIds: [],
      anchors: [{ candidateId: "anchor", scope: "guild", condition: "  " }],
    }, limits)).toBeNull();
    expect(validateRepertoireRefreshResult({
      recentIds: ["recent"],
      anchors: [],
      extra: true,
    }, limits)).toBeNull();
    expect(validateRepertoireRefreshResult({
      recentIds: [],
      anchors: [{ candidateId: "anchor", scope: "guild", condition: "local teasing" }],
    }, limits)).toEqual({
      recentIds: [],
      anchors: [{ candidateId: "anchor", scope: "guild", condition: "local teasing" }],
    });
  });
});

describe("repertoire refresh gating", () => {
  test("refreshes on first age gate, then requires count or age", async () => {
    insertExchange("b1", 1_000);
    let calls = 0;
    const first = await maybeRefreshRepertoire(runtimeInput(
      10_000,
      fakeCompletion((request) => {
        calls += 1;
        expect(request.systemPrompt).toContain("persona");
        expect(request.systemPrompt).toContain("runtime");
        expect(request.systemPrompt).toContain("decision");
        expect(request.tools).toBeUndefined();
        return JSON.stringify({ recentIds: ["b1"], anchors: [] });
      }),
    ));
    expect(first).toEqual({ ran: true, succeeded: true });
    expect(getRepertoireRefreshState(db)).toMatchObject({
      through: { messageId: "b1", createdAt: 1_001 },
      lastSuccessAt: 10_000,
    });

    insertExchange("b2", 20_000);
    const notDue = await maybeRefreshRepertoire(runtimeInput(
      30_000,
      fakeCompletion(() => {
        calls += 1;
        return JSON.stringify({ recentIds: ["b2"], anchors: [] });
      }),
    ));
    expect(notDue.ran).toBe(false);

    const ageDueAt = 10_000 + 240 * 60_000;
    const ageDue = await maybeRefreshRepertoire(runtimeInput(
      ageDueAt,
      fakeCompletion(() => {
        calls += 1;
        return JSON.stringify({ recentIds: ["b2"], anchors: [] });
      }),
    ));
    expect(ageDue).toEqual({ ran: true, succeeded: true });
    expect(calls).toBe(2);
  });

  test("keeps the successful checkpoint after invalid output and applies retry cooldown", async () => {
    insertExchange("b1", 1_000);
    let calls = 0;
    const failed = await maybeRefreshRepertoire(runtimeInput(
      10_000,
      fakeCompletion(() => {
        calls += 1;
        return "{}";
      }),
    ));
    expect(failed).toMatchObject({ ran: true, succeeded: false });
    expect(getRepertoireRefreshState(db)).toMatchObject({
      through: null,
      lastAttemptAt: 10_000,
      lastSuccessAt: 0,
    });

    const retry = await maybeRefreshRepertoire(runtimeInput(
      11_000,
      fakeCompletion(() => {
        calls += 1;
        return JSON.stringify({ recentIds: ["b1"], anchors: [] });
      }),
    ));
    expect(retry.ran).toBe(false);
    expect(calls).toBe(1);
  });

  test("allows only one profile-wide refresh in flight", async () => {
    insertExchange("b1", 1_000);
    let release: ((value: OpenRouterChatResult) => void) | undefined;
    const pending: RepertoireCompleteChat = (request) => {
      request.onPayload?.({ model: request.model });
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const first = maybeRefreshRepertoire(runtimeInput(10_000, pending));
    const second = await maybeRefreshRepertoire(runtimeInput(
      10_000,
      fakeCompletion(() => JSON.stringify({ recentIds: ["b1"], anchors: [] })),
    ));

    expect(second.ran).toBe(false);
    release?.(result(JSON.stringify({ recentIds: ["b1"], anchors: [] })));
    expect(await first).toEqual({ ran: true, succeeded: true });
  });
});
