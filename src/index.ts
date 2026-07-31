import { createLogger, RequestLog, type LogLevel, type Logger } from "./logger";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { requestLogStore } from "./dashboard/store";
import { parseDashboardPasswordlessCidrs } from "./dashboard/auth";
import { startDashboard } from "./dashboard/server";
import { loadGlobalConfig, loadGuildConfigs, resolveGuildConfig, validateTrimConfig, validateVpnConfig } from "./config/loader";
import type { GuildConfig } from "./config/types";
import { createDatabase } from "./db/database";
import { createDiscordClient, loginDiscordClient } from "./discord/client";
import { buildDiscordContext } from "./discord/context-renderer";
import { registerInteractionRuntime } from "./discord/interaction-runtime";
import { translateInbound, translateOutbound, buildDisplayNameContext, type InboundResolvers, type OutboundResolvers } from "./discord/translation";
import { splitMessage } from "./discord/split-message";
import { EmojiCache, buildEmojiContext, type EmojiEntry } from "./discord/emoji-cache";
import { guildEmojiEntries, registerEmojiCacheSync, syncGuildEmojiCache } from "./discord/emoji-cache-sync";
import { appendStickerTags, messageDisplayContent } from "./discord/message-media";
import { assetsFromDiscordMessage } from "./discord/message-assets";
import { botChannelPermissions, channelDisplayName, channelTypeLabel, createDiscordMessageSender, createTargetChannelResolver, createTypingController, fetchAccessibleGuildChannel as fetchAccessibleDiscordGuildChannel, isSendableGuildChannel, type SendableGuildChannel } from "./discord/message-sender";
import { createSchedulerEngine, type SchedulerEngine } from "./scheduler/engine";
import { createScheduledTaskRunner } from "./scheduler/scheduled-task-runtime";
import { handleMessage } from "./agent/handler";
import { runSilentMemoryAgentPass, runSilentToolAgentPass } from "./agent/maintenance-pass";
import { hasMaintenanceMaterial, type HandleResult, type AssetAttachmentResolver, type IncomingMessage, type HandlerDeps, type MemoryExtractionRequest, type MessageSender, type OutboundAttachment } from "./agent/turn-types";
import { trackWriteToolStarts } from "./agent/tool-access";
import {
  contentMentionsEveryone,
  shouldRespond,
  shouldRespondDeliberately,
  type TriggerInput,
  type TriggerResult,
} from "./agent/triggers";
import { typingSimulationDelayMs } from "./agent/typing-simulation";
import { createChannelDispatcher, DispatchSupersededError, selectDispatchMessageForTrigger, selectDispatchMessagesForTrigger, selectNormalDispatchTrigger, type ChannelDispatcher, type DispatchOutcome } from "./discord/channel-dispatcher";
import { assembleContext, type AssembledContext, type ThreadMetadata } from "./agent/context-assembly";
import { PRIVATE_HANDOFF_MESSAGE_ID_PREFIX, PRIVATE_THOUGHT_MESSAGE_ID_PREFIX, type HistoryMessage } from "./agent/history-types";
import { getLatestMessageActivityBefore, listDiscordChannelUsage, type MessageActivity } from "./db/message-activity-repository";
import { getContextHistoryMessages, getParentPreContext, listChannelMessages } from "./db/message-history-repository";
import { getMessageSearchMatchesByIds } from "./db/message-search-repository";
import { getRoutedMessageSource, insertPromptOnlyBotMessage, insertPromptOnlyMessageHandoff, insertSyntheticEvent, upsertBotMessageContent } from "./db/message-state-repository";
import { cleanupDeletedDiscordMessage } from "./db/message-cleanup";
import {
  countMessagesSinceMemoryExtraction,
  getMemoryExtractionCheckpoint,
  getMessagesSinceMemoryExtraction,
  markMemoryExtractionCheckpoint,
  markMemoryExtractionCheckpointAtMessage,
} from "./db/memory-extraction-repository";
import { processHistory } from "./agent/history-pipeline";
import { normalizeWhitespace, trimMessages } from "./agent/history-trimming";
import { formatHistoryContent, formatMessageLine, OLDER_LEGEND } from "./agent/history-formatting";
import { insertDateStamps } from "./agent/history-dates";
import { formatRelativeAgo } from "./agent/history-dates";
import { currentLocalContext, formatElapsedDuration } from "./time/agent-time";
import type { ReplyFallbackDeps } from "./agent/reply-target-fallback";

import { createElevenLabsClient, type ElevenLabsClient } from "./tts/client";
import type { TtsResult } from "./tts/types";
import { buildMemoryContext, buildMemoryMaintenanceContext, buildPrivateLifeMemoryContext, buildVisibleUserMemoryContext } from "./agent/memory-context";
import { createRecordMemoryTool } from "./agent/memory-extraction";
import { buildRepertoireContext } from "./agent/repertoire-context.ts";
import { createSearchChannelMessagesTool } from "./agent/search-channel-messages-tool";
import { createScheduleTools } from "./agent/schedule-tool";
import { createEventWatchTools } from "./agent/event-watch-tool.ts";
import { createChatUserListTool, type MemberInfo } from "./agent/member-list-tool";
import { createChannelListTool, type ChannelInfo } from "./agent/channel-list-tool";
import { createEmojiListTool } from "./agent/emoji-list-tool";
import { createDiscordTimeoutTools, type TimeoutMember, type TimeoutMemberResolution } from "./agent/timeout-user-tool";
import { createSearchMemoriesTool } from "./agent/search-memories-tool";
import { buildNotebooksContext, createNotebookTools } from "./agent/notebook-service.ts";
import { buildInnerThreadMaintenanceContext, buildInnerThreadsContext, createListInnerThreadsTool, createRecordInnerThreadsTool } from "./agent/inner-thread-service";
import { listInnerThreads } from "./db/inner-thread-repository";
import { createListChannelMessagesTool } from "./agent/list-channel-messages-tool";
import { createOwnMessageTools } from "./agent/own-message-tool";
import { createBraveImageSearchTool, createBraveSearchTool } from "./agent/brave-search-tool";
import { createReadAssetTool, extractPdfText, extractRemoteVideoFrame, type ReadAssetToolDeps } from "./agent/read-asset-tool";
import { createSearchAssetTool } from "./agent/search-asset-tool";
import { createReadUserAvatarTool, type AvatarSize } from "./agent/read-user-avatar-tool";
import { createFetchImagesTool } from "./agent/fetch-images-tool";
import { loadExternalImage } from "./agent/external-image";
import { createCodexGenerateImageTool, type GeneratedImageAttachment, type ReferenceImageInput } from "./agent/codex-image-tool";
import { AgentJobStore, createCancelAgentJobTool, isActiveJobStatus, type ImageGenerationJobResult } from "./agent/job-runtime";
import { createAgentJobInspectionTools, renderAgentJobDetails } from "./agent/agent-job-tool";
import { annotateHistoryJobs, buildAsyncImageReadyMetadata, createGeneratedImageRuntime, imageReferencesForToolInput, renderAgentJobsContext, renderImageGenerationInput, shortQuote, type GeneratedImageRuntime } from "./agent/generated-image-runtime";
import { createStoredAssetAttachmentResolver } from "./agent/stored-asset-attachments";
import { loadAssetReferenceImage, loadStagedAssetReferenceImage, resolvedLinkReferenceImage } from "./agent/asset-reference-image";
import { createFetchUrlTool } from "./agent/fetch-url-tool";
import { LinkContentCache, resolveLinkContent } from "./agent/link-content.ts";
import { createSummarizeVideoTool } from "./agent/summarize-video-tool";
import { createCloseThreadTool, createStartThreadTool } from "./agent/start-thread-tool";
import { createReactToMessageTool } from "./agent/react-to-message-tool";
import { createDiceRollTool, type DiceRollDelivery } from "./agent/dice-roll-tool";
import { applyRuntimeToolPrompts } from "./agent/runtime-tool-prompts";
import {
  isReadOnlyTool,
  isToolAllowedInMaintenance,
  type MaintenanceWriteToolName,
} from "./agent/tool-effects.ts";
import { createSearchToolsTool } from "./agent/tool-catalog.ts";
import {
  commitStagedMaintenanceCalls,
  SemanticMaintenanceCoordinator,
  stageMaintenanceTools,
  type StagedMaintenanceCall,
} from "./agent/semantic-maintenance-coordinator.ts";
import { createModelImageSupportStore } from "./llm/model-image-support";
import { resolveModelProfile } from "./llm/client";
import { createAmbientRuntime } from "./ambient/runtime";
import { createPrivateLifeRuntime } from "./private-life/runtime.ts";
import { createPrivateLifeSummaryTool } from "./private-life/summary-tool.ts";
import {
  PRIVATE_LIFE_ACTION_SCOPES,
  PRIVATE_LIFE_ATTENTION_ORIGINS,
  PRIVATE_LIFE_CURIOSITY_MODES,
  PRIVATE_LIFE_TERRITORIES,
} from "./private-life/types.ts";
import { clearExpiredPrivateLifeThoughts } from "./db/private-life-repository.ts";
import { createPersonaModeRuntime } from "./modes/runtime";
import type { PersonaModeActivityType } from "./modes/types";
import { cacheAssetExtraction, getAssetById, getAssetsByMessageId, syncMessageAssets } from "./db/asset-repository";
import {
  getEventWatch,
  listEventWatches,
  listPendingWatchMessageIds,
  markWatchMessageProcessed,
} from "./db/event-watch-repository.ts";
import { createWatchMatcher } from "./event-watch/matcher.ts";
import { createEventWatchRuntime, type EventWatchTurn } from "./event-watch/runtime.ts";
import { createUpdateCurrentEventWatchTool } from "./event-watch/current-watch-tool.ts";
import { DEFAULT_EVENT_WATCH_PRESSURE, type NormalizedWatchEvent } from "./event-watch/types.ts";
import {
  normalizeDiscordWatchMessage,
  registerEventWatchDiscordAdapters,
  type EventWatchDiscordAdapters,
} from "./event-watch/discord-adapters.ts";
import {
  createStagedAsset,
  deleteStagedAsset,
  getStagedAsset,
  getStagedAssetForJob,
  listStagedAssets,
  reconcileStagedAsset,
} from "./db/staged-asset-repository";
import { upsertThread, updateThreadActivity, markThreadArchived, listThreadsForContext, getThreadMetadata, getThread } from "./db/thread-repository";
import { prepareImageBufferForContext } from "./agent/image-buffer";
import { deleteExpiredMemories, countUserMemoriesByUser } from "./db/memory-repository";
import { createRelationshipsManagementApi } from "./dashboard/relationships-management";
import { createDashboardManagementRuntime, dashboardTriggerLocation } from "./dashboard/management-runtime";
import { createPromptLabRunner, promptLabDryRunTools, promptLabSummary, promptLabSyntheticId } from "./dashboard/prompt-lab-runtime";
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
} from "./relationships";
import { listUpcomingForContext } from "./db/schedule-repository";
import { registerGuildSlashCommands, registerSlashCommands } from "./commands/registry";
import { statusCommandDefinition } from "./commands/status";
import { scheduleCommandDefinition } from "./commands/schedule";
import { memoryWipeCommandDefinition } from "./commands/memory-wipe";
import { vpnCommandDefinition } from "./commands/vpn";
import { voiceTestCommandDefinition } from "./commands/voice-test.ts";
import { createVpnClient, type VpnClient } from "./vpn/api-client";
import { createSessionStore, type SessionStore } from "./vpn/session";
import { loadInstructionBundle, type PromptBundle } from "./config/instruction-bundle";
import { inspectPromptScenario, type PromptScenarioId } from "./config/prompt-inspector";
import { requireProfileConfigPath } from "./config/profile";
import { renderPromptTemplate } from "./config/prompt-template";
import { resolveReactionEmojiInput } from "./discord/reaction-emoji";
import { createDiscordReplyFallbackDeps, createSyntheticReplyFallbackDeps, syncDeletedOwnBotMessage, syncEditedOwnBotMessage } from "./discord/reply-fallback-runtime";
import { createDiscordAssetSourceResolver } from "./discord/asset-resolver";
import { backfillMessageAssets } from "./discord/asset-backfill";
import { fetchMessagesAfterRestart } from "./discord/restart-catchup";
import { clearRestartRecoveryState, getRestartRecoveryState, listRecentDiscordChannels, setRestartRecoveryCutoff } from "./db/restart-recovery-repository";
import { AsyncTaskTracker } from "./runtime/async-task-tracker";
import { DEFAULT_ASSET_READING, DEFAULT_EXTERNAL_IMAGES } from "./config/defaults";
import { join } from "path";
import { mkdirSync, existsSync, readdirSync, statSync, watch, type FSWatcher } from "fs";
import { unlink } from "fs/promises";
import type { Database } from "./db/database";
import { ActivityType, ChannelType, PermissionFlagsBits, type Client, type Guild, type GuildBasedChannel, type GuildMember, type Message, type TextChannel, type ThreadChannel, type Typing } from "discord.js";
import { renderVoiceHistory, renderVoiceMoveHandoff } from "./voice/history.ts";
import { compactVoiceMaintenance, createVoiceSummaryTool } from "./voice/maintenance.ts";
import {
  VoiceRepository,
} from "./voice/repository.ts";
import { VoiceRuntime, type VoiceTurnRequest } from "./voice/runtime.ts";
import { createVoiceTools } from "./voice/tools.ts";

const pkg = await Bun.file(new URL("../package.json", import.meta.url).pathname).json() as { version?: string };
const CONTEXT_IMAGE_MAX_DIMENSION = 1024;
const version: string = pkg.version ?? "0.0.0";

const startTime = Date.now();
const logLevel = (process.env.LOG_LEVEL ?? "info") as LogLevel;
const log = createLogger({ level: logLevel });

const TYPING_INTERVAL_MS = 8_000;
const RESTART_CATCHUP_MAX_AGE_MS = 30 * 60_000;
const RESTART_CATCHUP_MAX_CHANNELS = 50;
const RESTART_CATCHUP_MAX_MESSAGES_PER_CHANNEL = 500;

const inboundMessageTasks = new AsyncTaskTracker();
const imageJobTasks = new AsyncTaskTracker();
const backgroundTasks = new AsyncTaskTracker();
const assetBackfillController = new AbortController();
let acceptingDiscordMessages = true;

const configuredProfile = process.env.PROFILE?.trim();
if (configuredProfile === undefined || configuredProfile === "") {
  throw new Error("PROFILE is required (for example, PROFILE=2b or PROFILE=delamain)");
}
const profile = configuredProfile;
const profilesDir = "profiles";
const profileDir = join(profilesDir, profile);
const configPath = requireProfileConfigPath(profilesDir, profile);
const guildsDir = join(profileDir, "guilds");
let globalConfig = loadGlobalConfig(process.env, configPath);
validateTrimConfig(globalConfig.defaultTrim);
validateVpnConfig(globalConfig.vpn);
log.info("profile loaded", {
  profile,
  modelProfile: globalConfig.defaultModelProfile,
  model: resolveModelProfile(globalConfig, globalConfig.defaultModelProfile).model,
  configPath,
});

async function loadExternalReference(url: string, signal?: AbortSignal): Promise<ReferenceImageInput> {
  const image = await loadExternalImage(url, globalConfig.externalImages ?? DEFAULT_EXTERNAL_IMAGES, {}, signal);
  return {
    id: image.finalUrl,
    data: image.preview.toString("base64"),
    mimeType: image.previewMimeType,
    width: image.width,
    height: image.height,
  };
}

/** Resolve a current guild display avatar as an ephemeral image-generation reference. */
async function loadGuildAvatarReference(guild: Guild, userId: string, signal?: AbortSignal): Promise<ReferenceImageInput | null> {
  const member = await resolveGuildMemberReference(guild, userId);
  if (member === undefined) return null;
  const url = member.displayAvatarURL({ extension: "png", forceStatic: true, size: 2048 });
  const image = await loadExternalReference(url, signal);
  return { ...image, id: `avatar:${userId}` };
}

const startupMessageQueue: Message[] = [];
let startupMessageProcessingReady = false;
let startupMessageQueueDraining = false;

const client: Client = createDiscordClient(globalConfig, log);
client.on("messageCreate", handleMessageCreateEvent);
const discordLoginPromise = loginDiscordClient(client, globalConfig.discordToken);
void discordLoginPromise.catch(() => {});

// --- 2. Ensure data directory exists ---
if (!existsSync(globalConfig.dataDir)) {
  mkdirSync(globalConfig.dataDir, { recursive: true });
}

// --- 3. Init SQLite ---
const dbPath = join(globalConfig.dataDir, "bot.db");
const db: Database = createDatabase(dbPath);
const linkContentCache = new LinkContentCache();
log.info("database ready", { path: dbPath });

function discordActivityType(type: PersonaModeActivityType): ActivityType {
  const types: Record<PersonaModeActivityType, ActivityType> = {
    playing: ActivityType.Playing,
    streaming: ActivityType.Streaming,
    listening: ActivityType.Listening,
    watching: ActivityType.Watching,
    custom: ActivityType.Custom,
    competing: ActivityType.Competing,
  };
  return types[type];
}

const personaModeRuntime = createPersonaModeRuntime({
  db,
  config: globalConfig.personaModes,
  timezone: globalConfig.defaultTimezone,
  log: log.child({ component: "persona-modes" }),
  trackBackgroundTask: (task) => {
    void backgroundTasks.track(task);
  },
  guildIds: () => [...client.guilds.cache.keys()],
  presentation: {
    global: {
      currentAvatarHash: () => client.user?.avatar ?? null,
      applyAvatar: async (candidate) => {
        const user = client.user;
        if (user === null) throw new Error("Discord client is not ready");
        const bytes = Buffer.from(await Bun.file(candidate.path).arrayBuffer());
        const updated = await user.setAvatar(bytes);
        return { discordAvatarHash: updated.avatar };
      },
      applyPresence: (presence) => {
        const user = client.user;
        if (user === null) throw new Error("Discord client is not ready");
        user.setPresence({
          status: presence?.status ?? "online",
          activities: presence?.activity === undefined
            ? []
            : [{
                type: discordActivityType(presence.activity.type),
                name: presence.activity.name,
                ...(presence.activity.state !== undefined ? { state: presence.activity.state } : {}),
                ...(presence.activity.url !== undefined ? { url: presence.activity.url } : {}),
              }],
        });
      },
    },
    guild: {
      currentAvatarHash: (guildId) => client.guilds.cache.get(guildId)?.members.me?.avatar ?? null,
      applyAvatar: async (guildId, candidate) => {
        const guild = client.guilds.cache.get(guildId);
        if (guild === undefined) throw new Error(`Discord guild ${guildId} is not available`);
        const avatar = candidate === null
          ? null
          : Buffer.from(await Bun.file(candidate.path).arrayBuffer());
        const updated = await guild.members.editMe({ avatar });
        return { discordAvatarHash: updated.avatar };
      },
    },
  },
});
client.on("shardResume", () => personaModeRuntime.reapplyPresentation());

// --- 4. Load guild configs ---
const guildConfigs = loadGuildConfigs(guildsDir, globalConfig);
log.info("guild configs loaded", { count: guildConfigs.size });

const agentJobs = new AgentJobStore(db, globalConfig.defaultAgentJobs);

const modelImageSupport = createModelImageSupportStore({ log });
await modelImageSupport.refresh(globalConfig, guildConfigs, "startup");

// --- 8. Load shared instructions plus the selected profile overlay.
let promptBundle: PromptBundle = loadInstructionBundle(profilesDir, profile, log);

function runtimeToolDescription(
  toolName: string,
): string | undefined {
  return promptBundle.runtime.toolDescriptions[toolName];
}

function runtimeContextTemplate(
  name: string,
  variables: Record<string, string | number | boolean | undefined> = {},
  fallback = "",
): string {
  const template = promptBundle.runtime.contextTemplates[name];
  return template === undefined ? fallback : renderPromptTemplate(template, variables);
}

function defaultPersonaModeForMaintenance(): {
  id: string;
  instructions: string;
} {
  const config = globalConfig.personaModes;
  const mode = config?.modes.find((candidate) => candidate.id === config.defaultModeId);
  return {
    id: config?.defaultModeId ?? "default",
    instructions: mode?.instructions ?? "",
  };
}

// --- 9. Emoji cache ---
const emojiCache = new EmojiCache();
const EMOJI_TTL_MS = 10 * 60 * 1000; // 10 minutes
registerEmojiCacheSync(client, emojiCache);

// --- 9b. TTS client (optional) ---
let ttsClient: ElevenLabsClient | undefined;
if (globalConfig.elevenLabsApiKey !== undefined && globalConfig.elevenLabsApiKey !== "") {
  ttsClient = createElevenLabsClient({ apiKey: globalConfig.elevenLabsApiKey });
  log.info("tts client ready");
}

// --- 9c. VPN client and session store ---
const vpnConfig = globalConfig.vpn;
const vpnEnabled = vpnConfig !== undefined;
const vpnClient: VpnClient | null = vpnEnabled ? createVpnClient(vpnConfig.apiUrl) : null;
const vpnSessionStore: SessionStore = createSessionStore();

if (vpnEnabled) {
  log.info("vpn client ready", { apiUrl: vpnConfig.apiUrl });
} else {
  log.info("vpn disabled");
}

// Periodic VPN session cleanup (every 5 minutes)
const VPN_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const vpnSessionCleanupTimer = setInterval(() => {
  vpnSessionStore.cleanExpired();
}, VPN_SESSION_CLEANUP_INTERVAL_MS);

// --- 10. Guild config resolver ---
function getGuildConfig(guildId: string): GuildConfig {
  const existing = guildConfigs.get(guildId);
  if (existing !== undefined) return existing;
  // Resolve default-only guilds on demand so global hot-reload changes such as
  // TTS settings cannot be hidden behind a stale cached default config.
  return resolveGuildConfig(globalConfig, { guildId, slug: "" });
}

function getRelationshipConfig(guildConfig: GuildConfig): RelationshipConfig {
  const config = guildConfig.relationships ?? globalConfig.defaultRelationships;
  if (config === undefined) throw new Error("relationships is not configured");
  return config;
}

function innerThreadsEnabled(guildConfig: GuildConfig): boolean {
  return (guildConfig.innerThreads ?? globalConfig.defaultInnerThreads)?.enabled !== false;
}

function notebooksEnabled(guildConfig: GuildConfig): boolean {
  return (guildConfig.notebooks ?? globalConfig.defaultNotebooks)?.enabled === true;
}

const SCHEDULED_ATTENTION_COOLDOWN_MS = 30_000;
const scheduledAttentionBusy = new Map<string, number>();

function scheduledAttentionKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

function markScheduledAttentionBusy(guildId: string, channelId: string): () => void {
  const key = scheduledAttentionKey(guildId, channelId);
  scheduledAttentionBusy.set(key, Number.POSITIVE_INFINITY);
  return () => {
    scheduledAttentionBusy.set(key, Date.now() + SCHEDULED_ATTENTION_COOLDOWN_MS);
  };
}

function isScheduledAttentionBusy(guildId: string, channelId: string): boolean {
  const until = scheduledAttentionBusy.get(scheduledAttentionKey(guildId, channelId));
  if (until === undefined) return false;
  if (until === Number.POSITIVE_INFINITY || until > Date.now()) return true;
  scheduledAttentionBusy.delete(scheduledAttentionKey(guildId, channelId));
  return false;
}

// --- 12. Init scheduler ---
const watchMatcher = createWatchMatcher({
  db,
  pressure: DEFAULT_EVENT_WATCH_PRESSURE,
  getTimezone: (guildId) => getGuildConfig(guildId).timezone,
  onMetrics: (metrics, event) => {
    log.debug("event watch match complete", {
      eventType: event.type,
      eventKey: event.eventKey,
      ...metrics,
    });
  },
});

const eventWatchRuntime = createEventWatchRuntime({
  db,
  matcher: watchMatcher,
  pressure: DEFAULT_EVENT_WATCH_PRESSURE,
  log: log.child({ component: "event-watch" }),
  onFire: processEventWatchTurn,
});
let eventWatchDiscordAdapters: EventWatchDiscordAdapters | null = null;

const scheduler: SchedulerEngine = createSchedulerEngine({
  db,
  onFire: createScheduledTaskRunner({
    client,
    db,
    requestLogStore,
    log,
    getGuildConfig,
    createSyntheticReplyFallbackDeps,
    buildContext,
    buildAgentTools,
    createVisibleMaintenanceTools: (maintenanceInput) => blockToolsExcept(
      createPostReplyMaintenanceTools(maintenanceInput),
      "",
      "visible reply mode",
    ),
    createBotDiscordMessageSender,
    createTtsGenerator,
    createHandlerDeps,
    resolveAssetAttachments: createAssetAttachmentResolver,
    runLoggedAgentTurn,
    runMemoryPostReplyExtraction,
    runRelationshipPostReplyExtraction,
    runInnerThreadPostReplyExtraction,
    onScheduleCompleted: (id) => scheduler.removeSchedule(id),
    markScheduledAttentionBusy,
    preparePersonaModeTurn: (guildId) => personaModeRuntime.prepareNaturalTurn(guildId),
  }),
  log,
});
scheduler.start();
log.info("scheduler started", { jobs: scheduler.activeCount() });

// --- Periodic expired memory cleanup (hourly) ---
const MEMORY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const memoryCleanupTimer = setInterval(() => {
  const deleted = deleteExpiredMemories(db);
  if (deleted > 0) {
    log.info("expired memories cleaned", { deleted });
  }
  const thoughtRetentionDays = globalConfig.privateLife?.thoughtRetentionDays ?? 0;
  const clearedThoughts = clearExpiredPrivateLifeThoughts(
    db,
    Date.now() - thoughtRetentionDays * 86_400_000,
  );
  if (clearedThoughts > 0) {
    log.info("expired private-life thoughts cleared", { clearedThoughts, thoughtRetentionDays });
  }
  const expiredStaged = listStagedAssets(db, { unresolvedOnly: true, limit: 500 })
    .filter((asset) => asset.expiresAt <= Date.now());
  for (const staged of expiredStaged) {
    agentJobs.markExpired(staged.jobId);
    void unlink(staged.storagePath).catch(() => {});
    deleteStagedAsset(db, staged.ref);
  }
  if (expiredStaged.length > 0) {
    log.info("expired staged assets cleaned", { deleted: expiredStaged.length });
  }
  const deletedAgentJobs = agentJobs.cleanup();
  if (deletedAgentJobs > 0) {
    log.info("expired unlinked agent jobs cleaned", { deleted: deletedAgentJobs });
  }
}, MEMORY_CLEANUP_INTERVAL_MS);

// --- 13. Wait for Discord client login ---
await discordLoginPromise;
personaModeRuntime.start();
eventWatchRuntime.start();
log.info("event watch runtime started");

// --- 14. Register slash commands ---
const botUser = client.user;
if (botUser !== null) {
  try {
    const commandCount = await registerSlashCommands({
      token: globalConfig.discordToken,
      clientId: botUser.id,
      commands: [
        statusCommandDefinition.toJSON(),
        scheduleCommandDefinition.toJSON(),
        memoryWipeCommandDefinition.toJSON(),
        vpnCommandDefinition.toJSON(),
      ],
    });
    log.info("slash commands registered", { count: commandCount });
    const voiceTestGuildIds = [...new Set([
      ...(globalConfig.defaultVoice?.testing.guildIds ?? []),
      ...[...guildConfigs.values()]
        .filter((config) => config.voice?.enabled === true && config.voice.testing.enabled)
        .flatMap((config) => config.voice?.testing.guildIds ?? []),
    ])];
    if (profile === "2b" && globalConfig.defaultVoice?.enabled === true && globalConfig.defaultVoice.testing.enabled && voiceTestGuildIds.length > 0) {
      const accessibleGuildIds = voiceTestGuildIds.filter((guildId) => client.guilds.cache.has(guildId));
      const skippedGuildIds = voiceTestGuildIds.filter((guildId) => !client.guilds.cache.has(guildId));
      if (accessibleGuildIds.length > 0) {
        const voiceCommandCount = await registerGuildSlashCommands({
          token: globalConfig.discordToken,
          clientId: botUser.id,
          guildIds: accessibleGuildIds,
          commands: [voiceTestCommandDefinition.toJSON()],
        });
        log.info("voice test slash command registered", { guilds: accessibleGuildIds.length, count: voiceCommandCount });
      }
      if (skippedGuildIds.length > 0) {
        log.warn("voice test slash command skipped inaccessible guilds", { guildIds: skippedGuildIds });
      }
    }
  } catch (err) {
    log.error("failed to register slash commands", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

registerInteractionRuntime({
  client,
  db,
  scheduler,
  getGlobalConfig: () => globalConfig,
  getGuildConfig,
  vpnClient,
  vpnSessionStore,
  vpnEnabled,
  startTime,
  log,
  voiceRuntime,
  isAcceptingEvents: () => acceptingDiscordMessages,
  trackTask: (task) => {
    void backgroundTasks.track(task);
  },
});

// --- 17. Build resolvers from a Discord guild ---
const ambientRuntime = createAmbientRuntime({
  db,
  client,
  log,
  requestLogStore,
  agentJobs,
  getPromptBundle: () => promptBundle,
  getGlobalConfig: () => globalConfig,
  typingIntervalMs: TYPING_INTERVAL_MS,
  getGuildConfig,
  dashboardTriggerLocation,
  buildInboundResolvers,
  createSyntheticReplyFallbackDeps,
  buildContext,
  buildAgentTools,
  createVisibleMaintenanceTools: ({
    guild,
    guildConfig,
    memoryRequest,
    sourceRequestId,
  }) => {
    const latestHuman = latestHumanIdentity(
      guild.id,
      memoryRequest.incomingMessage.channelId ?? "",
    );
    return blockToolsExcept(createPostReplyMaintenanceTools({
      guild,
      guildConfig,
      memoryRequest,
      currentUserId: latestHuman.userId,
      currentUsername: latestHuman.username,
      sourceMessageId: memoryRequest.sourceMessageId ?? promptLabSyntheticId(),
      sourceRequestId,
    }), "", "visible reply mode");
  },
  promptLabDryRunTools,
  promptLabSyntheticId,
  promptLabSummary,
  resolveClientGuild,
  fetchAccessibleGuildChannel,
  createBotDiscordMessageSender,
  createHandlerDeps,
  processTriggeredMessage,
  trackBackgroundTask: (task) => {
    void backgroundTasks.track(task);
  },
  isAutonomousAttentionBusy: isScheduledAttentionBusy,
  waitForSemanticMaintenance: () => semanticMaintenanceCoordinator.barrier(),
  preparePersonaModeTurn: (guildId) => personaModeRuntime.prepareNaturalTurn(guildId),
  runMaintenance: async ({
    guildConfig,
    request,
    guild,
    channel,
    sourceRequestId,
    dryRun,
    dryRuns,
  }) => {
    const latestHuman = latestHumanIdentity(guild.id, channel.id);
    const currentUserId = request.context.memoryFocusUserId ?? latestHuman.userId;
    const currentUsername = resolvePromptUsername(guild, currentUserId) ?? latestHuman.username;
    await runMemoryPostReplyExtraction({
      guildConfig,
      memoryRequest: request,
      guild,
      channel,
      sourceRequestId,
      source: "ambient_initiative",
      passKind: "ambient",
      currentUserId,
      currentUsername,
      dryRun,
      dryRuns,
    });
    await runRelationshipPostReplyExtraction({
      guildConfig,
      memoryRequest: request,
      guild,
      channel,
      sourceRequestId,
      source: "ambient_initiative",
      currentUserId,
      currentUsername,
      dryRun,
      dryRuns,
    });
    await runInnerThreadPostReplyExtraction({
      guildConfig,
      memoryRequest: request,
      guild,
      channel,
      sourceRequestId,
      dryRun,
    });
  },
});

const privateLifeRuntime = createPrivateLifeRuntime({
  db,
  client,
  log,
  requestLogStore,
  getPromptBundle: () => promptBundle,
  getGlobalConfig: () => globalConfig,
  getGuildConfig,
  resolveClientGuild,
  fetchAccessibleGuildChannel,
  createSyntheticReplyFallbackDeps,
  buildContext,
  buildAgentTools,
  createVisibleMaintenanceTools: ({
    episodeId,
    guild,
    guildConfig,
    memoryRequest,
    sourceRequestId,
  }) => blockToolsExcept(createPrivateLifeMaintenanceTools({
    episodeId,
    guild,
    guildConfig,
    memoryRequest,
    sourceRequestId,
    dryRun: true,
  }), "", "private-life actor mode"),
  createBotDiscordMessageSender,
  createHandlerDeps,
  promptLabDryRunTools,
  promptLabSyntheticId,
  promptLabSummary,
  runMaintenance: runPrivateLifeMaintenance,
  isBusy: (guildId, channelId) => isScheduledAttentionBusy(guildId, channelId)
    || requestLogStore.getActiveCount() > 0,
  activeRequestCount: () => requestLogStore.getActiveCount(),
  hasRecentVisibleOutput: (since) => {
    const botUserId = client.user?.id;
    if (botUserId === undefined) return true;
    return db.raw.prepare(`SELECT 1 FROM messages
      WHERE user_id = ? AND is_bot = 1 AND is_synthetic = 0
        AND is_prompt_only = 0 AND deleted_at IS NULL AND created_at >= ?
      LIMIT 1`).get(botUserId, since) !== null;
  },
});

// --- 21. Channel dispatcher ---
function promptLabUserFromGuild(guild: Guild, userId: string): {
  id: string;
  username: string;
  displayName?: string;
  globalName?: string;
} {
  const member = guild.members.cache.get(userId);
  const cachedUser = client.users.cache.get(userId);
  return {
    id: userId,
    username: member?.user.username ?? cachedUser?.username ?? dashboardManagementRuntime.userName(userId),
    ...(member?.displayName !== undefined ? { displayName: member.displayName } : {}),
    ...(member?.user.globalName !== null && member?.user.globalName !== undefined
      ? { globalName: member.user.globalName }
      : cachedUser?.globalName !== null && cachedUser?.globalName !== undefined
        ? { globalName: cachedUser.globalName }
        : {}),
  };
}

const runPromptLab = createPromptLabRunner({
  client,
  db,
  getPromptBundle: () => promptBundle,
  requestLogStore,
  log,
  getGuildConfig,
  getRelationshipConfig,
  resolveClientGuild,
  fetchAccessibleGuildChannel,
  buildInboundResolvers,
  buildContext,
  buildAgentTools,
  blockToolsExcept,
  createPostReplyMaintenanceTools,
  createHandlerDeps,
  runMemoryPostReplyExtraction,
  runRelationshipPostReplyExtraction,
  runInnerThreadPostReplyExtraction,
  promptLabUserFromGuild,
});

const dashboardPassword = process.env.DASHBOARD_PASSWORD;
const bypassDashboardAuth = process.env.UNSAFELY_BYPASS_DASHBOARD_AUTH === "true";
const dashboardPasswordlessCidrs = parseDashboardPasswordlessCidrs(process.env.DASHBOARD_PASSWORDLESS_CIDRS);
const dashboardTrustedProxyCidrs = parseDashboardPasswordlessCidrs(process.env.DASHBOARD_TRUSTED_PROXY_CIDRS);
const dashboardManagementRuntime = createDashboardManagementRuntime({
  client,
  db,
  defaultNotebookShelfAfterMs: globalConfig.defaultNotebooks?.defaultShelfAfterMs,
});
const dashboardManagement = {
  getPersonaModeStatus: () => {
    const status = personaModeRuntime.getStatus();
    return {
      profile,
      ...status,
      guilds: status.guilds.map((entry) => ({
        ...entry,
        guildName: client.guilds.cache.get(entry.guildId)?.name ?? entry.guildId,
      })),
    };
  },
  getDirectory: dashboardManagementRuntime.getDirectory,
  listMessages: dashboardManagementRuntime.listMessages,
  editMessage: dashboardManagementRuntime.editMessage,
  deleteMessages: dashboardManagementRuntime.deleteMessages,
  deleteLatestMessages: dashboardManagementRuntime.deleteLatestMessages,
  inspectPrompts: (input: {
    scenario: PromptScenarioId;
    provider: "openai-codex" | "openrouter";
    guildId?: string;
  }) => {
    const guildConfig = input.guildId !== undefined
      ? getGuildConfig(input.guildId)
      : resolveGuildConfig(globalConfig, { guildId: "dashboard", slug: "dashboard" });
    return inspectPromptScenario({
      bundle: promptBundle,
      profile,
      scenario: input.scenario,
      provider: input.provider,
      transport: guildConfig.promptTransport,
    });
  },
  runPromptLab,
  runPromptLabAmbientInitiative: ambientRuntime.runPromptLabAmbientInitiative,
  runPromptLabPrivateLife: (input: {
    guildId: string;
    channelId: string;
    origin?: string;
    mode?: string;
    territory?: string;
    actionScope?: string;
  }) => {
    const origin = PRIVATE_LIFE_ATTENTION_ORIGINS.find((candidate) => candidate === input.origin);
    const mode = PRIVATE_LIFE_CURIOSITY_MODES.find((candidate) => candidate === input.mode);
    const territory = PRIVATE_LIFE_TERRITORIES.find((candidate) => candidate === input.territory);
    const actionScope = PRIVATE_LIFE_ACTION_SCOPES.find((candidate) => candidate === input.actionScope);
    if (input.origin !== undefined && origin === undefined) throw new Error(`Unknown private-life origin: ${input.origin}`);
    if (input.mode !== undefined && mode === undefined) throw new Error(`Unknown private-life mode: ${input.mode}`);
    if (input.territory !== undefined && territory === undefined) throw new Error(`Unknown private-life territory: ${input.territory}`);
    if (input.actionScope !== undefined && actionScope === undefined) throw new Error(`Unknown private-life action scope: ${input.actionScope}`);
    return privateLifeRuntime.runPromptLab({
      guildId: input.guildId,
      channelId: input.channelId,
      ...(origin !== undefined ? { origin } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(territory !== undefined ? { territory } : {}),
      ...(actionScope !== undefined ? { actionScope } : {}),
    });
  },
  listPrivateLifeEpisodes: (limit?: number) => ({ episodes: privateLifeRuntime.listEpisodes(limit) }),
  listInnerThreads: (filter: { guildId?: string; status?: "active" | "resolved"; limit?: number }) => ({
    threads: listInnerThreads(db, filter),
  }),
  deleteInnerThread: dashboardManagementRuntime.deleteInnerThread,
  listStagedAssets: (filter: { guildId?: string; channelId?: string; unresolvedOnly?: boolean; limit?: number }) => ({
    assets: listStagedAssets(db, filter),
  }),
  listMemories: dashboardManagementRuntime.listMemories,
  createMemory: dashboardManagementRuntime.createMemory,
  editMemory: dashboardManagementRuntime.editMemory,
  deleteMemory: dashboardManagementRuntime.deleteMemory,
  restoreMemory: dashboardManagementRuntime.restoreMemory,
  listNotebooks: dashboardManagementRuntime.listNotebooks,
  createNotebook: dashboardManagementRuntime.createNotebook,
  editNotebook: dashboardManagementRuntime.editNotebook,
  setNotebookState: dashboardManagementRuntime.setNotebookState,
  deleteNotebook: dashboardManagementRuntime.deleteNotebook,
  relationships: createRelationshipsManagementApi({
    db,
    getGlobalConfig: () => globalConfig,
    getGuildConfig: () => resolveGuildConfig(globalConfig, { guildId: "dashboard", slug: "dashboard" }),
  }),
  voice: {
      getSnapshot: () => voiceRuntime.snapshot(),
      subscribe: (listener: (snapshot: object) => void) => voiceRuntime.subscribe(listener),
      listChannels: () => ({
        channels: [...client.guilds.cache.values()].flatMap((guild) => [...guild.channels.cache.values()]
          .filter((channel) => channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice)
          .map((channel) => ({
            id: channel.id,
            name: channel.name,
            guildId: guild.id,
            guildName: guild.name,
            members: [...channel.members.values()]
              .filter((member) => !member.user.bot)
              .map((member) => member.user.username),
          }))),
      }),
      join: async (channelId: string) => await voiceRuntime.join(channelId),
      leave: async () => {
        await voiceRuntime.leave("Voice session ended from the dashboard.");
        return voiceRuntime.snapshot();
      },
      inject: async (text: string) => {
        const snapshot = voiceRuntime.snapshot();
        if (snapshot.guildId === undefined) throw new Error("2B is not connected to a voice channel.");
        return await voiceRuntime.inject({
          guildId: snapshot.guildId,
          userId: "dashboard",
          username: "dashboard",
          text,
          trusted: true,
        });
      },
    },
};
let dashboardServer: ReturnType<typeof startDashboard> | undefined;
if (bypassDashboardAuth) {
  dashboardServer = startDashboard({ port: 3000, password: "", bypassAuth: true, management: dashboardManagement, log });
  log.warn("dashboard started with auth bypass — do not use in production");
} else if (dashboardPassword !== undefined && dashboardPassword !== "") {
  dashboardServer = startDashboard({
    port: 3000,
    password: dashboardPassword,
    passwordlessCidrs: dashboardPasswordlessCidrs,
    trustedProxyCidrs: dashboardTrustedProxyCidrs,
    management: dashboardManagement,
    log,
  });
} else {
  log.info("dashboard disabled (DASHBOARD_PASSWORD not set)");
}

// --- Graceful shutdown ---
async function shutdown(signal: string): Promise<void> {
  log.info("shutting down", { signal });

  setRestartRecoveryCutoff(db);
  acceptingDiscordMessages = false;
  startupMessageProcessingReady = false;
  // The voice dashboard keeps an EventSource request open indefinitely, so a
  // graceful HTTP stop cannot finish during process shutdown.
  const dashboardStop = dashboardServer?.stop(true);

  clearInterval(memoryCleanupTimer);
  clearInterval(vpnSessionCleanupTimer);
  eventWatchDiscordAdapters?.stop();
  if (configReloadPollTimer !== null) clearInterval(configReloadPollTimer);
  if (reloadTimer !== null) clearTimeout(reloadTimer);
  for (const watcher of configWatchers) watcher.close();
  ambientRuntime.clearAmbientAttentionState();
  ambientRuntime.clearAmbientInitiativeState();
  privateLifeRuntime.clear();
  scheduler.stop();
  eventWatchRuntime.stop();
  personaModeRuntime.stop();
  assetBackfillController.abort(new Error("Asset backfill stopped for shutdown."));

  await inboundMessageTasks.drain();
  await Promise.all([...dispatchers.values()].map((dispatcher) => dispatcher.drain()));
  await scheduler.drain();
  await eventWatchRuntime.drain();
  await voiceRuntime.shutdown();
  await dashboardStop;
  while (imageJobTasks.activeCount() > 0 || backgroundTasks.activeCount() > 0) {
    await Promise.all([imageJobTasks.drain(), backgroundTasks.drain()]);
  }

  ambientRuntime.clearAmbientAttentionState();
  ambientRuntime.clearAmbientInitiativeState();
  privateLifeRuntime.clear();
  for (const dispatcher of dispatchers.values()) dispatcher.dispose();
  dispatchers.clear();
  await client.destroy();
  db.close();

  log.info("shutdown complete");
  process.exit(0);
}

let shutdownPromise: Promise<void> | null = null;
function requestShutdown(signal: string): void {
  if (shutdownPromise !== null) {
    log.warn("forcing shutdown after repeated signal", { signal });
    process.exit(1);
  }
  shutdownPromise = shutdown(signal).catch((error: unknown) => {
    log.error("graceful shutdown failed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
  void shutdownPromise;
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

export { db, guildConfigs, globalConfig, promptBundle, scheduler, client };
