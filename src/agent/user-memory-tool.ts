import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Database } from "../db/database";
import { countMemories, listMemories, type MemoryRow } from "../db/memory-repository";

export interface MemoryListToolDeps {
  db: Database;
  currentGuildId: string;
  /** Resolve a Discord username, with or without @, to a user ID in the requested guild. */
  resolveUsername: (username: string, guildId: string) => Promise<string | undefined>;
  resolveGuildName?: (guildId: string) => string | undefined;
  resolveUsernameById?: (userId: string) => string | undefined;
  canAccessGuild?: (guildId: string) => Promise<boolean>;
  isUserInGuild?: (userId: string, guildId: string) => Promise<boolean>;
}

export type UserMemoryToolDeps = MemoryListToolDeps;

type MemoryListToolResult = AgentToolResult<
  | { target: "guild"; guildId: string; count: number; total: number }
  | { target: "self"; count: number; total: number }
  | { target: "user"; userId: string; count: number; total: number }
  | { error: boolean }
>;

const MemoryListParams = Type.Object({
  target: Type.Optional(Type.Union([
    Type.Literal("user"),
    Type.Literal("guild"),
    Type.Literal("self"),
  ], {
    description: "Memory target. Defaults to user when username/user_id is provided, otherwise guild. Use self for the bot/persona's own continuity and journal.",
  })),
  username: Type.Optional(Type.String({
    minLength: 1,
    description: "Discord username for target=user. A leading @ is optional. Resolved in guild_id or the current guild.",
  })),
  user_id: Type.Optional(Type.String({
    minLength: 1,
    description: "Discord user ID for target=user. User memories are guild-agnostic.",
  })),
  guild_id: Type.Optional(Type.String({
    minLength: 1,
    description: "Guild ID for target=guild, or the guild to resolve username in. Defaults to the current guild.",
  })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max memories to return. Default 30." })),
});

function normalizeUsername(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
}

function formatConfidence(confidence: number): string {
  return confidence.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatMemory(row: MemoryRow): string {
  const scope = row.scope === "self"
    ? "self"
    : row.subjectUserId === null
    ? `guild:${row.guildId ?? "unknown"}`
    : `user:${row.subjectUserId}`;
  return `- ${row.id} [${scope}] [${formatConfidence(row.confidence)}] [${row.kind}] ${row.content}`;
}

/** Create a read-only tool for retrieving guild or user memories. */
export function createMemoryListTool(deps: MemoryListToolDeps): AgentTool {
  const { db, currentGuildId, resolveUsername } = deps;

  return {
    name: "list_memories",
    label: "list_memories",
    description:
      "Retrieve bot memories. User memories are Discord-user scoped and shared across guilds; guild memories are shared facts for one guild/server; self memories are the bot/persona's own portable continuity and private journal. The prompt already includes current-speaker user memories, current-guild memories, and self memories. Use target=user with username/user_id for a person, target=guild for a guild's shared memories, or target=self to inspect the bot/persona's own continuity. Do not casually reveal private facts learned in one guild to another; use only what is needed for the current conversation.",
    parameters: MemoryListParams,

    async execute(_toolCallId: string, params: unknown): Promise<MemoryListToolResult> {
      const p = params as {
        target?: "user" | "guild" | "self";
        username?: string;
        user_id?: string;
        guild_id?: string;
        limit?: number;
      };
      const guildId = typeof p.guild_id === "string" && p.guild_id.trim() !== "" ? p.guild_id.trim() : currentGuildId;
      const target = p.target ?? (p.username !== undefined || p.user_id !== undefined ? "user" : "guild");

      const limit = typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.min(Math.floor(p.limit), 50))
        : 30;

      if (target === "guild") {
        if (guildId !== currentGuildId && deps.canAccessGuild !== undefined && !await deps.canAccessGuild(guildId)) {
          return {
            content: [{ type: "text", text: `Guild '${guildId}' not found or not accessible.` }],
            details: { error: true },
          };
        }
        const total = countMemories(db, { guildId, subjectUserId: null });
        const rows = listMemories(db, { guildId, subjectUserId: null, limit }).filter((row) => row.content.trim() !== "");
        const guildName = deps.resolveGuildName?.(guildId);
        const label = guildName !== undefined && guildName !== "" ? `${guildName} (${guildId})` : guildId;
        if (rows.length === 0) {
          return {
            content: [{ type: "text", text: `No guild memories found for ${label}.` }],
            details: { target: "guild", guildId, count: 0, total },
          };
        }
        return {
          content: [{ type: "text", text: `Guild memories for ${label} (${rows.length}/${total} shown):\n${rows.map(formatMemory).join("\n")}` }],
          details: { target: "guild", guildId, count: rows.length, total },
        };
      }

      if (target === "self") {
        const total = countMemories(db, { guildId, scope: "self" });
        const rows = listMemories(db, { guildId, scope: "self", limit }).filter((row) => row.content.trim() !== "");
        if (rows.length === 0) {
          return {
            content: [{ type: "text", text: "No self memories found." }],
            details: { target: "self", count: 0, total },
          };
        }
        return {
          content: [{ type: "text", text: `Self memories (${rows.length}/${total} shown):\n${rows.map(formatMemory).join("\n")}` }],
          details: { target: "self", count: rows.length, total },
        };
      }

      let userId: string | undefined;
      let label: string;
      if (typeof p.user_id === "string" && p.user_id.trim() !== "") {
        userId = p.user_id.trim();
        label = deps.resolveUsernameById?.(userId) ?? userId;
        if (deps.isUserInGuild !== undefined && !await deps.isUserInGuild(userId, guildId)) {
          return {
            content: [{ type: "text", text: `User '${userId}' not found in guild ${guildId}.` }],
            details: { error: true },
          };
        }
      } else if (typeof p.username === "string" && p.username.trim() !== "") {
        const username = normalizeUsername(p.username);
        userId = await resolveUsername(username, guildId);
        label = `@${username}`;
      } else {
        return {
          content: [{ type: "text", text: "target=user requires username or user_id." }],
          details: { error: true },
        };
      }

      if (userId === undefined || userId === "") {
        return {
          content: [{ type: "text", text: `User '${label}' not found in guild ${guildId}.` }],
          details: { error: true },
        };
      }

      const total = countMemories(db, { guildId, subjectUserId: userId });
      const rows = listMemories(db, { guildId, subjectUserId: userId, limit }).filter((row) => row.content.trim() !== "");
      const resolvedLabel = label.startsWith("@") || label === userId ? label : `@${label}`;
      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: `No portable user memories found for ${resolvedLabel}. Current-guild memories are separate; use target=guild for shared server facts.` }],
          details: { target, userId, count: 0, total },
        };
      }

      return {
        content: [{ type: "text", text: `Portable user memories for ${resolvedLabel} (${rows.length}/${total} shown):\n${rows.map(formatMemory).join("\n")}` }],
        details: { target, userId, count: rows.length, total },
      };
    },
  };
}

export function createUserMemoryTool(deps: UserMemoryToolDeps): AgentTool {
  return createMemoryListTool(deps);
}
