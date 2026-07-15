import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
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
  | { target: "community"; guildId: string; count: number; total: number }
  | { target: "self"; count: number; total: number }
  | { target: "user"; userId: string; count: number; total: number }
  | { error: boolean }
>;

const MemoryListParams = Type.Object({
  target: Type.Optional(Type.Union([
    Type.Literal("user"),
    Type.Literal("community"),
    Type.Literal("self"),
  ], {
    description: "Memory target.",
  })),
  username: Type.Optional(Type.String({
    minLength: 1,
    description: "Discord username for target=user.",
  })),
  user_id: Type.Optional(Type.String({
    minLength: 1,
    description: "Discord user ID for target=user.",
  })),
  guild_id: Type.Optional(Type.String({
    minLength: 1,
    description: "Guild ID for target=community or username resolution.",
  })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max memories to return." })),
});

function normalizeUsername(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
}

function formatConfidence(confidence: number): string {
  return confidence.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatMemory(row: MemoryRow): string {
  const about = row.about === "user" && row.aboutUserId !== null ? `user:${row.aboutUserId}` : row.about;
  const recallIn = row.recallIn === "anywhere" ? "anywhere" : `guild:${row.recallIn.guildId}`;
  const recallWhen = row.recallWhen === "always"
    ? "always"
    : `any(${row.recallWhen.map((userId) => `user:${userId}`).join(",")})`;
  return `- ${row.id} [about:${about}] [in:${recallIn}] [when:${recallWhen}] [${formatConfidence(row.confidence)}] [${row.kind}]${row.priority > 0 ? " [IMPORTANT]" : ""} ${row.content}`;
}

function formatUserMemory(row: MemoryRow): string {
  return `- ${row.id} [${formatConfidence(row.confidence)}] [${row.kind}]${row.priority > 0 ? " [IMPORTANT]" : ""} ${row.content}`;
}

function formatUserHeaderLabel(label: string, userId: string): string {
  if (label === userId) return `user:${userId}`;
  const resolvedLabel = label.startsWith("@") || label === userId ? label : `@${label}`;
  return `${resolvedLabel} (user:${userId})`;
}

/** Create a read-only tool for retrieving community, self, or user memories. */
export function createMemoryListTool(deps: MemoryListToolDeps): AgentTool {
  const { db, currentGuildId, resolveUsername } = deps;

  return {
    name: "list_memories",
    label: "list_memories",
    description: "Retrieve bot memories.",
    parameters: MemoryListParams,

    async execute(_toolCallId: string, params: unknown): Promise<MemoryListToolResult> {
      const p = params as {
        target?: "user" | "community" | "self";
        username?: string;
        user_id?: string;
        guild_id?: string;
        limit?: number;
      };
      const guildId = typeof p.guild_id === "string" && p.guild_id.trim() !== "" ? p.guild_id.trim() : currentGuildId;
      const target = p.target ?? (p.username !== undefined || p.user_id !== undefined ? "user" : "community");

      const limit = typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.min(Math.floor(p.limit), 50))
        : 30;

      if (target === "community") {
        if (guildId !== currentGuildId && deps.canAccessGuild !== undefined && !await deps.canAccessGuild(guildId)) {
          return {
            content: [{ type: "text", text: `Guild '${guildId}' not found or not accessible.` }],
            details: { error: true },
          };
        }
        const total = countMemories(db, { guildId, about: "community" });
        const rows = listMemories(db, { guildId, about: "community", limit }).filter((row) => row.content.trim() !== "");
        const guildName = deps.resolveGuildName?.(guildId);
        const label = guildName !== undefined && guildName !== "" ? `${guildName} (${guildId})` : guildId;
        if (rows.length === 0) {
          return {
            content: [{ type: "text", text: `No community memories found for ${label}.` }],
            details: { target: "community", guildId, count: 0, total },
          };
        }
        return {
          content: [{ type: "text", text: `Community memories for ${label} (${rows.length}/${total} shown):\n${rows.map(formatMemory).join("\n")}` }],
          details: { target: "community", guildId, count: rows.length, total },
        };
      }

      if (target === "self") {
        const total = countMemories(db, { guildId, about: "self" });
        const rows = listMemories(db, { guildId, about: "self", limit }).filter((row) => row.content.trim() !== "");
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

      const total = countMemories(db, { guildId, aboutUserId: userId });
      const rows = listMemories(db, { guildId, aboutUserId: userId, limit }).filter((row) => row.content.trim() !== "");
      const headerLabel = formatUserHeaderLabel(label, userId);
      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: `No user memories available here for ${headerLabel}.` }],
          details: { target, userId, count: 0, total },
        };
      }

      return {
        content: [{ type: "text", text: `User memories for ${headerLabel} (${rows.length}/${total} shown):\n${rows.map(formatUserMemory).join("\n")}` }],
        details: { target, userId, count: rows.length, total },
      };
    },
  };
}

export function createUserMemoryTool(deps: UserMemoryToolDeps): AgentTool {
  return createMemoryListTool(deps);
}
