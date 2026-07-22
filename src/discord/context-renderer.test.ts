import { describe, expect, test } from "bun:test";
import { ChannelType, type Client } from "discord.js";
import { buildDiscordContext } from "./context-renderer.ts";

function fakeClient(): Client {
  const guilds = [
    { id: "g1", name: "Alpha" },
    { id: "g2", name: "Beta" },
  ];
  const channels = Array.from({ length: 6 }, (_, index) => {
    const number = index + 1;
    return {
      id: `c${number}`,
      guildId: number <= 3 ? "g1" : "g2",
      name: `room-${number}`,
      type: ChannelType.GuildText,
      viewable: true,
      isDMBased: () => false,
      isThread: () => false,
    };
  });
  return {
    user: null,
    guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) },
    channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) },
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
      })),
    });

    expect(rendered).toContain("Guilds in 2B's Discord life:");
    expect(rendered).toContain("Alpha / #room-1");
    expect(rendered).toContain("Beta / #room-5");
    expect(rendered).not.toContain("#room-6");
    expect(rendered.indexOf("#room-1")).toBeLessThan(rendered.indexOf("#room-5"));
    expect(rendered).not.toContain("system_channel");
  });
});
