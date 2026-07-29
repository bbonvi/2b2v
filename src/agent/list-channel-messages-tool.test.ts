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

const location = {
  guildId: "g1",
  guildName: "Guild One",
  channelId: "c1",
  channelName: "general",
};

function deps(fetchMessages: ListChannelMessagesToolDeps["fetchMessages"] = () => Promise.resolve({ location, messages })): ListChannelMessagesToolDeps {
  return { guildId: "g1", timezone: "UTC", fetchMessages };
}

describe("list_channel_messages", () => {
  test("formats normal history grammar with MsgIDs and typed assets", async () => {
    const withAsset = message("m1", "alice", "file", Date.now(), [{
      id: 7, kind: "text", sourceKind: "attachment", filename: "x.js", contentType: "text/javascript",
      size: 100, width: null, height: null, durationSeconds: null,
    }]);
    const result = await createListChannelMessagesTool(deps(() => Promise.resolve({ location, messages: [withAsset] })))
      .execute("tc", { channel_id: "c1" }, AbortSignal.timeout(5000));
    const output = (result.content[0] as TextContent).text;
    expect(output).toContain("Channel: Guild One / #general | guild_id=g1 | channel_id=c1");
    expect(output).toContain("[@alice (MsgID: m1; Text: #7 x.js (100B))]: file");
    expect(output).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/);
    expect(result.details).toEqual({
      guild_id: "g1",
      guild_name: "Guild One",
      channel_id: "c1",
      channel_name: "general",
      count: 1,
      oldest_message_id: "m1",
      newest_message_id: "m1",
    });
  });

  test("passes anchors through without a channel", async () => {
    const seen: Array<{ channelId?: string; beforeMessageId?: string; afterMessageId?: string; aroundMessageId?: string }> = [];
    const tool = createListChannelMessagesTool(deps((input) => {
      seen.push({
        ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
        ...(input.beforeMessageId === undefined ? {} : { beforeMessageId: input.beforeMessageId }),
        ...(input.afterMessageId === undefined ? {} : { afterMessageId: input.afterMessageId }),
        ...(input.aroundMessageId === undefined ? {} : { aroundMessageId: input.aroundMessageId }),
      });
      return Promise.resolve({ location, messages: messages.slice(0, 1) });
    }));
    await tool.execute("tc", { before_message_id: "m2" }, AbortSignal.timeout(5000));
    await tool.execute("tc", { after_message_id: "m1" }, AbortSignal.timeout(5000));
    await tool.execute("tc", { around_message_id: "m1" }, AbortSignal.timeout(5000));
    await tool.execute("tc", { channel_id: "c1", around_message_id: "m1" }, AbortSignal.timeout(5000));
    expect(seen).toEqual([
      { beforeMessageId: "m2" },
      { afterMessageId: "m1" },
      { aroundMessageId: "m1" },
      { channelId: "c1", aroundMessageId: "m1" },
    ]);
  });

  test("requires a channel or one anchor", async () => {
    const missingLocation = await createListChannelMessagesTool(deps()).execute(
      "tc",
      {},
      AbortSignal.timeout(5000),
    );
    expect((missingLocation.content[0] as TextContent).text).toContain("Provide channel_id or one message anchor");

    const result = await createListChannelMessagesTool(deps()).execute("tc", {
      channel_id: "c1", before_message_id: "m1", around_message_id: "m2",
    }, AbortSignal.timeout(5000));
    expect((result.content[0] as TextContent).text).toContain("Use only one");
  });

  test("handles empty and inaccessible results", async () => {
    const empty = await createListChannelMessagesTool(deps(() => Promise.resolve({ location, messages: [] })))
      .execute("tc", { channel_id: "c1" }, AbortSignal.timeout(5000));
    expect((empty.content[0] as TextContent).text).toContain("Channel: Guild One / #general | guild_id=g1 | channel_id=c1");
    expect((empty.content[0] as TextContent).text).toContain("No messages");
    expect(empty.details).toEqual({
      guild_id: "g1",
      guild_name: "Guild One",
      channel_id: "c1",
      channel_name: "general",
      count: 0,
    });
    const missing = await createListChannelMessagesTool(deps(() => Promise.resolve(null)))
      .execute("tc", { around_message_id: "missing" }, AbortSignal.timeout(5000));
    expect((missing.content[0] as TextContent).text).toContain("not found");
  });
});
