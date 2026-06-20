import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  createTimeoutUserTool,
  MAX_TIMEOUT_SECONDS,
  type TimeoutMember,
  type TimeoutUserToolDeps,
} from "./timeout-user-tool";

interface TimeoutCall {
  durationMs: number;
  reason?: string;
}

type MockMember = TimeoutMember & {
  calls: TimeoutCall[];
  rejectTimeout?: boolean;
};

function makeMember(overrides: Partial<MockMember> = {}): MockMember {
  const calls: TimeoutCall[] = [];
  const member: MockMember = {
    id: "user-1",
    username: "alice",
    displayName: "Alice",
    isBot: false,
    moderatable: true,
    calls,
    timeout: (durationMs, reason) => {
      if (member.rejectTimeout === true) return Promise.reject(new Error("Missing Permissions"));
      calls.push(reason === undefined ? { durationMs } : { durationMs, reason });
      return Promise.resolve();
    },
    ...overrides,
  };
  return member;
}

function makeTool(member: TimeoutMember | null, overrides: Partial<TimeoutUserToolDeps> = {}): AgentTool {
  return createTimeoutUserTool({
    guildId: "guild-1",
    botUserId: "bot-1",
    guildOwnerId: "owner-1",
    resolveMember: () => Promise.resolve(member),
    ...overrides,
  });
}

function text(result: Awaited<ReturnType<AgentTool["execute"]>>): string {
  const first = result.content[0] as { text?: string } | undefined;
  return first?.text ?? "";
}

describe("createTimeoutUserTool", () => {
  test("exposes constrained moderation instructions", () => {
    const tool = makeTool(makeMember());
    expect(tool.name).toBe("timeout_user");
    expect(tool.description).toContain("almost never");
    expect(tool.description).toContain("list_chat_users");
    expect(tool.description).toContain("10 minutes");
  });

  test("rejects non-guild use", async () => {
    const tool = makeTool(makeMember(), { guildId: undefined });
    const result = await tool.execute("call-1", { target: "alice", duration: 1, unit: "minutes" });
    expect(text(result)).toContain("only works in a Discord guild");
  });

  test("rejects non-positive durations", async () => {
    const member = makeMember();
    const tool = makeTool(member);
    const result = await tool.execute("call-1", { target: "alice", duration: 0, unit: "seconds" });
    expect(text(result)).toContain("positive");
    expect(member.calls).toHaveLength(0);
  });

  test("rejects durations above ten minutes", async () => {
    const member = makeMember();
    const tool = makeTool(member);
    const result = await tool.execute("call-1", { target: "alice", duration: 11, unit: "minutes" });
    expect(text(result)).toContain("10 minutes");
    expect(member.calls).toHaveLength(0);
  });

  test("allows exactly ten minutes and passes Discord timeout milliseconds", async () => {
    const member = makeMember();
    const tool = makeTool(member);
    const result = await tool.execute("call-1", {
      target: "@alice",
      duration: 10,
      unit: "minutes",
      reason: "admin asked",
    });
    expect(text(result)).toContain("Timed out @alice");
    expect(member.calls).toEqual([{ durationMs: MAX_TIMEOUT_SECONDS * 1_000, reason: "admin asked" }]);
  });

  test("rejects missing target resolution", async () => {
    const tool = makeTool(null);
    const result = await tool.execute("call-1", { target: "nobody", duration: 1, unit: "minutes" });
    expect(text(result)).toContain("No guild member found");
  });

  test("refuses to time out the bot itself or guild owner", async () => {
    const botResult = await makeTool(makeMember({ id: "bot-1" })).execute(
      "call-1",
      { target: "bot", duration: 1, unit: "minutes" },
    );
    const ownerResult = await makeTool(makeMember({ id: "owner-1" })).execute(
      "call-2",
      { target: "owner", duration: 1, unit: "minutes" },
    );

    expect(text(botResult)).toContain("bot itself");
    expect(text(ownerResult)).toContain("guild owner");
  });

  test("reports bot permission or hierarchy failures gracefully", async () => {
    const unmoderatable = await makeTool(makeMember({ moderatable: false })).execute(
      "call-1",
      { target: "alice", duration: 1, unit: "minutes" },
    );
    const rejected = await makeTool(makeMember({ rejectTimeout: true })).execute(
      "call-2",
      { target: "alice", duration: 1, unit: "minutes" },
    );

    expect(text(unmoderatable)).toContain("lack Timeout Members permission");
    expect(text(rejected)).toContain("Failed to time out");
  });
});
