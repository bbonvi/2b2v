import { test, expect, describe } from "bun:test";
import {
  createChannelHistoryTool,
  type ChannelHistoryToolDeps,
  type ChannelMessage,
} from "./channel-history-tool";

function makeDeps(messages: ChannelMessage[]): ChannelHistoryToolDeps {
  return {
    guildId: "g1",
    fetchMessages: async (_channelId, _limit) => messages,
  };
}

const MESSAGES: ChannelMessage[] = [
  { id: "m1", authorUsername: "alice", content: "Hello world", createdAt: Date.now() - 60000 },
  { id: "m2", authorUsername: "bob", content: "Hi alice!", createdAt: Date.now() - 30000 },
  { id: "m3", authorUsername: "alice", content: "How are you?", createdAt: Date.now() },
];

describe("createChannelHistoryTool", () => {
  test("returns channel_history AgentTool with correct metadata", () => {
    const tool = createChannelHistoryTool(makeDeps(MESSAGES));
    expect(tool.label).toBe("channel_history");
    expect(tool.description).toBeDefined();
    expect(tool.parameters).toBeDefined();
  });

  test("returns channel messages", async () => {
    const tool = createChannelHistoryTool(makeDeps(MESSAGES));
    const result = await tool.execute("tc1", { channelId: "c1" }, AbortSignal.timeout(5000));
    const text = (result.content?.[0] as any)?.text ?? result.text ?? "";
    expect(text).toContain("alice");
    expect(text).toContain("Hello world");
    expect(text).toContain("bob");
    expect(result.details?.count).toBe(3);
  });

  test("respects limit parameter", async () => {
    let passedLimit: number | undefined;
    const deps: ChannelHistoryToolDeps = {
      guildId: "g1",
      fetchMessages: async (_channelId, limit) => {
        passedLimit = limit;
        return MESSAGES.slice(0, limit);
      },
    };
    const tool = createChannelHistoryTool(deps);
    await tool.execute("tc1", { channelId: "c1", limit: 2 }, AbortSignal.timeout(5000));
    expect(passedLimit).toBe(2);
  });

  test("defaults limit to 50", async () => {
    let passedLimit: number | undefined;
    const deps: ChannelHistoryToolDeps = {
      guildId: "g1",
      fetchMessages: async (_channelId, limit) => {
        passedLimit = limit;
        return MESSAGES;
      },
    };
    const tool = createChannelHistoryTool(deps);
    await tool.execute("tc1", { channelId: "c1" }, AbortSignal.timeout(5000));
    expect(passedLimit).toBe(50);
  });

  test("handles empty results", async () => {
    const tool = createChannelHistoryTool(makeDeps([]));
    const result = await tool.execute("tc1", { channelId: "c1" }, AbortSignal.timeout(5000));
    const text = (result.content?.[0] as any)?.text ?? result.text ?? "";
    expect(text).toContain("No messages");
    expect(result.details?.count).toBe(0);
  });

  test("degrades gracefully when fetchMessages throws", async () => {
    const deps: ChannelHistoryToolDeps = {
      guildId: "g1",
      fetchMessages: async () => { throw new Error("Missing Access"); },
    };
    const tool = createChannelHistoryTool(deps);
    const result = await tool.execute("tc1", { channelId: "c1" }, AbortSignal.timeout(5000));
    const text = (result.content?.[0] as any)?.text ?? result.text ?? "";
    expect(text).toContain("Unable to fetch");
  });

  test("formats messages with timestamps", async () => {
    const tool = createChannelHistoryTool(makeDeps(MESSAGES));
    const result = await tool.execute("tc1", { channelId: "c1" }, AbortSignal.timeout(5000));
    const text = (result.content?.[0] as any)?.text ?? result.text ?? "";
    expect(text).toContain("UTC");
    expect(text).toContain("alice: Hello world");
  });
});
