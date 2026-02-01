import { describe, test, expect } from "bun:test";
import { createSendMessagesTool, type MessageSender } from "./send-messages-tool.ts";

describe("createSendMessagesTool", () => {
  test("returns a tool with correct name and description", () => {
    const sender: MessageSender = async () => ({ sentMessageIds: [] });
    const tool = createSendMessagesTool(sender);
    expect(tool.name).toBe("send_messages");
    expect(tool.label).toBe("Send Messages");
    expect(tool.description).toContain("reply");
  });

  test("execute calls sender with messages and returns result", async () => {
    const calls: { text: string }[][] = [];
    const sender: MessageSender = async (msgs) => {
      calls.push(msgs);
      return { sentMessageIds: ["msg-1", "msg-2"] };
    };
    const tool = createSendMessagesTool(sender);

    const result = await tool.execute("call-1", {
      messages: [{ text: "Hello" }, { text: "How are you?" }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([{ text: "Hello" }, { text: "How are you?" }]);
    expect(result.details.messageCount).toBe(2);
    expect(result.details.sentMessageIds).toEqual(["msg-1", "msg-2"]);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Sent 2 message(s).",
    });
  });

  test("execute propagates signal to sender", async () => {
    let receivedSignal: AbortSignal | undefined;
    const sender: MessageSender = async (_msgs, signal) => {
      receivedSignal = signal;
      return { sentMessageIds: [] };
    };
    const tool = createSendMessagesTool(sender);
    const controller = new AbortController();

    await tool.execute("call-1", { messages: [{ text: "hi" }] }, controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });
});
