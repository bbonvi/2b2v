import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentFetchLike } from "./summarize-content.ts";
import { DEFAULT_EXTERNAL_IMAGES } from "../config/defaults.ts";
import type { ExternalImagesConfig } from "../config/types.ts";
import {
  LinkContentCache,
  cacheStatusLabel,
  resolveLinkContent,
  type LinkCacheMode,
  type LinkCacheStatus,
  type ResolvedLinkContent,
  type ResolvedLinkKind,
  type ResolvedPageLink,
  type ResolvedTextLink,
} from "./link-content.ts";
import { markReadOnlyTool } from "./tool-effects.ts";
import { renderTextRange, searchTextView } from "./text-view.ts";

export interface FetchUrlToolDeps {
  /** Maximum model-visible characters returned per call. Default: 16000. */
  maxContentLength?: number;
  /** Maximum downloaded page or text body. Default: 10 MiB. */
  maxResponseBytes?: number;
  /** Request timeout in ms. Default: 15000. */
  timeoutMs?: number;
  fetchFn?: AgentFetchLike;
  maxPageImages?: number;
  externalImages?: ExternalImagesConfig;
  cache?: LinkContentCache;
}

interface FetchUrlDetails {
  requestedUrl: string;
  finalUrl: string;
  resolvedKind: ResolvedLinkKind;
  cacheMode: LinkCacheMode;
  cacheStatus: LinkCacheStatus;
  raw: boolean;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  matched?: boolean;
}

const CacheModeSchema = Type.Union([
  Type.Literal("prefer"),
  Type.Literal("refresh"),
  Type.Literal("bypass"),
], {
  description: "prefer reuses available content; refresh fetches and saves a new copy; bypass fetches without saving.",
});

const FetchUrlParams = Type.Object({
  url: Type.String(),
  start_line: Type.Optional(Type.Integer({ minimum: 1 })),
  line_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  context_lines: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
  max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  raw: Type.Optional(Type.Boolean({ description: "Use source markup instead of readable content." })),
  cache_mode: Type.Optional(CacheModeSchema),
});

/** Read, paginate, or regex-search one exact URL. */
export function createFetchUrlTool(deps: FetchUrlToolDeps = {}): AgentTool {
  const maxContentLength = deps.maxContentLength ?? 16_000;
  const externalImages = deps.externalImages ?? DEFAULT_EXTERNAL_IMAGES;
  const cache = deps.cache ?? new LinkContentCache();
  return markReadOnlyTool({
    name: "fetch_url",
    label: "fetch_url",
    description: "Read or search an exact URL in bounded ranges.",
    parameters: FetchUrlParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<FetchUrlDetails>> {
      const input = params as {
        url: string;
        start_line?: number;
        line_count?: number;
        pattern?: string;
        context_lines?: number;
        max_results?: number;
        raw?: boolean;
        cache_mode?: LinkCacheMode;
      };
      if (input.pattern !== undefined && (input.start_line !== undefined || input.line_count !== undefined)) {
        throw new Error("pattern cannot be combined with start_line or line_count");
      }
      let resolved;
      try {
        resolved = await resolveLinkContent({
          cache,
          externalImages,
          fetchFn: deps.fetchFn,
          timeoutMs: deps.timeoutMs,
          maxResponseBytes: deps.maxResponseBytes,
          maxPageImages: deps.maxPageImages,
        }, {
          url: input.url,
          cacheMode: input.cache_mode,
          raw: input.raw,
        }, signal);
      } catch (error) {
        throw new Error(`fetch_url failed for ${input.url}: ${error instanceof Error ? error.message : String(error)}`);
      }

      const content = resolved.content;
      const header = [
        `Link: ${content.requestedUrl}`,
        content.finalUrl !== content.requestedUrl ? `Final URL: ${content.finalUrl}` : "",
        `Resolved: ${content.kind} (${content.contentType})`,
        `Cache: ${cacheStatusLabel(resolved.cacheStatus)}`,
      ].filter((line) => line !== "");
      const baseDetails = {
        requestedUrl: content.requestedUrl,
        finalUrl: content.finalUrl,
        resolvedKind: content.kind,
        cacheMode: resolved.cacheMode,
        cacheStatus: resolved.cacheStatus,
        raw: input.raw === true,
      } satisfies Omit<FetchUrlDetails, "startLine" | "endLine" | "totalLines" | "matched">;

      if (content.kind === "image" || content.kind === "gif") {
        return {
          content: [
            { type: "text", text: `${header.join("\n")}; dimensions: ${content.width}x${content.height}` },
            { type: "image", data: content.preview.toString("base64"), mimeType: content.previewMimeType },
          ],
          details: baseDetails,
        };
      }
      if (content.kind === "audio" || content.kind === "video") {
        return {
          content: [{ type: "text", text: header.join("\n") }],
          details: baseDetails,
        };
      }

      if (!isTextLink(content)) throw new Error("Resolved content is not text-readable.");
      const text = selectTextView(content, input.raw === true);
      if (input.pattern !== undefined) {
        const contextLines = input.context_lines ?? 2;
        const maxResults = input.max_results ?? 10;
        const result = await searchTextView(
          text,
          input.pattern,
          contextLines,
          maxResults,
          maxContentLength,
          signal ?? new AbortController().signal,
        );
        return {
          content: [{
            type: "text",
            text: `${header.join("\n")}\nView: ${input.raw === true ? "raw" : "readable"}\nRegex: ${JSON.stringify(input.pattern)}\n${result ?? "No matches."}`,
          }],
          details: { ...baseDetails, matched: result !== null },
        };
      }

      const range = renderTextRange(text, input.start_line ?? 1, input.line_count ?? 200, maxContentLength);
      const pageImages = input.raw !== true && range.startLine === 1 && content.kind === "page"
        ? renderPageImages(content.images)
        : "";
      return {
        content: [{
          type: "text",
          text: `${header.join("\n")}\nShowing ${input.raw === true ? "raw" : "readable"} lines ${range.startLine}-${range.endLine} of ${range.totalLines}:\n${range.text}${range.hasMore ? `\n[More content exists. Continue at start_line=${range.endLine + 1}.]` : ""}${pageImages}`,
        }],
        details: {
          ...baseDetails,
          startLine: range.startLine,
          endLine: range.endLine,
          totalLines: range.totalLines,
        },
      };
    },
  });
}

function selectTextView(
  content: ResolvedPageLink | ResolvedTextLink,
  raw: boolean,
): string {
  if (raw) {
    if (content.rawText === null) throw new Error("Raw source is unavailable for this fetched page.");
    return content.rawText;
  }
  if (content.readableText === null) {
    throw new Error("Readable extraction failed. Retry with raw=true to inspect source markup.");
  }
  return content.readableText;
}

function isTextLink(content: ResolvedLinkContent): content is ResolvedPageLink | ResolvedTextLink {
  return content.kind === "page" || content.kind === "text";
}

function renderPageImages(images: readonly { url: string; alt: string }[]): string {
  if (images.length === 0) return "";
  const lines = images.map((image, index) => `${index + 1}. ${image.alt !== "" ? JSON.stringify(image.alt) : "Image"} — ${image.url}`);
  return `\n\nPage images:\n${lines.join("\n")}`;
}
