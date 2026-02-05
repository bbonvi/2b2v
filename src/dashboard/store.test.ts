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
