import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Database } from "../db/database";
import { listMemories } from "../db/memory-repository";

export interface UserMemoryToolDeps {
  db: Database;
  guildId: string;
  /** Resolve a Discord username, with or without @, to a guild-scoped user ID. */
  resolveUsername: (username: string) => Promise<string | undefined>;
}

type UserMemoryToolResult = AgentToolResult<{ userId: string; count: number } | { error: boolean }>;

const UserMemoryParams = Type.Object({
  username: Type.String({
    minLength: 1,
    description: "Discord username to retrieve memories for. A leading @ is optional.",
  }),
  limit: Type.Optional(Type.Number({ description: "Max memories to return. Default 20, max 50." })),
});

/** Create a read-only tool for retrieving another guild member's user-scoped memories. */
export function createUserMemoryTool(deps: UserMemoryToolDeps): AgentTool {
  const { db, guildId, resolveUsername } = deps;

  return {
    name: "get_user_memory",
    label: "get_user_memory",
    description:
      "Retrieve guild-scoped memories for a specific user by username. By default, the prompt already includes global memories and memories for the user currently being replied to; use this tool when you need more information about another server member. Accepts usernames with or without a leading @. Does not return global memories.",
    parameters: UserMemoryParams,

    async execute(_toolCallId: string, params: unknown): Promise<UserMemoryToolResult> {
      const p = params as { username?: string; limit?: number };
      const rawUsername = typeof p.username === "string" ? p.username.trim() : "";
      const username = rawUsername.startsWith("@") ? rawUsername.slice(1).trim() : rawUsername;
      if (username === "") {
        return {
          content: [{ type: "text", text: "Username is required." }],
          details: { error: true },
        };
      }

      const userId = await resolveUsername(username);
      if (userId === undefined) {
        return {
          content: [{ type: "text", text: `User '@${username}' not found in this guild.` }],
          details: { error: true },
        };
      }

      const limit = Math.max(1, Math.min(p.limit ?? 20, 50));
      const rows = listMemories(db, {
        guildId,
        subjectUserId: userId,
        limit,
      }).filter((row) => row.content.trim() !== "");

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: `No user-specific memories found for @${username}. Global memories are already present in the prompt.` }],
          details: { userId, count: 0 },
        };
      }

      const lines = rows.map((row) => `- ${row.id} [${row.kind}] ${row.content}`);
      return {
        content: [{ type: "text", text: `User-specific memories for @${username}:\n${lines.join("\n")}` }],
        details: { userId, count: rows.length },
      };
    },
  };
}
