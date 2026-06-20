import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

export interface ChannelInfo {
  id: string;
  name: string;
  type: string;
  canView: boolean;
  canSend: boolean;
  isCurrent: boolean;
  isDm?: boolean;
  categoryName?: string;
  parentName?: string;
}

export interface ChannelListToolDeps {
  guildId: string;
  fetchChannels: (guildId: string) => Promise<ChannelInfo[]>;
}

const ListChannelsParams = Type.Object({});

/** Create a tool that lists visible guild channels and threads for routing. */
export function createChannelListTool(deps: ChannelListToolDeps): AgentTool {
  const { guildId, fetchChannels } = deps;

  return {
    name: "list_channels",
    label: "list_channels",
    description:
      "List visible Discord guild channels and threads before cross-channel handoff/sending or mentioning a channel. Returns chat_id/channel IDs and sendability. DMs are unsupported and never listed.",
    parameters: ListChannelsParams,

    async execute(_toolCallId: string): Promise<AgentToolResult<{ count: number } | { error: boolean }>> {
      let channels: ChannelInfo[];
      try {
        channels = await fetchChannels(guildId);
      } catch {
        return {
          content: [{ type: "text", text: "Unable to list channels. The bot may lack permission to view this guild." }],
          details: { error: true },
        };
      }

      const visible = channels
        .filter((channel) => channel.canView && channel.isDm !== true)
        .sort(compareChannels);

      if (visible.length === 0) {
        return {
          content: [{ type: "text", text: "No visible guild channels or threads found. DMs are unsupported." }],
          details: { count: 0 },
        };
      }

      return {
        content: [{ type: "text", text: formatChannelList(visible) }],
        details: { count: visible.length },
      };
    },
  };
}

export function formatChannelList(channels: readonly ChannelInfo[]): string {
  const lines = [
    "Legend: * = current chat/thread; id = chat_id for <message chat_id=\"...\">; mention = Discord channel mention; send=yes means bot can send there; DMs unsupported.",
    ...channels.map(formatChannel),
  ];
  return lines.join("\n");
}

function formatChannel(channel: ChannelInfo): string {
  const current = channel.isCurrent ? "*" : " ";
  const context = formatChannelContext(channel);
  return `${current} #${channel.name} | id=${channel.id} | mention=<#${channel.id}> | ${context} | send=${channel.canSend ? "yes" : "no"}`;
}

function formatChannelContext(channel: ChannelInfo): string {
  const parts = [channel.type];
  if (channel.parentName !== undefined && channel.parentName !== "") {
    parts.push(`parent: #${channel.parentName}`);
  }
  if (channel.categoryName !== undefined && channel.categoryName !== "") {
    parts.push(`category: ${channel.categoryName}`);
  }
  return parts.join(" / ");
}

function compareChannels(a: ChannelInfo, b: ChannelInfo): number {
  if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
  const category = (a.categoryName ?? "").localeCompare(b.categoryName ?? "");
  if (category !== 0) return category;
  const parent = (a.parentName ?? "").localeCompare(b.parentName ?? "");
  if (parent !== 0) return parent;
  const type = a.type.localeCompare(b.type);
  if (type !== 0) return type;
  return a.name.localeCompare(b.name);
}
