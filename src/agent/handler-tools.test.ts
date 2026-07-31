import { describe, expect, mock, test } from "bun:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { handleMessage } from "./handler.ts";
import type { ChatCompleteFn, MessageSender } from "./turn-types.ts";
import { makeCodexGlobal, makeDeps, makeGuildConfig, makeMessage } from "./handler-test-support.ts";

describe("handleMessage", () => {
  test("accepts an empty final model turn after a tool produced public output", async () => {
    let publicOutputSent = false;
    const tool: AgentTool = {
      name: "public_action",
      label: "Public Action",
      description: "Post public output",
      parameters: Type.Object({}),
      execute: () => {
        publicOutputSent = true;
        return Promise.resolve({ content: [{ type: "text", text: "Public output posted." }], details: {} });
      },
    };
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      return Promise.resolve(calls === 1
        ? {
            text: "",
            toolCalls: [{
              id: "call-public",
              type: "function",
              function: { name: "public_action", arguments: "{}" },
            }],
            rawResponse: {},
            messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
          }
        : {
            text: "",
            toolCalls: [],
            rawResponse: {},
            messageForLogs: { role: "assistant", usage: { input: 1, output: 0, totalTokens: 1 }, content: [] },
          });
    };
    const afterReplyCalls: unknown[] = [];
    const onStillWorking = mock(() => {});

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        extraTools: [tool],
        hasExternalVisibleOutput: () => publicOutputSent,
        onStillWorking,
        afterReply: (request) => {
          afterReplyCalls.push(request);
          return Promise.resolve();
        },
      }),
    );

    expect(result.responseText).toBeUndefined();
    expect(calls).toBe(2);
    expect(onStillWorking).toHaveBeenCalledTimes(1);
    expect(afterReplyCalls[0]).toMatchObject({ visibleReplySent: true });
  });

  test("stops retrying empty final model responses after five attempts", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      return Promise.resolve({
        text: "",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 0, totalTokens: 1 }, content: [] },
      });
    };
    const sender: MessageSender = mock(() => Promise.resolve({ sentMessageId: "sent-1" }));

    let thrown: unknown;
    try {
      await handleMessage(
        makeMessage({ mentionedUserIds: ["bot-1"] }),
        makeDeps({ completeChat, sender }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Model produced an empty response.");
    expect(calls).toBe(5);
    expect(sender).toHaveBeenCalledTimes(0);
  });

  test("executes native tool calls then sends final text", async () => {
    const toolCalls: unknown[] = [];
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: (_id, params) => {
        toolCalls.push(params);
        return Promise.resolve({ content: [{ type: "text", text: "tool says 42" }], details: {} });
      },
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        expect(request.tools?.some((toolDef) => toolDef.function.name === "load_skill")).toBe(true);
        expect(request.tools?.some((toolDef) => toolDef.function.name === "lookup")).toBe(true);
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: "{\"query\":\"x\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      expect(
        request.messages.some((m) =>
          m.role === "tool" && typeof m.content === "string" && m.content.includes("tool says 42")),
      ).toBe(true);
      return Promise.resolve({
        text: "answer is 42",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer is 42" }] },
      });
    };

    const sender: MessageSender = mock(() => Promise.resolve({ sentMessageId: "sent-1" }));
    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        sender,
        guildConfig: makeGuildConfig({
          replyLoop: { maxToolCalls: 1, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
        }),
      }),
    );

    expect(result.responseText).toBe("answer is 42");
    expect(toolCalls).toEqual([{ query: "x" }]);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  test("retains Codex provider-native reasoning content into the next tool turn request", async () => {
    const providerNativeContent = [
      {
        type: "thinking" as const,
        thinking: "",
        thinkingSignature: "{\"type\":\"reasoning\",\"id\":\"rs_1\",\"encrypted_content\":\"sealed\",\"summary\":[]}",
      },
      {
        type: "toolCall" as const,
        id: "call_abc|fc_123",
        name: "lookup",
        arguments: { query: "x" },
      },
    ];
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "tool says 42" }], details: {} }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call_abc|fc_123",
            type: "function",
            function: { name: "lookup", arguments: "{\"query\":\"x\"}" },
          }],
          providerNativeContent,
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      const assistantMessage = request.messages.find((message) => message.role === "assistant");
      expect(assistantMessage?.providerNativeContent).toEqual(providerNativeContent);
      expect(assistantMessage?.tool_calls?.[0]?.id).toBe("call_abc|fc_123");
      expect(request.messages.some((message) =>
        message.role === "tool"
          && message.tool_call_id === "call_abc|fc_123"
          && typeof message.content === "string"
          && message.content.includes("tool says 42")
      )).toBe(true);
      return Promise.resolve({
        text: "answer is 42",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer is 42" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        globalConfig: makeCodexGlobal(),
      }),
    );

    expect(result.responseText).toBe("answer is 42");
    expect(calls).toBe(2);
  });

  test("does not carry Codex provider-native content across separate Discord turns", async () => {
    const requestHadNativeContent: boolean[] = [];
    const completeChat: ChatCompleteFn = (request) => {
      requestHadNativeContent.push(
        request.messages.some((message) => message.providerNativeContent !== undefined),
      );
      return Promise.resolve({
        text: "hello user",
        toolCalls: [],
        providerNativeContent: [{
          type: "thinking",
          thinking: "",
          thinkingSignature: "{\"type\":\"reasoning\",\"id\":\"rs_1\",\"encrypted_content\":\"sealed\"}",
        }, {
          type: "text",
          text: "hello user",
          textSignature: "msg_1",
        }],
        rawResponse: {},
        messageForLogs: {
          role: "assistant",
          usage: { input: 1, output: 1, totalTokens: 2 },
          content: [{ type: "text", text: "hello user" }],
        },
      });
    };
    const deps = makeDeps({
      completeChat,
      globalConfig: makeCodexGlobal(),
    });

    await handleMessage(
      makeMessage({ messageId: "msg-1", translatedContent: "first", mentionedUserIds: ["bot-1"] }),
      deps,
    );
    await handleMessage(
      makeMessage({ messageId: "msg-2", translatedContent: "second", mentionedUserIds: ["bot-1"] }),
      deps,
    );

    expect(requestHadNativeContent).toEqual([false, false]);
  });

  test("sends visible text attached to a load_skill tool turn", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls === 1) {
        const text = [
          "<scene perspective=\"outside_character_editor\">",
          "room read: playful image request",
          "</scene>",
          "<message reply=\"true\">Ладно. Обычное селфи.</message>",
          "<message reply=\"false\">Без твоей подологии.</message>",
        ].join("\n");
        return Promise.resolve({
          text,
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "load_skill", arguments: "{\"skill\":\"image_generation\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text }] },
        });
      }
      return Promise.resolve({
        text: "<ignore>already sent</ignore>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "<ignore>already sent</ignore>" }] },
      });
    };

    const sender = mock<MessageSender>(() => Promise.resolve({ sentMessageId: "sent-1" }));

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender }),
    );

    expect(calls).toBe(2);
    expect(sender).toHaveBeenCalledTimes(2);
    expect(sender.mock.calls[0]?.[0]).toBe("Ладно. Обычное селфи.");
    expect(sender.mock.calls[0]?.[1]).toBe(true);
    expect(sender.mock.calls[1]?.[0]).toBe("Без твоей подологии.");
    expect(sender.mock.calls[1]?.[1]).toBe(false);
  });

  test("attaches generated image tool output to the final reply", async () => {
    const tool: AgentTool = {
      name: "codex_generate_image",
      label: "Codex Image",
      description: "Generate image",
      parameters: Type.Object({ prompt: Type.String() }),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Generated image queued." }],
        details: { generatedAttachmentIds: ["img-1"] },
      }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "load_skill", arguments: "{\"skill\":\"image_generation\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      if (calls === 2) {
        expect(request.tools?.map((entry) => entry.function.name)).toContain("codex_generate_image");
        expect(request.messages.some((message) =>
          message.role === "tool"
          && message.name === "load_skill"
          && message.addedToolNames?.includes("codex_generate_image") === true
        )).toBe(true);
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-2",
            type: "function",
            function: { name: "codex_generate_image", arguments: "{\"prompt\":\"a blue house\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "here",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "here" }] },
      });
    };

    const sentAttachments: unknown[] = [];
    const sender: MessageSender = (_text, _reply, _channelId, _voice, _signal, _replyToMessageId, attachments) => {
      sentAttachments.push(attachments);
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        initialToolNames: [],
        completeChat,
        sender,
        consumeGeneratedAttachments: (ids) => ids.map((id) => ({
          id,
          buffer: Buffer.from("fake"),
          filename: `${id}.png`,
          contentType: "image/png",
        })),
      }),
    );

    expect(sentAttachments).toEqual([[
      {
        id: "img-1",
        buffer: Buffer.from("fake"),
        filename: "img-1.png",
        contentType: "image/png",
      },
    ]]);
  });

  test("does not execute a tool enabled earlier in the same model turn", async () => {
    let executeCalls = 0;
    const tool: AgentTool = {
      name: "codex_generate_image",
      label: "Codex Image",
      description: "Generate image",
      parameters: Type.Object({ prompt: Type.String() }),
      execute: () => {
        executeCalls += 1;
        return Promise.resolve({
          content: [{ type: "text", text: "Generated image queued." }],
          details: {},
        });
      },
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        expect(request.tools?.some((entry) => entry.function.name === "codex_generate_image")).toBe(false);
        return Promise.resolve({
          text: "",
          toolCalls: [
            {
              id: "call-load",
              type: "function",
              function: { name: "load_skill", arguments: "{\"skill\":\"image_generation\"}" },
            },
            {
              id: "call-too-early",
              type: "function",
              function: { name: "codex_generate_image", arguments: "{\"prompt\":\"a blue house\"}" },
            },
          ],
          providerNativeContent: [
            {
              type: "toolCall",
              id: "call-load",
              name: "load_skill",
              arguments: { skill: "image_generation" },
            },
            {
              type: "toolCall",
              id: "call-too-early",
              name: "codex_generate_image",
              arguments: { prompt: "a blue house" },
            },
          ],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      if (calls === 2) {
        expect(executeCalls).toBe(0);
        expect(request.tools?.some((entry) => entry.function.name === "codex_generate_image")).toBe(true);
        expect(request.messages.some((message) =>
          message.role === "user"
          && typeof message.content === "string"
          && message.content.includes("next model turn")
        )).toBe(true);
        expect(request.messages.some((message) =>
          message.role === "assistant"
          && message.tool_calls?.some((call) => call.id === "call-too-early") === true
        )).toBe(false);
        expect(request.messages.some((message) =>
          message.role === "assistant"
          && message.providerNativeContent?.some((part) =>
            part.type === "toolCall" && part.id === "call-too-early"
          ) === true
        )).toBe(false);
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-image",
            type: "function",
            function: { name: "codex_generate_image", arguments: "{\"prompt\":\"a blue house\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "done",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        initialToolNames: [],
        completeChat,
      }),
    );

    expect(result.responseText).toBe("done");
    expect(executeCalls).toBe(1);
    expect(calls).toBe(3);
  });

  test("does not execute a discovered tool in the discovery model turn", async () => {
    let executeCalls = 0;
    const tool: AgentTool = {
      name: "fetch_url",
      label: "Fetch URL",
      description: "Fetch a webpage",
      parameters: Type.Object({ url: Type.String() }),
      execute: () => {
        executeCalls += 1;
        return Promise.resolve({ content: [{ type: "text", text: "page" }], details: {} });
      },
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [
            {
              id: "call-search-tools",
              type: "function",
              function: { name: "search_tools", arguments: "{\"query\":\"fetch webpage\"}" },
            },
            {
              id: "call-too-early",
              type: "function",
              function: { name: "fetch_url", arguments: "{\"url\":\"https://example.com\"}" },
            },
          ],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      if (calls === 2) {
        expect(executeCalls).toBe(0);
        expect(request.tools?.some((entry) => entry.function.name === "fetch_url")).toBe(true);
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-fetch",
            type: "function",
            function: { name: "fetch_url", arguments: "{\"url\":\"https://example.com\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "done",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        initialToolNames: [],
        completeChat,
      }),
    );

    expect(result.responseText).toBe("done");
    expect(executeCalls).toBe(1);
    expect(calls).toBe(3);
  });

  test("rejects an inactive skill-gated tool", async () => {
    let executeCalls = 0;
    const tool: AgentTool = {
      name: "codex_generate_image",
      label: "Codex Image",
      description: "Generate image",
      parameters: Type.Object({ prompt: Type.String() }),
      execute: () => {
        executeCalls += 1;
        return Promise.resolve({
          content: [{ type: "text", text: "Generated image queued." }],
          details: { generatedAttachmentIds: ["img-1"] },
        });
      },
    };

    let calls = 0;
    let sawInactiveError = false;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "codex_generate_image", arguments: "{\"prompt\":\"a blue house\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      sawInactiveError = request.messages.some((message) =>
        message.role === "user"
        && typeof message.content === "string"
        && message.content.includes("not active in this model turn")
      );
      expect(request.messages.some((message) =>
        message.role === "assistant"
        && message.tool_calls?.some((call) => call.id === "call-1") === true
      )).toBe(false);
      return Promise.resolve({
        text: "ok",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "ok" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [tool], initialToolNames: [], completeChat }),
    );

    expect(result.responseText).toBe("ok");
    expect(sawInactiveError).toBe(true);
    expect(executeCalls).toBe(0);
  });

  test("does not require final text after async image job is queued", async () => {
    const tool: AgentTool = {
      name: "codex_generate_image",
      label: "Codex Image",
      description: "Generate image",
      parameters: Type.Object({ prompt: Type.String() }),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Started async image generation job img-1." }],
        details: {
          asyncJobId: "img-1",
          asyncJobStatus: "queued",
          asyncJobCreated: true,
        },
      }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "load_skill", arguments: "{\"skill\":\"image_generation\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "",
        toolCalls: [{
          id: "call-2",
          type: "function",
          function: { name: "codex_generate_image", arguments: "{\"prompt\":\"a blue house\"}" },
        }],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    const sender = mock(() => Promise.resolve({ sentMessageId: "sent-1" }));
    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [tool], completeChat, sender }),
    );

    expect(result.triggered).toBe(true);
    expect(result.agentRan).toBe(true);
    expect(result.responseText).toBeUndefined();
    expect(calls).toBe(2);
    expect(sender).toHaveBeenCalledTimes(0);
  });

  test("does not resend a streamed explicit final message after generated image tool output", async () => {
    const tool: AgentTool = {
      name: "codex_generate_image",
      label: "Codex Image",
      description: "Generate image",
      parameters: Type.Object({ prompt: Type.String() }),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Generated image queued." }],
        details: { generatedAttachmentIds: ["img-1"] },
      }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = async (request) => {
      calls += 1;
      if (calls === 1) {
        await request.onTextDelta?.("\n");
        return {
          text: "\n",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "load_skill", arguments: "{\"skill\":\"image_generation\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        };
      }
      if (calls === 2) {
        return {
          text: "",
          toolCalls: [{
            id: "call-2",
            type: "function",
            function: { name: "codex_generate_image", arguments: "{\"prompt\":\"a blue house\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        };
      }

      await request.onTextDelta?.("<message>Вот.</message>");
      return {
        text: "<message>Вот.</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "<message>Вот.</message>" }] },
      };
    };

    const senderCalls: Array<{ text: string; attachmentIds: string[] }> = [];
    const sender: MessageSender = (text, _reply, _channelId, _voice, _signal, _replyToMessageId, attachments) => {
      senderCalls.push({ text, attachmentIds: attachments?.map((attachment) => attachment.id) ?? [] });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        sender,
        consumeGeneratedAttachments: (ids) => ids.map((id) => ({
          id,
          buffer: Buffer.from("fake"),
          filename: `${id}.png`,
          contentType: "image/png",
        })),
      }),
    );

    expect(senderCalls).toEqual([{ text: "Вот.", attachmentIds: ["img-1"] }]);
  });

  test("runs safe read-only tool calls in parallel and preserves tool message order", async () => {
    let active = 0;
    let maxActive = 0;
    const starts: string[] = [];
    const finishes: string[] = [];
    const fetchUrl: AgentTool = {
      name: "fetch_url",
      label: "Fetch URL",
      description: "Fetch a URL",
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id, params) => {
        const { url } = params as { url: string };
        starts.push(url);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, url.endsWith("/one") ? 30 : 10));
        active -= 1;
        finishes.push(url);
        return {
          content: [{ type: "text", text: `body for ${url}` }],
          details: {},
        };
      },
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [
            { id: "call-one", type: "function", function: { name: "fetch_url", arguments: "{\"url\":\"https://example.com/one\"}" } },
            { id: "call-two", type: "function", function: { name: "fetch_url", arguments: "{\"url\":\"https://example.com/two\"}" } },
          ],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      const toolMessages = request.messages.filter((m) => m.role === "tool");
      expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["call-one", "call-two"]);
      expect(toolMessages[0]?.content).toContain("body for https://example.com/one");
      expect(toolMessages[1]?.content).toContain("body for https://example.com/two");
      return Promise.resolve({
        text: "parallel answer",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "parallel answer" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [fetchUrl], completeChat, runtimePrompts: undefined }),
    );

    expect(result.responseText).toBe("parallel answer");
    expect(maxActive).toBe(2);
    expect(starts).toEqual(["https://example.com/one", "https://example.com/two"]);
    expect(finishes).toEqual(["https://example.com/two", "https://example.com/one"]);
  });

});
