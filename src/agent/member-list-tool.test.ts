import { test, expect, describe } from "bun:test";
import { createChatUserListTool, type MemberListToolDeps, type MemberInfo } from "./member-list-tool";
import type { TextContent } from "@mariozechner/pi-ai";

function makeDeps(members: MemberInfo[], memoryCounts?: Map<string, number>, adminUserIds: string[] = []): MemberListToolDeps {
  return {
    guildId: "g1",
    fetchMembers: (_guildId, onlineOnly) => {
      if (onlineOnly) return Promise.resolve(members.filter((m) => m.status !== "offline"));
      return Promise.resolve(members);
    },
    getMemoryCounts: () => memoryCounts ?? new Map(),
    adminUserIds,
  };
}

const MEMBERS: MemberInfo[] = [
  { userId: "u1", username: "alice", displayName: "Alice A", status: "online", isBot: false, hasAdministratorPermission: true },
  { userId: "u2", username: "bob", displayName: "bob", status: "offline", isBot: false, hasAdministratorPermission: false, dmChannelId: "dm-2" },
  { userId: "u3", username: "botty", displayName: "Botty", status: "online", isBot: true, hasAdministratorPermission: false },
];

describe("createChatUserListTool", () => {
  test("returns list_chat_users AgentTool with correct metadata", () => {
    const tool = createChatUserListTool(makeDeps(MEMBERS));
    expect(tool.label).toBe("list_chat_users");
    expect(tool.description).toContain("exact usernames");
    expect(tool.description).toContain("2B still cannot send PMs/DMs");
    expect(tool.parameters).toBeDefined();
  });

  test("lists all members when onlineOnly is false", async () => {
    const tool = createChatUserListTool(makeDeps(MEMBERS));
    const result = await tool.execute("tc1", { onlineOnly: false }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain('username="alice"');
    expect(text).toContain('username="bob"');
    expect(text).toContain('username="botty"');
    expect((result.details as { count: number }).count).toBe(3);
  });

  test("lists only online members when onlineOnly is true", async () => {
    const tool = createChatUserListTool(makeDeps(MEMBERS));
    const result = await tool.execute("tc1", { onlineOnly: true }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain('username="alice"');
    expect(text).not.toContain('username="bob"');
    expect(text).toContain('username="botty"');
    expect((result.details as { count: number }).count).toBe(2);
  });

  test("defaults onlineOnly to false", async () => {
    const tool = createChatUserListTool(makeDeps(MEMBERS));
    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    expect((result.details as { count: number }).count).toBe(3);
  });

  test("includes compact legend, display names only when different, bot flag, and cached dm_channel_id", async () => {
    const tool = createChatUserListTool(makeDeps(MEMBERS));
    const result = await tool.execute("tc1", { onlineOnly: true }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text.split("\n")[0]).toContain("Legend:");
    expect(text).toContain('display_name="Alice A"');
    expect(text).toContain("flags=bot");

    const bobResult = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    const bobText = (bobResult.content[0] as TextContent).text;
    const bobLine = bobText.split("\n").find((l) => l.includes('username="bob"'));
    expect(bobLine).toBeDefined();
    expect(bobLine).not.toContain("display_name=");
    expect(bobLine).toContain("dm_channel_id=dm-2");
  });

  test("handles empty member list", async () => {
    const tool = createChatUserListTool(makeDeps([]));
    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Legend:");
    expect(text).toContain("(no rows)");
    expect((result.details as { count: number }).count).toBe(0);
  });

  test("degrades gracefully when fetchMembers throws", async () => {
    const deps: MemberListToolDeps = {
      guildId: "g1",
      fetchMembers: () => { throw new Error("Missing Access"); },
      getMemoryCounts: () => new Map(),
      adminUserIds: [],
    };
    const tool = createChatUserListTool(deps);
    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Unable to fetch");
  });

  test("includes memory counts in output when available", async () => {
    const memoryCounts = new Map([
      ["u1", 5],
      ["u3", 2],
    ]);
    const tool = createChatUserListTool(makeDeps(MEMBERS, memoryCounts));
    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("mem=5");
    expect(text).toContain("mem=2");
    const bobLine = text.split("\n").find((l) => l.includes('username="bob"'));
    expect(bobLine).toBeDefined();
    expect(bobLine).not.toContain("mem=");
  });

  test("omits memory count suffix for users with zero memories", async () => {
    const memoryCounts = new Map([["u1", 3]]);
    const tool = createChatUserListTool(makeDeps(MEMBERS, memoryCounts));
    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("mem=3");
    const bobLine = text.split("\n").find((l) => l.includes('username="bob"'));
    expect(bobLine).toBeDefined();
    expect(bobLine).not.toContain("mem=");
  });

  test("flags admins from Administrator permission or guild adminUserIds", async () => {
    const tool = createChatUserListTool(makeDeps(MEMBERS, undefined, ["u2"]));
    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    const aliceLine = text.split("\n").find((l) => l.includes('username="alice"'));
    const bobLine = text.split("\n").find((l) => l.includes('username="bob"'));
    expect(aliceLine).toContain("flags=admin");
    expect(bobLine).toContain("flags=admin");
  });
});
