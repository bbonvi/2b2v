import { describe, test, expect } from "bun:test";
import {
  createMultiMessageSender,
  type ChannelActions,
} from "./multi-message.ts";

describe("createMultiMessageSender", () => {
  function makeActions(): ChannelActions & {
    log: { action: string; text?: string }[];
  } {
    const log: { action: string; text?: string }[] = [];
    return {
      log,
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
    };
  }

  test("single message sends as reply with typing", async () => {
    const actions = makeActions();
    const sender = createMultiMessageSender(actions);

    const result = await sender([{ text: "Hello" }]);

    expect(actions.log).toEqual([
      { action: "typing" },
      { action: "reply", text: "Hello" },
    ]);
    expect(result.sentMessageIds).toEqual(["reply-id"]);
  });

  test("multiple messages: first=reply, rest=normal", async () => {
    const actions = makeActions();
    const sender = createMultiMessageSender(actions);

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
  });

  test("respects abort signal", async () => {
    const actions = makeActions();
    const controller = new AbortController();
    const sender = createMultiMessageSender(actions);

    // Abort after first message by overriding sendMessage
    const origSendMessage = actions.sendMessage;
    actions.sendMessage = (text: string) => {
      controller.abort();
      return origSendMessage(text);
    };

    const result = await sender(
      [{ text: "First" }, { text: "Second" }, { text: "Third" }],
      controller.signal
    );

    // First sent as reply, second triggers abort, third skipped
    expect(result.sentMessageIds.length).toBeLessThanOrEqual(2);
  });

  test("typing indicator shown before each message", async () => {
    const actions = makeActions();
    const sender = createMultiMessageSender(actions);

    await sender([{ text: "A" }, { text: "B" }]);

    const typingIndices = actions.log
      .map((e, i) => (e.action === "typing" ? i : -1))
      .filter((i) => i >= 0);
    const sendIndices = actions.log
      .map((e, i) => (e.action === "reply" || e.action === "message" ? i : -1))
      .filter((i) => i >= 0);

    for (let i = 0; i < sendIndices.length; i++) {
      const ti = typingIndices[i];
      const si = sendIndices[i];
      if (ti === undefined || si === undefined) throw new Error("unreachable");
      expect(ti).toBeLessThan(si);
    }
  });
});
