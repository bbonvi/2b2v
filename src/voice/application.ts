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


export function createVoiceApplication(input: {
    db: Database;
    client: Client;
    log: Logger;
    requestLogStore: typeof requestLogStore;
    getGlobalConfig: () => ReturnType<typeof loadGlobalConfig>;
    getPromptBundle: () => PromptBundle;
    getGuildConfig: (guildId: string) => GuildConfig;
    runtimeContextTemplate: (name: string, variables?: Record<string, string | number | boolean | undefined>, fallback?: string) => string;
    buildContext: typeof buildContext;
    buildAgentTools: typeof buildAgentTools;
    createBotDiscordMessageSender: typeof createBotDiscordMessageSender;
    createHandlerDeps: typeof createHandlerDeps;
    createAssetAttachmentResolver: typeof createAssetAttachmentResolver;
    runLoggedAgentTurn: typeof runLoggedAgentTurn;
    resolveKnownUsername: (guild: Guild, username: string) => string | undefined;
    resolvePromptUsername: (guild: Guild, userId: string) => string | undefined;
    createPostReplyMaintenanceTools: typeof createPostReplyMaintenanceTools;
    blockToolsExcept: typeof blockToolsExcept;
    runMemoryPostReplyExtraction: typeof runMemoryPostReplyExtraction;
    runRelationshipPostReplyExtraction: typeof runRelationshipPostReplyExtraction;
    runInnerThreadPostReplyExtraction: typeof runInnerThreadPostReplyExtraction;
    preparePersonaModeTurn: (guildId: string) => ReturnType<typeof personaModeRuntime.prepareNaturalTurn>;
  }
) {
  const { db, client, log, requestLogStore, getGlobalConfig, getPromptBundle, getGuildConfig, runtimeContextTemplate, buildContext, buildAgentTools, createBotDiscordMessageSender, createHandlerDeps, createAssetAttachmentResolver, runLoggedAgentTurn, resolveKnownUsername, resolvePromptUsername, createPostReplyMaintenanceTools, blockToolsExcept, runMemoryPostReplyExtraction, runRelationshipPostReplyExtraction, runInnerThreadPostReplyExtraction, preparePersonaModeTurn } = input;
const voiceRepository = new VoiceRepository(db);
const voiceMaintenanceBusy = new Set<string>();

function getVoiceConfig(guildConfig: GuildConfig) {
  const voice = guildConfig.voice ?? getGlobalConfig().defaultVoice;
  if (voice === undefined) throw new Error("voice configuration is unavailable");
  return voice;
}

async function voiceAssembledContext(
  request: VoiceTurnRequest,
  guild: Guild,
  guildConfig: GuildConfig,
): Promise<AssembledContext> {
  const instruction = request.instruction;
  const lastOutputIndex = request.history.findLastIndex((entry) => entry.kind === "output");
  // Keep the exchange around 2B's latest audible turn near the prompt tail,
  // while bounding unusually long runs of uninterrupted human speech.
  const immediateStart = Math.max(
    0,
    request.history.length - 16,
    lastOutputIndex === -1 ? request.history.length - 8 : lastOutputIndex - 2,
  );
  const earlierHistory = renderVoiceHistory(
    request.history.slice(0, immediateStart),
    guildConfig.timezone,
  );
  const immediateExchange = renderVoiceHistory(
    request.history.slice(immediateStart),
    guildConfig.timezone,
  );
  const latestUserMessage: HistoryMessage = {
    id: `voice:${request.sessionId}:${request.trigger.id}`,
    author: request.trigger.username,
    authorDisplayName: guild.members.cache.get(request.trigger.userId)?.displayName,
    authorId: request.trigger.userId,
    content: request.trigger.normalizedText,
    isBot: false,
    timestamp: request.trigger.startedAt,
    replyToId: null,
    hasEmbeds: false,
    isSynthetic: request.trigger.synthetic,
    relatedThreadId: null,
  };
  const replyFallbackDeps = createDiscordReplyFallbackDeps({
    db,
    clientChannelsFetch: (channelId) => client.channels.fetch(channelId),
    guild,
    guildId: request.guildId,
    channelId: request.channelId,
    guildConfig,
  });
  const base = await buildContext(
    request.guildId,
    request.channelId,
    guild,
    guildConfig,
    request.trigger.normalizedText,
    latestUserMessage,
    replyFallbackDeps,
    false,
    {
      timestamp: request.trigger.startedAt,
      messageId: latestUserMessage.id,
    },
    "live",
    undefined,
    {
      appendLatestToHistory: false,
      additionalVisibleUserIds: request.transcript
        .filter((segment) => !segment.synthetic)
        .map((segment) => segment.userId),
    },
  );
  const voiceSection = {
    label: "Live Voice Room",
    text: [
      "## Live Voice Room",
      `GuildID: ${request.guildId}`,
      `Voice ChannelID: ${request.channelId}`,
      "The sections below are chronological and may span recent visits to this channel. Every line begins with its local event or audible-speech start time precise to seconds. [room] lines mark presence boundaries; user speech is fallible ASR output; 2B lines are words previously audible in the room, and [interrupted] marks a partial reply.",
      earlierHistory === "" ? "" : `## Earlier Voice Room Context\n${earlierHistory}`,
      `## Immediate Voice Exchange\n${immediateExchange}`,
      [
        "## Current Voice Opportunity",
        `Source: ${request.opportunity.source}`,
        request.opportunity.owner === undefined
          ? "Attention owner: none; this is a room-level or external instruction opportunity."
          : `Attention owner: @${request.opportunity.owner.username} (${request.opportunity.owner.userId})`,
        `OpenedAt: ${new Date(request.opportunity.openedAt).toISOString()}`,
        request.opportunity.currentSpeakers.length === 0
          ? "Currently speaking: nobody."
          : `Currently speaking: ${request.opportunity.currentSpeakers.map((speaker) =>
            `@${speaker.username} (${speaker.userId}) for ${speaker.speakingForMs}ms`
          ).join(", ")}`,
        request.opportunity.recentInterrupters.length === 0
          ? "Recent interrupters in this opportunity: none."
          : `Recent interrupters: ${request.opportunity.recentInterrupters.map((speaker) =>
            `@${speaker.username} (${speaker.userId})`
          ).join(", ")}`,
      ].join("\n"),
      instruction === undefined
        ? ""
        : [
          "",
          "## Open Voice Instruction",
          `InstructionID: ${instruction.id}`,
          `Status: ${instruction.status}`,
          `Requester: @${instruction.requesterUsername} (${instruction.requesterId})`,
          `Source GuildID: ${instruction.sourceGuildId}`,
          `Source ChannelID: ${instruction.sourceChannelId}`,
          `Source MsgID: ${instruction.sourceMessageId}`,
          `Original asking message: ${instruction.sourceMessageText}`,
          `Instruction: ${instruction.instruction}`,
        ].join("\n"),
    ].filter((part) => part !== "").join("\n"),
    cached: false,
    role: "developer" as const,
  };
  const handoffSection = request.handoff === undefined
    ? undefined
    : {
      label: "Voice Move Handoff",
      text: renderVoiceMoveHandoff(request.handoff, guildConfig.timezone),
      cached: false,
      role: "developer" as const,
    };
  const currentContextIndex = base.sections.findIndex((section) => section.label === "Current Context");
  const insertAt = currentContextIndex === -1 ? base.sections.length : currentContextIndex;
  return {
    ...base,
    sections: [
      ...base.sections.slice(0, insertAt),
      ...(handoffSection === undefined ? [] : [handoffSection]),
      voiceSection,
      ...base.sections.slice(insertAt),
    ],
    userMessage: request.trigger.normalizedText,
  };
}

async function resolveDefaultVoiceTextChannel(guildId: string): Promise<SendableGuildChannel | null> {
  const guild = await resolveClientGuild(guildId);
  if (guild === null) return null;
  const configured = getGuildConfig(guildId).ambientInitiative?.mainChannelId;
  if (configured !== undefined && configured !== "") {
    const channel = client.channels.cache.get(configured) ?? await client.channels.fetch(configured).catch(() => null);
    if (channel !== null && isSendableGuildChannel(channel)) return channel;
  }
  if (guild.systemChannel !== null && isSendableGuildChannel(guild.systemChannel)) return guild.systemChannel;
  const row = db.raw.prepare(`SELECT channel_id FROM messages
    WHERE guild_id = ? AND is_bot = 0 AND deleted_at IS NULL
    GROUP BY channel_id ORDER BY COUNT(*) DESC LIMIT 1`).get(guildId) as { channel_id: string } | null;
  if (row !== null) {
    const channel = client.channels.cache.get(row.channel_id) ?? await client.channels.fetch(row.channel_id).catch(() => null);
    if (channel !== null && isSendableGuildChannel(channel)) return channel;
  }
  return null;
}

async function sendVoiceTextDirective(message: {
  channelId?: string;
  handoff?: string;
  replyTo?: string;
  resolvesInstruction?: string;
  text: string;
}, source: {
  sourceGuildId: string;
  sourceChannelId: string;
  sourceMessageId: string;
}): Promise<{ sentMessageId: string }> {
  const snapshot = voiceRuntime.snapshot();
  const instruction = message.resolvesInstruction === undefined
    ? undefined
    : voiceRepository.getInstruction(message.resolvesInstruction);
  const guildId = instruction?.sourceGuildId ?? snapshot.guildId;
  const explicit = message.channelId ?? instruction?.sourceChannelId;
  let channel: SendableGuildChannel | null = null;
  if (explicit !== undefined) {
    const fetched = client.channels.cache.get(explicit) ?? await client.channels.fetch(explicit).catch(() => null);
    if (fetched !== null && isSendableGuildChannel(fetched)) channel = fetched;
  } else if (guildId !== undefined) {
    channel = await resolveDefaultVoiceTextChannel(guildId);
  }
  if (channel === null) throw new Error("No sendable default text channel is available for the voice message.");
  let sent: Message | undefined;
  if (message.replyTo !== undefined && "messages" in channel) {
    const target = await channel.messages.fetch(message.replyTo).catch(() => null);
    if (target !== null) {
      sent = await target.reply({
        content: message.text,
        allowedMentions: { repliedUser: true, users: instruction === undefined ? [] : [instruction.requesterId] },
      });
    }
  }
  if (sent === undefined) {
    const fallback = instruction === undefined || message.text.includes(`<@${instruction.requesterId}>`)
      ? message.text
      : `<@${instruction.requesterId}> ${message.text}`;
    sent = await channel.send({
      content: fallback,
      allowedMentions: { users: instruction === undefined ? [] : [instruction.requesterId] },
    });
  }
  const destinationGuildId = sent.guildId ?? channel.guildId;
  const destinationChannelId = sent.channelId;
  upsertBotMessageContent(db, {
    id: sent.id,
    guildId: destinationGuildId,
    channelId: destinationChannelId,
    botUserId: client.user?.id ?? "",
    botUsername: client.user?.username ?? "bot",
    rawContent: sent.content,
    translatedContent: sent.content,
    createdAt: sent.createdTimestamp,
    replyToId: sent.reference?.messageId ?? null,
    routedFrom: source.sourceGuildId !== destinationGuildId
      || source.sourceChannelId !== destinationChannelId
      ? {
          routedFromGuildId: source.sourceGuildId,
          routedFromChannelId: source.sourceChannelId,
          routedFromMessageId: source.sourceMessageId,
        }
      : undefined,
  });
  if (message.handoff !== undefined) {
    insertPromptOnlyMessageHandoff(db, {
      ...source,
      destinationGuildId,
      destinationChannelId,
      routedMessageId: sent.id,
      botUserId: client.user?.id ?? "",
      botUsername: client.user?.username ?? "bot",
      handoff: message.handoff,
    });
  }
  return { sentMessageId: sent.id };
}

async function runVoiceAgentTurn(request: VoiceTurnRequest): Promise<void> {
  const runtime = voiceRuntime;
  const guild = await resolveClientGuild(request.guildId);
  if (guild === null) throw new Error(`Voice guild ${request.guildId} is unavailable.`);
  const baseConfig = getGuildConfig(request.guildId);
  const voiceConfig = getVoiceConfig(baseConfig);
  const guildConfig = baseConfig;
  const context = await voiceAssembledContext(request, guild, guildConfig);
  const origin = request.instruction === undefined
    ? {
      requesterId: request.trigger.userId,
      requesterUsername: request.trigger.username,
      sourceMessageId: `voice:${request.sessionId}:${request.trigger.id}`,
      sourceQuote: request.trigger.normalizedText,
    }
    : {
      requesterId: request.instruction.requesterId,
      requesterUsername: request.instruction.requesterUsername,
      sourceMessageId: request.instruction.sourceMessageId,
      sourceQuote: request.instruction.sourceMessageText,
    };
  const allowedToolNames = new Set([
    "list_channels",
    "search_memories",
    "read_asset",
    "search_asset",
    "read_user_avatar",
    "fetch_images",
    "fetch_url",
    "web_search",
    "search_images",
    "summarize_video",
    // Live image generation remains skill-gated, so its prerequisite loader
    // must survive the otherwise restrictive voice-tool allowlist.
    "load_skill",
    "join_voice_channel",
    "leave_voice_channel",
    "codex_generate_image",
    "cancel_agent_job",
    "list_agent_jobs",
    "read_agent_job",
  ]);
  const imageDeliveryChannel = await resolveDefaultVoiceTextChannel(request.guildId);
  const tools = buildAgentTools(
    request.guildId,
    request.channelId,
    guildConfig,
    guild,
    undefined,
    undefined,
    origin,
    {
      includeImageGenerationTools: imageDeliveryChannel !== null,
      voiceToolSurface: "voice",
      ...(imageDeliveryChannel === null
        ? {}
        : {
          imageDelivery: {
            guildId: imageDeliveryChannel.guildId,
            channelId: imageDeliveryChannel.id,
          },
        }),
    },
  ).filter((tool) => allowedToolNames.has(tool.name));
  const sink = runtime.createResponseSink(request.trigger.id, request.instruction?.id);
  const requestLog = new RequestLog(request.guildId, request.channelId, requestLogStore);
  requestLog.setAuthor(request.trigger.username);
  requestLog.setTrigger({
    type: "voice_turn",
    sessionId: request.sessionId,
    segmentId: request.trigger.id,
    instructionId: request.instruction?.id,
  });
  requestLog.setAgentRan(true);
  const runtimePrompts = {
    ...getPromptBundle().runtime,
    reply: getPromptBundle().runtime.voice?.runtime ?? "",
    finalActionInstruction: getPromptBundle().runtime.voice?.finalActionInstruction ?? "",
  };
  const incoming: IncomingMessage = {
    content: request.trigger.normalizedText,
    guildId: request.guildId,
    guildName: guild.name,
    channelId: request.channelId,
    channelName: voiceRuntime.snapshot().channelName ?? request.channelId,
    authorId: request.trigger.userId,
    authorUsername: request.trigger.username,
    authorIsBot: false,
    botUserId: client.user?.id ?? "",
    mentionedUserIds: [],
    mentionedRoleIds: [],
    botRoleIds: [],
    mentionedEveryone: false,
    translatedContent: request.trigger.normalizedText,
    eventContent: [
      "The room is available for your next action. Base it on the latest coherent exchange in Immediate Voice Exchange, including recent speech from all participants and your last audible reply.",
      "The final ASR segment merely caused this turn to run; it is not a privileged standalone message and may be inaccurate, incomplete, incidental, or addressed to someone else. Do not answer it in isolation. Respond to what is socially current in the room, or remain silent when no response is appropriate.",
      "Speech only seconds apart is likely part of one exchange, including quick replies and interruptions, but timing is evidence rather than proof; syntax, addressee, topic, and room context remain authoritative.",
    ].join("\n\n"),
    eventPrompt: {
      metadataHeading: "Voice Turn Metadata",
      contentHeading: "Live Voice Response Opportunity",
      metadataText: [
        `GuildID: ${request.guildId}`,
        `GuildName: ${guild.name}`,
        `Voice ChannelID: ${request.channelId}`,
        `Voice ChannelName: ${voiceRuntime.snapshot().channelName ?? request.channelId}`,
        `Response Boundary SegmentID: ${request.trigger.id}`,
      ].join("\n"),
    },
    messageId: `voice:${request.sessionId}:${request.trigger.id}`,
  };
  try {
    await handleMessage(incoming, createHandlerDeps({
      guildId: request.guildId,
      guildConfig,
      context,
      currentChannelId: request.channelId,
      sender: () => Promise.resolve({ sentMessageId: `voice:${crypto.randomUUID()}` }),
      extraTools: tools,
      log: log.child({ component: "voice-agent", sessionId: request.sessionId }),
      requestLog,
      modeLifecycle: false,
      overrides: {
        forceTrigger: true,
        modelProfile: voiceConfig.modelProfile,
        systemPrompt: getPromptBundle().systemPrompt,
        personaPrompt: getPromptBundle().corePrompt,
        runtimePrompts,
        externalResponseSink: sink,
        abortSignal: request.abortSignal,
        afterReply: undefined,
      },
    }));
  } catch (error) {
    sink.abort();
    throw error;
  } finally {
    runtime.releaseResponseSink(sink);
    requestLog.emit(log);
  }
}

async function runVoiceMaintenance(sessionId: string, final: boolean): Promise<void> {
  if (voiceMaintenanceBusy.has(sessionId)) return;
  const session = voiceRepository.getSession(sessionId);
  if (session === undefined) return;
  const guild = await resolveClientGuild(session.guildId);
  if (guild === null) return;
  const baseConfig = getGuildConfig(session.guildId);
  const voiceConfig = getVoiceConfig(baseConfig);
  const guildConfig = baseConfig;
  const includeSynthetic = voiceConfig.testing.includeSyntheticInMaintenance;
  const maintenanceChannel = client.channels.cache.get(session.channelId)
    ?? await client.channels.fetch(session.channelId).catch(() => null);
  const maintenanceChannelName = maintenanceChannel !== null
    && "name" in maintenanceChannel
    && typeof maintenanceChannel.name === "string"
    ? maintenanceChannel.name
    : session.channelId;
  voiceMaintenanceBusy.add(sessionId);
  try {
    const workloadDue = (
      checkpointKind: "summary" | "memory",
      config: { everySegments: number; minIntervalMs: number },
    ): boolean => {
      if (final) return true;
      const checkpoint = voiceRepository.getCheckpoint(sessionId, checkpointKind);
      const afterSegmentId = checkpoint?.throughSegmentId ?? 0;
      const newSegments = voiceRepository.countTranscriptAfter(sessionId, afterSegmentId);
      const lastRunAt = checkpoint?.lastRunAt ?? session.startedAt;
      return newSegments >= config.everySegments
        && Date.now() - lastRunAt >= config.minIntervalMs;
    };
    const loadBatch = (
      checkpointKind: "summary" | "memory",
      config: { everySegments: number; maxTurns: number; maxChars: number },
    ) => {
      const checkpoint = voiceRepository.getCheckpoint(sessionId, checkpointKind);
      const afterSegmentId = checkpoint?.throughSegmentId ?? 0;
      const history = voiceRepository.listMaintenanceHistory(
        sessionId,
        afterSegmentId,
        Math.max(config.everySegments, config.maxTurns * 6),
      ).filter((entry) =>
        entry.kind !== "transcript" || includeSynthetic || !entry.transcript.synthetic
      );
      const compact = compactVoiceMaintenance(
        history,
        afterSegmentId,
        config.maxTurns,
        config.maxChars,
      );
      const segments = history.flatMap((entry) =>
        entry.kind === "transcript" && entry.transcript.id > afterSegmentId
          ? [entry.transcript]
          : []
      );
      return { compact, segments };
    };
    const shouldSkipBatch = (batch: ReturnType<typeof loadBatch>): boolean =>
      batch.compact.newSegmentCount === 0
      || batch.compact.text === ""
      || (final && !batch.compact.hasNewOutput && batch.compact.newSegmentCount < 12);
    const createMaintenanceLog = (
      kind: "summary" | "extraction",
      last: { username: string },
      sourceMessageId: string,
      context: AssembledContext,
    ): RequestLog => {
      const requestLog = new RequestLog(guild.id, session.channelId, requestLogStore);
      requestLog.setAuthor(last.username);
      requestLog.setTrigger({
        type: "background_memory_extraction",
        source: `voice_session_${kind}`,
        sourceRequestId: sessionId,
      });
      requestLog.setTriggerContext({
        guildName: guild.name,
        channelName: maintenanceChannelName,
        messageId: sourceMessageId,
        authorUsername: last.username,
        content: context.userMessage,
        translatedContent: context.userMessage,
      });
      requestLog.setAgentRan(true);
      return requestLog;
    };
    const runLoggedPass = async (
      requestLog: RequestLog,
      pass: Parameters<typeof runSilentToolAgentPass>[0],
    ): Promise<void> => {
      requestLogStore.incrementActive();
      try {
        await runSilentToolAgentPass(pass);
      } catch (error) {
        requestLog.setError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        requestLog.emit(log);
        requestLogStore.decrementActive();
      }
    };

    if (workloadDue("summary", voiceConfig.maintenance.summary)) {
      const batch = loadBatch("summary", voiceConfig.maintenance.summary);
      const last = batch.segments.at(-1);
      if (last !== undefined && !shouldSkipBatch(batch)) {
        const sourceMessageId = `voice:${sessionId}:${batch.compact.latestSegmentId}:summary`;
        const context: AssembledContext = {
          sections: [{
            label: "Current Context",
            text: [
              session.rollingSummary === ""
                ? ""
                : `## Existing Rolling Summary\n${session.rollingSummary}`,
              `## Compact Voice Delta\n${batch.compact.text}`,
            ].filter((part) => part !== "").join("\n\n"),
            cached: false,
            role: "developer",
          }],
          userMessage: "Refresh the rolling voice-room summary.",
          visibleUserIds: batch.compact.userIds,
        };
        const incomingMessage: IncomingMessage = {
          content: context.userMessage,
          guildId: session.guildId,
          guildName: guild.name,
          channelId: session.channelId,
          channelName: maintenanceChannelName,
          authorId: last.userId,
          authorUsername: last.username,
          authorIsBot: false,
          botUserId: client.user?.id ?? "",
          mentionedUserIds: [],
          mentionedRoleIds: [],
          botRoleIds: [],
          mentionedEveryone: false,
          translatedContent: context.userMessage,
          messageId: sourceMessageId,
        };
        let refreshedSummary: string | undefined;
        const requestLog = createMaintenanceLog("summary", last, sourceMessageId, context);
        await runLoggedPass(requestLog, {
          globalConfig: getGlobalConfig(),
          guildConfig,
          context,
          systemPrompt: "Maintain a concise rolling summary from a compact live-voice transcript. ASR wording may be inaccurate. Never answer the conversation.",
          personaPrompt: "",
          runtimePrompts: getPromptBundle().runtime,
          incomingMessage,
          userContent: context.userMessage,
          assistantReply: "",
          visibleReplySent: false,
          tools: [createVoiceSummaryTool((summary) => {
            refreshedSummary = summary;
            voiceRepository.updateSession(sessionId, {
              rollingSummary: summary,
              summaryThroughSegmentId: batch.compact.latestSegmentId,
              ...(final ? { finalSummary: summary } : {}),
            });
          })],
          runtimeInstruction: "This is private voice-summary maintenance. Only update_voice_summary is available.",
          controlMessage: "Call update_voice_summary once with a refreshed 3-6 sentence summary combining the existing summary and new delta. Retry only if the tool reports an error.",
          modelProfile: voiceConfig.maintenance.summary.modelProfile,
          maxToolCalls: 2,
          terminateAfterSuccessfulToolRoundNames: ["update_voice_summary"],
          requestLog,
          log: log.child({ component: "voice-summary-maintenance", sessionId }),
        });
        if (refreshedSummary === undefined) {
          log.warn("voice summary maintenance completed without refreshing summary", { sessionId });
        }
        // A completed no-op must still advance cadence; otherwise one malformed
        // summary turn is retried after every subsequent transcript segment.
        voiceRepository.setCheckpoint(sessionId, "summary", batch.compact.latestSegmentId);
      }
    }

    if (workloadDue("memory", voiceConfig.maintenance.extraction)) {
      const batch = loadBatch("memory", voiceConfig.maintenance.extraction);
      const last = batch.segments.at(-1);
      if (last !== undefined && !shouldSkipBatch(batch)) {
        const usernameById = new Map(batch.segments.map((segment) => [segment.userId, segment.username]));
        const userIds = batch.compact.userIds.filter((userId) => usernameById.has(userId)).slice(0, 8);
        const sourceMessageId = `voice:${sessionId}:${batch.compact.latestSegmentId}:extraction`;
        const relationshipConfig = getRelationshipConfig(guildConfig);
        const enableInnerThreads = innerThreadsEnabled(guildConfig);
        const createVoiceExtractionTools = (dryRun: boolean): AgentTool[] => {
          const tools: AgentTool[] = [];
          if (guildConfig.memoryExtraction.postReply) {
            tools.push(createRecordMemoryTool({
              db,
              guildId: guild.id,
              currentUserId: last.userId,
              currentUsername: last.username,
              sourceMessageId,
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
            }));
          }
          if (relationshipConfig.enabled) {
            tools.push(createRecordRelationshipTool({
              db,
              config: relationshipConfig,
              dryRun,
              description: runtimeToolDescription("record_relationship"),
              scope: {
                guildId: session.guildId,
                channelId: session.channelId,
                sourceMessageId,
              },
            }));
          }
          if (enableInnerThreads) {
            tools.push(createRecordInnerThreadsTool({
              db,
              guildId: guild.id,
              channelId: session.channelId,
              requestId: sessionId,
              description: runtimeToolDescription("record_inner_threads"),
              dryRun,
            }));
          }
          return applyRuntimeToolPrompts(tools, getPromptBundle().runtime);
        };
        const validationTools = createVoiceExtractionTools(true);
        const commitTools = createVoiceExtractionTools(false);
        const stagedCalls: StagedMaintenanceCall[] = [];
        const stagedToolNames = new Set(validationTools.map((tool) => tool.name));
        const tools = stageMaintenanceTools(validationTools, stagedCalls, stagedToolNames);
        if (tools.length > 0) {
          const memoryContext = buildMemoryContext({
            db,
            guildId: guild.id,
            currentUserId: last.userId,
            visibleUserIds: userIds,
            resolveUserId: (userId) => usernameById.get(userId)
              ?? resolvePromptUsername(guild, userId),
            limit: 40,
            recentUserMaxUsers: 8,
            recentUserMaxMemoriesPerUser: 5,
            recentUserMaxRows: 30,
            contextInstruction: "Use these rows only to avoid duplicate or contradictory maintenance updates.",
          });
          const relationshipContext = relationshipConfig.enabled
            ? renderRelationshipPromptContext({
                current: getRelationshipProfile(db, last.userId),
                currentLabel: `@${last.username} (${last.userId})`,
                others: userIds
                  .filter((userId) => userId !== last.userId)
                  .map((userId): RelationshipContextProfile => ({
                    profile: getRelationshipProfile(db, userId),
                    label: `@${usernameById.get(userId) ?? userId} (${userId})`,
                    reason: "recent-chat",
                  })),
                template: getPromptBundle().runtime.relationships.context,
              })
            : "";
          const relationshipAxisContext = relationshipConfig.enabled
            ? [
                "## Current Relationship Axis Values",
                ...userIds.map((userId) =>
                  `- @${usernameById.get(userId) ?? userId} (${userId}): ${renderRelationshipAxisValues(getRelationshipProfile(db, userId))}`
                ),
              ].join("\n")
            : "";
          const context: AssembledContext = {
            sections: [{
              label: "Current Context",
              text: [
                session.rollingSummary === ""
                  ? ""
                  : `## Existing Rolling Summary\n${session.rollingSummary}`,
                memoryContext === "" ? "" : `## Existing Memory Context\n${memoryContext}`,
                relationshipContext,
                relationshipAxisContext,
                enableInnerThreads
                  ? buildInnerThreadsContext({
                      db,
                      guildId: guild.id,
                      visibleUserIds: userIds,
                      limit: 30,
                      resolveUserId: (userId) => usernameById.get(userId)
                        ?? guild.members.cache.get(userId)?.user.username,
                    })
                  : "",
                `## Voice Speaker IDs\n${userIds.map((userId) =>
                  `@${usernameById.get(userId) ?? userId} = ${userId}`
                ).join("\n")}`,
                `## Compact Voice Delta\n${batch.compact.text}`,
              ].filter((part) => part !== "").join("\n\n"),
              cached: false,
              role: "developer",
            }],
            userMessage: "Review the compact voice delta for durable maintenance.",
            visibleUserIds: userIds,
          };
          const incomingMessage: IncomingMessage = {
            content: context.userMessage,
            guildId: session.guildId,
            guildName: guild.name,
            channelId: session.channelId,
            channelName: maintenanceChannelName,
            authorId: last.userId,
            authorUsername: last.username,
            authorIsBot: false,
            botUserId: client.user?.id ?? "",
            mentionedUserIds: [],
            mentionedRoleIds: [],
            botRoleIds: [],
            mentionedEveryone: false,
            translatedContent: context.userMessage,
            messageId: sourceMessageId,
          };
          const requestLog = createMaintenanceLog("extraction", last, sourceMessageId, context);
          const ticket = semanticMaintenanceCoordinator.reserve();
          const defaultMode = defaultPersonaModeForMaintenance();
          try {
            await runLoggedPass(requestLog, {
              globalConfig: getGlobalConfig(),
              guildConfig,
              context,
              systemPrompt: [
                getPromptBundle().systemPrompt,
                "Maintain private durable semantic state from a compact live-voice transcript. ASR wording may be inaccurate. Never answer the conversation.",
              ].filter((part) => part !== "").join("\n\n"),
              personaPrompt: getPromptBundle().corePrompt,
              runtimePrompts: getPromptBundle().runtime,
              incomingMessage,
              userContent: context.userMessage,
              assistantReply: "",
              visibleReplySent: false,
              tools,
              runtimeInstruction: getPromptBundle().runtime.reply,
              controlMessage: [
                runtimeContextTemplate(
                  "semantic-maintenance-execution-mode",
                  {
                    defaultPersonaModeId: defaultMode.id,
                    defaultPersonaModeInstructions: defaultMode.instructions,
                  },
                ),
                "Voice transcripts may contain ASR errors; require clear evidence before mutation.",
                "Every relationship signal must include the target userId from Voice Speaker IDs.",
                guildConfig.memoryExtraction.postReply
                  ? runtimeContextTemplate("memory-pass-decision")
                  : "",
                relationshipConfig.enabled
                  ? runtimeContextTemplate("relationship-pass-decision")
                  : "",
                enableInnerThreads
                  ? runtimeContextTemplate("inner-thread-pass-decision")
                  : "",
              ].filter((part) => part !== "").join("\n\n"),
              modelProfile: voiceConfig.maintenance.extraction.modelProfile,
              maxToolCalls: (guildConfig.memoryExtraction.postReply
                ? guildConfig.memoryExtraction.maxToolCalls
                : 0)
                + (relationshipConfig.enabled ? relationshipConfig.maxToolCalls : 0)
                + (enableInnerThreads ? 3 : 0),
              terminateAfterSuccessfulToolRoundNames: tools.map((tool) => tool.name),
              requestLog,
              log: log.child({ component: "voice-extraction-maintenance", sessionId }),
            });
            await ticket.commit(async () => {
              await commitStagedMaintenanceCalls({ calls: stagedCalls, tools: commitTools });
            });
          } catch (error) {
            ticket.skip();
            throw error;
          }
        }
        voiceRepository.setCheckpoint(sessionId, "memory", batch.compact.latestSegmentId);
        voiceRepository.setCheckpoint(sessionId, "relationship", batch.compact.latestSegmentId);
      }
    }
  } finally {
    voiceMaintenanceBusy.delete(sessionId);
  }
}

const voiceRuntime = new VoiceRuntime({
  client,
  repository: voiceRepository,
  getGuildConfig,
  elevenLabsApiKey: getGlobalConfig().elevenLabsApiKey,
  log: log.child({ component: "voice" }),
  onTurn: runVoiceAgentTurn,
  sendMessage: sendVoiceTextDirective,
  onMaintenance: runVoiceMaintenance,
});


  return { voiceRuntime, getVoiceConfig, voiceAssembledContext };
}
