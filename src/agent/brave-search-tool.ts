import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

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

const WebSearchParams = Type.Object({
  query: Type.String({ description: "The search query to execute." }),
  count: Type.Optional(
    Type.Number({ description: "Number of results to return." })
  ),
});

export function createBraveSearchTool(deps: BraveSearchToolDeps): AgentTool {
  const { apiKey } = deps;
  const timeoutMs = deps.timeoutMs ?? 15000;
  const fetchResults = deps.fetchResults ?? ((query: string, count: number, signal?: AbortSignal) =>
    fetchBraveResults(apiKey, query, count, signal));

  return {
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
  };
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
