import { describe, expect, test } from "bun:test";
import type { VoiceRuntime } from "./runtime.ts";
import { createVoiceTools } from "./tools.ts";

const origin = {
  guildId: "guild",
  channelId: "text",
  sourceMessageId: "message",
  sourceMessageText: "Move to the other room.",
  requesterId: "user",
  requesterUsername: "alice",
};

describe("createVoiceTools", () => {
  test("defers voice-surface movement and departure until the live turn finishes", async () => {
    const calls: string[] = [];
    const runtime = {
      requestMove: (channelId: string) => {
        calls.push(`requestMove:${channelId}`);
        return Promise.resolve({ scheduled: true, channelId });
      },
      requestLeave: () => {
        calls.push("requestLeave");
        return { scheduled: true as const };
      },
    } as unknown as VoiceRuntime;
    const tools = createVoiceTools({ runtime, origin, surface: "voice" });
    const join = tools.find((tool) => tool.name === "join_voice_channel");
    const leave = tools.find((tool) => tool.name === "leave_voice_channel");
    if (join === undefined || leave === undefined) throw new Error("Expected voice presence tools");

    await join.execute("join", { channel_id: "voice-2" }, AbortSignal.timeout(5_000));
    await leave.execute("leave", {}, AbortSignal.timeout(5_000));

    expect(calls).toEqual(["requestMove:voice-2", "requestLeave"]);
  });

  test("uses immediate move semantics from text and retains the instruction tool", async () => {
    const calls: string[] = [];
    const runtime = {
      move: (channelId: string) => {
        calls.push(`move:${channelId}`);
        return Promise.resolve({ sessionId: "session", channelId, moved: true });
      },
      leave: () => {
        calls.push("leave");
        return Promise.resolve();
      },
      instruct: () => {
        calls.push("instruct");
        return { id: "instruction", status: "queued" };
      },
    } as unknown as VoiceRuntime;
    const tools = createVoiceTools({ runtime, origin, surface: "text" });
    const join = tools.find((tool) => tool.name === "join_voice_channel");
    const leave = tools.find((tool) => tool.name === "leave_voice_channel");
    const instruct = tools.find((tool) => tool.name === "instruct_voice_channel");
    if (join === undefined || leave === undefined || instruct === undefined) {
      throw new Error("Expected text-surface voice tools");
    }

    await join.execute("join", { channel_id: "voice-2" }, AbortSignal.timeout(5_000));
    await leave.execute("leave", {}, AbortSignal.timeout(5_000));
    await instruct.execute("instruct", { instruction: "Ask Bob." }, AbortSignal.timeout(5_000));

    expect(calls).toEqual(["move:voice-2", "leave", "instruct"]);
  });
});
