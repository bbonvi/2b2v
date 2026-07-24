import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database.ts";
import type { AssetKind } from "../db/asset-repository.ts";
import {
  findMessageSearchCandidates,
  getMessageSearchCursor,
  getMessageSearchMatchesByIds,
  getHistoryMessagesByIds,
  type MessageSearchCursor,
  type SearchMessageCandidatesFilter,
  type SearchMessageCandidate,
  type SearchMessageMatch,
} from "../db/message-repository.ts";
import type { Logger } from "../logger.ts";
import { formatLocalWallClock, parseLocalDateTimeToEpoch } from "../time/agent-time.ts";
import { AssetIdSchema, parseAssetId } from "./asset-id.ts";
import { formatMessageLine } from "./history-formatting.ts";
import { resolveReplies } from "./history-replies.ts";
import { runRipgrepChunks } from "./ripgrep.ts";
import { markReadOnlyTool } from "./tool-effects.ts";

const ASSET_KINDS = ["image", "gif", "audio", "video", "text", "file"] as const;
const SEARCH_SCOPES = ["current_channel", "current_guild", "all_guilds"] as const;
const DEFAULT_CANDIDATE_CHUNK_SIZE = 10_000;

export interface SearchChannelMessagesToolDeps {
  db: Database;
  guildId: string;
  /** Channel/thread/DM that initiated this agent turn; searches default here. */
  currentChannelId: string;
  timezone: string;
  resolveChannel?: (channelId: string) => Promise<{ guildId: string; channelId: string } | null>;
  canAccessGuild?: (guildId: string) => Promise<boolean>;
  logger?: Logger;
  candidateChunkSize?: number;
}

const SearchChannelMessagesParams = Type.Object({
  pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: "Ripgrep-compatible regular expression." })),
  scope: Type.Optional(Type.Union(SEARCH_SCOPES.map((scope) => Type.Literal(scope)), {
    description: "Search scope. Defaults to the current channel; all_guilds covers every accessible stored guild channel.",
  })),
  username: Type.Optional(Type.String({ description: "Stored historical Discord username." })),
  user_id: Type.Optional(Type.String({ description: "Stable Discord user ID." })),
  guild_id: Type.Optional(Type.String({ description: "Guild ID filter." })),
  channel_id: Type.Optional(Type.String({ description: "Guild channel or thread filter." })),
  asset_id: Type.Optional(AssetIdSchema),
  has_assets: Type.Optional(Type.Boolean({ description: "Filter by whether a message has indexed assets." })),
  asset_kind: Type.Optional(Type.Union(ASSET_KINDS.map((kind) => Type.Literal(kind)), { description: "Indexed asset type." })),
  after: Type.Optional(Type.String({ description: "Local wall-clock lower bound, YYYY-MM-DD HH:mm." })),
  before: Type.Optional(Type.String({ description: "Local wall-clock upper bound, YYYY-MM-DD HH:mm." })),
  before_message_id: Type.Optional(Type.String({ description: "Search messages older than this result message ID." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum results." })),
});

interface SearchDetails {
  count: number;
  has_more: boolean;
  next_before_message_id?: string;
  candidates_scanned: number;
  duration_ms: number;
}

/** Strip one leading @ and trim whitespace from a username-like input. */
export function normalizeUsername(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
}

/** Create a local indexed Discord message and attachment discovery tool. */
export function createSearchChannelMessagesTool(deps: SearchChannelMessagesToolDeps): AgentTool {
  const { db, guildId, currentChannelId, timezone } = deps;
  const candidateChunkSize = Math.max(1, deps.candidateChunkSize ?? DEFAULT_CANDIDATE_CHUNK_SIZE);
  return markReadOnlyTool({
    name: "search_channel_messages",
    label: "Search Channel Messages",
    description: "Regex-search stored Discord messages and indexed attachment metadata in the current channel, current guild, or all accessible guilds.",
    parameters: SearchChannelMessagesParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<SearchDetails | { error: boolean }>> {
      const startedAt = performance.now();
      const p = params as {
        pattern?: string;
        scope?: typeof SEARCH_SCOPES[number];
        username?: string;
        user_id?: string;
        guild_id?: string;
        channel_id?: string;
        asset_id?: unknown;
        has_assets?: boolean;
        asset_kind?: AssetKind;
        after?: string;
        before?: string;
        before_message_id?: string;
        limit?: number;
      };
      const pattern = p.pattern?.trim();
      const username = p.username === undefined ? undefined : normalizeUsername(p.username);
      const userId = p.user_id?.trim();
      const beforeMessageId = p.before_message_id?.trim();
      const explicitGuildId = p.guild_id !== undefined && p.guild_id.trim() !== "";
      const explicitChannelId = p.channel_id !== undefined && p.channel_id.trim() !== "";
      const scope = p.scope ?? "current_channel";
      const parsedAssetId = p.asset_id === undefined ? undefined : parseAssetId(p.asset_id);
      if (parsedAssetId === null) return error("asset_id must be a positive integer, optionally prefixed with #");
      const assetId = parsedAssetId;
      if (username === "" || userId === "") return error("username and user_id cannot be empty.");
      if (beforeMessageId === "") return error("before_message_id cannot be empty.");
      if (pattern === "") return error("pattern cannot be empty.");
      if (scope === "all_guilds" && (explicitGuildId || explicitChannelId)) {
        return error("scope=all_guilds cannot be combined with guild_id or channel_id.");
      }
      const hasNarrowingFilter = explicitGuildId || explicitChannelId || username !== undefined || userId !== undefined
        || assetId !== undefined || p.has_assets !== undefined || p.asset_kind !== undefined
        || p.after !== undefined || p.before !== undefined;
      if (pattern === undefined && !hasNarrowingFilter) {
        return error("Provide a regex pattern or at least one narrowing filter.");
      }

      let targetGuildId: string | undefined = explicitGuildId ? p.guild_id?.trim() ?? guildId : guildId;
      let scopedChannelId: string | undefined = explicitGuildId || scope !== "current_channel" ? undefined : currentChannelId;
      if (scope === "all_guilds") targetGuildId = undefined;
      if (explicitChannelId) {
        const requestedChannelId = p.channel_id?.trim() ?? "";
        if (deps.resolveChannel !== undefined) {
          const channel = await deps.resolveChannel(requestedChannelId);
          if (channel === null) return error(`Channel '${requestedChannelId}' not found or not accessible.`);
          targetGuildId = channel.guildId;
          scopedChannelId = channel.channelId;
        } else {
          scopedChannelId = requestedChannelId;
        }
      }
      if (targetGuildId !== undefined && scopedChannelId === undefined && targetGuildId !== guildId && deps.canAccessGuild !== undefined
          && !await deps.canAccessGuild(targetGuildId)) {
        return error(`Guild '${targetGuildId}' not found or not accessible.`);
      }

      const after = parseDateFilter(p.after, "after", timezone);
      if (typeof after === "string") return error(after);
      const before = parseDateFilter(p.before, "before", timezone);
      if (typeof before === "string") return error(before);
      if (after !== undefined && before !== undefined && after >= before) return error("after must be earlier than before.");
      const initialCursor = beforeMessageId === undefined ? undefined : getMessageSearchCursor(db, beforeMessageId);
      if (beforeMessageId !== undefined && initialCursor === null) {
        return error(`Cursor message '${beforeMessageId}' was not found.`);
      }

      let accessibleChannelIds: string[] | undefined;
      if (scopedChannelId === undefined && deps.resolveChannel !== undefined) {
        const rows = targetGuildId === undefined
          ? db.raw.prepare("SELECT DISTINCT channel_id FROM messages").all() as Array<{ channel_id: string }>
          : db.raw.prepare("SELECT DISTINCT channel_id FROM messages WHERE guild_id = ?").all(targetGuildId) as Array<{ channel_id: string }>;
        const resolved = await Promise.all(rows.map(async ({ channel_id: channelId }) => ({
          channelId,
          channel: await deps.resolveChannel?.(channelId).catch(() => null),
        })));
        accessibleChannelIds = resolved
          .filter(({ channel }) => channel !== null && channel !== undefined
            && (targetGuildId === undefined || channel.guildId === targetGuildId))
          .map(({ channelId }) => channelId);
      } else if (scope === "all_guilds") {
        return error("All-guild search is unavailable because accessible channels cannot be verified.");
      }

      const limit = Math.max(1, Math.min(p.limit ?? 10, 50));
      const candidateFilter: SearchMessageCandidatesFilter = {
        ...(targetGuildId !== undefined ? { guildId: targetGuildId } : {}),
        ...(scopedChannelId !== undefined ? { channelId: scopedChannelId } : {}),
        ...(accessibleChannelIds !== undefined ? { channelIds: accessibleChannelIds } : {}),
        ...(username !== undefined ? { username } : {}),
        ...(userId !== undefined ? { userId } : {}),
        ...(assetId !== undefined ? { assetId } : {}),
        ...(p.has_assets !== undefined ? { hasAssets: p.has_assets } : {}),
        ...(p.asset_kind !== undefined ? { assetKind: p.asset_kind } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(initialCursor !== undefined && initialCursor !== null ? { cursor: initialCursor } : {}),
      };
      let matches: SearchMessageMatch[];
      let candidatesScanned: number;
      if (pattern !== undefined) {
        try {
          const regexResult = await regexFilterCandidates(
            db,
            candidateFilter,
            pattern,
            limit + 1,
            candidateChunkSize,
            signal ?? AbortSignal.timeout(30_000),
          );
          matches = regexResult.matches;
          candidatesScanned = regexResult.candidatesScanned;
        } catch (cause) {
          return error(cause instanceof Error ? cause.message : "Regex search failed.");
        }
      } else {
        const candidates = findMessageSearchCandidates(db, { ...candidateFilter, limit: limit + 1 });
        matches = candidates;
        candidatesScanned = candidates.length;
      }
      const hasMore = matches.length > limit;
      matches = matches.slice(0, limit);
      const nextBeforeMessageId = hasMore ? matches.at(-1)?.messageId : undefined;
      const durationMs = Math.round(performance.now() - startedAt);
      deps.logger?.debug("message search complete", {
        scope,
        pattern: pattern ?? null,
        count: matches.length,
        hasMore,
        candidatesScanned,
        durationMs,
      });
      if (matches.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No messages matched these filters. This does not rule out another scope or an uncertain filter.",
          }],
          details: { count: 0, has_more: false, candidates_scanned: candidatesScanned, duration_ms: durationMs },
        };
      }

      matches.reverse();
      const locations = new Map(matches.map((match) => [match.messageId, match]));
      const messages = getHistoryMessagesByIds(db, matches.map((match) => match.messageId)).map((message) => {
        const location = locations.get(message.id);
        return location !== undefined
          && (scopedChannelId === undefined || location.channelId !== currentChannelId || location.guildId !== guildId)
          ? { ...message, historyAnnotations: [`GuildID: ${location.guildId}`, `ChannelID: ${location.channelId}`] }
          : message;
      });
      const replyIds = messages.flatMap((message) => message.replyToId === null ? [] : [message.replyToId]);
      const replies = resolveReplies({
        older: [],
        newer: messages,
        latestUserMessage: null,
        replyQuoteChars: 200,
        extraLookup: getHistoryMessagesByIds(db, replyIds),
      }).newer;
      const intro = pattern === undefined
        ? `Message search — ${messages.length} newest matches, rendered chronologically.`
        : `Search results for /${pattern}/ — ${messages.length} newest matches, rendered chronologically.`;
      const lines = [intro, ...messages.map((message) =>
        `[${formatLocalWallClock(message.timestamp, timezone)}]\n${formatMessageLine({
          message,
          reply: replies.get(message.id) ?? null,
          includeMessageIds: true,
        })}`)];
      if (hasMore && nextBeforeMessageId !== undefined) {
        lines.push(`More matches are available. next_before_message_id=${nextBeforeMessageId}`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: {
          count: messages.length,
          has_more: hasMore,
          ...(nextBeforeMessageId !== undefined ? { next_before_message_id: nextBeforeMessageId } : {}),
          candidates_scanned: candidatesScanned,
          duration_ms: durationMs,
        },
      };
    },
  });
}

function parseDateFilter(value: string | undefined, name: string, timezone: string): number | string | undefined {
  if (value === undefined) return undefined;
  const parsed = parseLocalDateTimeToEpoch(value.trim(), timezone);
  return parsed.ok ? parsed.epochMs : `Invalid ${name}: ${parsed.error}`;
}

async function regexFilterCandidates(
  db: Database,
  filter: SearchMessageCandidatesFilter,
  pattern: string,
  maxMatches: number,
  chunkSize: number,
  signal: AbortSignal,
): Promise<{ matches: SearchMessageMatch[]; candidatesScanned: number }> {
  let cursor: MessageSearchCursor | undefined = filter.cursor;
  let candidatesScanned = 0;
  function* candidateChunks(): Generator<string> {
    for (;;) {
      signal.throwIfAborted();
      const candidates = findMessageSearchCandidates(db, {
        ...filter,
        ...(cursor !== undefined ? { cursor } : {}),
        limit: chunkSize,
      });
      if (candidates.length === 0) return;
      candidatesScanned += candidates.length;
      yield candidates.map(formatCandidateLine).join("");
      const last = candidates.at(-1);
      if (last === undefined || candidates.length < chunkSize) return;
      cursor = { messageId: last.messageId, createdAt: last.createdAt };
    }
  }
  const stdout = await runRipgrepChunks([
    "--json",
    "--text",
    "--color=never",
    `--max-count=${maxMatches}`,
    "--regexp",
    pattern,
  ], candidateChunks(), signal);
  if (stdout === null) return { matches: [], candidatesScanned };
  const messageIds: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const event = JSON.parse(line) as { type?: unknown; data?: { lines?: { text?: unknown } } };
    const matchedLine = event.data?.lines?.text;
    if (event.type !== "match" || typeof matchedLine !== "string") continue;
    const separator = matchedLine.indexOf("\t");
    if (separator > 0) messageIds.push(matchedLine.slice(0, separator));
  }
  return { matches: getMessageSearchMatchesByIds(db, messageIds), candidatesScanned };
}

function formatCandidateLine(candidate: SearchMessageCandidate): string {
  return [
    candidate.messageId,
    candidate.content,
    candidate.assetSearchText,
  ].join("\t")
    .replace(/[\r\n]+/g, " ")
    .replaceAll(String.fromCharCode(30), " ")
    .replaceAll(String.fromCharCode(31), " ")
    + "\n";
}

function error(text: string): AgentToolResult<{ error: boolean }> {
  return { content: [{ type: "text", text }], details: { error: true } };
}
