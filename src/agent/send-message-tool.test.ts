import { describe, test, expect } from "bun:test";
import { createSendMessageTool, type MessageSender } from "./send-message-tool.ts";

describe("createSendMessageTool", () => {
  test("returns a tool with correct name and description", () => {
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "" });
    const tool = createSendMessageTool(sender);
    expect(tool.name).toBe("send_message");
    expect(tool.label).toBe("Send Message");
    expect(tool.description).toContain("reply");
  });

  test("execute calls sender with text and reply=false by default", async () => {
    const calls: { text: string; reply: boolean }[] = [];
    const sender: MessageSender = (text, reply) => {
      calls.push({ text, reply });
      return Promise.resolve({ sentMessageId: "msg-1" });
    };
    const tool = createSendMessageTool(sender);

    const result = await tool.execute("call-1", { text: "Hello", reply: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ text: "Hello", reply: false });
    expect(result.details.sentMessageId).toBe("msg-1");
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Message sent.",
    });
  });

  test("execute passes reply=true to sender", async () => {
    const calls: { text: string; reply: boolean }[] = [];
    const sender: MessageSender = (text, reply) => {
      calls.push({ text, reply });
      return Promise.resolve({ sentMessageId: "reply-1" });
    };
    const tool = createSendMessageTool(sender);

    const result = await tool.execute("call-1", { text: "Hi there", reply: true });

    expect(calls[0]).toEqual({ text: "Hi there", reply: true });
    expect(result.details.sentMessageId).toBe("reply-1");
  });

  test("execute propagates signal to sender", async () => {
    let receivedSignal: AbortSignal | undefined;
    const sender: MessageSender = (_text, _reply, signal) => {
      receivedSignal = signal;
      return Promise.resolve({ sentMessageId: "" });
    };
    const tool = createSendMessageTool(sender);
    const controller = new AbortController();

    await tool.execute("call-1", { text: "hi", reply: false }, controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });

  test("propagates sender errors", async () => {
    const sender: MessageSender = () =>
      Promise.reject(new Error("Discord API unavailable"));
    const tool = createSendMessageTool(sender);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test rejects is async
    await expect(
      tool.execute("call-1", { text: "hi", reply: false })
    ).rejects.toThrow("Discord API unavailable");
  });
});
