import { test, expect, describe } from "bun:test";
import {
  loadPersona,
  assembleSystemPrompt,
  formatChatHistory,
  type PromptContext,
  type ChatMessage,
} from "./prompt.ts";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TMP_DIR = join(import.meta.dir, "../../.test-tmp-prompt");

function setup() {
  mkdirSync(TMP_DIR, { recursive: true });
}

function teardown() {
  rmSync(TMP_DIR, { recursive: true, force: true });
}

// --- loadPersona ---

describe("loadPersona", () => {
  test("loads persona markdown from file path", () => {
    setup();
    const personaPath = join(TMP_DIR, "persona.md");
    writeFileSync(personaPath, "# 2B\nYoRHa combat android.");
    try {
      const result = loadPersona(personaPath);
      expect(result).toBe("# 2B\nYoRHa combat android.");
    } finally {
      teardown();
    }
  });

  test("throws when persona file does not exist", () => {
    expect(() => loadPersona("/nonexistent/persona.md")).toThrow();
  });

  test("trims whitespace from persona content", () => {
    setup();
    const personaPath = join(TMP_DIR, "persona.md");
    writeFileSync(personaPath, "\n  # 2B  \n\n");
    try {
      const result = loadPersona(personaPath);
      expect(result).toBe("# 2B");
    } finally {
      teardown();
    }
  });
});

// --- formatChatHistory ---

describe("formatChatHistory", () => {
  test("formats messages as user/bot labeled lines", () => {
    const messages: ChatMessage[] = [
      { author: "alice", content: "Hello 2B!", isBot: false },
      { author: "2B", content: "Greetings, alice.", isBot: true },
    ];
    const result = formatChatHistory(messages);
    expect(result).toBe("alice: Hello 2B!\n2B: Greetings, alice.");
  });

  test("returns empty string for empty messages", () => {
    expect(formatChatHistory([])).toBe("");
  });

  test("handles multiline message content", () => {
    const messages: ChatMessage[] = [
      { author: "bob", content: "line one\nline two", isBot: false },
    ];
    const result = formatChatHistory(messages);
    expect(result).toBe("bob: line one\nline two");
  });
});

// --- assembleSystemPrompt ---

describe("assembleSystemPrompt", () => {
  test("assembles all sections in correct order", () => {
    const ctx: PromptContext = {
      persona: "# 2B\nCombat android.",
      journalSummaries: ["Tracked alice's birthday", "Server movie night planned"],
      upcomingSchedules: ["Daily greeting at 08:00 UTC"],
      chatHistory: [
        { author: "alice", content: "Hey 2B", isBot: false },
        { author: "2B", content: "Hello.", isBot: true },
      ],
      emojiContext: "",
      displayNameContext: "",
      guildId: "g1",
      channelId: "c1",
      timestamp: "2025-01-01T00:00:00.000Z",
    };

    const result = assembleSystemPrompt(ctx);

    // Persona section appears first
    expect(result).toContain("# 2B\nCombat android.");
    // Journal section present
    expect(result).toContain("## Journal");
    expect(result).toContain("- Tracked alice's birthday");
    expect(result).toContain("- Server movie night planned");
    // Schedules section present
    expect(result).toContain("## Upcoming Schedules");
    expect(result).toContain("- Daily greeting at 08:00 UTC");
    // Chat history section present
    expect(result).toContain("## Chat History");
    expect(result).toContain("alice: Hey 2B");
    expect(result).toContain("2B: Hello.");
  });

  test("omits journal section when no entries", () => {
    const ctx: PromptContext = {
      persona: "# 2B",
      journalSummaries: [],
      upcomingSchedules: [],
      chatHistory: [],
      emojiContext: "",
      displayNameContext: "",
      guildId: "g1",
      channelId: "c1",
      timestamp: "2025-01-01T00:00:00.000Z",
    };
    const result = assembleSystemPrompt(ctx);
    // Use "\n## X\n" pattern to match actual sections, not TOOL_INSTRUCTIONS references
    expect(result).not.toContain("\n## Journal\n");
  });

  test("omits schedules section when no entries", () => {
    const ctx: PromptContext = {
      persona: "# 2B",
      journalSummaries: [],
      upcomingSchedules: [],
      chatHistory: [],
      emojiContext: "",
      displayNameContext: "",
      guildId: "g1",
      channelId: "c1",
      timestamp: "2025-01-01T00:00:00.000Z",
    };
    const result = assembleSystemPrompt(ctx);
    expect(result).not.toContain("## Upcoming Schedules");
  });

  test("omits chat history section when no messages", () => {
    const ctx: PromptContext = {
      persona: "# 2B",
      journalSummaries: [],
      upcomingSchedules: [],
      chatHistory: [],
      emojiContext: "",
      displayNameContext: "",
      guildId: "g1",
      channelId: "c1",
      timestamp: "2025-01-01T00:00:00.000Z",
    };
    const result = assembleSystemPrompt(ctx);
    expect(result).not.toContain("## Chat History");
  });

  test("includes emoji context when provided", () => {
    const ctx: PromptContext = {
      persona: "# 2B",
      journalSummaries: [],
      upcomingSchedules: [],
      chatHistory: [],
      emojiContext: ":salute: — military salute\n:pod: — flight unit",
      displayNameContext: "",
      guildId: "g1",
      channelId: "c1",
      timestamp: "2025-01-01T00:00:00.000Z",
    };
    const result = assembleSystemPrompt(ctx);
    expect(result).toContain("## Available Emojis");
    expect(result).toContain(":salute: — military salute");
  });

  test("includes display name context when provided", () => {
    const ctx: PromptContext = {
      persona: "# 2B",
      journalSummaries: [],
      upcomingSchedules: [],
      chatHistory: [],
      emojiContext: "",
      displayNameContext: "@alice — Alice Wonderland\n@bob — Bob Builder",
      guildId: "g1",
      channelId: "c1",
      timestamp: "2025-01-01T00:00:00.000Z",
    };
    const result = assembleSystemPrompt(ctx);
    expect(result).toContain("## Server Members");
    expect(result).toContain("@alice — Alice Wonderland");
  });

  test("sections appear in correct order: persona, emojis, members, journal, schedules, history", () => {
    const ctx: PromptContext = {
      persona: "# 2B",
      journalSummaries: ["Entry one"],
      upcomingSchedules: ["Schedule one"],
      chatHistory: [{ author: "alice", content: "hi", isBot: false }],
      emojiContext: ":wave: — greeting",
      displayNameContext: "@alice — Alice",
      guildId: "g1",
      channelId: "c1",
      timestamp: "2025-01-01T00:00:00.000Z",
    };
    const result = assembleSystemPrompt(ctx);

    // Use "\n## X\n" pattern to match actual sections, not TOOL_INSTRUCTIONS references
    const personaIdx = result.indexOf("# 2B");
    const emojiIdx = result.indexOf("\n## Available Emojis\n");
    const memberIdx = result.indexOf("\n## Server Members\n");
    const journalIdx = result.indexOf("\n## Journal\n");
    const schedIdx = result.indexOf("\n## Upcoming Schedules\n");
    const contextIdx = result.indexOf("\n## Current Context\n");
    const historyIdx = result.indexOf("\n## Chat History\n");

    expect(personaIdx).toBeLessThan(emojiIdx);
    expect(emojiIdx).toBeLessThan(memberIdx);
    expect(memberIdx).toBeLessThan(journalIdx);
    expect(journalIdx).toBeLessThan(schedIdx);
    expect(schedIdx).toBeLessThan(contextIdx);
    expect(contextIdx).toBeLessThan(historyIdx);
  });

  test("includes current context section with guild, channel, and timestamp", () => {
    const ctx: PromptContext = {
      persona: "# 2B",
      journalSummaries: [],
      upcomingSchedules: [],
      chatHistory: [],
      emojiContext: "",
      displayNameContext: "",
      guildId: "guild-123",
      channelId: "channel-456",
      timestamp: "2025-06-15T12:30:00.000Z",
    };
    const result = assembleSystemPrompt(ctx);
    expect(result).toContain("## Current Context");
    expect(result).toContain("Guild: guild-123 | Chat: channel-456");
    expect(result).toContain("Date/Time: 2025-06-15T12:30:00.000Z");
  });

  test("persona-only prompt contains persona and tool instructions", () => {
    const ctx: PromptContext = {
      persona: "# 2B\nI am a combat android.",
      journalSummaries: [],
      upcomingSchedules: [],
      chatHistory: [],
      emojiContext: "",
      displayNameContext: "",
      guildId: "g1",
      channelId: "c1",
      timestamp: "2025-01-01T00:00:00.000Z",
    };
    const result = assembleSystemPrompt(ctx);
    expect(result).toStartWith("# 2B\nI am a combat android.");
    expect(result).toContain("send_message");
    // Use "\n## X\n" pattern to match actual sections, not TOOL_INSTRUCTIONS references
    expect(result).not.toContain("\n## Available Emojis\n");
    expect(result).not.toContain("\n## Server Members\n");
    expect(result).not.toContain("\n## Journal\n");
    expect(result).not.toContain("\n## Chat History\n");
  });
});
