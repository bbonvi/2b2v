import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

/** Minimal fetch-like function signature for testability. */
type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface FetchUrlToolDeps {
  /** Max content length in characters. Default: 16000 */
  maxContentLength?: number;
  /** Request timeout in ms. Default: 15000 */
  timeoutMs?: number;
  /** Disable Jina fallback (use manual only). Default: false */
  disableJina?: boolean;
  /** Injected for testability. */
  fetchFn?: FetchLike;
}

const FetchUrlParams = Type.Object({
  url: Type.String({ description: "The URL to fetch and extract content from." }),
});

export function createFetchUrlTool(deps: FetchUrlToolDeps = {}): AgentTool {
  const maxContentLength = deps.maxContentLength ?? 16000;
  const timeoutMs = deps.timeoutMs ?? 15000;
  const disableJina = deps.disableJina ?? false;
  const fetchFn = deps.fetchFn ?? fetch;

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });

  return {
    name: "fetch_url",
    label: "fetch_url",
    description:
      "Fetch a webpage URL and extract its readable content as markdown. " +
      "Use this to read articles, documentation, or any web page. " +
      "Returns the page title and main content. " +
      "Might take 10+ seconds.",
    parameters: FetchUrlParams,

    async execute(
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<{ url: string; title: string; contentLength: number; method: string }>> {
      const { url } = params as { url: string };

      // Validate URL
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          throw new Error("Only HTTP/HTTPS URLs are supported");
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("Only HTTP/HTTPS")) {
          throw err;
        }
        throw new Error(`Invalid URL: ${url}`);
      }

      const request = createToolTimeout(signal, timeoutMs, `fetch_url timed out after ${timeoutMs}ms`);
      try {
        let jinaError: unknown;
        // Try Jina Reader first (unless disabled)
        if (!disableJina) {
          try {
            return await fetchWithJina(parsedUrl.toString(), maxContentLength, fetchFn, request.signal);
          } catch (error) {
            if (request.signal.aborted) throw error;
            jinaError = error;
          }
        }

        // Fallback: Manual extraction
        try {
          return await fetchManual(parsedUrl.toString(), maxContentLength, fetchFn, turndown, request.signal);
        } catch (manualError) {
          if (jinaError !== undefined) {
            throw new Error(`Jina reader failed: ${errorMessage(jinaError)}; manual fetch failed: ${errorMessage(manualError)}`);
          }
          throw manualError;
        }
      } catch (error) {
        throw new Error(formatFetchUrlFailure(parsedUrl.toString(), error, timeoutMs));
      } finally {
        request.cleanup();
      }
    },
  };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal, "fetch_url aborted");
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(abortReason(signal, "fetch_url aborted"));
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
      controller.abort(abortReason(parent, "fetch_url aborted"));
      return;
    }
    controller.abort(new Error("fetch_url aborted"));
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatFetchUrlFailure(url: string, error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.message.startsWith("fetch_url failed")) return error.message;
  if (error instanceof Error && error.name === "AbortError") {
    return `fetch_url failed for ${url}: request timed out after ${timeoutMs}ms`;
  }
  return `fetch_url failed for ${url}: ${errorMessage(error)}`;
}

/** Fetch using Jina Reader API (r.jina.ai) */
async function fetchWithJina(
  url: string,
  maxContentLength: number,
  fetchFn: FetchLike,
  signal: AbortSignal,
): Promise<AgentToolResult<{ url: string; title: string; contentLength: number; method: string }>> {
  const jinaUrl = `https://r.jina.ai/${url}`;

  const response = await abortable(fetchFn(jinaUrl, {
    signal,
    headers: {
      Accept: "text/markdown",
    },
  }), signal);

  if (!response.ok) {
    throw new Error(`Jina returned HTTP ${response.status}: ${response.statusText}`);
  }

  let markdown = await abortable(response.text(), signal);

  // Extract title from first heading if present
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1] ?? new URL(url).hostname;

  // Truncate if needed
  if (markdown.length > maxContentLength) {
    markdown = markdown.slice(0, maxContentLength) + "\n\n[Content truncated...]";
  }

  const text = markdown.startsWith("Source:")
    ? markdown
    : `Source: ${url}\n\n${markdown}`;

  return {
    content: [{ type: "text", text }],
    details: { url, title, contentLength: markdown.length, method: "jina" },
  };
}

/** Fallback: Manual fetch with Readability extraction */
async function fetchManual(
  url: string,
  maxContentLength: number,
  fetchFn: FetchLike,
  turndown: TurndownService,
  signal: AbortSignal,
): Promise<AgentToolResult<{ url: string; title: string; contentLength: number; method: string }>> {
  const response = await abortable(fetchFn(url, {
    signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  }), signal);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }

  const html = await abortable(response.text(), signal);

  // Parse and extract
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { document } = parseHTML(html);
  // Readability expects DOM Document; linkedom's document is runtime-compatible but differently typed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reader = new Readability(document as any);
  const article = reader.parse();

  if (article === null) {
    throw new Error("Could not extract readable content from page");
  }

  let markdown = turndown.turndown(article.content ?? "");

  if (markdown.length > maxContentLength) {
    markdown = markdown.slice(0, maxContentLength) + "\n\n[Content truncated...]";
  }

  const title = article.title !== null && article.title !== undefined && article.title !== ""
    ? article.title
    : new URL(url).hostname;

  return {
    content: [{ type: "text", text: `# ${title}\n\nSource: ${url}\n\n${markdown}` }],
    details: { url, title, contentLength: markdown.length, method: "manual" },
  };
}
