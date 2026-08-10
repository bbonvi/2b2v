import { createLogger, type LogLevel } from "./logger";
import { requestLogStore } from "./dashboard/store";
import { parseDashboardPasswordlessCidrs } from "./dashboard/auth";
import { startDashboard } from "./dashboard/server";
import { loadGlobalConfig, loadGuildConfigs, resolveGuildConfig, validateContextHistoryConfig, validateVpnConfig } from "./config/loader";
import type { GuildConfig } from "./config/types";
import { createDatabase } from "./db/database";
import { createDiscordClient, loginDiscordClient } from "./discord/client";
import { registerInteractionRuntime } from "./discord/interaction-runtime";
import { EmojiCache } from "./discord/emoji-cache";
import { registerEmojiCacheSync } from "./discord/emoji-cache-sync";
import { createSchedulerEngine, type SchedulerEngine } from "./scheduler/engine";
import { createScheduledTaskRunner } from "./scheduler/scheduled-task-runtime";
import { createElevenLabsClient, type ElevenLabsClient } from "./tts/client";
import { AgentJobStore } from "./agent/job-runtime";
import { LinkContentCache } from "./agent/link-content.ts";
import { SemanticMaintenanceCoordinator } from "./agent/semantic-maintenance-coordinator.ts";
import { createModelImageSupportStore } from "./llm/model-image-support";
import { resolveModelProfile } from "./llm/client";
import { createAmbientRuntime } from "./ambient/runtime";
import { createPrivateLifeRuntime } from "./private-life/runtime.ts";
import { createPersonaModeRuntime } from "./modes/runtime";
import type { PersonaModeActivityType } from "./modes/types";
import { createWatchMatcher } from "./event-watch/matcher.ts";
import { createEventWatchRuntime } from "./event-watch/runtime.ts";
import { DEFAULT_EVENT_WATCH_PRESSURE } from "./event-watch/types.ts";
import { createDashboardManagement, createDashboardManagementRuntime, dashboardTriggerLocation } from "./dashboard/management-runtime";
import { createDiscordPromptLabRunner, promptLabDryRunTools, promptLabSummary, promptLabSyntheticId } from "./dashboard/prompt-lab-runtime";
import { type RelationshipConfig } from "./relationships";
import { registerGuildSlashCommands, registerSlashCommands } from "./commands/registry";
import { statusCommandDefinition } from "./commands/status";
import { scheduleCommandDefinition } from "./commands/schedule";
import { memoryWipeCommandDefinition } from "./commands/memory-wipe";
import { vpnCommandDefinition } from "./commands/vpn";
import { voiceTestCommandDefinition } from "./commands/voice-test.ts";
import { createVpnClient, type VpnClient } from "./vpn/api-client";
import { createSessionStore, type SessionStore } from "./vpn/session";
import { loadInstructionBundle, type PromptBundle } from "./config/instruction-bundle";
import { requireProfileConfigPath } from "./config/profile";
import { renderPromptTemplate } from "./config/prompt-template";
import { createSyntheticReplyFallbackDeps } from "./discord/reply-fallback-runtime";
import { backfillMessageAssets } from "./discord/asset-backfill";
import { setRestartRecoveryCutoff } from "./db/restart-recovery-repository";
import { AsyncTaskTracker } from "./runtime/async-task-tracker";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import type { Database } from "./db/database";
import { ActivityType, type Client } from "discord.js";
import { createAmbientMemoryRuntime } from "./agent/ambient-memory-runtime";
import { createContextRuntime } from "./agent/context-runtime";
import { createImageJobRuntime } from "./agent/image-job-runtime";
import { createMaintenanceRuntime } from "./agent/maintenance-runtime";
import { createToolRuntime } from "./agent/tool-runtime";
import { createTurnRuntime } from "./agent/turn-runtime";
import { createConfigReloadRuntime } from "./config/reload-runtime";
import { createStartupMessageQueue, registerMessageEvents } from "./discord/message-events";
import { createMessageTurnRuntime, createScheduledAttentionGuard } from "./discord/message-turn-runtime";
import { createVoiceApplication } from "./voice/application";
import { createBackgroundAgentRuntime } from "./agent/background-agent-runtime.ts";

const pkg = await Bun.file(new URL("../package.json", import.meta.url).pathname).json() as { version?: string };
const version: string = pkg.version ?? "0.0.0";
const startTime = Date.now();
const logLevel = (process.env.LOG_LEVEL ?? "info") as LogLevel;
const log = createLogger({ level: logLevel });
const TYPING_INTERVAL_MS = 8_000;
const inboundMessageTasks = new AsyncTaskTracker();
const imageJobTasks = new AsyncTaskTracker();
const agentJobTasks = new AsyncTaskTracker();
const backgroundTasks = new AsyncTaskTracker();
const assetBackfillController = new AbortController();
log.info("bot starting", { version, runtime: `bun ${Bun.version}`, pid: process.pid });
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
validateContextHistoryConfig(globalConfig.defaultContextHistory);
validateVpnConfig(globalConfig.vpn);
log.info("profile loaded", {
  profile,
  modelProfile: globalConfig.defaultModelProfile,
  model: resolveModelProfile(globalConfig, globalConfig.defaultModelProfile).model,
  configPath,
});
const client: Client = createDiscordClient(globalConfig, log);
const startupMessageQueue = createStartupMessageQueue(client);
const discordLoginPromise = loginDiscordClient(client, globalConfig.discordToken);
void discordLoginPromise.catch(() => {});
if (!existsSync(globalConfig.dataDir)) {
  mkdirSync(globalConfig.dataDir, { recursive: true });
}

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

const guildConfigs = loadGuildConfigs(guildsDir, globalConfig);
log.info("guild configs loaded", { count: guildConfigs.size });

const agentJobs = new AgentJobStore(db, globalConfig.agentJobs);

const modelImageSupport = createModelImageSupportStore({ log });
await modelImageSupport.refresh(globalConfig, guildConfigs, "startup");

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

const emojiCache = new EmojiCache();
registerEmojiCacheSync(client, emojiCache);

let ttsClient: ElevenLabsClient | undefined;
if (globalConfig.elevenLabsApiKey !== undefined && globalConfig.elevenLabsApiKey !== "") {
  ttsClient = createElevenLabsClient({ apiKey: globalConfig.elevenLabsApiKey });
  log.info("tts client ready");
}

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

const semanticMaintenanceCoordinator = new SemanticMaintenanceCoordinator();

const contextRuntime = createContextRuntime({
  db, client, emojiCache, agentJobs, log,
  getGlobalConfig: () => globalConfig,
  getPromptBundle: () => promptBundle,
  getRelationshipConfig,
  innerThreadsEnabled,
  notebooksEnabled,
  runtimeContextTemplate,
  resolveStoredUsername: (userId) => dashboardManagementRuntime.userName(userId),
  voicePresenceContext: () => voiceRuntime.presenceContext(),
  renderPersonaModeContext: (guildId) => personaModeRuntime.renderPromptContext(guildId),
});
const {
  buildInboundResolvers, buildOutboundResolvers, authorDisplayName, resolveGuildUsername,
  resolveKnownUsername, resolvePromptUsername, resolveGuildMemberReference,
  refreshEmojiCache, fetchEmojiCache, buildContext,
} = contextRuntime;

const ambientMemoryRuntime = createAmbientMemoryRuntime({
  db, client, log, requestLogStore,
  getGlobalConfig: () => globalConfig,
  getPromptBundle: () => promptBundle,
  runtimeToolDescription,
  resolveKnownUsername,
  resolvePromptUsername,
  semanticMaintenanceCoordinator,
});
const { maybeRunAmbientMemoryExtraction, markMemoryExtractionCheckpointFromContext } = ambientMemoryRuntime;

const maintenanceRuntime = createMaintenanceRuntime({
  db, client, log, agentJobs, requestLogStore,
  getGlobalConfig: () => globalConfig,
  getPromptBundle: () => promptBundle,
  getRelationshipConfig,
  innerThreadsEnabled,
  runtimeToolDescription,
  runtimeContextTemplate,
  resolveKnownUsername,
  resolvePromptUsername,
  markMemoryExtractionCheckpointFromContext,
});
const {
  blockToolsExcept, latestHumanIdentity, createPostReplyMaintenanceTools,
  runMemoryPostReplyExtraction, runRelationshipPostReplyExtraction,
  runInnerThreadPostReplyExtraction, runPrivateLifeMaintenance,
  createPrivateLifeMaintenanceTools,
} = maintenanceRuntime;

const turnRuntime = createTurnRuntime({
  db, client, log, agentJobs, linkContentCache, backgroundTasks, modelImageSupport,
  ...(ttsClient === undefined ? {} : { ttsClient }),
  getGlobalConfig: () => globalConfig,
  getPromptBundle: () => promptBundle,
  buildOutboundResolvers,
  noteVisiblePersonaTurn: (guildId) => personaModeRuntime.noteVisibleTurn(guildId),
});
const {
  persistIgnoredBotReply, persistPrivateThoughts, createBotDiscordMessageSender,
  resolveClientGuild, fetchAccessibleGuildChannel, createTtsGenerator,
  createHandlerDeps, createAssetAttachmentResolver, runLoggedAgentTurn,
} = turnRuntime;

let enqueueChannelTaskImpl = (_guildId: string, _channelId: string, _task: () => Promise<void>): Promise<void> =>
  Promise.reject(new Error("Channel dispatcher is not ready."));
let runAgentJobImpl = (_jobId: string): Promise<void> =>
  Promise.reject(new Error("Background agent runtime is not ready."));
const resumeAgentJob = (jobId: string): void => {
  void agentJobTasks.track(runAgentJobImpl(jobId)).catch((error: unknown) => {
    log.error("background agent resume failed", { jobId, error: error instanceof Error ? error.message : String(error) });
  });
};

const imageJobRuntime = createImageJobRuntime({
  db, client, log, requestLogStore, agentJobs, linkContentCache,
  getGlobalConfig: () => globalConfig,
  getPromptBundle: () => promptBundle,
  getGuildConfig,
  runtimeContextTemplate,
  buildContext,
  getBuildAgentTools: () => buildAgentTools,
  blockToolsExcept,
  createPostReplyMaintenanceTools,
  runMemoryPostReplyExtraction,
  runRelationshipPostReplyExtraction,
  runInnerThreadPostReplyExtraction,
  createBotDiscordMessageSender,
  createTtsGenerator,
  createHandlerDeps,
  createAssetAttachmentResolver,
  persistIgnoredBotReply,
  fetchAccessibleGuildChannel,
  resolveGuildMemberReference,
  noteAmbientBotReply: (input) => ambientRuntime.noteAmbientBotReply(input),
  enqueueChannelTask: async (guildId, channelId, task) => await enqueueChannelTaskImpl(guildId, channelId, task),
  resumeAgentJob,
});
const { runImageGenerationJob, loadExternalReference, loadGuildAvatarReference } = imageJobRuntime;

const { markScheduledAttentionBusy, isScheduledAttentionBusy } = createScheduledAttentionGuard();

const watchMatcher = createWatchMatcher({
  db,
  pressure: DEFAULT_EVENT_WATCH_PRESSURE,
  getTimezone: (guildId) => getGuildConfig(guildId).timezone,
  onMetrics: (metrics, event) => log.debug("event watch match complete", {
    eventType: event.type, eventKey: event.eventKey, ...metrics,
  }),
});

const scheduler: SchedulerEngine = createSchedulerEngine({
  db,
  onFire: createScheduledTaskRunner({
    client, db, requestLogStore, log, getGuildConfig, createSyntheticReplyFallbackDeps,
    buildContext,
    buildAgentTools: (...args) => buildAgentTools(...args),
    createVisibleMaintenanceTools: (input) => blockToolsExcept(createPostReplyMaintenanceTools(input), "", "visible reply mode"),
    createBotDiscordMessageSender, createTtsGenerator, createHandlerDeps,
    resolveAssetAttachments: createAssetAttachmentResolver, runLoggedAgentTurn,
    runMemoryPostReplyExtraction, runRelationshipPostReplyExtraction, runInnerThreadPostReplyExtraction,
    onScheduleCompleted: (id) => scheduler.removeSchedule(id),
    markScheduledAttentionBusy,
    preparePersonaModeTurn: (guildId) => personaModeRuntime.prepareNaturalTurn(guildId),
  }),
  log,
});

const toolRuntime = createToolRuntime({
  db, client, log, agentJobs, scheduler, linkContentCache,
  getGlobalConfig: () => globalConfig,
  getPromptBundle: () => promptBundle,
  getGuildConfig, notebooksEnabled,
  runtimeToolDescription, resolveClientGuild,
  fetchAccessibleGuildChannel, resolveGuildUsername, resolveGuildMemberReference,
  fetchEmojiCache, buildOutboundResolvers,
  runImageGenerationJob,
  trackImageJob: (task) => { void imageJobTasks.track(task); },
  runAgentJob: async (jobId) => await runAgentJobImpl(jobId),
  trackAgentJob: (task) => {
    void agentJobTasks.track(task).catch((error: unknown) => {
      log.error("background agent failed outside worker", { error: error instanceof Error ? error.message : String(error) });
    });
  },
  watchMatcher,
  getEventWatchRuntime: () => eventWatchRuntime,
  getEventWatchDiscordAdapters: () => messageEvents.getEventWatchDiscordAdapters(),
  emojiCache, innerThreadsEnabled, refreshEmojiCache,
  loadExternalReference, loadGuildAvatarReference,
  getVoiceRuntime: () => voiceRuntime,
});
const { buildAgentTools } = toolRuntime;

const voiceApplication = createVoiceApplication({
  db, client, log, requestLogStore,
  getGlobalConfig: () => globalConfig,
  getPromptBundle: () => promptBundle,
  getGuildConfig, runtimeContextTemplate, buildContext, buildAgentTools,
  createHandlerDeps, resolveKnownUsername, resolvePromptUsername,
  resolveClientGuild, getRelationshipConfig, innerThreadsEnabled, runtimeToolDescription,
  semanticMaintenanceCoordinator, defaultPersonaModeForMaintenance,
});
const { voiceRuntime } = voiceApplication;

const messageTurnRuntime = createMessageTurnRuntime({
  db, client, log, requestLogStore, agentJobs, getGuildConfig,
  getPromptBundle: () => promptBundle,
  buildInboundResolvers, authorDisplayName, buildContext, buildAgentTools,
  createBotDiscordMessageSender, createHandlerDeps, createAssetAttachmentResolver,
  runLoggedAgentTurn, createTtsGenerator, blockToolsExcept,
  createPostReplyMaintenanceTools, runMemoryPostReplyExtraction,
  runRelationshipPostReplyExtraction, runInnerThreadPostReplyExtraction,
  persistIgnoredBotReply, persistPrivateThoughts,
  fetchAccessibleGuildChannel,
  getAmbientRuntime: () => ambientRuntime,
  getEventWatchRuntime: () => eventWatchRuntime,
  runtimeContextTemplate,
  preparePersonaModeTurn: (guildId) => personaModeRuntime.prepareNaturalTurn(guildId),
});
const { dispatchers, getOrCreateDispatcher, evaluateMessageTrigger, normalizedWatchMessage,
  processEventWatchTurn, processSettledWatchedMessage, processTriggeredMessage } = messageTurnRuntime;
enqueueChannelTaskImpl = messageTurnRuntime.enqueueChannelTask;

const backgroundAgentRuntime = createBackgroundAgentRuntime({
  db, client, log, requestLogStore, agentJobs,
  getGlobalConfig: () => globalConfig,
  getPromptBundle: () => promptBundle,
  getGuildConfig,
  buildAgentTools,
  createHandlerDeps,
  fetchAccessibleGuildChannel,
  dispatchRootHandoff: messageTurnRuntime.runBackgroundHandoff,
});
runAgentJobImpl = backgroundAgentRuntime.runAgentJob;

const eventWatchRuntime = createEventWatchRuntime({
  db, matcher: watchMatcher, pressure: DEFAULT_EVENT_WATCH_PRESSURE,
  log: log.child({ component: "event-watch" }), onFire: processEventWatchTurn,
});
scheduler.start();
log.info("scheduler started", { jobs: scheduler.activeCount() });
const stopMaintenanceCleanup = maintenanceRuntime.startCleanup();

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

const messageEvents = registerMessageEvents({
  db, client, log, inboundMessageTasks, backgroundTasks, getGuildConfig,
  buildInboundResolvers, fetchAccessibleGuildChannel, evaluateMessageTrigger,
  normalizedWatchMessage, processSettledWatchedMessage, processTriggeredMessage,
  getOrCreateDispatcher, maybeRunAmbientMemoryExtraction, ambientRuntime, eventWatchRuntime,
  startupQueue: startupMessageQueue,
});

await discordLoginPromise;
personaModeRuntime.start();
eventWatchRuntime.start();
log.info("event watch runtime started");

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
  isAcceptingEvents: () => messageEvents.isAccepting(),
  trackTask: (task) => {
    void backgroundTasks.track(task);
  },
});
messageEvents.registerDiscordListeners();
const configReloadRuntime = createConfigReloadRuntime({
  profile, profilesDir, profileDir, configPath, guildsDir, log, backgroundTasks,
  modelImageSupport,
  getGlobalConfig: () => globalConfig,
  setGlobalConfig: (config) => { globalConfig = config; },
  setPromptBundle: (bundle) => { promptBundle = bundle; },
  guildConfigs,
  isAcceptingEvents: messageEvents.isAccepting,
  updatePersonaModes: (config, timezone) => personaModeRuntime.update(config, timezone),
  resetDispatchers: () => {
    const previous = [...dispatchers.values()];
    dispatchers.clear();
    return async () => {
      await Promise.all(previous.map(async (dispatcher) => {
        await dispatcher.drain();
        dispatcher.dispose();
      }));
    };
  },
  clearAmbientState: () => {
    ambientRuntime.clearAmbientAttentionState();
    ambientRuntime.clearAmbientInitiativeState();
    privateLifeRuntime.clear();
  },
  restartAmbientLoops: () => {
    ambientRuntime.startAmbientInitiativeLoops();
    privateLifeRuntime.start();
  },
});
await messageEvents.recoverPendingWatchMessages();
await messageEvents.recoverMessagesAfterRestart();
log.info("health check passed — all systems ready", {
  uptimeMs: Date.now() - startTime,
  guilds: guildConfigs.size,
  schedulerJobs: scheduler.activeCount(),
});
messageEvents.start();
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
  "SELECT id FROM agent_jobs WHERE kind = 'image_generation' AND status IN ('queued', 'ready') ORDER BY completed_at ASC, created_at ASC",
).all() as Array<{ id: string }>) {
  void imageJobTasks.track(runImageGenerationJob(row.id)).catch((error: unknown) => {
    log.error("image job recovery failed", {
      jobId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
void agentJobTasks.track(backgroundAgentRuntime.recover()).catch((error: unknown) => {
  log.error("agent job recovery failed", { error: error instanceof Error ? error.message : String(error) });
});

const runPromptLab = createDiscordPromptLabRunner({
  client, db, getPromptBundle: () => promptBundle, requestLogStore, log,
  getGuildConfig, getRelationshipConfig, resolveClientGuild, fetchAccessibleGuildChannel,
  buildInboundResolvers, buildContext, buildAgentTools, blockToolsExcept,
  createPostReplyMaintenanceTools, createHandlerDeps, runMemoryPostReplyExtraction,
  runRelationshipPostReplyExtraction, runInnerThreadPostReplyExtraction,
  dashboardUserName: (userId) => dashboardManagementRuntime.userName(userId),
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
const dashboardManagement = createDashboardManagement({
  profile, client, db, runtime: dashboardManagementRuntime, personaModeRuntime,
  ambientRuntime, privateLifeRuntime, voiceRuntime, runPromptLab,
  getGlobalConfig: () => globalConfig,
  getPromptBundle: () => promptBundle,
  getGuildConfig,
});
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
  messageEvents.stop();
  // The voice dashboard keeps an EventSource request open indefinitely, so a
  // graceful HTTP stop cannot finish during process shutdown.
  const dashboardStop = dashboardServer?.stop(true);

  stopMaintenanceCleanup();
  clearInterval(vpnSessionCleanupTimer);
  configReloadRuntime.close();
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
  while (imageJobTasks.activeCount() > 0 || agentJobTasks.activeCount() > 0 || backgroundTasks.activeCount() > 0) {
    await Promise.all([imageJobTasks.drain(), agentJobTasks.drain(), backgroundTasks.drain()]);
  }

  ambientRuntime.clearAmbientAttentionState();
  ambientRuntime.clearAmbientInitiativeState();
  privateLifeRuntime.clear();
  for (const dispatcher of dispatchers.values()) dispatcher.dispose();
  dispatchers.clear();
  await client.destroy();
  requestLogStore.close();
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
