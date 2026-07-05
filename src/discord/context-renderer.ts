import { ChannelType, type Client, type Guild, type GuildBasedChannel } from "discord.js";
import type { ChannelInfo } from "../agent/channel-list-tool";
import { botChannelPermissions, channelTypeLabel } from "./message-sender";

const DISCORD_CONTEXT_MAX_GUILDS = 12;

function isMainDiscordContextChannel(channel: GuildBasedChannel): boolean {
  return channel.type === ChannelType.GuildText
    || channel.type === ChannelType.GuildAnnouncement
    || channel.type === ChannelType.GuildForum
    || channel.type === ChannelType.GuildMedia;
}

function systemDiscordContextChannel(client: Client, guild: Guild, currentChannelId: string): ChannelInfo | null {
  if (guild.systemChannelId === null) return null;
  const channel = guild.channels.cache.get(guild.systemChannelId);
  if (channel === undefined || !isMainDiscordContextChannel(channel)) return null;

  const permissions = botChannelPermissions(client, channel);
  if (!permissions.canView) return null;
  const categoryName = channel.parent?.name;
  return {
    guildId: guild.id,
    guildName: guild.name,
    id: channel.id,
    name: channel.name,
    type: channelTypeLabel(channel),
    canView: permissions.canView,
    canSend: permissions.canSend,
    isCurrent: channel.id === currentChannelId,
    ...(categoryName !== undefined ? { categoryName } : {}),
  };
}

export function buildDiscordContext(input: {
  client: Client;
  currentGuildId: string;
  currentGuildName: string;
  currentChannelId: string;
  currentChannelName?: string;
  navigationTemplate: string;
}): string {
  const guilds = [...input.client.guilds.cache.values()]
    .sort((a, b) => {
      if (a.id === input.currentGuildId) return -1;
      if (b.id === input.currentGuildId) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, DISCORD_CONTEXT_MAX_GUILDS);
  const currentChannel = input.currentChannelName !== undefined
    ? `#${input.currentChannelName} (${input.currentChannelId})`
    : input.currentChannelId;
  const lines = [
    `Current guild: ${input.currentGuildName} (${input.currentGuildId})`,
    `Current channel/thread: ${currentChannel}`,
    ...input.navigationTemplate.split(/\r?\n/),
  ];

  for (const guild of guilds) {
    const current = guild.id === input.currentGuildId ? " current" : "";
    lines.push(`- ${guild.name} | guild_id=${guild.id}${current}`);
    const channel = systemDiscordContextChannel(input.client, guild, input.currentChannelId);
    if (channel === null) {
      lines.push("  system_channel: (none cached/visible; use list_channels with guild_id if needed)");
      continue;
    }
    const marker = channel.isCurrent ? " *" : "";
    lines.push(`  system_channel: #${channel.name} | channel_id=${channel.id} | type=${channel.type} | send=${channel.canSend ? "yes" : "no"}${marker}`);
  }

  return lines.join("\n");
}
