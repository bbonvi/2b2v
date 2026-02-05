import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

export interface MemberInfo {
  userId: string;
  username: string;
  displayName: string;
  status: "online" | "idle" | "dnd" | "offline";
  isBot: boolean;
}

export interface MemberListToolDeps {
  guildId: string;
  fetchMembers: (guildId: string, onlineOnly: boolean) => Promise<MemberInfo[]>;
  getMemoryCounts: (guildId: string) => Map<string, number>;
}

const ListMembersParams = Type.Object({
  onlineOnly: Type.Optional(
    Type.Boolean({ description: "If true, only list online/idle/dnd members. Default: false (all members)." })
  ),
});

export function createMemberListTool(deps: MemberListToolDeps): AgentTool {
  const { guildId, fetchMembers, getMemoryCounts } = deps;

  return {
    name: "list_members",
    label: "list_members",
    description:
      "List server members. Optionally filter to only online members. Returns usernames, display names, and online status.",
    parameters: ListMembersParams,

    async execute(_toolCallId: string, params: unknown): Promise<AgentToolResult<{ count: number } | { error: boolean }>> {
      const { onlineOnly: rawOnlineOnly } = params as { onlineOnly?: boolean };
      const onlineOnly = rawOnlineOnly ?? false;

      let members: MemberInfo[];
      try {
        members = await fetchMembers(guildId, onlineOnly);
      } catch {
        return {
          content: [{ type: "text", text: "Unable to fetch members. The bot may lack permission to view the member list." }],
          details: { error: true },
        };
      }

      if (members.length === 0) {
        return {
          content: [{ type: "text", text: onlineOnly ? "No members currently online." : "No members found." }],
          details: { count: 0 },
        };
      }

      const memoryCounts = getMemoryCounts(guildId);
      const lines = members.map((m) => formatMember(m, memoryCounts.get(m.userId) ?? 0));
      const header = onlineOnly ? `Online members (${members.length}):` : `All members (${members.length}):`;
      return {
        content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
        details: { count: members.length },
      };
    },
  };
}

function formatMember(m: MemberInfo, memoryCount: number): string {
  const bot = m.isBot ? " [BOT]" : "";
  const status = m.status !== "offline" ? ` (${m.status})` : "";
  const memories = memoryCount > 0 ? ` — ${memoryCount} memories` : "";
  return `@${m.username} — ${m.displayName}${bot}${status}${memories}`;
}
