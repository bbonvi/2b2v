import { describe, expect, mock, test } from "bun:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { handleMessage } from "./handler.ts";
import type { ChatCompleteFn, MessageSender } from "./turn-types.ts";
import { RequestLog } from "../logger.ts";
import { TEST_RUNTIME_PROMPTS, contentText, findMessageContent, makeCodexGlobal, makeContext, makeDeps, makeGlobalConfig, makeGuildConfig, makeMessage, makePromptTransportConfig, payloadText } from "./handler-test-support.ts";

describe("handleMessage", () => {
  test("returns triggered=false when no trigger matches", async () => {
    const completeChat = mock(() => Promise.resolve({
      text: "unused",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: {},
    }));
    const result = await handleMessage(makeMessage(), makeDeps({
      guildConfig: makeGuildConfig({ triggers: { mention: false, keywords: [], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingResumeGraceMs: 3000, typingMaxWaitMs: 15000 } }),
      completeChat: completeChat as unknown as ChatCompleteFn,
    }));

    expect(result.triggered).toBe(false);
    expect(result.agentRan).toBe(false);
    expect(completeChat).toHaveBeenCalledTimes(0);
  });

  test("triggerOverride runs even when the current message does not match", async () => {
    const completeChat = mock(() => Promise.resolve({
      text: "hello user",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: {},
    }));

    const result = await handleMessage(makeMessage({ content: "followup", translatedContent: "followup" }), makeDeps({
      guildConfig: makeGuildConfig({ triggers: { mention: false, keywords: [], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingResumeGraceMs: 3000, typingMaxWaitMs: 15000 } }),
      triggerOverride: { reason: "keyword", keyword: "туби" },
      completeChat: completeChat as unknown as ChatCompleteFn,
    }));

    expect(result.triggered).toBe(true);
    expect(result.triggerResult).toEqual({ reason: "keyword", keyword: "туби" });
    expect(completeChat).toHaveBeenCalledTimes(1);
  });

  test("sends direct final model text", async () => {
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ sender }),
    );

    expect(result.responseText).toBe("hello user");
    expect(senderCalls).toEqual([{ text: "hello user", reply: false, channelId: undefined }]);
  });

  test("runs for a role assigned to the bot", async () => {
    const result = await handleMessage(
      makeMessage({
        mentionedRoleIds: ["role-bot"],
        botRoleIds: ["role-bot"],
      }),
      makeDeps(),
    );

    expect(result.triggered).toBe(true);
    expect(result.triggerResult).toEqual({ reason: "mention" });
  });

  test("routes individual message envelopes by channel_id", async () => {
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string; replyTo?: string }> = [];
    const sender: MessageSender = (text, reply, channelId, _voice, _signal, replyTo) => {
      senderCalls.push({ text, reply, channelId, replyTo });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message>here</message><message channel_id=\"thread-1\" reply_to=\"msg-9\">there</message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: {
        role: "assistant",
        model: "m",
        stopReason: "stop",
        content: [{ type: "text", text: "routed" }],
        usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
      },
    });

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ sender, completeChat }),
    );

    expect(senderCalls).toEqual([
      { text: "here", reply: false, channelId: undefined, replyTo: undefined },
      { text: "there", reply: false, channelId: "thread-1", replyTo: "msg-9" },
    ]);
  });

  test("same-current-channel routing does not suppress default first-message replies", async () => {
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message channel_id=\"channel-1\">same channel</message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "same channel" }] },
    });

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ sender, completeChat, currentChannelId: "channel-1" }),
    );

    expect(senderCalls).toEqual([{ text: "same channel", reply: false, channelId: "channel-1" }]);
  });

  test("cross-channel routed messages without reply_to default to normal sends", async () => {
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message channel_id=\"thread-1\">thread message</message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "thread message" }] },
    });

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ sender, completeChat, currentChannelId: "channel-1" }),
    );

    expect(senderCalls).toEqual([{ text: "thread message", reply: false, channelId: "thread-1" }]);
  });

  test("first current-channel message still replies after an earlier cross-channel send", async () => {
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: `sent-${senderCalls.length}` });
    };
    const completeChat: ChatCompleteFn = () => Promise.resolve({
      text: "<message channel_id=\"thread-1\">thread message</message><message>current message</message>",
      toolCalls: [],
      rawResponse: {},
      messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "messages" }] },
    });

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ sender, completeChat, currentChannelId: "channel-1" }),
    );

    expect(senderCalls).toEqual([
      { text: "thread message", reply: false, channelId: "thread-1" },
      { text: "current message", reply: false, channelId: undefined },
    ]);
  });

  test("does not require OpenRouter image fallback options when Codex fallback is disabled", async () => {
    const completeChat: ChatCompleteFn = (request) => {
      expect(request.provider).toBe("openai-codex");
      expect(request.apiKey).toBe("");
      expect(request.providerParams?.codexAuthPath).toBe("data/codex-auth.json");
      expect(request.providerParams?.serviceTier).toBe("priority");
      return Promise.resolve({
        text: "codex reply",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        globalConfig: {
          ...makeCodexGlobal({ serviceTier: "priority" }),
          openrouterApiKey: undefined,
        },
        guildConfig: makeGuildConfig({
          imageReading: { fallbackEnabled: false, fallbackModelProfile: "main" },
          imageGeneration: { quality: "auto", modelProfile: "main" },
        }),
        completeChat,
      }),
    );

    expect(result.responseText).toBe("codex reply");
  });

  test("sends keyword-triggered final text as a reply", async () => {
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ content: "hello bot", translatedContent: "hello bot" }),
      makeDeps({
        guildConfig: makeGuildConfig({
          triggers: { mention: false, keywords: ["bot"], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingResumeGraceMs: 3000, typingMaxWaitMs: 15000 },
        }),
        sender,
      }),
    );

    expect(senderCalls).toEqual([{ text: "hello user", reply: false, channelId: undefined }]);
  });

  test("includes loaded runtime prompts before volatile turn context", async () => {
    const completeChat: ChatCompleteFn = (request) => {
      const payload = {
        messages: [
          ...(request.systemPrompt !== "" ? [{ role: "system", content: request.systemPrompt }] : []),
          ...request.messages,
        ],
      };
      request.onPayload?.(payload);
      const text = payloadText(payload);
      expect(text).toContain(TEST_RUNTIME_PROMPTS.skills.indexPrompt.trim());
      expect(text).toContain(TEST_RUNTIME_PROMPTS.reply.trim());
      expect(text).toContain(TEST_RUNTIME_PROMPTS.finalActionInstruction.trim());
      expect(text).toContain(TEST_RUNTIME_PROMPTS.contextTemplates["visible-reply-execution-mode"]);
      expect(text.indexOf(TEST_RUNTIME_PROMPTS.reply.trim())).toBeLessThan(text.indexOf("## Memory"));
      return Promise.resolve({
        text: "done",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ completeChat }),
    );
  });

  test("keeps stable prompt before a stable cache anchor and volatile turn context", async () => {
    const completeChat: ChatCompleteFn = (request) => {
      const payload = {
        messages: [
          ...(request.systemPrompt !== "" ? [{ role: "system", content: request.systemPrompt }] : []),
          ...request.messages,
        ],
      };
      request.onPayload?.(payload);

      const messages = payload.messages as Array<{ role?: string; content?: unknown }>;
      expect(messages[0]?.role).toBe("developer");
      expect(contentText(messages[0]?.content)).toContain("You are a test bot.");
      expect(contentText(messages[0]?.content)).not.toContain(TEST_RUNTIME_PROMPTS.reply.trim());
      expect(messages[1]?.role).toBe("developer");
      expect(contentText(messages[1]?.content)).toContain(TEST_RUNTIME_PROMPTS.skills.indexPrompt.trim());
      expect(contentText(messages[1]?.content)).toContain("image_generation");
      expect(contentText(messages[1]?.content)).toContain(TEST_RUNTIME_PROMPTS.reply.trim());
      expect(messages[2]).toEqual({
        role: "user",
        content: "Stable context is loaded; wait for the current Discord turn.",
      });
      expect(messages[3]).toEqual({ role: "assistant", content: "Ready." });
      expect(findMessageContent(messages, "## Memory")).toContain("- 1 [@user] [preference] concise");
      expect(findMessageContent(messages, "## Server Members")).toContain("@user");
      expect(findMessageContent(messages, "Guild: g1")).toBe("Guild: g1");
      const currentTurn = findMessageContent(messages, "## Current Discord Message");
      expect(currentTurn).toContain("## Current Discord Message Metadata");
      expect(currentTurn).toContain("MsgID: msg-1");
      expect(currentTurn).toContain("Author: @testuser");
      expect(currentTurn).toContain("AuthorID: user-1");
      expect(currentTurn).toContain("DisplayName: Test Nick");
      expect(currentTurn).toContain("GlobalName: Test Global");
      expect(currentTurn).toContain("AuthorIsBot: false");
      expect(currentTurn).toContain("ReplyToMsgID: parent-msg");
      expect(currentTurn).toContain("Audio: #29 chunk_08.wav");
      expect(currentTurn).toContain("Reply Context: The current event replies to a message you previously sent here from another channel.");
      expect(currentTurn).toContain("Source GuildID: source-guild");
      expect(currentTurn).toContain("Source ChannelID: source-channel");
      expect(currentTurn).toContain("Source MsgID: source-msg");
      expect(currentTurn).toContain("<handoff>old routed context</handoff>");
      expect(currentTurn).toContain("hello bot");
      const currentTurnIndex = messages.findIndex((message) => contentText(message.content).includes("## Current Discord Message"));
      expect(messages[currentTurnIndex + 1]?.role).toBe("user");
      const finalAction = contentText(messages[currentTurnIndex + 1]?.content);
      expect(finalAction).toStartWith("## Execution Mode: Visible Reply");
      expect(finalAction).toContain(TEST_RUNTIME_PROMPTS.finalActionInstruction.trim());

      return Promise.resolve({
        text: "done",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({
        mentionedUserIds: ["bot-1"],
        replyToMessageId: "parent-msg",
        authorDisplayName: "Test Nick",
        authorGlobalName: "Test Global",
        authorIsBot: false,
        repliedToBotRouteSource: {
          sourceGuildId: "source-guild",
          sourceChannelId: "source-channel",
          sourceMessageId: "source-msg",
          handoff: "<handoff>old routed context</handoff>",
        },
        assets: [{
          id: 29,
          kind: "audio",
          sourceKind: "attachment",
          filename: "chunk_08.wav",
          contentType: "audio/wav",
          size: 5_030_816,
          width: null,
          height: null,
          durationSeconds: 198.3,
        }],
      }),
      makeDeps({ completeChat }),
    );
  });

  test("uses full debounced current-turn event content when provided", async () => {
    let currentTurn = "";
    const completeChat: ChatCompleteFn = (request) => {
      currentTurn = findMessageContent(request.messages, "## Current Discord Message") ?? "";
      return Promise.resolve({
        text: "ok",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({
        translatedContent: "latest followup",
        eventContent: "first trigger [msg-break] latest followup",
        mentionedUserIds: ["bot-1"],
      }),
      makeDeps({ completeChat }),
    );

    expect(currentTurn).toContain("MsgID: msg-1");
    expect(currentTurn).toContain("first trigger [msg-break] latest followup");
  });

  test("does not duplicate current Discord content already rendered in canonical history", async () => {
    let promptText = "";
    const completeChat: ChatCompleteFn = (request) => {
      promptText = request.messages.map((message) => contentText(message.content)).join("\n");
      return Promise.resolve({
        text: "ok",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: {
          role: "assistant",
          usage: { input: 1, output: 1, totalTokens: 2 },
          content: [],
        },
      });
    };

    await handleMessage(
      makeMessage({
        translatedContent: "unique-current-message",
        currentContentInHistory: true,
        mentionedUserIds: ["bot-1"],
      }),
      makeDeps({
        completeChat,
        context: makeContext({
          userMessage: "unique-current-message",
          sections: [
            {
              label: "Chat History — Newer",
              text: "## Chat History\n[@testuser (MsgID: msg-1)]: unique-current-message",
              cached: false,
              role: "developer",
            },
          ],
        }),
      }),
    );

    expect(promptText.match(/unique-current-message/g)).toHaveLength(1);
    expect(promptText).toContain("## Context Boundary");
    expect(promptText).not.toContain("## Current Discord Message Metadata");
  });

  test("uses caller-provided headings for a non-message current turn", async () => {
    let currentTurn = "";
    const completeChat: ChatCompleteFn = (request) => {
      currentTurn = findMessageContent(request.messages, "## Live Voice Response Opportunity") ?? "";
      return Promise.resolve({
        text: "ok",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({
        eventContent: "Use the immediate exchange.",
        eventPrompt: {
          metadataHeading: "Voice Turn Metadata",
          contentHeading: "Live Voice Response Opportunity",
          metadataText: "Voice ChannelID: voice-1",
        },
        mentionedUserIds: ["bot-1"],
      }),
      makeDeps({ completeChat }),
    );

    expect(currentTurn).toContain("## Voice Turn Metadata");
    expect(currentTurn).toContain("Voice ChannelID: voice-1");
    expect(currentTurn).toContain("Use the immediate exchange.");
    expect(currentTurn).not.toContain("## Current Discord Message Metadata");
    expect(currentTurn).not.toContain("## Current Discord Message");
    expect(currentTurn).not.toContain("Author:");
  });

  test("renders a bare synthetic current turn as one message before actor instructions", async () => {
    let promptMessages: string[] = [];
    const completeChat: ChatCompleteFn = (request) => {
      promptMessages = request.messages.map((message) => contentText(message.content));
      return Promise.resolve({
        text: "ok",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({
        translatedContent: "## Background Agent Handoff\n\nInspection complete.",
        eventContent: "## Background Agent Handoff\n\nInspection complete.",
        bareCurrentTurn: true,
        mentionedUserIds: ["bot-1"],
      }),
      makeDeps({ completeChat }),
    );

    const handoffMessages = promptMessages.filter((message) => message.includes("## Background Agent Handoff"));
    expect(handoffMessages).toEqual(["## Background Agent Handoff\n\nInspection complete."]);
    expect(handoffMessages[0]).not.toContain("## Current Discord Message Metadata");
    expect(handoffMessages[0]).not.toContain("## Current Discord Message");
    const handoffIndex = promptMessages.findIndex((message) => message.includes("## Background Agent Handoff"));
    expect(promptMessages[handoffIndex + 1]).toStartWith("## Execution Mode: Visible Reply");
  });

  test("places a private-life instruction immediately before its synthetic event", async () => {
    let promptMessages: string[] = [];
    const completeChat: ChatCompleteFn = (request) => {
      promptMessages = request.messages.map((message) => typeof message.content === "string" ? message.content : "");
      return Promise.resolve({
        text: "<ignore>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({
        eventPrompt: {
          metadataHeading: "Private-Life Runtime",
          contentHeading: "Private-Life Opportunity",
          metadataText: "No Discord user caused this private opportunity.",
        },
        content: "Current local date and time: Wednesday 22 July 2026 at 09:25 GMT+03:00",
        translatedContent: "Current local date and time: Wednesday 22 July 2026 at 09:25 GMT+03:00",
        mentionedUserIds: ["bot-1"],
      }),
      makeDeps({
        completeChat,
        context: makeContext({
          sections: [{
            label: "Private-Life Instruction",
            text: "# Private Life Opportunity\n\nPrivate policy.",
            cached: false,
            role: "developer",
          }],
        }),
      }),
    );

    const privateInstructionIndex = promptMessages.findIndex((message) => message.includes("# Private Life Opportunity"));
    const eventIndex = promptMessages.findIndex((message) => message.includes("## Private-Life Runtime"));
    expect(privateInstructionIndex).toBeGreaterThanOrEqual(0);
    expect(eventIndex).toBeGreaterThan(privateInstructionIndex);
    expect(promptMessages[eventIndex]?.match(/## Private-Life Opportunity/g)).toHaveLength(1);
  });

  test("marks an external bot author in current event metadata", async () => {
    let currentTurn = "";
    const completeChat: ChatCompleteFn = (request) => {
      currentTurn = findMessageContent(request.messages, "## Current Discord Message") ?? "";
      return Promise.resolve({
        text: "ok",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({
        authorId: "other-bot",
        authorIsBot: true,
        mentionedUserIds: ["bot-1"],
      }),
      makeDeps({ completeChat }),
    );

    expect(currentTurn).toContain("AuthorIsBot: true");
  });

  test("splits Codex stable prompt into input messages", async () => {
    const completeChat: ChatCompleteFn = (request) => {
      const payload = {
        instructions: request.systemPrompt,
        input: request.messages.map((message) => ({
          type: "message",
          role: message.role,
          content: contentText(message.content),
        })),
      };
      request.onPayload?.(payload);

      expect(payload.instructions).toBe("Top-level policy.");
      expect(payload.instructions).not.toContain("You are a helpful assistant.");
      expect(payload.input[0]).toMatchObject({ role: "developer" });
      expect(contentText((payload.input[0] as { content?: unknown }).content)).toContain("You are a test bot.");
      expect(payload.input[1]).toMatchObject({ role: "developer" });
      expect(contentText((payload.input[1] as { content?: unknown }).content)).toContain("Reserved action directives");
      expect(payload.input.some((item) =>
        item.type === "message" && item.role === "user" && item.content.includes("## Memory")
      )).toBe(true);
      expect(payload.input.some((item) =>
        item.type === "message" && item.role === "user" && item.content.includes("## Current Discord Message")
      )).toBe(true);
      const currentTurnIndex = payload.input.findIndex((item) =>
        item.type === "message" && item.content.includes("## Current Discord Message")
      );
      expect(payload.input[currentTurnIndex + 1]).toMatchObject({
        type: "message",
        role: "user",
      });
      expect(payload.input[currentTurnIndex + 1]?.content).toContain("## Final Action Instruction");

      return Promise.resolve({
        text: "done",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        systemPrompt: "Top-level policy.",
        globalConfig: makeCodexGlobal(),
      }),
    );
  });

  test("does not duplicate Codex instruction-target core prompt", async () => {
    const transport = makePromptTransportConfig();
    transport.openaiCodex.sections.core = {
      ...transport.openaiCodex.sections.core,
      target: "instructions",
    };
    let capturedPayload: { instructions?: unknown; input: unknown[] } | undefined;
    const completeChat: ChatCompleteFn = (request) => {
      const payload = {
        instructions: request.systemPrompt,
        input: request.messages.map((message) => ({
          type: "message",
          role: message.role,
          content: contentText(message.content),
        })),
      };
      request.onPayload?.(payload);
      capturedPayload = payload;

      return Promise.resolve({
        text: "done",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        globalConfig: makeCodexGlobal(),
        guildConfig: makeGuildConfig({ promptTransport: transport }),
      }),
    );

    if (capturedPayload === undefined) throw new Error("expected payload capture");
    expect(typeof capturedPayload.instructions).toBe("string");
    expect(capturedPayload.instructions).toContain("You are a test bot.");
    const promptText = JSON.stringify(capturedPayload);
    expect(promptText.match(/You are a test bot\./g)?.length).toBe(1);
  });

  test("keeps older chat history in the stable prompt instead of volatile turn context", async () => {
    const completeChat: ChatCompleteFn = (request) => {
      const payload = { messages: [...request.messages] };
      request.onPayload?.(payload);

      const messages = payload.messages as Array<{ role?: string; content?: unknown }>;
      const olderHistory = contentText(messages[2]?.content);
      const recentHistory = findMessageContent(messages, "## Chat History\n[@new]: volatile recent");
      expect(olderHistory).toContain("## Chat History — Older");
      expect(olderHistory).toContain("[@old]: cached chunk");
      expect(recentHistory).toContain("## Chat History\n[@new]: volatile recent");
      expect(recentHistory).not.toContain("[@old]: cached chunk");

      return Promise.resolve({
        text: "done",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        context: makeContext({
          sections: [
            { label: "Chat History — Older", text: "## Chat History — Older\n[@old]: cached chunk", cached: true, role: "system" },
            { label: "Chat History — Newer", text: "## Chat History\n[@new]: volatile recent", cached: false, role: "developer" },
          ],
        }),
      }),
    );
  });

  test("inserts custom transport content after older history", async () => {
    const transport = makePromptTransportConfig();
    transport.openrouter.sections.custom.content = "Use the new feature.";
    const completeChat: ChatCompleteFn = (request) => {
      const payload = { messages: [...request.messages] };
      request.onPayload?.(payload);

      const texts = (payload.messages as Array<{ content?: unknown }>).map((message) => contentText(message.content));
      const olderIndex = texts.findIndex((text) => text.includes("## Chat History — Older"));
      const customIndex = texts.findIndex((text) => text === "Use the new feature.");
      const recentIndex = texts.findIndex((text) => text.includes("## Chat History\n[@new]: volatile recent"));
      expect(olderIndex).toBeGreaterThanOrEqual(0);
      expect(customIndex).toBeGreaterThan(olderIndex);
      expect(recentIndex).toBeGreaterThan(customIndex);

      return Promise.resolve({
        text: "done",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        completeChat,
        guildConfig: makeGuildConfig({ promptTransport: transport }),
        context: makeContext({
          sections: [
            { label: "Chat History — Older", text: "## Chat History — Older\n[@old]: cached chunk", cached: true, role: "system" },
            { label: "Chat History — Newer", text: "## Chat History\n[@new]: volatile recent", cached: false, role: "developer" },
          ],
        }),
      }),
    );
  });

  test("orders volatile context for OpenRouter and OpenAI Codex", async () => {
    for (const globalConfig of [makeGlobalConfig(), makeCodexGlobal()]) {
      const completeChat: ChatCompleteFn = (request) => {
        const content = request.messages.map((message) => contentText(message.content));
        expect(content.filter((text) => text.endsWith(" marker"))).toEqual([
          "discord marker",
          "members marker",
          "channel threads marker",
          "schedule marker",
          "notebook marker",
          "inner marker",
          "relationship marker",
          "memory marker",
          "recent marker",
          "current marker",
        ]);
        return Promise.resolve({
          text: "done",
          toolCalls: [],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      };

      await handleMessage(
        makeMessage({ mentionedUserIds: ["bot-1"] }),
        makeDeps({
          completeChat,
          globalConfig,
          context: makeContext({
            sections: [
              { label: "Current Context", text: "current marker", cached: false, role: "developer" },
              { label: "Upcoming Schedules", text: "schedule marker", cached: false, role: "developer" },
              { label: "Server Members", text: "members marker", cached: false, role: "developer" },
              { label: "Notebooks", text: "notebook marker", cached: false, role: "developer" },
              { label: "Inner Threads", text: "inner marker", cached: false, role: "developer" },
              { label: "Relationships", text: "relationship marker", cached: false, role: "developer" },
              { label: "Discord Context", text: "discord marker", cached: false, role: "developer" },
              { label: "Memories", text: "memory marker", cached: false, role: "developer" },
              { label: "Threads In This Channel", text: "channel threads marker", cached: false, role: "developer" },
              { label: "Chat History — Newer", text: "recent marker", cached: false, role: "developer" },
            ],
          }),
        }),
      );
    }
  });

  test("uses a stable OpenRouter session id across native tool turns", async () => {
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "tool says 42" }], details: {} }),
    };
    const sessionIds: Array<string | undefined> = [];
    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      sessionIds.push(request.sessionId);
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
        text: "answer is 42",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer is 42" }] },
      });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        requestLog: new RequestLog("guild-1", "channel-1"),
      }),
    );

    expect(sessionIds).toEqual([
      "2b2v:guild-1:channel-1:openrouter:moonshotai/kimi-k2.5",
      "2b2v:guild-1:channel-1:openrouter:moonshotai/kimi-k2.5",
    ]);
  });

  test("uses a stable UUIDv7 Codex session id across turns", async () => {
    const sessionIds: Array<string | undefined> = [];
    const completeChat: ChatCompleteFn = (request) => {
      sessionIds.push(request.sessionId);
      return Promise.resolve({
        text: "ok",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "ok" }] },
      });
    };

    const deps = {
      completeChat,
      globalConfig: makeCodexGlobal(),
      requestLog: new RequestLog("1075346959298199564", "1080016551471743046"),
    };
    await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), makeDeps(deps));
    await handleMessage(makeMessage({ mentionedUserIds: ["bot-1"] }), makeDeps(deps));

    expect(sessionIds[0]).toBe(sessionIds[1]);
    expect(sessionIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

});
