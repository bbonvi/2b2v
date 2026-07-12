import { describe, expect, test } from "bun:test";
import type { AssetReadingConfig } from "../config/types.ts";
import type { MessageAsset } from "../db/asset-repository.ts";
import { createReadAssetTool } from "./read-asset-tool.ts";

const config: AssetReadingConfig = {
  maxCharsPerRead: 5,
  textRangeBytes: 8,
  maxDownloadBytes: 1024,
  maxTranscriptionDurationSeconds: 100,
  videoPreviewMaxBytes: 1024,
  videoPreviewTimesSeconds: [0, 1],
  videoPreviewTimeoutSeconds: 1,
  timeoutSeconds: { image: 1, gif: 1, audio: 1, video: 1, text: 1, file: 1 },
};

function asset(kind: MessageAsset["kind"]): MessageAsset {
  return {
    id: 1, messageId: "m", guildId: "g", channelId: "c", sourceKind: "attachment", sourceKey: "a",
    kind, filename: `${kind}.dat`, contentType: kind === "text" ? "text/plain" : "audio/ogg",
    size: 20, width: null, height: null, durationSeconds: 10,
    extractedText: null, extractionProvider: null, extractedAt: null, createdAt: 1,
  };
}

describe("read_asset", () => {
  test("pages remote text with byte cursors", async () => {
    const source = Buffer.from("hello world");
    const tool = createReadAssetTool({
      config,
      getAsset: () => asset("text"),
      resolveSource: () => Promise.resolve({ url: "https://cdn.test/a", contentType: "text/plain", filename: "a.txt" }),
      cacheExtraction: () => {},
      prepareImage: () => Promise.reject(new Error("unused")),
      fetchFn: ((_url: string | URL | Request, init?: RequestInit) => {
        const start = Number(/bytes=(\d+)-/.exec(new Headers(init?.headers).get("range") ?? "")?.[1] ?? 0);
        const body = source.subarray(start, Math.min(source.length, start + config.textRangeBytes));
        return Promise.resolve(new Response(body, { status: 206, headers: { "content-range": `bytes ${start}-${start + body.length - 1}/${source.length}` } }));
      }) as unknown as typeof fetch,
    });
    const first = await tool.execute("one", { asset_id: "#1" });
    expect(first.content.some((part) => part.type === "text" && part.text === "File contents:\nhello")).toBeTrue();
    expect(first.details).toEqual({ assetId: 1, nextCursor: "b:5" });
    const second = await tool.execute("two", { asset_id: 1, cursor: "b:5" });
    expect(second.content.some((part) => part.type === "text" && part.text === "File contents:\n worl")).toBeTrue();
  });

  test("caches paid transcripts and paginates them", async () => {
    const record = asset("audio");
    let calls = 0;
    const tool = createReadAssetTool({
      config,
      elevenLabsApiKey: "key",
      getAsset: () => record,
      resolveSource: () => Promise.resolve({ url: "https://cdn.test/audio", contentType: "audio/ogg", filename: "voice.ogg" }),
      cacheExtraction: (_id, text, provider) => {
        record.extractedText = text;
        record.extractionProvider = provider;
      },
      prepareImage: () => Promise.reject(new Error("unused")),
      fetchFn: (() => {
        calls += 1;
        return Promise.resolve(Response.json({ text: "hello transcript" }));
      }) as unknown as typeof fetch,
    });
    const first = await tool.execute("one", { asset_id: 1 });
    expect(first.details).toEqual({ assetId: 1, nextCursor: "c:5" });
    expect(first.content.some((part) => part.type === "text" && part.text === "Transcript (ElevenLabs Scribe v2):\nhello")).toBeTrue();
    await tool.execute("two", { asset_id: 1, cursor: "c:5" });
    expect(calls).toBe(1);
    expect(record.extractionProvider).toBe("elevenlabs-scribe-v2");
  });

  test("applies the asset-kind timeout", () => {
    const tool = createReadAssetTool({
      config: { ...config, timeoutSeconds: { ...config.timeoutSeconds, audio: 0.01 } },
      elevenLabsApiKey: "key",
      getAsset: () => asset("audio"),
      resolveSource: () => Promise.resolve({ url: "https://cdn.test/audio", contentType: "audio/ogg", filename: "voice.ogg" }),
      cacheExtraction: () => {},
      prepareImage: () => Promise.reject(new Error("unused")),
      fetchFn: ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("asset read timed out"));
        }, { once: true });
      })) as unknown as typeof fetch,
    });
    return expect(Promise.resolve(tool.execute("timeout", { asset_id: 1 }))).rejects.toThrow("asset read timed out");
  });
});
