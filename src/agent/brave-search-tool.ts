import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { markReadOnlyTool } from "./tool-effects.ts";

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

export interface BraveSearchToolDeps {
  apiKey: string;
  /** Request timeout in ms. Default: 15000. */
  timeoutMs?: number;
  /** Injected for testability. Default implementation calls Brave Search API. */
  fetchResults?: (query: string, count: number, signal?: AbortSignal) => Promise<BraveSearchResult[]>;
}

export interface BraveImageSearchResult {
  title: string;
  imageUrl: string;
  previewUrl: string | null;
  sourceUrl: string;
  width: number | null;
  height: number | null;
}

export interface BraveImageSearchToolDeps {
  apiKey: string;
  timeoutMs?: number;
  fetchResults?: (query: string, count: number, signal?: AbortSignal) => Promise<BraveImageSearchResult[]>;
}

const WebSearchParams = Type.Object({
  query: Type.String({ description: "The search query to execute." }),
  count: Type.Optional(
    Type.Number({ description: "Number of results to return." })
  ),
});

const ImageSearchParams = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 400, description: "Image search query." }),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Number of image results." })),
});

export function createBraveSearchTool(deps: BraveSearchToolDeps): AgentTool {
  const { apiKey } = deps;
  const timeoutMs = deps.timeoutMs ?? 15000;
  const fetchResults = deps.fetchResults ?? ((query: string, count: number, signal?: AbortSignal) =>
    fetchBraveResults(apiKey, query, count, signal));

  return markReadOnlyTool({
    name: "web_search",
    label: "web_search",
    description: "Search the web using Brave Search.",
    parameters: WebSearchParams,

    async execute(
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<{ count: number } | { error: boolean }>> {
      const { query, count: rawCount } = params as { query: string; count?: number };
      const count = Math.min(rawCount ?? 5, 20);

      let results: BraveSearchResult[];
      const timeout = createToolTimeout(signal, timeoutMs, `web_search timed out after ${timeoutMs}ms`);
      try {
        results = await abortable(fetchResults(query, count, timeout.signal), timeout.signal);
      } catch (error) {
        const message = normalizeToolError(error, "web_search");
        return {
          content: [{ type: "text", text: message }],
          details: { error: true },
        };
      } finally {
        timeout.cleanup();
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No results found for your query." }],
          details: { count: 0 },
        };
      }

      const lines = results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`);
      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: { count: results.length },
      };
    },
  });
}

/** Create a Brave-backed image discovery tool that returns URLs without loading image bytes. */
export function createBraveImageSearchTool(deps: BraveImageSearchToolDeps): AgentTool {
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const fetchResults = deps.fetchResults ?? ((query: string, count: number, signal?: AbortSignal) =>
    fetchBraveImageResults(deps.apiKey, query, count, signal));
  return markReadOnlyTool({
    name: "search_images",
    label: "search_images",
    description: "Search the web for images using Brave Image Search.",
    parameters: ImageSearchParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ count: number } | { error: boolean }>> {
      const { query, count: requestedCount } = params as { query: string; count?: number };
      const count = Math.max(1, Math.min(requestedCount ?? 5, 20));
      const timeout = createToolTimeout(signal, timeoutMs, `search_images timed out after ${timeoutMs}ms`);
      try {
        const results = await abortable(fetchResults(query, count, timeout.signal), timeout.signal);
        if (results.length === 0) return { content: [{ type: "text", text: "No image results found." }], details: { count: 0 } };
        const text = results.map((result, index) => {
          const size = result.width !== null && result.height !== null ? `\n   size: ${result.width}x${result.height}` : "";
          const preview = result.previewUrl !== null ? `\n   preview_url: ${result.previewUrl}` : "";
          const kind = /\.gif(?:$|[?#])/iu.test(result.imageUrl) ? "\n   kind_hint: gif" : "";
          return `${index + 1}. **${result.title}**\n   image_url: ${result.imageUrl}${preview}\n   source_url: ${result.sourceUrl}${size}${kind}`;
        }).join("\n\n");
        return { content: [{ type: "text", text }], details: { count: results.length } };
      } catch (error) {
        return { content: [{ type: "text", text: normalizeToolError(error, "search_images") }], details: { error: true } };
      } finally {
        timeout.cleanup();
      }
    },
  });
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal, "web_search aborted");
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(abortReason(signal, "web_search aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason !== "") return new Error(reason);
  return new Error(fallback);
}

function createToolTimeout(parent: AbortSignal | undefined, timeoutMs: number, timeoutMessage: string): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(timeoutMessage));
  }, timeoutMs);
  const onParentAbort = (): void => {
    if (parent !== undefined) {
      controller.abort(abortReason(parent, "web_search aborted"));
      return;
    }
    controller.abort(new Error("web_search aborted"));
  };

  if (parent?.aborted === true) {
    onParentAbort();
  } else {
    parent?.addEventListener("abort", onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function normalizeToolError(error: unknown, toolName: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${toolName} failed: ${message}`;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

interface BraveImageSearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    thumbnail?: { src?: string };
    properties?: { url?: string; width?: number; height?: number };
  }>;
}

async function fetchBraveImageResults(
  apiKey: string,
  query: string,
  count: number,
  signal?: AbortSignal,
): Promise<BraveImageSearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/images/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("safesearch", "strict");
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
  });
  if (!response.ok) throw new Error(`Brave Image Search returned HTTP ${response.status}`);
  const payload = await response.json() as BraveImageSearchResponse;
  return (payload.results ?? []).flatMap((result) => {
    const imageUrl = result.properties?.url;
    const sourceUrl = result.url;
    if (imageUrl === undefined || sourceUrl === undefined) return [];
    return [{
      title: result.title ?? new URL(sourceUrl).hostname,
      imageUrl,
      previewUrl: result.thumbnail?.src ?? null,
      sourceUrl,
      width: result.properties?.width ?? null,
      height: result.properties?.height ?? null,
    }];
  });
}

/** Default implementation that calls the Brave Search Web API. */
async function fetchBraveResults(
  apiKey: string,
  query: string,
  count: number,
  signal: AbortSignal | undefined,
): Promise<BraveSearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));

  const res = await fetch(url.toString(), {
    signal,
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!res.ok) {
    throw new Error(`Brave Search API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as BraveSearchResponse;
  const webResults = data.web?.results ?? [];

  return webResults.map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.description ?? "",
  }));
}
