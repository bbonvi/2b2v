import { afterEach, describe, expect, test } from "bun:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Client, Guild } from "discord.js";
import { createDatabase, type Database } from "../db/database.ts";
import { createStagedAsset } from "../db/staged-asset-repository.ts";
import { RequestLogStore } from "../dashboard/store.ts";
import type { SendableGuildChannel } from "../discord/message-sender.ts";
import type { PromptBundle } from "../config/instruction-bundle.ts";
import { createImageJobRuntime } from "./image-job-runtime.ts";
import { AgentJobStore } from "./job-runtime.ts";
import { makeContext, makeDeps, makeGlobalConfig, makeGuildConfig, TEST_RUNTIME_PROMPTS } from "./handler-test-support.ts";
import type { ChatCompleteFn, MessageSender } from "./turn-types.ts";

describe("image job runtime", () => {
  let db: Database | undefined;
  let logs: RequestLogStore | undefined;

  afterEach(() => {
    logs?.close();
    db?.close();
    logs = undefined;
    db = undefined;
  });

  test("lets a ready-image wake load the image skill and start another image", async () => {
    db = createDatabase(":memory:");
    logs = new RequestLogStore();
    const jobs = new AgentJobStore(db, {
      imageTimeoutMs: 300_000,
      imageCancelGraceMs: 60_000,
      terminalVisibleMs: 600_000,
      yieldedAutoDismissMs: 3_600_000,
      maxImageReplacements: 2,
    });
    const ready = jobs.enqueueImageJob({
      guildId: "guild-1",
      channelId: "channel-1",
      requesterId: "user-1",
      requesterUsername: "alice",
      sourceMessageId: "message-1",
      sourceQuote: "make another version",
      prompt: "first image",
      references: [],
      outputFormat: "png",
      is4k: false,
    }).job;
    jobs.start(ready.id);
    jobs.markReady(ready.id, {
      stagedAssetRef: "ready_image",
      workspacePath: "/tmp/ready-image.png",
      contentType: "image/png",
      byteSize: 100,
    });
    createStagedAsset(db, {
      ref: "ready_image",
      jobId: ready.id,
      ownerGuildId: "guild-1",
      ownerChannelId: "channel-1",
      filename: "ready-image.png",
      contentType: "image/png",
      storagePath: "/tmp/ready-image.png",
      createdAt: 1,
      expiresAt: 10_000,
    });

    let imageCalls = 0;
    const imageTool: AgentTool = {
      name: "codex_generate_image",
      label: "Image",
      description: "Generate an image.",
      parameters: Type.Object({ prompt: Type.String() }),
      execute: () => {
        imageCalls += 1;
        return Promise.resolve({
          content: [{ type: "text", text: "Started image job." }],
          details: { asyncJobCreated: true },
        });
      },
    };
    let modelCalls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      modelCalls += 1;
      if (modelCalls === 1) {
        expect(request.tools?.some((tool) => tool.function.name === "codex_generate_image")).toBe(false);
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "load-image-skill",
            type: "function",
            function: { name: "load_skill", arguments: '{"skill":"image_generation"}' },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      expect(request.tools?.some((tool) => tool.function.name === "codex_generate_image")).toBe(true);
      return Promise.resolve({
        text: "",
        toolCalls: [{
          id: "start-another-image",
          type: "function",
          function: { name: "codex_generate_image", arguments: '{"prompt":"second image"}' },
        }],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };
    const guildConfig = makeGuildConfig();
    const globalConfig = makeGlobalConfig();
    const promptBundle: PromptBundle = {
      systemDocuments: [],
      systemPrompt: "",
      coreDocuments: [],
      corePrompt: "",
      runtime: TEST_RUNTIME_PROMPTS,
      sources: { groups: {}, maps: {} },
    };
    const guild = { id: "guild-1", name: "Test Guild" } as Guild;
    const channel = {
      id: "channel-1",
      guildId: "guild-1",
      guild,
      name: "images",
      isThread: () => false,
      send: () => Promise.resolve(),
      sendTyping: () => Promise.resolve(),
      messages: { fetch: () => Promise.reject(new Error("not cached")) },
    } as unknown as SendableGuildChannel;
    const client = {
      user: { id: "bot-1", username: "2B" },
      guilds: { cache: new Map([["guild-1", guild]]) },
      channels: {
        cache: new Map([["channel-1", channel]]),
        fetch: () => Promise.resolve(channel),
      },
    } as unknown as Client;
    const sender: MessageSender = () => Promise.resolve({ sentMessageId: "sent-1" });
    let toolOptions: {
      includeImageGenerationTools?: boolean;
      currentRequest?: { requesterId: string; sourceMessageId: string };
    } | undefined;

    const runtime = createImageJobRuntime({
      db,
      client,
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        logTokenUsage: () => {},
        child() { return this; },
      },
      requestLogStore: logs,
      agentJobs: jobs,
      linkContentCache: {} as never,
      getGlobalConfig: () => globalConfig,
      getPromptBundle: () => promptBundle,
      getGuildConfig: () => guildConfig,
      runtimeContextTemplate: (_name, _variables, fallback) => fallback ?? "Ready image.",
      buildContext: () => Promise.resolve(makeContext({ userMessage: "Ready image.", visibleUserIds: ["user-1"] })),
      getBuildAgentTools: () => (_guildId, _channelId, _config, _guild, _excluded, _onImage, _request, options) => {
        toolOptions = options;
        return [imageTool];
      },
      blockToolsExcept: () => [],
      createPostReplyMaintenanceTools: () => [],
      runMemoryPostReplyExtraction: () => Promise.resolve({ enabled: false, ran: false }),
      runRelationshipPostReplyExtraction: () => Promise.resolve(),
      runInnerThreadPostReplyExtraction: () => Promise.resolve(),
      runPostReplyMaintenanceBurst: () => Promise.resolve(),
      createBotDiscordMessageSender: () => sender,
      createTtsGenerator: () => ({ ttsEnabled: false }),
      createHandlerDeps: (input) => makeDeps({
        globalConfig,
        guildConfig: input.guildConfig,
        context: input.context,
        currentChannelId: input.currentChannelId,
        sender: input.sender,
        extraTools: input.extraTools,
        initialToolNames: [],
        completeChat,
        ...input.overrides,
      }),
      createAssetAttachmentResolver: () => () => Promise.resolve([]),
      persistIgnoredBotReply: () => {},
      fetchAccessibleGuildChannel: () => Promise.resolve(channel),
      resolveGuildMemberReference: () => Promise.resolve(undefined),
      noteAmbientBotReply: () => {},
      enqueueChannelTask: async (_guildId, _channelId, task) => { await task(); },
      resumeAgentJob: () => {},
    });

    await runtime.runImageGenerationJob(ready.id);

    expect(toolOptions).toMatchObject({
      includeImageGenerationTools: true,
      currentRequest: { requesterId: "user-1", sourceMessageId: "message-1" },
    });
    expect(modelCalls).toBe(2);
    expect(imageCalls).toBe(1);
  });
});
