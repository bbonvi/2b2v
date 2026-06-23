import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { prepareImageBufferForContext } from "../db/image-ingest.ts";

/** Minimal fetch-like function signature for testability. */
type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/tiff",
]);

export interface FetchImagesToolDeps {
  /** Maximum images per call. Default: 5 */
  maxImagesPerCall?: number;
  /** Maximum dimension for resize. Default: 1024 */
  maxDimension?: number;
  /** Request timeout in ms. Default: 15000 */
  timeoutMs?: number;
  /** Injected for testability. */
  fetchFn?: FetchLike;
}

const FetchImagesParams = Type.Object({
  urls: Type.Array(Type.String(), {
    description: "Array of image URLs to fetch.",
  }),
});

interface FetchResult {
  url: string;
  success: boolean;
  width?: number;
  height?: number;
  error?: string;
}

export function createFetchImagesTool(deps: FetchImagesToolDeps = {}): AgentTool {
  const maxImagesPerCall = deps.maxImagesPerCall ?? 5;
  const maxDimension = deps.maxDimension ?? 1024;
  const timeoutMs = deps.timeoutMs ?? 15000;
  const fetchFn = deps.fetchFn ?? fetch;

  return {
    name: "fetch_images",
    label: "Fetch Images",
    description: "Fetch external images by URL.",
    parameters: FetchImagesParams,

    async execute(
      _toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ fetched: number; failed: number; results: FetchResult[] }>> {
      const { urls } = params as { urls: string[] };

      if (urls.length > maxImagesPerCall) {
        throw new Error(
          `Too many URLs requested (${urls.length}); maximum is ${maxImagesPerCall} per call.`
        );
      }

      const content: (TextContent | ImageContent)[] = [];
      const results: FetchResult[] = [];
      let fetched = 0;
      let failed = 0;

      for (const url of urls) {
        const result = await fetchSingleImage(url, timeoutMs, maxDimension, fetchFn);
        results.push(result.summary);

        if (result.success) {
          content.push({ type: "text", text: JSON.stringify(result.summary) });
          content.push({ type: "image", data: result.data, mimeType: "image/jpeg" });
          fetched++;
        } else {
          content.push({ type: "text", text: JSON.stringify(result.summary) });
          failed++;
        }
      }

      return {
        content,
        details: { fetched, failed, results },
      };
    },
  };
}

type FetchSingleResult = {
  success: true;
  data: string;
  summary: FetchResult;
} | {
  success: false;
  summary: FetchResult;
};

async function fetchSingleImage(
  url: string,
  timeoutMs: number,
  maxDimension: number,
  fetchFn: FetchLike
): Promise<FetchSingleResult> {
  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return {
        success: false,
        summary: { url, success: false, error: "Only HTTP/HTTPS URLs are supported" },
      };
    }
  } catch {
    return {
      success: false,
      summary: { url, success: false, error: "Invalid URL format" },
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(parsedUrl.toString(), {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ImageFetcher/1.0)",
      },
    });

    if (!response.ok) {
      return {
        success: false,
        summary: { url, success: false, error: `HTTP ${response.status}: ${response.statusText}` },
      };
    }

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ALLOWED_MIME_TYPES.has(contentType)) {
      return {
        success: false,
        summary: { url, success: false, error: `Unsupported content type: ${contentType}` },
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const processed = await prepareImageBufferForContext(buffer, contentType, maxDimension);

    return {
      success: true,
      data: processed.data.toString("base64"),
      summary: { url, success: true, width: processed.width, height: processed.height },
    };
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === "AbortError") {
        return {
          success: false,
          summary: { url, success: false, error: `Request timed out after ${timeoutMs}ms` },
        };
      }
      return {
        success: false,
        summary: { url, success: false, error: err.message },
      };
    }
    return {
      success: false,
      summary: { url, success: false, error: String(err) },
    };
  } finally {
    clearTimeout(timeout);
  }
}
