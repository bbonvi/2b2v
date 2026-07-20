import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AssetReadingConfig } from "../config/types.ts";
import type { MessageAsset } from "../db/asset-repository.ts";
import type { StagedAsset } from "../db/staged-asset-repository.ts";
import { AssetRefSchema, parseAssetRef } from "./asset-id.ts";

const ReadAssetParams = Type.Object({
  asset_id: AssetRefSchema,
  start_line: Type.Optional(Type.Integer({ minimum: 1, description: "First line to read from textual content." })),
  line_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum lines to read." })),
});

export interface ResolvedAssetSource {
  url: string;
  contentType: string | null;
  filename: string | null;
}

export type AssetOriginLocation = "current-channel" | "other-channel" | "other-guild";

export interface AssetOrigin {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  location: AssetOriginLocation;
}

export interface ReadAssetToolDeps {
  config: AssetReadingConfig;
  elevenLabsApiKey?: string;
  getAsset: (id: number) => MessageAsset | null;
  /** Resolve a durable generated output that has not yet become a Discord asset. */
  getStagedAsset?: (ref: string) => StagedAsset | null;
  /** Render private producer metadata for generated assets, when available. */
  getProvenance?: (id: number) => string | null;
  /** Resolve visible origin metadata and confirm the bot can still access the source channel. */
  resolveOrigin: (asset: MessageAsset) => Promise<AssetOrigin | null>;
  resolveSource: (asset: MessageAsset) => Promise<ResolvedAssetSource | null>;
  cacheExtraction: (id: number, text: string, provider: string) => void;
  prepareImage: (buffer: Buffer, mimeType: string) => Promise<{ data: Buffer; mime: string; width: number; height: number }>;
  fetchFn?: typeof fetch;
  extractVideoFrame?: (url: string, seconds: number, timeoutSeconds: number, signal?: AbortSignal) => Promise<Buffer | null>;
}

export interface AssetTextView {
  text: string;
  label: "File contents" | "Transcript";
  providerLabel?: string;
}

/** Render source location for model-visible asset tool output. */
export function formatAssetOrigin(origin: AssetOrigin): string {
  const location = origin.location === "current-channel"
    ? "current channel"
    : origin.location === "other-channel"
      ? "another channel in this guild"
      : "another guild";
  return `Origin: ${origin.guildName} (${origin.guildId}) / #${origin.channelName} (${origin.channelId}); location: ${location}`;
}

/** Read one lazy message asset, using line ranges for textual content. */
export function createReadAssetTool(deps: ReadAssetToolDeps): AgentTool {
  const fetchFn = deps.fetchFn ?? fetch;
  return {
    name: "read_asset",
    label: "Read Asset",
    description: "Read an image, GIF, audio, video, text, or file referenced by a permanent asset ID or staged handle.",
    parameters: ReadAssetParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<
      | { assetId: number; origin: AssetOrigin; startLine?: number; endLine?: number; totalLines?: number }
      | { assetRef: string; jobId: string }
    >> {
      const input = params as { asset_id: unknown; start_line?: number; line_count?: number };
      const assetRef = parseAssetRef(input.asset_id);
      if (assetRef === null) {
        throw new Error("asset_id must be a positive integer or staged asset handle");
      }
      if (typeof assetRef === "string") {
        const staged = deps.getStagedAsset?.(assetRef) ?? null;
        if (staged === null) throw new Error(`Staged asset ${assetRef} was not found.`);
        const timeoutSignal = AbortSignal.timeout(deps.config.timeoutSeconds.image * 1000);
        const readSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
        const file = Bun.file(staged.storagePath);
        if (!await file.exists()) throw new Error(`Staged asset ${assetRef} file is unavailable.`);
        if (file.size > deps.config.maxDownloadBytes) {
          throw new Error(`Staged asset ${assetRef} exceeds the configured read limit.`);
        }
        const image = await deps.prepareImage(
          Buffer.from(await file.arrayBuffer()),
          staged.contentType,
        );
        readSignal.throwIfAborted();
        return {
          content: [
            {
              type: "text",
              text: `Staged asset: ${staged.ref} — ${staged.filename}\nJob: ${staged.jobId}\nOwner room: guild ${staged.ownerGuildId}, channel ${staged.ownerChannelId}\nExpires: ${new Date(staged.expiresAt).toISOString()}`,
            },
            { type: "image", data: image.data.toString("base64"), mimeType: image.mime },
          ],
          details: { assetRef: staged.ref, jobId: staged.jobId },
        };
      }
      const assetId = assetRef;
      const asset = deps.getAsset(assetId);
      if (asset === null) throw new Error(`Asset ${assetId} was not found.`);
      const origin = await deps.resolveOrigin(asset);
      if (origin === null) throw new Error(`Asset ${assetId} source channel is unavailable or inaccessible.`);
      const timeoutSignal = AbortSignal.timeout(deps.config.timeoutSeconds[asset.kind] * 1000);
      const readSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      const source = await deps.resolveSource(asset);
      readSignal.throwIfAborted();
      const cachedTranscriptAvailable = (asset.kind === "audio" || asset.kind === "video") && asset.extractedText !== null;
      if (source === null && !cachedTranscriptAvailable) throw new Error(`Asset ${assetId} source is no longer available.`);
      const effectiveSource = source ?? { url: "", filename: asset.filename, contentType: asset.contentType };
      const filename = effectiveSource.filename ?? asset.filename;
      const contentType = effectiveSource.contentType ?? asset.contentType;
      const kindLabel = `${asset.kind[0]?.toUpperCase() ?? ""}${asset.kind.slice(1)}`;
      const facts = [
        contentType !== null ? `type: ${contentType}` : "",
        asset.size !== null ? `size: ${asset.size.toLocaleString("en-US")} bytes` : "",
        asset.width !== null && asset.height !== null ? `dimensions: ${asset.width}x${asset.height}` : "",
        asset.durationSeconds !== null ? `duration: ${Math.round(asset.durationSeconds * 10) / 10}s` : "",
        `source: ${asset.sourceKind}`,
      ].filter((fact) => fact !== "");
      const provenance = deps.getProvenance?.(asset.id) ?? null;
      const content: Array<TextContent | ImageContent> = [{
        type: "text",
        text: `Asset: ${kindLabel} #${asset.id}${filename !== null ? ` — ${filename}` : ""}\n${formatAssetOrigin(origin)}\n${facts.join("; ")}${provenance !== null ? `\n\nGeneration provenance:\n${provenance}` : ""}`,
      }];

      if (asset.kind === "image" || asset.kind === "gif") {
        const buffer = await fetchAssetBuffer(fetchFn, effectiveSource.url, deps.config.maxDownloadBytes, readSignal);
        const image = await deps.prepareImage(buffer, effectiveSource.contentType ?? asset.contentType ?? "image/png");
        readSignal.throwIfAborted();
        content.push({ type: "image", data: image.data.toString("base64"), mimeType: image.mime });
        return { content, details: { assetId: asset.id, origin } };
      }

      if (asset.kind === "text" || asset.kind === "audio" || asset.kind === "video") {
        let range: LineRange | null = null;
        try {
          const view = await loadAssetTextView(deps, asset, effectiveSource, readSignal);
          range = renderLineRange(view.text, input.start_line ?? 1, input.line_count ?? 200, deps.config.maxCharsPerRead);
          const viewMeta = [
            view.providerLabel,
            `${view.text.length.toLocaleString("en-US")} characters`,
            `${range.totalLines.toLocaleString("en-US")} lines`,
          ].filter((value) => value !== undefined);
          content.push({ type: "text", text: `${view.label} (${viewMeta.join("; ")}) — showing lines ${range.startLine}-${range.endLine}:\n${range.text}` });
          if (range.lineTruncated) content.push({ type: "text", text: `[A line exceeded maxCharsPerRead and was truncated; use search_asset to inspect it.]` });
          else if (range.hasMore) content.push({ type: "text", text: `[More content exists. Request another line range only if needed.]` });
        } catch (error) {
          if (asset.kind === "text" || readSignal.aborted) throw error;
          content.push({ type: "text", text: `Transcript unavailable: ${error instanceof Error ? error.message : String(error)}` });
        }
        if (
          asset.kind === "video" && (input.start_line === undefined || input.start_line === 1)
          && source !== null
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
        return { content, details: range === null
          ? { assetId: asset.id, origin }
          : { assetId: asset.id, origin, startLine: range.startLine, endLine: range.endLine, totalLines: range.totalLines } };
      }

      content.push({ type: "text", text: "Content reading is unsupported for this file type; metadata and reposting remain available." });
      return { content, details: { assetId: asset.id, origin } };
    },
  };
}

/** Materialize the searchable textual view of a text, audio, or video asset. */
export async function loadAssetTextView(
  deps: ReadAssetToolDeps,
  asset: MessageAsset,
  source: ResolvedAssetSource,
  signal: AbortSignal,
): Promise<AssetTextView> {
  if (asset.kind === "text") {
    // ponytail: buffer up to maxDownloadBytes; stream into rg if large-file memory pressure becomes real.
    const buffer = await fetchAssetBuffer(deps.fetchFn ?? fetch, source.url, deps.config.maxDownloadBytes, signal);
    return { text: buffer.toString("utf8"), label: "File contents" };
  }
  if (asset.kind !== "audio" && asset.kind !== "video") throw new Error(`Asset #${asset.id} has no searchable text.`);
  if (asset.extractedText !== null) {
    return {
      text: normalizeCachedTranscript(asset.extractedText),
      label: "Transcript",
      providerLabel: asset.extractionProvider?.startsWith("elevenlabs-scribe-v2") === true ? "ElevenLabs Scribe v2" : asset.extractionProvider ?? undefined,
    };
  }
  if (asset.durationSeconds !== null && asset.durationSeconds > deps.config.maxTranscriptionDurationSeconds) {
    throw new Error(`Asset duration ${Math.round(asset.durationSeconds)}s exceeds transcription limit ${deps.config.maxTranscriptionDurationSeconds}s.`);
  }
  if (deps.elevenLabsApiKey === undefined || deps.elevenLabsApiKey === "") throw new Error("ElevenLabs speech-to-text is not configured.");
  const transcript = await transcribeElevenLabs(deps.fetchFn ?? fetch, deps.elevenLabsApiKey, source.url, signal);
  deps.cacheExtraction(asset.id, transcript, "elevenlabs-scribe-v2-timestamped");
  return { text: transcript, label: "Transcript", providerLabel: "ElevenLabs Scribe v2" };
}

interface LineRange {
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  hasMore: boolean;
  lineTruncated: boolean;
}

function renderLineRange(text: string, requestedStart: number, requestedCount: number, maxChars: number): LineRange {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (requestedStart > lines.length) throw new Error(`start_line ${requestedStart} exceeds the ${lines.length} available lines.`);
  const startLine = requestedStart;
  const selected: string[] = [];
  let endLine = startLine - 1;
  let chars = 0;
  let lineTruncated = false;
  for (let index = startLine - 1; index < lines.length && selected.length < requestedCount; index += 1) {
    const prefix = `${index + 1} | `;
    const line = lines[index] ?? "";
    const available = maxChars - chars - prefix.length - (selected.length > 0 ? 1 : 0);
    if (available <= 0) break;
    lineTruncated = line.length > available;
    const rendered = lineTruncated ? `${prefix}${line.slice(0, Math.max(0, available - 18))}… [line truncated]` : `${prefix}${line}`;
    selected.push(rendered);
    chars += rendered.length + 1;
    endLine = index + 1;
    if (lineTruncated) break;
  }
  return {
    text: selected.join("\n"),
    startLine,
    endLine: Math.max(startLine, endLine),
    totalLines: lines.length,
    hasMore: lineTruncated || endLine < lines.length,
    lineTruncated,
  };
}

export async function fetchAssetBuffer(fetchFn: typeof fetch, url: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const response = await fetchFn(url, { signal });
  if (!response.ok) throw new Error(`Asset fetch failed (${response.status}).`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Asset exceeds download limit ${maxBytes} bytes.`);
  return await readLimitedResponseBody(response, maxBytes);
}

/** Read a response body without buffering beyond the configured byte limit. */
export async function readLimitedResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (response.body === null) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`Asset response exceeds limit ${maxBytes} bytes.`);
    return buffer;
  }
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
  form.set("timestamps_granularity", "word");
  form.set("tag_audio_events", "true");
  const response = await fetchFn("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST", headers: { "xi-api-key": apiKey }, body: form, signal,
  });
  const result = await response.json() as { text?: unknown; words?: unknown; detail?: unknown };
  if (!response.ok || typeof result.text !== "string") {
    throw new Error(`ElevenLabs transcription failed (${response.status}): ${JSON.stringify(result.detail ?? result).slice(0, 500)}`);
  }
  return formatTimestampedTranscript(result.text, result.words);
}

interface TranscriptWord {
  text: string;
  start: number;
  end: number;
  type: string;
}

function formatTimestampedTranscript(text: string, words: unknown): string {
  if (!Array.isArray(words)) return normalizeCachedTranscript(text);
  const valid = words.filter((value): value is Record<string, unknown> => value !== null && typeof value === "object")
    .map((value): TranscriptWord | null => typeof value.text === "string"
      && typeof value.start === "number" && Number.isFinite(value.start)
      && typeof value.end === "number" && Number.isFinite(value.end)
      ? { text: value.text, start: value.start, end: value.end, type: typeof value.type === "string" ? value.type : "word" }
      : null)
    .filter((value): value is TranscriptWord => value !== null);
  if (valid.length === 0) return normalizeCachedTranscript(text);

  const segments: string[] = [];
  let segmentText = "";
  let segmentStart = valid[0]?.start ?? 0;
  let segmentEnd = segmentStart;
  const flush = (): void => {
    const clean = segmentText.replace(/\s+/g, " ").trim();
    if (clean !== "") segments.push(`[${formatTimestamp(segmentStart)}–${formatTimestamp(segmentEnd)}] ${clean}`);
    segmentText = "";
  };
  for (const word of valid) {
    if (segmentText === "") segmentStart = word.start;
    if (word.type !== "spacing" && segmentText !== "" && !/\s$/u.test(segmentText) && !/^[,.;:!?…)}\]]/u.test(word.text)) {
      segmentText += " ";
    }
    segmentText += word.text;
    segmentEnd = word.end;
    const duration = segmentEnd - segmentStart;
    if ((duration >= 12 && /[.!?…]["')\]]?$/u.test(word.text)) || duration >= 20) flush();
  }
  flush();
  return segments.join("\n");
}

function normalizeCachedTranscript(text: string): string {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (clean.includes("\n") || clean.length <= 500) return clean;
  const words = clean.split(/\s+/u);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line !== "" && line.length + word.length + 1 > 500) {
      lines.push(line);
      line = word;
    } else {
      line += `${line !== "" ? " " : ""}${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines.join("\n");
}

function formatTimestamp(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
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
