import { describe, expect, test } from "bun:test";
import type { TextContent } from "@earendil-works/pi-ai";
import { createListChannelMessagesTool, type ListChannelMessage, type ListChannelMessagesToolDeps } from "./list-channel-messages-tool.ts";

function message(id: string, author: string, content: string, timestamp: number, assets?: ListChannelMessage["assets"]): ListChannelMessage {
  return {
    id, author, authorId: `u-${author}`, content, isBot: false, timestamp, replyToId: null,
    hasEmbeds: false, isSynthetic: false, relatedThreadId: null,
    ...(assets === undefined ? {} : { assets }),
  };
}

const messages = [
  message("m1", "alice", "Hello world", Date.now() - 60_000),
  message("m2", "bob", "Hi alice!", Date.now() - 30_000),
];

function deps(fetchMessages: ListChannelMessagesToolDeps["fetchMessages"] = () => Promise.resolve({ messages })): ListChannelMessagesToolDeps {
  return { guildId: "g1", timezone: "UTC", fetchMessages };
}

describe("list_channel_messages", () => {
  test("formats normal history grammar with MsgIDs and typed assets", async () => {
    const withAsset = message("m1", "alice", "file", Date.now(), [{
      id: 7, kind: "text", sourceKind: "attachment", filename: "x.js", contentType: "text/javascript",
      size: 100, width: null, height: null, durationSeconds: null,
    }]);
    const result = await createListChannelMessagesTool(deps(() => Promise.resolve({ messages: [withAsset] })))
      .execute("tc", { channel_id: "c1" }, AbortSignal.timeout(5000));
    const output = (result.content[0] as TextContent).text;
    expect(output).toContain("[@alice (MsgID: m1; Text: #7 x.js (100B))]: file");
    expect(output).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/);
  });

  test("passes pagination and around anchors through", async () => {
    const seen: Array<{ beforeMessageId?: string; aroundMessageId?: string }> = [];
    const tool = createListChannelMessagesTool(deps((input) => {
      seen.push({
        ...(input.beforeMessageId === undefined ? {} : { beforeMessageId: input.beforeMessageId }),
        ...(input.aroundMessageId === undefined ? {} : { aroundMessageId: input.aroundMessageId }),
      });
      return Promise.resolve({ messages: messages.slice(0, 1) });
    }));
    await tool.execute("tc", { channel_id: "c1", before_message_id: "m2" }, AbortSignal.timeout(5000));
    await tool.execute("tc", { channel_id: "c1", around_message_id: "m1" }, AbortSignal.timeout(5000));
    expect(seen).toEqual([{ beforeMessageId: "m2" }, { aroundMessageId: "m1" }]);
  });

  test("rejects combined anchors", async () => {
    const result = await createListChannelMessagesTool(deps()).execute("tc", {
      channel_id: "c1", before_message_id: "m1", around_message_id: "m2",
    }, AbortSignal.timeout(5000));
    expect((result.content[0] as TextContent).text).toContain("Use only one");
  });

  test("handles empty and inaccessible results", async () => {
    const empty = await createListChannelMessagesTool(deps(() => Promise.resolve({ messages: [] })))
      .execute("tc", { channel_id: "c1" }, AbortSignal.timeout(5000));
    expect((empty.content[0] as TextContent).text).toContain("No messages");
    const missing = await createListChannelMessagesTool(deps(() => Promise.resolve(null)))
      .execute("tc", { channel_id: "c1" }, AbortSignal.timeout(5000));
    expect((missing.content[0] as TextContent).text).toContain("not found");
  });
});
