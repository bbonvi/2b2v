import { describe, test, expect } from "bun:test";
import {
  translateInbound,
  resolveDiscordTimestamp,
  type InboundResolvers,
} from "./translation.ts";

const resolvers: InboundResolvers = {
  user: (id) => {
    const map: Record<string, { username: string; displayName: string }> = {
      "111": { username: "alice", displayName: "Alice Wonder" },
      "222": { username: "bob", displayName: "Bob Builder" },
    };
    return map[id];
  },
  channel: (id) => {
    const map: Record<string, string> = {
      "333": "general",
      "444": "off-topic",
    };
    return map[id];
  },
  role: (id) => {
    const map: Record<string, string> = {
      "555": "Moderators",
      "666": "VIP",
    };
    return map[id];
  },
};

describe("translateInbound", () => {
  test("resolves user mention <@id>", () => {
    expect(translateInbound("Hello <@111>!", resolvers)).toBe(
      "Hello @alice!"
    );
  });

  test("resolves nickname mention <@!id>", () => {
    expect(translateInbound("Hey <@!222>", resolvers)).toBe("Hey @bob");
  });

  test("resolves channel mention <#id>", () => {
    expect(translateInbound("See <#333>", resolvers)).toBe("See #general");
  });

  test("resolves role mention <@&id>", () => {
    expect(translateInbound("Ping <@&555>", resolvers)).toBe(
      "Ping @Moderators"
    );
  });

  test("resolves custom emoji <:name:id>", () => {
    expect(translateInbound("Nice <:thumbsup:999>", resolvers)).toBe(
      "Nice :thumbsup:"
    );
  });

  test("resolves animated emoji <a:name:id>", () => {
    expect(translateInbound("Cool <a:dance:888>", resolvers)).toBe(
      "Cool :dance:"
    );
  });

  test("resolves multiple patterns in one message", () => {
    const input = "<@111> said hi in <#333> with <:wave:777>";
    expect(translateInbound(input, resolvers)).toBe(
      "@alice said hi in #general with :wave:"
    );
  });

  test("preserves unknown user mention as raw", () => {
    expect(translateInbound("Hello <@999>", resolvers)).toBe(
      "Hello <@999>"
    );
  });

  test("preserves unknown channel mention as raw", () => {
    expect(translateInbound("See <#999>", resolvers)).toBe("See <#999>");
  });

  test("preserves unknown role mention as raw", () => {
    expect(translateInbound("Ping <@&999>", resolvers)).toBe(
      "Ping <@&999>"
    );
  });

  test("handles message with no markup", () => {
    expect(translateInbound("just plain text", resolvers)).toBe(
      "just plain text"
    );
  });

  test("handles empty string", () => {
    expect(translateInbound("", resolvers)).toBe("");
  });
});

describe("resolveDiscordTimestamp", () => {
  test("resolves timestamp with R style to relative time", () => {
    const result = resolveDiscordTimestamp(1700000000, "R");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("resolves timestamp with f style to date+time", () => {
    const result = resolveDiscordTimestamp(1700000000, "f");
    expect(result).toContain("2023");
  });

  test("resolves timestamp with F style to full date+time", () => {
    const result = resolveDiscordTimestamp(1700000000, "F");
    expect(result).toContain("2023");
  });

  test("resolves timestamp with d style to short date", () => {
    const result = resolveDiscordTimestamp(1700000000, "d");
    expect(result).toContain("2023");
  });

  test("resolves timestamp with D style to long date", () => {
    const result = resolveDiscordTimestamp(1700000000, "D");
    expect(result).toContain("2023");
  });

  test("resolves timestamp with t style to short time", () => {
    const result = resolveDiscordTimestamp(1700000000, "t");
    expect(typeof result).toBe("string");
  });

  test("resolves timestamp with T style to long time", () => {
    const result = resolveDiscordTimestamp(1700000000, "T");
    expect(typeof result).toBe("string");
  });

  test("defaults to f style when no style given", () => {
    const result = resolveDiscordTimestamp(1700000000);
    expect(result).toContain("2023");
  });
});

describe("translateInbound with timestamps", () => {
  test("resolves timestamp in message", () => {
    const result = translateInbound("Event at <t:1700000000:f>", resolvers);
    expect(result).not.toContain("<t:");
    expect(result).toContain("2023");
  });

  test("resolves timestamp without style", () => {
    const result = translateInbound("Since <t:1700000000>", resolvers);
    expect(result).not.toContain("<t:");
  });

  test("resolves relative timestamp", () => {
    const result = translateInbound("That was <t:1700000000:R>", resolvers);
    expect(result).not.toContain("<t:");
  });
});

describe("buildDisplayNameContext", () => {
  // Importing separately since it's a context-building util
  let buildDisplayNameContext: (
    users: Array<{ username: string; displayName: string }>
  ) => string;

  test("formats user list for LLM context", async () => {
    const mod = await import("./translation.ts");
    buildDisplayNameContext = mod.buildDisplayNameContext;

    const result = buildDisplayNameContext([
      { username: "alice", displayName: "Alice Wonder" },
      { username: "bob", displayName: "Bob Builder" },
    ]);
    expect(result).toContain("@alice");
    expect(result).toContain("Alice Wonder");
    expect(result).toContain("@bob");
    expect(result).toContain("Bob Builder");
  });

  test("returns empty string for empty list", async () => {
    const mod = await import("./translation.ts");
    buildDisplayNameContext = mod.buildDisplayNameContext;
    expect(buildDisplayNameContext([])).toBe("");
  });
});
