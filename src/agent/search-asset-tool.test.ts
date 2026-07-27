import { describe, expect, test } from "bun:test";
import type { AssetReadingConfig } from "../config/types.ts";
import type { MessageAsset } from "../db/asset-repository.ts";
import { createSearchAssetTool } from "./search-asset-tool.ts";
import type { AssetOrigin } from "./read-asset-tool.ts";

const config: AssetReadingConfig = {
  maxCharsPerRead: 30_000,
  maxDownloadBytes: 1024,
  maxTranscriptionDurationSeconds: 100,
  videoPreviewMaxBytes: 1024,
  videoPreviewTimesSeconds: [0],
  videoPreviewTimeoutSeconds: 1,
  timeoutSeconds: { image: 1, gif: 1, audio: 1, video: 1, text: 1, file: 1, link: 1 },
};

const asset: MessageAsset = {
  id: 7,
  messageId: "m",
  guildId: "g",
  channelId: "c",
  sourceKind: "attachment",
  sourceKey: "a",
  kind: "text",
  filename: "source.js",
  contentType: "text/javascript",
  size: 32,
  width: null,
  height: null,
  durationSeconds: null,
  extractedText: null,
  extractionProvider: null,
  extractedAt: null,
  createdAt: 1,
};

const linkAsset: MessageAsset = {
  ...asset,
  id: 8,
  sourceKind: "url",
  sourceKey: "https://example.com",
  kind: "link",
  filename: null,
  contentType: null,
  size: null,
};

const pdfAsset: MessageAsset = {
  ...asset,
  id: 9,
  kind: "file",
  filename: "report.pdf",
  contentType: "application/pdf",
};

const origin: AssetOrigin = {
  guildId: "g",
  guildName: "Guild",
  channelId: "elsewhere",
  channelName: "logs",
  location: "other-channel",
};

describe("search_asset", () => {
  test("returns regex matches with numbered context lines", async () => {
    const tool = createSearchAssetTool({
      config,
      getAsset: () => asset,
      resolveOrigin: () => Promise.resolve(origin),
      resolveSource: () => Promise.resolve({ url: "https://cdn.test/source", contentType: "text/javascript", filename: "source.js" }),
      cacheExtraction: () => {},
      prepareImage: () => Promise.reject(new Error("unused")),
      fetchFn: (() => Promise.resolve(new Response("before\nrefreshToken\nafter"))) as unknown as typeof fetch,
    });
    const result = await tool.execute("search", { asset_id: "#7", pattern: "refresh(Token|Session)", context_lines: 1 });
    const text = result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
    expect(text).toContain("1-before");
    expect(text).toContain("2:refreshToken");
    expect(text).toContain("3-after");
    expect(text).toContain("Origin: Guild (g) / #logs (elsewhere); location: another channel in this guild");
    expect(result.details).toEqual({ assetId: 7, origin, matched: true });
  });

  test("returns a clear invalid-regex error", () => {
    const tool = createSearchAssetTool({
      config,
      getAsset: () => asset,
      resolveOrigin: () => Promise.resolve(origin),
      resolveSource: () => Promise.resolve({ url: "https://cdn.test/source", contentType: "text/plain", filename: "source.js" }),
      cacheExtraction: () => {},
      prepareImage: () => Promise.reject(new Error("unused")),
      fetchFn: (() => Promise.resolve(new Response("text"))) as unknown as typeof fetch,
    });
    return expect(Promise.resolve(tool.execute("search", { asset_id: 7, pattern: "(" }))).rejects.toThrow("Invalid regex");
  });

  test("searches extracted PDF text", async () => {
    const tool = createSearchAssetTool({
      config,
      getAsset: () => pdfAsset,
      resolveOrigin: () => Promise.resolve(origin),
      resolveSource: () => Promise.resolve({ url: "https://cdn.test/report", contentType: "application/pdf", filename: "report.pdf" }),
      cacheExtraction: () => {},
      prepareImage: () => Promise.reject(new Error("unused")),
      fetchFn: (() => Promise.resolve(new Response("pdf"))) as unknown as typeof fetch,
      extractPdfText: () => Promise.resolve("before\nsearchable PDF text\nafter"),
    });

    const result = await tool.execute("pdf-search", { asset_id: 9, pattern: "PDF text" });
    const output = result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
    expect(output).toContain("2:searchable PDF text");
  });

  test("searches the raw view of a Link asset", async () => {
    const tool = createSearchAssetTool({
      config,
      getAsset: () => linkAsset,
      resolveOrigin: () => Promise.resolve(origin),
      resolveSource: () => Promise.resolve({ url: linkAsset.sourceKey, contentType: null, filename: null }),
      resolveLink: (input) => Promise.resolve({
        cacheMode: input.cacheMode ?? "prefer",
        cacheStatus: "hit",
        content: {
          kind: "page",
          requestedUrl: input.url,
          finalUrl: input.url,
          contentType: "text/html",
          fetchedAt: 1,
          title: "Page",
          readableText: "visible",
          rawText: "<script>needle</script>",
          images: [],
        },
      }),
      cacheExtraction: () => {},
      prepareImage: () => Promise.reject(new Error("unused")),
    });

    const result = await tool.execute("link", { asset_id: 8, pattern: "needle", raw: true });
    const output = result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
    expect(output).toContain("Cache: hit");
    expect(output).toContain("<script>needle</script>");
    expect(result.details).toMatchObject({ assetId: 8, matched: true, cacheStatus: "hit", raw: true });
  });
});
