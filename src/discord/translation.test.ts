import { describe, test, expect } from "bun:test";
import {
  translateInbound,
  translateOutbound,
  resolveDiscordTimestamp,
  type InboundResolvers,
  type OutboundResolvers,
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

// --- Outbound translation tests ---

const outboundResolvers: OutboundResolvers = {
  user: (username) => {
    const map: Record<string, string> = {
      alice: "111",
      bob: "222",
    };
    return map[username];
  },
  channel: (name) => {
    const map: Record<string, string> = {
      general: "333",
      "off-topic": "444",
    };
    return map[name];
  },
  emoji: (name) => {
    const map: Record<string, { id: string; animated: boolean }> = {
      thumbsup: { id: "999", animated: false },
      dance: { id: "888", animated: true },
    };
    return map[name];
  },
};

describe("translateOutbound", () => {
  test("resolves @username to user mention", () => {
    expect(translateOutbound("Hello @alice!", outboundResolvers)).toBe(
      "Hello <@111>!"
    );
  });

  test("resolves #channel to channel mention", () => {
    expect(translateOutbound("See #general", outboundResolvers)).toBe(
      "See <#333>"
    );
  });

  test("resolves :emoji: to custom emoji markup", () => {
    expect(translateOutbound("Nice :thumbsup:", outboundResolvers)).toBe(
      "Nice <:thumbsup:999>"
    );
  });

  test("resolves animated emoji correctly", () => {
    expect(translateOutbound("Cool :dance:", outboundResolvers)).toBe(
      "Cool <a:dance:888>"
    );
  });

  test("preserves unknown @username as plain text", () => {
    expect(translateOutbound("Hello @unknown", outboundResolvers)).toBe(
      "Hello @unknown"
    );
  });

  test("preserves unknown #channel as plain text", () => {
    expect(translateOutbound("See #secret", outboundResolvers)).toBe(
      "See #secret"
    );
  });

  test("preserves unknown :emoji: as plain text", () => {
    expect(translateOutbound("Nice :shrug:", outboundResolvers)).toBe(
      "Nice :shrug:"
    );
  });

  test("resolves multiple patterns in one message", () => {
    const input = "@alice said hi in #general with :thumbsup:";
    expect(translateOutbound(input, outboundResolvers)).toBe(
      "<@111> said hi in <#333> with <:thumbsup:999>"
    );
  });

  test("handles message with no resolvable patterns", () => {
    expect(translateOutbound("just plain text", outboundResolvers)).toBe(
      "just plain text"
    );
  });

  test("handles empty string", () => {
    expect(translateOutbound("", outboundResolvers)).toBe("");
  });

  test("does not match @username inside email addresses", () => {
    expect(translateOutbound("email user@alice.com", outboundResolvers)).toBe(
      "email user@alice.com"
    );
  });

  test("matches @username at start of string", () => {
    expect(translateOutbound("@bob is here", outboundResolvers)).toBe(
      "<@222> is here"
    );
  });

  test("does not resolve channel name with hyphen incorrectly", () => {
    expect(translateOutbound("See #off-topic", outboundResolvers)).toBe(
      "See <#444>"
    );
  });

  test("collects warnings for failed lookups", () => {
    const warnings: string[] = [];
    translateOutbound("@nobody #nowhere :nope:", outboundResolvers, warnings);
    expect(warnings).toContain("Failed to resolve user mention: @nobody");
    expect(warnings).toContain("Failed to resolve channel mention: #nowhere");
    expect(warnings).toContain("Failed to resolve emoji: :nope:");
  });

  test("no warnings when all lookups succeed", () => {
    const warnings: string[] = [];
    translateOutbound("@alice #general :thumbsup:", outboundResolvers, warnings);
    expect(warnings.length).toBe(0);
  });
});

describe("buildDisplayNameContext", () => {
  // Importing separately since it's a context-building util
  let buildDisplayNameContext: (
    users: Array<{ username: string; displayName: string }>
  ) => string;

  test("formats user list for LLM context with legend", async () => {
    const mod = await import("./translation.ts");
    buildDisplayNameContext = mod.buildDisplayNameContext;

    const result = buildDisplayNameContext([
      { username: "alice", displayName: "Alice Wonder" },
      { username: "bob", displayName: "Bob Builder" },
    ]);
    // Legend present
    expect(result).toContain("Legend: [@username] — [display name] — [memories]");
    expect(result).toContain("recall_user_memories(username)");
    // User entries
    expect(result).toContain("@alice — Alice Wonder");
    expect(result).toContain("@bob — Bob Builder");
  });

  test("returns empty string for empty list", async () => {
    const mod = await import("./translation.ts");
    buildDisplayNameContext = mod.buildDisplayNameContext;
    expect(buildDisplayNameContext([])).toBe("");
  });
});
