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


export function createMessageTurnRuntime(input: {
    db: Database;
    client: Client;
    log: Logger;
    requestLogStore: typeof requestLogStore;
    getGuildConfig: (guildId: string) => GuildConfig;
    getPromptBundle: () => PromptBundle;
    buildInboundResolvers: (guild: Guild) => InboundResolvers;
    authorDisplayName: (message: Message) => string | undefined;
    buildContext: ReturnType<typeof import("../agent/context-runtime").createContextRuntime>["buildContext"];
    buildAgentTools: ReturnType<typeof import("../agent/tool-runtime").createToolRuntime>["buildAgentTools"];
    createBotDiscordMessageSender: ReturnType<typeof import("../agent/turn-runtime").createTurnRuntime>["createBotDiscordMessageSender"];
    createHandlerDeps: ReturnType<typeof import("../agent/turn-runtime").createTurnRuntime>["createHandlerDeps"];
    createAssetAttachmentResolver: ReturnType<typeof import("../agent/turn-runtime").createTurnRuntime>["createAssetAttachmentResolver"];
    runLoggedAgentTurn: ReturnType<typeof import("../agent/turn-runtime").createTurnRuntime>["runLoggedAgentTurn"];
    createTtsGenerator: ReturnType<typeof import("../agent/turn-runtime").createTurnRuntime>["createTtsGenerator"];
    blockToolsExcept: ReturnType<typeof import("../agent/maintenance-runtime").createMaintenanceRuntime>["blockToolsExcept"];
    createPostReplyMaintenanceTools: ReturnType<typeof import("../agent/maintenance-runtime").createMaintenanceRuntime>["createPostReplyMaintenanceTools"];
    runMemoryPostReplyExtraction: ReturnType<typeof import("../agent/maintenance-runtime").createMaintenanceRuntime>["runMemoryPostReplyExtraction"];
    runRelationshipPostReplyExtraction: ReturnType<typeof import("../agent/maintenance-runtime").createMaintenanceRuntime>["runRelationshipPostReplyExtraction"];
    runInnerThreadPostReplyExtraction: ReturnType<typeof import("../agent/maintenance-runtime").createMaintenanceRuntime>["runInnerThreadPostReplyExtraction"];
    persistIgnoredBotReply: ReturnType<typeof import("../agent/turn-runtime").createTurnRuntime>["persistIgnoredBotReply"];
    persistPrivateThoughts: ReturnType<typeof import("../agent/turn-runtime").createTurnRuntime>["persistPrivateThoughts"];
    maybeRunAmbientMemoryExtraction: ReturnType<typeof import("../agent/ambient-memory-runtime").createAmbientMemoryRuntime>["maybeRunAmbientMemoryExtraction"];
    fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
    getAmbientRuntime: () => ReturnType<typeof createAmbientRuntime>;
    getPrivateLifeRuntime: () => ReturnType<typeof createPrivateLifeRuntime>;
    getEventWatchRuntime: () => ReturnType<typeof createEventWatchRuntime>;
    runtimeContextTemplate: (name: string, variables?: Record<string, string | number | boolean | undefined>, fallback?: string) => string;
    preparePersonaModeTurn: (guildId: string) => ReturnType<ReturnType<typeof createPersonaModeRuntime>["prepareNaturalTurn"]>;
  }
) {
  const { db, client, log, requestLogStore, getGuildConfig, getPromptBundle, buildInboundResolvers, authorDisplayName, buildContext, buildAgentTools, createBotDiscordMessageSender, createHandlerDeps, createAssetAttachmentResolver, runLoggedAgentTurn, createTtsGenerator, blockToolsExcept, createPostReplyMaintenanceTools, runMemoryPostReplyExtraction, runRelationshipPostReplyExtraction, runInnerThreadPostReplyExtraction, persistIgnoredBotReply, persistPrivateThoughts, maybeRunAmbientMemoryExtraction, fetchAccessibleGuildChannel, getAmbientRuntime, getPrivateLifeRuntime, getEventWatchRuntime, runtimeContextTemplate, preparePersonaModeTurn } = input;
type CurrentTurnBoundary = NonNullable<Parameters<typeof buildContext>[8]>;
 
const dispatchers = new Map<string, ChannelDispatcher>();

/** Get or create a channel dispatcher for a guild. */
function getOrCreateDispatcher(guildId: string): ChannelDispatcher {
  let dispatcher = dispatchers.get(guildId);
  if (dispatcher !== undefined) return dispatcher;

  const config = getGuildConfig(guildId);
  dispatcher = createChannelDispatcher({
    config: config.dispatcher,
    triggers: config.triggers,
    debug: (event, fields) => log.debug(event, { guildId, ...fields }),
    handler: async (batch, trigger, control): Promise<DispatchOutcome> => {
      if (trigger === null) return { coveredMessageIds: [] };
      const selected = selectDispatchMessageForTrigger(batch, trigger);
      if (selected === undefined) return { coveredMessageIds: [] };
      const currentTurnMessages = selectDispatchMessagesForTrigger(batch, trigger)
        .map((pending) => pending.message as Message);
      const matchedWatchIds = [...new Set(batch.flatMap((pending) =>
        pending.authorId === trigger.message.authorId ? pending.matchedWatchIds ?? [] : []
      ))];
      const ordinaryTrigger = selectNormalDispatchTrigger(batch) ?? trigger.result;
      if (matchedWatchIds.length > 0) {
        return await processSettledWatchedMessage(
          selected.message as Message,
          matchedWatchIds,
          ordinaryTrigger,
          currentTurnMessages,
        );
      }
      if (trigger.result === null) return { coveredMessageIds: [] };
      control.enableSupersession();
      return await processTriggeredMessage(selected.message as Message, trigger.result, currentTurnMessages, {
        abortSignal: control.signal,
        onActionCommitted: () => { control.commit(); },
      });
    },
  });
  dispatchers.set(guildId, dispatcher);
  return dispatcher;
}

function messageRepliesToOwnBot(message: Message): boolean {
  if (message.guildId === null || message.reference?.messageId === undefined) return false;
  const botUserId = client.user?.id ?? "";
  if (botUserId === "") return false;
  const row = db.raw
    .prepare("SELECT user_id, is_bot FROM messages WHERE id = ? AND guild_id = ? AND is_prompt_only = 0")
    .get(message.reference.messageId, message.guildId) as { user_id: string; is_bot: number } | null;
  return row !== null && row.user_id === botUserId && row.is_bot === 1;
}

function messageTriggerMentionFields(
  message: Message,
): Pick<TriggerInput, "mentionedUserIds" | "mentionedRoleIds" | "botRoleIds" | "mentionedEveryone"> {
  const botMember = message.guild?.members.me;
  return {
    mentionedUserIds: [...message.mentions.users.keys()],
    mentionedRoleIds: [...message.mentions.roles.keys()],
    botRoleIds: botMember === null || botMember === undefined
      ? []
      : [...botMember.roles.cache.keys()],
    mentionedEveryone: message.mentions.everyone && contentMentionsEveryone(message.content),
  };
}

function evaluateMessageTrigger(message: Message, guildConfig: GuildConfig, deliberateOnly = false): TriggerResult {
  const triggerInput = {
    content: message.content,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    botUserId: client.user?.id ?? "",
    ...messageTriggerMentionFields(message),
    repliedToBot: messageRepliesToOwnBot(message),
  };
  return deliberateOnly
    ? shouldRespondDeliberately(triggerInput, guildConfig.triggers)
    : shouldRespond(triggerInput, guildConfig.triggers);
}

function formatTriggerReason(trigger: NonNullable<TriggerResult>): string {
  return trigger.reason === "keyword" ? `keyword "${trigger.keyword}"` : trigger.reason;
}

function normalizedWatchMessage(message: Message, content?: string): Extract<NormalizedWatchEvent, { type: "message" }> {
  return normalizeDiscordWatchMessage({
    db,
    message,
    ...(content === undefined ? {} : { content }),
    botUserId: client.user?.id,
  });
}

async function processEventWatchTurn(turn: EventWatchTurn): Promise<{ visibleOutput: boolean }> {
  const watch = turn.watches[0];
  if (watch === undefined) return { visibleOutput: false };
  let message: Message | null = turn.sourceMessage instanceof Object
    && "id" in turn.sourceMessage
    ? turn.sourceMessage as Message
    : null;
  const sourceMatchesExecution = turn.event.guildId === watch.runInGuildId
    && "channelId" in turn.event
    && turn.event.channelId === watch.runInChannelId;
  if (message === null && turn.event.type === "message") {
    const sourceChannel = await fetchAccessibleGuildChannel(turn.event.channelId);
    message = await sourceChannel?.messages.fetch(turn.event.messageId).catch(() => null) ?? null;
  }
  if (!sourceMatchesExecution || message === null) {
    const targetChannel = await fetchAccessibleGuildChannel(watch.runInChannelId);
    if (targetChannel === null || targetChannel.guildId !== watch.runInGuildId) {
      throw new Error(`Watch execution channel ${watch.runInChannelId} is unavailable.`);
    }
    message = syntheticEventProxyMessage(
      targetChannel,
      `event-watch:${turn.fires.map((fire) => fire.id).join(":")}`,
      turn.event.at,
    );
  }
  const eventContent = turn.event.type === "message" && sourceMatchesExecution
    ? undefined
    : [
        "Untrusted matched event data:",
        JSON.stringify(turn.event),
      ].join("\n");
  const outcome = await processTriggeredMessage(
    message,
    turn.ordinaryTrigger,
    [message],
    {
      eventWatchTurn: turn,
      ...(eventContent === undefined
        ? {}
        : {
            currentTurnOverride: {
              messageId: `event-watch:${turn.fires.map((fire) => fire.id).join(":")}`,
              timestamp: turn.event.at,
              content: eventContent,
            },
          }),
    },
  );
  return { visibleOutput: outcome.visibleOutputSent === true };
}

/** Minimal Discord message carrier for a synthetic event in an execution channel. */
function syntheticEventProxyMessage(
  channel: SendableGuildChannel,
  id: string,
  createdTimestamp: number,
): Message {
  const author = client.user;
  if (author === null) throw new Error("Discord bot identity is unavailable.");
  return {
    id,
    guildId: channel.guildId,
    guild: channel.guild,
    channelId: channel.id,
    channel,
    author,
    member: channel.guild.members.me,
    content: "",
    components: [],
    embeds: [],
    stickers: { values: () => [][Symbol.iterator]() },
    mentions: {
      users: new Map(),
      roles: new Map(),
      everyone: false,
    },
    reference: null,
    webhookId: null,
    createdTimestamp,
  } as unknown as Message;
}

async function processSettledWatchedMessage(
  message: Message,
  matchedWatchIds: readonly string[],
  ordinaryTrigger: NonNullable<TriggerResult> | null,
  currentTurnMessages: readonly Message[],
): Promise<DispatchOutcome> {
  const event = normalizedWatchMessage(message);
  const groups = new Map<string, string[]>();
  for (const watchId of matchedWatchIds) {
    const watch = getEventWatch(db, watchId);
    if (watch === null) continue;
    const key = `${watch.runInGuildId}:${watch.runInChannelId}`;
    const ids = groups.get(key) ?? [];
    ids.push(watchId);
    groups.set(key, ids);
  }
  let ordinaryHandled = false;
  for (const [key, watchIds] of groups) {
    const turn = getEventWatchRuntime().claimMatched(watchIds, event);
    if (turn === null) continue;
    turn.sourceMessage = message;
    if (key === `${message.guildId}:${message.channelId}` && ordinaryTrigger !== null) {
      turn.ordinaryTrigger = ordinaryTrigger;
      ordinaryHandled = true;
    }
    await getEventWatchRuntime().executeClaimed(turn);
  }
  if (ordinaryTrigger !== null && !ordinaryHandled) {
    return await processTriggeredMessage(message, ordinaryTrigger, currentTurnMessages);
  }
  return { coveredMessageIds: currentTurnMessages.map((current) => current.id) };
}

/** Process a triggered message through the full handler pipeline. */
function isMessageBackedTrigger(trigger: NonNullable<TriggerResult>): boolean {
  return trigger.reason === "mention"
    || trigger.reason === "keyword"
    || trigger.reason === "random"
    || trigger.reason === "ambient_pickup"
    || trigger.reason === "lingering_attention";
}

async function processTriggeredMessage(
  message: Message,
  triggerOverride?: NonNullable<TriggerResult>,
  currentTurnMessages: readonly Message[] = [message],
  options: {
    disableLiveOutput?: boolean;
    currentTurnOverride?: {
      messageId: string;
      timestamp: number;
      content: string;
    };
    preSendCheck?: (draftText: string) => boolean | Promise<boolean>;
    onWriteToolStart?: (toolName: string) => void;
    abortSignal?: AbortSignal;
    onActionCommitted?: () => void;
    eventWatchTurn?: EventWatchTurn;
  } = {},
): Promise<DispatchOutcome> {
  if (message.guild === null || message.guildId === null) return { coveredMessageIds: [] };
  const guild = message.guild;

  const guildId = message.guildId;
  const channelId = message.channelId;
  requestLogStore.incrementActive();
  const requestLog = new RequestLog(guildId, channelId, requestLogStore);
  requestLog.setAuthor(message.author.username);
  // Keep the dashboard's active row identifiable before the agent turn completes.
  requestLog.setTrigger(triggerOverride ?? null);
  let requestLogEmitted = false;
  let activeTyping: ReturnType<typeof createTypingController> | null = null;

  try {
    const guildConfig = getGuildConfig(guildId);
    const inboundResolvers = buildInboundResolvers(guild);
    const displayContent = messageDisplayContent(message.content, message.components, message.author.username, message.embeds);
    const translatedContent = appendStickerTags(
      translateInbound(displayContent, inboundResolvers),
      message.stickers.values(),
    );
    const currentTurnEventContent = options.currentTurnOverride?.content ?? currentTurnMessages
      .map((current) => appendStickerTags(
        translateInbound(messageDisplayContent(current.content, current.components, current.author.username, current.embeds), inboundResolvers),
        current.stickers.values(),
      ))
      .filter((content) => content !== "")
      .join(" [msg-break] ");
    requestLog.setTriggerContext({
      ...dashboardTriggerLocation(guild, message.channel),
      messageId: options.currentTurnOverride?.messageId ?? message.id,
      authorUsername: message.author.username,
      content: options.currentTurnOverride?.content ?? displayContent,
      translatedContent: options.currentTurnOverride?.content ?? translatedContent,
    });
    const currentChannelObj = message.channel as SendableGuildChannel;
    const resolveTargetChannel = createTargetChannelResolver(client, currentChannelObj);
    const typing = createTypingController({
      defaultChannel: currentChannelObj,
      resolveTargetChannel,
    });
    activeTyping = typing;
    const typingStartDelayMs = typingSimulationDelayMs(guildConfig.typingSimulation, "input", currentTurnEventContent);
    if (guildConfig.typingSimulation.enabled) {
      typing.scheduleStartLoop(typingStartDelayMs);
    } else {
      typing.startLoop();
    }
    const baseSender = createBotDiscordMessageSender({
      defaultChannel: currentChannelObj,
      resolveTargetChannel,
      botUserId: client.user?.id ?? "",
      botUsername: client.user?.username ?? "bot",
      logger: log,
      ...(options.currentTurnOverride === undefined ? { replySourceMessage: message } : {}),
      getLastTypingAt: typing.getLastTypingAt,
      routedFrom: {
        routedFromGuildId: guildId,
        routedFromChannelId: channelId,
        routedFromMessageId: message.id,
      },
    });
    const sentBotMessageIds: string[] = [];
    const sender: MessageSender = async (...args) => {
      const result = await baseSender(...args);
      if (result.sentMessageId !== "") {
        sentBotMessageIds.push(result.sentMessageId);
        const destinationChannelId = args[2] ?? channelId;
        getAmbientRuntime().markAmbientPickupChannelCooldown(guildConfig.ambientAttention, guildId, destinationChannelId);
        getAmbientRuntime().clearPendingAmbientKindInChannel("ambient_pickup", guildId, destinationChannelId);
      }
      return result;
    };
    let externalVisibleOutputSent = false;
    let noteExternalVisibleOutput = (): void => {};
    const markExternalVisibleOutput = (): void => {
      externalVisibleOutputSent = true;
      noteExternalVisibleOutput();
    };

    const currentAssets = options.currentTurnOverride === undefined
      ? currentTurnMessages.flatMap((current) => getAssetsByMessageId(db, current.id))
      : [];
    const currentTurnBoundary = options.currentTurnOverride !== undefined
      ? { timestamp: options.currentTurnOverride.timestamp, messageId: options.currentTurnOverride.messageId }
      : currentTurnMessages.reduce<CurrentTurnBoundary>(
        (earliest, current) => {
          if (
            current.createdTimestamp < earliest.timestamp ||
            (current.createdTimestamp === earliest.timestamp && current.id < earliest.messageId)
          ) {
            return { timestamp: current.createdTimestamp, messageId: current.id };
          }
          return earliest;
        },
        { timestamp: message.createdTimestamp, messageId: message.id },
      );
    const currentTurnMessageIds = options.currentTurnOverride !== undefined
      ? [options.currentTurnOverride.messageId]
      : [...new Set(currentTurnMessages.map((current) => current.id))];
    const repliedToBotRouteSource = message.reference?.messageId !== undefined
      ? getRoutedMessageSource(db, {
          messageId: message.reference.messageId,
          guildId,
          channelId,
        })
      : null;
    const latestUserMessage: HistoryMessage = {
      id: options.currentTurnOverride?.messageId ?? message.id,
      author: message.author.username,
      authorDisplayName: authorDisplayName(message),
      authorId: message.author.id,
      content: options.currentTurnOverride?.content ?? translatedContent,
      isBot: message.author.bot,
      ...(message.webhookId !== null ? { webhookId: message.webhookId } : {}),
      timestamp: options.currentTurnOverride?.timestamp ?? message.createdTimestamp,
      replyToId: options.currentTurnOverride === undefined ? message.reference?.messageId ?? null : null,
      assets: currentAssets.map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        sourceKind: asset.sourceKind,
        filename: asset.filename,
        contentType: asset.contentType,
        size: asset.size,
        width: asset.width,
        height: asset.height,
        durationSeconds: asset.durationSeconds,
        ...(asset.originalAssetId !== undefined ? { originalAssetId: asset.originalAssetId } : {}),
      })),
      hasEmbeds: options.currentTurnOverride === undefined && message.embeds.length > 0,
      isSynthetic: options.currentTurnOverride !== undefined,
      relatedThreadId: null,
    };

    const replyFallbackDeps = createDiscordReplyFallbackDeps({
      db,
      clientChannelsFetch: (chId) => client.channels.fetch(chId),
      guild,
      guildId,
      channelId,
      guildConfig,
    });

    const isThread = message.channel.isThread();
    preparePersonaModeTurn(guildId);
    const context = await buildContext(
      guildId,
      channelId,
      guild,
      guildConfig,
      options.currentTurnOverride?.content ?? translatedContent,
      latestUserMessage,
      replyFallbackDeps,
      isThread,
      currentTurnBoundary,
      "live",
      options.currentTurnOverride !== undefined ? currentTurnMessageIds : undefined,
      {
        appendLatestToHistory: options.currentTurnOverride !== undefined,
        ...(triggerOverride !== undefined && isMessageBackedTrigger(triggerOverride)
          ? { triggerMessageIds: currentTurnMessageIds }
          : {}),
      },
    );
    if (options.eventWatchTurn !== undefined) {
      const watchLines = options.eventWatchTurn.watches.flatMap((watch) => [
        `Watch ${watch.id}: ${watch.instruction}`,
        `Previous handoff: ${watch.handoffNote.trim() === "" ? "(none)" : watch.handoffNote.trim()}`,
      ]);
      context.sections.push({
        label: "Event Watch",
        role: "developer",
        cached: false,
        text: [
          "## Event Watch",
          runtimeContextTemplate("event-watch-execution-mode", {}, "Act on this matched watch only if it still matters."),
          options.eventWatchTurn.ordinaryTrigger === undefined
            ? ""
            : `This watched message also triggered ordinary attention through ${formatTriggerReason(options.eventWatchTurn.ordinaryTrigger)}. Handle both reasons in this action turn.`,
          ...watchLines,
        ].filter((line) => line !== "").join("\n"),
      });
    }

    const startThreadTool = createStartThreadTool({
      guildId,
      createThread: async (name: string) => {
        const thread = await message.startThread({ name });
        return {
          threadId: thread.id,
          threadName: thread.name,
          parentChannelId: channelId,
          starterMessageId: message.id,
        };
      },
      persistThread: (input) => upsertThread(db, {
        threadId: input.threadId,
        guildId: input.guildId,
        parentChatId: input.parentChannelId,
        starterMessageId: input.starterMessageId,
        threadName: input.threadName,
        createdByBot: true,
      }),
      onPersistError: (err) => {
        log.error("failed to persist thread record", {
          error: err instanceof Error ? err.message : String(err),
        });
      },
      onSuccess: (payload) => {
        try {
          insertSyntheticEvent(db, {
            id: crypto.randomUUID(),
            guildId,
            channelId: payload.parentChannelId,
            botUserId: client.user?.id ?? "",
            botUsername: client.user?.username ?? "bot",
            threadId: payload.threadId,
            threadName: payload.threadName,
          });
        } catch (err) {
          log.error("failed to insert synthetic event for thread", {
            threadId: payload.threadId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });
    const closeThreadTool = createCloseThreadTool({
      currentGuildId: guildId,
      currentChannelId: channelId,
      currentIsThread: isThread,
      lookupThread: (threadId) => {
        const row = getThread(db, threadId);
        if (row === null) return null;
        return {
          threadId: row.threadId,
          guildId: row.guildId,
          threadName: row.threadName,
          parentChannelId: row.parentChatId,
          createdByBot: row.createdByBot,
        };
      },
      closeThread: async (threadId) => {
        const resolved = await createTargetChannelResolver(client, currentChannelObj)(threadId);
        if (!resolved.isThread()) throw new Error("Target channel is not a thread.");
        await (resolved as ThreadChannel).setArchived(true, "closed by close_thread tool");
        return {
          threadId: resolved.id,
          threadName: resolved.name,
          parentChannelId: resolved.parentId ?? channelId,
        };
      },
      persistArchived: (threadId) => {
        markThreadArchived(db, threadId);
      },
    });
    const generatedImages = createGeneratedImageRuntime();
    const toolRequest = options.eventWatchTurn === undefined
      ? {
          requesterId: message.author.id,
          requesterUsername: message.author.username,
          sourceMessageId: message.id,
          sourceQuote: shortQuote(translatedContent),
        }
      : {
          requesterId: "event-watch",
          requesterUsername: client.user?.username ?? "persona",
          sourceMessageId: options.currentTurnOverride?.messageId ?? message.id,
          sourceQuote: shortQuote(options.currentTurnOverride?.content ?? translatedContent),
        };
    const agentTools = buildAgentTools(
      guildId,
      channelId,
      guildConfig,
      guild,
      context.contextMessageIds,
      generatedImages.onGeneratedImage,
      toolRequest,
      {
        visibleUserIds: context.visibleUserIds ?? [],
        onVisibleOutput: markExternalVisibleOutput,
        deliverDiceRoll: async (input) => {
          const result = await sender(
            input.text,
            false,
            undefined,
            undefined,
            input.signal,
            input.sourceMessageId,
            undefined,
            input.dedupeKey,
            {
              kind: "components_v2_card",
              accentColor: 0x8f73ff,
              componentId: input.componentId,
              history: { text: input.historyText },
            },
          );
          if (result.sentMessageId === "") throw new Error("Discord did not return a roll result message ID.");
          markExternalVisibleOutput();
          return { sentMessageId: result.sentMessageId };
        },
      },
    );
    const threadTools = options.currentTurnOverride === undefined
      ? applyRuntimeToolPrompts([startThreadTool, closeThreadTool], getPromptBundle().runtime)
      : [];
    const watchUpdateTool = options.eventWatchTurn === undefined
      ? []
      : [createUpdateCurrentEventWatchTool({
          db,
          watchIds: options.eventWatchTurn.watches.map((watch) => watch.id),
          onCompleted: (watchId) => getEventWatchRuntime().cancelWatch(watchId),
        })];
    const baseExtraTools = [...agentTools, ...threadTools, ...watchUpdateTool];
    const extraTools = options.onWriteToolStart !== undefined
      ? trackWriteToolStarts(baseExtraTools, options.onWriteToolStart)
      : baseExtraTools;

    const incoming: IncomingMessage = {
      content: options.currentTurnOverride?.content ?? message.content,
      guildId,
      guildName: guild.name,
      channelId,
      channelName: channelDisplayName(message.channel),
      authorId: message.author.id,
      authorUsername: message.author.username,
      authorDisplayName: authorDisplayName(message),
      authorGlobalName: message.author.globalName ?? message.author.displayName,
      authorIsBot: message.author.bot,
      botUserId: client.user?.id ?? "",
      ...messageTriggerMentionFields(message),
      translatedContent: options.currentTurnOverride?.content ?? translatedContent,
      eventContent: currentTurnEventContent !== "" ? currentTurnEventContent : translatedContent,
      currentContentInHistory: options.currentTurnOverride === undefined,
      messageId: options.currentTurnOverride?.messageId ?? message.id,
      ...(options.currentTurnOverride === undefined
        ? {
            replyToMessageId: message.reference?.messageId,
            repliedToBot: messageRepliesToOwnBot(message),
          }
        : { repliedToBot: false }),
      assets: latestUserMessage.assets,
      ...(repliedToBotRouteSource !== null
        ? {
            repliedToBotRouteSource: {
              sourceGuildId: repliedToBotRouteSource.routedFromGuildId,
              sourceChannelId: repliedToBotRouteSource.routedFromChannelId,
              sourceMessageId: repliedToBotRouteSource.routedFromMessageId,
              ...(repliedToBotRouteSource.handoff !== undefined
                && context.contextMessageIds?.includes(message.reference?.messageId ?? "") !== true
                ? { handoff: repliedToBotRouteSource.handoff }
                : {}),
            },
          }
        : {}),
    };
    const visibleMaintenanceTools = blockToolsExcept(createPostReplyMaintenanceTools({
      guild,
      guildConfig,
      memoryRequest: {
        sourceMessageId: options.currentTurnOverride?.messageId ?? message.id,
        userMessage: options.currentTurnOverride?.content ?? translatedContent,
        assistantReply: "",
        recentContext: "",
        context,
        incomingMessage: incoming,
        visibleReplySent: false,
      },
      currentUserId: message.author.id,
      currentUsername: message.author.username,
      sourceMessageId: options.currentTurnOverride?.messageId ?? message.id,
      sourceRequestId: requestLog.requestId,
    }), "", "visible reply mode");

    const tts = createTtsGenerator(guildConfig);

    const deps = createHandlerDeps({
      guildId,
      guildConfig,
      context,
      currentChannelId: channelId,
      sender,
      extraTools: [...extraTools, ...visibleMaintenanceTools],
      log: log.child({ guildId, channelId, requestId: requestLog.requestId }),
      requestLog,
      tts,
      generatedImages,
      resolveAssetAttachments: createAssetAttachmentResolver(guildId, guildConfig,
        log.child({ component: "stored-asset-attachments", guildId, channelId, requestId: requestLog.requestId })),
      overrides: {
        onTriggered: () => {
          if (!guildConfig.typingSimulation.enabled) typing.startLoop();
        },
        onStillWorking: (destinationChannelId) => { typing.startLoop(destinationChannelId); },
        getTypingStartedAt: typing.getTypingStartedAt,
        onVisibleOutput: typing.stopLoop,
        hasExternalVisibleOutput: () => externalVisibleOutputSent,
        onAgentEnd: typing.stopLoop,
        triggerOverride,
        forceTrigger: options.eventWatchTurn !== undefined ? true : undefined,
        disableLiveOutput: options.disableLiveOutput,
        preSendCheck: options.preSendCheck,
        abortSignal: options.abortSignal,
        onActionCommitted: options.onActionCommitted,
        onIgnoredReply: ({ channelId: destinationChannelId, historyText }) => {
          persistIgnoredBotReply({
            guildId,
            channelId,
            destinationChannelId,
            botUserId: client.user?.id ?? "",
            botUsername: client.user?.username ?? "bot",
            sourceMessageId: message.id,
            historyText,
          });
          getAmbientRuntime().clearAmbientLeaseForUser(guildId, destinationChannelId ?? channelId, message.author.id);
        },
        onHandoffDelivered: (handoff) => {
          insertPromptOnlyMessageHandoff(db, {
            sourceGuildId: guildId,
            sourceChannelId: channelId,
            sourceMessageId: message.id,
            destinationGuildId: handoff.destinationGuildId,
            destinationChannelId: handoff.destinationChannelId,
            routedMessageId: handoff.routedMessageId,
            botUserId: client.user?.id ?? "",
            botUsername: client.user?.username ?? "bot",
            handoff: handoff.handoff,
          });
        },
        afterReply: async (memoryRequest) => {
          if (options.currentTurnOverride !== undefined && options.eventWatchTurn !== undefined) return;
          await runMemoryPostReplyExtraction({
            guildConfig,
            memoryRequest,
            guild,
            channel: message.channel,
            sourceRequestId: requestLog.requestId,
            currentUserId: message.author.id,
            currentUsername: message.author.username,
          });
          await runRelationshipPostReplyExtraction({
            guildConfig,
            memoryRequest,
            guild,
            channel: message.channel,
            sourceRequestId: requestLog.requestId,
            source: "post_reply",
            currentUserId: message.author.id,
            currentUsername: message.author.username,
          });
          await runInnerThreadPostReplyExtraction({
            guildConfig,
            memoryRequest,
            guild,
            channel: message.channel,
            sourceRequestId: requestLog.requestId,
          });
        },
      },
    });
    noteExternalVisibleOutput = () => { deps.onVisibleOutput?.(); };

    try {
      await runLoggedAgentTurn({
        incoming,
        deps,
        requestLog,
        logger: log,
        afterSuccess: (result) => {
          persistPrivateThoughts({
            guildId,
            channelId,
            botUserId: client.user?.id ?? "",
            botUsername: client.user?.username ?? "bot",
            sourceMessageId: message.id,
            requestId: requestLog.requestId,
            thoughts: result.privateThoughts ?? [],
            maxChars: guildConfig.trim.messageCharLimit,
          });
          const botMessageId = sentBotMessageIds.at(-1);
          // Attachment-only and intermediate-only replies have no response text;
          // the delivered Discord message is the durable signal for lingering attention.
          if (botMessageId === undefined) return;
          getAmbientRuntime().noteAmbientBotReply({
            guildId,
            channelId,
            userId: message.author.id,
            sourceMessageId: message.id,
            botMessageId,
            message,
            allowLease: triggerOverride?.reason === "mention" ||
              triggerOverride?.reason === "keyword" ||
              triggerOverride?.reason === "ambient_pickup" ||
              triggerOverride?.reason === "lingering_attention",
            allowFollowUp: triggerOverride?.reason === "mention" || triggerOverride?.reason === "keyword",
          });
        },
        onFinally: (completed, error) => {
          typing.stopLoop();
          if (error instanceof DispatchSupersededError) return;
          const completedTrigger = completed?.triggerResult ?? triggerOverride;
          if (
            completedTrigger?.reason === "mention" ||
            completedTrigger?.reason === "keyword" ||
            completedTrigger?.reason === "random"
          ) {
            getAmbientRuntime().clearAmbientNormalTriggerInFlight(guildId, channelId, message.author.id);
          }
        },
      });
    } finally {
      requestLogEmitted = true;
    }
    return {
      coveredMessageIds: currentTurnMessageIds,
      visibleOutputSent: sentBotMessageIds.length > 0 || externalVisibleOutputSent,
    };
  } catch (err) {
    if (err instanceof DispatchSupersededError) {
      log.debug("message turn superseded before model action", {
        messageId: message.id,
        guildId: message.guildId,
      });
      return { coveredMessageIds: [] };
    }
    if (!requestLogEmitted) {
      requestLog.setError(err instanceof Error ? err.message : String(err));
      requestLog.emit(log);
      requestLogEmitted = true;
    }
    log.error("messageCreate handler error", {
      messageId: message.id,
      guildId: message.guildId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { coveredMessageIds: [] };
  } finally {
    activeTyping?.stopLoop();
    requestLogStore.decrementActive();
  }
}


  return { dispatchers, getOrCreateDispatcher, evaluateMessageTrigger, normalizedWatchMessage, processEventWatchTurn, processSettledWatchedMessage, processTriggeredMessage };
}
