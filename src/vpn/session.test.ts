import { describe, expect, setSystemTime, test } from "bun:test";
import {
  createSessionStore,
  encodeCustomId,
  parseCustomId,
} from "./session.ts";

describe("VPN custom IDs", () => {
  test("encodes and parses IDs with optional parameters", () => {
    const cases = [
      {
        encoded: "vpn:sess123:home",
        input: { sessionId: "sess123", action: "home" },
        parsed: { sessionId: "sess123", action: "home", param: undefined },
      },
      {
        encoded: "vpn:sess123:create:eu1",
        input: { sessionId: "sess123", action: "create", param: "eu1" },
        parsed: { sessionId: "sess123", action: "create", param: "eu1" },
      },
    ];

    for (const item of cases) {
      expect(encodeCustomId(item.input.sessionId, item.input.action, item.input.param)).toBe(item.encoded);
      expect(parseCustomId(item.encoded)).toEqual(item.parsed);
    }
  });

  test("rejects foreign and malformed IDs", () => {
    expect(parseCustomId("other:sess:action")).toBeNull();
    expect(parseCustomId("vpn:only")).toBeNull();
    expect(parseCustomId("")).toBeNull();
  });
});

describe("SessionStore", () => {
  test("owns the session lifecycle", () => {
    const store = createSessionStore();
    const first = store.create("user1", "guild1");
    const second = store.create("user1", "guild1");
    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({
      userId: "user1",
      guildId: "guild1",
      profiles: [],
      servers: [],
    });
    expect(store.get(first.id)).toEqual(first);
    expect(store.isOwner(first.id, "user1")).toBe(true);
    expect(store.isOwner(first.id, "user2")).toBe(false);
    store.delete(first.id);
    expect(store.get(first.id)).toBeUndefined();
  });

  test("removes expired sessions", () => {
    const now = Date.now();
    setSystemTime(now);
    try {
      const store = createSessionStore(100);
      const session = store.create("user1", "guild1");
      setSystemTime(now + 150);
      store.cleanExpired();
      expect(store.get(session.id)).toBeUndefined();
    } finally {
      setSystemTime();
    }
  });
});
