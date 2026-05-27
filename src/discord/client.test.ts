import { describe, test, expect } from "bun:test";
import { GatewayIntentBits } from "discord.js";
import { REQUIRED_INTENTS, checkMessageContentIntent } from "./client.ts";

describe("REQUIRED_INTENTS", () => {
  test("includes all intents from spec", () => {
    expect(REQUIRED_INTENTS).toContain(GatewayIntentBits.Guilds);
    expect(REQUIRED_INTENTS).toContain(GatewayIntentBits.GuildMessages);
    expect(REQUIRED_INTENTS).toContain(GatewayIntentBits.GuildMessageTyping);
    expect(REQUIRED_INTENTS).toContain(GatewayIntentBits.MessageContent);
    expect(REQUIRED_INTENTS).toContain(GatewayIntentBits.GuildMembers);
    expect(REQUIRED_INTENTS).toContain(GatewayIntentBits.GuildExpressions);
    expect(REQUIRED_INTENTS).toContain(GatewayIntentBits.GuildPresences);
  });

  test("has no duplicates", () => {
    const unique = new Set(REQUIRED_INTENTS);
    expect(unique.size).toBe(REQUIRED_INTENTS.length);
  });
});

describe("checkMessageContentIntent", () => {
  test("returns true when content is present", () => {
    expect(checkMessageContentIntent("hello world")).toBe(true);
  });

  test("returns false for empty content on non-bot message", () => {
    expect(checkMessageContentIntent("")).toBe(false);
  });

  test("returns false for undefined content", () => {
    expect(checkMessageContentIntent(undefined)).toBe(false);
  });
});
