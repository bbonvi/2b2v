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
      params: unknown
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

      // Try Jina Reader first (unless disabled)
      if (!disableJina) {
        try {
          const result = await fetchWithJina(parsedUrl.toString(), timeoutMs, maxContentLength, fetchFn);
          return result;
        } catch {
          // Fall through to manual extraction
        }
      }

      // Fallback: Manual extraction
      return fetchManual(parsedUrl.toString(), timeoutMs, maxContentLength, fetchFn, turndown);
    },
  };
}

/** Fetch using Jina Reader API (r.jina.ai) */
async function fetchWithJina(
  url: string,
  timeoutMs: number,
  maxContentLength: number,
  fetchFn: FetchLike
): Promise<AgentToolResult<{ url: string; title: string; contentLength: number; method: string }>> {
  const jinaUrl = `https://r.jina.ai/${url}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(jinaUrl, {
      signal: controller.signal,
      headers: {
        Accept: "text/markdown",
      },
    });

    if (!response.ok) {
      throw new Error(`Jina returned ${response.status}`);
    }

    let markdown = await response.text();

    // Extract title from first heading if present
    const titleMatch = markdown.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1] ?? new URL(url).hostname;

    // Truncate if needed
    if (markdown.length > maxContentLength) {
      markdown = markdown.slice(0, maxContentLength) + "\n\n[Content truncated...]";
    }

    return {
      content: [{ type: "text", text: markdown }],
      details: { url, title, contentLength: markdown.length, method: "jina" },
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Fallback: Manual fetch with Readability extraction */
async function fetchManual(
  url: string,
  timeoutMs: number,
  maxContentLength: number,
  fetchFn: FetchLike,
  turndown: TurndownService
): Promise<AgentToolResult<{ url: string; title: string; contentLength: number; method: string }>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let html: string;
  try {
    const response = await fetchFn(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    html = await response.text();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

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
