import { describe, test, expect } from "bun:test";
import {
  computeDelay,
  createMultiMessageSender,
  type ChannelActions,
  type MessageDelayConfig,
} from "./multi-message.ts";

describe("computeDelay", () => {
  test("uses base + text.length * perChar formula", () => {
    const config: MessageDelayConfig = { base: 500, perChar: 30 };
    expect(computeDelay("hello", config)).toBe(500 + 5 * 30); // 650
  });

  test("returns base for empty string", () => {
    const config: MessageDelayConfig = { base: 500, perChar: 30 };
    expect(computeDelay("", config)).toBe(500);
  });

  test("scales with message length", () => {
    const config: MessageDelayConfig = { base: 100, perChar: 10 };
    const short = computeDelay("hi", config);
    const long = computeDelay("this is a longer message", config);
    expect(long).toBeGreaterThan(short);
  });
});

describe("createMultiMessageSender", () => {
  function makeActions(): ChannelActions & {
    log: { action: string; text?: string }[];
    delays: number[];
  } {
    const log: { action: string; text?: string }[] = [];
    const delays: number[] = [];
    return {
      log,
      delays,
      sendReply: (text: string) => {
        log.push({ action: "reply", text });
        return Promise.resolve("reply-id");
      },
      sendMessage: (text: string) => {
        log.push({ action: "message", text });
        return Promise.resolve(`msg-${log.length}`);
      },
      startTyping: () => {
        log.push({ action: "typing" });
      },
      delay: (ms: number) => {
        delays.push(ms);
        // no actual delay in tests
        return Promise.resolve();
      },
    };
  }

  test("single message sends as reply with typing", async () => {
    const actions = makeActions();
    const config: MessageDelayConfig = { base: 500, perChar: 30 };
    const sender = createMultiMessageSender(actions, config);

    const result = await sender([{ text: "Hello" }]);

    expect(actions.log).toEqual([
      { action: "typing" },
      { action: "reply", text: "Hello" },
    ]);
    expect(result.sentMessageIds).toEqual(["reply-id"]);
    expect(actions.delays).toEqual([]); // no delay for first message
  });

  test("multiple messages: first=reply, rest=normal with delays", async () => {
    const actions = makeActions();
    const config: MessageDelayConfig = { base: 100, perChar: 10 };
    const sender = createMultiMessageSender(actions, config);

    const result = await sender([
      { text: "First" },
      { text: "Second" },
      { text: "Third" },
    ]);

    expect(actions.log).toEqual([
      { action: "typing" },
      { action: "reply", text: "First" },
      { action: "typing" },
      { action: "message", text: "Second" },
      { action: "typing" },
      { action: "message", text: "Third" },
    ]);
    expect(result.sentMessageIds).toEqual(["reply-id", "msg-4", "msg-6"]);
    // Delays before 2nd and 3rd messages
    expect(actions.delays).toEqual([
      100 + 6 * 10, // "Second".length = 6
      100 + 5 * 10, // "Third".length = 5
    ]);
  });

  test("respects abort signal", async () => {
    const actions = makeActions();
    const config: MessageDelayConfig = { base: 500, perChar: 30 };
    const controller = new AbortController();
    const sender = createMultiMessageSender(actions, config);

    // Abort before second message
    actions.delay = () => {
      controller.abort();
      return Promise.resolve();
    };

    const result = await sender(
      [{ text: "First" }, { text: "Second" }],
      controller.signal
    );

    // Should have sent first, then aborted before second
    expect(result.sentMessageIds).toEqual(["reply-id"]);
  });

  test("typing indicator shown before each message", async () => {
    const actions = makeActions();
    const config: MessageDelayConfig = { base: 0, perChar: 0 };
    const sender = createMultiMessageSender(actions, config);

    await sender([{ text: "A" }, { text: "B" }]);

    // Every send should be preceded by typing
    const typingIndices = actions.log
      .map((e, i) => (e.action === "typing" ? i : -1))
      .filter((i) => i >= 0);
    const sendIndices = actions.log
      .map((e, i) => (e.action === "reply" || e.action === "message" ? i : -1))
      .filter((i) => i >= 0);

    // Each typing must come before its corresponding send
    for (let i = 0; i < sendIndices.length; i++) {
      const ti = typingIndices[i];
      const si = sendIndices[i];
      if (ti === undefined || si === undefined) throw new Error("unreachable");
      expect(ti).toBeLessThan(si);
    }
  });
});
