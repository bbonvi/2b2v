import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database.ts";
import type { AssetKind } from "../db/asset-repository.ts";
import {
  findMessageSearchCandidates,
  getHistoryMessagesByIds,
  type SearchMessageCandidate,
} from "../db/message-repository.ts";
import { formatLocalWallClock, parseLocalDateTimeToEpoch } from "../time/agent-time.ts";
import { AssetIdSchema, parseAssetId } from "./asset-id.ts";
import { formatMessageLine } from "./history-formatting.ts";
import { resolveReplies } from "./history-replies.ts";
import { runRipgrep } from "./ripgrep.ts";

const ASSET_KINDS = ["image", "gif", "audio", "video", "text", "file"] as const;

export interface SearchChannelMessagesToolDeps {
  db: Database;
  guildId: string;
  /** Channel/thread/DM that initiated this agent turn; searches default here. */
  currentChannelId: string;
  timezone: string;
  resolveChannel?: (channelId: string) => Promise<{ guildId: string; channelId: string } | null>;
  canAccessGuild?: (guildId: string) => Promise<boolean>;
}

const SearchChannelMessagesParams = Type.Object({
  pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: "Ripgrep-compatible regular expression." })),
  username: Type.Optional(Type.String({ description: "Stored historical Discord username." })),
  user_id: Type.Optional(Type.String({ description: "Stable Discord user ID." })),
  guild_id: Type.Optional(Type.String({ description: "Guild ID filter." })),
  channel_id: Type.Optional(Type.String({ description: "Guild channel or thread filter." })),
  asset_id: Type.Optional(AssetIdSchema),
  has_assets: Type.Optional(Type.Boolean({ description: "Filter by whether a message has indexed assets." })),
  asset_kind: Type.Optional(Type.Union(ASSET_KINDS.map((kind) => Type.Literal(kind)), { description: "Indexed asset type." })),
  after: Type.Optional(Type.String({ description: "Local wall-clock lower bound, YYYY-MM-DD HH:mm." })),
  before: Type.Optional(Type.String({ description: "Local wall-clock upper bound, YYYY-MM-DD HH:mm." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum results." })),
});

/** Strip one leading @ and trim whitespace from a username-like input. */
export function normalizeUsername(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
}

/** Create a local indexed Discord message and attachment discovery tool. */
export function createSearchChannelMessagesTool(deps: SearchChannelMessagesToolDeps): AgentTool {
  const { db, guildId, currentChannelId, timezone } = deps;
  return {
    name: "search_channel_messages",
    label: "Search Channel Messages",
    description: "Regex-search stored Discord messages and indexed attachment metadata using optional structured filters.",
    parameters: SearchChannelMessagesParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ count: number } | { error: boolean }>> {
      const p = params as {
        pattern?: string;
        username?: string;
        user_id?: string;
        guild_id?: string;
        channel_id?: string;
        asset_id?: unknown;
        has_assets?: boolean;
        asset_kind?: AssetKind;
        after?: string;
        before?: string;
        limit?: number;
      };
      const pattern = p.pattern?.trim();
      const username = p.username === undefined ? undefined : normalizeUsername(p.username);
      const userId = p.user_id?.trim();
      const explicitGuildId = p.guild_id !== undefined && p.guild_id.trim() !== "";
      const explicitChannelId = p.channel_id !== undefined && p.channel_id.trim() !== "";
      const parsedAssetId = p.asset_id === undefined ? undefined : parseAssetId(p.asset_id);
      if (parsedAssetId === null) return error("asset_id must be a positive integer, optionally prefixed with #");
      const assetId = parsedAssetId;
      if (username === "" || userId === "") return error("username and user_id cannot be empty.");
      if (pattern === "") return error("pattern cannot be empty.");
      const hasNarrowingFilter = explicitGuildId || explicitChannelId || username !== undefined || userId !== undefined
        || assetId !== undefined || p.has_assets !== undefined || p.asset_kind !== undefined
        || p.after !== undefined || p.before !== undefined;
      if (pattern === undefined && !hasNarrowingFilter) {
        return error("Provide a regex pattern or at least one narrowing filter.");
      }

      let targetGuildId = explicitGuildId ? p.guild_id?.trim() ?? guildId : guildId;
      let scopedChannelId: string | undefined = explicitGuildId ? undefined : currentChannelId;
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
      if (scopedChannelId === undefined && targetGuildId !== guildId && deps.canAccessGuild !== undefined
          && !await deps.canAccessGuild(targetGuildId)) {
        return error(`Guild '${targetGuildId}' not found or not accessible.`);
      }

      const after = parseDateFilter(p.after, "after", timezone);
      if (typeof after === "string") return error(after);
      const before = parseDateFilter(p.before, "before", timezone);
      if (typeof before === "string") return error(before);
      if (after !== undefined && before !== undefined && after >= before) return error("after must be earlier than before.");

      let accessibleChannelIds: string[] | undefined;
      if (scopedChannelId === undefined && deps.resolveChannel !== undefined) {
        const rows = db.raw.prepare("SELECT DISTINCT channel_id FROM messages WHERE guild_id = ?").all(targetGuildId) as Array<{ channel_id: string }>;
        const resolved = await Promise.all(rows.map(async ({ channel_id: channelId }) => ({
          channelId,
          channel: await deps.resolveChannel?.(channelId).catch(() => null),
        })));
        accessibleChannelIds = resolved
          .filter(({ channel }) => channel !== null && channel !== undefined && channel.guildId === targetGuildId)
          .map(({ channelId }) => channelId);
      }

      const limit = Math.max(1, Math.min(p.limit ?? 10, 50));
      let candidates = findMessageSearchCandidates(db, {
        guildId: targetGuildId,
        ...(scopedChannelId !== undefined ? { channelId: scopedChannelId } : {}),
        ...(accessibleChannelIds !== undefined ? { channelIds: accessibleChannelIds } : {}),
        ...(username !== undefined ? { username } : {}),
        ...(userId !== undefined ? { userId } : {}),
        ...(assetId !== undefined ? { assetId } : {}),
        ...(p.has_assets !== undefined ? { hasAssets: p.has_assets } : {}),
        ...(p.asset_kind !== undefined ? { assetKind: p.asset_kind } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(pattern === undefined ? { limit } : {}),
      });
      if (pattern !== undefined) {
        try {
          candidates = await regexFilterCandidates(candidates, pattern, limit, signal ?? AbortSignal.timeout(30_000));
        } catch (cause) {
          return error(cause instanceof Error ? cause.message : "Regex search failed.");
        }
      }
      if (candidates.length === 0) {
        return { content: [{ type: "text", text: "No messages found matching those filters." }], details: { count: 0 } };
      }

      candidates.reverse();
      const locations = new Map(candidates.map((candidate) => [candidate.messageId, candidate]));
      const messages = getHistoryMessagesByIds(db, candidates.map((candidate) => candidate.messageId)).map((message) => {
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
        captioningEnabled: false,
        extraLookup: getHistoryMessagesByIds(db, replyIds),
      }).newer;
      const intro = pattern === undefined
        ? `Message search — ${messages.length} newest matches, rendered chronologically.`
        : `Search results for /${pattern}/ — ${messages.length} newest matches, rendered chronologically.`;
      const lines = [intro, ...messages.map((message) =>
        `[${formatLocalWallClock(message.timestamp, timezone)}]\n${formatMessageLine({
          message,
          reply: replies.get(message.id) ?? null,
          captioningEnabled: false,
          includeMessageIds: true,
        })}`)];
      return { content: [{ type: "text", text: lines.join("\n\n") }], details: { count: messages.length } };
    },
  };
}

function parseDateFilter(value: string | undefined, name: string, timezone: string): number | string | undefined {
  if (value === undefined) return undefined;
  const parsed = parseLocalDateTimeToEpoch(value.trim(), timezone);
  return parsed.ok ? parsed.epochMs : `Invalid ${name}: ${parsed.error}`;
}

async function regexFilterCandidates(
  candidates: SearchMessageCandidate[],
  pattern: string,
  limit: number,
  signal: AbortSignal,
): Promise<SearchMessageCandidate[]> {
  // ponytail: arbitrary regex is an O(history) scan; add FTS preselection only if histories reach millions of rows.
  const searchable = candidates.map((candidate) => [
    candidate.messageId,
    candidate.content,
    candidate.assetSearchText,
  ].join("\t").replace(/[\r\n]+/g, " ").replaceAll(String.fromCharCode(30), " ").replaceAll(String.fromCharCode(31), " ")).join("\n");
  const stdout = await runRipgrep([
    "--json",
    "--text",
    "--color=never",
    `--max-count=${limit}`,
    "--regexp",
    pattern,
  ], searchable, signal);
  if (stdout === null) return [];
  const indexes: number[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const event = JSON.parse(line) as { type?: unknown; data?: { line_number?: unknown } };
    if (event.type !== "match" || typeof event.data?.line_number !== "number") continue;
    indexes.push(event.data.line_number - 1);
  }
  return indexes.flatMap((index) => {
    const candidate = candidates[index];
    return candidate === undefined ? [] : [candidate];
  });
}

function error(text: string): AgentToolResult<{ error: boolean }> {
  return { content: [{ type: "text", text }], details: { error: true } };
}
