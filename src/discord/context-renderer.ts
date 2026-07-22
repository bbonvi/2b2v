import type { Client, GuildBasedChannel, ThreadChannel } from "discord.js";
import { botChannelPermissions, channelTypeLabel } from "./message-sender";

const DISCORD_CONTEXT_MAX_GUILDS = 12;
const DISCORD_CONTEXT_POPULAR_CHANNELS = 5;

export interface PopularDiscordChannelUsage {
  guildId: string;
  channelId: string;
  messageCount: number;
}

function popularChannelLines(input: {
  client: Client;
  currentChannelId: string;
  popularChannels: readonly PopularDiscordChannelUsage[];
}): string[] {
  const lines: string[] = [];
  for (const usage of input.popularChannels) {
    if (lines.length >= DISCORD_CONTEXT_POPULAR_CHANNELS) break;
    const cached = input.client.channels.cache.get(usage.channelId);
    if (cached === undefined || cached.isDMBased() || !("guildId" in cached) || cached.guildId !== usage.guildId) continue;
    const channel = cached as GuildBasedChannel | ThreadChannel;
    const permissions = botChannelPermissions(input.client, channel);
    if (!permissions.canView) continue;
    const guildName = input.client.guilds.cache.get(usage.guildId)?.name ?? usage.guildId;
    const current = usage.channelId === input.currentChannelId ? " current" : "";
    lines.push(`- ${guildName} / #${channel.name} | guild_id=${usage.guildId} | channel_id=${usage.channelId} | type=${channelTypeLabel(channel)} | send=${permissions.canSend ? "yes" : "no"} | 2B_messages=${usage.messageCount}${current}`);
  }
  return lines;
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
    "Guilds in 2B's Discord life:",
  ];

  for (const guild of guilds) {
    const current = guild.id === input.currentGuildId ? " current" : "";
    lines.push(`- ${guild.name} | guild_id=${guild.id}${current}`);
  }

  const popular = popularChannelLines({
    client: input.client,
    currentChannelId: input.currentChannelId,
    popularChannels: input.popularChannels ?? [],
  });
  lines.push("2B's five most-used accessible channels, ranked by her real visible message count:");
  lines.push(...(popular.length > 0 ? popular : ["- none recorded"]));

  return lines.join("\n");
}
