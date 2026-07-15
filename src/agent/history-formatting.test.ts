import { describe, expect, test } from "bun:test";
import { formatMessageLine, NEWER_LEGEND, OLDER_LEGEND, type ReplyContext } from "./history-formatting.ts";
import type { HistoryMessage } from "./history-types.ts";

function message(overrides: Partial<HistoryMessage> = {}): HistoryMessage {
  return {
    id: "1",
    author: "alice",
    authorId: "uid-alice",
    content: "hello",
    isBot: false,
    timestamp: 1_000,
    replyToId: null,
    hasEmbeds: false,
    isSynthetic: false,
    relatedThreadId: null,
    ...overrides,
  };
}

describe("formatMessageLine", () => {
  test("formats plain, deleted, and merged messages", () => {
    expect(formatMessageLine({ message: message(), reply: null })).toBe("[@alice]: hello");
    expect(formatMessageLine({ message: message({ isDeleted: true }), reply: null })).toBe("[@alice]: hello [deleted]");
    expect(formatMessageLine({
      message: message({ mergedMessageIds: ["1", "2"] }),
      reply: null,
      includeMessageIds: true,
    })).toBe("[@alice (MsgIDs: [1, 2])]: hello");
  });

  test("omits IDs for prompt-only rows and scopes reactions to newer history", () => {
    expect(formatMessageLine({
      message: message({ id: "prompt-only:1", isPromptOnly: true }),
      reply: null,
      includeMessageIds: true,
    })).toBe("[@alice]: hello");
    expect(formatMessageLine({
      message: message({ id: "123", reactions: "👍:1" }),
      reply: null,
      includeMessageIds: true,
    })).toBe("[@alice (MsgID: 123; Reactions: 👍:1)]: hello");
    expect(formatMessageLine({
      message: message({ id: "123", reactions: "👍:1" }),
      reply: null,
    })).toBe("[@alice]: hello");
  });

  test("formats display names, replies, and annotations", () => {
    const reply: ReplyContext = {
      targetAuthor: "bob",
      targetDisplayName: "Bob X",
      quote: "earlier text",
      replyMsgId: "123",
      missingTarget: false,
    };
    expect(formatMessageLine({
      message: message({ authorDisplayName: "Alice W", historyAnnotations: ["<trigger>"] }),
      reply,
      includeMessageIds: true,
      includeDisplayNames: true,
    })).toBe('[@alice (Alice W) to @bob (Bob X) (MsgID: 1; Quote: "earlier text"; <trigger>)]: hello');
  });

  test("groups lazy assets by type", () => {
    expect(formatMessageLine({
      message: message({ assets: [
        { id: 21, kind: "image", sourceKind: "attachment", filename: "cat.png", contentType: "image/png", size: 10, width: 20, height: 30, durationSeconds: null, jobId: "img-abc123" },
        { id: 22, kind: "audio", sourceKind: "attachment", filename: "voice.ogg", contentType: "audio/ogg", size: 40, width: null, height: null, durationSeconds: 5 },
        { id: 23, kind: "file", sourceKind: "attachment", filename: "notes.pdf", contentType: "application/pdf", size: 50, width: null, height: null, durationSeconds: null },
      ] }),
      reply: null,
    })).toBe("[@alice (Images: #21 cat.png [Job img-abc123]; Audio: #22 voice.ogg (5s); Files: #23 notes.pdf (50B))]: hello");
  });

  test("formats reply assets and missing targets", () => {
    const reply: ReplyContext = {
      targetAuthor: "unknown",
      quote: null,
      replyMsgId: "missing",
      missingTarget: true,
      replyAssets: [{ id: 8, kind: "gif", sourceKind: "embed", filename: null, contentType: null, size: null, width: 100, height: 100, durationSeconds: null }],
    };
    expect(formatMessageLine({ message: message(), reply })).toBe("[@alice to @unknown (MissingTarget: true; ReplyGIFs: #8)]: hello");
  });

  test("renders synthetic events directly", () => {
    const synthetic = message({ content: "Event: Thread created", isSynthetic: true });
    expect(formatMessageLine({ message: synthetic, reply: null })).toBe("Event: Thread created");
  });
});

describe("history legends", () => {
  test("describe IDs, assets, and volatile display names", () => {
    expect(OLDER_LEGEND).toContain("read_asset");
    expect(NEWER_LEGEND).toContain("display name");
    expect(NEWER_LEGEND).toContain("Images/GIFs/Audio/Video/Text/Files");
  });
});
