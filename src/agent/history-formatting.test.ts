import { test, expect, describe } from "bun:test";
import { formatMessageLine, NEWER_LEGEND, OLDER_LEGEND } from "./history-formatting.ts";
import type { HistoryMessage } from "./history-types.ts";
import type { FormatInput, ReplyContext } from "./history-formatting.ts";

function msg(overrides?: Partial<HistoryMessage>): HistoryMessage {
  return {
    id: "1",
    author: "alice",
    authorId: "uid-alice",
    content: "hello",
    isBot: false,
    timestamp: 1000,
    replyToId: null,
    imageIds: [],
    captions: [],
    hasEmbeds: false,
    isSynthetic: false,
    relatedThreadId: null,
    ...overrides,
  };
}

describe("formatMessageLine", () => {
  test("plain message, no reply, no images", () => {
    const input: FormatInput = { message: msg(), reply: null, captioningEnabled: false };
    expect(formatMessageLine(input)).toBe("[@alice]: hello");
  });

  test("appends deleted marker without hiding message content", () => {
    const input: FormatInput = { message: msg({ isDeleted: true }), reply: null, captioningEnabled: false };
    expect(formatMessageLine(input)).toBe("[@alice]: hello [deleted]");
  });

  test("includes message id metadata when requested", () => {
    const input: FormatInput = { message: msg({ id: "123" }), reply: null, captioningEnabled: false, includeMessageIds: true };
    expect(formatMessageLine(input)).toBe("[@alice (MsgID: 123)]: hello");
  });

  test("includes trigger marker metadata", () => {
    const input: FormatInput = {
      message: msg({ id: "123", historyAnnotations: ["<trigger>"] }),
      reply: null,
      captioningEnabled: false,
      includeMessageIds: true,
    };
    expect(formatMessageLine(input)).toBe("[@alice (MsgID: 123; <trigger>)]: hello");
  });

  test("omits message id metadata for prompt-only rows", () => {
    const input: FormatInput = {
      message: msg({ id: "prompt-only:ignore:123", content: "<ignore>no</ignore>", isBot: true, isPromptOnly: true }),
      reply: null,
      captioningEnabled: false,
      includeMessageIds: true,
    };
    expect(formatMessageLine(input)).toBe("[@alice]: <ignore>no</ignore>");
  });

  test("includes author display name before metadata when requested", () => {
    const input: FormatInput = {
      message: msg({ id: "123", authorDisplayName: "Alice W" }),
      reply: null,
      captioningEnabled: false,
      includeMessageIds: true,
      includeDisplayNames: true,
    };
    expect(formatMessageLine(input)).toBe("[@alice (Alice W) (MsgID: 123)]: hello");
  });

  test("omits display name when it equals username", () => {
    const input: FormatInput = {
      message: msg({ id: "123", authorDisplayName: "alice" }),
      reply: null,
      captioningEnabled: false,
      includeMessageIds: true,
      includeDisplayNames: true,
    };
    expect(formatMessageLine(input)).toBe("[@alice (MsgID: 123)]: hello");
  });

  test("includes merged message ids when requested", () => {
    const input: FormatInput = {
      message: msg({ id: "1", mergedMessageIds: ["1", "2"] }),
      reply: null,
      captioningEnabled: false,
      includeMessageIds: true,
    };
    expect(formatMessageLine(input)).toBe("[@alice (MsgIDs: [1, 2])]: hello");
  });

  test("message with images", () => {
    const input: FormatInput = {
      message: msg({ imageIds: [12, 13] }),
      reply: null,
      captioningEnabled: false,
    };
    expect(formatMessageLine(input)).toBe("[@alice (ImageIDs: [12, 13])]: hello");
  });

  test("message with GIF and sticker image previews", () => {
    const input: FormatInput = {
      message: msg({ imageIds: [12, 13, 14], imageSourceKinds: ["gif", "sticker", "image"] }),
      reply: null,
      captioningEnabled: false,
    };
    expect(formatMessageLine(input)).toBe("[@alice (ImageIDs: [14]; GIFImageIDs: [12]; StickerImageIDs: [13])]: hello");
  });

  test("groups lazy assets by typed short IDs", () => {
    const input: FormatInput = {
      message: msg({ assets: [
        { id: 21, kind: "image", sourceKind: "attachment", filename: "cat.png", contentType: "image/png", size: 10, width: 20, height: 30, durationSeconds: null },
        { id: 22, kind: "audio", sourceKind: "attachment", filename: "voice.ogg", contentType: "audio/ogg", size: 40, width: null, height: null, durationSeconds: 5 },
        { id: 23, kind: "file", sourceKind: "attachment", filename: "notes.pdf", contentType: "application/pdf", size: 50, width: null, height: null, durationSeconds: null },
      ] }),
      reply: null,
      captioningEnabled: false,
    };
    expect(formatMessageLine(input)).toBe("[@alice (Images: #21 cat.png; Audio: #22 voice.ogg (5s); Files: #23 notes.pdf (50B))]: hello");
  });

  test("message with images and captions when captioning enabled", () => {
    const input: FormatInput = {
      message: msg({ imageIds: [12, 13], captions: ["red car", "street sign"] }),
      reply: null,
      captioningEnabled: true,
    };
    expect(formatMessageLine(input)).toBe(
      '[@alice (ImageIDs: [12, 13]; Captions: ["red car", "street sign"])]: hello'
    );
  });

  test("message with typed images keys captions by image ID", () => {
    const input: FormatInput = {
      message: msg({ imageIds: [12, 13], imageSourceKinds: ["gif", "sticker"], captions: ["dance", "wave"] }),
      reply: null,
      captioningEnabled: true,
    };
    expect(formatMessageLine(input)).toBe(
      '[@alice (GIFImageIDs: [12]; StickerImageIDs: [13]; CaptionByImageID: [12: "dance", 13: "wave"])]: hello'
    );
  });

  test("includes reactions only for newer history with message ids", () => {
    const message = msg({ id: "123", reactions: "👍:3 :party::1" });

    expect(formatMessageLine({
      message,
      reply: null,
      captioningEnabled: false,
      includeMessageIds: true,
    })).toBe("[@alice (MsgID: 123; Reactions: 👍:3 :party::1)]: hello");

    expect(formatMessageLine({
      message,
      reply: null,
      captioningEnabled: false,
    })).toBe("[@alice]: hello");
  });

  test("captions omitted when captioning disabled", () => {
    const input: FormatInput = {
      message: msg({ imageIds: [12], captions: ["car"] }),
      reply: null,
      captioningEnabled: false,
    };
    expect(formatMessageLine(input)).toBe("[@alice (ImageIDs: [12])]: hello");
  });

  test("reply with quote", () => {
    const reply: ReplyContext = {
      targetAuthor: "bob",
      targetDisplayName: "Bob X",
      quote: "earlier text",
      replyMsgId: "123",
      missingTarget: false,
      replyImageIds: [],
      replyCaptions: [],
    };
    const input: FormatInput = { message: msg({ authorDisplayName: "Alice W" }), reply, captioningEnabled: false, includeDisplayNames: true };
    expect(formatMessageLine(input)).toBe(
      '[@alice (Alice W) to @bob (Bob X) (Quote: "earlier text")]: hello'
    );
  });

  test("reply without quote (immediate previous)", () => {
    const reply: ReplyContext = {
      targetAuthor: "bob",
      quote: null,
      replyMsgId: "123",
      missingTarget: false,
      replyImageIds: [],
      replyCaptions: [],
    };
    const input: FormatInput = { message: msg(), reply, captioningEnabled: false };
    expect(formatMessageLine(input)).toBe("[@alice to @bob]: hello");
  });

  test("reply with missing target", () => {
    const reply: ReplyContext = {
      targetAuthor: "eve",
      quote: null,
      replyMsgId: "456",
      missingTarget: true,
      replyImageIds: [],
      replyCaptions: [],
    };
    const input: FormatInput = { message: msg(), reply, captioningEnabled: false };
    expect(formatMessageLine(input)).toBe(
      "[@alice to @eve (MissingTarget: true)]: hello"
    );
  });

  test("reply with image IDs on target", () => {
    const reply: ReplyContext = {
      targetAuthor: "bob",
      quote: "check this",
      replyMsgId: "100",
      missingTarget: false,
      replyImageIds: [5, 6],
      replyImageSourceKinds: ["gif", "sticker"],
      replyCaptions: [],
    };
    const input: FormatInput = { message: msg(), reply, captioningEnabled: false };
    expect(formatMessageLine(input)).toBe(
      '[@alice to @bob (Quote: "check this"; ReplyGIFImageIDs: [5]; ReplyStickerImageIDs: [6])]: hello'
    );
  });

  test("reply with captions on target when captioning enabled", () => {
    const reply: ReplyContext = {
      targetAuthor: "bob",
      quote: null,
      replyMsgId: "100",
      missingTarget: false,
      replyImageIds: [5],
      replyCaptions: ["a photo"],
    };
    const input: FormatInput = { message: msg(), reply, captioningEnabled: true };
    expect(formatMessageLine(input)).toBe(
      '[@alice to @bob (ReplyImageIDs: [5]; ReplyCaptions: ["a photo"])]: hello'
    );
  });

  test("reply with typed image captions keys captions by image ID", () => {
    const reply: ReplyContext = {
      targetAuthor: "bob",
      quote: null,
      replyMsgId: "100",
      missingTarget: false,
      replyImageIds: [5],
      replyImageSourceKinds: ["gif"],
      replyCaptions: ["a GIF"],
    };
    const input: FormatInput = { message: msg(), reply, captioningEnabled: true };
    expect(formatMessageLine(input)).toBe(
      '[@alice to @bob (ReplyGIFImageIDs: [5]; ReplyCaptionByImageID: [5: "a GIF"])]: hello'
    );
  });

  test("trimmed message content includes MsgID in content, not meta", () => {
    // The trimmed marker is part of the content, not the meta block
    const input: FormatInput = {
      message: msg({ content: "long text… [trimmed 180 chars; MsgID: 555]" }),
      reply: null,
      captioningEnabled: false,
    };
    expect(formatMessageLine(input)).toBe(
      "[@alice]: long text… [trimmed 180 chars; MsgID: 555]"
    );
  });

  test("full meta key ordering: Quote, MissingTarget, ReplyImageIDs, ReplyCaptions, ImageIDs, Captions", () => {
    const reply: ReplyContext = {
      targetAuthor: "bob",
      quote: "hi",
      replyMsgId: "99",
      missingTarget: true,
      replyImageIds: [1],
      replyCaptions: ["cat"],
    };
    const input: FormatInput = {
      message: msg({ imageIds: [10], captions: ["dog"] }),
      reply,
      captioningEnabled: true,
    };
    const result = formatMessageLine(input);
    expect(result).toBe(
      '[@alice to @bob (Quote: "hi"; MissingTarget: true; ReplyImageIDs: [1]; ReplyCaptions: ["cat"]; ImageIDs: [10]; Captions: ["dog"])]: hello'
    );
  });
});

describe("synthetic event formatting", () => {
  test("synthetic event outputs content directly without author prefix", () => {
    const syntheticMsg = msg({
      content: "Event: Thread created — Support Thread (channel_id: 123456)",
      isSynthetic: true,
      relatedThreadId: "123456",
    });
    const input: FormatInput = { message: syntheticMsg, reply: null, captioningEnabled: false };
    expect(formatMessageLine(input)).toBe("Event: Thread created — Support Thread (channel_id: 123456)");
  });

  test("synthetic event ignores reply context", () => {
    const syntheticMsg = msg({
      content: "Event: Thread created — Help (channel_id: 789)",
      isSynthetic: true,
      relatedThreadId: "789",
      replyToId: "some-msg", // Should be ignored
    });
    const reply: ReplyContext = {
      targetAuthor: "bob",
      quote: "ignored",
      replyMsgId: "some-msg",
      missingTarget: false,
      replyImageIds: [],
      replyCaptions: [],
    };
    const input: FormatInput = { message: syntheticMsg, reply, captioningEnabled: false };
    // Output is raw content, not formatted with reply metadata
    expect(formatMessageLine(input)).toBe("Event: Thread created — Help (channel_id: 789)");
  });
});

describe("OLDER_LEGEND", () => {
  test("contains two legend lines", () => {
    const lines = OLDER_LEGEND.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("Legend:");
    expect(lines[1]).toStartWith("Legend:");
  });

  test("mentions key concepts", () => {
    expect(OLDER_LEGEND).toContain("time markers use [...]");
    expect(OLDER_LEGEND).toContain("[msg-break]");
    expect(OLDER_LEGEND).toContain("search_channel_messages mode=\"id\"");
    expect(OLDER_LEGEND).toContain("read_asset");
  });
});

describe("NEWER_LEGEND", () => {
  test("explains volatile display names", () => {
    expect(NEWER_LEGEND).toContain("display name");
    expect(NEWER_LEGEND).toContain("not stable identity");
    expect(NEWER_LEGEND).toContain("jokes");
    expect(NEWER_LEGEND).toContain("@username for exact pings");
  });
});
