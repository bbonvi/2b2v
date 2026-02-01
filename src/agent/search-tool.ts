import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Database } from "../db/database";
import type { EmbeddingPipeline } from "../embeddings/pipeline";
import { searchMessages, type MessageSearchResult } from "../db/message-repository";

export interface SearchToolDeps {
  db: Database;
  guildId: string;
  embed: EmbeddingPipeline;
}

const SearchParams = Type.Object({
  query: Type.String({ description: "Semantic search query describing what you're looking for." }),
  userId: Type.Optional(Type.String({ description: "Filter results to a specific user ID." })),
  channelId: Type.Optional(Type.String({ description: "Filter results to a specific channel ID." })),
  afterMs: Type.Optional(Type.Number({ description: "Only messages after this epoch ms timestamp." })),
  beforeMs: Type.Optional(Type.Number({ description: "Only messages before this epoch ms timestamp." })),
  limit: Type.Optional(Type.Number({ description: "Max results to return. Default 10." })),
});

/**
 * Create a semantic search agent tool bound to a guild context.
 * Embeds the query, runs KNN + metadata filters, returns formatted excerpts.
 */
export function createSearchTool(deps: SearchToolDeps): AgentTool {
  const { db, guildId, embed } = deps;

  return {
    name: "search_messages",
    label: "Search Messages",
    description:
      "Search chat history semantically. Describe what you're looking for in natural language. Optionally filter by user, channel, or time range.",
    parameters: SearchParams,
    execute: async (_toolCallId, params): Promise<AgentToolResult> => {
      const p = params as any;
      const limit = p.limit ?? 10;

      const [queryVec] = await embed.embed([p.query]);

      const results = searchMessages(db, queryVec, {
        guildId,
        userId: p.userId,
        channelId: p.channelId,
        after: p.afterMs,
        before: p.beforeMs,
        limit,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No messages found matching your query." }] };
      }

      const lines = results.map((r) => formatResult(r));
      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: { count: results.length },
      };
    },
  };
}

function formatResult(r: MessageSearchResult): string {
  const date = new Date(r.createdAt).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return `[${date}] ${r.authorUsername}: ${r.translatedContent}`;
}
