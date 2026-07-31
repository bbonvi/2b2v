import { createLogger, RequestLog, type LogLevel, type Logger } from "../logger";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { requestLogStore } from "../dashboard/store";
import { parseDashboardPasswordlessCidrs } from "../dashboard/auth";
import { startDashboard } from "../dashboard/server";
import { loadGlobalConfig, loadGuildConfigs, resolveGuildConfig, validateTrimConfig, validateVpnConfig } from "../config/loader";
import type { GuildConfig } from "../config/types";
import { createDatabase } from "../db/database";
import { createDiscordClient, loginDiscordClient } from "../discord/client";
import { buildDiscordContext } from "../discord/context-renderer";
import { registerInteractionRuntime } from "../discord/interaction-runtime";
import { translateInbound, translateOutbound, buildDisplayNameContext, type InboundResolvers, type OutboundResolvers } from "../discord/translation";
import { splitMessage } from "../discord/split-message";
import { EmojiCache, buildEmojiContext, type EmojiEntry } from "../discord/emoji-cache";
import { guildEmojiEntries, registerEmojiCacheSync, syncGuildEmojiCache } from "../discord/emoji-cache-sync";
import { appendStickerTags, messageDisplayContent } from "../discord/message-media";
import { assetsFromDiscordMessage } from "../discord/message-assets";
import { botChannelPermissions, channelDisplayName, channelTypeLabel, createDiscordMessageSender, createTargetChannelResolver, createTypingController, fetchAccessibleGuildChannel as fetchAccessibleDiscordGuildChannel, isSendableGuildChannel, type SendableGuildChannel } from "../discord/message-sender";
import { createSchedulerEngine, type SchedulerEngine } from "../scheduler/engine";
import { createScheduledTaskRunner } from "../scheduler/scheduled-task-runtime";
import { handleMessage } from "../agent/handler";
import { runSilentMemoryAgentPass, runSilentToolAgentPass } from "../agent/maintenance-pass";
import { hasMaintenanceMaterial, type HandleResult, type AssetAttachmentResolver, type IncomingMessage, type HandlerDeps, type MemoryExtractionRequest, type MessageSender, type OutboundAttachment } from "../agent/turn-types";
import { trackWriteToolStarts } from "../agent/tool-access";
import {
  contentMentionsEveryone,
  shouldRespond,
  shouldRespondDeliberately,
  type TriggerInput,
  type TriggerResult,
} from "../agent/triggers";
import { typingSimulationDelayMs } from "../agent/typing-simulation";
import { createChannelDispatcher, DispatchSupersededError, selectDispatchMessageForTrigger, selectDispatchMessagesForTrigger, selectNormalDispatchTrigger, type ChannelDispatcher, type DispatchOutcome } from "../discord/channel-dispatcher";
import { assembleContext, type AssembledContext, type ThreadMetadata } from "../agent/context-assembly";
import { PRIVATE_HANDOFF_MESSAGE_ID_PREFIX, PRIVATE_THOUGHT_MESSAGE_ID_PREFIX, type HistoryMessage } from "../agent/history-types";
import { getLatestMessageActivityBefore, listDiscordChannelUsage, type MessageActivity } from "../db/message-activity-repository";
import { getContextHistoryMessages, getParentPreContext, listChannelMessages } from "../db/message-history-repository";
import { getMessageSearchMatchesByIds } from "../db/message-search-repository";
import { getRoutedMessageSource, insertPromptOnlyBotMessage, insertPromptOnlyMessageHandoff, insertSyntheticEvent, upsertBotMessageContent } from "../db/message-state-repository";
import { cleanupDeletedDiscordMessage } from "../db/message-cleanup";
import {
  countMessagesSinceMemoryExtraction,
  getMemoryExtractionCheckpoint,
  getMessagesSinceMemoryExtraction,
  markMemoryExtractionCheckpoint,
  markMemoryExtractionCheckpointAtMessage,
} from "../db/memory-extraction-repository";
import { processHistory } from "../agent/history-pipeline";
import { normalizeWhitespace, trimMessages } from "../agent/history-trimming";
import { formatHistoryContent, formatMessageLine, OLDER_LEGEND } from "../agent/history-formatting";
import { insertDateStamps } from "../agent/history-dates";
import { formatRelativeAgo } from "../agent/history-dates";
import { currentLocalContext, formatElapsedDuration } from "../time/agent-time";
import type { ReplyFallbackDeps } from "../agent/reply-target-fallback";

import { createElevenLabsClient, type ElevenLabsClient } from "../tts/client";
import type { TtsResult } from "../tts/types";
import { buildMemoryContext, buildMemoryMaintenanceContext, buildPrivateLifeMemoryContext, buildVisibleUserMemoryContext } from "../agent/memory-context";
import { createRecordMemoryTool } from "../agent/memory-extraction";
import { buildRepertoireContext } from "../agent/repertoire-context.ts";
import { createSearchChannelMessagesTool } from "../agent/search-channel-messages-tool";
import { createScheduleTools } from "../agent/schedule-tool";
import { createEventWatchTools } from "../agent/event-watch-tool.ts";
import { createChatUserListTool, type MemberInfo } from "../agent/member-list-tool";
import { createChannelListTool, type ChannelInfo } from "../agent/channel-list-tool";
import { createEmojiListTool } from "../agent/emoji-list-tool";
import { createDiscordTimeoutTools, type TimeoutMember, type TimeoutMemberResolution } from "../agent/timeout-user-tool";
import { createSearchMemoriesTool } from "../agent/search-memories-tool";
import { buildNotebooksContext, createNotebookTools } from "../agent/notebook-service.ts";
import { buildInnerThreadMaintenanceContext, buildInnerThreadsContext, createListInnerThreadsTool, createRecordInnerThreadsTool } from "../agent/inner-thread-service";
import { listInnerThreads } from "../db/inner-thread-repository";
import { createListChannelMessagesTool } from "../agent/list-channel-messages-tool";
import { createOwnMessageTools } from "../agent/own-message-tool";
import { createBraveImageSearchTool, createBraveSearchTool } from "../agent/brave-search-tool";
import { createReadAssetTool, extractPdfText, extractRemoteVideoFrame, type ReadAssetToolDeps } from "../agent/read-asset-tool";
import { createSearchAssetTool } from "../agent/search-asset-tool";
import { createReadUserAvatarTool, type AvatarSize } from "../agent/read-user-avatar-tool";
import { createFetchImagesTool } from "../agent/fetch-images-tool";
import { loadExternalImage } from "../agent/external-image";
import { createCodexGenerateImageTool, type GeneratedImageAttachment, type ReferenceImageInput } from "../agent/codex-image-tool";
import { AgentJobStore, createCancelAgentJobTool, isActiveJobStatus, type ImageGenerationJobResult } from "../agent/job-runtime";
import { createAgentJobInspectionTools, renderAgentJobDetails } from "../agent/agent-job-tool";
import { annotateHistoryJobs, buildAsyncImageReadyMetadata, createGeneratedImageRuntime, imageReferencesForToolInput, renderAgentJobsContext, renderImageGenerationInput, shortQuote, type GeneratedImageRuntime } from "../agent/generated-image-runtime";
import { createStoredAssetAttachmentResolver } from "../agent/stored-asset-attachments";
import { loadAssetReferenceImage, loadStagedAssetReferenceImage, resolvedLinkReferenceImage } from "../agent/asset-reference-image";
import { createFetchUrlTool } from "../agent/fetch-url-tool";
import { LinkContentCache, resolveLinkContent } from "../agent/link-content.ts";
import { createSummarizeVideoTool } from "../agent/summarize-video-tool";
import { createCloseThreadTool, createStartThreadTool } from "../agent/start-thread-tool";
import { createReactToMessageTool } from "../agent/react-to-message-tool";
import { createDiceRollTool, type DiceRollDelivery } from "../agent/dice-roll-tool";
import { applyRuntimeToolPrompts } from "../agent/runtime-tool-prompts";
import {
  isReadOnlyTool,
  isToolAllowedInMaintenance,
  type MaintenanceWriteToolName,
} from "../agent/tool-effects.ts";
import { createSearchToolsTool } from "../agent/tool-catalog.ts";
import {
  commitStagedMaintenanceCalls,
  SemanticMaintenanceCoordinator,
  stageMaintenanceTools,
  type StagedMaintenanceCall,
} from "../agent/semantic-maintenance-coordinator.ts";
import { createModelImageSupportStore } from "../llm/model-image-support";
import { resolveModelProfile } from "../llm/client";
import { createAmbientRuntime } from "../ambient/runtime";
import { createPrivateLifeRuntime } from "../private-life/runtime.ts";
import { createPrivateLifeSummaryTool } from "../private-life/summary-tool.ts";
import {
  PRIVATE_LIFE_ACTION_SCOPES,
  PRIVATE_LIFE_ATTENTION_ORIGINS,
  PRIVATE_LIFE_CURIOSITY_MODES,
  PRIVATE_LIFE_TERRITORIES,
} from "../private-life/types.ts";
import { clearExpiredPrivateLifeThoughts } from "../db/private-life-repository.ts";
import { createPersonaModeRuntime } from "../modes/runtime";
import type { PersonaModeActivityType } from "../modes/types";
import { cacheAssetExtraction, getAssetById, getAssetsByMessageId, syncMessageAssets } from "../db/asset-repository";
import {
  getEventWatch,
  listEventWatches,
  listPendingWatchMessageIds,
  markWatchMessageProcessed,
} from "../db/event-watch-repository.ts";
import { createWatchMatcher } from "../event-watch/matcher.ts";
import { createEventWatchRuntime, type EventWatchTurn } from "../event-watch/runtime.ts";
import { createUpdateCurrentEventWatchTool } from "../event-watch/current-watch-tool.ts";
import { DEFAULT_EVENT_WATCH_PRESSURE, type NormalizedWatchEvent } from "../event-watch/types.ts";
import {
  normalizeDiscordWatchMessage,
  registerEventWatchDiscordAdapters,
  type EventWatchDiscordAdapters,
} from "../event-watch/discord-adapters.ts";
import {
  createStagedAsset,
  deleteStagedAsset,
  getStagedAsset,
  getStagedAssetForJob,
  listStagedAssets,
  reconcileStagedAsset,
} from "../db/staged-asset-repository";
import { upsertThread, updateThreadActivity, markThreadArchived, listThreadsForContext, getThreadMetadata, getThread } from "../db/thread-repository";
import { prepareImageBufferForContext } from "../agent/image-buffer";
import { deleteExpiredMemories, countUserMemoriesByUser } from "../db/memory-repository";
import { createRelationshipsManagementApi } from "../dashboard/relationships-management";
import { createDashboardManagementRuntime, dashboardTriggerLocation } from "../dashboard/management-runtime";
import { createPromptLabRunner, promptLabDryRunTools, promptLabSummary, promptLabSyntheticId } from "../dashboard/prompt-lab-runtime";
import {
  buildPriorExchangesContext,
  createRecordRelationshipTool,
  getRelationshipProfile,
  hasRelationshipData,
  listRelationshipEvents,
  listRelationshipProfiles,
  renderNotableRelationshipsContext,
  renderRelationshipAxisValues,
  renderRelationshipMaintenanceContext,
  renderRelationshipPromptContext,
  selectRelationshipAnchorProfiles,
  type RelationshipContextProfile,
  type RelationshipConfig,
  type RelationshipMutationResult,
} from "../relationships";
import { listUpcomingForContext } from "../db/schedule-repository";
import { registerGuildSlashCommands, registerSlashCommands } from "../commands/registry";
import { statusCommandDefinition } from "../commands/status";
import { scheduleCommandDefinition } from "../commands/schedule";
import { memoryWipeCommandDefinition } from "../commands/memory-wipe";
import { vpnCommandDefinition } from "../commands/vpn";
import { voiceTestCommandDefinition } from "../commands/voice-test.ts";
import { createVpnClient, type VpnClient } from "../vpn/api-client";
import { createSessionStore, type SessionStore } from "../vpn/session";
import { loadInstructionBundle, type PromptBundle } from "../config/instruction-bundle";
import { inspectPromptScenario, type PromptScenarioId } from "../config/prompt-inspector";
import { requireProfileConfigPath } from "../config/profile";
import { renderPromptTemplate } from "../config/prompt-template";
import { resolveReactionEmojiInput } from "../discord/reaction-emoji";
import { createDiscordReplyFallbackDeps, createSyntheticReplyFallbackDeps, syncDeletedOwnBotMessage, syncEditedOwnBotMessage } from "../discord/reply-fallback-runtime";
import { createDiscordAssetSourceResolver } from "../discord/asset-resolver";
import { backfillMessageAssets } from "../discord/asset-backfill";
import { fetchMessagesAfterRestart } from "../discord/restart-catchup";
import { clearRestartRecoveryState, getRestartRecoveryState, listRecentDiscordChannels, setRestartRecoveryCutoff } from "../db/restart-recovery-repository";
import { AsyncTaskTracker } from "../runtime/async-task-tracker";
import { DEFAULT_ASSET_READING, DEFAULT_EXTERNAL_IMAGES } from "../config/defaults";
import { join } from "path";
import { mkdirSync, existsSync, readdirSync, statSync, watch, type FSWatcher } from "fs";
import { unlink } from "fs/promises";
import type { Database } from "../db/database";
import { ActivityType, ChannelType, PermissionFlagsBits, type Client, type Guild, type GuildBasedChannel, type GuildMember, type Message, type TextChannel, type ThreadChannel, type Typing } from "discord.js";
import { renderVoiceHistory, renderVoiceMoveHandoff } from "../voice/history.ts";
import { compactVoiceMaintenance, createVoiceSummaryTool } from "../voice/maintenance.ts";
import {
  VoiceRepository,
} from "../voice/repository.ts";
import { VoiceRuntime, type VoiceTurnRequest } from "../voice/runtime.ts";
import { createVoiceTools } from "../voice/tools.ts";


export function registerMessageEvents(input: {
    db: Database;
    client: Client;
    log: Logger;
    inboundMessageTasks: AsyncTaskTracker;
    backgroundTasks: AsyncTaskTracker;
    getGuildConfig: (guildId: string) => GuildConfig;
    buildInboundResolvers: (guild: Guild) => InboundResolvers;
    fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
    evaluateMessageTrigger: ReturnType<typeof import("./message-turn-runtime").createMessageTurnRuntime>["evaluateMessageTrigger"];
    normalizedWatchMessage: ReturnType<typeof import("./message-turn-runtime").createMessageTurnRuntime>["normalizedWatchMessage"];
    processSettledWatchedMessage: ReturnType<typeof import("./message-turn-runtime").createMessageTurnRuntime>["processSettledWatchedMessage"];
    processTriggeredMessage: ReturnType<typeof import("./message-turn-runtime").createMessageTurnRuntime>["processTriggeredMessage"];
    getOrCreateDispatcher: ReturnType<typeof import("./message-turn-runtime").createMessageTurnRuntime>["getOrCreateDispatcher"];
    maybeRunAmbientMemoryExtraction: ReturnType<typeof import("../agent/ambient-memory-runtime").createAmbientMemoryRuntime>["maybeRunAmbientMemoryExtraction"];
    ambientRuntime: ReturnType<typeof createAmbientRuntime>;
    eventWatchRuntime: ReturnType<typeof createEventWatchRuntime>;
  }
) {
  const { db, client, log, inboundMessageTasks, backgroundTasks, getGuildConfig, buildInboundResolvers, fetchAccessibleGuildChannel, evaluateMessageTrigger, normalizedWatchMessage, processSettledWatchedMessage, processTriggeredMessage, getOrCreateDispatcher, maybeRunAmbientMemoryExtraction, ambientRuntime, eventWatchRuntime } = input;
  let acceptingDiscordMessages = true;
  const startupMessageQueue: Message[] = [];
  let startupMessageProcessingReady = false;
  let startupMessageQueueDraining = false;
  const RESTART_CATCHUP_MAX_AGE_MS = 30 * 60_000;
  const RESTART_CATCHUP_MAX_CHANNELS = 50;
  const RESTART_CATCHUP_MAX_MESSAGES_PER_CHANNEL = 500;
  client.on("messageCreate", handleMessageCreateEvent);
function handleMessageCreateEvent(message: Message): void {
  if (!acceptingDiscordMessages) return;
  if (!startupMessageProcessingReady || startupMessageQueueDraining) {
    startupMessageQueue.push(message);
    return;
  }

  startInboundMessageTask(message);
}

function startInboundMessageTask(message: Message): void {
  void inboundMessageTasks.track(processDiscordMessageCreate(message));
}

function drainStartupMessageQueue(): void {
  if (startupMessageQueueDraining) return;
  startupMessageQueueDraining = true;
  const queued = startupMessageQueue.length;
  if (queued > 0) log.info("draining startup Discord message queue", { queued });
  try {
    while (startupMessageQueue.length > 0) {
      const message = startupMessageQueue.shift();
      if (message !== undefined) startInboundMessageTask(message);
    }
  } finally {
    startupMessageQueueDraining = false;
  }
}

/** Persist one live Discord message and report whether this process claimed it first. */
function persistInboundDiscordMessage(message: Message, rawContent: string, translatedContent: string): boolean {
  if (message.guild === null || message.guildId === null) return false;
  const guildId = message.guildId;
  const channelId = message.channelId;
  const messageCreatedAt = message.createdTimestamp;
  const now = Date.now();
  const inserted = db.raw
    .prepare(
      `INSERT OR IGNORE INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, webhook_id, created_at, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      message.id,
      guildId,
      channelId,
      message.author.id,
      message.author.username,
      rawContent,
      translatedContent,
      message.author.bot ? 1 : 0,
      message.webhookId,
      messageCreatedAt,
      message.reference?.messageId ?? null,
    );

  if (message.channel.isThread()) {
    const updated = updateThreadActivity(db, channelId, {
      lastActivityAt: messageCreatedAt,
      lastMessageId: message.id,
      archivedAt: message.channel.archived === true ? message.channel.archiveTimestamp : null,
    });
    if (!updated) {
      upsertThread(db, {
        threadId: channelId,
        guildId,
        parentChatId: message.channel.parentId ?? channelId,
        starterMessageId: channelId,
        threadName: message.channel.name,
        createdAt: message.channel.createdTimestamp ?? now,
        lastActivityAt: messageCreatedAt,
        lastMessageId: message.id,
        messageCount: message.channel.messageCount ?? 1,
        createdByBot: message.channel.ownerId === client.user?.id,
        archivedAt: message.channel.archived === true ? message.channel.archiveTimestamp : null,
      });
    }
  }

  syncMessageAssets(db, { messageId: message.id, assets: assetsFromDiscordMessage(message) });
  return inserted.changes > 0;
}

// --- 23. messageCreate handler ---
async function processDiscordMessageCreate(message: Message): Promise<void> {
  try {
    const authoredBySelf = message.author.id === client.user?.id;
    // Ignore DMs
    if (message.guild === null || message.guildId === null) return;

    const guild = message.guild;
    const guildId = message.guildId;
    const channelId = message.channelId;
    const guildConfig = getGuildConfig(guildId);
    // A delivered message consumes the user's previous typing indicator. Keep
    // ambient gates in sync with dispatcher typing, otherwise stale typing can
    // drop lingering/pickup/initiative candidates after the message arrived.
    ambientRuntime.clearAmbientTyping(guildId, channelId, message.author.id);

    // Build inbound resolvers and translate
    const inboundResolvers = buildInboundResolvers(guild);
    const displayContent = messageDisplayContent(message.content, message.components, message.author.username, message.embeds);
    const translatedContent = appendStickerTags(
      translateInbound(displayContent, inboundResolvers),
      message.stickers.values(),
    );
    const inserted = persistInboundDiscordMessage(message, displayContent, translatedContent);
    const pendingWatchEvaluation = db.raw.prepare(
      "SELECT 1 FROM event_watch_message_inbox WHERE message_id = ? AND state = 'pending'",
    ).get(message.id) !== null;
    if (!inserted && !pendingWatchEvaluation) return;

    const triggerResult = authoredBySelf ? null : evaluateMessageTrigger(message, guildConfig);
    const watchEvent = normalizedWatchMessage(message, translatedContent);
    const matchedWatchIds = await eventWatchRuntime.matchMessage(watchEvent);
    if (!authoredBySelf) ambientRuntime.maybeScheduleAmbientAttention(message, triggerResult);

    // Dispatch to handler: use channel dispatcher if enabled, otherwise call directly
    if (guildConfig.dispatcher.enabled) {
      getOrCreateDispatcher(guildId).enqueue(message, {
        authorId: message.author.id,
        triggerResult,
        matchedWatchIds,
      });
      if (!authoredBySelf && triggerResult === null && matchedWatchIds.length === 0) {
        void maybeRunAmbientMemoryExtraction(message, guildConfig);
      }
    } else {
      if (matchedWatchIds.length > 0) {
        await processSettledWatchedMessage(message, matchedWatchIds, triggerResult, [message]);
      } else if (!authoredBySelf && triggerResult === null) {
        void maybeRunAmbientMemoryExtraction(message, guildConfig);
      } else if (triggerResult !== null) {
        await processTriggeredMessage(message, triggerResult);
      }
    }
  } catch (err) {
    log.error("messageCreate handler error", {
      messageId: message.id,
      guildId: message.guildId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Recover deliberate triggers that arrived after coordinated shutdown stopped intake. */
async function recoverMessagesAfterRestart(): Promise<void> {
  const recovery = getRestartRecoveryState(db);
  if (recovery === null) return;

  const effectiveCutoffAt = Math.max(recovery.cutoffAt, Date.now() - RESTART_CATCHUP_MAX_AGE_MS);
  const channels = listRecentDiscordChannels(db, RESTART_CATCHUP_MAX_CHANNELS);
  let fetchedCount = 0;
  let claimedCount = 0;
  let triggerCount = 0;
  if (effectiveCutoffAt !== recovery.cutoffAt) {
    log.warn("restart catch-up cutoff was clamped", {
      storedCutoffAt: recovery.cutoffAt,
      effectiveCutoffAt,
      maxAgeMs: RESTART_CATCHUP_MAX_AGE_MS,
    });
  }

  for (const knownChannel of channels) {
    try {
      const channel = await fetchAccessibleGuildChannel(knownChannel.channelId);
      if (channel === null || channel.guildId !== knownChannel.guildId) continue;
      const fetched = await fetchMessagesAfterRestart<Message>({
        cutoffAt: effectiveCutoffAt,
        maxMessages: RESTART_CATCHUP_MAX_MESSAGES_PER_CHANNEL,
        fetchAfter: async (afterMessageId, limit) => {
          const page = await channel.messages.fetch({ after: afterMessageId, limit, cache: false });
          return [...page.values()];
        },
      });
      fetchedCount += fetched.fetched;
      if (fetched.capped) {
        log.warn("restart catch-up channel reached message cap", {
          guildId: knownChannel.guildId,
          channelId: knownChannel.channelId,
          maxMessages: RESTART_CATCHUP_MAX_MESSAGES_PER_CHANNEL,
        });
      }

      const recovered: Array<{ message: Message; triggerResult: TriggerResult; matchedWatchIds: string[] }> = [];
      for (const message of fetched.messages) {
        if (message.author.id === client.user?.id || message.guild === null || message.guildId === null) continue;
        const displayContent = messageDisplayContent(message.content, message.components, message.author.username, message.embeds);
        const translatedContent = appendStickerTags(
          translateInbound(displayContent, buildInboundResolvers(message.guild)),
          message.stickers.values(),
        );
        if (!persistInboundDiscordMessage(message, displayContent, translatedContent)) continue;
        claimedCount += 1;
        const guildConfig = getGuildConfig(message.guildId);
        const triggerResult = evaluateMessageTrigger(message, guildConfig, true);
        const matchedWatchIds = await eventWatchRuntime.matchMessage(normalizedWatchMessage(message, translatedContent));
        if (triggerResult !== null) triggerCount += 1;
        recovered.push({ message, triggerResult, matchedWatchIds });
      }

      if (!recovered.some((entry) => entry.triggerResult !== null || entry.matchedWatchIds.length > 0)) continue;
      const guildConfig = getGuildConfig(knownChannel.guildId);
      for (const entry of recovered) {
        if (entry.triggerResult !== null) {
          // Reuse only the normal-trigger guard; null recovered messages never seed ambient work.
          ambientRuntime.maybeScheduleAmbientAttention(entry.message, entry.triggerResult);
        }
        if (guildConfig.dispatcher.enabled) {
          getOrCreateDispatcher(knownChannel.guildId).enqueue(entry.message, {
            authorId: entry.message.author.id,
            triggerResult: entry.triggerResult,
            matchedWatchIds: entry.matchedWatchIds,
          });
        } else if (entry.matchedWatchIds.length > 0) {
          await processSettledWatchedMessage(entry.message, entry.matchedWatchIds, entry.triggerResult, [entry.message]);
        } else if (entry.triggerResult !== null) {
          await processTriggeredMessage(entry.message, entry.triggerResult);
        }
      }
    } catch (error) {
      log.warn("restart catch-up channel failed", {
        guildId: knownChannel.guildId,
        channelId: knownChannel.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  clearRestartRecoveryState(db);
  log.info("restart catch-up complete", {
    cutoffAt: effectiveCutoffAt,
    channels: channels.length,
    fetched: fetchedCount,
    claimed: claimedCount,
    triggers: triggerCount,
  });
}

/** Finish watch evaluation for messages committed before an interrupted live evaluation. */
async function recoverPendingWatchMessages(): Promise<void> {
  let recovered = 0;
  for (const messageId of listPendingWatchMessageIds(db)) {
    const row = db.raw.prepare(
      "SELECT guild_id, channel_id FROM messages WHERE id = ?",
    ).get(messageId) as { guild_id: string; channel_id: string } | null;
    if (row === null) continue;
    try {
      const channel = await fetchAccessibleGuildChannel(row.channel_id);
      if (channel === null || channel.guildId !== row.guild_id) {
        markWatchMessageProcessed(db, messageId);
        continue;
      }
      const message = await channel.messages.fetch(messageId);
      const displayContent = messageDisplayContent(message.content, message.components, message.author.username, message.embeds);
      const translatedContent = appendStickerTags(
        translateInbound(displayContent, buildInboundResolvers(message.guild)),
        message.stickers.values(),
      );
      const matchedWatchIds = await eventWatchRuntime.matchMessage(normalizedWatchMessage(message, translatedContent));
      if (matchedWatchIds.length > 0) {
        await processSettledWatchedMessage(message, matchedWatchIds, null, [message]);
      }
      recovered += 1;
    } catch (error) {
      log.warn("pending watch message recovery failed", {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (recovered > 0) log.info("pending watch messages recovered", { recovered });
}

client.on("messageUpdate", (_oldMessage, updatedMessage) => {
  if (!acceptingDiscordMessages) return;
  if (updatedMessage.guildId === null) return;
  const stored = db.raw.prepare("SELECT 1 AS present FROM messages WHERE id = ?").get(updatedMessage.id) as { present: number } | null;
  if (stored === null) return;
  const task = updatedMessage.fetch().then((message) => {
    syncMessageAssets(db, { messageId: message.id, assets: assetsFromDiscordMessage(message) });
  }).catch((error: unknown) => {
    log.warn("message asset update failed", { messageId: updatedMessage.id, error: error instanceof Error ? error.message : String(error) });
  });
  void backgroundTasks.track(task);
});

// --- 24. messageDelete handler ---
client.on("messageDelete", (message) => {
  if (!acceptingDiscordMessages) return;
  try {
    if (message.guildId === null) return;

    const messageId = message.id;
    const guildId = message.guildId;
    const result = cleanupDeletedDiscordMessage({ db, guildId, messageId });
    if (result.messagesDeleted === 0) return;

    log.debug("message deleted from Discord", { messageId, guildId });
  } catch (err) {
    log.error("messageDelete handler error", {
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

client.on("typingStart", (typing: Typing) => {
  if (!acceptingDiscordMessages) return;
  if (!typing.inGuild() || typing.user.bot) return;
  ambientRuntime.noteAmbientTyping(typing);
  if (!getGuildConfig(typing.guild.id).dispatcher.enabled) return;
  getOrCreateDispatcher(typing.guild.id).recordTyping(typing.channel.id, typing.user.id);
});

const eventWatchDiscordAdapters = registerEventWatchDiscordAdapters({
  client,
  db,
  runtime: eventWatchRuntime,
  log,
  isAcceptingEvents: () => acceptingDiscordMessages,
  trackTask: (task) => { void backgroundTasks.track(task); },
});

  return { eventWatchDiscordAdapters, recoverMessagesAfterRestart, recoverPendingWatchMessages, stop: () => { acceptingDiscordMessages = false; startupMessageProcessingReady = false; }, start: () => { startupMessageProcessingReady = true; drainStartupMessageQueue(); }, isAccepting: () => acceptingDiscordMessages };
}
