import { describe, expect, test } from "bun:test";
import type { TextContent } from "@mariozechner/pi-ai";
import {
  createReactToMessageTool,
  normalizeReactToMessageInput,
  type ReactToMessageDetails,
} from "./react-to-message-tool.ts";

describe("normalizeReactToMessageInput", () => {
  test("defaults channel_id to the current channel", () => {
    expect(normalizeReactToMessageInput({
      message_id: " msg-1 ",
      emoji: " 👍 ",
    }, "channel-1")).toEqual({
      messageId: "msg-1",
      channelId: "channel-1",
      emoji: "👍",
    });
  });

  test("uses explicit channel_id when provided", () => {
    expect(normalizeReactToMessageInput({
      message_id: "msg-1",
      channel_id: " thread-1 ",
      emoji: ":thumbsup:",
    }, "channel-1")).toEqual({
      messageId: "msg-1",
      channelId: "thread-1",
      emoji: ":thumbsup:",
    });
  });

  test("rejects blank required fields", () => {
    expect(normalizeReactToMessageInput({ message_id: " ", emoji: "👍" }, "channel-1")).toEqual({ error: "message_id is required." });
    expect(normalizeReactToMessageInput({ message_id: "msg-1", emoji: " " }, "channel-1")).toEqual({ error: "emoji is required." });
  });
});

describe("createReactToMessageTool", () => {
  test("returns react_to_message AgentTool with guidance metadata", () => {
    const tool = createReactToMessageTool({
      currentChannelId: "channel-1",
      reactToMessage: () => Promise.reject(new Error("unused")),
    });

    expect(tool.name).toBe("react_to_message");
    expect(tool.description).toBe("Add a Discord reaction to a guild message.");
  });

  test("reacts through dependency and returns details", async () => {
    const calls: Array<{ messageId: string; channelId: string; emoji: string }> = [];
    const tool = createReactToMessageTool({
      currentChannelId: "channel-1",
      reactToMessage: (input) => {
        calls.push(input);
        return Promise.resolve({ ...input } satisfies ReactToMessageDetails);
      },
    });

    const result = await tool.execute("call-1", { message_id: "msg-1", emoji: "👍" }, AbortSignal.timeout(5000));

    expect(calls).toEqual([{ messageId: "msg-1", channelId: "channel-1", emoji: "👍" }]);
    expect(result.details).toEqual({ messageId: "msg-1", channelId: "channel-1", emoji: "👍" });
    expect((result.content[0] as TextContent).text).toContain("Reacted to message msg-1");
  });

  test("returns graceful error when dependency fails", async () => {
    const tool = createReactToMessageTool({
      currentChannelId: "channel-1",
      reactToMessage: () => Promise.reject(new Error("Missing Permissions")),
    });

    const result = await tool.execute("call-1", { message_id: "msg-1", emoji: "👍" }, AbortSignal.timeout(5000));

    expect((result.details as { error: string }).error).toBe("Missing Permissions");
    expect((result.content[0] as TextContent).text).toContain("Failed to react to message");
  });
});
