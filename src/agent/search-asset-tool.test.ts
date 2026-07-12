import { describe, expect, test } from "bun:test";
import type { AssetReadingConfig } from "../config/types.ts";
import type { MessageAsset } from "../db/asset-repository.ts";
import { createSearchAssetTool } from "./search-asset-tool.ts";

const config: AssetReadingConfig = {
  maxCharsPerRead: 30_000,
  maxDownloadBytes: 1024,
  maxTranscriptionDurationSeconds: 100,
  videoPreviewMaxBytes: 1024,
  videoPreviewTimesSeconds: [0],
  videoPreviewTimeoutSeconds: 1,
  timeoutSeconds: { image: 1, gif: 1, audio: 1, video: 1, text: 1, file: 1 },
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

describe("search_asset", () => {
  test("returns regex matches with numbered context lines", async () => {
    const tool = createSearchAssetTool({
      config,
      getAsset: () => asset,
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
    expect(result.details).toEqual({ assetId: 7, matched: true });
  });

  test("returns a clear invalid-regex error", () => {
    const tool = createSearchAssetTool({
      config,
      getAsset: () => asset,
      resolveSource: () => Promise.resolve({ url: "https://cdn.test/source", contentType: "text/plain", filename: "source.js" }),
      cacheExtraction: () => {},
      prepareImage: () => Promise.reject(new Error("unused")),
      fetchFn: (() => Promise.resolve(new Response("text"))) as unknown as typeof fetch,
    });
    return expect(Promise.resolve(tool.execute("search", { asset_id: 7, pattern: "(" }))).rejects.toThrow("Invalid regex");
  });
});
