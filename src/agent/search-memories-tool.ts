import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database";
import { listMemories, type MemoryRow } from "../db/memory-repository";
import { formatMemorySearchRow } from "./memory-service.ts";
import { runRipgrep } from "./ripgrep.ts";
import { markReadOnlyTool } from "./tool-effects.ts";

export interface SearchMemoriesToolDeps {
  db: Database;
  currentGuildId: string;
  resolveUsername: (username: string, guildId: string) => Promise<string | undefined>;
  resolveGuildName?: (guildId: string) => string | undefined;
  resolveUsernameById?: (userId: string) => string | undefined;
  canAccessGuild?: (guildId: string) => Promise<boolean>;
  isUserInGuild?: (userId: string, guildId: string) => Promise<boolean>;
}

interface MemoryCursor {
  version: 1;
  priority: number;
  updatedAt: number;
  id: number;
}

type SearchMemoriesToolResult = AgentToolResult<
  | {
    guildId: string;
    userId?: string;
    count: number;
    total: number;
    hasMore: boolean;
    nextCursor?: string;
  }
  | { error: true }
>;

const SearchMemoriesParams = Type.Object({
  pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: "Optional ripgrep regex." })),
  user: Type.Optional(Type.String({ minLength: 1, description: "Optional username, mention, or Discord user ID." })),
  guild_id: Type.Optional(Type.String({ minLength: 1, description: "Optional accessible guild override." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Page size." })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512, description: "Opaque page cursor." })),
});

function error(text: string): SearchMemoriesToolResult {
  return { content: [{ type: "text", text }], details: { error: true } };
}

function normalizedUserReference(value: string): string {
  return value.trim().replace(/^@+/, "").trim();
}

function explicitUserId(value: string): string | undefined {
  return /^(?:user:)?(\d{17,20})$/.exec(value)?.[1];
}

function encodeCursor(row: MemoryRow): string {
  const cursor: MemoryCursor = {
    version: 1,
    priority: row.priority,
    updatedAt: row.updatedAt,
    id: row.id,
  };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string | undefined): MemoryCursor | null | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== 1
      || !Number.isInteger(candidate.priority) || Number(candidate.priority) < 0
      || !Number.isInteger(candidate.updatedAt) || Number(candidate.updatedAt) < 0
      || !Number.isInteger(candidate.id) || Number(candidate.id) < 1) return null;
    return {
      version: 1,
      priority: Number(candidate.priority),
      updatedAt: Number(candidate.updatedAt),
      id: Number(candidate.id),
    };
  } catch {
    return null;
  }
}

function isAfterCursor(row: MemoryRow, cursor: MemoryCursor): boolean {
  if (row.priority !== cursor.priority) return row.priority < cursor.priority;
  if (row.updatedAt !== cursor.updatedAt) return row.updatedAt < cursor.updatedAt;
  return row.id < cursor.id;
}

async function filterAccessibleUserMemories(
  rows: MemoryRow[],
  guildId: string,
  isUserInGuild: SearchMemoriesToolDeps["isUserInGuild"],
): Promise<MemoryRow[]> {
  if (isUserInGuild === undefined) return rows;
  const userIds = [...new Set(rows.flatMap((row) => row.about === "user" && row.aboutUserId !== null ? [row.aboutUserId] : []))];
  const membership = new Map(await Promise.all(userIds.map(async (userId) => [
    userId,
    await isUserInGuild(userId, guildId),
  ] as const)));
  return rows.filter((row) => row.about !== "user"
    || row.aboutUserId === null
    || membership.get(row.aboutUserId) === true);
}

async function regexFilterRows(
  rows: MemoryRow[],
  formattedRows: string[],
  pattern: string,
  signal: AbortSignal,
): Promise<MemoryRow[]> {
  const searchable = formattedRows
    .map((row) => row.replace(/[\r\n]+/g, " "))
    .join("\n");
  const stdout = await runRipgrep([
    "--json",
    "--text",
    "--color=never",
    "--regexp",
    pattern,
  ], searchable, signal);
  if (stdout === null) return [];
  const matches: MemoryRow[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const event = JSON.parse(line) as { type?: unknown; data?: { line_number?: unknown } };
    if (event.type !== "match" || typeof event.data?.line_number !== "number") continue;
    const row = rows[event.data.line_number - 1];
    if (row !== undefined) matches.push(row);
  }
  return matches;
}

/** Create the compact read-only memory discovery tool. */
export function createSearchMemoriesTool(deps: SearchMemoriesToolDeps): AgentTool {
  return markReadOnlyTool({
    name: "search_memories",
    label: "search_memories",
    description: "List or regex-search available memories.",
    parameters: SearchMemoriesParams,

    async execute(_toolCallId: string, params: unknown, signal): Promise<SearchMemoriesToolResult> {
      const p = params as {
        pattern?: string;
        user?: string;
        guild_id?: string;
        limit?: number;
        cursor?: string;
      };
      const pattern = p.pattern?.trim();
      if (pattern === "") return error("pattern cannot be empty.");
      const cursor = decodeCursor(p.cursor);
      if (cursor === null) return error("Invalid memory cursor.");

      const guildId = typeof p.guild_id === "string" && p.guild_id.trim() !== ""
        ? p.guild_id.trim()
        : deps.currentGuildId;
      if (guildId !== deps.currentGuildId
        && deps.canAccessGuild !== undefined
        && !await deps.canAccessGuild(guildId)) {
        return error(`Guild '${guildId}' not found or not accessible.`);
      }

      let userId: string | undefined;
      let userLabel: string | undefined;
      if (p.user !== undefined) {
        const user = normalizedUserReference(p.user);
        if (user === "") return error("user cannot be empty.");
        const rawUserId = explicitUserId(user);
        if (rawUserId !== undefined) {
          if (deps.isUserInGuild !== undefined && !await deps.isUserInGuild(rawUserId, guildId)) {
            return error(`User '${rawUserId}' not found in guild ${guildId}.`);
          }
          userId = rawUserId;
          userLabel = deps.resolveUsernameById?.(rawUserId) ?? `user:${rawUserId}`;
        } else {
          userId = await deps.resolveUsername(user, guildId);
          userLabel = `@${user}`;
        }
        if (userId === undefined || userId === "") return error(`User '${userLabel}' not found in guild ${guildId}.`);
      }

      let rows = await filterAccessibleUserMemories(
        listMemories(deps.db, { guildId, about: "any" }),
        guildId,
        deps.isUserInGuild,
      );
      if (userId !== undefined) {
        rows = rows.filter((row) => row.aboutUserId === userId
          || (row.recallWhen !== "always" && row.recallWhen.includes(userId)));
      }

      const formatRow = (row: MemoryRow): string => formatMemorySearchRow(row, guildId, deps.resolveUsernameById);
      if (pattern !== undefined) {
        try {
          rows = await regexFilterRows(
            rows,
            rows.map(formatRow),
            pattern,
            signal ?? AbortSignal.timeout(30_000),
          );
        } catch (cause) {
          return error(cause instanceof Error ? cause.message : "Memory regex search failed.");
        }
      }

      const total = rows.length;
      if (cursor !== undefined) rows = rows.filter((row) => isAfterCursor(row, cursor));
      const limit = Math.max(1, Math.min(Math.floor(p.limit ?? 50), 50));
      const page = rows.slice(0, limit + 1);
      const hasMore = page.length > limit;
      const shown = hasMore ? page.slice(0, limit) : page;
      const last = shown.at(-1);
      const nextCursor = hasMore && last !== undefined ? encodeCursor(last) : undefined;

      if (shown.length === 0) {
        return {
          content: [{ type: "text", text: cursor === undefined
            ? "No memories found matching those filters."
            : "No more memories found matching those filters." }],
          details: {
            guildId,
            ...(userId !== undefined ? { userId } : {}),
            count: 0,
            total,
            hasMore: false,
          },
        };
      }

      const guildName = deps.resolveGuildName?.(guildId);
      const guildLabel = guildId === deps.currentGuildId
        ? "current guild"
        : guildName !== undefined && guildName !== "" ? `${guildName} (${guildId})` : guildId;
      const searchLabel = [
        userLabel !== undefined ? ` for ${userLabel.startsWith("@") || userLabel.startsWith("user:") ? userLabel : `@${userLabel}`}` : "",
        pattern !== undefined ? ` /${pattern}/` : "",
      ].join("");
      const footer = nextCursor === undefined
        ? "End of memories."
        : `More memories are available.\nnext_cursor=${nextCursor}`;
      const sourceLegend = shown.some((row) => row.sourceMessageId !== null)
        ? "\nLegend: a final bare [DiscordMsgID] is the optional source message."
        : "";
      return {
        content: [{
          type: "text",
          text: `Memory search${searchLabel} in ${guildLabel} — ${shown.length}/${total} shown.${sourceLegend}\n\n${shown.map(formatRow).join("\n")}\n\n${footer}`,
        }],
        details: {
          guildId,
          ...(userId !== undefined ? { userId } : {}),
          count: shown.length,
          total,
          hasMore,
          ...(nextCursor !== undefined ? { nextCursor } : {}),
        },
      };
    },
  });
}
