import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { QdrantClient } from "@qdrant/js-client-rest";
import type { Database } from "../db/database";
import type { EmbeddingPipeline } from "../embeddings/pipeline";
import { searchMessages, getMessageById, searchMessagesLiteral, type MessageSearchResult } from "../db/message-repository";
import { formatLocalWallClock } from "../time/agent-time.ts";
import { normalizeUsername } from "./memory-tools.ts";


interface AttachmentInfo {
  name: string;
  contentType: string | null;
  size: number;
}

export interface SearchToolDeps {
  db: Database;
  qdrant: QdrantClient;
  guildId: string;
  timezone: string;
  embed: EmbeddingPipeline;
  /** Resolve username to userId. Returns undefined if not found. */
  resolveUsername: (username: string) => string | undefined;
  fetchMessage?: (channelId: string, messageId: string) => Promise<{ attachments: AttachmentInfo[] } | null>;
}

const SearchParams = Type.Object({
  mode: Type.Optional(Type.Union([
    Type.Literal("semantic"),
    Type.Literal("literal"),
    Type.Literal("id"),
  ], { description: "Search mode. 'semantic' (default): AI similarity search. 'literal': exact keyword/phrase match (case-insensitive). 'id': direct message ID lookup." })),
  query: Type.String({ description: "Search query, keyword/phrase, or message ID depending on mode." }),
  username: Type.Optional(Type.String({ description: "Filter results to a specific username." })),
  chat_id: Type.Optional(Type.String({ description: "Filter results to a specific chat (channel, thread, or DM)." })),
  afterMs: Type.Optional(Type.Number({ description: "Only messages after this epoch ms timestamp." })),
  beforeMs: Type.Optional(Type.Number({ description: "Only messages before this epoch ms timestamp." })),
  limit: Type.Optional(Type.Number({ description: "Max results to return. Default 10." })),
});

/**
 * Create a semantic search agent tool bound to a guild context.
 * Embeds the query, runs Qdrant search + SQLite metadata lookup, returns formatted excerpts.
 */
export function createSearchTool(deps: SearchToolDeps): AgentTool {
  const { db, qdrant, guildId, timezone, embed, resolveUsername } = deps;

  return {
    name: "search_messages",
    label: "Search Messages",
    description:
      "Search chat history. Modes: 'semantic' (default) — AI similarity search with natural language; 'literal' — case-insensitive keyword/phrase match; 'id' — direct message lookup by ID. Optionally filter by username, chat, or time range.",
    parameters: SearchParams,
    execute: async (_toolCallId, params): Promise<AgentToolResult<{ count: number } | undefined>> => {
      const p = params as {
        mode?: "semantic" | "literal" | "id";
        query: string;
        username?: string;
        chat_id?: string;
        afterMs?: number;
        beforeMs?: number;
        limit?: number;
      };
      const mode = p.mode ?? "semantic";
      const limit = Math.max(1, Math.min(p.limit ?? 10, 50));

      // Resolve username to userId if provided (normalize to strip leading @)
      let userId: string | undefined;
      if (p.username !== undefined) {
        userId = resolveUsername(normalizeUsername(p.username));
        if (userId === undefined) {
          return { content: [{ type: "text", text: `User '${p.username}' not found.` }], details: undefined };
        }
      }

      let results: MessageSearchResult[];

      if (mode === "id") {
        const result = getMessageById(db, p.query, guildId);
        if (result === null) {
          return { content: [{ type: "text", text: "Message not found." }], details: undefined };
        }
        results = [result];
      } else if (mode === "literal") {
        try {
          results = searchMessagesLiteral(db, p.query, {
            guildId,
            userId: userId,
            channelId: p.chat_id,
            after: p.afterMs,
            before: p.beforeMs,
            limit,
          });
        } catch {
          return { content: [{ type: "text", text: "Search is temporarily unavailable." }], details: undefined };
        }
      } else {
        // semantic mode
        let queryVec: Float32Array;
        try {
          const embedResult = await embed.embed([p.query]);
          const vec = embedResult[0];
          if (vec === undefined) {
            return { content: [{ type: "text", text: "Failed to generate embedding for query." }], details: undefined };
          }
          queryVec = vec;
        } catch {
          return { content: [{ type: "text", text: "Failed to generate embedding for query." }], details: undefined };
        }

        try {
          results = await searchMessages(db, qdrant, queryVec, {
            guildId,
            userId: userId,
            channelId: p.chat_id,
            after: p.afterMs,
            before: p.beforeMs,
            limit,
          });
        } catch {
          return { content: [{ type: "text", text: "Search is temporarily unavailable." }], details: undefined };
        }
      }

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No messages found matching your query." }], details: undefined };
      }

      // Fetch attachments from Discord if callback provided
      const attachmentMap = new Map<string, AttachmentInfo[]>();
      if (deps.fetchMessage !== undefined) {
        const fetchMsg = deps.fetchMessage;
        const CONCURRENCY = 5;
        const queue = [...results];
        const runBatch = async () => {
          while (queue.length > 0) {
            const r = queue.shift();
            if (r === undefined) break;
            try {
              const msg = await fetchMsg(r.channelId, r.id);
              if (msg !== null && msg.attachments.length > 0) {
                attachmentMap.set(r.id, msg.attachments);
              }
            } catch {
              // Skip — show text only
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, results.length) }, () => runBatch()));
      }

      const lines = results.map((r) => formatResult(r, timezone, attachmentMap.get(r.id)));
      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: { count: results.length },
      };
    },
  };
}

function formatResult(r: MessageSearchResult, timezone: string, attachments?: AttachmentInfo[]): string {
  const date = formatLocalWallClock(r.createdAt, timezone);
  const replyTag = r.replyToId !== null ? ` (reply to ${r.replyToId})` : "";
  let line = `[${date}] ${r.authorUsername}${replyTag}: ${r.translatedContent}`;
  if (attachments !== undefined && attachments.length > 0) {
    for (const a of attachments) {
      const sizeStr = formatFileSize(a.size);
      const type = a.contentType ?? "unknown";
      line += `\n  📎 ${a.name} (${type}, ${sizeStr})`;
    }
  }
  return line;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
