import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Client, Guild } from "discord.js";
import type { AssembledContext } from "../agent/context-assembly";
import { handleMessage, type HandlerDeps, type IncomingMessage, type MessageSender } from "../agent/handler";
import type { HistoryMessage } from "../agent/history-types";
import type { ReplyFallbackDeps } from "../agent/reply-target-fallback";
import { createCloseThreadTool, createStartThreadTool } from "../agent/start-thread-tool";
import { applyRuntimeToolPrompts } from "../agent/runtime-tool-prompts";
import { shortQuote } from "../agent/generated-image-runtime";
import type { GuildConfig } from "../config/types";
import type { PromptBundle } from "../config/instruction-bundle";
import type { Database } from "../db/database";
import { getThread } from "../db/thread-repository";
import { channelDisplayName, type SendableGuildChannel } from "../discord/message-sender";
import { translateInbound, type InboundResolvers } from "../discord/translation";
import { fetchedDiscordMessageToFallback } from "../discord/reply-fallback-runtime";
import { dashboardTriggerLocation } from "./management-runtime";
import { RequestLog, type Logger } from "../logger";
import {
  type PromptLabDraftMessage,
  type PromptLabDryRun,
  type PromptLabMemoryDryRun,
  type PromptLabRelationshipDryRun,
  type PromptLabRunResult,
} from "./prompt-lab-types";
import type { RelationshipConfig } from "../relationships";
import { getRelationshipProfile, renderRelationshipPromptContext } from "../relationships";
import type { RequestLogStore } from "./store";

const PROMPT_LAB_READ_TOOL_NAMES = new Set([
  "search_channel_messages",
  "list_scheduled_tasks",
  "list_chat_users",
  "list_channels",
  "list_emojis",
  "search_memories",
  "list_channel_messages",
  "read_user_avatar",
  "fetch_images",
  "fetch_url",
  "summarize_video",
  "web_search",
  "search_images",
  "load_skill",
]);

export function promptLabSyntheticId(offset = 0): string {
  const base = 15_000_000_000_000_000n;
  const span = 899_999_999_999_999n;
  const randomPart = BigInt(Math.floor(Math.random() * Number(span)));
  return (base + randomPart + BigInt(offset)).toString();
}

export function promptLabDryRunTools(tools: AgentTool[], dryRuns: PromptLabDryRun[]): AgentTool[] {
  return tools.map((tool) => {
    if (PROMPT_LAB_READ_TOOL_NAMES.has(tool.name)) return tool;
    return {
      ...tool,
      execute: (_toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> => {
        dryRuns.push({ tool: tool.name, args: params });
        return Promise.resolve({
          content: [{
            type: "text",
            text: `Prompt Lab dry-run: would execute \`${tool.name}\`, but dashboard test runs do not mutate Discord, SQLite, schedules, memories, jobs, or files.`,
          }],
          details: { dryRun: true, tool: tool.name, args: params },
        });
      },
    };
  });
}

export function promptLabSummary(entry: ReturnType<RequestLog["toEntry"]>): {
  toolCount: number;
  runtimeActionCount: number;
  llmCallCount: number;
  estimatedCostUsd: number | null;
  totalDurationMs: number;
} {
  const estimatedCostUsd = entry.llmCalls.reduce((sum, call) => sum + (call.estimatedCostUsd ?? 0), 0);
  return {
    toolCount: entry.tools.length,
    runtimeActionCount: entry.tools.filter((tool) => tool.modelRequestId === undefined).length,
    llmCallCount: entry.llmCalls.length,
    estimatedCostUsd: estimatedCostUsd > 0 ? estimatedCostUsd : null,
    totalDurationMs: entry.totalDurationMs,
  };
}

export function createPromptLabRunner(input: {
  client: Client;
  db: Database;
  getPromptBundle: () => PromptBundle;
  requestLogStore: RequestLogStore;
  log: Logger;
  getGuildConfig: (guildId: string) => GuildConfig;
  getRelationshipConfig: (guildConfig: GuildConfig) => RelationshipConfig;
  resolveClientGuild: (guildId: string) => Promise<Guild | null>;
  fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
  buildInboundResolvers: (guild: Guild) => InboundResolvers;
  buildContext: (guildId: string, channelId: string, guild: Guild, guildConfig: GuildConfig, userMessage: string, latestUserMessage: HistoryMessage, replyFallbackDeps: ReplyFallbackDeps, isThread: boolean, currentTurnBoundary?: { timestamp: number; messageId: string }, relationshipsMode?: "live" | "virtual") => Promise<AssembledContext>;
  buildAgentTools: (guildId: string, channelId: string, guildConfig: GuildConfig, guild: Guild, contextMessageIds: string[], onGeneratedImage: undefined, currentRequest: { requesterId: string; requesterUsername: string; sourceMessageId: string; sourceQuote: string }, options: Record<string, unknown>) => AgentTool[];
  blockToolsExcept: (tools: AgentTool[], allowedName: string, passLabel: string) => AgentTool[];
  createPostReplyMaintenanceTools: (input: {
    guild: Guild;
    guildConfig: GuildConfig;
    memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0];
    currentUserId: string;
    currentUsername?: string;
    sourceMessageId: string;
    dryRun?: boolean;
  }) => AgentTool[];
  createHandlerDeps: (input: {
    guildId: string;
    guildConfig: GuildConfig;
    context: AssembledContext;
    currentChannelId: string;
    sender: MessageSender;
    extraTools: AgentTool[];
    log: Logger;
    requestLog: RequestLog;
    resolveAssetAttachments?: HandlerDeps["resolveAssetAttachments"];
    modeLifecycle?: boolean;
    overrides?: Partial<HandlerDeps>;
  }) => HandlerDeps;
  runMemoryPostReplyExtraction: (input: {
    guildConfig: GuildConfig;
    guild: Guild;
    channel: unknown;
    sourceRequestId: string;
    source?: string;
    currentUserId: string;
    currentUsername?: string;
    dryRun?: boolean;
    dryRuns?: PromptLabDryRun[];
    memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0];
  }) => Promise<PromptLabMemoryDryRun>;
  runRelationshipPostReplyExtraction: (input: {
    guildConfig: GuildConfig;
    memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0];
    requestLog?: RequestLog;
    guild?: Guild;
    channel?: unknown;
    source?: string;
    sourceRequestId?: string;
    dryRun?: boolean;
    currentUserId: string;
    currentUsername?: string;
    onResult?: (result: { accepted: unknown[]; rejected: unknown[] }, candidates: unknown[]) => void;
  }) => Promise<void>;
  runInnerThreadPostReplyExtraction: (input: {
    guildConfig: GuildConfig;
    memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0];
    guild: Guild;
    channel: unknown;
    sourceRequestId: string;
    dryRun?: boolean;
  }) => Promise<void>;
  promptLabUserFromGuild: (guild: Guild, userId: string) => { id: string; username: string; displayName?: string; globalName?: string };
}): (runInput: { guildId: string; channelId: string; userId: string; content: string; runToken?: string }) => Promise<PromptLabRunResult> {
  function promptLabRelationshipContext(guildConfig: GuildConfig, userId: string): string | undefined {
    const config = input.getRelationshipConfig(guildConfig);
    if (!config.enabled || !config.promptInjection) return undefined;
    return renderRelationshipPromptContext({
      current: getRelationshipProfile(input.db, userId),
      currentLabel: userId,
      template: input.getPromptBundle().runtime.relationships.context,
    });
  }

  async function runPromptLabRelationshipExtractionDryRun(dryRunInput: {
    sourceRequestId: string;
    guild: Guild;
    channel: unknown;
    guildConfig: GuildConfig;
    context: AssembledContext;
    incomingMessage: IncomingMessage;
    userMessage: string;
    assistantReply: string;
    maintenanceTranscript?: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0]["maintenanceTranscript"];
    availableTools?: AgentTool[];
    promptContext?: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0]["promptContext"];
  }): Promise<PromptLabRelationshipDryRun | undefined> {
    const config = input.getRelationshipConfig(dryRunInput.guildConfig);
    if (!config.enabled || dryRunInput.assistantReply.trim() === "") return undefined;
    const channelId = dryRunInput.incomingMessage.channelId ?? "";
    const extractionLog = new RequestLog(dryRunInput.incomingMessage.guildId ?? "", channelId, input.requestLogStore);
    extractionLog.setAuthor(`prompt-lab:${dryRunInput.incomingMessage.authorUsername}`);
    extractionLog.setTrigger({ type: "relationships_extraction", sourceRequestId: dryRunInput.sourceRequestId, source: "prompt_lab", dryRun: true });
    extractionLog.setTriggerContext({
      ...dashboardTriggerLocation(dryRunInput.guild, dryRunInput.channel),
      messageId: dryRunInput.incomingMessage.messageId,
      authorUsername: dryRunInput.incomingMessage.authorUsername,
      content: dryRunInput.userMessage,
      translatedContent: dryRunInput.userMessage,
    });
    extractionLog.setAgentRan(true);
    input.requestLogStore.incrementActive();
    let signals: unknown[] = [];
    let accepted: unknown[] = [];
    let rejected: unknown[] = [];
    try {
      await input.runRelationshipPostReplyExtraction({
        guildConfig: dryRunInput.guildConfig,
        guild: dryRunInput.guild,
        channel: dryRunInput.channel,
        sourceRequestId: dryRunInput.sourceRequestId,
        source: "prompt_lab",
        dryRun: true,
        requestLog: extractionLog,
        currentUserId: dryRunInput.incomingMessage.authorId,
        currentUsername: dryRunInput.incomingMessage.authorUsername,
        memoryRequest: {
          sourceMessageId: dryRunInput.incomingMessage.messageId,
          userMessage: dryRunInput.userMessage,
          assistantReply: dryRunInput.assistantReply,
          recentContext: dryRunInput.context.sections.map((section) => section.text).join("\n\n"),
          context: dryRunInput.context,
          incomingMessage: dryRunInput.incomingMessage,
          visibleReplySent: true,
          maintenanceTranscript: dryRunInput.maintenanceTranscript,
          availableTools: dryRunInput.availableTools,
          promptContext: dryRunInput.promptContext,
        },
        onResult: (result, toolSignals) => {
          signals = toolSignals;
          accepted = result.accepted;
          rejected = result.rejected;
        },
      });
      return { requestId: extractionLog.requestId, signals, accepted, rejected };
    } finally {
      extractionLog.emit(input.log);
      input.requestLogStore.decrementActive();
    }
  }

  async function runPromptLabMemoryExtractionDryRun(dryRunInput: {
    sourceRequestId: string;
    guild: Guild;
    channel: unknown;
    guildConfig: GuildConfig;
    context: AssembledContext;
    incomingMessage: IncomingMessage;
    userMessage: string;
    assistantReply: string;
    dryRuns: PromptLabDryRun[];
    maintenanceTranscript?: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0]["maintenanceTranscript"];
    availableTools?: AgentTool[];
    promptContext?: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0]["promptContext"];
  }): Promise<PromptLabMemoryDryRun> {
    return await input.runMemoryPostReplyExtraction({
      guildConfig: dryRunInput.guildConfig,
      guild: dryRunInput.guild,
      channel: dryRunInput.channel,
      sourceRequestId: dryRunInput.sourceRequestId,
      source: "prompt_lab",
      currentUserId: dryRunInput.incomingMessage.authorId,
      currentUsername: dryRunInput.incomingMessage.authorUsername,
      dryRun: true,
      dryRuns: dryRunInput.dryRuns,
      memoryRequest: {
        sourceMessageId: dryRunInput.incomingMessage.messageId,
        userMessage: dryRunInput.userMessage,
        assistantReply: dryRunInput.assistantReply,
        recentContext: dryRunInput.context.sections.map((section) => section.text).join("\n\n"),
        context: dryRunInput.context,
        incomingMessage: dryRunInput.incomingMessage,
        visibleReplySent: true,
        maintenanceTranscript: dryRunInput.maintenanceTranscript,
        availableTools: dryRunInput.availableTools,
        promptContext: dryRunInput.promptContext,
      },
    });
  }

  return async (runInput) => {
    const guild = await input.resolveClientGuild(runInput.guildId);
    if (guild === null) throw new Error("Guild is unavailable.");
    const channel = await input.fetchAccessibleGuildChannel(runInput.channelId);
    if (channel === null || channel.guildId !== runInput.guildId) {
      throw new Error("Channel is unavailable or does not belong to the selected guild.");
    }
    const botUserId = input.client.user?.id ?? "";
    if (botUserId === "") throw new Error("Bot user is not ready.");

    const guildConfig = input.getGuildConfig(runInput.guildId);
    const labUser = input.promptLabUserFromGuild(guild, runInput.userId);
    const content = runInput.content.trim();
    const translatedContent = translateInbound(content, input.buildInboundResolvers(guild));
    const now = Date.now();
    const messageId = promptLabSyntheticId();
    const latestUserMessage: HistoryMessage = {
      id: messageId,
      author: labUser.username,
      authorDisplayName: labUser.displayName,
      authorId: labUser.id,
      content: translatedContent,
      isBot: false,
      timestamp: now,
      replyToId: null,
      hasEmbeds: false,
      isSynthetic: false,
      relatedThreadId: null,
    };

    const replyFallbackDeps: ReplyFallbackDeps = {
      db: input.db,
      guildId: runInput.guildId,
      channelId: runInput.channelId,
      fetchDiscordMessage: async (chId, msgId) => {
        const target = await input.fetchAccessibleGuildChannel(chId);
        if (target === null || !("messages" in target)) return null;
        try {
          return fetchedDiscordMessageToFallback(await target.messages.fetch(msgId));
        } catch {
          return null;
        }
      },
    };

    const context = await input.buildContext(
      runInput.guildId,
      runInput.channelId,
      guild,
      guildConfig,
      translatedContent,
      latestUserMessage,
      replyFallbackDeps,
      channel.isThread(),
      { timestamp: now, messageId },
      "virtual",
    );
    const baseTools = input.buildAgentTools(
      runInput.guildId,
      runInput.channelId,
      guildConfig,
      guild,
      context.contextMessageIds ?? [],
      undefined,
      {
        requesterId: labUser.id,
        requesterUsername: labUser.username,
        sourceMessageId: messageId,
        sourceQuote: shortQuote(translatedContent),
      },
      {},
    );
    const threadTools = applyRuntimeToolPrompts([
      createStartThreadTool({
        guildId: runInput.guildId,
        createThread: (name: string) => Promise.resolve({
          threadId: promptLabSyntheticId(1000),
          threadName: name,
          parentChannelId: runInput.channelId,
          starterMessageId: messageId,
        }),
        persistThread: () => {},
      }),
      createCloseThreadTool({
        currentGuildId: runInput.guildId,
        currentChannelId: runInput.channelId,
        currentIsThread: channel.isThread(),
        lookupThread: (threadId) => {
          const row = getThread(input.db, threadId);
          if (row === null) return null;
          return {
            threadId: row.threadId,
            guildId: row.guildId,
            threadName: row.threadName,
            parentChannelId: row.parentChatId,
            createdByBot: row.createdByBot,
          };
        },
        closeThread: (threadId) => Promise.resolve({
          threadId,
          threadName: threadId,
          parentChannelId: runInput.channelId,
        }),
        persistArchived: () => {},
      }),
    ], input.getPromptBundle().runtime);
    const dryRuns: PromptLabDryRun[] = [];
    const drafts: PromptLabDraftMessage[] = [];
    const requestLog = new RequestLog(runInput.guildId, runInput.channelId, input.requestLogStore);
    requestLog.setAuthor(`prompt-lab:${labUser.username}`);
    requestLog.setTrigger({
      type: "prompt_lab",
      mode: "mention",
      ...(runInput.runToken !== undefined ? { runToken: runInput.runToken } : {}),
    });
    requestLog.setTriggerContext({
      ...dashboardTriggerLocation(guild, channel),
      messageId,
      authorUsername: labUser.username,
      content,
    });
    requestLog.setAgentRan(true);
    input.requestLogStore.incrementActive();

    const sender: MessageSender = (text, reply, destinationChannelId, voice, _signal, replyToMessageId, attachments) => {
      const id = promptLabSyntheticId(drafts.length + 1);
      drafts.push({
        id,
        text,
        reply,
        ...(destinationChannelId !== undefined ? { channelId: destinationChannelId } : {}),
        ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
        attachments: attachments?.map((attachment) => attachment.filename) ?? [],
        voice: voice !== undefined,
      });
      return Promise.resolve({ sentMessageId: id });
    };
    const incomingMessage: IncomingMessage = {
      content,
      guildId: runInput.guildId,
      guildName: guild.name,
      channelId: runInput.channelId,
      channelName: channelDisplayName(channel),
      authorId: labUser.id,
      authorUsername: labUser.username,
      authorDisplayName: labUser.displayName,
      authorGlobalName: labUser.globalName,
      authorIsBot: false,
      botUserId,
      mentionedUserIds: [botUserId],
      translatedContent,
      messageId,
    };
    const visibleMaintenanceTools = input.blockToolsExcept(input.createPostReplyMaintenanceTools({
      guild,
      guildConfig,
      memoryRequest: {
        sourceMessageId: messageId,
        userMessage: translatedContent,
        assistantReply: "",
        recentContext: "",
        context,
        incomingMessage,
        visibleReplySent: false,
      },
      currentUserId: labUser.id,
      currentUsername: labUser.username,
      sourceMessageId: messageId,
      dryRun: true,
    }), "", "visible reply mode");
    const visibleTools = [...promptLabDryRunTools([...baseTools, ...threadTools], dryRuns), ...visibleMaintenanceTools];

    try {
      const result = await handleMessage(
        incomingMessage,
        input.createHandlerDeps({
          guildId: runInput.guildId,
          guildConfig,
          context,
          currentChannelId: runInput.channelId,
          sender,
          extraTools: visibleTools,
          log: input.log.child({ guildId: runInput.guildId, channelId: runInput.channelId, requestId: requestLog.requestId, component: "prompt-lab" }),
          requestLog,
          modeLifecycle: false,
          resolveAssetAttachments: () => Promise.resolve([]),
          overrides: {
            triggerOverride: { reason: "mention" },
            liveMessageTypingHoldMs: 0,
            consumeGeneratedAttachments: () => [],
          },
        }),
      );
      const assistantReply = (result.responseText ?? drafts.map((draft) => draft.text).join("\n\n")).trim();
      const maintenanceVisibleTools = result.availableTools ?? visibleTools;
      const memoryExtraction = await runPromptLabMemoryExtractionDryRun({
        sourceRequestId: requestLog.requestId,
        guild,
        channel,
        guildConfig,
        context,
        incomingMessage,
        userMessage: translatedContent,
        assistantReply,
        dryRuns,
        maintenanceTranscript: result.maintenanceTranscript,
        availableTools: maintenanceVisibleTools,
        promptContext: result.promptContext,
      });
      const relationshipsExtraction = await runPromptLabRelationshipExtractionDryRun({
        sourceRequestId: requestLog.requestId,
        guild,
        channel,
        guildConfig,
        context,
        incomingMessage,
        userMessage: translatedContent,
        assistantReply,
        maintenanceTranscript: result.maintenanceTranscript,
        availableTools: maintenanceVisibleTools,
        promptContext: result.promptContext,
      });
      await input.runInnerThreadPostReplyExtraction({
        guildConfig,
        guild,
        channel,
        sourceRequestId: requestLog.requestId,
        dryRun: true,
        memoryRequest: {
          sourceMessageId: incomingMessage.messageId,
          userMessage: translatedContent,
          assistantReply,
          recentContext: context.sections.map((section) => section.text).join("\n\n"),
          context,
          incomingMessage,
          visibleReplySent: true,
          maintenanceTranscript: result.maintenanceTranscript,
          availableTools: maintenanceVisibleTools,
          promptContext: result.promptContext,
        },
      });
      const relationshipsContext = promptLabRelationshipContext(guildConfig, labUser.id);
      const summary = promptLabSummary(requestLog.toEntry());
      return {
        requestId: requestLog.requestId,
        triggered: result.triggered,
        ...(result.responseText !== undefined ? { responseText: result.responseText } : {}),
        drafts,
        dryRuns,
        ...(relationshipsContext !== undefined ? { relationshipsContext } : {}),
        ...(relationshipsExtraction !== undefined ? { relationshipsExtraction } : {}),
        memoryExtraction,
        ...summary,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      requestLog.setError(error);
      return {
        requestId: requestLog.requestId,
        triggered: true,
        drafts,
        dryRuns,
        ...promptLabSummary(requestLog.toEntry()),
        error,
      };
    } finally {
      requestLog.emit(input.log);
      input.requestLogStore.decrementActive();
    }
  };
}
