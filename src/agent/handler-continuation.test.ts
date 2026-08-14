import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { handleMessage } from "./handler.ts";
import { makeDeps, makeMessage } from "./handler-test-support.ts";
import type { ChatCompleteFn, MessageSender } from "./turn-types.ts";

describe("handler continuation", () => {
  test("continues after a private continue directive requests another model turn", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: '<message>one moment</message><continue/>',
          toolCalls: [],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      expect(request.messages.some((message) =>
        message.role === "assistant"
        && message.content === '<message>one moment</message><continue/>'
      )).toBe(true);
      return Promise.resolve({
        text: "finished",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };
    const sent: string[] = [];
    const sender: MessageSender = (text) => {
      sent.push(text);
      return Promise.resolve({ sentMessageId: `sent-${sent.length}` });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender }),
    );

    expect(calls).toBe(2);
    expect(sent).toEqual(["one moment", "finished"]);
    expect(result.responseText).toBe("finished");
  });

  test("continues after thoughts without sending them to Discord", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      return Promise.resolve(calls === 1
        ? {
            text: "<thoughts>prepare the next action</thoughts><continue/>",
            toolCalls: [],
            rawResponse: {},
            messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
          }
        : {
            text: "finished",
            toolCalls: [],
            rawResponse: {},
            messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
          });
    };
    const sent: string[] = [];
    const sender: MessageSender = (text) => {
      sent.push(text);
      return Promise.resolve({ sentMessageId: `sent-${sent.length}` });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender }),
    );

    expect(calls).toBe(2);
    expect(sent).toEqual(["finished"]);
  });

  test("stops after two consecutive private continuations", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      return Promise.resolve({
        text: `<message>step ${calls}</message><continue/>`,
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };
    const sent: string[] = [];
    const sender: MessageSender = (text) => {
      sent.push(text);
      return Promise.resolve({ sentMessageId: `sent-${sent.length}` });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender }),
    );

    expect(calls).toBe(3);
    expect(sent).toEqual(["step 1", "step 2", "step 3"]);
  });

  test("does not send a redundant continue directive beside a native call", async () => {
    let executions = 0;
    const tool: AgentTool = {
      name: "private_action",
      label: "Private action",
      description: "Run a private action.",
      parameters: Type.Object({}),
      execute: () => {
        executions += 1;
        return Promise.resolve({ content: [{ type: "text", text: "Done." }], details: {} });
      },
    };
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      return Promise.resolve(calls === 1
        ? {
            text: "<continue/>",
            toolCalls: [{
              id: "private-action",
              type: "function",
              function: { name: "private_action", arguments: "{}" },
            }],
            rawResponse: {},
            messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
          }
        : {
            text: "finished",
            toolCalls: [],
            rawResponse: {},
            messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
          });
    };
    const sent: string[] = [];
    const sender: MessageSender = (text) => {
      sent.push(text);
      return Promise.resolve({ sentMessageId: `sent-${sent.length}` });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        sender,
        extraTools: [tool],
        initialToolNames: ["private_action"],
      }),
    );

    expect(calls).toBe(2);
    expect(executions).toBe(1);
    expect(sent).toEqual(["finished"]);
  });
});
