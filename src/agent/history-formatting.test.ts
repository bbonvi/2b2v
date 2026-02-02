import { test, expect, describe } from "bun:test";
import { formatMessageLine, OLDER_LEGEND } from "./history-formatting.ts";
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
    ...overrides,
  };
}

describe("formatMessageLine", () => {
  test("plain message, no reply, no images", () => {
    const input: FormatInput = { message: msg(), reply: null, captioningEnabled: false };
    expect(formatMessageLine(input)).toBe("[@alice]: hello");
  });

  test("message with images", () => {
    const input: FormatInput = {
      message: msg({ imageIds: [12, 13] }),
      reply: null,
      captioningEnabled: false,
    };
    expect(formatMessageLine(input)).toBe("[@alice (ImageIDs: [12, 13])]: hello");
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
      quote: "earlier text",
      replyMsgId: "123",
      missingTarget: false,
      replyImageIds: [],
      replyCaptions: [],
    };
    const input: FormatInput = { message: msg(), reply, captioningEnabled: false };
    expect(formatMessageLine(input)).toBe(
      '[@alice to @bob (Quote: "earlier text"; ReplyMsgID: 123)]: hello'
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
    expect(formatMessageLine(input)).toBe("[@alice to @bob (ReplyMsgID: 123)]: hello");
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
      "[@alice to @eve (ReplyMsgID: 456; MissingTarget: true)]: hello"
    );
  });

  test("reply with image IDs on target", () => {
    const reply: ReplyContext = {
      targetAuthor: "bob",
      quote: "check this",
      replyMsgId: "100",
      missingTarget: false,
      replyImageIds: [5, 6],
      replyCaptions: [],
    };
    const input: FormatInput = { message: msg(), reply, captioningEnabled: false };
    expect(formatMessageLine(input)).toBe(
      '[@alice to @bob (Quote: "check this"; ReplyMsgID: 100; ReplyImageIDs: [5, 6])]: hello'
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
      '[@alice to @bob (ReplyMsgID: 100; ReplyImageIDs: [5]; ReplyCaptions: ["a photo"])]: hello'
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

  test("full meta key ordering: Quote, ReplyMsgID, MissingTarget, ReplyImageIDs, ReplyCaptions, ImageIDs, Captions", () => {
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
      '[@alice to @bob (Quote: "hi"; ReplyMsgID: 99; MissingTarget: true; ReplyImageIDs: [1]; ReplyCaptions: ["cat"]; ImageIDs: [10]; Captions: ["dog"])]: hello'
    );
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
    expect(OLDER_LEGEND).toContain("[DATE ...]");
    expect(OLDER_LEGEND).toContain("[msg-break]");
    expect(OLDER_LEGEND).toContain("search_messages(id)");
    expect(OLDER_LEGEND).toContain("read_images([id])");
  });
});
