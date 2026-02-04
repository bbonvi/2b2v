import { describe, test, expect, beforeEach } from "bun:test";
import {
  createSessionStore,
  encodeCustomId,
  parseCustomId,
  type SessionStore,
} from "./session.ts";

describe("encodeCustomId", () => {
  test("encodes session and action into customId", () => {
    const customId = encodeCustomId("sess123", "home");
    expect(customId).toBe("vpn:sess123:home");
  });

  test("encodes action with param", () => {
    const customId = encodeCustomId("sess123", "create", "eu1");
    expect(customId).toBe("vpn:sess123:create:eu1");
  });
});

describe("parseCustomId", () => {
  test("parses valid customId", () => {
    const result = parseCustomId("vpn:sess123:home");
    expect(result).toEqual({ sessionId: "sess123", action: "home", param: undefined });
  });

  test("parses customId with param", () => {
    const result = parseCustomId("vpn:sess123:create:eu1");
    expect(result).toEqual({ sessionId: "sess123", action: "create", param: "eu1" });
  });

  test("returns null for non-vpn prefix", () => {
    expect(parseCustomId("other:sess:action")).toBeNull();
  });

  test("returns null for malformed customId", () => {
    expect(parseCustomId("vpn:only")).toBeNull();
    expect(parseCustomId("")).toBeNull();
  });
});

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = createSessionStore();
  });

  test("creates new session with unique id", () => {
    const session = store.create("user1", "guild1");
    expect(session.id).toBeDefined();
    expect(session.userId).toBe("user1");
    expect(session.guildId).toBe("guild1");
    expect(session.profiles).toEqual([]);
    expect(session.servers).toEqual([]);
  });

  test("get returns session by id", () => {
    const session = store.create("user1", "guild1");
    const retrieved = store.get(session.id);
    expect(retrieved).toEqual(session);
  });

  test("get returns undefined for unknown id", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  test("delete removes session", () => {
    const session = store.create("user1", "guild1");
    store.delete(session.id);
    expect(store.get(session.id)).toBeUndefined();
  });

  test("cleanExpired removes sessions older than timeout", async () => {
    const store = createSessionStore(100); // 100ms timeout
    const session = store.create("user1", "guild1");

    await new Promise((r) => setTimeout(r, 150));

    store.cleanExpired();
    expect(store.get(session.id)).toBeUndefined();
  });

  test("isOwner returns true for session owner", () => {
    const session = store.create("user1", "guild1");
    expect(store.isOwner(session.id, "user1")).toBe(true);
    expect(store.isOwner(session.id, "user2")).toBe(false);
  });
});
