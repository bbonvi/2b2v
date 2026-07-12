import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { DEFAULT_EXTERNAL_IMAGES } from "../config/defaults.ts";
import type { ExternalImagesConfig } from "../config/types.ts";
import { loadExternalImage, type ExternalImageLoaderDeps } from "./external-image.ts";

export interface FetchImagesToolDeps extends ExternalImageLoaderDeps, Partial<ExternalImagesConfig> {}

const FetchImagesParams = Type.Object({
  urls: Type.Array(Type.String(), { description: "Array of image URLs to fetch." }),
});

interface FetchResult {
  url: string;
  success: boolean;
  finalUrl?: string;
  kind?: "image" | "gif";
  contentType?: string;
  preview?: "image" | "first frame";
  width?: number;
  height?: number;
  error?: string;
}

/** Create an ephemeral external-image inspection tool. */
export function createFetchImagesTool(deps: FetchImagesToolDeps = {}): AgentTool {
  const config: ExternalImagesConfig = {
    maxImagesPerCall: deps.maxImagesPerCall ?? DEFAULT_EXTERNAL_IMAGES.maxImagesPerCall,
    maxBytes: deps.maxBytes ?? DEFAULT_EXTERNAL_IMAGES.maxBytes,
    timeoutMs: deps.timeoutMs ?? DEFAULT_EXTERNAL_IMAGES.timeoutMs,
    maxRedirects: deps.maxRedirects ?? DEFAULT_EXTERNAL_IMAGES.maxRedirects,
    maxDimension: deps.maxDimension ?? DEFAULT_EXTERNAL_IMAGES.maxDimension,
    maxPageImages: deps.maxPageImages ?? DEFAULT_EXTERNAL_IMAGES.maxPageImages,
  };
  return {
    name: "fetch_images",
    label: "Fetch Images",
    description: "Fetch external images by URL for visual inspection.",
    parameters: FetchImagesParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ fetched: number; failed: number; results: FetchResult[] }>> {
      const { urls } = params as { urls: string[] };
      if (urls.length > config.maxImagesPerCall) {
        throw new Error(`Too many URLs requested (${urls.length}); maximum is ${config.maxImagesPerCall} per call.`);
      }
      const content: Array<TextContent | ImageContent> = [];
      const results: FetchResult[] = [];
      for (const url of urls) {
        try {
          const image = await loadExternalImage(url, config, deps, signal);
          const summary: FetchResult = {
            url,
            success: true,
            finalUrl: image.finalUrl,
            kind: image.kind,
            contentType: image.originalMimeType,
            preview: image.kind === "gif" ? "first frame" : "image",
            width: image.width,
            height: image.height,
          };
          results.push(summary);
          content.push({ type: "text", text: JSON.stringify(summary) });
          content.push({ type: "image", data: image.preview.toString("base64"), mimeType: image.previewMimeType });
        } catch (cause) {
          const error = cause instanceof Error && cause.name === "TimeoutError"
            ? `Request timed out after ${config.timeoutMs}ms`
            : cause instanceof Error ? cause.message : String(cause);
          const summary = { url, success: false, error } satisfies FetchResult;
          results.push(summary);
          content.push({ type: "text", text: JSON.stringify(summary) });
        }
      }
      const fetched = results.filter(({ success }) => success).length;
      return { content, details: { fetched, failed: results.length - fetched, results } };
    },
  };
}
