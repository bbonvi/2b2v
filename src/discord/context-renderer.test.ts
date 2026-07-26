import { describe, expect, test } from "bun:test";
import { ChannelType, type Client } from "discord.js";
import { buildDiscordContext } from "./context-renderer.ts";

function fakeClient(options: { activeVoiceRoom?: boolean } = {}): Client {
  const everyone = { id: "everyone" };
  const guilds = [
    { id: "g1", name: "Alpha", memberCount: 183, roles: { everyone } },
    { id: "g2", name: "Beta", memberCount: 42, roles: { everyone } },
  ];
  const channels = Array.from({ length: 6 }, (_, index) => {
    const number = index + 1;
    const guild = guilds[number <= 3 ? 0 : 1];
    return {
      id: `c${number}`,
      guildId: guild?.id,
      guild,
      name: `room-${number}`,
      type: ChannelType.GuildText,
      viewable: true,
      isDMBased: () => false,
      isThread: () => false,
      permissionsFor: () => ({ has: () => true }),
    };
  });
  const voiceChannels = options.activeVoiceRoom === true
    ? [{
      id: "voice-1",
      guildId: guilds[0]?.id,
      guild: guilds[0],
      name: "voice-room",
      type: ChannelType.GuildVoice,
      viewable: true,
      isDMBased: () => false,
      isThread: () => false,
      permissionsFor: () => ({ has: () => true }),
      members: new Map([["alice", { user: { bot: false } }]]),
    }]
    : [];
  return {
    user: null,
    guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) },
    channels: { cache: new Map([...channels, ...voiceChannels].map((channel) => [channel.id, channel])) },
  } as unknown as Client;
}

describe("buildDiscordContext", () => {
  test("shows at most five accessible channels in bot-message popularity order", () => {
    const rendered = buildDiscordContext({
      client: fakeClient(),
      currentGuildId: "g1",
      currentGuildName: "Alpha",
      currentChannelId: "c1",
      currentChannelName: "room-1",
      navigationTemplate: "Navigation policy.",
      popularChannels: [1, 2, 3, 4, 5, 6].map((number) => ({
        guildId: number <= 3 ? "g1" : "g2",
        channelId: `c${number}`,
        messageCount: 70 - number * 10,
        recentBotMessageCount: number,
        activeHumanPosterCount: number,
      })),
    });

    expect(rendered).toContain("Accessible guilds:");
    expect(rendered).toContain("Alpha | guild_id=g1 | members=183");
    expect(rendered).toContain("Alpha / #room-1");
    expect(rendered).toContain("Beta / #room-5");
    expect(rendered).not.toContain("#room-6");
    expect(rendered.indexOf("#room-1")).toBeLessThan(rendered.indexOf("#room-5"));
    expect(rendered).toContain("visibility=guild-wide");
    expect(rendered).toContain("active_humans_7d=1");
    expect(rendered).toContain("recent_2b_24h<=5");
    expect(rendered).not.toContain("2B_messages");
    expect(rendered).not.toContain("system_channel");
  });

  test("briefly signals active voice rooms in the current guild", () => {
    const input = {
      currentGuildId: "g1",
      currentGuildName: "Alpha",
      currentChannelId: "c1",
      currentChannelName: "room-1",
      navigationTemplate: "Navigation policy.",
    };
    const rendered = buildDiscordContext({
      client: fakeClient({ activeVoiceRoom: true }),
      ...input,
    });
    const inactive = buildDiscordContext({ client: fakeClient(), ...input });

    expect(rendered.split("\n")).toHaveLength(inactive.split("\n").length + 1);
    expect(rendered).not.toContain("voice-room");
    expect(rendered).not.toContain("alice");
  });
});
