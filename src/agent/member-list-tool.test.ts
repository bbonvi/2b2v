import { test, expect, describe } from "bun:test";
import { createMemberListTool, type MemberListToolDeps, type MemberInfo } from "./member-list-tool";
import type { TextContent } from "@mariozechner/pi-ai";

function makeDeps(members: MemberInfo[]): MemberListToolDeps {
  return {
    guildId: "g1",
    fetchMembers: (_guildId, onlineOnly) => {
      if (onlineOnly) return Promise.resolve(members.filter((m) => m.status !== "offline"));
      return Promise.resolve(members);
    },
  };
}

const MEMBERS: MemberInfo[] = [
  { userId: "u1", username: "alice", displayName: "Alice A", status: "online", isBot: false },
  { userId: "u2", username: "bob", displayName: "Bob B", status: "offline", isBot: false },
  { userId: "u3", username: "botty", displayName: "Botty", status: "online", isBot: true },
];

describe("createMemberListTool", () => {
  test("returns list_members AgentTool with correct metadata", () => {
    const tool = createMemberListTool(makeDeps(MEMBERS));
    expect(tool.label).toBe("list_members");
    expect(tool.description).toBeDefined();
    expect(tool.parameters).toBeDefined();
  });

  test("lists all members when onlineOnly is false", async () => {
    const tool = createMemberListTool(makeDeps(MEMBERS));
    const result = await tool.execute("tc1", { onlineOnly: false }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("alice");
    expect(text).toContain("bob");
    expect(text).toContain("botty");
    expect((result.details as { count: number }).count).toBe(3);
  });

  test("lists only online members when onlineOnly is true", async () => {
    const tool = createMemberListTool(makeDeps(MEMBERS));
    const result = await tool.execute("tc1", { onlineOnly: true }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("alice");
    expect(text).not.toContain("bob");
    expect(text).toContain("botty");
    expect((result.details as { count: number }).count).toBe(2);
  });

  test("defaults onlineOnly to false", async () => {
    const tool = createMemberListTool(makeDeps(MEMBERS));
    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    expect((result.details as { count: number }).count).toBe(3);
  });

  test("includes display name and bot marker in output", async () => {
    const tool = createMemberListTool(makeDeps(MEMBERS));
    const result = await tool.execute("tc1", { onlineOnly: true }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Alice A");
    expect(text).toContain("[BOT]");
  });

  test("handles empty member list", async () => {
    const tool = createMemberListTool(makeDeps([]));
    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("No members");
    expect((result.details as { count: number }).count).toBe(0);
  });

  test("degrades gracefully when fetchMembers throws", async () => {
    const deps: MemberListToolDeps = {
      guildId: "g1",
      fetchMembers: () => { throw new Error("Missing Access"); },
    };
    const tool = createMemberListTool(deps);
    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Unable to fetch");
  });
});
