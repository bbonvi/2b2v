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


export function createConfigReloadRuntime(input: {
    profile: string;
    profilesDir: string;
    profileDir: string;
    configPath: string;
    guildsDir: string;
    log: Logger;
    backgroundTasks: AsyncTaskTracker;
    modelImageSupport: ReturnType<typeof createModelImageSupportStore>;
    getGlobalConfig: () => ReturnType<typeof loadGlobalConfig>;
    setGlobalConfig: (config: ReturnType<typeof loadGlobalConfig>) => void;
    setPromptBundle: (bundle: PromptBundle) => void;
    guildConfigs: Map<string, GuildConfig>;
    isAcceptingEvents: () => boolean;
    updatePersonaModes: (config: ReturnType<typeof loadGlobalConfig>["personaModes"], timezone: string) => void;
    resetDispatchers: () => Promise<void>;
    clearAmbientState: () => void;
    restartAmbientLoops: () => void;
  }
) {
  const { profile, profilesDir, profileDir, configPath, guildsDir, log, backgroundTasks, modelImageSupport, getGlobalConfig, setGlobalConfig, setPromptBundle, guildConfigs, isAcceptingEvents, updatePersonaModes, resetDispatchers, clearAmbientState, restartAmbientLoops } = input;
const CONFIG_RELOAD_DEBOUNCE_MS = 500;
const CONFIG_RELOAD_POLL_MS = 5000;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let configReloadPollTimer: ReturnType<typeof setInterval> | null = null;
const configWatchers: FSWatcher[] = [];
let lastConfigFingerprint = configReloadFingerprint();

function scheduleConfigReload(): void {
  if (!acceptingDiscordMessages) return;
  if (reloadTimer !== null) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void backgroundTasks.track(reloadConfigs());
  }, CONFIG_RELOAD_DEBOUNCE_MS);
}

function configReloadFingerprint(): string {
  const parts: string[] = [];
  const pending = [profileDir];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined) continue;
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    parts.push(`${path}:${stat.mtimeMs}:${stat.size}`);
    if (!stat.isDirectory()) continue;
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (/\.(?:ya?ml|md|png|jpe?g|webp)$/i.test(entry.name)) pending.push(entryPath);
    }
  }
  return parts.sort().join("|");
}

async function reloadConfigs(): Promise<void> {
  try {
    requireProfileConfigPath(profilesDir, profile);
    const newGlobal = loadGlobalConfig(
      process.env,
      configPath,
    );
    validateTrimConfig(newGlobal.defaultTrim);

    // Reload guild configs — clear and rebuild
    const newGuilds = loadGuildConfigs(guildsDir, newGlobal);
    await modelImageSupport.refresh(newGlobal, newGuilds, "hot_reload");
    if (!acceptingDiscordMessages) return;

    getGlobalConfig() = newGlobal;
    getPromptBundle() = loadInstructionBundle(profilesDir, profile, log);
    personaModeRuntime.update(newGlobal.personaModes, newGlobal.defaultTimezone);

    guildConfigs.clear();
    for (const [id, cfg] of newGuilds) {
      guildConfigs.set(id, cfg);
    }

    // Swap first so new events use the new config while previously accepted work drains intact.
    const previousDispatchers = [...dispatchers.values()];
    dispatchers.clear();
    ambientRuntime.clearAmbientAttentionState();
    ambientRuntime.clearAmbientInitiativeState();
    privateLifeRuntime.clear();
    ambientRuntime.startAmbientInitiativeLoops();
    privateLifeRuntime.start();
    await Promise.all(previousDispatchers.map(async (dispatcher) => {
      await dispatcher.drain();
      dispatcher.dispose();
    }));

    log.info("config hot-reloaded", {
      modelProfile: getGlobalConfig().defaultModelProfile,
      model: resolveModelProfile(getGlobalConfig(), getGlobalConfig().defaultModelProfile).model,
      guilds: guildConfigs.size,
    });
  } catch (err) {
    log.error("config hot-reload failed, keeping previous config", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

if (existsSync(profileDir)) {
  const watcher = watch(profileDir, { recursive: true }, (_event, _filename) => {
    lastConfigFingerprint = configReloadFingerprint();
    scheduleConfigReload();
  });

  // Prevent watcher from keeping the process alive during shutdown
  watcher.unref();
  configWatchers.push(watcher);
  log.info("profile hot-reload watcher started");

  configReloadPollTimer = setInterval(() => {
    const fingerprint = configReloadFingerprint();
    if (fingerprint === lastConfigFingerprint) return;
    lastConfigFingerprint = fingerprint;
    scheduleConfigReload();
  }, CONFIG_RELOAD_POLL_MS);
  configReloadPollTimer.unref();
  log.info("config hot-reload poller started", { intervalMs: CONFIG_RELOAD_POLL_MS });
}

const sharedInstructionsDir = join(profilesDir, "shared", "instructions");
if (existsSync(sharedInstructionsDir)) {
  const watcher = watch(sharedInstructionsDir, { recursive: true }, (_event, _filename) => {
    scheduleConfigReload();
  });

  watcher.unref();
  configWatchers.push(watcher);
  log.info("shared instructions hot-reload watcher started");
}

// --- Health check summary ---
await recoverPendingWatchMessages();
await recoverMessagesAfterRestart();
log.info("health check passed — all systems ready", {
  uptimeMs: Date.now() - startTime,
  guilds: guildConfigs.size,
  schedulerJobs: scheduler.activeCount(),
});
startupMessageProcessingReady = true;
drainStartupMessageQueue();
void backgroundTasks.track(backfillMessageAssets({
  db,
  client,
  logger: log.child({ component: "asset-backfill" }),
  signal: assetBackfillController.signal,
})).catch((error: unknown) => {
  log.warn("asset history backfill stopped", { error: error instanceof Error ? error.message : String(error) });
});
ambientRuntime.startAmbientInitiativeLoops();
privateLifeRuntime.start();
for (const row of db.raw.prepare(
  "SELECT id FROM agent_jobs WHERE status = 'ready' ORDER BY completed_at ASC, created_at ASC",
).all() as Array<{ id: string }>) {
  void imageJobTasks.track(runImageGenerationJob(row.id)).catch((error: unknown) => {
    log.error("ready staged image recovery failed", {
      jobId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

// --- Start dashboard ---


  return { reloadConfigs, close: () => { if (configReloadPollTimer !== null) clearInterval(configReloadPollTimer); if (reloadTimer !== null) clearTimeout(reloadTimer); for (const watcher of configWatchers) watcher.close(); } };
}
