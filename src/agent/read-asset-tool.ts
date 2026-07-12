import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AssetReadingConfig } from "../config/types.ts";
import type { MessageAsset } from "../db/asset-repository.ts";
import { AssetIdSchema, parseAssetId } from "./asset-id.ts";

const ReadAssetParams = Type.Object({
  asset_id: AssetIdSchema,
  cursor: Type.Optional(Type.String({ description: "Opaque next cursor returned by an earlier read." })),
});

export interface ResolvedAssetSource {
  url: string;
  contentType: string | null;
  filename: string | null;
}

export interface ReadAssetToolDeps {
  config: AssetReadingConfig;
  elevenLabsApiKey?: string;
  getAsset: (id: number) => MessageAsset | null;
  resolveSource: (asset: MessageAsset) => Promise<ResolvedAssetSource | null>;
  cacheExtraction: (id: number, text: string, provider: string) => void;
  prepareImage: (buffer: Buffer, mimeType: string) => Promise<{ data: Buffer; mime: string; width: number; height: number }>;
  fetchFn?: typeof fetch;
  extractVideoFrame?: (url: string, seconds: number, timeoutSeconds: number, signal?: AbortSignal) => Promise<Buffer | null>;
}

/** Read one lazy message asset, paging large textual results with an opaque cursor. */
export function createReadAssetTool(deps: ReadAssetToolDeps): AgentTool {
  const fetchFn = deps.fetchFn ?? fetch;
  return {
    name: "read_asset",
    label: "Read Asset",
    description: "Read an image, GIF, audio, video, text, or file referenced by a typed chat asset ID.",
    parameters: ReadAssetParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ assetId: number; nextCursor?: string }>> {
      const input = params as { asset_id: unknown; cursor?: string };
      const assetId = parseAssetId(input.asset_id);
      if (assetId === null) throw new Error("asset_id must be a positive integer, optionally prefixed with #");
      const asset = deps.getAsset(assetId);
      if (asset === null) throw new Error(`Asset ${assetId} was not found.`);
      const timeoutSignal = AbortSignal.timeout(deps.config.timeoutSeconds[asset.kind] * 1000);
      const readSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      const source = await deps.resolveSource(asset);
      readSignal.throwIfAborted();
      if (source === null) throw new Error(`Asset ${assetId} source is no longer available.`);
      const filename = source.filename ?? asset.filename;
      const contentType = source.contentType ?? asset.contentType;
      const kindLabel = `${asset.kind[0]?.toUpperCase() ?? ""}${asset.kind.slice(1)}`;
      const facts = [
        contentType !== null ? `type: ${contentType}` : "",
        asset.size !== null ? `size: ${asset.size.toLocaleString("en-US")} bytes` : "",
        asset.width !== null && asset.height !== null ? `dimensions: ${asset.width}x${asset.height}` : "",
        asset.durationSeconds !== null ? `duration: ${Math.round(asset.durationSeconds * 10) / 10}s` : "",
        `source: ${asset.sourceKind}`,
      ].filter((fact) => fact !== "");
      const content: Array<TextContent | ImageContent> = [{
        type: "text",
        text: `Asset: ${kindLabel} #${asset.id}${filename !== null ? ` — ${filename}` : ""}\n${facts.join("; ")}`,
      }];

      if (asset.kind === "image" || asset.kind === "gif") {
        const buffer = await fetchAssetBuffer(fetchFn, source.url, deps.config.maxDownloadBytes, readSignal);
        const image = await deps.prepareImage(buffer, source.contentType ?? asset.contentType ?? "image/png");
        readSignal.throwIfAborted();
        content.push({ type: "image", data: image.data.toString("base64"), mimeType: image.mime });
        return { content, details: { assetId: asset.id } };
      }

      if (asset.kind === "text") {
        const page = asset.extractedText !== null
          ? pageCachedText(asset.extractedText, input.cursor, deps.config.maxCharsPerRead)
          : await pageRemoteText(fetchFn, source.url, input.cursor, deps.config, readSignal);
        readSignal.throwIfAborted();
        content.push({ type: "text", text: `File contents${page.total !== null ? ` (${page.total.toLocaleString("en-US")} ${page.unit} total)` : ""}:\n${page.text}` });
        if (page.nextCursor !== undefined) content.push({ type: "text", text: partialPageNotice(page) });
        return { content, details: { assetId: asset.id, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) } };
      }

      if (asset.kind === "audio" || asset.kind === "video") {
        let transcript = asset.extractedText;
        let transcriptProvider = asset.extractionProvider;
        if (transcript === null) {
          if (asset.durationSeconds !== null && asset.durationSeconds > deps.config.maxTranscriptionDurationSeconds) {
            throw new Error(`Asset duration ${Math.round(asset.durationSeconds)}s exceeds transcription limit ${deps.config.maxTranscriptionDurationSeconds}s.`);
          }
          if (deps.elevenLabsApiKey === undefined || deps.elevenLabsApiKey === "") throw new Error("ElevenLabs speech-to-text is not configured.");
          transcript = await transcribeElevenLabs(fetchFn, deps.elevenLabsApiKey, source.url, readSignal);
          transcriptProvider = "elevenlabs-scribe-v2";
          deps.cacheExtraction(asset.id, transcript, transcriptProvider);
        }
        const page = pageCachedText(transcript, input.cursor, deps.config.maxCharsPerRead);
        const providerLabel = transcriptProvider === "elevenlabs-scribe-v2" ? "ElevenLabs Scribe v2" : transcriptProvider;
        const transcriptMeta = [providerLabel, `${transcript.length.toLocaleString("en-US")} characters total`].filter((value) => value !== null);
        content.push({ type: "text", text: `Transcript (${transcriptMeta.join("; ")}):\n${page.text}` });
        if (page.nextCursor !== undefined) content.push({ type: "text", text: partialPageNotice(page) });
        if (
          asset.kind === "video" && input.cursor === undefined
          && (asset.size === null || asset.size <= deps.config.videoPreviewMaxBytes)
          && deps.extractVideoFrame !== undefined
        ) {
          for (const seconds of deps.config.videoPreviewTimesSeconds) {
            if (asset.durationSeconds !== null && seconds >= asset.durationSeconds) continue;
            const frame = await deps.extractVideoFrame(source.url, seconds, deps.config.videoPreviewTimeoutSeconds, readSignal);
            if (frame === null) continue;
            content.push({ type: "text", text: `Video frame at ${seconds}s` });
            content.push({ type: "image", data: frame.toString("base64"), mimeType: "image/jpeg" });
          }
        }
        return { content, details: { assetId: asset.id, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) } };
      }

      content.push({ type: "text", text: "Content reading is unsupported for this file type; metadata and reposting remain available." });
      return { content, details: { assetId: asset.id } };
    },
  };
}

function parseCursor(cursor: string | undefined, prefix: "c" | "b"): number {
  if (cursor === undefined) return 0;
  const match = new RegExp(`^${prefix}:(\\d+)$`).exec(cursor);
  if (match === null) throw new Error("Invalid cursor for this asset.");
  return Number(match[1]);
}

interface TextPage {
  text: string;
  nextCursor?: string;
  end: number;
  total: number | null;
  unit: "bytes" | "characters";
}

function partialPageNotice(page: TextPage): string {
  const progress = page.total !== null ? ` Read through ${page.end.toLocaleString("en-US")} of ${page.total.toLocaleString("en-US")} ${page.unit}.` : "";
  return `[Partial content: more remains.${progress} Continue only if needed with cursor: ${page.nextCursor ?? ""}]`;
}

function pageCachedText(text: string, cursor: string | undefined, maxChars: number): TextPage {
  const offset = parseCursor(cursor, "c");
  if (offset > text.length) throw new Error("Cursor is past end of extracted text.");
  const end = Math.min(text.length, offset + maxChars);
  return { text: text.slice(offset, end), end, total: text.length, unit: "characters", ...(end < text.length ? { nextCursor: `c:${end}` } : {}) };
}

async function pageRemoteText(
  fetchFn: typeof fetch,
  url: string,
  cursor: string | undefined,
  config: AssetReadingConfig,
  signal: AbortSignal | undefined,
): Promise<TextPage> {
  const offset = parseCursor(cursor, "b");
  const response = await fetchFn(url, {
    headers: { Range: `bytes=${offset}-${offset + config.textRangeBytes - 1}` },
    signal,
  });
  if (!response.ok && response.status !== 206) throw new Error(`Text asset fetch failed (${response.status}).`);
  const buffer = await readLimitedBody(response, config.textRangeBytes);
  let decoded = buffer.toString("utf8");
  if (decoded.endsWith("�")) decoded = decoded.slice(0, -1);
  const text = decoded.slice(0, config.maxCharsPerRead);
  const consumed = Buffer.byteLength(text, "utf8");
  const totalValue = response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]
    ?? (response.status === 200 ? response.headers.get("content-length") : null);
  const total = totalValue !== null && Number.isFinite(Number(totalValue)) ? Number(totalValue) : null;
  const nextOffset = offset + consumed;
  const hasMore = consumed > 0 && (total !== null ? nextOffset < total : buffer.length >= config.textRangeBytes || text.length < decoded.length);
  return { text, end: nextOffset, total, unit: "bytes", ...(hasMore ? { nextCursor: `b:${nextOffset}` } : {}) };
}

export async function fetchAssetBuffer(fetchFn: typeof fetch, url: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const response = await fetchFn(url, { signal });
  if (!response.ok) throw new Error(`Asset fetch failed (${response.status}).`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Asset exceeds download limit ${maxBytes} bytes.`);
  return await readLimitedBody(response, maxBytes);
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      await reader.cancel();
      throw new Error(`Asset response exceeds limit ${maxBytes} bytes.`);
    }
    chunks.push(value);
    total += value.length;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function transcribeElevenLabs(fetchFn: typeof fetch, apiKey: string, url: string, signal: AbortSignal | undefined): Promise<string> {
  const form = new FormData();
  form.set("model_id", "scribe_v2");
  form.set("cloud_storage_url", url);
  form.set("timestamps_granularity", "none");
  form.set("tag_audio_events", "true");
  const response = await fetchFn("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST", headers: { "xi-api-key": apiKey }, body: form, signal,
  });
  const result = await response.json() as { text?: unknown; detail?: unknown };
  if (!response.ok || typeof result.text !== "string") {
    throw new Error(`ElevenLabs transcription failed (${response.status}): ${JSON.stringify(result.detail ?? result).slice(0, 500)}`);
  }
  return result.text;
}

/** Extract one JPEG frame from a remotely seekable video with FFmpeg. */
export async function extractRemoteVideoFrame(
  url: string,
  seconds: number,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  signal?.throwIfAborted();
  const process = Bun.spawn([
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "https,tls,tcp",
    "-rw_timeout", String(timeoutSeconds * 1_000_000), "-ss", String(seconds), "-i", url,
    "-frames:v", "1", "-vf", "scale=1024:-2:force_original_aspect_ratio=decrease", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
  ], { stdout: "pipe", stderr: "pipe" });
  const onAbort = (): void => process.kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => process.kill(), timeoutSeconds * 1000);
  try {
    const [exitCode, output] = await Promise.all([
      process.exited,
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).arrayBuffer(),
    ]);
    signal?.throwIfAborted();
    return exitCode === 0 && output.byteLength > 0 ? Buffer.from(output) : null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
