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


export function createTurnRuntime(input: {
  db: Database;
  client: Client;
  log: Logger;
  agentJobs: AgentJobStore;
  linkContentCache: LinkContentCache;
  backgroundTasks: AsyncTaskTracker;
  modelImageSupport: ReturnType<typeof createModelImageSupportStore>;
  ttsClient?: ElevenLabsClient;
  getGlobalConfig: () => ReturnType<typeof loadGlobalConfig>;
  getPromptBundle: () => PromptBundle;
  buildOutboundResolvers: (guild: Guild) => OutboundResolvers;
  fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
  noteVisiblePersonaTurn: (guildId: string) => void;
}) {
  const { db, client, log, agentJobs, linkContentCache, backgroundTasks, modelImageSupport, ttsClient, getGlobalConfig, getPromptBundle, buildOutboundResolvers, fetchAccessibleGuildChannel, noteVisiblePersonaTurn } = input;
function persistIgnoredBotReply(input: {
  guildId: string;
  channelId: string;
  destinationChannelId?: string;
  botUserId: string;
  botUsername: string;
  sourceMessageId: string;
  historyText: string;
}): void {
  insertPromptOnlyBotMessage(db, {
    id: `prompt-only:ignore:${input.sourceMessageId}`,
    guildId: input.guildId,
    channelId: input.destinationChannelId ?? input.channelId,
    botUserId: input.botUserId,
    botUsername: input.botUsername,
    content: input.historyText,
    replyToId: input.sourceMessageId,
  });
}

function persistPrivateThoughts(input: {
  guildId: string;
  channelId: string;
  botUserId: string;
  botUsername: string;
  sourceMessageId: string;
  requestId: string;
  thoughts: string[];
  maxChars: number;
}): void {
  const text = input.thoughts
    .map(normalizeWhitespace)
    .filter((thought) => thought !== "")
    .join("\n\n");
  if (text === "") return;
  const content = text.length > input.maxChars
    ? `${text.slice(0, input.maxChars)}…`
    : text;
  insertPromptOnlyBotMessage(db, {
    id: `${PRIVATE_THOUGHT_MESSAGE_ID_PREFIX}${input.requestId}`,
    guildId: input.guildId,
    channelId: input.channelId,
    botUserId: input.botUserId,
    botUsername: input.botUsername,
    content: `<thoughts>${content}</thoughts>`,
    replyToId: input.sourceMessageId,
  });
}

function createBotDiscordMessageSender(
  input: Omit<Parameters<typeof createDiscordMessageSender>[0], "db" | "buildOutboundResolvers">,
): MessageSender {
  const callerOnDelivered = input.onDelivered;
  return createDiscordMessageSender({
    db,
    buildOutboundResolvers,
    ...input,
    onDelivered: async (delivery) => {
      await callerOnDelivered?.(delivery);
      for (const attachment of delivery.attachments) {
        if (!attachment.id.startsWith("staged-")) continue;
        const ref = attachment.id.slice("staged-".length);
        const staged = getStagedAsset(db, ref);
        if (staged === null || staged.deliveredMessageId !== undefined) continue;
        const permanent = getAssetsByMessageId(db, delivery.messageId)
          .find((asset) => asset.filename === staged.filename);
        const reconciled = reconcileStagedAsset(db, {
          ref,
          deliveredMessageId: delivery.messageId,
          ...(permanent !== undefined ? { permanentAssetId: permanent.id } : {}),
        });
        if (!reconciled) continue;
        if (permanent !== undefined) agentJobs.linkAsset(staged.jobId, permanent.id);
        const job = agentJobs.get(staged.jobId);
        if (job?.status === "ready") {
          agentJobs.markDelivered(staged.jobId, delivery.messageId, {
            ...(job.result ?? {}),
            stagedAssetRef: ref,
          });
        }
        await unlink(staged.storagePath).catch((error: unknown) => {
          log.warn("delivered staged asset cleanup failed", {
            ref,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    },
  });
}

async function resolveClientGuild(guildId: string): Promise<Guild | null> {
  const cached = client.guilds.cache.get(guildId);
  if (cached !== undefined) return cached;
  return await client.guilds.fetch(guildId).catch(() => null);
}

async function fetchAccessibleGuildChannel(channelId: string): Promise<SendableGuildChannel | null> {
  return await fetchAccessibleDiscordGuildChannel(client, channelId);
}

function createTtsGenerator(guildConfig: GuildConfig): {
  ttsEnabled: boolean;
  generateSpeech?: (text: string) => Promise<TtsResult>;
} {
  const ttsEnabled = ttsClient !== undefined && guildConfig.tts?.enabled === true;
  if (!ttsEnabled || ttsClient === undefined || guildConfig.tts === undefined) {
    return { ttsEnabled };
  }
  const client = ttsClient;
  return {
    ttsEnabled,
    generateSpeech: async (text: string): Promise<TtsResult> => {
      const preset = guildConfig.tts?.voices.normal;
      if (preset === undefined) {
        return { ok: false, error: "Normal voice is not configured" };
      }
      return client.generate({
        text,
        voiceId: preset.voiceId,
        model: preset.model,
        seed: preset.seed,
        applyTextNormalization: preset.applyTextNormalization,
        outputFormat: preset.outputFormat,
        languageCode: preset.languageCode,
        voiceSettings: {
          stability: preset.stability,
          similarityBoost: preset.similarityBoost,
          speed: preset.speed,
          style: preset.style,
          useSpeakerBoost: preset.useSpeakerBoost,
        },
      });
    },
  };
}

function createHandlerDeps(input: {
  guildId: string;
  guildConfig: GuildConfig;
  context: AssembledContext;
  currentChannelId: string;
  sender: MessageSender;
  extraTools: AgentTool[];
  log: Logger;
  requestLog: RequestLog;
  tts?: {
    ttsEnabled: boolean;
    generateSpeech?: (text: string) => Promise<TtsResult>;
  };
  generatedImages?: GeneratedImageRuntime;
  resolveAssetAttachments?: AssetAttachmentResolver;
  modeLifecycle?: boolean;
  overrides?: Partial<HandlerDeps>;
}): HandlerDeps {
  let visibleModeOutput = false;
  const onVisibleOutput = input.overrides?.onVisibleOutput;
  const onAgentEnd = input.overrides?.onAgentEnd;
  return {
    globalConfig: getGlobalConfig(),
    guildConfig: input.guildConfig,
    context: input.context,
    currentChannelId: input.currentChannelId,
    systemPrompt: getPromptBundle().systemPrompt,
    personaPrompt: getPromptBundle().corePrompt,
    runtimePrompts: getPromptBundle().runtime,
    sender: input.sender,
    extraTools: input.extraTools,
    log: input.log,
    requestLog: input.requestLog,
    modelImageInputSupport: modelImageSupport.get(
      getGlobalConfig(),
      input.overrides?.modelProfile ?? input.guildConfig.modelProfile,
    ),
    ...(input.tts ?? {}),
    ...(input.generatedImages !== undefined
      ? { consumeGeneratedAttachments: input.generatedImages.consumeGeneratedAttachments }
      : {}),
    ...(input.resolveAssetAttachments !== undefined ? { resolveAssetAttachments: input.resolveAssetAttachments } : {}),
    trackBackgroundTask: (task) => {
      void backgroundTasks.track(task);
    },
    ...input.overrides,
    onVisibleOutput: () => {
      onVisibleOutput?.();
      visibleModeOutput = true;
    },
    onAgentEnd: () => {
      onAgentEnd?.();
      if (input.modeLifecycle === false || !visibleModeOutput) return;
      noteVisiblePersonaTurn(input.guildId);
    },
  };
}

function createAssetAttachmentResolver(guildId: string, guildConfig: GuildConfig, logger: Logger): AssetAttachmentResolver {
  const resolveSource = createDiscordAssetSourceResolver({
    fetchMessage: async (channelId, messageId) => {
      const channel = await fetchAccessibleGuildChannel(channelId);
      if (channel === null || !("messages" in channel)) return null;
      try {
        return await (channel as TextChannel | ThreadChannel).messages.fetch(messageId);
      } catch {
        return null;
      }
    },
  });
  return createStoredAssetAttachmentResolver({
    db,
    stagedGuildId: guildId,
    maxDownloadBytes: guildConfig.assetReading?.maxDownloadBytes ?? DEFAULT_ASSET_READING.maxDownloadBytes,
    resolveSource,
    resolveLink: async (input, signal) => await resolveLinkContent({
      cache: linkContentCache,
      externalImages: getGlobalConfig().externalImages ?? DEFAULT_EXTERNAL_IMAGES,
    }, input, signal),
    canSendSticker: async (stickerId) => {
      const guild = client.guilds.cache.get(guildId);
      if (guild === undefined) return false;
      const sticker = await guild.stickers.fetch(stickerId).catch(() => null);
      return sticker !== null && sticker.available !== false;
    },
    logger,
  });
}

async function runLoggedAgentTurn(input: {
  incoming: IncomingMessage;
  deps: HandlerDeps;
  requestLog: RequestLog;
  logger: Logger;
  afterSuccess?: (result: HandleResult) => void | Promise<void>;
  onFinally?: (result: HandleResult | undefined, error: unknown) => void;
}): Promise<HandleResult> {
  let result: HandleResult | undefined;
  let error: unknown;
  try {
    result = await handleMessage(input.incoming, input.deps);
    await input.afterSuccess?.(result);
    return result;
  } catch (err) {
    error = err;
    if (!(err instanceof DispatchSupersededError)) {
      input.requestLog.setError(err instanceof Error ? err.message : String(err));
    }
    throw err;
  } finally {
    input.onFinally?.(result, error);
    if (result !== undefined) {
      input.requestLog.setTrigger(result.triggerResult);
      input.requestLog.setAgentRan(result.agentRan);
    }
    input.requestLog.emit(input.logger);
  }
}

log.info("bot starting", {
  version,
  runtime: `bun ${Bun.version}`,
  pid: process.pid,
});

// --- 1. Load global config (throws on missing secrets) ---

  return { persistIgnoredBotReply, persistPrivateThoughts, createBotDiscordMessageSender, resolveClientGuild, fetchAccessibleGuildChannel, createTtsGenerator, createHandlerDeps, createAssetAttachmentResolver, runLoggedAgentTurn };
}
