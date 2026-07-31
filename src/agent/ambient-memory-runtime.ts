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


export function createAmbientMemoryRuntime(input: {
    db: Database;
    client: Client;
    log: Logger;
    requestLogStore: typeof requestLogStore;
    getGlobalConfig: () => ReturnType<typeof loadGlobalConfig>;
    getPromptBundle: () => PromptBundle;
    runtimeToolDescription: (toolName: string) => string | undefined;
    resolveKnownUsername: (guild: Guild, username: string) => string | undefined;
    resolvePromptUsername: (guild: Guild, userId: string) => string | undefined;
  }
) {
  const { db, client, log, requestLogStore, getGlobalConfig, getPromptBundle, runtimeToolDescription, resolveKnownUsername, resolvePromptUsername } = input;
const semanticMaintenanceCoordinator = new SemanticMaintenanceCoordinator();
const ambientMemoryPasses = new Set<string>();
const MEMORY_MAINTENANCE_BATCH_SIZE = 12;

function collectHumanUserIds(messages: HistoryMessage[]): string[] {
  const recency = new Map<string, true>();
  for (const message of messages) {
    if (message.isBot) continue;
    recency.delete(message.authorId);
    recency.set(message.authorId, true);
  }
  return [...recency.keys()].reverse();
}

function formatAmbientMemoryHistory(messages: HistoryMessage[], timezone: string): string {
  const dateEntries = insertDateStamps(messages, timezone);
  const lines: string[] = [OLDER_LEGEND];
  for (const entry of dateEntries) {
    if (entry.type === "date") {
      lines.push(entry.text);
      continue;
    }
    const item = messages[entry.index];
    if (item === undefined) continue;
    lines.push(formatMessageLine({
      message: item,
      reply: null,
      includeMessageIds: true,
      includeDisplayNames: true,
    }));
  }
  return `## Ambient Chat History\n${lines.join("\n")}`;
}

async function maybeRunAmbientMemoryExtraction(message: Message, guildConfig: GuildConfig): Promise<void> {
  if (!guildConfig.memoryExtraction.ambient.enabled) return;
  if (message.guild === null || message.guildId === null) return;
  if (client.user === null) return;

  const guildId = message.guildId;
  const channelId = message.channelId;
  const key = `${guildId}:${channelId}`;
  if (ambientMemoryPasses.has(key)) return;

  const checkpoint = getMemoryExtractionCheckpoint(db, guildId, channelId);
  const now = Date.now();
  const minIntervalMs = guildConfig.memoryExtraction.ambient.minIntervalSeconds * 1000;
  if (checkpoint !== null && now - checkpoint.lastRunAt < minIntervalMs) return;

  const pendingCount = countMessagesSinceMemoryExtraction(db, {
    guildId,
    channelId,
    checkpoint,
  });
  if (pendingCount < guildConfig.memoryExtraction.ambient.everyMessages) return;

  const batch = getMessagesSinceMemoryExtraction(db, {
    guildId,
    channelId,
    checkpoint,
    limit: guildConfig.memoryExtraction.ambient.maxBatchMessages,
  });
  const lastMessage = batch[batch.length - 1];
  if (lastMessage === undefined) return;

  ambientMemoryPasses.add(key);
  try {
    const guild = message.guild;
    const memoryLog = new RequestLog(guildId, channelId, requestLogStore);
    memoryLog.setAuthor("ambient");
    memoryLog.setTriggerContext({
      ...dashboardTriggerLocation(guild, message.channel),
      messageId: message.id,
      authorUsername: message.author.username,
      content: message.content,
    });
    memoryLog.setTrigger({ type: "background_memory_extraction", mode: "ambient" });
    memoryLog.setAgentRan(true);
    requestLogStore.incrementActive();

    const visibleUserIds = collectHumanUserIds(batch);
    const visibleUserMemoryContext = buildVisibleUserMemoryContext({
      db,
      guildId,
      currentUserId: lastMessage.authorId,
      visibleUserIds,
      resolveUserId: (userId) => resolvePromptUsername(guild, userId),
      contextInstruction: getPromptBundle().runtime.contextTemplates["memory-other-visible-users"],
    });
    const currentUserMemories = buildMemoryContext({
      db,
      guildId,
      currentUserId: lastMessage.authorId,
      limit: guildConfig.memoryContext?.maxRows ?? 80,
      resolveUserId: (userId) => resolvePromptUsername(guild, userId),
      contextInstruction: getPromptBundle().runtime.contextTemplates.memory,
    });
    const maintenance = buildMemoryMaintenanceContext({
      db,
      guildId,
      afterId: checkpoint?.maintenanceCursorId ?? 0,
      limit: MEMORY_MAINTENANCE_BATCH_SIZE,
      resolveUserId: (userId) => client.users.cache.get(userId)?.username,
    });
    const context: AssembledContext = {
      sections: [
        ...(currentUserMemories !== ""
          ? [{ label: "Memories", role: "developer" as const, cached: false, text: `## Memory\n${currentUserMemories}` }]
          : []),
        ...(maintenance.text !== ""
          ? [{ label: "Memory Maintenance Candidates", role: "developer" as const, cached: false, text: maintenance.text }]
          : []),
        {
          label: "Chat History — Newer",
          role: "developer",
          cached: false,
          text: formatAmbientMemoryHistory(batch, guildConfig.timezone),
        },
      ],
      userMessage: "",
      contextMessageIds: batch.map((item) => item.id),
      visibleUserIds,
    };
    const createAmbientRecordMemoryTool = (dryRun: boolean): AgentTool => {
      const unprompted = createRecordMemoryTool({
        db,
        guildId,
        currentUserId: lastMessage.authorId,
        currentUsername: lastMessage.author,
        sourceMessageId: lastMessage.id,
        dryRun,
        recordMemoryDescription: runtimeToolDescription("record_memory"),
        resolveUsername: async (username) => {
          const cached = resolveKnownUsername(guild, username);
          if (cached !== undefined) return cached;
          try {
            await guild.members.fetch();
          } catch {
            // Cache-only fallback below handles missing permissions.
          }
          return resolveKnownUsername(guild, username);
        },
      });
      return applyRuntimeToolPrompts([unprompted], getPromptBundle().runtime)[0] ?? unprompted;
    };
    const validationTool = createAmbientRecordMemoryTool(true);
    const commitTool = createAmbientRecordMemoryTool(false);
    const stagedCalls: StagedMaintenanceCall[] = [];
    const stagedTool = stageMaintenanceTools(
      [validationTool],
      stagedCalls,
      new Set(["record_memory"]),
    )[0];
    if (stagedTool === undefined) throw new Error("Ambient memory staging tool is unavailable.");
    const ticket = semanticMaintenanceCoordinator.reserve();
    const incoming: IncomingMessage = {
      content: "",
      guildId,
      guildName: guild.name,
      channelId,
      channelName: channelDisplayName(message.channel),
      authorId: lastMessage.authorId,
      authorUsername: lastMessage.author,
      authorDisplayName: guild.members.cache.get(lastMessage.authorId)?.displayName,
      authorIsBot: false,
      botUserId: client.user.id,
      mentionedUserIds: [],
      mentionedRoleIds: [],
      botRoleIds: [],
      mentionedEveryone: false,
      translatedContent: "",
      messageId: lastMessage.id,
    };

    try {
      await runSilentMemoryAgentPass({
        globalConfig: getGlobalConfig(),
        guildConfig,
        context,
        systemPrompt: getPromptBundle().systemPrompt,
        personaPrompt: getPromptBundle().corePrompt,
        runtimePrompts: getPromptBundle().runtime,
        incomingMessage: incoming,
        userContent: "",
        assistantReply: "",
        visibleReplySent: false,
        passKind: "ambient",
        visibleUserMemoryContext,
        tools: [stagedTool],
        requestLog: memoryLog,
        log: log.child({ guildId, channelId, requestId: memoryLog.requestId }),
      });
      await ticket.commit(async () => {
        await commitStagedMaintenanceCalls({ calls: stagedCalls, tools: [commitTool] });
        markMemoryExtractionCheckpoint(db, {
          guildId,
          channelId,
          lastMessageId: lastMessage.id,
          lastMessageCreatedAt: lastMessage.timestamp,
          maintenanceCursorId: maintenance.nextCursorId,
        });
      });
    } catch (err) {
      ticket.skip();
      memoryLog.setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      memoryLog.emit(log);
      requestLogStore.decrementActive();
    }
  } catch (err) {
    log.warn("ambient memory extraction failed", {
      guildId,
      channelId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    ambientMemoryPasses.delete(key);
  }
}

function markMemoryExtractionCheckpointFromContext(input: {
  guildId: string;
  channelId: string;
  contextMessageIds: readonly string[] | undefined;
  fallbackMessageId?: string;
  maintenanceCursorId?: number;
}): boolean {
  const ids = [
    ...(input.contextMessageIds ?? []),
    ...(input.fallbackMessageId !== undefined ? [input.fallbackMessageId] : []),
  ];
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const id = ids[i];
    if (id === undefined) continue;
    if (markMemoryExtractionCheckpointAtMessage(db, {
      guildId: input.guildId,
      channelId: input.channelId,
      messageId: id,
      maintenanceCursorId: input.maintenanceCursorId,
    })) {
      return true;
    }
  }
  return false;
}

// --- 20. Build agent tools for a message context ---

  return { maybeRunAmbientMemoryExtraction, markMemoryExtractionCheckpointFromContext };
}
