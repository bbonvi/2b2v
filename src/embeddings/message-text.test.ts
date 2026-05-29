import { describe, expect, test } from "bun:test";
import { buildMessageEmbeddingBlocks, normalizeMessageForEmbedding } from "./message-text.ts";

describe("normalizeMessageForEmbedding", () => {
  test("keeps ordinary short text", () => {
    expect(normalizeMessageForEmbedding("ok")).toBe("ok");
    expect(normalizeMessageForEmbedding("lol")).toBe("lol");
  });

  test("normalizes discord-specific markup without usernames", () => {
    expect(normalizeMessageForEmbedding("hi <@123> <:wave:456> https://example.com/a?b=c")).toBe("hi @mention :wave: [link example.com]");
  });
});

describe("buildMessageEmbeddingBlocks", () => {
  test("merges same-author messages within gap", () => {
    const blocks = buildMessageEmbeddingBlocks([
      { id: "1", guildId: "g", channelId: "c", userId: "u", content: "first", createdAt: 1000, isBot: false },
      { id: "2", guildId: "g", channelId: "c", userId: "u", content: "second", createdAt: 2000, isBot: false },
      { id: "3", guildId: "g", channelId: "c", userId: "v", content: "third", createdAt: 3000, isBot: false },
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.id).toBe("msgblock:1:2");
    expect(blocks[0]?.text).toBe("first\nsecond");
    expect(blocks[0]?.messageIds).toEqual(["1", "2"]);
    expect(blocks[1]?.id).toBe("3");
  });

  test("splits same-author blocks before embedding text would be truncated", () => {
    const blocks = buildMessageEmbeddingBlocks([
      { id: "1", guildId: "g", channelId: "c", userId: "u", content: "a".repeat(1500), createdAt: 1000, isBot: false },
      { id: "2", guildId: "g", channelId: "c", userId: "u", content: "b".repeat(600), createdAt: 2000, isBot: false },
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.id).toBe("1");
    expect(blocks[1]?.id).toBe("2");
  });

  test("groups independent channel streams before merging", () => {
    const blocks = buildMessageEmbeddingBlocks([
      { id: "c1-a", guildId: "g", channelId: "c1", userId: "u", content: "one", createdAt: 1000, isBot: false },
      { id: "c2-a", guildId: "g", channelId: "c2", userId: "v", content: "interrupt", createdAt: 1500, isBot: false },
      { id: "c1-b", guildId: "g", channelId: "c1", userId: "u", content: "two", createdAt: 2000, isBot: false },
    ]);

    expect(blocks.map((block) => block.id)).toEqual(["msgblock:c1-a:c1-b", "c2-a"]);
  });
});
