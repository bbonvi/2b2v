import { test, expect, describe } from "bun:test";
import {
  createListChannelMessagesTool,
  type ListChannelMessagesToolDeps,
  type ListChannelMessage,
} from "./list-channel-messages-tool";
import type { TextContent } from "@earendil-works/pi-ai";

function makeDeps(messages: ListChannelMessage[]): ListChannelMessagesToolDeps {
  return {
    guildId: "g1",
    timezone: "UTC",
    fetchMessages: () => Promise.resolve({ messages }),
  };
}

const MESSAGES: ListChannelMessage[] = [
  { id: "m1", authorUsername: "alice", content: "Hello world", createdAt: Date.now() - 60000 },
  { id: "m2", authorUsername: "bob", content: "Hi alice!", createdAt: Date.now() - 30000 },
  { id: "m3", authorUsername: "alice", content: "How are you?", createdAt: Date.now() },
];

describe("createListChannelMessagesTool", () => {
  test("returns list_channel_messages AgentTool with correct metadata", () => {
    const tool = createListChannelMessagesTool(makeDeps(MESSAGES));
    expect(tool.label).toBe("list_channel_messages");
    expect(tool.description).toBeDefined();
    expect(tool.parameters).toBeDefined();
  });

  test("returns chat messages", async () => {
    const tool = createListChannelMessagesTool(makeDeps(MESSAGES));
    const result = await tool.execute("tc1", { channel_id: "c1" }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("alice");
    expect(text).toContain("Hello world");
    expect(text).toContain("bob");
    expect((result.details as { count: number }).count).toBe(3);
  });

  test("respects limit parameter", async () => {
    let passedLimit: number | undefined;
    const deps: ListChannelMessagesToolDeps = {
      guildId: "g1",
      timezone: "UTC",
      fetchMessages: (input) => {
        passedLimit = input.limit;
        return Promise.resolve({ messages: MESSAGES.slice(0, input.limit) });
      },
    };
    const tool = createListChannelMessagesTool(deps);
    await tool.execute("tc1", { channel_id: "c1", limit: 2 }, AbortSignal.timeout(5000));
    expect(passedLimit).toBe(2);
  });

  test("defaults limit to 50", async () => {
    let passedLimit: number | undefined;
    const deps: ListChannelMessagesToolDeps = {
      guildId: "g1",
      timezone: "UTC",
      fetchMessages: (input) => {
        passedLimit = input.limit;
        return Promise.resolve({ messages: MESSAGES });
      },
    };
    const tool = createListChannelMessagesTool(deps);
    await tool.execute("tc1", { channel_id: "c1" }, AbortSignal.timeout(5000));
    expect(passedLimit).toBe(50);
  });

  test("handles empty results", async () => {
    const tool = createListChannelMessagesTool(makeDeps([]));
    const result = await tool.execute("tc1", { channel_id: "c1" }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("No messages");
    expect((result.details as { count: number }).count).toBe(0);
  });

  test("degrades gracefully when fetchMessages throws", async () => {
    const deps: ListChannelMessagesToolDeps = {
      guildId: "g1",
      timezone: "UTC",
      fetchMessages: () => { throw new Error("Missing Access"); },
    };
    const tool = createListChannelMessagesTool(deps);
    const result = await tool.execute("tc1", { channel_id: "c1" }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Unable to fetch");
  });

  test("formats messages with local wall-clock timestamps", async () => {
    const tool = createListChannelMessagesTool(makeDeps(MESSAGES));
    const result = await tool.execute("tc1", { channel_id: "c1" }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    // Local wall-clock format: [YYYY-MM-DD HH:mm], no "UTC" suffix
    expect(text).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/);
    expect(text).not.toContain("UTC");
    expect(text).toContain("[id m1] alice: Hello world");
  });

  test("passes cursor parameters through", async () => {
    let passed: { beforeMessageId?: string; afterMessageId?: string } | undefined;
    const deps: ListChannelMessagesToolDeps = {
      guildId: "g1",
      timezone: "UTC",
      fetchMessages: (input) => {
        passed = {
          ...(input.beforeMessageId !== undefined ? { beforeMessageId: input.beforeMessageId } : {}),
          ...(input.afterMessageId !== undefined ? { afterMessageId: input.afterMessageId } : {}),
        };
        return Promise.resolve({ messages: MESSAGES.slice(0, 1) });
      },
    };
    const tool = createListChannelMessagesTool(deps);
    const result = await tool.execute("tc1", { channel_id: "c1", before_message_id: "m2", limit: 1 }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;

    expect(passed).toEqual({ beforeMessageId: "m2" });
    expect(text).toContain("oldest_message_id=m1");
    expect((result.details as { oldest_message_id?: string }).oldest_message_id).toBe("m1");
  });

  test("rejects two cursors", async () => {
    const tool = createListChannelMessagesTool(makeDeps(MESSAGES));
    const result = await tool.execute("tc1", { channel_id: "c1", before_message_id: "m2", after_message_id: "m1" }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("either before_message_id or after_message_id");
  });
});
