import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AssetReadingConfig } from "../config/types.ts";
import type { MessageAsset } from "../db/asset-repository.ts";
import type { StagedAsset } from "../db/staged-asset-repository.ts";
import { AssetRefSchema, parseAssetRef } from "./asset-id.ts";
import { markReadOnlyTool } from "./tool-effects.ts";
import { renderTextRange, type TextLineRange } from "./text-view.ts";
import {
  cacheStatusLabel,
  type LinkCacheMode,
  type ResolvedLinkResult,
} from "./link-content.ts";

const LinkCacheModeSchema = Type.Union([
  Type.Literal("prefer"),
  Type.Literal("refresh"),
  Type.Literal("bypass"),
], {
  description: "prefer reuses available content; refresh fetches and saves a new copy; bypass fetches without saving.",
});

const ReadAssetParams = Type.Object({
  asset_id: AssetRefSchema,
  start_line: Type.Optional(Type.Integer({ minimum: 1 })),
  line_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  raw: Type.Optional(Type.Boolean({ description: "Use source markup instead of readable content." })),
  cache_mode: Type.Optional(LinkCacheModeSchema),
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
  /** Resolve byte-derived metadata persisted with a staged generated output. */
  getStagedAssetMetadata?: (jobId: string) => { actualSize?: string } | null;
  /** Render private producer metadata for generated assets, when available. */
  getProvenance?: (id: number) => string | null;
  /** Resolve visible origin metadata and confirm the bot can still access the source channel. */
  resolveOrigin: (asset: MessageAsset) => Promise<AssetOrigin | null>;
  resolveSource: (asset: MessageAsset) => Promise<ResolvedAssetSource | null>;
  cacheExtraction: (id: number, text: string, provider: string) => void;
  prepareImage: (buffer: Buffer, mimeType: string) => Promise<{ data: Buffer; mime: string; width: number; height: number }>;
  fetchFn?: typeof fetch;
  extractPdfText?: (buffer: Buffer, maxOutputBytes: number, signal?: AbortSignal) => Promise<string>;
  extractVideoFrame?: (url: string, seconds: number, timeoutSeconds: number, signal?: AbortSignal) => Promise<Buffer | null>;
  /** Resolve one lazy chat Link through the shared runtime cache. */
  resolveLink?: (input: { url: string; cacheMode?: LinkCacheMode; raw?: boolean }, signal?: AbortSignal) => Promise<ResolvedLinkResult>;
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
  return markReadOnlyTool({
    name: "read_asset",
    label: "Read Asset",
    description: "",
    parameters: ReadAssetParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<
      | { assetId: number; origin: AssetOrigin; startLine?: number; endLine?: number; totalLines?: number }
      | { assetRef: string; jobId: string }
      | {
          assetId: number;
          origin: AssetOrigin;
          resolvedKind: string;
          cacheMode: LinkCacheMode;
          cacheStatus: string;
          raw: boolean;
          startLine?: number;
          endLine?: number;
          totalLines?: number;
        }
    >> {
      const input = params as {
        asset_id: unknown;
        start_line?: number;
        line_count?: number;
        raw?: boolean;
        cache_mode?: LinkCacheMode;
      };
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
        const metadata = deps.getStagedAssetMetadata?.(staged.jobId) ?? null;
        const facts = [
          `type: ${staged.contentType}`,
          `size: ${file.size.toLocaleString("en-US")} bytes`,
          metadata?.actualSize !== undefined ? `dimensions: ${metadata.actualSize}` : "",
        ].filter((fact) => fact !== "");
        return {
          content: [
            {
              type: "text",
              text: `Staged asset: ${staged.ref} — ${staged.filename}\nJob: ${staged.jobId}\n${facts.join("; ")}\nOwner room: guild ${staged.ownerGuildId}, channel ${staged.ownerChannelId}\nExpires: ${new Date(staged.expiresAt).toISOString()}`,
            },
            { type: "image", data: image.data.toString("base64"), mimeType: image.mime },
          ],
          details: { assetRef: staged.ref, jobId: staged.jobId },
        };
      }
      const assetId = assetRef;
      const asset = deps.getAsset(assetId);
      if (asset === null) throw new Error(`Asset ${assetId} was not found.`);
      if (asset.kind !== "link" && (input.raw !== undefined || input.cache_mode !== undefined)) {
        throw new Error("raw and cache_mode apply only to Link assets.");
      }
      const origin = await deps.resolveOrigin(asset);
      if (origin === null) throw new Error(`Asset ${assetId} source channel is unavailable or inaccessible.`);
      const timeoutSignal = AbortSignal.timeout(deps.config.timeoutSeconds[asset.kind] * 1000);
      const readSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      const source = await deps.resolveSource(asset);
      readSignal.throwIfAborted();
      const cachedTextAvailable = asset.extractedText !== null
        && (asset.kind === "audio" || asset.kind === "video" || isPdfAsset(asset));
      if (source === null && !cachedTextAvailable) throw new Error(`Asset ${assetId} source is no longer available.`);
      const effectiveSource = source ?? { url: "", filename: asset.filename, contentType: asset.contentType };
      if (asset.kind === "link") {
        if (source === null) throw new Error(`Link asset ${assetId} source is no longer available.`);
        if (deps.resolveLink === undefined) throw new Error("Link reading is unavailable.");
        const resolved = await deps.resolveLink({
          url: source.url,
          cacheMode: input.cache_mode,
          raw: input.raw,
        }, readSignal);
        return await renderResolvedLink(deps, asset, origin, source, resolved, input, readSignal);
      }
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

      if (asset.kind === "text" || asset.kind === "audio" || asset.kind === "video" || isPdfAsset(asset, effectiveSource)) {
        let range: TextLineRange | null = null;
        try {
          const view = await loadAssetTextView(deps, asset, effectiveSource, readSignal);
          range = renderTextRange(view.text, input.start_line ?? 1, input.line_count ?? 200, deps.config.maxCharsPerRead);
          const viewMeta = [
            view.providerLabel,
            `${view.text.length.toLocaleString("en-US")} characters`,
            `${range.totalLines.toLocaleString("en-US")} lines`,
          ].filter((value) => value !== undefined);
          content.push({ type: "text", text: `${view.label} (${viewMeta.join("; ")}) — showing lines ${range.startLine}-${range.endLine}:\n${range.text}` });
          if (range.hasMore) content.push({ type: "text", text: `[More content exists. Request another line range only if needed.]` });
        } catch (error) {
          if (asset.kind === "text" || isPdfAsset(asset, effectiveSource) || readSignal.aborted) throw error;
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
  });
}

async function renderResolvedLink(
  deps: ReadAssetToolDeps,
  asset: MessageAsset,
  origin: AssetOrigin,
  source: ResolvedAssetSource,
  resolved: ResolvedLinkResult,
  input: {
    start_line?: number;
    line_count?: number;
    raw?: boolean;
  },
  signal: AbortSignal,
): Promise<AgentToolResult<{
  assetId: number;
  origin: AssetOrigin;
  resolvedKind: string;
  cacheMode: LinkCacheMode;
  cacheStatus: string;
  raw: boolean;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
}>> {
  const link = resolved.content;
  const header = [
    `Asset: Link #${asset.id}`,
    formatAssetOrigin(origin),
    `Link: ${link.requestedUrl}`,
    link.finalUrl !== link.requestedUrl ? `Final URL: ${link.finalUrl}` : "",
    `Resolved: ${link.kind} (${link.contentType})`,
    `Cache: ${cacheStatusLabel(resolved.cacheStatus)}`,
  ].filter((line) => line !== "").join("\n");
  const baseDetails = {
    assetId: asset.id,
    origin,
    resolvedKind: link.kind,
    cacheMode: resolved.cacheMode,
    cacheStatus: resolved.cacheStatus,
    raw: input.raw === true,
  };

  if (link.kind === "image" || link.kind === "gif") {
    return {
      content: [
        { type: "text", text: `${header}; dimensions: ${link.width}x${link.height}` },
        { type: "image", data: link.preview.toString("base64"), mimeType: link.previewMimeType },
      ],
      details: baseDetails,
    };
  }

  if (link.kind === "page" || link.kind === "text") {
    const text = input.raw === true ? link.rawText : link.readableText;
    if (text === null) {
      throw new Error(input.raw === true
        ? "Raw source is unavailable for this fetched page."
        : "Readable extraction failed. Retry with raw=true to inspect source markup.");
    }
    const range = renderTextRange(text, input.start_line ?? 1, input.line_count ?? 200, deps.config.maxCharsPerRead);
    return {
      content: [{
        type: "text",
        text: `${header}\nShowing ${input.raw === true ? "raw" : "readable"} lines ${range.startLine}-${range.endLine} of ${range.totalLines}:\n${range.text}${range.hasMore ? `\n[More content exists. Continue at start_line=${range.endLine + 1}.]` : ""}`,
      }],
      details: {
        ...baseDetails,
        startLine: range.startLine,
        endLine: range.endLine,
        totalLines: range.totalLines,
      },
    };
  }

  const mediaAsset: MessageAsset = {
    ...asset,
    kind: link.kind,
    contentType: link.contentType,
  };
  const content: Array<TextContent | ImageContent> = [{ type: "text", text: header }];
  let range: TextLineRange | null = null;
  try {
    const view = await loadAssetTextView(deps, mediaAsset, {
      ...source,
      contentType: link.contentType,
    }, signal);
    range = renderTextRange(view.text, input.start_line ?? 1, input.line_count ?? 200, deps.config.maxCharsPerRead);
    content.push({
      type: "text",
      text: `${view.label} (${view.providerLabel ?? "source"}; ${view.text.length.toLocaleString("en-US")} characters; ${range.totalLines.toLocaleString("en-US")} lines) — showing lines ${range.startLine}-${range.endLine}:\n${range.text}${range.hasMore ? `\n[More content exists. Continue at start_line=${range.endLine + 1}.]` : ""}`,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    content.push({ type: "text", text: `Transcript unavailable: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (
    link.kind === "video"
    && (input.start_line === undefined || input.start_line === 1)
    && deps.extractVideoFrame !== undefined
  ) {
    for (const seconds of deps.config.videoPreviewTimesSeconds) {
      const frame = await deps.extractVideoFrame(source.url, seconds, deps.config.videoPreviewTimeoutSeconds, signal);
      if (frame === null) continue;
      content.push({ type: "text", text: `Video frame at ${seconds}s` });
      content.push({ type: "image", data: frame.toString("base64"), mimeType: "image/jpeg" });
    }
  }
  return {
    content,
    details: range === null
      ? baseDetails
      : {
          ...baseDetails,
          startLine: range.startLine,
          endLine: range.endLine,
          totalLines: range.totalLines,
        },
  };
}

/** Materialize the searchable textual view of a text, PDF, audio, or video asset. */
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
  if (isPdfAsset(asset, source)) {
    if (asset.extractedText !== null) {
      return {
        text: asset.extractedText,
        label: "File contents",
        providerLabel: asset.extractionProvider ?? undefined,
      };
    }
    if (deps.extractPdfText === undefined) throw new Error("PDF text extraction is unavailable.");
    const buffer = await fetchAssetBuffer(deps.fetchFn ?? fetch, source.url, deps.config.maxDownloadBytes, signal);
    const text = await deps.extractPdfText(buffer, deps.config.maxDownloadBytes, signal);
    deps.cacheExtraction(asset.id, text, "poppler-pdftotext-layout");
    return { text, label: "File contents", providerLabel: "Poppler pdftotext" };
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

/** Identify a PDF without expanding the durable asset-kind contract. */
export function isPdfAsset(
  asset: Pick<MessageAsset, "kind" | "contentType" | "filename">,
  source?: Pick<ResolvedAssetSource, "contentType" | "filename">,
): boolean {
  if (asset.kind !== "file") return false;
  const contentType = (source?.contentType ?? asset.contentType)?.split(";", 1)[0]?.trim().toLowerCase();
  const filename = source?.filename ?? asset.filename;
  return contentType === "application/pdf" || filename?.toLowerCase().endsWith(".pdf") === true;
}

/** Extract bounded UTF-8 text from one PDF with Poppler. */
export async function extractPdfText(
  buffer: Buffer,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const process = Bun.spawn(
    ["pdftotext", "-layout", "-enc", "UTF-8", "-", "-"],
    {
      stdin: buffer,
      stdout: "pipe",
      stderr: "pipe",
      signal,
      maxBuffer: maxOutputBytes,
    },
  );
  const [exitCode, output, errorOutput] = await Promise.all([
    process.exited,
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
  ]);
  signal?.throwIfAborted();
  if (exitCode !== 0) {
    const detail = errorOutput.trim().slice(0, 500);
    throw new Error(`PDF text extraction failed${detail === "" ? ` (exit ${exitCode})` : `: ${detail}`}`);
  }
  const text = Buffer.from(output).toString("utf8").replace(/\f/gu, "\n\n").trim();
  if (text === "") throw new Error("PDF has no extractable text.");
  return text;
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
