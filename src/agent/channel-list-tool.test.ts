import { describe, expect, test } from "bun:test";
import type { TextContent } from "@mariozechner/pi-ai";
import { createChannelListTool, type ChannelInfo, type ChannelListToolDeps } from "./channel-list-tool";

function makeDeps(channels: ChannelInfo[]): ChannelListToolDeps {
  return {
    currentGuildId: "g1",
    fetchChannels: (guildId) => Promise.resolve(channels.map((channel) => ({ ...channel, guildId, guildName: "Guild One" }))),
    resolveGuildName: () => "Guild One",
  };
}

describe("createChannelListTool", () => {
  test("returns list_channels AgentTool with expected metadata", () => {
    const tool = createChannelListTool(makeDeps([]));
    expect(tool.label).toBe("list_channels");
    expect(tool.description).toContain("cross-channel");
    expect(tool.description).toContain("cross-guild");
    expect(tool.description).toContain("DMs");
    expect(tool.parameters).toBeDefined();
  });

  test("formats visible guild channels with ids, mentions, sendability and current marker", async () => {
    const tool = createChannelListTool(makeDeps([
      { guildId: "g1", guildName: "Guild One", id: "c2", name: "handoff", type: "text", canView: true, canSend: true, isCurrent: false, categoryName: "Ops" },
      { guildId: "g1", guildName: "Guild One", id: "c1", name: "general", type: "text", canView: true, canSend: false, isCurrent: true },
      { guildId: "g1", guildName: "Guild One", id: "t1", name: "incident", type: "thread", canView: true, canSend: true, isCurrent: false, parentName: "handoff", categoryName: "Ops" },
    ]));

    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;

    expect(text).toContain("Legend:");
    expect(text).toContain("* #general | id=c1 | mention=<#c1> | text | send=no");
    expect(text).toContain("  #handoff | id=c2 | mention=<#c2> | text / category: Ops | send=yes");
    expect(text).toContain("  #incident | id=t1 | mention=<#t1> | thread / parent: #handoff / category: Ops | send=yes");
    expect((result.details as { guildId: string; count: number }).guildId).toBe("g1");
    expect((result.details as { count: number }).count).toBe(3);
  });

  test("filters inaccessible channels and DMs", async () => {
    const tool = createChannelListTool(makeDeps([
      { guildId: "g1", guildName: "Guild One", id: "visible", name: "visible", type: "text", canView: true, canSend: true, isCurrent: false },
      { guildId: "g1", guildName: "Guild One", id: "hidden", name: "hidden", type: "text", canView: false, canSend: false, isCurrent: false },
      { guildId: "g1", guildName: "Guild One", id: "dm1", name: "dm", type: "dm", canView: true, canSend: true, isCurrent: false, isDm: true },
    ]));

    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;

    expect(text).toContain("#visible");
    expect(text).not.toContain("#hidden");
    expect(text).not.toContain("#dm");
    expect((result.details as { count: number }).count).toBe(1);
  });

  test("handles empty visible channel list", async () => {
    const tool = createChannelListTool(makeDeps([
      { guildId: "g1", guildName: "Guild One", id: "hidden", name: "hidden", type: "text", canView: false, canSend: false, isCurrent: false },
    ]));

    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;

    expect(text).toContain("No visible guild channels");
    expect((result.details as { count: number }).count).toBe(0);
  });
});
