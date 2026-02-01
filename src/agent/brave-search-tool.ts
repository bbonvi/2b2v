import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

export interface BraveSearchToolDeps {
  apiKey: string;
  /** Injected for testability. Default implementation calls Brave Search API. */
  fetchResults?: (query: string, count: number) => Promise<BraveSearchResult[]>;
}

const WebSearchParams = Type.Object({
  query: Type.String({ description: "The search query to execute." }),
  count: Type.Optional(
    Type.Number({ description: "Number of results to return. Default: 5, max: 20." })
  ),
});

export function createBraveSearchTool(deps: BraveSearchToolDeps): AgentTool {
  const { apiKey } = deps;
  const fetchResults = deps.fetchResults ?? ((query: string, count: number) => fetchBraveResults(apiKey, query, count));

  return {
    name: "web_search",
    label: "web_search",
    description:
      "Search the web using Brave Search. Returns titles, URLs, and descriptions for each result.",
    parameters: WebSearchParams,

    async execute(
      _toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ count: number } | { error: boolean }>> {
      const { query, count: rawCount } = params as { query: string; count?: number };
      const count = Math.min(rawCount ?? 5, 20);

      let results: BraveSearchResult[];
      try {
        results = await fetchResults(query, count);
      } catch {
        return {
          content: [{ type: "text", text: "Unable to perform web search. The Brave Search API may be unavailable or the API key may be invalid." }],
          details: { error: true },
        };
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
async function fetchBraveResults(apiKey: string, query: string, count: number): Promise<BraveSearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));

  const res = await fetch(url.toString(), {
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
