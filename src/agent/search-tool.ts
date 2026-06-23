import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { QdrantClient } from "@qdrant/js-client-rest";
import type { Database } from "../db/database";
import type { EmbeddingPipeline } from "../embeddings/pipeline";
import {
  searchMessages,
  getMessageById,
  searchMessagesLiteral,
  getMessagesAroundMessage,
  getMessagesAroundTimestamp,
  type MessageSearchResult,
} from "../db/message-repository";
import { formatLocalWallClock, parseLocalDateTimeToEpoch } from "../time/agent-time.ts";
import { normalizeMessageForEmbedding } from "../embeddings/message-text.ts";


interface AttachmentInfo {
  name: string;
  contentType: string | null;
  size: number;
}

export interface SearchToolDeps {
  db: Database;
  qdrant: QdrantClient;
  guildId: string;
  /** Channel/thread/DM that initiated this agent turn; searches default here. */
  currentChannelId: string;
  timezone: string;
  embed: EmbeddingPipeline;
  /** Resolve username to userId. Returns undefined if not found. */
  resolveUsername: (username: string) => string | undefined;
  resolveUsernameInGuild?: (username: string, guildId: string) => Promise<string | undefined>;
  resolveChannel?: (channelId: string) => Promise<{ guildId: string; channelId: string } | null>;
  canAccessGuild?: (guildId: string) => Promise<boolean>;
  /** Message IDs already visible in prompt context; search should not repeat them. */
  excludedMessageIds?: Iterable<string>;
  fetchMessage?: (channelId: string, messageId: string) => Promise<{ attachments: AttachmentInfo[] } | null>;
}

const SearchParams = Type.Object({
  mode: Type.Optional(Type.Union([
    Type.Literal("semantic"),
    Type.Literal("literal"),
    Type.Literal("id"),
    Type.Literal("context"),
  ], { description: "Search mode." })),
  query: Type.Optional(Type.String({ description: "Search query." })),
  message_id: Type.Optional(Type.String({ description: "Anchor message ID for mode='context'." })),
  username: Type.Optional(Type.String({ description: "Filter results to a specific username." })),
  guild_id: Type.Optional(Type.String({ description: "Guild ID filter." })),
  channel_id: Type.Optional(Type.String({ description: "Guild channel or thread filter." })),
  around: Type.Optional(Type.String({ description: "Local wall-clock timestamp for context mode." })),
  afterMs: Type.Optional(Type.Number({ description: "Only messages after this epoch ms timestamp." })),
  beforeMs: Type.Optional(Type.Number({ description: "Only messages before this epoch ms timestamp." })),
  is_bot: Type.Optional(Type.Boolean({ description: "Semantic search only: true for bot-authored results, false for human-authored results." })),
  source: Type.Optional(Type.Union([
    Type.Literal("live"),
    Type.Literal("backfill"),
    Type.Literal("reindex"),
  ], { description: "Semantic vector source filter." })),
  embedding_kind: Type.Optional(Type.Union([
    Type.Literal("single"),
    Type.Literal("merged"),
  ], { description: "Semantic vector granularity filter." })),
  include_attachments: Type.Optional(Type.Boolean({ description: "Fetch attachment metadata." })),
  limit: Type.Optional(Type.Number({ description: "Max results to return." })),
});

/** Strip one leading @ and trim whitespace from a username-like input. */
export function normalizeUsername(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
}

/**
 * Create a semantic search agent tool bound to a guild context.
 * Embeds the query, runs Qdrant search + SQLite metadata lookup, returns formatted excerpts.
 */
export function createSearchTool(deps: SearchToolDeps): AgentTool {
  const { db, qdrant, guildId, currentChannelId, timezone, embed, resolveUsername } = deps;

  return {
    name: "search_messages",
    label: "Search Messages",
    description: "Search Discord message history.",
    parameters: SearchParams,
    execute: async (_toolCallId, params): Promise<AgentToolResult<{ count: number } | undefined>> => {
      const p = params as {
        mode?: "semantic" | "literal" | "id" | "context";
        query?: string;
        message_id?: string;
        username?: string;
        guild_id?: string;
        channel_id?: string;
        around?: string;
        afterMs?: number;
        beforeMs?: number;
        is_bot?: boolean;
        source?: "live" | "backfill" | "reindex";
        embedding_kind?: "single" | "merged";
        include_attachments?: boolean;
        limit?: number;
      };
      const mode = p.mode ?? "semantic";
      const limit = Math.max(1, Math.min(p.limit ?? 10, 50));
      const explicitGuildId = p.guild_id !== undefined && p.guild_id.trim() !== "";
      let targetGuildId = explicitGuildId ? p.guild_id?.trim() ?? guildId : guildId;
      let scopedChannelId: string | undefined = explicitGuildId ? undefined : currentChannelId;
      if (p.channel_id !== undefined && p.channel_id.trim() !== "") {
        const rawChannelId = p.channel_id.trim();
        if (deps.resolveChannel !== undefined) {
          const channel = await deps.resolveChannel(rawChannelId);
          if (channel === null) {
            return { content: [{ type: "text", text: `Channel '${rawChannelId}' not found or not accessible.` }], details: undefined };
          }
          targetGuildId = channel.guildId;
          scopedChannelId = channel.channelId;
        } else {
          scopedChannelId = rawChannelId;
        }
      }
      if (scopedChannelId === undefined && targetGuildId !== guildId && deps.canAccessGuild !== undefined) {
        const canAccess = await deps.canAccessGuild(targetGuildId);
        if (!canAccess) {
          return { content: [{ type: "text", text: `Guild '${targetGuildId}' not found or not accessible.` }], details: undefined };
        }
      }
      const excludedMessageIds = [...new Set(deps.excludedMessageIds ?? [])];
      let contextIntro: string | undefined;

      // Resolve username to userId if provided (normalize to strip leading @)
      let userId: string | undefined;
      if (p.username !== undefined) {
        const normalizedUsername = normalizeUsername(p.username);
        userId = deps.resolveUsernameInGuild !== undefined
          ? await deps.resolveUsernameInGuild(normalizedUsername, targetGuildId)
          : resolveUsername(normalizedUsername);
        if (userId === undefined) {
          return { content: [{ type: "text", text: `User '${p.username}' not found in guild ${targetGuildId}.` }], details: undefined };
        }
      }

      let results: MessageSearchResult[];

      if (mode === "id") {
        if (p.query === undefined || p.query.trim() === "") {
          return { content: [{ type: "text", text: "Message ID is required for id lookup." }], details: undefined };
        }
        const result = getMessageById(db, p.query, targetGuildId);
        if (result === null) {
          return { content: [{ type: "text", text: "Message not found." }], details: undefined };
        }
        if (scopedChannelId !== undefined && result.channelId !== scopedChannelId) {
          return { content: [{ type: "text", text: "Message not found in that channel." }], details: undefined };
        }
        if (excludedMessageIds.includes(result.id)) {
          return { content: [{ type: "text", text: "Message is already present in the current prompt context." }], details: { count: 0 } };
        }
        results = [result];
      } else if (mode === "context") {
        const contextLimit = Math.max(1, Math.min(p.limit ?? 20, 50));
        if (p.message_id !== undefined && p.message_id.trim() !== "") {
          const contextResults = getMessagesAroundMessage(db, p.message_id, {
            guildId: targetGuildId,
            channelId: scopedChannelId,
            limit: contextLimit,
          });
          if (contextResults === null) {
            return { content: [{ type: "text", text: "Message not found." }], details: undefined };
          }
          results = contextResults;
          contextIntro = `Surrounding channel context around message id ${p.message_id}${scopedChannelId !== undefined ? ` in channel ${scopedChannelId}` : ""}, ordered oldest to newest.`;
        } else if (p.around !== undefined && p.around.trim() !== "") {
          if (scopedChannelId === undefined) {
            return { content: [{ type: "text", text: "mode='context' with around timestamp requires channel_id." }], details: undefined };
          }
          const parsed = parseLocalDateTimeToEpoch(p.around, timezone);
          if (!parsed.ok) {
            return { content: [{ type: "text", text: `Invalid around timestamp: ${parsed.error}` }], details: undefined };
          }
          results = getMessagesAroundTimestamp(db, {
            guildId: targetGuildId,
            channelId: scopedChannelId,
            around: parsed.epochMs,
            limit: contextLimit,
          });
          contextIntro = `Surrounding channel context around ${p.around} in channel ${scopedChannelId}, ordered oldest to newest.`;
        } else {
          return { content: [{ type: "text", text: "mode='context' requires message_id or around." }], details: undefined };
        }
      } else if (mode === "literal") {
        if (p.query === undefined || p.query.trim() === "") {
          return { content: [{ type: "text", text: "Query is required for literal search." }], details: undefined };
        }
        try {
          results = searchMessagesLiteral(db, p.query, {
            guildId: targetGuildId,
            userId: userId,
            channelId: scopedChannelId,
            after: p.afterMs,
            before: p.beforeMs,
            excludeIds: excludedMessageIds,
            limit,
          });
        } catch {
          return { content: [{ type: "text", text: "Search is temporarily unavailable." }], details: undefined };
        }
      } else {
        // semantic mode
        if (p.query === undefined || p.query.trim() === "") {
          return { content: [{ type: "text", text: "Query is required for semantic search." }], details: undefined };
        }
        let queryVec: Float32Array;
        try {
          const normalizedQuery = normalizeMessageForEmbedding(p.query);
          if (normalizedQuery === "") {
            return { content: [{ type: "text", text: "Query has no searchable text after normalization." }], details: undefined };
          }
          const embedResult = await embed.embed([normalizedQuery]);
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
            guildId: targetGuildId,
            userId: userId,
            channelId: scopedChannelId,
            after: p.afterMs,
            before: p.beforeMs,
            excludeIds: excludedMessageIds,
            isBot: p.is_bot,
            source: p.source,
            embeddingKind: p.embedding_kind,
            limit,
          });
        } catch {
          return { content: [{ type: "text", text: "Search is temporarily unavailable." }], details: undefined };
        }
      }

      if (results.length === 0) {
        const text = excludedMessageIds.length > 0
          ? "No messages found outside the current prompt context matching your query."
          : "No messages found matching your query.";
        return { content: [{ type: "text", text }], details: { count: 0 } };
      }

      if (scopedChannelId === undefined && deps.resolveChannel !== undefined) {
        const visibleChannelIds = new Map<string, boolean>();
        const visibleResults: MessageSearchResult[] = [];
        for (const result of results) {
          let visible = visibleChannelIds.get(result.channelId);
          if (visible === undefined) {
            const channel = await deps.resolveChannel(result.channelId);
            visible = channel !== null && channel.guildId === targetGuildId;
            visibleChannelIds.set(result.channelId, visible);
          }
          if (visible) visibleResults.push(result);
        }
        results = visibleResults;
        if (results.length === 0) {
          return { content: [{ type: "text", text: "No messages found in accessible channels matching your query." }], details: { count: 0 } };
        }
      }

      // Fetch attachments from Discord only when explicitly requested. Older
      // messages are usually uncached, so this path can cost one network call
      // per result and dominate otherwise-fast SQLite/Qdrant searches.
      const attachmentMap = new Map<string, AttachmentInfo[]>();
      if (p.include_attachments === true && deps.fetchMessage !== undefined) {
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

      const lines = [
        contextIntro ?? formatResultIntro(mode),
        ...results.map((r) => formatResult(r, timezone, {
          includeScore: mode === "semantic",
          includeChannelId: scopedChannelId === undefined || scopedChannelId !== currentChannelId || targetGuildId !== guildId,
          attachments: attachmentMap.get(r.id),
        })),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: { count: results.length },
      };
    },
  };
}

function formatResultIntro(mode: "semantic" | "literal" | "id" | "context"): string {
  if (mode === "semantic") return "Semantic search results are ranked by similarity; higher scores mean closer matches.";
  if (mode === "literal") return "Literal search results are exact text matches ordered oldest to newest.";
  if (mode === "context") return "Surrounding chat context, ordered oldest to newest.";
  return "Direct message lookup result.";
}

function formatResult(
  r: MessageSearchResult,
  timezone: string,
  options: { includeScore: boolean; includeChannelId: boolean; attachments?: AttachmentInfo[] },
): string {
  const date = formatLocalWallClock(r.createdAt, timezone);
  const replyTag = r.replyToId !== null ? ` (reply to ${r.replyToId})` : "";
  const scoreTag = options.includeScore ? `[score ${r.score.toFixed(3)}] ` : "";
  const channelTag = options.includeChannelId ? ` [channel_id ${r.channelId}]` : "";
  const ids = r.matchedMessageIds !== undefined && r.matchedMessageIds.length > 1
    ? ` [ids ${r.matchedMessageIds.join(",")}]`
    : ` [id ${r.id}]`;
  let line = `${scoreTag}[${date}]${channelTag}${ids} ${r.authorUsername}${replyTag}: ${r.translatedContent}`;
  if (options.attachments !== undefined && options.attachments.length > 0) {
    for (const a of options.attachments) {
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
