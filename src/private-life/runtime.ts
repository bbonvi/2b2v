import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Client, Guild } from "discord.js";
import type { Database } from "../db/database.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";
import type { PromptBundle, RuntimePromptBundle } from "../config/instruction-bundle.ts";
import type { AssembledContext } from "../agent/context-assembly.ts";
import type { HistoryMessage } from "../agent/history-types.ts";
import type { ReplyFallbackDeps } from "../agent/reply-target-fallback.ts";
import {
  handleMessage,
  type HandlerDeps,
  type IncomingMessage,
  type MemoryExtractionRequest,
  type MessageSender,
} from "../agent/handler.ts";
import type { Logger } from "../logger.ts";
import { RequestLog } from "../logger.ts";
import type { RequestLogStore } from "../dashboard/store.ts";
import type {
  PromptLabDraftMessage,
  PromptLabDryRun,
  PromptLabRunResult,
} from "../dashboard/prompt-lab-types.ts";
import type { SendableGuildChannel } from "../discord/message-sender.ts";
import { channelDisplayName, createTargetChannelResolver } from "../discord/message-sender.ts";
import { createGeneratedImageRuntime } from "../agent/generated-image-runtime.ts";
import type { GeneratedImageAttachment } from "../agent/codex-image-tool.ts";
import { createStoredAssetAttachmentResolver } from "../agent/stored-asset-attachments.ts";
import { createDiscordAssetSourceResolver } from "../discord/asset-resolver.ts";
import { DEFAULT_ASSET_READING } from "../config/defaults.ts";
import { isReadOnlyTool } from "../agent/tool-effects.ts";
import { listInnerThreads } from "../db/inner-thread-repository.ts";
import {
  completePrivateLifeEpisode,
  countPrivateLifeVisibleEpisodesSince,
  createPrivateLifeEpisode,
  failPrivateLifeEpisode,
  listPrivateLifeEpisodes,
  listRecentPrivateLifeSummaries,
  type PrivateLifeEpisode,
} from "../db/private-life-repository.ts";
import {
  privateLifeDayPhase,
  privateLifeNextDelayMs,
  privateLifePhaseBoundaryDelayMs,
  selectPrivateLifeCuriosity,
} from "./selector.ts";
import type {
  PrivateLifeConfig,
  PrivateLifeDayPhase,
  PrivateLifeSelection,
} from "./types.ts";

type RunMode = "automatic" | "draft";

const PUBLIC_ACTION_TOOL_NAMES = new Set([
  "react_to_message",
  "edit_own_message",
  "delete_own_message",
  "discord_set_user_timeout",
  "discord_remove_user_timeout",
  "schedule_task",
  "delete_scheduled_task",
  "start_thread",
  "close_thread",
  "join_voice_channel",
  "leave_voice_channel",
  "instruct_voice_channel",
]);

type RunOpportunityResult = {
  requestId?: string;
  episodeId?: string;
  error?: string;
  drafts?: PromptLabDraftMessage[];
  dryRuns?: PromptLabDryRun[];
  responseText?: string;
  privateThoughts?: string[];
  dayPhase?: PrivateLifeDayPhase;
  selection?: PrivateLifeSelection;
  recentLabels?: string[];
};

type CreateHandlerDepsInput = {
  guildId: string;
  guildConfig: GuildConfig;
  context: AssembledContext;
  currentChannelId: string;
  sender: MessageSender;
  extraTools: AgentTool[];
  log: Logger;
  requestLog: RequestLog;
  generatedImages?: ReturnType<typeof createGeneratedImageRuntime>;
  resolveAssetAttachments?: HandlerDeps["resolveAssetAttachments"];
  modeLifecycle?: boolean;
  overrides?: Partial<HandlerDeps>;
};

export interface PrivateLifePromptLabResult extends PromptLabRunResult {
  privateLife?: {
    dayPhase: PrivateLifeDayPhase;
    selection: PrivateLifeSelection;
    recentLabels: string[];
    privateThoughts: string[];
  };
}

export interface PrivateLifeRuntime {
  start(): void;
  clear(): void;
  runOpportunity(mode?: RunMode, overrides?: {
    guildId?: string;
    channelId?: string;
    origin?: PrivateLifeSelection["origin"];
    mode?: PrivateLifeSelection["mode"];
    territory?: PrivateLifeSelection["territory"];
    actionScope?: PrivateLifeSelection["actionScope"];
  }): Promise<RunOpportunityResult>;
  runPromptLab(input: {
    guildId: string;
    channelId: string;
    origin?: PrivateLifeSelection["origin"];
    mode?: PrivateLifeSelection["mode"];
    territory?: PrivateLifeSelection["territory"];
    actionScope?: PrivateLifeSelection["actionScope"];
  }): Promise<PrivateLifePromptLabResult>;
  listEpisodes(limit?: number): PrivateLifeEpisode[];
}

export interface PrivateLifeRuntimeDeps {
  db: Database;
  client: Client;
  log: Logger;
  requestLogStore: RequestLogStore;
  getPromptBundle: () => PromptBundle;
  getGlobalConfig: () => GlobalConfig;
  getGuildConfig: (guildId: string) => GuildConfig;
  resolveClientGuild: (guildId: string) => Promise<Guild | null>;
  fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
  createSyntheticReplyFallbackDeps: (input: { db: Database; guildId: string; channelId: string }) => ReplyFallbackDeps;
  buildContext: (
    guildId: string,
    channelId: string,
    guild: Guild,
    guildConfig: GuildConfig,
    userMessage: string,
    latestUserMessage: HistoryMessage,
    replyFallbackDeps: ReplyFallbackDeps,
    isThread: boolean,
    currentTurnBoundary?: { timestamp: number; messageId: string },
    relationshipsMode?: "live" | "virtual" | "private-life",
    excludeMessageIds?: readonly string[],
    historyOptions?: { appendLatestToHistory?: boolean; additionalVisibleUserIds?: readonly string[] },
  ) => Promise<AssembledContext>;
  buildAgentTools: (
    guildId: string,
    channelId: string,
    guildConfig: GuildConfig,
    guild: Guild,
    contextMessageIds: string[],
    onGeneratedImage?: (attachment: GeneratedImageAttachment) => void,
    currentRequest?: {
      requesterId: string;
      requesterUsername: string;
      sourceMessageId: string;
      sourceQuote: string;
    },
    options?: Record<string, unknown>,
  ) => AgentTool[];
  createVisibleMaintenanceTools: (input: {
    episodeId: string;
    guild: Guild;
    guildConfig: GuildConfig;
    memoryRequest: MemoryExtractionRequest;
    sourceRequestId: string;
  }) => AgentTool[];
  createBotDiscordMessageSender: (input: {
    defaultChannel: SendableGuildChannel;
    resolveTargetChannel: ReturnType<typeof createTargetChannelResolver>;
    botUserId: string;
    botUsername: string;
    logger: Logger;
  }) => MessageSender;
  createHandlerDeps: (input: CreateHandlerDepsInput) => HandlerDeps;
  promptLabDryRunTools: (tools: AgentTool[], dryRuns: PromptLabDryRun[]) => AgentTool[];
  promptLabSyntheticId: (offset?: number) => string;
  promptLabSummary: (entry: ReturnType<RequestLog["toEntry"]>) => Omit<
    PromptLabRunResult,
    "requestId" | "triggered" | "drafts" | "dryRuns" | "responseText" | "error"
  >;
  runMaintenance: (input: {
    episodeId: string;
    guild: Guild;
    channel: SendableGuildChannel;
    guildConfig: GuildConfig;
    request: MemoryExtractionRequest;
    sourceRequestId: string;
    dryRun: boolean;
    dryRuns: PromptLabDryRun[];
  }) => Promise<void>;
  isBusy?: (guildId: string, channelId: string) => boolean;
  activeRequestCount?: () => number;
  hasRecentVisibleOutput?: (since: number) => boolean;
}

function blockedTool(tool: AgentTool, reason: string): AgentTool {
  return {
    ...tool,
    execute: (_id: string, _params: unknown): Promise<AgentToolResult<unknown>> => Promise.resolve({
      content: [{ type: "text", text: `Blocked during this private-life opportunity: ${reason}` }],
      details: { blocked: true, reason, tool: tool.name },
    }),
  };
}

function toolResultFailed(result: AgentToolResult<unknown>): boolean {
  if (result.details === null || typeof result.details !== "object") return false;
  const details = result.details as Record<string, unknown>;
  return details.blocked === true
    || (details.error !== undefined && details.error !== null && details.error !== false && details.error !== "");
}

function localTimeText(now: number, timezone: string, phase: PrivateLifeDayPhase): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).format(new Date(now));
  const state = phase === "sleep-window" ? "sleeping" : phase === "late-night" ? "awake-at-night" : "awake";
  return [
    `Current local date and time: ${formatted}`,
    `Time zone: ${timezone}`,
    `Day phase: ${phase}`,
    `Current state: ${state}`,
  ].join("\n");
}

function runtimePromptsForPrivateLife(bundle: PromptBundle): RuntimePromptBundle {
  const actorTurn = bundle.runtime.contextTemplates["private-life-actor-turn"]?.trim()
    ?? "## Private-Life Actor Turn\nThis is a private opportunity, not a Discord reply. Visible output is optional; semantic maintenance runs afterward.";
  const actionBoundary = bundle.runtime.contextTemplates["private-life-action-boundary"]?.trim()
    ?? "## Private-Life Action Boundary\nChoose only 2B's next private thought, exploration, action, visible expression, or silence. Stop without explanation when her interest is spent.";
  return {
    ...bundle.runtime,
    contextTemplates: {
      ...bundle.runtime.contextTemplates,
      "visible-reply-execution-mode": actorTurn,
    },
    finalActionInstruction: actionBoundary,
  };
}

function addPrivateLifeInstruction(context: AssembledContext, instruction: string): AssembledContext {
  const text = instruction.trim();
  if (text === "") return context;
  return {
    ...context,
    sections: [
      ...context.sections.filter((section) => section.label !== "Private-Life Instruction"),
      {
        label: "Private-Life Instruction",
        text,
        cached: false,
        role: "developer",
      },
    ],
  };
}

function restrictContext(context: AssembledContext, selection: PrivateLifeSelection): AssembledContext {
  const social = selection.territory === "social-personal" || selection.territory === "community" || selection.mode === "social-impulse";
  if (social) return context;
  const omitted = new Set([
    "Server Members",
    "Threads In This Channel",
    "Discord Context",
    "Chat History — Older",
    "Chat History — Newer",
  ]);
  return { ...context, sections: context.sections.filter((section) => !omitted.has(section.label)) };
}

function opportunityText(input: {
  config: PrivateLifeConfig;
  phase: PrivateLifeDayPhase;
  selection: PrivateLifeSelection;
  timezone: string;
  now: number;
  recentLabels: readonly string[];
}): string {
  const sleepInstruction = input.phase === "sleep-window"
    ? "You are currently asleep. Usually remain asleep. A rare episode may be a dream fragment, discomfort, noise, or a brief waking thought. Do not perform external or visible actions."
    : input.phase === "late-night"
      ? "Respect the late hour. Quiet private activity is plausible; disruptive, social, physical, or time-dependent action needs a concrete reason and plausible availability."
      : "Respect the current time and weekday when choosing any event or action.";
  return [
    localTimeText(input.now, input.timezone, input.phase),
    `Configured opportunity cadence: about ${input.config.opportunitiesPerDay} per day; this turn does not need to cover everything.`,
    sleepInstruction,
    "",
    `Attention origin: ${input.selection.origin}`,
    `Activity mode: ${input.selection.mode}`,
    `Subject territory: ${input.selection.territory}`,
    `Action scope: ${input.selection.actionScope}`,
    input.selection.actionScope === "reflect-only"
      ? "Remain in private thought. Do not use tools, perform external actions, or send Discord output."
      : input.selection.actionScope === "quiet-exploration"
        ? "Quiet read-only exploration is available. Do not change external state or send Discord output."
        : input.selection.actionScope === "private-action"
          ? "Private action is available. Do not perform public Discord actions or send Discord output."
          : "A social opportunity is available, but visible output remains optional.",
    input.selection.continuedThreadContent === undefined
      ? ""
      : `Selected inner thread: ${input.selection.continuedThreadId ?? "unknown"}: ${input.selection.continuedThreadContent}`,
    input.selection.candidateSeeds.length === 0
      ? ""
      : `Concrete seed directions:\n${input.selection.candidateSeeds.map((seed) => `- ${seed}`).join("\n")}`,
    input.recentLabels.length === 0
      ? ""
      : `Recent private-life subjects to avoid repeating without a new hook:\n${input.recentLabels.map((label) => `- ${label}`).join("\n")}`,
    "",
    "The origin, mode, and territory direct attention but do not prescribe an event, opinion, emotion, or result. Consider several distinct concrete possibilities inside them. Follow a real pull, transform the direction, or do nothing. Visible output remains optional.",
  ].filter((part) => part !== "").join("\n");
}

export function createPrivateLifeRuntime(deps: PrivateLifeRuntimeDeps): PrivateLifeRuntime {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let running = false;
  let scheduleGeneration = 0;

  function config(): PrivateLifeConfig | undefined {
    return deps.getGlobalConfig().privateLife;
  }

  async function resolveLocation(overrides?: { guildId?: string; channelId?: string }): Promise<{
    guild: Guild;
    channel: SendableGuildChannel;
    guildConfig: GuildConfig;
  } | null> {
    const current = config();
    if (current === undefined) return null;
    const guildId = overrides?.guildId ?? current.guildId ?? (() => {
      const row = deps.db.raw.prepare(`SELECT guild_id FROM messages
        WHERE is_bot = 0 AND deleted_at IS NULL
        GROUP BY guild_id ORDER BY COUNT(*) DESC LIMIT 1`).get() as { guild_id: string } | null;
      return row?.guild_id ?? deps.client.guilds.cache.first()?.id;
    })();
    if (guildId === undefined) return null;
    const guild = await deps.resolveClientGuild(guildId);
    if (guild === null) return null;
    const channelId = overrides?.channelId ?? current.channelId ?? (() => {
      const row = deps.db.raw.prepare(`SELECT channel_id FROM messages
        WHERE guild_id = ? AND is_bot = 0 AND deleted_at IS NULL
        GROUP BY channel_id ORDER BY COUNT(*) DESC LIMIT 1`).get(guildId) as { channel_id: string } | null;
      return row?.channel_id;
    })();
    if (channelId === undefined) return null;
    const channel = await deps.fetchAccessibleGuildChannel(channelId);
    if (channel === null || channel.guildId !== guildId) return null;
    return { guild, channel, guildConfig: deps.getGuildConfig(guildId) };
  }

  async function schedule(): Promise<void> {
    const generation = ++scheduleGeneration;
    if (!started) return;
    if (timer !== undefined) clearTimeout(timer);
    const current = config();
    if (current === undefined || !current.enabled) return;
    const location = await resolveLocation();
    if (generation !== scheduleGeneration || current !== config()) return;
    const timezone = location?.guildConfig.timezone ?? deps.getGlobalConfig().defaultTimezone;
    const now = Date.now();
    const phase = privateLifeDayPhase(current, timezone, now);
    const opportunityDelay = privateLifeNextDelayMs(current, phase);
    const boundaryDelay = privateLifePhaseBoundaryDelayMs(current, timezone, now);
    const shouldRun = opportunityDelay < boundaryDelay;
    timer = setTimeout(() => {
      timer = undefined;
      if (!shouldRun) {
        void schedule();
        return;
      }
      void runOpportunity("automatic").catch((error: unknown) => {
        deps.log.error("private-life opportunity failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }).finally(() => { void schedule(); });
    }, Math.min(opportunityDelay, boundaryDelay));
    timer.unref();
  }

  async function runOpportunity(mode: RunMode = "automatic", overrides?: {
    guildId?: string;
    channelId?: string;
    origin?: PrivateLifeSelection["origin"];
    mode?: PrivateLifeSelection["mode"];
    territory?: PrivateLifeSelection["territory"];
    actionScope?: PrivateLifeSelection["actionScope"];
  }): Promise<RunOpportunityResult> {
    const current = config();
    if (current === undefined || !current.enabled) return { error: "Private life is disabled." };
    if (running) return { error: "A private-life opportunity is already running." };
    const location = await resolveLocation(overrides);
    if (location === null) return { error: "No private-life guild and channel are available." };
    if (mode === "automatic" && deps.isBusy?.(location.guild.id, location.channel.id) === true) {
      return { error: "The selected location is busy." };
    }

    running = true;
    const now = Date.now();
    const phase = privateLifeDayPhase(current, location.guildConfig.timezone, now);
    const visibleOutputAvailableAtStart = deps.hasRecentVisibleOutput?.(
      now - current.visibleOutputCooldownMinutes * 60_000,
    ) !== true;
    const recent = listRecentPrivateLifeSummaries(deps.db, current.recentThemeLimit);
    const threads = location.guildConfig.innerThreads?.enabled === false
      ? []
      : listInnerThreads(deps.db, {
          status: "active",
          guildId: location.guild.id,
          limit: 50,
        }).filter((thread) => thread.expiresAt === null || thread.expiresAt > now);
    const selection = selectPrivateLifeCuriosity({
      config: current,
      phase,
      recent,
      threads,
      now,
      ...(overrides?.origin !== undefined ? { origin: overrides.origin } : {}),
      ...(overrides?.mode !== undefined ? { mode: overrides.mode } : {}),
      ...(overrides?.territory !== undefined ? { territory: overrides.territory } : {}),
      ...(overrides?.actionScope !== undefined ? { actionScope: overrides.actionScope } : {}),
      socialOutputAvailable: mode === "draft"
        || (phase !== "sleep-window" && visibleOutputAvailableAtStart),
    });
    const episodeId = `private-life:${crypto.randomUUID()}`;
    if (mode === "automatic") {
      createPrivateLifeEpisode(deps.db, {
        id: episodeId,
        guildId: location.guild.id,
        channelId: location.channel.id,
        dayPhase: phase,
        selection,
        createdAt: now,
      });
    }
    const requestLog = new RequestLog(location.guild.id, location.channel.id, deps.requestLogStore);
    requestLog.setAuthor(mode === "draft" ? "prompt-lab:private-life" : "private-life");
    requestLog.setTrigger({ type: "private_life", episodeId, phase, selection });
    requestLog.setTriggerContext({
      messageId: episodeId,
      authorUsername: "private-life",
      content: `${selection.origin} / ${selection.mode} / ${selection.territory}`,
      translatedContent: `${selection.origin} / ${selection.mode} / ${selection.territory}`,
    });
    requestLog.setAgentRan(true);
    deps.requestLogStore.incrementActive();
    const drafts: PromptLabDraftMessage[] = [];
    const dryRuns: PromptLabDryRun[] = [];
    try {
      const text = opportunityText({
        config: current,
        phase,
        selection,
        timezone: location.guildConfig.timezone,
        now,
        recentLabels: recent.map((theme) => theme.label),
      });
      const botUserId = deps.client.user?.id ?? "";
      const botUsername = deps.client.user?.username ?? "bot";
      const latest: HistoryMessage = {
        id: episodeId,
        author: botUsername,
        authorId: botUserId,
        content: text,
        isBot: true,
        timestamp: now,
        replyToId: null,
        hasEmbeds: false,
        isSynthetic: true,
        relatedThreadId: null,
      };
      const builtContext = await deps.buildContext(
        location.guild.id,
        location.channel.id,
        location.guild,
        location.guildConfig,
        text,
        latest,
        deps.createSyntheticReplyFallbackDeps({
          db: deps.db,
          guildId: location.guild.id,
          channelId: location.channel.id,
        }),
        location.channel.isThread(),
        { timestamp: now, messageId: episodeId },
        "private-life",
        undefined,
        { appendLatestToHistory: false },
      );
      const context = addPrivateLifeInstruction(
        restrictContext(builtContext, selection),
        deps.getPromptBundle().runtime.privateLife ?? "",
      );
      const incoming: IncomingMessage = {
        content: text,
        guildId: location.guild.id,
        guildName: location.guild.name,
        channelId: location.channel.id,
        channelName: channelDisplayName(location.channel),
        authorId: botUserId,
        authorUsername: botUsername,
        authorIsBot: true,
        botUserId,
        mentionedUserIds: [],
        translatedContent: text,
        messageId: episodeId,
        eventPrompt: {
          metadataHeading: "Private-Life Runtime",
          contentHeading: "Private-Life Opportunity",
          metadataText: "No Discord user caused this private opportunity. The current event is trusted runtime context.",
        },
      };
      const actorGuildConfig: GuildConfig = {
        ...location.guildConfig,
        replyLoop: {
          ...location.guildConfig.replyLoop,
          maxToolCalls: current.maxToolCalls,
        },
      };
      const generatedImages = createGeneratedImageRuntime();
      const publicAction = { executed: false };
      const visibleAllowed = (): boolean => selection.actionScope === "social-opportunity"
        && current.allowVisibleOutput
        && phase !== "sleep-window"
        && visibleOutputAvailableAtStart
        && (deps.activeRequestCount?.() ?? 1) <= 1
        && countPrivateLifeVisibleEpisodesSince(deps.db, now - 86_400_000) < current.maxVisiblePerDay;
      const baseTools = deps.buildAgentTools(
        location.guild.id,
        location.channel.id,
        location.guildConfig,
        location.guild,
        context.contextMessageIds ?? [],
        generatedImages.onGeneratedImage,
        undefined,
        { visibleUserIds: context.visibleUserIds ?? [] },
      );
      const timeSafeTools = baseTools.map((tool) => {
        if (phase === "sleep-window" && !isReadOnlyTool(tool)) return blockedTool(tool, "2B is asleep");
        if (selection.actionScope === "reflect-only") {
          return blockedTool(tool, "this opportunity is private reflection only");
        }
        if (selection.actionScope === "quiet-exploration" && !isReadOnlyTool(tool)) {
          return blockedTool(tool, "this opportunity allows read-only exploration only");
        }
        if (selection.actionScope === "private-action" && PUBLIC_ACTION_TOOL_NAMES.has(tool.name)) {
          return blockedTool(tool, "this opportunity does not allow public Discord actions");
        }
        if (!PUBLIC_ACTION_TOOL_NAMES.has(tool.name)) return tool;
        return {
          ...tool,
          execute: async (toolCallId: string, params: unknown, signal?: AbortSignal) => {
            if (!visibleAllowed()) return await blockedTool(tool, "the private-life public-action budget is closed")
              .execute(toolCallId, params, signal);
            const result = await tool.execute(toolCallId, params, signal);
            if (!toolResultFailed(result)) publicAction.executed = true;
            return result;
          },
          };
      });
      const visibleMaintenanceTools = deps.createVisibleMaintenanceTools({
        episodeId,
        guild: location.guild,
        guildConfig: actorGuildConfig,
        sourceRequestId: requestLog.requestId,
        memoryRequest: {
          sourceMessageId: episodeId,
          userMessage: text,
          assistantReply: "",
          recentContext: context.sections.map((section) => section.text).join("\n\n"),
          context,
          incomingMessage: incoming,
          visibleReplySent: false,
        },
      });
      const tools = mode === "draft"
        ? [...deps.promptLabDryRunTools(timeSafeTools, dryRuns), ...visibleMaintenanceTools]
        : [...timeSafeTools, ...visibleMaintenanceTools];
      const baseSender = deps.createBotDiscordMessageSender({
        defaultChannel: location.channel,
        resolveTargetChannel: createTargetChannelResolver(deps.client, location.channel),
        botUserId,
        botUsername,
        logger: deps.log.child({ component: "private-life-send", episodeId }),
      });
      const sender: MessageSender = mode === "automatic"
        ? baseSender
        : (message, reply, destinationChannelId, voice, _signal, replyToMessageId, attachments) => {
            const id = deps.promptLabSyntheticId(drafts.length + 1);
            drafts.push({
              id,
              text: message,
              reply,
              ...(destinationChannelId !== undefined ? { channelId: destinationChannelId } : {}),
              ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
              attachments: attachments?.map((attachment) => attachment.filename) ?? [],
              voice: voice !== undefined,
            });
            return Promise.resolve({ sentMessageId: id });
          };
      const result = await handleMessage(incoming, deps.createHandlerDeps({
        guildId: location.guild.id,
        guildConfig: actorGuildConfig,
        context,
        currentChannelId: location.channel.id,
        sender,
        extraTools: tools,
        log: deps.log.child({ component: "private-life-actor", episodeId, requestId: requestLog.requestId }),
        requestLog,
        generatedImages,
        resolveAssetAttachments: createStoredAssetAttachmentResolver({
          db: deps.db,
          stagedGuildId: location.guild.id,
          maxDownloadBytes: location.guildConfig.assetReading?.maxDownloadBytes ?? DEFAULT_ASSET_READING.maxDownloadBytes,
          resolveSource: createDiscordAssetSourceResolver({
            fetchMessage: async (channelId, messageId) => {
              const channel = await deps.fetchAccessibleGuildChannel(channelId);
              if (channel === null) return null;
              return await channel.messages.fetch(messageId).catch(() => null);
            },
          }),
          logger: deps.log.child({ component: "private-life-assets", episodeId }),
        }),
        overrides: {
          modelProfile: current.modelProfile,
          runtimePrompts: runtimePromptsForPrivateLife(deps.getPromptBundle()),
          triggerOverride: { reason: "private_life" },
          liveMessageTypingHoldMs: 0,
          disableLiveOutput: true,
          preSendCheck: visibleAllowed,
          hasExternalVisibleOutput: () => publicAction.executed,
        },
      }));
      const thoughts = result.privateThoughts ?? [];
      const visibleDelivered = publicAction.executed
        || (result.responseText !== undefined && result.responseText !== "" && visibleAllowed());
      if (mode === "automatic") {
        completePrivateLifeEpisode(deps.db, {
          id: episodeId,
          requestId: requestLog.requestId,
          ...(thoughts.length > 0 ? { thoughts: thoughts.join("\n\n") } : {}),
          ...(result.responseText !== undefined ? { visibleOutput: result.responseText } : {}),
          visibleDelivered,
        });
      }
      const maintenanceRequest: MemoryExtractionRequest = {
        sourceMessageId: episodeId,
        userMessage: text,
        assistantReply: result.responseText ?? "",
        recentContext: context.sections.map((section) => section.text).join("\n\n"),
        context,
        incomingMessage: incoming,
        visibleReplySent: visibleDelivered,
        maintenanceTranscript: result.maintenanceTranscript,
        availableTools: result.availableTools,
        promptContext: result.promptContext,
      };
      await deps.runMaintenance({
        episodeId,
        guild: location.guild,
        channel: location.channel,
        guildConfig: actorGuildConfig,
        request: maintenanceRequest,
        sourceRequestId: requestLog.requestId,
        dryRun: mode === "draft",
        dryRuns,
      });
      return {
        requestId: requestLog.requestId,
        episodeId,
        drafts,
        dryRuns,
        ...(result.responseText !== undefined ? { responseText: result.responseText } : {}),
        privateThoughts: thoughts,
        dayPhase: phase,
        selection,
        recentLabels: recent.map((theme) => theme.label),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      requestLog.setError(message);
      if (mode === "automatic") failPrivateLifeEpisode(deps.db, episodeId, message);
      return { requestId: requestLog.requestId, episodeId, error: message };
    } finally {
      running = false;
      requestLog.emit(deps.log);
      deps.requestLogStore.decrementActive();
    }
  }

  async function runPromptLab(input: {
    guildId: string;
    channelId: string;
    origin?: PrivateLifeSelection["origin"];
    mode?: PrivateLifeSelection["mode"];
    territory?: PrivateLifeSelection["territory"];
    actionScope?: PrivateLifeSelection["actionScope"];
  }): Promise<PrivateLifePromptLabResult> {
    const result = await runOpportunity("draft", input);
    const entry = result.requestId === undefined ? null : deps.requestLogStore.getByRequestId(result.requestId);
    const summary = entry === null
      ? { toolCount: 0, llmCallCount: 0, estimatedCostUsd: null, totalDurationMs: 0 }
      : deps.promptLabSummary(entry);
    return {
      requestId: result.requestId ?? `private-life-unavailable:${crypto.randomUUID()}`,
      triggered: result.error === undefined,
      drafts: result.drafts ?? [],
      dryRuns: result.dryRuns ?? [],
      ...summary,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.selection !== undefined && result.dayPhase !== undefined ? {
        ...(result.responseText !== undefined ? { responseText: result.responseText } : {}),
        privateLife: {
          dayPhase: result.dayPhase,
          selection: result.selection,
          recentLabels: result.recentLabels ?? [],
          privateThoughts: result.privateThoughts ?? [],
        },
      } : {}),
    };
  }

  return {
    start: () => {
      started = true;
      void schedule();
    },
    clear: () => {
      started = false;
      scheduleGeneration += 1;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    runOpportunity,
    runPromptLab,
    listEpisodes: (limit = 50) => listPrivateLifeEpisodes(deps.db, limit),
  };
}
