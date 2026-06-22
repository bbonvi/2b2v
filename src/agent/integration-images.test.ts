import { describe, test, expect, beforeEach } from "bun:test";
import { createDatabase, type Database } from "../db/database.ts";
import { insertImage, getImageById } from "../db/image-repository.ts";
import { createReadChatImagesTool, type ReadChatImagesToolDeps } from "./read-chat-images-tool.ts";
import { fetchMissingReplyTargets, type ReplyFallbackDeps, type FetchedDiscordMessage } from "./reply-target-fallback.ts";
import { assembleContext, contextToSystemPrompt } from "./context-assembly.ts";
import type { HistoryMessage } from "./history-types.ts";
import type { IncomingMessage } from "./handler.ts";

const GUILD_ID = "g-integ";
const CHANNEL_ID = "ch-integ";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertTestImage(db: Database, messageId: string, overrides: Partial<Parameters<typeof insertImage>[1]> = {}) {
  return insertImage(db, {
    messageId,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    path: "/tmp/test/fake.jpg",
    mime: "image/jpeg",
    width: 640,
    height: 480,
    createdAt: Date.now(),
    ...overrides,
  });
}

function makeMsg(overrides: Partial<HistoryMessage> & { id: string }): HistoryMessage {
  return {
    author: "user",
    authorId: "u1",
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

// ---------------------------------------------------------------------------
// 1. read_chat_images tool with real SQLite
// ---------------------------------------------------------------------------
describe("read_chat_images tool with real DB", () => {
  test("retrieves images inserted via image-repository", async () => {
    const img1 = insertTestImage(db, "msg-1", { path: "/tmp/test/1.jpg" });
    const img2 = insertTestImage(db, "msg-1", { path: "/tmp/test/2.jpg", width: 320, height: 240 });

    const fakeFiles = new Map<string, Buffer>([
      ["/tmp/test/1.jpg", Buffer.from("data-1")],
      ["/tmp/test/2.jpg", Buffer.from("data-2")],
    ]);

    const deps: ReadChatImagesToolDeps = {
      imageReadMaxPerCall: 10,
      getImageById: (id: number) => {
        const rec = getImageById(db, id);
        return rec !== null ? { id: rec.id, mime: rec.mime, width: rec.width, height: rec.height, path: rec.path } : null;
      },
      readFile: (path: string) => fakeFiles.get(path) ?? null,
      prepareImageForContext: (buffer: Buffer) => Promise.resolve({
        data: buffer,
        mime: "image/jpeg",
        width: 256,
        height: 192,
      }),
    };

    const tool = createReadChatImagesTool(deps);
    const result = await tool.execute("c1", { image_ids: [img2.id, img1.id] });

    // Tool returns alternating text (metadata) + image (data) content items
    // For 2 images: [text, image, text, image]
    expect(result.content).toHaveLength(4);

    // First image metadata (img2)
    const meta1 = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as Record<string, unknown>;
    expect(meta1.id).toBe(img2.id);
    expect(meta1.width).toBe(256);

    // First image data (img2)
    const img2Data = result.content[1] as { type: "image"; data: string; mimeType: string };
    expect(img2Data.type).toBe("image");
    expect(img2Data.data).toBe(Buffer.from("data-2").toString("base64"));

    // Second image metadata (img1)
    const meta2 = JSON.parse((result.content[2] as { type: "text"; text: string }).text) as Record<string, unknown>;
    expect(meta2.id).toBe(img1.id);
    expect(meta2.width).toBe(256);

    // Second image data (img1)
    const img1Data = result.content[3] as { type: "image"; data: string; mimeType: string };
    expect(img1Data.type).toBe("image");
    expect(img1Data.data).toBe(Buffer.from("data-1").toString("base64"));
  });

  test("returns not_found for IDs not in DB", async () => {
    const deps: ReadChatImagesToolDeps = {
      imageReadMaxPerCall: 10,
      getImageById: (id: number) => {
        const rec = getImageById(db, id);
        return rec !== null ? { id: rec.id, mime: rec.mime, width: rec.width, height: rec.height, path: rec.path } : null;
      },
      readFile: () => null,
      prepareImageForContext: (buffer: Buffer) => Promise.resolve({
        data: buffer,
        mime: "image/jpeg",
        width: 256,
        height: 192,
      }),
    };

    const tool = createReadChatImagesTool(deps);
    const result = await tool.execute("c2", { image_ids: [9999] });

    // For not_found, only a text content item with error is returned (no image)
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as Record<string, unknown>;
    expect(parsed.id).toBe(9999);
    expect(parsed.error).toBe("not_found");
  });

  test("image IDs are sequential across messages", () => {
    const img1 = insertTestImage(db, "msg-1");
    const img2 = insertTestImage(db, "msg-2");
    const img3 = insertTestImage(db, "msg-1");

    expect(img2.id).toBe(img1.id + 1);
    expect(img3.id).toBe(img2.id + 1);
  });
});

// ---------------------------------------------------------------------------
// 2. Discord fallback persists and tool can read afterward
// ---------------------------------------------------------------------------
describe("Discord fallback → read_chat_images integration", () => {
  test("fetched reply target with image attachments persists message to DB", async () => {
    const processedImages: Array<{ url: string; messageId: string }> = [];

    const fetched: FetchedDiscordMessage = {
      id: "target-99",
      authorId: "u-remote",
      authorUsername: "remoteuser",
      content: "check this photo",
      timestamp: 500,
      isBot: false,
      replyToId: null,
      attachments: [
        { url: "https://cdn.example.com/photo.jpg", contentType: "image/jpeg" },
      ],
    };

    const deps: ReplyFallbackDeps = {
      db,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      fetchDiscordMessage: (_ch, id) => id === "target-99" ? Promise.resolve(fetched) : Promise.resolve(null),
      enqueueEmbedding: () => Promise.resolve(),
      processImage: (url, _ct, msgId) => {
        processedImages.push({ url, messageId: msgId });
        return Promise.resolve();
      },
    };

    const messages = [makeMsg({ id: "msg-1", replyToId: "target-99" })];
    const result = await fetchMissingReplyTargets(deps, messages);

    // Fetched message returned
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("target-99");
    expect(result[0]?.content).toBe("check this photo");

    // Persisted in DB
    const row = db.raw.prepare("SELECT * FROM messages WHERE id = ?").get("target-99") as Record<string, unknown>;
    expect(row).not.toBeNull();
    expect(row.guild_id).toBe(GUILD_ID);
    expect(row.channel_id).toBe(CHANNEL_ID);
    expect(row.author_username).toBe("remoteuser");

    // Image attachment processed
    expect(processedImages).toHaveLength(1);
    expect(processedImages[0]?.url).toBe("https://cdn.example.com/photo.jpg");
    expect(processedImages[0]?.messageId).toBe("target-99");
  });

  test("multiple missing targets fetched and all persisted", async () => {
    const remoteMessages = new Map<string, FetchedDiscordMessage>([
      ["t-1", {
        id: "t-1", authorId: "u1", authorUsername: "alice",
        content: "first", timestamp: 100, isBot: false, replyToId: null, attachments: [],
      }],
      ["t-2", {
        id: "t-2", authorId: "u2", authorUsername: "bob",
        content: "second", timestamp: 200, isBot: false, replyToId: null, attachments: [],
      }],
    ]);

    const deps: ReplyFallbackDeps = {
      db,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      fetchDiscordMessage: (_ch, id) => Promise.resolve(remoteMessages.get(id) ?? null),
      enqueueEmbedding: () => Promise.resolve(),
      processImage: () => Promise.resolve(),
    };

    const messages = [
      makeMsg({ id: "m1", replyToId: "t-1" }),
      makeMsg({ id: "m2", replyToId: "t-2" }),
    ];

    const result = await fetchMissingReplyTargets(deps, messages);
    expect(result).toHaveLength(2);

    // Both persisted
    const r1 = db.raw.prepare("SELECT id FROM messages WHERE id = ?").get("t-1") as { id: string } | null;
    const r2 = db.raw.prepare("SELECT id FROM messages WHERE id = ?").get("t-2") as { id: string } | null;
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. No inline images in context
// ---------------------------------------------------------------------------
describe("no inline images in context", () => {
  test("IncomingMessage type has no images field", () => {
    // Structural check: IncomingMessage should not carry image data
    const msg: IncomingMessage = {
      content: "hello",
      authorId: "u1",
      authorUsername: "testuser",
      botUserId: "bot1",
      mentionedUserIds: [],
      translatedContent: "hello",
    };

    // If images existed on the type, this would be a compile-time check.
    // At runtime, verify the object has no image-related keys.
    expect("images" in msg).toBe(false);
    expect("imageBlocks" in msg).toBe(false);
    expect("imagePayloads" in msg).toBe(false);
  });

  test("assembled context contains no inline image data", () => {
    const ctx = assembleContext({
      toolInstructions: "Use tools wisely.",
      instructions: "",
      emojis: ":wave: — greeting",
      members: "@alice — Alice",
      memories: "",
      discordContext: "",
      upcomingSchedules: "",
      threadsInChat: "",
      parentPreContext: "",
      olderHistory: "[@alice (ImageIDs: [1, 2])]: check these photos",
      newerHistory: "[@bob (ImageIDs: [3])]: nice pics",
      currentContext: "Channel: #general",
      responseInstruction: "",
      userMessage: "[@carol (ImageIDs: [4])]: what about this one?",
    });

    const systemPrompt = contextToSystemPrompt(ctx);

    // Context references image IDs but never contains base64 or binary image data
    expect(systemPrompt).toContain("ImageIDs: [1, 2]");
    expect(systemPrompt).toContain("ImageIDs: [3]");
    expect(systemPrompt).not.toContain("data:image");
    expect(systemPrompt).not.toContain("base64,");

    // User message also references IDs only
    expect(ctx.userMessage).toContain("ImageIDs: [4]");
    expect(ctx.userMessage).not.toContain("data:image");
  });

  test("context sections carry no image content blocks", () => {
    const ctx = assembleContext({
      toolInstructions: "Tools",
      instructions: "",
      emojis: "",
      members: "",
      memories: "",
      discordContext: "",
      upcomingSchedules: "",
      threadsInChat: "",
      parentPreContext: "",
      olderHistory: "",
      newerHistory: "[@user (ImageIDs: [5])]: look at this",
      currentContext: "",
      responseInstruction: "",
      userMessage: "test",
    });

    // Every section is pure text — no image content blocks
    for (const section of ctx.sections) {
      expect(typeof section.text).toBe("string");
      expect(section.text).not.toContain("data:image");
      // Ensure no binary-looking data leaked in
      // eslint-disable-next-line no-control-regex
      expect(section.text).not.toMatch(/[\x00-\x08\x0E-\x1F]/);
    }
  });
});
