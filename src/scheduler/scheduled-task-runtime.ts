import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Client, Guild, TextChannel } from "discord.js";
import type { AssembledContext } from "../agent/context-assembly";
import { createGeneratedImageRuntime, type GeneratedImageRuntime, shortQuote } from "../agent/generated-image-runtime";
import type { HandleResult, HandlerDeps, ImageAttachmentResolver, IncomingMessage, MessageSender } from "../agent/handler";
import { createStoredImageAttachmentResolver } from "../agent/stored-image-attachments";
import type { HistoryMessage } from "../agent/history-types";
import type { GuildConfig } from "../config/types";
import type { Database } from "../db/database";
import { channelDisplayName, createTargetChannelResolver, createTypingController, type ResolveTargetChannel, type SendableGuildChannel } from "../discord/message-sender";
import type { ReplyFallbackDeps } from "../agent/reply-target-fallback";
import type { RequestLogStore } from "../dashboard/store";
import { dashboardTriggerLocation } from "../dashboard/management-runtime";
import { RequestLog, type Logger } from "../logger";
import type { ScheduleFireEvent } from "./engine";
import type { TtsResult } from "../tts/types";
import { createUpdateCurrentScheduledTaskTool } from "./current-task-tool";

type TtsGenerator = {
  ttsEnabled: boolean;
  generateSpeech?: (text: string) => Promise<TtsResult>;
};

type VisibleMaintenanceInput = {
  guild: Guild;
  guildConfig: GuildConfig;
  memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0];
  currentUserId: string;
  currentUsername?: string;
  sourceMessageId: string;
};

function scheduledTaskInstruction(event: ScheduleFireEvent): string {
  const { schedule } = event;
  return [
    "## Scheduled Task Execution",
    "Run this private scheduled task now. Default to silence when there is nothing useful to say.",
    "Do not report misses like \"nothing yet\" unless the task explicitly asks for visible repeated updates.",
    "If stopping a user-visible recurring task, close the loop naturally without mentioning schedules, task IDs, cron, or tooling.",
    "Use update_current_scheduled_task when recurring state should carry forward or this recurring task should stop.",
    "The handoff note must be the full current handoff for next run, not just a delta; preserve prior context that still matters.",
    event.isFinalRun ? "This is the final recurring run because a ceiling is reached; complete any final check and close the loop if useful." : "",
    "",
    `Requester: ${schedule.createdByUsername ?? "unknown"}${schedule.createdByUserId !== null ? ` (${schedule.createdByUserId})` : ""}.`,
    `Fire count including this run: ${schedule.fireCount}.`,
    `Previous handoff note: ${schedule.handoffNote.trim() !== "" ? schedule.handoffNote.trim() : "(none)"}`,
    "",
    `Task instructions: ${schedule.messageContent}`,
  ].filter((line) => line !== "").join("\n");
}

export function createScheduledTaskRunner(input: {
  client: Client;
  db: Database;
  requestLogStore: RequestLogStore;
  log: Logger;
  getGuildConfig: (guildId: string) => GuildConfig;
  createSyntheticReplyFallbackDeps: (input: { db: Database; guildId: string; channelId: string }) => ReplyFallbackDeps;
  buildContext: (guildId: string, channelId: string, guild: Guild, guildConfig: GuildConfig, userMessage: string, latestUserMessage: HistoryMessage, replyFallbackDeps: ReplyFallbackDeps, isThread: boolean) => Promise<AssembledContext>;
  buildAgentTools: (guildId: string, channelId: string, guildConfig: GuildConfig, guild: Guild, contextMessageIds: string[], onGeneratedImage?: (attachment: Parameters<GeneratedImageRuntime["onGeneratedImage"]>[0]) => void, currentRequest?: { requesterId: string; requesterUsername: string; sourceMessageId: string; sourceQuote: string }) => AgentTool[];
  createVisibleMaintenanceTools: (input: VisibleMaintenanceInput) => AgentTool[];
  createBotDiscordMessageSender: (input: {
    defaultChannel: SendableGuildChannel;
    resolveTargetChannel: ResolveTargetChannel;
    botUserId: string;
    botUsername: string;
    logger: Logger;
    getLastTypingAt?: () => number;
    getAttachmentsDir: (targetGuildId: string) => string;
  }) => MessageSender;
  createTtsGenerator: (guildConfig: GuildConfig) => TtsGenerator;
  createHandlerDeps: (input: {
    guildConfig: GuildConfig;
    context: AssembledContext;
    currentChannelId: string;
    sender: MessageSender;
    extraTools: AgentTool[];
    log: Logger;
    requestLog: RequestLog;
    tts?: TtsGenerator;
    generatedImages?: GeneratedImageRuntime;
    resolveImageAttachments?: ImageAttachmentResolver;
    overrides?: Partial<HandlerDeps>;
  }) => HandlerDeps;
  runLoggedAgentTurn: (input: { incoming: IncomingMessage; deps: HandlerDeps; requestLog: RequestLog; logger: Logger; afterSuccess?: (result: HandleResult) => void | Promise<void>; onFinally?: (result: HandleResult | undefined) => void }) => Promise<HandleResult>;
  runMemoryPostReplyExtraction: (input: { guildConfig: GuildConfig; memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0]; guild: Guild; channel: unknown; sourceRequestId: string; source?: string; currentUserId: string; currentUsername?: string }) => Promise<unknown>;
  runRelationshipPostReplyExtraction: (input: { guildConfig: GuildConfig; memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0]; guild?: Guild; channel?: unknown; source?: string; sourceRequestId?: string; currentUserId: string; currentUsername?: string }) => Promise<void>;
  onScheduleCompleted?: (scheduleId: string) => void;
  markScheduledAttentionBusy?: (guildId: string, channelId: string) => () => void;
}): (event: ScheduleFireEvent) => Promise<void> {
  return async (event) => {
    const { schedule } = event;
    const scheduleLog = input.log.child({ component: "scheduler", scheduleId: schedule.id });
    scheduleLog.info("schedule fired", { guildId: schedule.guildId, channelId: schedule.channelId });

    try {
      const guild = input.client.guilds.cache.get(schedule.guildId);
      if (guild === undefined) {
        scheduleLog.warn("guild not found, skipping scheduled task");
        return;
      }

      const channel = guild.channels.cache.get(schedule.channelId);
      if (channel === undefined || !("send" in channel)) {
        scheduleLog.warn("channel not found or not sendable, skipping scheduled task");
        return;
      }

      const textChannel = channel as TextChannel;
      const guildId = schedule.guildId;
      const channelId = schedule.channelId;
      const releaseScheduledAttention = input.markScheduledAttentionBusy?.(guildId, channelId);
      try {
      const guildConfig = input.getGuildConfig(guildId);
      const botUserId = input.client.user?.id ?? "";
      const botUsername = input.client.user?.username ?? "bot";
      const resolveTargetChannel = createTargetChannelResolver(input.client, textChannel);
      const typing = createTypingController({ defaultChannel: textChannel, resolveTargetChannel });
      const sender = input.createBotDiscordMessageSender({
        defaultChannel: textChannel,
        resolveTargetChannel,
        botUserId,
        botUsername,
        logger: scheduleLog,
        getLastTypingAt: typing.getLastTypingAt,
        getAttachmentsDir: (targetGuildId) => input.getGuildConfig(targetGuildId).attachmentsDir,
      });

      const now = Date.now();
      const syntheticLatestMessage: HistoryMessage = {
        id: `scheduled-${schedule.id}-${now}`,
        author: "scheduler",
        authorId: "scheduler",
        content: schedule.messageContent,
        isBot: false,
        timestamp: now,
        replyToId: null,
        imageIds: [],
        captions: [],
        hasEmbeds: false,
        isSynthetic: true,
        relatedThreadId: null,
      };
      const replyFallbackDeps = input.createSyntheticReplyFallbackDeps({
        db: input.db,
        guildId,
        channelId,
      });
      const scheduledInstruction = scheduledTaskInstruction(event);
      const context = await input.buildContext(
        guildId,
        channelId,
        guild,
        guildConfig,
        scheduledInstruction,
        syntheticLatestMessage,
        replyFallbackDeps,
        textChannel.isThread(),
      );

      const generatedImages = createGeneratedImageRuntime();
      const extraTools = input.buildAgentTools(
        guildId,
        channelId,
        guildConfig,
        guild,
        context.contextMessageIds ?? [],
        generatedImages.onGeneratedImage,
        {
          requesterId: "scheduler",
          requesterUsername: "scheduler",
          sourceMessageId: syntheticLatestMessage.id,
          sourceQuote: shortQuote(schedule.messageContent),
        },
      );
      const updateCurrentTaskTool = createUpdateCurrentScheduledTaskTool({
        db: input.db,
        scheduleId: schedule.id,
        onCompleted: input.onScheduleCompleted,
      });
      const incoming: IncomingMessage = {
        content: schedule.messageContent,
        guildId,
        guildName: guild.name,
        channelId,
        channelName: channelDisplayName(textChannel),
        authorId: "scheduler",
        authorUsername: "scheduler",
        botUserId,
        mentionedUserIds: [],
        translatedContent: schedule.messageContent,
        messageId: syntheticLatestMessage.id,
        replyToMessageId: syntheticLatestMessage.replyToId ?? undefined,
      };
      const visibleMaintenanceTools = input.createVisibleMaintenanceTools({
        guild,
        guildConfig,
        memoryRequest: {
          sourceMessageId: syntheticLatestMessage.id,
          userMessage: schedule.messageContent,
          assistantReply: "",
          recentContext: "",
          context,
          incomingMessage: incoming,
          visibleReplySent: false,
        },
        currentUserId: "scheduler",
        currentUsername: "scheduler",
        sourceMessageId: syntheticLatestMessage.id,
      });
      const requestLog = new RequestLog(guildId, channelId, input.requestLogStore);
      requestLog.setAuthor("scheduler");
      requestLog.setTriggerContext({
        ...dashboardTriggerLocation(guild, textChannel),
        messageId: syntheticLatestMessage.id,
        authorUsername: "scheduler",
        content: schedule.messageContent,
        translatedContent: schedule.messageContent,
      });

      const deps = input.createHandlerDeps({
        guildConfig,
        context,
        currentChannelId: channelId,
        sender,
        extraTools: [...extraTools, updateCurrentTaskTool, ...visibleMaintenanceTools],
        log: scheduleLog,
        requestLog,
        tts: input.createTtsGenerator(guildConfig),
        generatedImages,
        resolveImageAttachments: createStoredImageAttachmentResolver({
          db: input.db,
          guildId,
          logger: scheduleLog.child({ component: "stored-image-attachments", guildId, channelId }),
        }),
        overrides: {
          onStillWorking: (destinationChannelId) => { typing.startLoop(destinationChannelId); },
          getTypingStartedAt: typing.getTypingStartedAt,
          onVisibleOutput: typing.stopLoop,
          onAgentEnd: typing.stopLoop,
          forceTrigger: true,
          triggerInstructions: guildConfig.triggerInstructions,
          disableLiveOutput: true,
          scheduledTaskRun: true,
          afterReply: async (memoryRequest) => {
            await input.runMemoryPostReplyExtraction({
              guildConfig,
              memoryRequest,
              guild,
              channel: textChannel,
              sourceRequestId: requestLog.requestId,
              source: "scheduled",
              currentUserId: "scheduler",
              currentUsername: "scheduler",
            });
            await input.runRelationshipPostReplyExtraction({
              guildConfig,
              memoryRequest,
              guild,
              channel: textChannel,
              sourceRequestId: requestLog.requestId,
              source: "scheduled",
              currentUserId: "scheduler",
              currentUsername: "scheduler",
            });
          },
        },
      });

      const result = await input.runLoggedAgentTurn({
        incoming,
        deps,
        requestLog,
        logger: input.log,
        onFinally: typing.stopLoop,
      });
      scheduleLog.info("scheduled task completed", { agentRan: result.agentRan });
      } finally {
        releaseScheduledAttention?.();
      }
    } catch (err: unknown) {
      input.log.error("scheduled task failed", {
        scheduleId: schedule.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
