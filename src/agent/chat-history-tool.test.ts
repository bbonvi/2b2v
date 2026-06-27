import { test, expect, describe } from "bun:test";
import {
  createChatHistoryTool,
  type ChatHistoryToolDeps,
  type ChatHistoryMessage,
} from "./chat-history-tool";
import type { TextContent } from "@earendil-works/pi-ai";

function makeDeps(messages: ChatHistoryMessage[]): ChatHistoryToolDeps {
  return {
    guildId: "g1",
    timezone: "UTC",
    fetchMessages: (_channelId, _limit) => Promise.resolve(messages),
  };
}

const MESSAGES: ChatHistoryMessage[] = [
  { id: "m1", authorUsername: "alice", content: "Hello world", createdAt: Date.now() - 60000 },
  { id: "m2", authorUsername: "bob", content: "Hi alice!", createdAt: Date.now() - 30000 },
  { id: "m3", authorUsername: "alice", content: "How are you?", createdAt: Date.now() },
];

describe("createChatHistoryTool", () => {
  test("returns chat_history AgentTool with correct metadata", () => {
    const tool = createChatHistoryTool(makeDeps(MESSAGES));
    expect(tool.label).toBe("chat_history");
    expect(tool.description).toBeDefined();
    expect(tool.parameters).toBeDefined();
  });

  test("returns chat messages", async () => {
    const tool = createChatHistoryTool(makeDeps(MESSAGES));
    const result = await tool.execute("tc1", { channel_id: "c1" }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("alice");
    expect(text).toContain("Hello world");
    expect(text).toContain("bob");
    expect((result.details as { count: number }).count).toBe(3);
  });

  test("respects limit parameter", async () => {
    let passedLimit: number | undefined;
    const deps: ChatHistoryToolDeps = {
      guildId: "g1",
      timezone: "UTC",
      fetchMessages: (_channelId, limit) => {
        passedLimit = limit;
        return Promise.resolve(MESSAGES.slice(0, limit));
      },
    };
    const tool = createChatHistoryTool(deps);
    await tool.execute("tc1", { channel_id: "c1", limit: 2 }, AbortSignal.timeout(5000));
    expect(passedLimit).toBe(2);
  });

  test("defaults limit to 50", async () => {
    let passedLimit: number | undefined;
    const deps: ChatHistoryToolDeps = {
      guildId: "g1",
      timezone: "UTC",
      fetchMessages: (_channelId, limit) => {
        passedLimit = limit;
        return Promise.resolve(MESSAGES);
      },
    };
    const tool = createChatHistoryTool(deps);
    await tool.execute("tc1", { channel_id: "c1" }, AbortSignal.timeout(5000));
    expect(passedLimit).toBe(50);
  });

  test("handles empty results", async () => {
    const tool = createChatHistoryTool(makeDeps([]));
    const result = await tool.execute("tc1", { channel_id: "c1" }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("No messages");
    expect((result.details as { count: number }).count).toBe(0);
  });

  test("degrades gracefully when fetchMessages throws", async () => {
    const deps: ChatHistoryToolDeps = {
      guildId: "g1",
      timezone: "UTC",
      fetchMessages: () => { throw new Error("Missing Access"); },
    };
    const tool = createChatHistoryTool(deps);
    const result = await tool.execute("tc1", { channel_id: "c1" }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Unable to fetch");
  });

  test("formats messages with local wall-clock timestamps", async () => {
    const tool = createChatHistoryTool(makeDeps(MESSAGES));
    const result = await tool.execute("tc1", { channel_id: "c1" }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    // Local wall-clock format: [YYYY-MM-DD HH:mm], no "UTC" suffix
    expect(text).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/);
    expect(text).not.toContain("UTC");
    expect(text).toContain("alice: Hello world");
  });
});
