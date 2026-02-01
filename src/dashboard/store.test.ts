import { test, expect, describe } from "bun:test";
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
