import { describe, expect, mock, spyOn, test } from "bun:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { handleMessage } from "./handler.ts";
import type { ChatCompleteFn, MemoryExtractionRequest, MessageSender, VoiceAttachment } from "./turn-types.ts";
import type { TtsResult } from "../tts/types.ts";
import { RequestLog } from "../logger.ts";
import { ModelProviderError } from "../llm/codex-chat.ts";
import { makeCodexGlobal, makeDeps, makeMessage, makeModelTimeoutError } from "./handler-test-support.ts";

describe("handleMessage", () => {
  test("does not emit typing while flushing leftover streamed messages after completion", async () => {
    const completeChat: ChatCompleteFn = async (request) => {
      await request.onTextDelta?.("<message>first</message>");
      return {
        text: "<message>first</message><message>second</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const senderCalls: string[] = [];
    const sender: MessageSender = (text) => {
      senderCalls.push(text);
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const onStillWorking = mock(() => {});

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, onStillWorking }),
    );

    expect(senderCalls).toEqual(["first", "second"]);
    expect(onStillWorking).toHaveBeenCalledTimes(0);
  });

  test("does not slice final plain text with a streamed message envelope offset", async () => {
    const finalText = "Не вышло и во второй раз. Похоже, генератор сегодня решил умереть стоя, очень драматично.";
    const completeChat: ChatCompleteFn = async (request) => {
      await request.onTextDelta?.("<message keep_typing=\"true\">be right back</message>");
      return {
        text: finalText,
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const senderCalls: Array<{ text: string; reply: boolean }> = [];
    const sender: MessageSender = (text, reply) => {
      senderCalls.push({ text, reply });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender }),
    );

    expect(senderCalls).toEqual([
      { text: "be right back", reply: false },
      { text: finalText, reply: false },
    ]);
    expect(result.responseText).toBe(finalText);
  });

  test("sends voice directive segments as TTS audio", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "Text first <voice>[whispers] quiet line</voice> text after",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; reply: boolean; voice: boolean; historyText?: string }> = [];
    const sender: MessageSender = (text, reply, _channelId, voice) => {
      senderCalls.push({ text, reply, voice: voice !== undefined, historyText: voice?.historyText });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const speechTexts: string[] = [];
    const generateSpeech = (text: string): Promise<TtsResult> => {
      speechTexts.push(text);
      return Promise.resolve({ ok: true, buffer: Buffer.from("audio"), contentType: "audio/mpeg" });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, ttsEnabled: true, generateSpeech }),
    );

    expect(senderCalls).toEqual([
      {
        text: "Text first\ntext after",
        reply: false,
        voice: true,
        historyText: "Text first\n<voice>[whispers] quiet line</voice>\ntext after",
      },
    ]);
    expect(speechTexts).toEqual(["[whispers] quiet line"]);
    expect(result.responseText).toBe('Text first\n<voice>[whispers] quiet line</voice>\ntext after');
  });

  test("keeps streamed handoffs out of text, voice, attachments, and visible memory", async () => {
    const response = [
      '<message channel_id="thread-1" asset_ids=[12]>',
      "<handoff>text-private\nline two</handoff>",
      "Visible text.",
      "</message>",
      '<message channel_id="thread-2">',
      "<handoff>voice-private</handoff>",
      "Caption <voice>Spoken line.</voice>",
      "</message>",
    ].join("\n");
    const completeChat: ChatCompleteFn = async (request) => {
      await request.onTextDelta?.(response);
      return {
        text: response,
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const sends: Array<{
      text: string;
      channelId?: string;
      voiceHistory?: string;
      attachments?: string[];
    }> = [];
    const sender: MessageSender = (text, _reply, channelId, voice, _signal, _replyTo, attachments) => {
      sends.push({
        text,
        channelId,
        voiceHistory: voice?.historyText,
        attachments: attachments?.map((attachment) => attachment.filename),
      });
      return Promise.resolve({
        sentMessageId: `sent-${sends.length}`,
        sentGuildId: "destination-guild",
        sentChannelId: channelId ?? "channel-1",
      });
    };
    const spoken: string[] = [];
    const handoffs: unknown[] = [];

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        sender,
        ttsEnabled: true,
        generateSpeech: (text) => {
          spoken.push(text);
          return Promise.resolve({ ok: true, buffer: Buffer.from("audio"), contentType: "audio/mpeg" });
        },
        resolveAssetAttachments: () => Promise.resolve([{
          id: "asset-12",
          buffer: Buffer.from("image"),
          filename: "asset.png",
          contentType: "image/png",
        }]),
        onHandoffDelivered: (handoff) => { handoffs.push(handoff); },
      }),
    );

    expect(sends).toEqual([
      {
        text: "Visible text.",
        channelId: "thread-1",
        voiceHistory: undefined,
        attachments: ["asset.png"],
      },
      {
        text: "Caption",
        channelId: "thread-2",
        voiceHistory: "Caption\n<voice>Spoken line.</voice>",
        attachments: undefined,
      },
    ]);
    expect(spoken).toEqual(["Spoken line."]);
    expect(handoffs).toEqual([
      {
        handoff: "text-private\nline two",
        routedMessageId: "sent-1",
        destinationGuildId: "destination-guild",
        destinationChannelId: "thread-1",
      },
      {
        handoff: "voice-private",
        routedMessageId: "sent-2",
        destinationGuildId: "destination-guild",
        destinationChannelId: "thread-2",
      },
    ]);
    expect(result.responseText).toBe(
      "Visible text.\n[msg-break]\nCaption\n<voice>Spoken line.</voice>",
    );
    expect(JSON.stringify({ sends, spoken, responseText: result.responseText }))
      .not.toContain("private");
  });

  test("sends audio directive inside message directive as one separate voice message", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message>text first</message><message><audio>spoken second</audio></message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; reply: boolean; voice: boolean; historyText?: string }> = [];
    const sender: MessageSender = (text, reply, _channelId, voice) => {
      senderCalls.push({ text, reply, voice: voice !== undefined, historyText: voice?.historyText });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const speechTexts: string[] = [];
    const generateSpeech = (text: string): Promise<TtsResult> => {
      speechTexts.push(text);
      return Promise.resolve({ ok: true, buffer: Buffer.from("audio"), contentType: "audio/mpeg" });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, ttsEnabled: true, generateSpeech }),
    );

    expect(senderCalls).toEqual([
      { text: "text first", reply: false, voice: false, historyText: undefined },
      { text: "", reply: false, voice: true, historyText: "<voice>spoken second</voice>" },
    ]);
    expect(speechTexts).toEqual(["spoken second"]);
    expect(result.responseText).toBe("text first\n[msg-break]\n<voice>spoken second</voice>");
  });

  test("keeps Discord pings as text content instead of generated speech", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<voice>@user hey</voice>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; voice: boolean; historyText?: string }> = [];
    const sender: MessageSender = (text, _reply, _channelId, voice) => {
      senderCalls.push({ text, voice: voice !== undefined, historyText: voice?.historyText });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const speechTexts: string[] = [];
    const generateSpeech = (text: string): Promise<TtsResult> => {
      speechTexts.push(text);
      return Promise.resolve({ ok: true, buffer: Buffer.from("audio"), contentType: "audio/mpeg" });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, ttsEnabled: true, generateSpeech }),
    );

    expect(senderCalls).toEqual([{
      text: "@user",
      voice: true,
      historyText: "@user\n<voice>hey</voice>",
    }]);
    expect(speechTexts).toEqual(["hey"]);
    expect(result.responseText).toBe("@user\n<voice>hey</voice>");
  });

  test("stores sanitized voice XML in sender history and memory extraction", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<voice>[SLOW] Седьмая. [sings] Ладно. [heavy sigh, then amused resignation] Ещё.</voice>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; historyText?: string }> = [];
    const sender: MessageSender = (text, _reply, _channelId, voice) => {
      senderCalls.push({ text, historyText: voice?.historyText });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const afterReplyCalls: unknown[] = [];
    const afterReply = (request: unknown): Promise<void> => {
      afterReplyCalls.push(request);
      return Promise.resolve();
    };
    const generateSpeech = (): Promise<TtsResult> =>
      Promise.resolve({ ok: true, buffer: Buffer.from("audio"), contentType: "audio/mpeg" });

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, ttsEnabled: true, generateSpeech, afterReply }),
    );

    expect(senderCalls).toEqual([{
      text: "",
      historyText: "<voice>[SLOW] Седьмая. [sings] Ладно. [heavy sigh, then amused resignation] Ещё.</voice>",
    }]);
    expect(afterReplyCalls[0]).toMatchObject({
      assistantReply: "<voice>[SLOW] Седьмая. [sings] Ладно. [heavy sigh, then amused resignation] Ещё.</voice>",
    });
    expect(result.responseText).toBe("<voice>[SLOW] Седьмая. [sings] Ладно. [heavy sigh, then amused resignation] Ещё.</voice>");
  });

  test("falls back to text when a voice directive cannot generate audio", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<voice>audio please</voice>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; voice?: VoiceAttachment }> = [];
    const sender: MessageSender = (text, _reply, _channelId, voice) => {
      senderCalls.push({ text, voice });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender }),
    );

    expect(senderCalls).toEqual([{ text: "audio please", voice: undefined }]);
  });

  test("ignore directive produces no Discord send but still schedules silent memory pass", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<ignore>not worth answering</ignore>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const sender: MessageSender = mock(() => Promise.resolve({ sentMessageId: "sent-1" }));
    const afterReplyCalls: unknown[] = [];
    const afterReply = mock((request: unknown) => {
      afterReplyCalls.push(request);
      return Promise.resolve();
    });
    const ignoredReplyCalls: unknown[] = [];
    const onIgnoredReply = mock((request: unknown) => {
      ignoredReplyCalls.push(request);
    });

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, afterReply, onIgnoredReply }),
    );

    expect(result.agentRan).toBe(true);
    expect(result.responseText).toBeUndefined();
    expect(sender).toHaveBeenCalledTimes(0);
    expect(onIgnoredReply).toHaveBeenCalledTimes(1);
    expect(ignoredReplyCalls[0]).toMatchObject({
      sourceMessageId: "msg-1",
      historyText: "<ignore>not worth answering</ignore>",
      rawResponse: "<ignore>not worth answering</ignore>",
    });
    expect(afterReply).toHaveBeenCalledTimes(1);
    expect(afterReplyCalls[0]).toMatchObject({
      assistantReply: "<ignore>not worth answering</ignore>",
      visibleReplySent: false,
    });
  });

  test("counts public output produced by a tool when the final model turn stays silent", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<ignore>the tool already posted the result</ignore>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const afterReplyCalls: unknown[] = [];

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        hasExternalVisibleOutput: () => true,
        afterReply: (request) => {
          afterReplyCalls.push(request);
          return Promise.resolve();
        },
      }),
    );

    expect(afterReplyCalls[0]).toMatchObject({ visibleReplySent: true });
  });

  test("blocks malformed private scene output without scheduling maintenance", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<scene perspective=\"script_writer\">\nroom read: private\nopinion: private\n</",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 1, output: 1, totalTokens: 2 },
        content: [],
      },
    });
    const sender = mock(() => Promise.resolve({ sentMessageId: "sent-1" }));
    const afterReply = mock(() => Promise.resolve());

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, afterReply }),
    );

    expect(result.agentRan).toBe(true);
    expect(result.responseText).toBeUndefined();
    expect(sender).toHaveBeenCalledTimes(0);
    expect(afterReply).toHaveBeenCalledTimes(0);
  });

  test("keeps complete thoughts private and makes them available to maintenance", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<thought>I want to inspect the broken seal later.</thought><message>The seal is worn.</message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 1, output: 1, totalTokens: 2 },
        content: [{ type: "text", text: "<thought>I want to inspect the broken seal later.</thought><message>The seal is worn.</message>" }],
      },
    });
    const sentTexts: string[] = [];
    const sender: MessageSender = mock((text: string) => {
      sentTexts.push(text);
      return Promise.resolve({ sentMessageId: "sent-1" });
    });
    const afterReplyCalls: MemoryExtractionRequest[] = [];

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        sender,
        afterReply: (request) => {
          afterReplyCalls.push(request);
          return Promise.resolve();
        },
      }),
    );

    expect(sender).toHaveBeenCalledTimes(1);
    expect(sentTexts).toEqual(["The seal is worn."]);
    expect(result.responseText).toBe("The seal is worn.");
    expect(result.privateThoughts).toEqual(["I want to inspect the broken seal later."]);
    expect(afterReplyCalls[0]?.assistantReply).toBe("The seal is worn.");
    expect(JSON.stringify(afterReplyCalls[0]?.maintenanceTranscript)).toContain("inspect the broken seal later");
  });

  test("keeps authored thoughts from tool turns in transcript order", async () => {
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "found" }], details: {} }),
    };
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "<thoughts>Keep the setup quiet until the result arrives.</thoughts>",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          }],
          providerNativeContent: [{ type: "thinking", thinking: "provider reasoning" }],
          rawResponse: {},
          messageForLogs: {
            role: "assistant",
            usage: { input: 1, output: 1, totalTokens: 2 },
            content: [{ type: "text", text: "<thoughts>Keep the setup quiet until the result arrives.</thoughts>" }],
          },
        });
      }
      return Promise.resolve({
        text: "<thoughts>Now use it.</thoughts><message>Found it.</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: {
          role: "assistant",
          usage: { input: 1, output: 1, totalTokens: 2 },
          content: [{ type: "text", text: "<thoughts>Now use it.</thoughts><message>Found it.</message>" }],
        },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, extraTools: [tool] }),
    );

    expect(result.privateThoughts).toEqual([
      "Keep the setup quiet until the result arrives.",
      "Now use it.",
    ]);
    expect(result.privateThoughts).not.toContain("provider reasoning");
  });

  test("blocks malformed thoughts without sending or scheduling maintenance", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<thoughts>private text that must not leak",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 1, output: 1, totalTokens: 2 },
        content: [],
      },
    });
    const sender = mock(() => Promise.resolve({ sentMessageId: "sent-1" }));
    const afterReply = mock(() => Promise.resolve());

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, afterReply }),
    );

    expect(result.responseText).toBeUndefined();
    expect(result.privateThoughts).toBeUndefined();
    expect(sender).toHaveBeenCalledTimes(0);
    expect(afterReply).toHaveBeenCalledTimes(0);
  });

  test("blocks provider-incomplete output without sending or scheduling maintenance", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<voice>[sings] partial output",
      toolCalls: [],
      stopReason: "length",
      rawResponse: {},
      messageForLogs: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 1, output: 1, totalTokens: 2 },
        content: [{ type: "text", text: "<voice>[sings] partial output" }],
      },
    });
    const sender = mock(() => Promise.resolve({ sentMessageId: "sent-1" }));
    const afterReply = mock(() => Promise.resolve());

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, afterReply }),
    );

    expect(result.agentRan).toBe(true);
    expect(result.responseText).toBeUndefined();
    expect(sender).toHaveBeenCalledTimes(0);
    expect(afterReply).toHaveBeenCalledTimes(0);
  });

  test("pre-send discard skips silent memory pass", async () => {
    const afterReply = mock(() => Promise.resolve());
    const sender = mock(() => Promise.resolve({ sentMessageId: "sent-1" }));
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "stale reply",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, afterReply, preSendCheck: () => false }),
    );

    expect(result.agentRan).toBe(true);
    expect(result.responseText).toBeUndefined();
    expect(sender).toHaveBeenCalledTimes(0);
    expect(afterReply).toHaveBeenCalledTimes(0);
  });

  test("throws and skips memory extraction when the final Discord send fails", async () => {
    const afterReply = mock(() => Promise.resolve());
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "" });

    let thrown: unknown;
    try {
      await handleMessage(
        makeMessage({ mentionedUserIds: ["bot-1"] }),
        makeDeps({ sender, afterReply }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Failed to send final Discord message");
    expect(afterReply).toHaveBeenCalledTimes(0);
  });

  test("continues maintenance when Discord rejects a send for missing permissions", async () => {
    const afterReplyCalls: MemoryExtractionRequest[] = [];
    const afterReply = mock((request: MemoryExtractionRequest) => {
      afterReplyCalls.push(request);
      return Promise.resolve();
    });
    const permissionError = Object.assign(new Error("Missing Permissions"), { code: 50013 });
    const sender: MessageSender = () => Promise.reject(permissionError);

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ sender, afterReply }),
    );

    expect(result.responseText).toBe("hello user");
    expect(afterReplyCalls).toHaveLength(1);
    expect(afterReplyCalls[0]).toMatchObject({
      assistantReply: "hello user",
      visibleReplySent: false,
    });
  });

  test("still throws unrelated Discord send errors", async () => {
    const afterReply = mock(() => Promise.resolve());
    const validationError = Object.assign(new Error("Invalid Form Body"), { code: 50035 });
    const sender: MessageSender = () => Promise.reject(validationError);

    let thrown: unknown;
    try {
      await handleMessage(
        makeMessage({ mentionedUserIds: ["bot-1"] }),
        makeDeps({ sender, afterReply }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(validationError);
    expect(afterReply).toHaveBeenCalledTimes(0);
  });

  test("retries LLM output timeouts before sending final response", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls < 3) return Promise.reject(makeModelTimeoutError());
      return Promise.resolve({
        text: "recovered after timeout",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "recovered after timeout" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat }),
    );

    expect(result.responseText).toBe("recovered after timeout");
    expect(calls).toBe(3);
  });

  test("retries the production WebSocket 1006 failure twice and records the recovered call", async () => {
    const requestLog = new RequestLog("guild-1", "channel-1");
    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      request.onPayload?.({ model: request.model, attempt: calls });
      if (calls < 3) {
        return Promise.reject(new ModelProviderError("WebSocket closed 1006 Connection ended", {
          kind: "transport",
          retryable: true,
          transportCode: 1006,
        }));
      }
      return Promise.resolve({
        text: "recovered response",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "recovered response" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, requestLog }),
    );

    expect(result.responseText).toBe("recovered response");
    expect(calls).toBe(3);
    expect(requestLog.toEntry().llmCalls.map((call) => call.status)).toEqual(["error", "error", "completed"]);
  });

  test("does not retry permanent WebSocket close codes or aborted provider requests", async () => {
    const failures = [
      new ModelProviderError("WebSocket closed 1008 Policy violation", {
        kind: "permanent",
        retryable: false,
        transportCode: 1008,
      }),
      new ModelProviderError("WebSocket closed 1009 Message too big", {
        kind: "permanent",
        retryable: false,
        transportCode: 1009,
      }),
      new ModelProviderError("OpenAI Codex request failed: aborted", {
        kind: "aborted",
        retryable: false,
      }),
    ];

    for (const failure of failures) {
      let calls = 0;
      const completeChat: ChatCompleteFn = () => {
        calls += 1;
        return Promise.reject(failure);
      };

      let thrown: unknown;
      try {
        await handleMessage(
          makeMessage({ mentionedUserIds: ["bot-1"] }),
          makeDeps({ completeChat }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(failure.message);
      expect(calls).toBe(1);
    }
  });

  test("retries an abnormal stream closure before visible output", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new ModelProviderError("Stream closed unexpectedly before completion", {
          kind: "transport",
          retryable: true,
        }));
      }
      return Promise.resolve({
        text: "recovered after stream closure",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "recovered after stream closure" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat }),
    );

    expect(result.responseText).toBe("recovered after stream closure");
    expect(calls).toBe(2);
  });

  test("does not replay a failed turn after a completed streamed Discord message", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = async (request) => {
      calls += 1;
      await request.onTextDelta?.("<message>already sent</message>");
      throw new ModelProviderError("WebSocket closed 1006 Connection ended", {
        kind: "transport",
        retryable: true,
        transportCode: 1006,
      });
    };
    const sent: string[] = [];
    const sender: MessageSender = (text) => {
      sent.push(text);
      return Promise.resolve({ sentMessageId: `sent-${sent.length}` });
    };

    let thrown: unknown;
    try {
      await handleMessage(
        makeMessage({ mentionedUserIds: ["bot-1"] }),
        makeDeps({ completeChat, sender }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect((thrown as Error).message).toBe("WebSocket closed 1006 Connection ended");
    expect(calls).toBe(1);
    expect(sent).toEqual(["already sent"]);
  });

  test("retries transient provider Not Found errors before sending final response", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls < 3) return Promise.reject(new Error("Not Found"));
      return Promise.resolve({
        text: "recovered after provider error",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "recovered after provider error" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat }),
    );

    expect(result.responseText).toBe("recovered after provider error");
    expect(calls).toBe(3);
  });

  test("retries Codex SSE server_error events before sending final response", async () => {
    let calls = 0;
    const codexServerError = "Codex error: {\"type\":\"error\",\"error\":{\"type\":\"server_error\",\"code\":\"server_error\",\"message\":\"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req-test in your message.\",\"param\":null},\"sequence_number\":3}";
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls < 3) return Promise.reject(new Error(codexServerError));
      return Promise.resolve({
        text: "recovered after codex server error",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "recovered after codex server error" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        globalConfig: makeCodexGlobal(),
      }),
    );

    expect(result.responseText).toBe("recovered after codex server error");
    expect(calls).toBe(3);
  });

  test("waits 2, 3, 5, and 5 seconds between transient provider retries", async () => {
    let calls = 0;
    const retryDelays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const mockSetTimeout = ((
      callback: (...callbackArgs: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 2_000 || delay === 3_000 || delay === 5_000) {
        retryDelays.push(delay);
        queueMicrotask(() => { callback(...args); });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(mockSetTimeout);
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls < 5) {
        return Promise.reject(new ModelProviderError("Our servers are currently overloaded.", {
          kind: "provider_transient",
          retryable: true,
        }));
      }
      return Promise.resolve({
        text: "recovered after overload",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "recovered after overload" }] },
      });
    };
    const deps = makeDeps({ completeChat });
    delete deps.modelTurnRetryDelayMs;

    try {
      const result = await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), deps);
      expect(result.responseText).toBe("recovered after overload");
      expect(calls).toBe(5);
      expect(retryDelays).toEqual([2_000, 3_000, 5_000, 5_000]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  test("records normalized provider errors with pending LLM request payload", async () => {
    const requestLog = new RequestLog("guild-1", "channel-1");
    const completeChat: ChatCompleteFn = (request) => {
      request.onPayload?.({ model: request.model, route: "test-route" });
      return Promise.reject(new Error("Not Found"));
    };

    let thrown: unknown;
    try {
      await handleMessage(
        makeMessage({ mentionedUserIds: ["bot-1"] }),
        makeDeps({ completeChat, requestLog }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("OpenRouter request failed: Not Found");
    const llmCalls = requestLog.toEntry().llmCalls;
    expect(llmCalls).toHaveLength(5);
    expect(llmCalls.every((call) => call.isError === true)).toBe(true);
    expect(llmCalls[4]?.error).toBe("OpenRouter request failed: Not Found");
    expect(llmCalls[4]?.requestPayload).toEqual({ model: "moonshotai/kimi-k2.5", route: "test-route" });
  });

  test("retries empty final model responses before sending final response", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls < 3) {
        return Promise.resolve({
          text: "",
          toolCalls: [],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 0, totalTokens: 1 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "non-empty answer",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "non-empty answer" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat }),
    );

    expect(result.responseText).toBe("non-empty answer");
    expect(calls).toBe(3);
  });

  test("does not retry empty text when the model returned tool calls", async () => {
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
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls === 1) {
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
      return Promise.resolve({
        text: "answer from tool",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer from tool" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [tool], completeChat }),
    );

    expect(result.responseText).toBe("answer from tool");
    expect(calls).toBe(2);
    expect(toolCalls).toEqual([{ query: "x" }]);
  });

});
