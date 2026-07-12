import { describe, expect, test } from "bun:test";
import type { AssetReadingConfig } from "../config/types.ts";
import type { MessageAsset } from "../db/asset-repository.ts";
import { createReadAssetTool } from "./read-asset-tool.ts";

const config: AssetReadingConfig = {
  maxCharsPerRead: 100,
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
  test("reads a numbered line range from remote text", async () => {
    const source = Buffer.from("alpha\nbeta\ngamma");
    const tool = createReadAssetTool({
      config,
      getAsset: () => asset("text"),
      resolveSource: () => Promise.resolve({ url: "https://cdn.test/a", contentType: "text/plain", filename: "a.txt" }),
      cacheExtraction: () => {},
      prepareImage: () => Promise.reject(new Error("unused")),
      fetchFn: (() => Promise.resolve(new Response(source, { headers: { "content-length": String(source.length) } }))) as unknown as typeof fetch,
    });
    const result = await tool.execute("one", { asset_id: "#1", start_line: 2, line_count: 2 });
    expect(result.content.some((part) => part.type === "text" && part.text.includes("showing lines 2-3:\n2 | beta\n3 | gamma"))).toBeTrue();
    expect(result.details).toEqual({ assetId: 1, startLine: 2, endLine: 3, totalLines: 3 });
  });

  test("caches timestamped transcripts as numbered lines", async () => {
    const record = asset("audio");
    let calls = 0;
    const tool = createReadAssetTool({
      config,
      elevenLabsApiKey: "key",
      getAsset: () => record,
      resolveSource: () => Promise.resolve(calls === 0
        ? { url: "https://cdn.test/audio", contentType: "audio/ogg", filename: "voice.ogg" }
        : null),
      cacheExtraction: (_id, text, provider) => {
        record.extractedText = text;
        record.extractionProvider = provider;
      },
      prepareImage: () => Promise.reject(new Error("unused")),
      fetchFn: (() => {
        calls += 1;
        return Promise.resolve(Response.json({
          text: "hello transcript",
          words: [
            { text: "hello", start: 0, end: 0.5, type: "word" },
            { text: " ", start: 0.5, end: 0.5, type: "spacing" },
            { text: "transcript", start: 0.5, end: 1.5, type: "word" },
          ],
        }));
      }) as unknown as typeof fetch,
    });
    const first = await tool.execute("one", { asset_id: 1 });
    expect(first.details).toEqual({ assetId: 1, startLine: 1, endLine: 1, totalLines: 1 });
    expect(first.content.some((part) => part.type === "text" && part.text.includes("1 | [00:00–00:01] hello transcript"))).toBeTrue();
    await tool.execute("two", { asset_id: 1, start_line: 1 });
    expect(calls).toBe(1);
    expect(record.extractionProvider).toBe("elevenlabs-scribe-v2-timestamped");
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

  test("returns video frames when transcription fails", async () => {
    const tool = createReadAssetTool({
      config,
      elevenLabsApiKey: "key",
      getAsset: () => asset("video"),
      resolveSource: () => Promise.resolve({ url: "https://cdn.test/video", contentType: "video/mp4", filename: "clip.mp4" }),
      cacheExtraction: () => {},
      prepareImage: () => Promise.reject(new Error("unused")),
      fetchFn: (() => Promise.resolve(Response.json({ detail: { message: "invalid audio" } }, { status: 400 }))) as unknown as typeof fetch,
      extractVideoFrame: (_url, seconds) => Promise.resolve(seconds === 0 ? Buffer.from("jpeg") : null),
    });
    const result = await tool.execute("video", { asset_id: 1 });
    expect(result.content.some((part) => part.type === "text" && part.text.includes("Transcript unavailable: ElevenLabs transcription failed (400)"))).toBeTrue();
    expect(result.content.some((part) => part.type === "text" && part.text === "Video frame at 0s")).toBeTrue();
    expect(result.content.some((part) => part.type === "image")).toBeTrue();
    expect(result.details).toEqual({ assetId: 1 });
  });
});
