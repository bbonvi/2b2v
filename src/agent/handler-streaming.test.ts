import { describe, expect, mock, test } from "bun:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { handleMessage } from "./handler.ts";
import type { ChatCompleteFn, MessageSender } from "./turn-types.ts";
import { RequestLog } from "../logger.ts";
import { assertSafeDiscordText } from "../discord/outbound-xml-guard.ts";
import { makeCodexGlobal, makeDeps, makeGuildConfig, makeMessage } from "./handler-test-support.ts";

describe("handleMessage", () => {
  test("shares Codex prompt cache keys without sharing channel transport sessions", async () => {
    const requests: Array<{ sessionId?: string; promptCacheKey?: string; payloadKey?: unknown }> = [];
    const completeChat: ChatCompleteFn = (request) => {
      const payload: Record<string, unknown> = {
        prompt_cache_key: request.sessionId,
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "current" }],
        }],
      };
      request.onPayload?.(payload);
      requests.push({
        ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
        ...(request.promptCacheKey !== undefined ? { promptCacheKey: request.promptCacheKey } : {}),
        payloadKey: payload.prompt_cache_key,
      });
      return Promise.resolve({
        text: "ok",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };
    const globalConfig = makeCodexGlobal({ model: "gpt-5.6-sol" });

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        globalConfig,
        requestLog: new RequestLog("guild-1", "channel-1"),
      }),
    );
    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"], channelId: "channel-2" }),
      makeDeps({
        completeChat,
        globalConfig,
        requestLog: new RequestLog("guild-1", "channel-2"),
      }),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]?.sessionId).not.toBe(requests[1]?.sessionId);
    expect(requests[0]?.promptCacheKey).toBe(requests[1]?.promptCacheKey);
    expect(requests[0]?.promptCacheKey).toMatch(/^2b2v:prompt:[a-f0-9]{48}$/);
    expect(requests.map((request) => request.payloadKey)).toEqual([
      requests[0]?.promptCacheKey,
      requests[1]?.promptCacheKey,
    ]);
  });

  test("keeps the Codex cache-family key stable across prompt and tool-contract edits", async () => {
    const keys: Array<string | undefined> = [];
    const completeChat: ChatCompleteFn = (request) => {
      keys.push(request.promptCacheKey);
      return Promise.resolve({
        text: "ok",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };
    const firstTool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "First contract wording",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => Promise.resolve({ content: [], details: {} }),
    };
    const secondTool: AgentTool = {
      ...firstTool,
      description: "Changed contract wording",
    };
    const common = {
      completeChat,
      globalConfig: makeCodexGlobal({ model: "gpt-5.6-sol" }),
      requestLog: new RequestLog("guild-1", "channel-1"),
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ ...common, systemPrompt: "first prompt", extraTools: [firstTool] }),
    );
    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ ...common, systemPrompt: "changed prompt", extraTools: [secondTool] }),
    );

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  test("removes the Codex prompt cache key when prompt caching is disabled", async () => {
    let requestCacheKey: string | undefined;
    let payloadCacheKey: unknown = "not-called";
    const completeChat: ChatCompleteFn = (request) => {
      const payload: Record<string, unknown> = {
        prompt_cache_key: request.sessionId,
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "current" }],
        }],
      };
      request.onPayload?.(payload);
      requestCacheKey = request.promptCacheKey;
      payloadCacheKey = payload.prompt_cache_key;
      return Promise.resolve({
        text: "ok",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        globalConfig: makeCodexGlobal({ model: "gpt-5.6-sol", promptCaching: { enabled: false } }),
        requestLog: new RequestLog("guild-1", "channel-1"),
      }),
    );

    expect(requestCacheKey).toBe("");
    expect(payloadCacheKey).toBeUndefined();
  });

  test("chains web search then fetch and sends one intermediate status", async () => {
    const toolCalls: Array<{ name: string; params: unknown }> = [];
    const webSearch: AgentTool = {
      name: "web_search",
      label: "Web Search",
      description: "Search the web",
      parameters: Type.Object({ query: Type.String() }),
      execute: (_id, params) => {
        toolCalls.push({ name: "web_search", params });
        return Promise.resolve({
          content: [{ type: "text", text: "1. **Example**\n   https://example.com/post\n   Useful snippet" }],
          details: {},
        });
      },
    };
    const fetchUrl: AgentTool = {
      name: "fetch_url",
      label: "Fetch URL",
      description: "Fetch a URL",
      parameters: Type.Object({ url: Type.String() }),
      execute: (_id, params) => {
        toolCalls.push({ name: "fetch_url", params });
        return Promise.resolve({
          content: [{ type: "text", text: "# Example\n\nSource: https://example.com/post\n\nFetched page body" }],
          details: {},
        });
      },
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "I'll check, one sec.",
          toolCalls: [{
            id: "call-discovery",
            type: "function",
            function: { name: "search_tools", arguments: "{\"query\":\"web search and fetch page\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      if (calls === 2) {
        expect(request.tools?.map((tool) => tool.function.name)).toContain("web_search");
        expect(request.tools?.map((tool) => tool.function.name)).toContain("fetch_url");
        expect(request.messages.some((message) =>
          message.role === "tool"
          && message.name === "search_tools"
          && message.addedToolNames?.includes("web_search") === true
          && message.addedToolNames.includes("fetch_url")
        )).toBe(true);
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-search",
            type: "function",
            function: { name: "web_search", arguments: "{\"query\":\"example\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      if (calls === 3) {
        expect(request.messages.some((m) =>
          m.role === "tool" && typeof m.content === "string" && m.content.includes("https://example.com/post"),
        )).toBe(true);
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-fetch",
            type: "function",
            function: { name: "fetch_url", arguments: "{\"url\":\"https://example.com/post\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      expect(request.messages.some((m) =>
        m.role === "tool" && typeof m.content === "string" && m.content.includes("Fetched page body"),
      )).toBe(true);
      return Promise.resolve({
        text: "Fetched summary [source](https://example.com/post)",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    const senderCalls: Array<{ text: string; reply: boolean }> = [];
    const sender: MessageSender = (text, reply) => {
      senderCalls.push({ text, reply });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const onStillWorking = mock(() => {});

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [webSearch, fetchUrl],
        initialToolNames: [],
        completeChat,
        sender,
        onStillWorking,
        guildConfig: makeGuildConfig({ replyLoop: { maxToolCalls: 2, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 } }),
      }),
    );

    expect(result.responseText).toBe("Fetched summary [source](https://example.com/post)");
    expect(toolCalls).toEqual([
      { name: "web_search", params: { query: "example" } },
      { name: "fetch_url", params: { url: "https://example.com/post" } },
    ]);
    expect(senderCalls).toEqual([
      { text: "I'll check, one sec.", reply: false },
      { text: "Fetched summary [source](https://example.com/post)", reply: false },
    ]);
    expect(onStillWorking).toHaveBeenCalledTimes(1);
  });

  test("sends message directive segments as separate Discord messages", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message>first line</message><message>second line</message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; reply: boolean }> = [];
    const sender: MessageSender = (text, reply) => {
      senderCalls.push({ text, reply });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const afterReplyCalls: unknown[] = [];
    const afterReply = (request: unknown): Promise<void> => {
      afterReplyCalls.push(request);
      return Promise.resolve();
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, afterReply }),
    );

    expect(senderCalls).toEqual([
      { text: "first line", reply: false },
      { text: "second line", reply: false },
    ]);
    expect(afterReplyCalls[0]).toMatchObject({
      assistantReply: "first line\n[msg-break]\nsecond line",
    });
    expect(result.responseText).toBe("first line\n[msg-break]\nsecond line");
  });

  test("applies message delivery attributes per Discord message", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: [
        "<message reply=\"false\">normal first</message>",
        "<message reply=\"true\">reply second</message>",
        "<message reply_to=\"older-123\">targeted third</message>",
        "<message>normal fourth</message>",
      ].join(""),
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; reply: boolean; replyToMessageId?: string }> = [];
    const sender: MessageSender = (text, reply, _channelId, _voice, _signal, replyToMessageId) => {
      senderCalls.push({ text, reply, replyToMessageId });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender }),
    );

    expect(senderCalls).toEqual([
      { text: "normal first", reply: false, replyToMessageId: undefined },
      { text: "reply second", reply: true, replyToMessageId: undefined },
      { text: "targeted third", reply: false, replyToMessageId: "older-123" },
      { text: "normal fourth", reply: false, replyToMessageId: undefined },
    ]);
  });

  test("attaches typed asset_ids on the requested message only", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message asset_ids=[12]>again</message><message asset_ids=[13] /><message>done</message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const senderCalls: Array<{ text: string; attachmentIds: string[] }> = [];
    const sender: MessageSender = (text, _reply, _channelId, _voice, _signal, _replyToMessageId, attachments) => {
      senderCalls.push({ text, attachmentIds: attachments?.map((attachment) => attachment.id) ?? [] });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        sender,
        resolveAssetAttachments: (assetIds) => Promise.resolve(assetIds.map((id) => ({
          id: `chat-asset-${id}`,
          buffer: Buffer.from("image"),
          filename: `chat-asset-${id}.png`,
          contentType: "image/png",
        }))),
      }),
    );

    expect(senderCalls).toEqual([
      { text: "again", attachmentIds: ["chat-asset-12"] },
      { text: "", attachmentIds: ["chat-asset-13"] },
      { text: "done", attachmentIds: [] },
    ]);
  });

  test("asks once for a corrected response after invalid message attributes", async () => {
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      return Promise.resolve({
        text: calls === 1
          ? '<message asset_id="12"></message>'
          : '<message asset_ids="12"></message>',
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };
    const senderCalls: Array<{ text: string; attachmentIds: string[] }> = [];
    const sender: MessageSender = (text, _reply, _channelId, _voice, _signal, _replyToMessageId, attachments) => {
      senderCalls.push({ text, attachmentIds: attachments?.map((attachment) => attachment.id) ?? [] });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        sender,
        resolveAssetAttachments: (assetIds) => Promise.resolve(assetIds.map((id) => ({
          id: `chat-asset-${id}`,
          buffer: Buffer.from("image"),
          filename: `chat-asset-${id}.png`,
          contentType: "image/png",
        }))),
      }),
    );

    expect(calls).toBe(2);
    expect(senderCalls).toEqual([{ text: "", attachmentIds: ["chat-asset-12"] }]);
  });

  test("rejects an asset-only message when no referenced asset resolves", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: '<message asset_ids="12"></message>',
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });

    let thrown: unknown;
    try {
      await handleMessage(
        makeMessage({ mentionedUserIds: ["bot-1"] }),
        makeDeps({
          completeChat,
          resolveAssetAttachments: () => Promise.resolve([]),
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("it has no text and no referenced asset resolved");
  });

  test("streams final message envelopes as they close", async () => {
    const lookupTool: AgentTool = {
      name: "search_channel_messages",
      label: "Search",
      description: "Search",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "tool result" }], details: {} }),
    };
    const events: string[] = [];
    let calls = 0;
    const completeChat: ChatCompleteFn = async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          text: "",
          toolCalls: [
            {
              id: "call-search",
              type: "function",
              function: { name: "search_channel_messages", arguments: "{\"query\":\"x\"}" },
            },
            {
              id: "call-search-skipped",
              type: "function",
              function: { name: "search_channel_messages", arguments: "{\"query\":\"y\"}" },
            },
          ],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        };
      }

      expect(request.toolChoice).toBe("none");
      await request.onTextDelta?.("<message keep_typing=\"true\">first</message><message>sec");
      events.push("after-first-delta");
      await request.onTextDelta?.("ond</message>");
      return {
        text: "<message keep_typing=\"true\">first</message><message>second</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const senderCalls: Array<{ text: string; reply: boolean }> = [];
    const sender: MessageSender = (text, reply) => {
      senderCalls.push({ text, reply });
      events.push(`sent:${text}`);
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const onStillWorking = mock(() => {
      events.push("typing");
    });

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        sender,
        extraTools: [lookupTool],
        onStillWorking,
        guildConfig: makeGuildConfig({ replyLoop: { maxToolCalls: 1, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 } }),
      }),
    );

    expect(events.indexOf("sent:first")).toBeLessThan(events.indexOf("after-first-delta"));
    expect(senderCalls).toEqual([
      { text: "first", reply: false },
      { text: "second", reply: false },
    ]);
    expect(onStillWorking).toHaveBeenCalled();
    expect(result.responseText).toBe("first\n[msg-break]\nsecond");
  });

  test("streams ordinary first-turn answers even when tools are available", async () => {
    const lookupTool: AgentTool = {
      name: "search_channel_messages",
      label: "Search",
      description: "Search",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "unused" }], details: {} }),
    };
    const events: string[] = [];
    const completeChat: ChatCompleteFn = async (request) => {
      expect(request.toolChoice).toBe("auto");
      await request.onTextDelta?.("<message>first normal</message><message>second");
      events.push("after-first-delta");
      await request.onTextDelta?.(" normal</message>");
      return {
        text: "<message>first normal</message><message>second normal</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const senderCalls: Array<{ text: string; reply: boolean }> = [];
    const sender: MessageSender = (text, reply) => {
      senderCalls.push({ text, reply });
      events.push(`sent:${text}`);
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, extraTools: [lookupTool] }),
    );

    expect(events.indexOf("sent:first normal")).toBeLessThan(events.indexOf("after-first-delta"));
    expect(senderCalls).toEqual([
      { text: "first normal", reply: false },
      { text: "second normal", reply: false },
    ]);
    expect(result.responseText).toBe("first normal\n[msg-break]\nsecond normal");
  });

  test("commits only after a complete message envelope", async () => {
    const events: string[] = [];
    const completeChat: ChatCompleteFn = async (request) => {
      await request.onTextDelta?.("<thoughts>still drafting</thoughts><message>par");
      expect(events).toEqual([]);
      await request.onTextDelta?.("tial</message>");
      expect(events).toEqual(["committed"]);
      return {
        text: "<thoughts>still drafting</thoughts><message>partial</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const sender: MessageSender = (text) => {
      events.push(`sent:${text}`);
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        sender,
        onActionCommitted: () => { events.push("committed"); },
      }),
    );

    expect(events).toEqual(["committed", "sent:partial"]);
  });

  test("commits a complete tool call before tool execution", async () => {
    let committed = false;
    let calls = 0;
    const lookupTool: AgentTool = {
      name: "search_channel_messages",
      label: "Search",
      description: "Search",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => {
        expect(committed).toBe(true);
        return Promise.resolve({ content: [{ type: "text", text: "tool result" }], details: {} });
      },
    };
    const completeChat: ChatCompleteFn = async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          text: "<thoughts>checking</thoughts>",
          toolCalls: [{
            id: "call-search",
            type: "function",
            function: { name: "search_channel_messages", arguments: "{\"query\":\"x\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        };
      }
      await request.onTextDelta?.("<message>done</message>");
      return {
        text: "<message>done</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        extraTools: [lookupTool],
        onActionCommitted: () => { committed = true; },
      }),
    );

    expect(committed).toBe(true);
  });

  test("does not commit or execute a tool call returned after cancellation", async () => {
    const controller = new AbortController();
    const cancellation = new Error("superseded");
    let committed = false;
    let executed = false;
    const lookupTool: AgentTool = {
      name: "search_channel_messages",
      label: "Search",
      description: "Search",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => {
        executed = true;
        return Promise.resolve({ content: [{ type: "text", text: "tool result" }], details: {} });
      },
    };
    const completeChat: ChatCompleteFn = () => {
      controller.abort(cancellation);
      return Promise.resolve({
        text: "",
        toolCalls: [{
          id: "call-search",
          type: "function",
          function: { name: "search_channel_messages", arguments: "{\"query\":\"x\"}" },
        }],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    let thrown: unknown;
    try {
      await handleMessage(
        makeMessage({ mentionedUserIds: ["bot-1"] }),
        makeDeps({
          abortSignal: controller.signal,
          completeChat,
          extraTools: [lookupTool],
          onActionCommitted: () => { committed = true; },
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(cancellation);
    expect(committed).toBe(false);
    expect(executed).toBe(false);
  });

  test("adds a rejected outbound XML error to the model conversation and retries", async () => {
    let calls = 0;
    let retryInstruction = "";
    const completeChat: ChatCompleteFn = async (request) => {
      calls += 1;
      if (calls === 1) {
        await request.onTextDelta?.(
          "<message>first</message><message><internal>private</internal></message>",
        );
        throw new Error("The XML guard did not reject the streamed message.");
      }
      const lastMessage = request.messages.at(-1);
      retryInstruction = typeof lastMessage?.content === "string" ? lastMessage.content : "";
      await request.onTextDelta?.("<message>corrected second</message>");
      return {
        text: "<message>corrected second</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const sentTexts: string[] = [];
    const sender: MessageSender = (text) => {
      assertSafeDiscordText(text);
      sentTexts.push(text);
      return Promise.resolve({ sentMessageId: `sent-${sentTexts.length}` });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender }),
    );

    expect(calls).toBe(2);
    expect(retryInstruction).toContain("was not sent");
    expect(sentTexts).toEqual(["first", "corrected second"]);
    expect(result.responseText).toBe("corrected second");
  });

  test("streaming consumes late ignore directives without dropping later messages", async () => {
    const finalText = "<message>first</message><ignore>skip</ignore><message>second</message>";
    const completeChat: ChatCompleteFn = async (request) => {
      await request.onTextDelta?.(finalText);
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
    const onIgnoredReply = mock(() => {});

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, onIgnoredReply }),
    );

    expect(senderCalls).toEqual([
      { text: "first", reply: false },
      { text: "second", reply: false },
    ]);
    expect(onIgnoredReply).toHaveBeenCalledTimes(0);
    expect(result.responseText).toBe("first\n[msg-break]\nsecond");
  });

  test("waits for typing indicator before sending the next streamed message", async () => {
    const events: string[] = [];
    let releaseTyping: (() => void) | undefined;
    const typingGate = new Promise<void>((resolve) => {
      releaseTyping = resolve;
    });
    const completeChat: ChatCompleteFn = async (request) => {
      const deltaPromise = request.onTextDelta?.("<message>first</message><message>sec") ?? Promise.resolve(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual(["sent:first", "typing-start"]);
      releaseTyping?.();
      await deltaPromise;
      await request.onTextDelta?.("ond</message>");
      return {
        text: "<message>first</message><message>second</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const sender: MessageSender = (text) => {
      events.push(`sent:${text}`);
      return Promise.resolve({ sentMessageId: `sent-${events.length}` });
    };
    const onStillWorking = async (): Promise<void> => {
      events.push("typing-start");
      await typingGate;
      events.push("typing-done");
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, onStillWorking }),
    );

    expect(events).toEqual(["sent:first", "typing-start", "typing-done", "sent:second"]);
  });

  test("emits typing between streamed messages that are already complete", async () => {
    const completeChat: ChatCompleteFn = async (request) => {
      await request.onTextDelta?.("<message keep_typing=\"true\">first</message><message>second</message>");
      return {
        text: "<message keep_typing=\"true\">first</message><message>second</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const events: string[] = [];
    const sentAt: number[] = [];
    const sender: MessageSender = (text) => {
      sentAt.push(Date.now());
      events.push(`sent:${text}`);
      return Promise.resolve({ sentMessageId: `sent-${events.length}` });
    };
    const onStillWorking = mock(() => {
      events.push("typing");
    });

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat, sender, onStillWorking, liveMessageTypingHoldMs: 25 }),
    );

    expect(events).toEqual(["sent:first", "typing", "sent:second"]);
    expect((sentAt[1] ?? 0) - (sentAt[0] ?? 0)).toBeGreaterThanOrEqual(15);
    expect(onStillWorking).toHaveBeenCalledTimes(1);
  });

  test("holds visible typing before each message when typing simulation is enabled", async () => {
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message>first reply</message><message>second reply</message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
    });
    const events: string[] = [];
    let typingStartedAt = 0;
    const sender: MessageSender = (text) => {
      events.push(`sent:${text}`);
      return Promise.resolve({ sentMessageId: `sent-${events.length}` });
    };
    const onStillWorking = mock(() => {
      typingStartedAt = Date.now();
      events.push("typing");
    });
    const onVisibleOutput = mock(() => {
      typingStartedAt = 0;
    });

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        sender,
        onStillWorking,
        onVisibleOutput,
        getTypingStartedAt: () => typingStartedAt,
        guildConfig: makeGuildConfig({
          typingSimulation: {
            enabled: true,
            inputReadingWpm: 0,
            inputMinDelayMs: 0,
            inputMaxDelayMs: 0,
            outputTypingWpm: 10,
            outputMinHoldMs: 10,
            outputMaxHoldMs: 10,
          },
        }),
      }),
    );

    expect(events).toEqual(["typing", "sent:first reply", "typing", "sent:second reply"]);
    expect(onStillWorking).toHaveBeenCalledTimes(2);
  });

  test("holds visible typing before each streamed message when typing simulation is enabled", async () => {
    const completeChat: ChatCompleteFn = async (request) => {
      await request.onTextDelta?.("<message>first reply</message><message>second reply</message>");
      return {
        text: "<message>first reply</message><message>second reply</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      };
    };
    const events: string[] = [];
    let typingStartedAt = 0;
    const sender: MessageSender = (text) => {
      events.push(`sent:${text}`);
      return Promise.resolve({ sentMessageId: `sent-${events.length}` });
    };
    const onStillWorking = mock(() => {
      typingStartedAt = Date.now();
      events.push("typing");
    });
    const onVisibleOutput = mock(() => {
      typingStartedAt = 0;
    });

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        sender,
        onStillWorking,
        onVisibleOutput,
        getTypingStartedAt: () => typingStartedAt,
        guildConfig: makeGuildConfig({
          typingSimulation: {
            enabled: true,
            inputReadingWpm: 0,
            inputMinDelayMs: 0,
            inputMaxDelayMs: 0,
            outputTypingWpm: 10,
            outputMinHoldMs: 10,
            outputMaxHoldMs: 10,
          },
        }),
      }),
    );

    expect(events).toEqual(["typing", "sent:first reply", "typing", "sent:second reply"]);
    expect(onStillWorking).toHaveBeenCalledTimes(2);
  });

});
