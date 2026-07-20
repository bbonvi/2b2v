import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Client, Guild } from "discord.js";
import type { Database } from "../db/database";
import type { Logger, RequestLog } from "../logger";
import { RequestLog as RuntimeRequestLog } from "../logger";
import type { RequestLogStore } from "../dashboard/store";
import type { AgentJobStore } from "../agent/job-runtime";
import type { AmbientInitiativeConfig, GlobalConfig, GuildConfig } from "../config/types";
import type { PromptBundle } from "../config/instruction-bundle";
import type { AssembledContext } from "../agent/context-assembly";
import type {
  HandlerDeps,
  IncomingMessage,
  MemoryExtractionRequest,
  MessageSender,
} from "../agent/handler";
import { handleMessage } from "../agent/handler";
import type { HistoryMessage } from "../agent/history-types";
import type { GeneratedImageAttachment } from "../agent/codex-image-tool";
import type { ReplyFallbackDeps } from "../agent/reply-target-fallback";
import type {
  PromptLabDraftMessage,
  PromptLabDryRun,
  PromptLabRunResult,
} from "../dashboard/prompt-lab-types";
import type {
  ResolveTargetChannel,
  SendableGuildChannel,
} from "../discord/message-sender";
import {
  botChannelPermissions,
  channelDisplayName,
  createTargetChannelResolver,
  isSendableGuildChannel,
} from "../discord/message-sender";
import { getHistoryMessages } from "../db/message-repository";
import { listApplicableInnerThreads } from "../db/inner-thread-repository";
import { formatHistoryContent } from "../agent/history-formatting";
import { formatLocalWallClock } from "../time/agent-time";
import {
  buildModelProfileStreamOptions,
  resolveModelProfile,
} from "../llm/client";
import { completeLlmChat } from "../llm/chat";
import { createGeneratedImageRuntime } from "../agent/generated-image-runtime";
import { createStoredAssetAttachmentResolver } from "../agent/stored-asset-attachments";
import { createDiscordAssetSourceResolver } from "../discord/asset-resolver";
import { DEFAULT_ASSET_READING } from "../config/defaults";
import { renderPromptTemplate } from "../config/prompt-template";

type RunMode = "automatic" | "draft" | "shadow";

type Candidate = {
  id: string;
  guildId: string;
  channelId: string;
  createdAt: number;
  mode: RunMode;
  forced: boolean;
  forceDecision: boolean;
  runToken?: string;
};

type Decision = {
  shouldWake: boolean;
  wakeProbability: number;
  confidence: number;
  reason: string;
};

export type AmbientInitiativeSignals = {
  now: number;
  inActiveHours: boolean;
  quietMs: number | null;
  lastHumanAt: number | null;
  lastBotAt: number | null;
  recentHumanCount: number;
  recentBotCount: number;
  pendingAmbientCandidates: number;
  activeImageJobs: number;
  strongestThreadPressure: number;
  applicableThreadCount: number;
  applicableThreads: Array<{
    id: string;
    content: string;
    pressure: number;
    recallScope: "anywhere" | "guild";
    recallGuildId: string | null;
  }>;
  lastInitiativeAt: number | null;
  visibleUserIds: string[];
};

export type AmbientInitiativePressure = {
  rawValue: number;
  value: number;
  roll: number;
  passed: boolean;
  adjustments: string[];
  inputs: Record<string, number | boolean | string | null>;
};

type InitiativeRecord = {
  guildId: string;
  channelId: string;
  sent: boolean;
  createdAt: number;
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

export type GenericAmbientInitiativeDeps = {
  db: Database;
  client: Client;
  log: Logger;
  requestLogStore: RequestLogStore;
  agentJobs: AgentJobStore;
  getPromptBundle: () => PromptBundle;
  getGlobalConfig: () => GlobalConfig;
  getGuildConfig: (guildId: string) => GuildConfig;
  dashboardTriggerLocation: (guild: Guild, channel: unknown) => { guildName: string; channelName?: string };
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
    relationshipsMode?: "live" | "virtual",
    excludeMessageIds?: readonly string[],
    historyOptions?: {
      appendLatestToHistory?: boolean;
      triggerMessageIds?: readonly string[];
      additionalVisibleUserIds?: readonly string[];
    },
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
  promptLabDryRunTools: (tools: AgentTool[], dryRuns: PromptLabDryRun[]) => AgentTool[];
  promptLabSyntheticId: (offset?: number) => string;
  promptLabSummary: (
    entry: ReturnType<RequestLog["toEntry"]>,
  ) => Omit<
    PromptLabRunResult,
    | "requestId"
    | "triggered"
    | "drafts"
    | "dryRuns"
    | "responseText"
    | "relationshipsContext"
    | "relationshipsExtraction"
    | "memoryExtraction"
    | "error"
  >;
  resolveClientGuild: (guildId: string) => Promise<Guild | null>;
  fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
  createSyntheticReplyFallbackDeps: (input: {
    db: Database;
    guildId: string;
    channelId: string;
  }) => ReplyFallbackDeps;
  createBotDiscordMessageSender: (input: {
    defaultChannel: SendableGuildChannel;
    resolveTargetChannel: ResolveTargetChannel;
    botUserId: string;
    botUsername: string;
    logger: Logger;
  }) => MessageSender;
  createVisibleMaintenanceTools: (input: {
    guild: Guild;
    guildConfig: GuildConfig;
    memoryRequest: MemoryExtractionRequest;
    sourceRequestId: string;
  }) => AgentTool[];
  createHandlerDeps: (input: CreateHandlerDepsInput) => HandlerDeps;
  pendingAmbientCandidatesInChannel: (guildId: string, channelId: string) => number;
  isAutonomousAttentionBusy: (guildId: string, channelId: string) => boolean;
  preparePersonaModeTurn?: (guildId: string) => void;
  runMaintenance?: (input: {
    guildConfig: GuildConfig;
    request: MemoryExtractionRequest;
    guild: Guild;
    channel: SendableGuildChannel;
    sourceRequestId: string;
    dryRun?: boolean;
    dryRuns?: PromptLabDryRun[];
  }) => Promise<void>;
};

export type GenericAmbientInitiativeRuntime = {
  runOpportunity: (
    guildId: string,
    mode?: RunMode,
    runToken?: string,
  ) => Promise<{ requestId?: string; error?: string }>;
  scheduleGuild: (guildId: string) => void;
  startLoops: () => void;
  runPromptLab: (input: {
    guildId: string;
    channelId: string;
    force?: boolean;
    runToken?: string;
  }) => Promise<PromptLabRunResult>;
  clear: () => void;
};

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * Math.max(0, max - min);
}

/** Apply ordinary social resistance while allowing genuinely high pressure to overcome it. */
export function applyAmbientInitiativeResistance(value: number, resistance: number): number {
  const boundedValue = clamp(value);
  const boundedResistance = clamp(resistance);
  return boundedValue * (boundedResistance + boundedValue * (1 - boundedResistance));
}

/** Calculate the probability that one cheap Ambient Initiative check reaches its evaluator. */
export function calculateAmbientInitiativePressure(
  config: AmbientInitiativeConfig,
  signals: AmbientInitiativeSignals,
  roll = Math.random(),
): AmbientInitiativePressure {
  const threadAdjusted = config.basePressure
    + signals.strongestThreadPressure * (1 - config.basePressure);
  let value = threadAdjusted;
  const adjustments: string[] = [];
  const resist = (condition: boolean, label: string, resistance: number): void => {
    if (!condition) return;
    value = applyAmbientInitiativeResistance(value, resistance);
    adjustments.push(label);
  };
  resist(!signals.inActiveHours, "outside_active_hours", 0.25);
  resist(signals.lastHumanAt === null, "no_recent_human_activity", 0.2);
  resist(signals.quietMs !== null && signals.quietMs < config.quietWindowMs, "room_not_quiet", 0.45);
  resist(
    signals.quietMs !== null && signals.quietMs < config.recentActivityMinMs,
    "human_activity_too_recent",
    0.6,
  );
  resist(
    signals.quietMs !== null && signals.quietMs > config.recentActivityMaxMs,
    "room_activity_stale",
    0.45,
  );
  resist(
    signals.lastBotAt !== null && signals.now - signals.lastBotAt < config.botCooldownMs,
    "recent_actor_output",
    0.35,
  );
  resist(
    signals.lastInitiativeAt !== null && signals.now - signals.lastInitiativeAt < config.cooldownMs,
    "recent_visible_initiative",
    0.2,
  );
  value = clamp(value);
  return {
    rawValue: threadAdjusted,
    value,
    roll,
    passed: roll <= value,
    adjustments,
    inputs: {
      basePressure: config.basePressure,
      strongestThreadPressure: signals.strongestThreadPressure,
      applicableThreadCount: signals.applicableThreadCount,
      inActiveHours: signals.inActiveHours,
      quietMs: signals.quietMs,
      recentActorOutput: signals.lastBotAt !== null
        && signals.now - signals.lastBotAt < config.botCooldownMs,
      recentInitiative: signals.lastInitiativeAt !== null
        && signals.now - signals.lastInitiativeAt < config.cooldownMs,
    },
  };
}

function parseClockMinutes(value: string): number {
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

function localClockMinutes(timezone: string, now: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(now));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function inActiveHours(config: AmbientInitiativeConfig, guildConfig: GuildConfig, now: number): boolean {
  const current = localClockMinutes(config.activeHours.timezone ?? guildConfig.timezone, now);
  const start = parseClockMinutes(config.activeHours.start);
  const end = parseClockMinutes(config.activeHours.end);
  if (start === end) return true;
  return start < end
    ? current >= start && current <= end
    : current >= start || current <= end;
}

function renderHistory(history: readonly HistoryMessage[], timezone: string): string {
  return history.map((message) => {
    const reply = message.replyToId !== null ? ` reply_to=${message.replyToId}` : "";
    return `[${formatLocalWallClock(message.timestamp, timezone)}] ${message.author} (${message.authorId})${reply}: ${formatHistoryContent(message)}`;
  }).join("\n");
}

function recordRuntimeAction(
  requestLog: RequestLog,
  id: string,
  tool: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  isError = false,
): void {
  requestLog.recordToolStart(id, tool, args);
  requestLog.recordToolEnd(id, isError, {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  });
}

export function createGenericAmbientInitiativeRuntime(
  deps: GenericAmbientInitiativeDeps,
): GenericAmbientInitiativeRuntime {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();
  const records: InitiativeRecord[] = [];
  let loopsEnabled = false;

  function resolveMainChannel(guild: Guild, config: AmbientInitiativeConfig): SendableGuildChannel | null {
    if (config.mainChannelId !== undefined && config.mainChannelId !== "") {
      const channel = deps.client.channels.cache.get(config.mainChannelId);
      return channel !== undefined
        && isSendableGuildChannel(channel)
        && channel.guildId === guild.id
        && botChannelPermissions(deps.client, channel).canSend
        ? channel
        : null;
    }
    const after = Date.now() - config.mainChannelLookbackDays * 86_400_000;
    const rows = deps.db.raw.prepare(
      `SELECT channel_id, COUNT(*) AS count
       FROM messages
       WHERE guild_id = ? AND is_bot = 0 AND is_synthetic = 0
         AND is_prompt_only = 0 AND created_at >= ?
       GROUP BY channel_id ORDER BY count DESC`,
    ).all(guild.id, after) as Array<{ channel_id: string; count: number }>;
    for (const row of rows) {
      if (row.count < config.minMainChannelHumanMessages) continue;
      const channel = deps.client.channels.cache.get(row.channel_id);
      if (channel !== undefined
        && isSendableGuildChannel(channel)
        && channel.guildId === guild.id
        && botChannelPermissions(deps.client, channel).canSend) {
        return channel;
      }
    }
    return null;
  }

  function buildSignals(
    guild: Guild,
    channelId: string,
    guildConfig: GuildConfig,
    config: AmbientInitiativeConfig,
  ): AmbientInitiativeSignals {
    const now = Date.now();
    const rows = deps.db.raw.prepare(
      `SELECT user_id, is_bot, created_at
       FROM messages
       WHERE guild_id = ? AND channel_id = ? AND is_synthetic = 0
         AND is_prompt_only = 0 AND created_at >= ?
       ORDER BY created_at DESC, id DESC LIMIT 200`,
    ).all(guild.id, channelId, now - config.recentActivityMaxMs) as Array<{
      user_id: string;
      is_bot: number;
      created_at: number;
    }>;
    let lastHumanAt: number | null = null;
    let lastBotAt: number | null = null;
    let recentHumanCount = 0;
    let recentBotCount = 0;
    const visibleUserIds: string[] = [];
    for (const row of rows) {
      if (row.is_bot === 0) {
        recentHumanCount += 1;
        lastHumanAt ??= row.created_at;
        if (!visibleUserIds.includes(row.user_id)) visibleUserIds.push(row.user_id);
      } else if (row.user_id === deps.client.user?.id) {
        recentBotCount += 1;
        lastBotAt ??= row.created_at;
      }
    }
    const threads = listApplicableInnerThreads(deps.db, {
      guildId: guild.id,
      visibleUserIds,
      limit: 50,
    });
    const lastInitiative = [...records].reverse().find((record) =>
      record.guildId === guild.id && record.channelId === channelId && record.sent
    );
    return {
      now,
      inActiveHours: inActiveHours(config, guildConfig, now),
      quietMs: lastHumanAt === null ? null : now - lastHumanAt,
      lastHumanAt,
      lastBotAt,
      recentHumanCount,
      recentBotCount,
      pendingAmbientCandidates: deps.pendingAmbientCandidatesInChannel(guild.id, channelId),
      activeImageJobs: deps.agentJobs
        .listVisible(guild.id, channelId)
        .filter((job) => job.status === "queued" || job.status === "running").length,
      strongestThreadPressure: threads.reduce(
        (highest, thread) => Math.max(highest, thread.pressure),
        0,
      ),
      applicableThreadCount: threads.length,
      applicableThreads: threads.slice(0, 8).map((thread) => ({
        id: thread.id,
        content: thread.content,
        pressure: thread.pressure,
        recallScope: thread.recallScope,
        recallGuildId: thread.recallGuildId,
      })),
      lastInitiativeAt: lastInitiative?.createdAt ?? null,
      visibleUserIds,
    };
  }

  function hardGate(input: {
    guildId: string;
    channelId: string;
    config: AmbientInitiativeConfig;
    signals: AmbientInitiativeSignals;
    forced: boolean;
  }): string | null {
    if (!input.config.enabled && !input.forced) return "ambient initiative disabled";
    if (!input.forced && deps.isAutonomousAttentionBusy(input.guildId, input.channelId)) {
      return "scheduled task active";
    }
    if (input.signals.activeImageJobs > 0) return "active image job visible";
    if (input.signals.pendingAmbientCandidates > 0) return "ambient attention pending";
    const daily = records.filter((record) =>
      record.guildId === input.guildId
      && record.channelId === input.channelId
      && record.sent
      && input.signals.now - record.createdAt <= 86_400_000
    ).length;
    if (!input.forced && daily >= input.config.maxPerDay) return "daily initiative budget exhausted";
    return null;
  }

  function createRequestLog(
    guild: Guild,
    channel: SendableGuildChannel,
    candidate: Candidate,
  ): RequestLog {
    const requestLog = new RuntimeRequestLog(candidate.guildId, candidate.channelId, deps.requestLogStore);
    requestLog.setAuthor(candidate.mode === "draft" ? "prompt-lab:ambient-initiative" : "ambient-initiative");
    requestLog.setTrigger({
      type: "ambient_initiative_evaluator",
      kind: "generic",
      status: "evaluating",
      mode: candidate.mode,
      ...(candidate.runToken !== undefined ? { runToken: candidate.runToken } : {}),
    });
    requestLog.setTriggerContext({
      ...deps.dashboardTriggerLocation(guild, channel),
      messageId: candidate.id,
      authorUsername: "ambient-initiative",
      content: "generic cognitive opportunity",
      translatedContent: "generic cognitive opportunity",
    });
    requestLog.setAgentRan(true);
    return requestLog;
  }

  async function evaluate(input: {
    guildConfig: GuildConfig;
    config: AmbientInitiativeConfig;
    signals: AmbientInitiativeSignals;
    pressure: AmbientInitiativePressure;
    history: HistoryMessage[];
    requestLog: RequestLog;
  }): Promise<Decision | null> {
    const globalConfig = deps.getGlobalConfig();
    const profile = resolveModelProfile(globalConfig, input.config.evaluator.modelProfile);
    const streamOptions = buildModelProfileStreamOptions(globalConfig, input.config.evaluator.modelProfile);
    const providerParams: Record<string, unknown> = { ...streamOptions };
    delete providerParams.apiKey;
    try {
      const result = await completeLlmChat({
        provider: profile.provider,
        apiKey: streamOptions.apiKey,
        model: profile.model,
        systemPrompt: [
          deps.getPromptBundle().runtime.ambientInitiative.evaluator,
          "Return only compact JSON with should_wake, wake_probability, confidence, and reason.",
        ].join("\n\n"),
        messages: [{
          role: "user",
          content: [
            `now: ${new Date(input.signals.now).toISOString()}`,
            `signals: ${JSON.stringify(input.signals)}`,
            `pressure: ${JSON.stringify(input.pressure)}`,
            "Recent channel history:",
            renderHistory(input.history, input.guildConfig.timezone),
          ].join("\n\n"),
        }],
        providerParams,
        onPayload: (payload) => input.requestLog.recordLLMRequest(payload),
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "ambient_initiative_wake",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["should_wake", "wake_probability", "confidence", "reason"],
              properties: {
                should_wake: { type: "boolean" },
                wake_probability: { type: "number", minimum: 0, maximum: 1 },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                reason: { type: "string" },
              },
            },
          },
        },
        toolChoice: "none",
        parallelToolCalls: false,
        signal: AbortSignal.timeout(input.config.evaluator.llmOutputTimeoutMs),
      });
      input.requestLog.recordLLMCompletion(result.messageForLogs);
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      return {
        shouldWake: parsed.should_wake === true,
        wakeProbability: typeof parsed.wake_probability === "number"
          ? clamp(parsed.wake_probability)
          : 0,
        confidence: typeof parsed.confidence === "number" ? clamp(parsed.confidence) : 0,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      };
    } catch (error) {
      input.requestLog.recordLLMError(error);
      deps.log.warn("ambient initiative wake evaluation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  function activityAfter(
    guildId: string,
    channelId: string,
    after: number,
  ): Array<{ id: string; userId: string; content: string; replyToId: string | null }> {
    return deps.db.raw.prepare(
      `SELECT id, user_id AS userId, raw_content AS content, reply_to_id AS replyToId
       FROM messages
       WHERE guild_id = ? AND channel_id = ? AND is_bot = 0 AND is_synthetic = 0
         AND is_prompt_only = 0 AND created_at > ?
       ORDER BY created_at ASC, id ASC`,
    ).all(guildId, channelId, after) as Array<{
      id: string;
      userId: string;
      content: string;
      replyToId: string | null;
    }>;
  }

  function includesOrdinaryTrigger(
    activity: ReturnType<typeof activityAfter>,
    guildConfig: GuildConfig,
  ): boolean {
    const botUserId = deps.client.user?.id ?? "";
    return activity.some((message) => {
      if (message.content.includes(`<@${botUserId}>`) || message.content.includes(`<@!${botUserId}>`)) {
        return true;
      }
      if (guildConfig.triggers.keywords.some((keyword) => {
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu")
          .test(message.content);
      })) {
        return true;
      }
      if (message.replyToId === null) return false;
      const replied = deps.db.raw.prepare("SELECT user_id FROM messages WHERE id = ?").get(
        message.replyToId,
      ) as { user_id: string } | null;
      return replied?.user_id === botUserId;
    });
  }

  async function generate(input: {
    guild: Guild;
    channel: SendableGuildChannel;
    guildConfig: GuildConfig;
    config: AmbientInitiativeConfig;
    candidate: Candidate;
    requestLog: RequestLog;
    draft?: { drafts: PromptLabDraftMessage[]; dryRuns: PromptLabDryRun[] };
    reconsideration?: {
      rejectedDraft: string;
      activity: ReturnType<typeof activityAfter>;
    };
  }): Promise<{
    responseText?: string;
    visible: boolean;
    preSendRejected: boolean;
    rejectedDraft?: string;
  }> {
    const botUserId = deps.client.user?.id ?? "";
    const botUsername = deps.client.user?.username ?? "bot";
    const now = Date.now();
    const opportunityTemplate = deps.getPromptBundle().runtime.contextTemplates[
      "ambient-initiative-opportunity"
    ] ?? "This is an autonomous cognitive opportunity. Visible speech is optional.";
    const opportunityText = renderPromptTemplate(
      opportunityTemplate,
      {
        botContactsLine: input.config.botContactIds.length > 0
          ? `Known bot contacts available in this guild: ${input.config.botContactIds.join(", ")}. They are optional participants, not targets; choose freely whether anyone should be addressed.\n\n`
          : "",
        reconsiderationBlock: input.reconsideration === undefined
          ? ""
          : [
              "A first visible draft was held because newer room activity arrived.",
              `Unsent draft: ${input.reconsideration.rejectedDraft}`,
              `New activity: ${JSON.stringify(input.reconsideration.activity)}`,
              "Reconsider freely. The prior draft was not delivered.",
            ].join("\n"),
      },
    );
    const latest: HistoryMessage = {
      id: input.candidate.id,
      author: botUsername,
      authorId: botUserId,
      content: opportunityText,
      isBot: true,
      timestamp: now,
      replyToId: null,
      hasEmbeds: false,
      isSynthetic: true,
      relatedThreadId: null,
    };
    const context = await deps.buildContext(
      input.candidate.guildId,
      input.candidate.channelId,
      input.guild,
      input.guildConfig,
      opportunityText,
      latest,
      deps.createSyntheticReplyFallbackDeps({
        db: deps.db,
        guildId: input.candidate.guildId,
        channelId: input.candidate.channelId,
      }),
      input.channel.isThread(),
      { timestamp: now, messageId: input.candidate.id },
      "virtual",
      undefined,
      {
        appendLatestToHistory: false,
        additionalVisibleUserIds: input.reconsideration?.activity.map((item) => item.userId),
      },
    );
    if (input.draft === undefined) deps.preparePersonaModeTurn?.(input.candidate.guildId);
    const generatedImages = createGeneratedImageRuntime();
    const incoming: IncomingMessage = {
      content: opportunityText,
      guildId: input.candidate.guildId,
      guildName: input.guild.name,
      channelId: input.candidate.channelId,
      channelName: channelDisplayName(input.channel),
      authorId: botUserId,
      authorUsername: botUsername,
      authorIsBot: true,
      botUserId,
      mentionedUserIds: [],
      translatedContent: opportunityText,
      messageId: input.candidate.id,
      eventPrompt: {
        metadataHeading: "Autonomous Opportunity",
        contentHeading: "Private Opportunity",
        metadataText: "No Discord message caused this invocation. Activation diagnostics are not actor instructions.",
      },
    };
    const baseTools = deps.buildAgentTools(
      input.candidate.guildId,
      input.candidate.channelId,
      input.guildConfig,
      input.guild,
      context.contextMessageIds ?? [],
      generatedImages.onGeneratedImage,
      undefined,
      { visibleUserIds: context.visibleUserIds ?? [] },
    );
    const visibleMaintenanceTools = deps.createVisibleMaintenanceTools({
      guild: input.guild,
      guildConfig: input.guildConfig,
      memoryRequest: {
        sourceMessageId: input.candidate.id,
        userMessage: opportunityText,
        assistantReply: "",
        recentContext: "",
        context,
        incomingMessage: incoming,
        visibleReplySent: false,
      },
      sourceRequestId: input.requestLog.requestId,
    });
    const actorTools = [...baseTools, ...visibleMaintenanceTools];
    const tools = input.draft === undefined
      ? actorTools
      : deps.promptLabDryRunTools(actorTools, input.draft.dryRuns);
    const baseSender = deps.createBotDiscordMessageSender({
      defaultChannel: input.channel,
      resolveTargetChannel: createTargetChannelResolver(deps.client, input.channel),
      botUserId,
      botUsername,
      logger: deps.log.child({
        component: "ambient-initiative-send",
        guildId: input.candidate.guildId,
        channelId: input.candidate.channelId,
      }),
    });
    const sender: MessageSender = async (
      text,
      reply,
      destinationChannelId,
      voice,
      signal,
      replyToMessageId,
      attachments,
    ) => {
      if (input.draft === undefined) {
        return await baseSender(
          text,
          reply,
          destinationChannelId,
          voice,
          signal,
          replyToMessageId,
          attachments,
        );
      }
      const id = deps.promptLabSyntheticId(input.draft.drafts.length + 1);
      input.draft.drafts.push({
        id,
        text,
        reply,
        ...(destinationChannelId !== undefined ? { channelId: destinationChannelId } : {}),
        ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
        attachments: attachments?.map((attachment) => attachment.filename) ?? [],
        voice: voice !== undefined,
      });
      return { sentMessageId: id };
    };
    let rejectedDraft = "";
    input.requestLog.setTriggerContext({
      ...deps.dashboardTriggerLocation(input.guild, input.channel),
      messageId: input.candidate.id,
      authorUsername: "ambient-initiative",
      content: opportunityText,
      translatedContent: opportunityText,
    });
    const result = await handleMessage(
      incoming,
      deps.createHandlerDeps({
        guildId: input.candidate.guildId,
        guildConfig: input.guildConfig,
        context,
        currentChannelId: input.candidate.channelId,
        sender,
        extraTools: tools,
        log: deps.log.child({
          component: "ambient-initiative-actor",
          guildId: input.candidate.guildId,
          channelId: input.candidate.channelId,
          requestId: input.requestLog.requestId,
        }),
        requestLog: input.requestLog,
        generatedImages,
        resolveAssetAttachments: createStoredAssetAttachmentResolver({
          db: deps.db,
          stagedGuildId: input.candidate.guildId,
          maxDownloadBytes: input.guildConfig.assetReading?.maxDownloadBytes
            ?? DEFAULT_ASSET_READING.maxDownloadBytes,
          resolveSource: createDiscordAssetSourceResolver({
            fetchMessage: async (channelId, messageId) => {
              const channel = await deps.fetchAccessibleGuildChannel(channelId);
              if (channel === null) return null;
              try {
                return await channel.messages.fetch(messageId);
              } catch {
                return null;
              }
            },
          }),
          logger: deps.log.child({ component: "ambient-initiative-assets" }),
        }),
        modeLifecycle: input.draft === undefined,
        overrides: {
          triggerOverride: { reason: "ambient_initiative" },
          liveMessageTypingHoldMs: 0,
          disableLiveOutput: true,
          preSendCheck: (draftText) => {
            if (input.draft !== undefined || input.reconsideration !== undefined) return true;
            const activity = activityAfter(
              input.candidate.guildId,
              input.candidate.channelId,
              input.candidate.createdAt,
            );
            if (activity.length === 0) return true;
            rejectedDraft = draftText;
            return false;
          },
          ...(deps.runMaintenance === undefined
            ? {}
            : {
                afterReply: async (request) => {
                  await deps.runMaintenance?.({
                    guildConfig: input.guildConfig,
                    request,
                    guild: input.guild,
                    channel: input.channel,
                    sourceRequestId: input.requestLog.requestId,
                    ...(input.draft !== undefined
                      ? { dryRun: true, dryRuns: input.draft.dryRuns }
                      : {}),
                  });
                },
              }),
        },
      }),
    );
    return {
      ...(result.responseText !== undefined ? { responseText: result.responseText } : {}),
      visible: result.responseText !== undefined && result.responseText !== "",
      preSendRejected: rejectedDraft !== "",
      ...(rejectedDraft !== "" ? { rejectedDraft } : {}),
    };
  }

  async function runCandidate(input: {
    guild: Guild;
    channel: SendableGuildChannel;
    candidate: Candidate;
    draft?: { drafts: PromptLabDraftMessage[]; dryRuns: PromptLabDryRun[] };
  }): Promise<{
    requestId: string;
    responseText?: string;
    sent: boolean;
    error?: string;
  }> {
    const guildConfig = deps.getGuildConfig(input.candidate.guildId);
    const config = guildConfig.ambientInitiative;
    if (config === undefined) throw new Error("Ambient initiative is not configured.");
    const lockKey = `${input.candidate.guildId}:${input.candidate.channelId}`;
    const requestLog = createRequestLog(input.guild, input.channel, input.candidate);
    deps.requestLogStore.incrementActive();
    if (running.has(lockKey)) {
      recordRuntimeAction(
        requestLog,
        `${input.candidate.id}:lock`,
        "ambient_initiative_lock",
        {},
        { status: "dropped", reason: "initiative already running" },
      );
      requestLog.emit(deps.log);
      deps.requestLogStore.decrementActive();
      return { requestId: requestLog.requestId, sent: false };
    }
    running.add(lockKey);
    try {
      const signals = buildSignals(input.guild, input.channel.id, guildConfig, config);
      const gate = hardGate({
        guildId: input.candidate.guildId,
        channelId: input.candidate.channelId,
        config,
        signals,
        forced: input.candidate.forced,
      });
      recordRuntimeAction(
        requestLog,
        `${input.candidate.id}:gate`,
        "ambient_initiative_hard_gate",
        {},
        gate === null
          ? { status: "passed", signals }
          : { status: "dropped", reason: gate, signals },
      );
      if (gate !== null) return { requestId: requestLog.requestId, sent: false };
      const pressure = input.candidate.forced
        ? {
            rawValue: 1,
            value: 1,
            roll: 0,
            passed: true,
            adjustments: [],
            inputs: { forced: true },
          }
        : calculateAmbientInitiativePressure(config, signals);
      recordRuntimeAction(
        requestLog,
        `${input.candidate.id}:pressure`,
        "ambient_initiative_pressure",
        {},
        { status: pressure.passed ? "passed" : "dropped", ...pressure },
      );
      if (!pressure.passed) return { requestId: requestLog.requestId, sent: false };
      const history = getHistoryMessages(deps.db, input.channel.id, config.historyLimit);
      const decision = input.candidate.forceDecision
        ? { shouldWake: true, wakeProbability: 1, confidence: 1, reason: "forced Prompt Lab wake" }
        : await evaluate({ guildConfig, config, signals, pressure, history, requestLog });
      const selected = decision !== null
        && decision.shouldWake
        && decision.wakeProbability >= config.probabilityThreshold
        && decision.confidence >= config.confidenceThreshold;
      recordRuntimeAction(
        requestLog,
        `${input.candidate.id}:decision`,
        "ambient_initiative_wake_decision",
        {},
        {
          status: selected ? "selected" : "dropped",
          decision,
          probabilityThreshold: config.probabilityThreshold,
          confidenceThreshold: config.confidenceThreshold,
        },
      );
      if (decision === null || !selected) return { requestId: requestLog.requestId, sent: false };
      let generation = await generate({
        guild: input.guild,
        channel: input.channel,
        guildConfig,
        config,
        candidate: input.candidate,
        requestLog,
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
      });
      if (generation.preSendRejected && input.draft === undefined) {
        const activity = activityAfter(
          input.candidate.guildId,
          input.candidate.channelId,
          input.candidate.createdAt,
        );
        if (includesOrdinaryTrigger(activity, guildConfig)) {
          recordRuntimeAction(
            requestLog,
            `${input.candidate.id}:reconsider`,
            "ambient_initiative_reconsideration",
            {},
            { status: "abandoned", reason: "ordinary trigger arrived" },
          );
          return { requestId: requestLog.requestId, sent: false };
        }
        generation = await generate({
          guild: input.guild,
          channel: input.channel,
          guildConfig,
          config,
          candidate: input.candidate,
          requestLog,
          reconsideration: {
            rejectedDraft: generation.rejectedDraft ?? "",
            activity,
          },
        });
      }
      const sent = generation.visible && input.candidate.mode === "automatic";
      records.push({
        guildId: input.candidate.guildId,
        channelId: input.candidate.channelId,
        sent,
        createdAt: Date.now(),
      });
      if (records.length > 300) records.splice(0, records.length - 300);
      return {
        requestId: requestLog.requestId,
        ...(generation.responseText !== undefined ? { responseText: generation.responseText } : {}),
        sent,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      requestLog.setError(message);
      return { requestId: requestLog.requestId, sent: false, error: message };
    } finally {
      running.delete(lockKey);
      requestLog.emit(deps.log);
      deps.requestLogStore.decrementActive();
    }
  }

  async function runOpportunity(
    guildId: string,
    mode: RunMode = "automatic",
    runToken?: string,
  ): Promise<{ requestId?: string; error?: string }> {
    const guild = await deps.resolveClientGuild(guildId);
    if (guild === null) return { error: "Guild is unavailable." };
    const config = deps.getGuildConfig(guildId).ambientInitiative;
    if (config === undefined || (!config.enabled && mode !== "draft")) {
      return { error: "Ambient initiative is disabled." };
    }
    const channel = resolveMainChannel(guild, config);
    if (channel === null) return { error: "No ambient initiative main channel is available." };
    const runMode = mode === "automatic" && config.shadowMode ? "shadow" : mode;
    const draft = runMode === "shadow"
      ? { drafts: [] as PromptLabDraftMessage[], dryRuns: [] as PromptLabDryRun[] }
      : undefined;
    const candidate: Candidate = {
      id: `ambient-initiative:${crypto.randomUUID()}`,
      guildId,
      channelId: channel.id,
      createdAt: Date.now(),
      mode: runMode,
      forced: runMode === "draft",
      forceDecision: false,
      ...(runToken !== undefined ? { runToken } : {}),
    };
    const result = await runCandidate({
      guild,
      channel,
      candidate,
      ...(draft !== undefined ? { draft } : {}),
    });
    return {
      requestId: result.requestId,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  function scheduleGuild(guildId: string): void {
    if (!loopsEnabled) return;
    const config = deps.getGuildConfig(guildId).ambientInitiative;
    if (config === undefined || !config.enabled) return;
    const existing = timers.get(guildId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(guildId);
      void runOpportunity(guildId)
        .catch((error: unknown) => {
          deps.log.error("ambient initiative failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => scheduleGuild(guildId));
    }, randomBetween(config.checkIntervalMinMs, config.checkIntervalMaxMs));
    timer.unref();
    timers.set(guildId, timer);
  }

  function startLoops(): void {
    loopsEnabled = true;
    for (const guild of deps.client.guilds.cache.values()) scheduleGuild(guild.id);
  }

  async function runPromptLab(input: {
    guildId: string;
    channelId: string;
    force?: boolean;
    runToken?: string;
  }): Promise<PromptLabRunResult> {
    const guild = await deps.resolveClientGuild(input.guildId);
    if (guild === null) throw new Error("Guild is unavailable.");
    const channel = await deps.fetchAccessibleGuildChannel(input.channelId);
    if (channel === null || channel.guildId !== input.guildId) {
      throw new Error("Channel is unavailable or belongs to another guild.");
    }
    const drafts: PromptLabDraftMessage[] = [];
    const dryRuns: PromptLabDryRun[] = [];
    const candidate: Candidate = {
      id: `prompt-lab:ambient-initiative:${crypto.randomUUID()}`,
      guildId: input.guildId,
      channelId: input.channelId,
      createdAt: Date.now(),
      mode: "draft",
      forced: true,
      forceDecision: input.force === true,
      ...(input.runToken !== undefined ? { runToken: input.runToken } : {}),
    };
    const result = await runCandidate({
      guild,
      channel,
      candidate,
      draft: { drafts, dryRuns },
    });
    const entry = deps.requestLogStore.getByRequestId(result.requestId);
    const summary = entry === null
      ? { toolCount: 0, llmCallCount: 0, estimatedCostUsd: null, totalDurationMs: 0 }
      : deps.promptLabSummary(entry);
    return {
      requestId: result.requestId,
      triggered: true,
      ...(result.responseText !== undefined ? { responseText: result.responseText } : {}),
      drafts,
      dryRuns,
      ...summary,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  function clear(): void {
    loopsEnabled = false;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    running.clear();
  }

  return {
    runOpportunity,
    scheduleGuild,
    startLoops,
    runPromptLab,
    clear,
  };
}
