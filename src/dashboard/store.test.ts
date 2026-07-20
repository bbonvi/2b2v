import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

  test("ring buffer evicts oldest entries at capacity", () => {
    const store = new RequestLogStore(3);
    store.push(makeEntry({ requestId: "r1" }));
    store.push(makeEntry({ requestId: "r2" }));
    store.push(makeEntry({ requestId: "r3" }));
    store.push(makeEntry({ requestId: "r4" }));
    const result = store.query();
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.requestId)).toEqual(["r4", "r3", "r2"]);
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

  test("getSanitizedByRequestId trims base64 image data without mutating stored entry", () => {
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
    const raw = store.getByRequestId("r1");
    if (raw === null) throw new Error("expected raw entry");

    const sanitizedText = JSON.stringify(sanitized);
    expect(sanitizedText).toContain("data:image/png;base64,[5KB base64 truncated]");
    expect(sanitizedText).toContain("[5KB base64 truncated]");
    expect(sanitizedText).not.toContain("A".repeat(1_024));
    expect(sanitizedText).not.toContain("B".repeat(1_024));

    const rawText = JSON.stringify(raw);
    expect(rawText).toContain(dataUri);
    expect(rawText).toContain(rawBase64);
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
  const testFile = "/tmp/request-log-store-test.json";

  afterEach(() => {
    if (existsSync(testFile)) unlinkSync(testFile);
    if (existsSync(`${testFile}.tmp`)) unlinkSync(`${testFile}.tmp`);
  });

  test("saves entries to disk on push", () => {
    const store = new RequestLogStore(1000, testFile);
    store.push(makeEntry({ requestId: "r1" }));
    store.push(makeEntry({ requestId: "r2" }));

    expect(existsSync(testFile)).toBe(true);
    const saved = JSON.parse(readFileSync(testFile, "utf-8")) as RequestLogEntry[];
    expect(saved).toHaveLength(2);
    expect(saved[0]?.requestId).toBe("r1");
    expect(saved[1]?.requestId).toBe("r2");
  });

  test("loads entries from existing file on construction", () => {
    const preload: RequestLogEntry[] = [
      makeEntry({ requestId: "pre1" }),
      makeEntry({ requestId: "pre2" }),
    ];
    writeFileSync(testFile, JSON.stringify(preload));

    const store = new RequestLogStore(1000, testFile);
    const result = store.query();
    expect(result).toHaveLength(2);
    expect(result[0]?.requestId).toBe("pre2"); // newest first
    expect(result[1]?.requestId).toBe("pre1");
  });

  test("respects maxEntries when loading from file", () => {
    const preload: RequestLogEntry[] = [
      makeEntry({ requestId: "old1" }),
      makeEntry({ requestId: "old2" }),
      makeEntry({ requestId: "old3" }),
      makeEntry({ requestId: "old4" }),
    ];
    writeFileSync(testFile, JSON.stringify(preload));

    const store = new RequestLogStore(2, testFile);
    const result = store.query();
    expect(result).toHaveLength(2);
    // Should have kept the last 2 (newest)
    expect(result.map((e) => e.requestId)).toEqual(["old4", "old3"]);
  });

  test("handles missing file gracefully", () => {
    const store = new RequestLogStore(1000, testFile);
    expect(store.query()).toEqual([]);
  });

  test("handles corrupt file gracefully", () => {
    writeFileSync(testFile, "not valid json {{{");
    const store = new RequestLogStore(1000, testFile);
    expect(store.query()).toEqual([]);
  });

  test("handles non-array JSON gracefully", () => {
    writeFileSync(testFile, JSON.stringify({ foo: "bar" }));
    const store = new RequestLogStore(1000, testFile);
    expect(store.query()).toEqual([]);
  });

  test("no file operations when filePath undefined", () => {
    const store = new RequestLogStore(1000);
    store.push(makeEntry({ requestId: "r1" }));
    // No file should be created at testFile
    expect(existsSync(testFile)).toBe(false);
  });

  test("persists across simulated restarts", () => {
    // First "session"
    const store1 = new RequestLogStore(1000, testFile);
    store1.push(makeEntry({ requestId: "s1-r1" }));
    store1.push(makeEntry({ requestId: "s1-r2" }));

    // Second "session" (simulates hot reload)
    const store2 = new RequestLogStore(1000, testFile);
    const loaded = store2.query();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((e) => e.requestId)).toEqual(["s1-r2", "s1-r1"]);

    // Add more entries in second session
    store2.push(makeEntry({ requestId: "s2-r1" }));
    expect(store2.query()).toHaveLength(3);

    // Third "session" sees all
    const store3 = new RequestLogStore(1000, testFile);
    expect(store3.query()).toHaveLength(3);
  });
});
