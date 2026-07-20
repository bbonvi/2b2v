import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { markReadOnlyTool } from "./tool-effects.ts";

export interface MemberInfo {
  userId: string;
  username: string;
  displayName: string;
  status: "online" | "idle" | "dnd" | "offline";
  isBot: boolean;
  hasAdministratorPermission: boolean;
  dmChannelId?: string;
}

export interface MemberListToolDeps {
  guildId: string;
  fetchMembers: (guildId: string, onlineOnly: boolean) => Promise<MemberInfo[]>;
  getMemoryCounts: (guildId: string) => Map<string, number>;
  adminUserIds: string[];
}

const ListMembersParams = Type.Object({
  onlineOnly: Type.Optional(
    Type.Boolean({ description: "Filter to online/idle/dnd members." })
  ),
});

/** Create a compact current-guild user listing tool for channel identity and admin awareness. */
export function createChatUserListTool(deps: MemberListToolDeps): AgentTool {
  const { guildId, fetchMembers, getMemoryCounts, adminUserIds } = deps;

  return markReadOnlyTool({
    name: "list_chat_users",
    label: "list_chat_users",
    description: "List relevant current-guild chat users.",
    parameters: ListMembersParams,

    async execute(_toolCallId: string, params: unknown): Promise<AgentToolResult<{ count: number } | { error: boolean }>> {
      const { onlineOnly: rawOnlineOnly } = params as { onlineOnly?: boolean };
      const onlineOnly = rawOnlineOnly ?? false;

      let members: MemberInfo[];
      try {
        members = await fetchMembers(guildId, onlineOnly);
      } catch {
        return {
          content: [{ type: "text", text: "Unable to fetch members; the bot may lack permission to view the member list." }],
          details: { error: true },
        };
      }

      const scope = onlineOnly ? "online" : "all";
      const header = `Legend: username display_name(if different) status flags(bot,admin) mem(nonzero) dm_channel_id(existing cached only); scope=${scope}; count=${members.length}`;

      if (members.length === 0) {
        return {
          content: [{ type: "text", text: `${header}\n(no rows)` }],
          details: { count: 0 },
        };
      }

      const memoryCounts = getMemoryCounts(guildId);
      const lines = members.map((m) => formatMember(
        m,
        memoryCounts.get(m.userId) ?? 0,
        adminUserIds.includes(m.userId),
      ));
      return {
        content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
        details: { count: members.length },
      };
    },
  });
}

function formatMember(m: MemberInfo, memoryCount: number, isConfiguredAdmin: boolean): string {
  const parts = [`username=${quoteValue(m.username)}`];
  if (m.displayName !== m.username) parts.push(`display_name=${quoteValue(m.displayName)}`);
  parts.push(`status=${m.status}`);

  const flags = [];
  if (m.isBot) flags.push("bot");
  if (m.hasAdministratorPermission || isConfiguredAdmin) flags.push("admin");
  if (flags.length > 0) parts.push(`flags=${flags.join(",")}`);
  if (memoryCount > 0) parts.push(`mem=${memoryCount}`);
  if (m.dmChannelId !== undefined) parts.push(`dm_channel_id=${m.dmChannelId}`);
  return parts.join(" ");
}

function quoteValue(value: string): string {
  return JSON.stringify(value);
}
