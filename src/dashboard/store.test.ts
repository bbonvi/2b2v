import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { RequestLogStore, type RequestLogEntry } from "./store";

function makeEntry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    requestId: crypto.randomUUID(),
    guildId: "g1",
    channelId: "c1",
    authorUsername: "alice",
    trigger: { type: "mention" },
    agentRan: true,
    tools: [],
    llmCalls: [],
    totalDurationMs: 100,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("RequestLogStore", () => {
  test("empty store returns empty arrays", () => {
    const store = new RequestLogStore();
    expect(store.query()).toEqual([]);
    expect(store.getFilterOptions()).toEqual({ guildIds: [], channelIds: [], usernames: [] });
  });

  test("push and query returns entries newest first", () => {
    const store = new RequestLogStore();
    const e1 = makeEntry({ requestId: "r1" });
    const e2 = makeEntry({ requestId: "r2" });
    store.push(e1);
    store.push(e2);
    const result = store.query();
    expect(result).toHaveLength(2);
    expect(result[0]?.requestId).toBe("r2");
    expect(result[1]?.requestId).toBe("r1");
  });

  test("keeps several thousand entries without eviction", () => {
    const store = new RequestLogStore();
    for (let index = 0; index < 2_500; index++) {
      store.push(makeEntry({ requestId: `r${index}`, timestamp: new Date(index).toISOString() }));
    }
    const result = store.query();
    expect(result).toHaveLength(2_500);
    expect(result[0]?.requestId).toBe("r2499");
    expect(result.at(-1)?.requestId).toBe("r0");
  });

  test("query filters by guildId", () => {
    const store = new RequestLogStore();
    store.push(makeEntry({ guildId: "g1" }));
    store.push(makeEntry({ guildId: "g2" }));
    store.push(makeEntry({ guildId: "g1" }));
    expect(store.query({ guildId: "g1" })).toHaveLength(2);
    expect(store.query({ guildId: "g2" })).toHaveLength(1);
    expect(store.query({ guildId: "g3" })).toHaveLength(0);
  });

  test("query filters by channelId", () => {
    const store = new RequestLogStore();
    store.push(makeEntry({ channelId: "c1" }));
    store.push(makeEntry({ channelId: "c2" }));
    expect(store.query({ channelId: "c1" })).toHaveLength(1);
  });

  test("query filters by authorUsername", () => {
    const store = new RequestLogStore();
    store.push(makeEntry({ authorUsername: "alice" }));
    store.push(makeEntry({ authorUsername: "bob" }));
    expect(store.query({ authorUsername: "bob" })).toHaveLength(1);
  });

  test("query combines multiple filters", () => {
    const store = new RequestLogStore();
    store.push(makeEntry({ guildId: "g1", channelId: "c1", authorUsername: "alice" }));
    store.push(makeEntry({ guildId: "g1", channelId: "c2", authorUsername: "alice" }));
    store.push(makeEntry({ guildId: "g2", channelId: "c1", authorUsername: "bob" }));
    expect(store.query({ guildId: "g1", authorUsername: "alice" })).toHaveLength(2);
    expect(store.query({ guildId: "g1", channelId: "c1" })).toHaveLength(1);
  });

  test("query limit caps returned entries after filtering", () => {
    const store = new RequestLogStore();
    store.push(makeEntry({ requestId: "r1", guildId: "g1" }));
    store.push(makeEntry({ requestId: "r2", guildId: "g2" }));
    store.push(makeEntry({ requestId: "r3", guildId: "g1" }));
    store.push(makeEntry({ requestId: "r4", guildId: "g1" }));

    expect(store.query({ guildId: "g1" }, 2).map((entry) => entry.requestId)).toEqual(["r4", "r3"]);
    expect(store.query({}, 0)).toEqual([]);
  });

  test("totals include every filtered request before lifecycle pagination", () => {
    const store = new RequestLogStore();
    for (let index = 0; index < 240; index++) {
      store.push(makeEntry({
        requestId: `r${index}`,
        guildId: index % 2 === 0 ? "g1" : "g2",
        triggerContext: { messageId: `m${index}`, content: "message" },
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        llmCalls: [{
          model: "model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          estimatedCostUsd: 0.01,
          stopReason: "stop",
          contentTypes: ["text"],
        }],
      }));
    }

    const page = store.queryGroupPage({ guildId: "g1" }, 100);
    expect(page.groups).toHaveLength(100);
    expect(page.totals.requestCount).toBe(120);
    expect(page.totals.groupCount).toBe(120);
    expect(page.totals.estimatedCostUsd).toBeCloseTo(1.2);
    expect(page.totals.firstRecordedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("query sorts by request timestamp, not emit order", () => {
    const store = new RequestLogStore();
    store.push(makeEntry({ requestId: "child", timestamp: "2026-06-17T00:00:02.000Z" }));
    store.push(makeEntry({ requestId: "parent-emitted-last", timestamp: "2026-06-17T00:00:01.000Z" }));

    expect(store.query().map((entry) => entry.requestId)).toEqual(["child", "parent-emitted-last"]);
  });

  test("querySummaries omits heavyweight detail payloads", () => {
    const store = new RequestLogStore();
    store.push(makeEntry({
      requestId: "r1",
      timestamp: "2026-06-17T00:00:00.000Z",
      error: "boom",
      tools: [{
        tool: "huge_tool",
        args: { input: "x" },
        result: "x".repeat(10_000),
      }],
      llmCalls: [{
        model: "model",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        estimatedCostUsd: 0.25,
        stopReason: "stop",
        contentTypes: ["text"],
        outputText: "x".repeat(10_000),
        requestPayload: { large: "x".repeat(10_000) },
        responsePayload: { large: "x".repeat(10_000) },
      }],
    }));

    const summaries = store.querySummaries();
    expect(summaries).toEqual([{
      requestId: "r1",
      guildId: "g1",
      channelId: "c1",
      authorUsername: "alice",
      trigger: { type: "mention" },
      agentRan: true,
      toolCount: 1,
      runtimeActionCount: 1,
      llmCallCount: 1,
      estimatedCostUsd: 0.25,
      totalDurationMs: 100,
      hasError: true,
      outcome: "error",
      timestamp: "2026-06-17T00:00:00.000Z",
    }]);
    const first = summaries[0];
    if (first === undefined) throw new Error("expected summary");
    expect("tools" in first).toBe(false);
    expect("llmCalls" in first).toBe(false);
  });

  test("getByRequestId returns a single full entry", () => {
    const store = new RequestLogStore();
    store.push(makeEntry({ requestId: "r1" }));
    store.push(makeEntry({ requestId: "r2", tools: [{ tool: "search", args: {}, result: "full result" }] }));

    expect(store.getByRequestId("r2")?.tools[0]?.result).toBe("full result");
    expect(store.getByRequestId("missing")).toBeNull();
  });

  test("trims base64 image data before it reaches persistent storage", () => {
    const store = new RequestLogStore();
    const dataUri = `data:image/png;base64,${"A".repeat(5_000)}`;
    const rawBase64 = "B".repeat(5_000);
    store.push(makeEntry({
      requestId: "r1",
      tools: [{
        tool: "read_image",
        args: { data: rawBase64 },
      }],
      llmCalls: [{
        model: "model",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        stopReason: "stop",
        contentTypes: ["text", "image"],
        requestPayload: {
          content: [{ type: "input_image", image_url: dataUri }],
        },
        responsePayload: {
          b64_json: rawBase64,
        },
      }],
    }));

    const sanitized = store.getSanitizedByRequestId("r1");
    if (sanitized === null) throw new Error("expected sanitized entry");
    const stored = store.getByRequestId("r1");
    if (stored === null) throw new Error("expected stored entry");

    const sanitizedText = JSON.stringify(sanitized);
    expect(sanitizedText).toContain("data:image/png;base64,[5KB base64 truncated]");
    expect(sanitizedText).toContain("[5KB base64 truncated]");
    expect(sanitizedText).not.toContain("A".repeat(1_024));
    expect(sanitizedText).not.toContain("B".repeat(1_024));

    expect(JSON.stringify(stored)).toBe(sanitizedText);
  });

  test("getFilterOptions returns unique values", () => {
    const store = new RequestLogStore();
    store.push(makeEntry({ guildId: "g1", channelId: "c1", authorUsername: "alice" }));
    store.push(makeEntry({ guildId: "g1", channelId: "c2", authorUsername: "bob" }));
    store.push(makeEntry({ guildId: "g2", channelId: "c1", authorUsername: "alice" }));
    const opts = store.getFilterOptions();
    expect(opts.guildIds.sort()).toEqual(["g1", "g2"]);
    expect(opts.channelIds.sort()).toEqual(["c1", "c2"]);
    expect(opts.usernames.sort()).toEqual(["alice", "bob"]);
  });

  test("groups reply, memory, relationship, inner-thread, and ambient phases by source message", () => {
    const store = new RequestLogStore();
    const context = { messageId: "m1", authorUsername: "alice", content: "hello" };
    store.push(makeEntry({ requestId: "reply", triggerContext: context, timestamp: "2026-06-17T00:00:01.000Z" }));
    store.push(makeEntry({
      requestId: "memory",
      trigger: { type: "background_memory_extraction", sourceRequestId: "reply" },
      triggerContext: context,
      timestamp: "2026-06-17T00:00:02.000Z",
      tools: [{
        tool: "record_memory",
        args: { actions: [{ action: "create" }] },
        status: "completed",
        resultPayload: { details: { applied: 1, requested: 1 } },
      }],
    }));
    store.push(makeEntry({
      requestId: "relationship",
      trigger: { type: "relationships_extraction", sourceRequestId: "reply" },
      triggerContext: context,
      timestamp: "2026-06-17T00:00:03.000Z",
      tools: [{
        tool: "record_relationship",
        args: { signals: [{ summary: "warmer" }] },
        status: "completed",
        resultPayload: { details: { accepted: [{ userId: "u1" }] } },
      }],
    }));
    store.push(makeEntry({
      requestId: "inner-thread",
      trigger: { type: "inner_thread_maintenance", sourceRequestId: "reply" },
      triggerContext: context,
      timestamp: "2026-06-17T00:00:04.000Z",
      tools: [{
        tool: "record_inner_threads",
        args: { actions: [{ action: "create" }] },
        status: "completed",
        resultPayload: { details: { applied: 1, errors: [] } },
      }],
    }));
    store.push(makeEntry({
      requestId: "ambient",
      trigger: { type: "ambient_attention_evaluator", kind: "ambient_pickup" },
      triggerContext: context,
      timestamp: "2026-06-17T00:00:05.000Z",
      tools: [{
        tool: "ambient_decision",
        args: {},
        status: "completed",
        resultPayload: { structuredContent: { status: "selected" } },
      }],
    }));

    const groups = store.queryGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.groupId).toBe("message:g1:c1:m1");
    expect(groups[0]?.requests.map((request) => request.requestId)).toEqual(["reply", "memory", "relationship", "inner-thread", "ambient"]);
    expect(groups[0]?.outcome).toBe("effective");
    expect(groups[0]?.requests.map((request) => request.outcome)).toEqual(["default", "effective", "effective", "effective", "effective"]);

    const detail = store.getSanitizedGroup("message:g1:c1:m1");
    expect(detail?.entries.map((item) => item.entry.requestId)).toEqual(["reply", "memory", "relationship", "inner-thread", "ambient"]);
  });

  test("groups ambient initiative maintenance under its synthetic parent request", () => {
    const store = new RequestLogStore();
    const messageId = "ambient-initiative:run-1";
    store.push(makeEntry({
      requestId: "initiative",
      authorUsername: "ambient-initiative",
      trigger: { type: "ambient_initiative_evaluator", kind: "generic", status: "evaluating" },
      triggerContext: {
        messageId,
        authorUsername: "ambient-initiative",
        content: "autonomous cognitive opportunity",
      },
      timestamp: "2026-07-20T00:00:01.000Z",
      llmCalls: [{
        model: "test",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        stopReason: "stop",
        contentTypes: ["text"],
        status: "completed",
      }],
    }));
    store.push(makeEntry({
      requestId: "initiative-memory",
      authorUsername: "2B",
      trigger: {
        type: "background_memory_extraction",
        sourceRequestId: "initiative",
        source: "ambient_initiative",
      },
      triggerContext: {
        messageId,
        authorUsername: "2B",
        content: "autonomous cognitive opportunity",
      },
      timestamp: "2026-07-20T00:00:02.000Z",
    }));

    const groups = store.queryGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.groupId).toBe(`trigger:g1:c1:${messageId}`);
    expect(groups[0]?.scope).toBe("trigger");
    expect(groups[0]?.requests.map((request) => request.requestId)).toEqual([
      "initiative",
      "initiative-memory",
    ]);
  });

  test("groups synthetic scheduled-task phases without treating them as messages", () => {
    const store = new RequestLogStore();
    const context = { messageId: "scheduled:daily", authorUsername: "scheduler", content: "daily task" };
    store.push(makeEntry({ requestId: "scheduled-run", authorUsername: "scheduler", triggerContext: context }));
    store.push(makeEntry({ requestId: "scheduled-memory", authorUsername: "scheduler", triggerContext: context }));

    const group = store.queryGroups()[0];
    expect(group?.scope).toBe("trigger");
    expect(group?.groupId).toBe("trigger:g1:c1:scheduled:daily");
    expect(group?.requestCount).toBe(2);
  });

  test("keeps asynchronous roots separate from their source message", () => {
    const store = new RequestLogStore();
    const context = { messageId: "m1", authorUsername: "alice", content: "make it" };
    store.push(makeEntry({ requestId: "reply", triggerContext: context, timestamp: "2026-07-20T00:00:01.000Z" }));
    store.push(makeEntry({
      requestId: "image-run",
      trigger: { type: "image_generation_job", jobId: "img-1", sourceMessageId: "m1" },
      triggerContext: { sourceMessageId: "m1", authorUsername: "alice", sourceQuote: "make it" },
      timestamp: "2026-07-20T00:00:02.000Z",
    }));
    store.push(makeEntry({
      requestId: "agent-run",
      trigger: { type: "background_agent_run", jobId: "agent-1", sourceMessageId: "m1" },
      triggerContext: { sourceMessageId: "m1", authorUsername: "alice", sourceQuote: "make it" },
      timestamp: "2026-07-20T00:00:03.000Z",
    }));
    store.push(makeEntry({
      requestId: "agent-handoff",
      trigger: { type: "background_agent_handoff", jobId: "agent-1", sourceMessageId: "m1" },
      triggerContext: { sourceMessageId: "m1", authorUsername: "alice", sourceQuote: "make it" },
      timestamp: "2026-07-20T00:00:04.000Z",
    }));

    const groups = store.queryGroups();
    expect(groups.map((group) => group.groupId)).toEqual([
      "job:agent-1",
      "job:img-1",
      "message:g1:c1:m1",
    ]);
    expect(groups[0]?.requests.map((request) => request.requestId)).toEqual([
      "agent-run",
      "agent-handoff",
    ]);
  });

  test("orders lifecycles by their first phase when an older lifecycle finishes later", () => {
    const store = new RequestLogStore();
    const olderContext = { messageId: "older", authorUsername: "alice", content: "first" };
    const newerContext = { messageId: "newer", authorUsername: "bob", content: "second" };
    store.push(makeEntry({
      requestId: "older-main",
      triggerContext: olderContext,
      timestamp: "2026-06-17T00:00:01.000Z",
    }));
    store.push(makeEntry({
      requestId: "newer-main",
      triggerContext: newerContext,
      timestamp: "2026-06-17T00:00:02.000Z",
    }));
    store.push(makeEntry({
      requestId: "older-background",
      trigger: { type: "background_memory_extraction", sourceRequestId: "older-main" },
      triggerContext: olderContext,
      timestamp: "2026-06-17T00:00:03.000Z",
    }));

    const groups = store.queryGroups();
    expect(groups.map((group) => group.groupId)).toEqual([
      "message:g1:c1:newer",
      "message:g1:c1:older",
    ]);
    expect(groups[1]?.timestamp).toBe("2026-06-17T00:00:01.000Z");
  });

  test("keeps empty maintenance and rejected ambient evaluations neutral", () => {
    const store = new RequestLogStore();
    store.push(makeEntry({
      requestId: "empty-memory",
      tools: [{
        tool: "record_memory",
        args: { actions: [] },
        status: "completed",
        resultPayload: { details: { applied: 0, requested: 0 } },
      }],
    }));
    store.push(makeEntry({
      requestId: "dropped-ambient",
      tools: [{
        tool: "ambient_decision",
        args: {},
        status: "completed",
        resultPayload: { structuredContent: { status: "dropped" } },
      }],
    }));

    expect(store.querySummaries().map((entry) => entry.outcome)).toEqual(["default", "default"]);
  });

  test("active request tracking", () => {
    const store = new RequestLogStore();
    expect(store.getActiveCount()).toBe(0);
    store.incrementActive();
    store.incrementActive();
    expect(store.getActiveCount()).toBe(2);
    store.decrementActive();
    expect(store.getActiveCount()).toBe(1);
    store.decrementActive();
    expect(store.getActiveCount()).toBe(0);
  });

  test("active entries appear before completed entries and are removed by push", () => {
    const store = new RequestLogStore();
    const active = makeEntry({
      requestId: "active-1",
      status: "active",
      timestamp: "2026-06-17T00:00:02.000Z",
      llmCalls: [{
        id: "model-request-1",
        status: "running",
        startedAt: "2026-06-17T00:00:02.000Z",
        model: "model",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        stopReason: "running",
        contentTypes: [],
        emittedToolCalls: [],
      }],
    });
    store.push(makeEntry({ requestId: "done-1", timestamp: "2026-06-17T00:00:01.000Z" }));
    store.upsertActive(active);

    expect(store.query().map((entry) => entry.requestId)).toEqual(["active-1", "done-1"]);
    expect(store.querySummaries()[0]?.status).toBe("active");
    expect(store.getByRequestId("active-1")?.llmCalls[0]?.status).toBe("running");

    const completed = { ...active };
    delete completed.status;
    store.push(completed);
    expect(store.query().map((entry) => entry.requestId)).toEqual(["active-1", "done-1"]);
    expect(store.querySummaries()[0]?.status).toBeUndefined();
  });

  test("decrementActive does not go below zero", () => {
    const store = new RequestLogStore();
    store.decrementActive();
    expect(store.getActiveCount()).toBe(0);
  });

  test("error entries are stored and queryable", () => {
    const store = new RequestLogStore();
    store.push(makeEntry({ error: "something broke", agentRan: false }));
    const result = store.query();
    expect(result).toHaveLength(1);
    expect(result[0]?.error).toBe("something broke");
    expect(result[0]?.agentRan).toBe(false);
  });
});

describe("RequestLogStore persistence", () => {
  const testFile = "/tmp/request-log-store-test.db";
  const stores: RequestLogStore[] = [];

  function openStore(): RequestLogStore {
    const store = new RequestLogStore(testFile);
    stores.push(store);
    return store;
  }

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const path of [testFile, `${testFile}-wal`, `${testFile}-shm`]) {
      if (existsSync(path)) unlinkSync(path);
    }
  });

  test("saves entries to SQLite on push", () => {
    const store = openStore();
    store.push(makeEntry({ requestId: "r1" }));
    store.push(makeEntry({ requestId: "r2" }));

    expect(existsSync(testFile)).toBe(true);
    expect(openStore().query().map((entry) => entry.requestId)).toEqual(["r2", "r1"]);
  });

  test("uses process-local SQLite when no path is provided", () => {
    const first = new RequestLogStore();
    const second = new RequestLogStore();
    first.push(makeEntry({ requestId: "r1" }));
    expect(first.query()).toHaveLength(1);
    expect(second.query()).toEqual([]);
    first.close();
    second.close();
  });

  test("persists across store instances", () => {
    const store1 = openStore();
    store1.push(makeEntry({ requestId: "s1-r1" }));
    store1.push(makeEntry({ requestId: "s1-r2" }));

    const store2 = openStore();
    const loaded = store2.query();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((e) => e.requestId)).toEqual(["s1-r2", "s1-r1"]);

    store2.push(makeEntry({ requestId: "s2-r1" }));
    expect(store2.query()).toHaveLength(3);

    const store3 = openStore();
    expect(store3.query()).toHaveLength(3);
  });
});
