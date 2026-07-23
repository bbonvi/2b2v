import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type ThreadChannel,
} from "discord.js";
import { botChannelPermissions, channelTypeLabel } from "./message-sender";

const DISCORD_CONTEXT_MAX_GUILDS = 8;
const DISCORD_CONTEXT_POPULAR_CHANNELS = 5;
const RECENT_BOT_ACTIVITY_BUCKET_SIZE = 5;

export interface PopularDiscordChannelUsage {
  guildId: string;
  channelId: string;
  messageCount: number;
  recentBotMessageCount: number;
  activeHumanPosterCount: number;
}

interface AccessiblePopularChannel {
  usage: PopularDiscordChannelUsage;
  channel: GuildBasedChannel | ThreadChannel;
  guildName: string;
  canSend: boolean;
}

function accessiblePopularChannels(input: {
  client: Client;
  popularChannels: readonly PopularDiscordChannelUsage[];
}): AccessiblePopularChannel[] {
  const channels: AccessiblePopularChannel[] = [];
  for (const usage of input.popularChannels) {
    if (channels.length >= DISCORD_CONTEXT_POPULAR_CHANNELS) break;
    const cached = input.client.channels.cache.get(usage.channelId);
    if (cached === undefined || cached.isDMBased() || !("guildId" in cached) || cached.guildId !== usage.guildId) continue;
    const channel = cached as GuildBasedChannel | ThreadChannel;
    const permissions = botChannelPermissions(input.client, channel);
    if (!permissions.canView) continue;
    const guildName = input.client.guilds.cache.get(usage.guildId)?.name ?? usage.guildId;
    channels.push({ usage, channel, guildName, canSend: permissions.canSend });
  }
  return channels;
}

function recentBotActivityField(count: number): string {
  if (count <= 0) return "recent_2b_24h=0";
  return `recent_2b_24h<=${Math.ceil(count / RECENT_BOT_ACTIVITY_BUCKET_SIZE) * RECENT_BOT_ACTIVITY_BUCKET_SIZE}`;
}

function activeHumanPosterRange(count: number): string {
  if (count <= 2) return String(Math.max(0, count));
  if (count <= 5) return "3-5";
  if (count <= 10) return "6-10";
  if (count <= 25) return "11-25";
  if (count <= 50) return "26-50";
  if (count <= 100) return "51-100";
  return "100+";
}

function channelVisibility(channel: GuildBasedChannel | ThreadChannel): "guild-wide" | "restricted" | "private-thread" | "unknown" {
  if (channel.isThread() && channel.type === ChannelType.PrivateThread) return "private-thread";
  const permissionChannel = channel.isThread() ? channel.parent : channel;
  if (permissionChannel === null) return "unknown";
  const everyone = permissionChannel.guild.roles.everyone;
  return permissionChannel.permissionsFor(everyone).has(PermissionFlagsBits.ViewChannel, false)
    ? "guild-wide"
    : "restricted";
}

function selectGuilds(
  client: Client,
  currentGuildId: string,
  popularChannels: readonly AccessiblePopularChannel[],
): Guild[] {
  const selected = new Map<string, Guild>();
  const addGuild = (guildId: string): void => {
    const guild = client.guilds.cache.get(guildId);
    if (guild !== undefined && selected.size < DISCORD_CONTEXT_MAX_GUILDS) selected.set(guild.id, guild);
  };

  addGuild(currentGuildId);
  for (const popular of popularChannels) addGuild(popular.usage.guildId);
  for (const guild of [...client.guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    addGuild(guild.id);
  }
  return [...selected.values()];
}

export function buildDiscordContext(input: {
  client: Client;
  currentGuildId: string;
  currentGuildName: string;
  currentChannelId: string;
  currentChannelName?: string;
  navigationTemplate: string;
  popularChannels?: readonly PopularDiscordChannelUsage[];
}): string {
  const popular = accessiblePopularChannels({
    client: input.client,
    popularChannels: input.popularChannels ?? [],
  });
  const guilds = selectGuilds(input.client, input.currentGuildId, popular);
  const currentLocation = input.currentChannelName !== undefined
    ? `${input.currentGuildName} / #${input.currentChannelName} | guild_id=${input.currentGuildId} | channel_id=${input.currentChannelId}`
    : `${input.currentGuildName} | guild_id=${input.currentGuildId} | channel_id=${input.currentChannelId}`;
  const lines = [
    `Current: ${currentLocation}`,
    ...input.navigationTemplate.split(/\r?\n/),
    "Accessible guilds:",
  ];

  for (const guild of guilds) {
    lines.push(`- ${guild.name} | guild_id=${guild.id} | members=${guild.memberCount}`);
  }

  lines.push("Frequently used accessible channels (all-time order; totals hidden):");
  lines.push(...(popular.length > 0
    ? popular.map(({ usage, channel, guildName, canSend }) => {
        const current = usage.channelId === input.currentChannelId ? " [current]" : "";
        return `- ${guildName} / #${channel.name}${current} | channel_id=${usage.channelId} | type=${channelTypeLabel(channel)} | visibility=${channelVisibility(channel)} | active_humans_7d=${activeHumanPosterRange(usage.activeHumanPosterCount)} | ${recentBotActivityField(usage.recentBotMessageCount)} | send=${canSend ? "yes" : "no"}`;
      })
    : ["- none recorded"]));

  return lines.join("\n");
}
