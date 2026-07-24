import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Client, Guild, Message, Typing } from "discord.js";
import type { Database } from "../db/database";
import { RequestLog, type Logger } from "../logger";
import type { RequestLogStore } from "../dashboard/store";
import type { AmbientAttentionConfig, AmbientAttentionKind, AmbientAttentionModeConfig, GuildConfig } from "../config/types";
import type { HistoryMessage } from "../agent/history-types";
import {
  contentMentionsEveryone,
  shouldRespond,
  type TriggerResult,
} from "../agent/triggers";
import type { AssembledContext } from "../agent/context-assembly";
import type { HandlerDeps, MemoryExtractionRequest, MessageSender } from "../agent/handler";
import { formatHistoryContent } from "../agent/history-formatting";
import type { AgentJobStore } from "../agent/job-runtime";
import type { PromptBundle } from "../config/instruction-bundle";
import type { GlobalConfig } from "../config/types";
import type { GeneratedImageAttachment } from "../agent/codex-image-tool";
import type { ResolveTargetChannel, SendableGuildChannel } from "../discord/message-sender";
import type { ReplyFallbackDeps } from "../agent/reply-target-fallback";
import type { PromptLabDryRun, PromptLabRunResult } from "../dashboard/prompt-lab-types";
import { buildComputedContactContextForUser } from "../agent/contact-context";
import { translateInbound } from "../discord/translation";
import {
  buildModelProfileStreamOptions,
  resolveModelProfile,
} from "../llm/client";
import { completeLlmChat } from "../llm/chat";
import type { OpenRouterMessage } from "../llm/types";
import { getChannelHumanActivityBuckets, getHistoryMessages, getMessageById } from "../db/message-repository";
import { channelDisplayName } from "../discord/message-sender";
import type { createGeneratedImageRuntime } from "../agent/generated-image-runtime";
import { formatLocalWallClock } from "../time/agent-time";
import { createGenericAmbientInitiativeRuntime } from "./initiative-runtime";

export function renderAmbientHistory(input: {
  history: HistoryMessage[];
  timezone: string;
  triggerMessageIds?: readonly string[];
  followUpAnchorMessageId?: string;
}): string {
  const triggerIds = new Set(input.triggerMessageIds ?? []);
  return input.history.map((message) => {
    const who = message.author;
    const marker = message.id === input.followUpAnchorMessageId
      ? " <follow_up_anchor>"
      : triggerIds.has(message.id)
        ? " <trigger>"
        : "";
    const reply = message.replyToId !== null ? ` reply_to=${message.replyToId}` : "";
    return `[${formatLocalWallClock(message.timestamp, input.timezone)}] ${who} (${message.authorId})${reply}${marker}: ${formatHistoryContent(message)}`;
  }).join("\n");
}

const CHANNEL_ACTIVITY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_ACTIVITY_BUCKET_MS = 60_000;
const BUSY_ACTIVITY_RATIO = 0.8;
const AMBIENT_TYPING_IDLE_GRACE_MS = 500;

function percentileBucketCount(counts: readonly number[], percentile: number): number {
  if (counts.length === 0) return 0;
  const sorted = [...counts].sort((a, b) => a - b);
  const index = Math.floor((sorted.length - 1) * percentile);
  return sorted[index] ?? 0;
}

function channelHumanBucketCounts(input: {
  db: Database;
  guildId: string;
  channelId: string;
  after: number;
  before: number;
  bucketMs: number;
}): number[] {
  const bucketCount = Math.max(1, Math.ceil((input.before - input.after) / input.bucketMs));
  const counts = Array<number>(bucketCount).fill(0);
  for (const bucket of getChannelHumanActivityBuckets(
    input.db,
    input.guildId,
    input.channelId,
    input.after,
    input.before,
    input.bucketMs,
  )) {
    if (bucket.bucketIndex >= 0 && bucket.bucketIndex < counts.length) counts[bucket.bucketIndex] = bucket.messageCount;
  }
  return counts;
}

function isChannelBusy(input: {
  db: Database;
  guildId: string;
  channelId: string;
  config: AmbientAttentionConfig;
  now: number;
}): boolean {
  if (input.config.busyWindowMs <= 0) return false;
  const bucketMs = Math.max(input.config.busyWindowMs, MIN_ACTIVITY_BUCKET_MS);
  const currentAfter = input.now - bucketMs;
  const currentHumanMessages = channelHumanBucketCounts({ ...input, after: currentAfter, before: input.now, bucketMs })
    .reduce((total, count) => total + count, 0);
  if (currentHumanMessages <= input.config.busyMessageLimit) return false;

  const historicalCounts = channelHumanBucketCounts({
    ...input,
    after: input.now - CHANNEL_ACTIVITY_LOOKBACK_MS,
    before: currentAfter,
    bucketMs,
  });
  const baseline = Math.max(input.config.busyMessageLimit, percentileBucketCount(historicalCounts, 0.95));
  return currentHumanMessages / baseline >= BUSY_ACTIVITY_RATIO;
}

/** Classify recent local channel shape for ambient attention prompts. */
export function resolveLocalChannelShape(input: {
  db: Database;
  guildId: string;
  channelId: string;
  botUserId: string;
  config: AmbientAttentionConfig;
  history: readonly HistoryMessage[];
  userId: string;
  now: number;
}): string {
  const recent = input.history.slice(-30).filter((message) => !message.isSynthetic);
  const humanMessages = recent.filter((message) => !message.isBot);
  const uniqueHumans = new Set(humanMessages.map((message) => message.authorId));
  const userMessages = humanMessages.filter((message) => message.authorId === input.userId).length;
  const botMessages = recent.filter((message) =>
    message.isBot && message.authorId === input.botUserId && message.isPromptOnly !== true
  ).length;
  if (humanMessages.length === 0) return "no_recent_human_chatter";
  if (uniqueHumans.size <= 1 && userMessages > 0 && botMessages > 0) return "mostly_user_and_bot";
  if (uniqueHumans.size <= 1) return "mostly_one_user";
  if (uniqueHumans.size <= 4 && humanMessages.length <= 12) return "small_mixed_chat";
  return isChannelBusy(input) ? "busy_group_chat" : "group_chat_not_busy";
}

export type AmbientRuntime = {
  runAmbientInitiativeOpportunity: (guildId: string, mode?: "automatic" | "draft" | "shadow", runToken?: string) => Promise<{ requestId?: string; error?: string }>;
  scheduleAmbientInitiativeGuild: (guildId: string) => void;
  startAmbientInitiativeLoops: () => void;
  runPromptLabAmbientInitiative: (input: { guildId: string; channelId: string; force?: boolean; runToken?: string }) => Promise<PromptLabRunResult>;
  maybeScheduleAmbientAttention: (message: Message, triggerResult: TriggerResult) => void;
  noteAmbientTyping: (typing: Typing) => void;
  markAmbientPickupChannelCooldown: (config: AmbientAttentionConfig | undefined, guildId: string, channelId: string, now?: number) => void;
  clearPendingAmbientKindInChannel: (kind: "ambient_pickup" | "lingering_attention", guildId: string, channelId: string) => void;
  clearAmbientNormalTriggerInFlight: (guildId: string, channelId: string, userId: string) => void;
  clearAmbientTyping: (guildId: string, channelId: string, userId: string) => void;
  clearAmbientLeaseForUser: (guildId: string, channelId: string, userId: string) => void;
  noteAmbientBotReply: (input: { guildId: string; channelId: string; userId: string; sourceMessageId: string; botMessageId: string; message?: Message; allowLease: boolean; allowFollowUp: boolean }) => void;
  clearAmbientAttentionState: () => void;
  clearAmbientInitiativeState: () => void;
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
  tts?: { ttsEnabled: boolean; generateSpeech?: NonNullable<HandlerDeps["generateSpeech"]> };
  generatedImages?: ReturnType<typeof createGeneratedImageRuntime>;
  resolveAssetAttachments?: HandlerDeps["resolveAssetAttachments"];
  modeLifecycle?: boolean;
  overrides?: Partial<HandlerDeps>;
};

export type AmbientRuntimeDeps = {
  db: Database;
  client: Client;
  log: Logger;
  requestLogStore: RequestLogStore;
  agentJobs: AgentJobStore;
  getPromptBundle: () => PromptBundle;
  getGlobalConfig: () => GlobalConfig;
  typingIntervalMs: number;
  getGuildConfig: (guildId: string) => GuildConfig;
  dashboardTriggerLocation: (guild: Guild, channel: unknown) => { guildName: string; channelName?: string };
  buildInboundResolvers: (guild: Guild) => Parameters<typeof translateInbound>[1];
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
    relationshipsMode?: "live" | "virtual",
    excludeMessageIds?: readonly string[],
    historyOptions?: {
      appendLatestToHistory?: boolean;
      triggerMessageIds?: readonly string[];
      additionalVisibleUserIds?: readonly string[];
    },
  ) => Promise<AssembledContext>;
  buildAgentTools: (guildId: string, channelId: string, guildConfig: GuildConfig, guild: Guild, contextMessageIds: string[], onGeneratedImage?: (attachment: GeneratedImageAttachment) => void, currentRequest?: { requesterId: string; requesterUsername: string; sourceMessageId: string; sourceQuote: string }, options?: Record<string, unknown>) => AgentTool[];
  promptLabDryRunTools: (tools: AgentTool[], dryRuns: PromptLabDryRun[]) => AgentTool[];
  promptLabSyntheticId: (offset?: number) => string;
  promptLabSummary: (entry: ReturnType<RequestLog["toEntry"]>) => Omit<PromptLabRunResult, "requestId" | "triggered" | "drafts" | "dryRuns" | "responseText" | "relationshipsContext" | "relationshipsExtraction" | "memoryExtraction" | "error">;
  resolveClientGuild: (guildId: string) => Promise<Guild | null>;
  fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
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
  processTriggeredMessage: (message: Message, triggerResult?: NonNullable<TriggerResult>, currentTurnMessages?: readonly Message[], options?: { disableLiveOutput?: boolean; currentTurnOverride?: { messageId: string; timestamp: number; content: string }; preSendCheck?: () => boolean; onWriteToolStart?: (toolName: string) => void }) => Promise<unknown>;
  trackBackgroundTask?: (task: Promise<unknown>) => void;
  isAutonomousAttentionBusy?: (guildId: string, channelId: string) => boolean;
  waitForSemanticMaintenance?: () => Promise<void>;
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

/** Decide whether typing should postpone an ambient candidate instead of consuming it. */
export function shouldDeferAmbientCandidateForTyping(
  kind: AmbientAttentionKind,
  phase: "evaluate" | "pre_send",
  reason: string,
): boolean {
  return reason === "user typing active"
    && (kind === "lingering_attention" || (kind === "ambient_pickup" && phase === "evaluate"));
}

/** Scope pickup work to a channel while retaining user ownership for conversational follow-ons. */
export function ambientPendingKey(
  kind: AmbientAttentionKind,
  guildId: string,
  channelId: string,
  userId: string,
): string {
  return kind === "ambient_pickup"
    ? `${kind}:${guildId}:${channelId}`
    : `${kind}:${guildId}:${channelId}:${userId}`;
}

export function createAmbientRuntime(input: AmbientRuntimeDeps): AmbientRuntime {
  const { db, client, log, requestLogStore, agentJobs } = input;
  const getPromptBundle = input.getPromptBundle;
  const getGlobalConfig = input.getGlobalConfig;
  const preparePersonaModeTurn = input.preparePersonaModeTurn;
  const TYPING_INTERVAL_MS = input.typingIntervalMs;

  function startTrackedAmbientTask(task: Promise<unknown>, label: string): void {
    const handled = task.catch((error: unknown) => {
      log.error(`${label} failed`, { error: error instanceof Error ? error.message : String(error) });
    });
    input.trackBackgroundTask?.(handled);
    void handled;
  }
  const getGuildConfig = input.getGuildConfig;
  const dashboardTriggerLocation = input.dashboardTriggerLocation;
  const buildInboundResolvers = input.buildInboundResolvers;
  const createSyntheticReplyFallbackDeps = input.createSyntheticReplyFallbackDeps;
  const buildContext = input.buildContext;
  const buildAgentTools = input.buildAgentTools;
  const promptLabDryRunTools = input.promptLabDryRunTools;
  const promptLabSyntheticId = input.promptLabSyntheticId;
  const promptLabSummary = input.promptLabSummary;
  const resolveClientGuild = input.resolveClientGuild;
  const fetchAccessibleGuildChannel = input.fetchAccessibleGuildChannel;
  const createBotDiscordMessageSender = input.createBotDiscordMessageSender;
  const createHandlerDeps = input.createHandlerDeps;
  const processTriggeredMessage = input.processTriggeredMessage;
  const isAutonomousAttentionBusy = input.isAutonomousAttentionBusy ?? (() => false);
  type AmbientCandidate = {
    id: string;
    kind: AmbientAttentionKind;
    message: Message;
    createdAt: number;
    triggerCreatedAt: number;
    triggerMessageId: string;
    triggerMessageIds: string[];
    triggerMessages: Message[];
    userId: string;
    channelId: string;
    guildId: string;
    burstStartedAt?: number;
    burstMessageCount?: number;
  };

  type AmbientLease = {
    guildId: string;
    channelId: string;
    userId: string;
    exchangeId: string;
    sourceMessageId: string;
    botMessageId: string;
    botRepliedAt: number;
    strongUntil: number;
    expiresAt: number;
    typingExtensions: number;
    followUpsSent: number;
  };

  type AmbientDecision = {
    should_reply: boolean;
    reply_probability: number;
    confidence: number;
    intent?: string;
    reason: string;
  };

  type AmbientDecisionVerdict = {
    passed: boolean;
    probabilityThreshold: number;
    confidenceThreshold: number;
    adjustedProbability: number;
    jitter: number;
    weakLingering: boolean;
    decidingParameter: "should_reply" | "reply_probability" | "confidence" | "passed";
    explanation: string;
  };

  type AmbientPendingCandidate = {
    candidate: AmbientCandidate;
    timer: ReturnType<typeof setTimeout>;
  };

  const ambientCandidateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let ambientAttentionGeneration = 0;
  const ambientLeases = new Map<string, AmbientLease>();
  const ambientPendingCandidates = new Map<string, AmbientPendingCandidate>();
  const ambientTypingByChannelUser = new Map<string, number>();
  const ambientReplyTimesByUser = new Map<string, number[]>();
  const ambientReplyTimesByChannel = new Map<string, number[]>();
  const ambientCooldowns = new Map<string, number>();
  const ambientPickupChannelCooldowns = new Map<string, number>();
  const ambientNormalTriggerUsers = new Set<string>();

  function ambientLeaseKey(guildId: string, channelId: string, userId: string): string {
    return `${guildId}:${channelId}:${userId}`;
  }

  function ambientChannelUserKey(guildId: string, channelId: string, userId: string): string {
    return `${guildId}:${channelId}:${userId}`;
  }

  function ambientNormalTriggerUserKey(guildId: string, channelId: string, userId: string): string {
    return `${guildId}:${channelId}:${userId}`;
  }

  function ambientCooldownKey(kind: AmbientAttentionKind, guildId: string, channelId: string, userId: string): string {
    return `${kind}:${guildId}:${channelId}:${userId}`;
  }

  function ambientPickupChannelCooldownKey(guildId: string, channelId: string): string {
    return `${guildId}:${channelId}`;
  }

  function ambientModeConfig(config: AmbientAttentionConfig, kind: AmbientAttentionKind): AmbientAttentionModeConfig {
    if (kind === "ambient_pickup") return config.ambientPickup;
    if (kind === "lingering_attention") return config.lingering;
    return config.followUp;
  }

  function randomBetween(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function pruneRecentTimes(times: number[], now: number): number[] {
    return times.filter((time) => now - time < 60 * 60 * 1000);
  }

  function ambientBudgetAvailable(
    config: AmbientAttentionConfig,
    candidate: AmbientCandidate,
    now = Date.now(),
  ): boolean {
    const mode = ambientModeConfig(config, candidate.kind);
    const userKey = `${candidate.guildId}:${candidate.userId}`;
    const channelKey = `${candidate.guildId}:${candidate.channelId}`;
    const userTimes = pruneRecentTimes(ambientReplyTimesByUser.get(userKey) ?? [], now);
    const channelTimes = pruneRecentTimes(ambientReplyTimesByChannel.get(channelKey) ?? [], now);
    ambientReplyTimesByUser.set(userKey, userTimes);
    ambientReplyTimesByChannel.set(channelKey, channelTimes);
    return userTimes.length < mode.maxRepliesPerUserPerHour && channelTimes.length < mode.maxRepliesPerChannelPerHour;
  }

  function recordAmbientReply(candidate: AmbientCandidate, now = Date.now()): void {
    const userKey = `${candidate.guildId}:${candidate.userId}`;
    const channelKey = `${candidate.guildId}:${candidate.channelId}`;
    ambientReplyTimesByUser.set(userKey, [...pruneRecentTimes(ambientReplyTimesByUser.get(userKey) ?? [], now), now]);
    ambientReplyTimesByChannel.set(channelKey, [...pruneRecentTimes(ambientReplyTimesByChannel.get(channelKey) ?? [], now), now]);
  }

  function markAmbientCooldown(config: AmbientAttentionConfig, candidate: AmbientCandidate, now = Date.now()): void {
    const mode = ambientModeConfig(config, candidate.kind);
    if (mode.cooldownMs <= 0) return;
    ambientCooldowns.set(ambientCooldownKey(candidate.kind, candidate.guildId, candidate.channelId, candidate.userId), now + mode.cooldownMs);
  }

  function ambientCooldownReady(candidate: AmbientCandidate, now = Date.now()): boolean {
    return (ambientCooldowns.get(ambientCooldownKey(candidate.kind, candidate.guildId, candidate.channelId, candidate.userId)) ?? 0) <= now;
  }

  function markAmbientPickupChannelCooldown(config: AmbientAttentionConfig | undefined, guildId: string, channelId: string, now = Date.now()): void {
    if (config === undefined || !config.enabled || !config.ambientPickup.enabled || config.ambientPickup.cooldownMs <= 0) return;
    ambientPickupChannelCooldowns.set(ambientPickupChannelCooldownKey(guildId, channelId), now + config.ambientPickup.cooldownMs);
  }

  function ambientPickupChannelCooldownReady(candidate: AmbientCandidate, now = Date.now()): boolean {
    if (candidate.kind !== "ambient_pickup") return true;
    return (ambientPickupChannelCooldowns.get(ambientPickupChannelCooldownKey(candidate.guildId, candidate.channelId)) ?? 0) <= now;
  }

  function ambientPickupChannelReady(guildId: string, channelId: string, now = Date.now()): boolean {
    return (ambientPickupChannelCooldowns.get(ambientPickupChannelCooldownKey(guildId, channelId)) ?? 0) <= now;
  }

  function activeTypingInChannel(guildId: string, channelId: string, activeMs: number, now = Date.now()): boolean {
    if (activeMs <= 0) return false;
    const effectiveActiveMs = Math.max(activeMs, TYPING_INTERVAL_MS);
    const prefix = `${guildId}:${channelId}:`;
    for (const [key, lastTypingAt] of ambientTypingByChannelUser) {
      if (!key.startsWith(prefix)) continue;
      if (now - lastTypingAt <= effectiveActiveMs) return true;
    }
    return false;
  }

  function ambientTypingActiveMs(config: AmbientAttentionConfig, kind: AmbientAttentionKind): number {
    return ambientModeConfig(config, kind).typingActiveMs;
  }

  function rawStoredMessageContent(messageId: string, guildId: string): string | null {
    const row = db.raw
      .prepare("SELECT raw_content FROM messages WHERE id = ? AND guild_id = ? AND is_prompt_only = 0")
      .get(messageId, guildId) as { raw_content: string } | null;
    return row?.raw_content ?? null;
  }

  function contentMentionsBot(content: string, botUserId: string): boolean {
    if (botUserId === "") return false;
    return new RegExp(`<@!?${botUserId}>`).test(content);
  }

  function mentionedRoleIds(content: string): string[] {
    return [...content.matchAll(/<@&(\d+)>/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]]
    );
  }

  function storedMessageRepliesToOwnBot(message: HistoryMessage, guildId: string): boolean {
    if (message.replyToId === null) return false;
    const botUserId = client.user?.id ?? "";
    if (botUserId === "") return false;
    const row = db.raw
      .prepare("SELECT user_id, is_bot FROM messages WHERE id = ? AND guild_id = ? AND is_prompt_only = 0")
      .get(message.replyToId, guildId) as { user_id: string; is_bot: number } | null;
    return row !== null && row.user_id === botUserId && row.is_bot === 1;
  }

  function deterministicHistoryTrigger(message: HistoryMessage, guildConfig: GuildConfig): TriggerResult {
    const botUserId = client.user?.id ?? "";
    const rawContent = rawStoredMessageContent(message.id, guildConfig.guildId) ?? message.content;
    const botMember = client.guilds.cache.get(guildConfig.guildId)?.members.me;
    return shouldRespond(
      {
        content: message.content,
        authorId: message.authorId,
        authorIsBot: message.isBot,
        botUserId,
        mentionedUserIds: contentMentionsBot(rawContent, botUserId) ? [botUserId] : [],
        mentionedRoleIds: mentionedRoleIds(rawContent),
        botRoleIds: botMember === null || botMember === undefined
          ? []
          : [...botMember.roles.cache.keys()],
        // Stored messages do not keep Discord's mention_everyone flag. A literal
        // token is sufficient here because this path only suppresses stale ambient work.
        mentionedEveryone: contentMentionsEveryone(rawContent),
        repliedToBot: storedMessageRepliesToOwnBot(message, guildConfig.guildId),
      },
      { ...guildConfig.triggers, randomChance: 0 },
    );
  }

  function memoryCountBucket(memoryCount: number): string {
    if (memoryCount <= 0) return "none";
    if (memoryCount <= 2) return "few";
    if (memoryCount <= 8) return "some";
    return "many";
  }

  function familiarityBucket(input: {
    familiarityScore: number;
    directContactEvents: number;
    activeContactDays: number;
  }): string {
    if (input.directContactEvents <= 0) return "no_prior_direct_contact";
    if (input.familiarityScore >= 70) return "very_familiar";
    if (input.familiarityScore >= 45) return "familiar";
    if (input.directContactEvents >= 3 || input.activeContactDays >= 2) return "occasional";
    return "new_or_light_contact";
  }

  function recencyBucket(timestamp: number | null, now: number): string {
    if (timestamp === null) return "none";
    const ageMs = Math.max(0, now - timestamp);
    if (ageMs <= 24 * 60 * 60 * 1000) return "today";
    if (ageMs <= 7 * 24 * 60 * 60 * 1000) return "this_week";
    if (ageMs <= 30 * 24 * 60 * 60 * 1000) return "this_month";
    return "old";
  }

  function isPromptOnlyIgnore(message: HistoryMessage): boolean {
    return message.isBot && message.isPromptOnly === true && message.content.trim().toLowerCase().startsWith("<ignore");
  }

  function recentBotInvolvement(history: readonly HistoryMessage[], userId: string, now: number): string {
    const recent = history.filter((message) => now - message.timestamp <= 10 * 60 * 1000);
    const botUserId = client.user?.id ?? "";
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const message = recent[i];
      if (message === undefined || !message.isBot || message.authorId !== botUserId) continue;
      if (isPromptOnlyIgnore(message)) {
        if (message.replyToId !== null) {
          const target = history.find((item) => item.id === message.replyToId);
          if (target !== undefined && target.authorId === userId) return "bot_recently_chose_silence_for_same_user";
          if (target !== undefined && !target.isBot) return "bot_recently_chose_silence_for_other_user";
        }
        return "bot_recently_chose_silence";
      }
      if (message.isPromptOnly === true) continue;
      if (message.replyToId !== null) {
        const target = history.find((item) => item.id === message.replyToId);
        if (target !== undefined && target.authorId === userId) return "bot_replied_to_same_user_recently";
        if (target !== undefined && !target.isBot) return "bot_replied_to_other_user_recently";
      }
      const previousHuman = history
        .filter((item) => !item.isBot && item.timestamp <= message.timestamp)
        .at(-1);
      if (previousHuman?.authorId === userId) return "bot_spoke_after_same_user_recently";
      if (previousHuman !== undefined) return "bot_spoke_after_other_user_recently";
      return "bot_spoke_recently";
    }
    return "none_recent";
  }

  function renderAmbientRelationshipSignals(candidate: AmbientCandidate, history: HistoryMessage[], config: AmbientAttentionConfig): string {
    const now = Date.now();
    const contact = buildComputedContactContextForUser({
      db,
      botUserId: client.user?.id ?? "",
      botAddressAliasesForGuild: (contactGuildId) => [
        client.user?.username ?? "",
        ...getGuildConfig(contactGuildId).triggers.keywords,
      ],
      userId: candidate.userId,
      currentChannelId: candidate.channelId,
      beforeCreatedAt: candidate.triggerCreatedAt,
      beforeMessageId: candidate.triggerMessageId,
      now,
    });
    const familiarity = contact === null
      ? "no_prior_direct_contact"
      : familiarityBucket(contact);
    const memoryBucket = memoryCountBucket(contact?.memoryCount ?? 0);
    return [
      `familiarity: ${familiarity}`,
      `direct_contact_events: ${contact?.directContactEvents ?? 0}`,
      `active_contact_days: ${contact?.activeContactDays ?? 0}`,
      `direct_contact_recency: ${recencyBucket(contact?.lastContactAt ?? null, now)}`,
      `last_user_to_bot: ${recencyBucket(contact?.lastUserToBotAt ?? null, now)}`,
      `last_bot_to_user: ${recencyBucket(contact?.lastBotToUserAt ?? null, now)}`,
      `memory_count_bucket: ${memoryBucket}`,
      `local_channel_shape: ${resolveLocalChannelShape({
        db,
        guildId: candidate.guildId,
        channelId: candidate.channelId,
        botUserId: client.user?.id ?? "",
        config,
        history,
        userId: candidate.userId,
        now,
      })}`,
      `recent_bot_involvement: ${recentBotInvolvement(history, candidate.userId, now)}`,
    ].join("\n");
  }

  function ambientCandidateTriggerContext(candidate: AmbientCandidate): {
    guildName?: string;
    channelName?: string;
    authorUsername?: string;
    messageId: string;
    content: string;
    translatedContent: string;
  } {
    const guild = candidate.message.guild;
    const translatedContent = guild !== null
      ? translateInbound(candidate.message.content, buildInboundResolvers(guild))
      : candidate.message.content;
    return {
      ...(guild !== null ? { guildName: guild.name } : {}),
      channelName: channelDisplayName(candidate.message.channel),
      authorUsername: candidate.message.author.username,
      messageId: candidate.triggerMessageId,
      content: candidate.message.content,
      translatedContent,
    };
  }

  function createAmbientRequestLog(candidate: AmbientCandidate, status: string): RequestLog {
    const requestLog = new RequestLog(candidate.guildId, candidate.channelId, requestLogStore);
    requestLog.setAuthor(candidate.message.author.username);
    requestLog.setTrigger({
      type: "ambient_attention_evaluator",
      kind: candidate.kind,
      status,
      triggerMessageId: candidate.triggerMessageId,
      userId: candidate.userId,
    });
    requestLog.setTriggerContext(ambientCandidateTriggerContext(candidate));
    requestLog.setAgentRan(true);
    return requestLog;
  }

  function emitAmbientRequestLog(requestLog: RequestLog): void {
    requestLog.emit(log);
    requestLogStore.decrementActive();
  }

  function recordAmbientRuntimeAction(
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

  function logAmbientScheduled(candidate: AmbientCandidate, delayMs: number): void {
    const requestLog = createAmbientRequestLog(candidate, "scheduled");
    requestLogStore.incrementActive();
    recordAmbientRuntimeAction(
      requestLog,
      `ambient-scheduled:${candidate.id}`,
      "ambient_attention_scheduled",
      {
        kind: candidate.kind,
        delayMs,
        triggerMessageId: candidate.triggerMessageId,
        ...(candidate.burstMessageCount !== undefined ? { burstMessageCount: candidate.burstMessageCount } : {}),
        ...(candidate.burstStartedAt !== undefined ? { burstDurationMs: Date.now() - candidate.burstStartedAt } : {}),
      },
      {
        status: "scheduled",
        summary: candidate.burstMessageCount !== undefined && candidate.burstMessageCount > 1
          ? `${candidate.kind} burst of ${candidate.burstMessageCount} messages queued for evaluation in ${delayMs}ms.`
          : `${candidate.kind} queued for evaluation in ${delayMs}ms.`,
      },
    );
    emitAmbientRequestLog(requestLog);
  }

  function clearPendingCandidate(key: string): void {
    const pending = ambientPendingCandidates.get(key);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    ambientCandidateTimers.delete(pending.candidate.id);
    ambientPendingCandidates.delete(key);
  }

  function clearPendingAmbientKindInChannel(kind: "ambient_pickup" | "lingering_attention", guildId: string, channelId: string): void {
    for (const [key, pending] of ambientPendingCandidates) {
      if (pending.candidate.kind === kind && pending.candidate.guildId === guildId && pending.candidate.channelId === channelId) {
        clearPendingCandidate(key);
      }
    }
  }

  function clearPendingAmbientForUser(guildId: string, channelId: string, userId: string): void {
    clearPendingCandidate(ambientPendingKey("ambient_pickup", guildId, channelId, userId));
    clearPendingCandidate(ambientPendingKey("lingering_attention", guildId, channelId, userId));
    clearPendingCandidate(ambientPendingKey("follow_up", guildId, channelId, userId));
  }

  function markAmbientNormalTriggerInFlight(guildId: string, channelId: string, userId: string): void {
    ambientNormalTriggerUsers.add(ambientNormalTriggerUserKey(guildId, channelId, userId));
  }

  function clearAmbientNormalTriggerInFlight(guildId: string, channelId: string, userId: string): void {
    ambientNormalTriggerUsers.delete(ambientNormalTriggerUserKey(guildId, channelId, userId));
  }

  function ambientNormalTriggerInFlight(guildId: string, channelId: string, userId: string): boolean {
    return ambientNormalTriggerUsers.has(ambientNormalTriggerUserKey(guildId, channelId, userId));
  }

  function clearPendingForCandidate(candidate: AmbientCandidate): void {
    const key = ambientPendingKey(candidate.kind, candidate.guildId, candidate.channelId, candidate.userId);
    const pending = ambientPendingCandidates.get(key);
    if (pending?.candidate.id === candidate.id) clearPendingCandidate(key);
  }

  function armPendingCandidate(key: string, candidate: AmbientCandidate, delayMs: number, logSchedule = true): void {
    clearPendingCandidate(key);
    if (logSchedule) logAmbientScheduled(candidate, delayMs);
    const generation = ambientAttentionGeneration;
    const timer = setTimeout(() => {
      if (generation !== ambientAttentionGeneration) return;
      const pending = ambientPendingCandidates.get(key);
      if (pending?.candidate.id === candidate.id) ambientPendingCandidates.delete(key);
      ambientCandidateTimers.delete(candidate.id);
      startTrackedAmbientTask(runAmbientCandidate(candidate), "ambient candidate");
    }, delayMs);
    ambientPendingCandidates.set(key, { candidate, timer });
    ambientCandidateTimers.set(candidate.id, timer);
  }

  function schedulePendingBurstFromMessage(
    message: Message,
    base: Omit<AmbientCandidate, "id" | "kind">,
    config: AmbientAttentionConfig,
    kind: "ambient_pickup" | "lingering_attention",
  ): void {
    const key = ambientPendingKey(kind, base.guildId, base.channelId, base.userId);
    const mode = ambientModeConfig(config, kind);
    const existing = ambientPendingCandidates.get(key);
    const burstStartedAt = existing?.candidate.burstStartedAt ?? message.createdTimestamp;
    const burstMessageCount = (existing?.candidate.burstMessageCount ?? 0) + 1;
    const triggerMessageIds = kind === "ambient_pickup"
      ? [message.id]
      : [...new Set([...(existing?.candidate.triggerMessageIds ?? []), message.id])];
    const triggerMessages = kind === "ambient_pickup"
      ? [message]
      : [
          ...(existing?.candidate.triggerMessages ?? []),
          message,
        ].filter((item, index, items) => items.findIndex((candidateMessage) => candidateMessage.id === item.id) === index);
    const candidate: AmbientCandidate = {
      ...base,
      id: crypto.randomUUID(),
      kind,
      triggerMessageIds,
      triggerMessages,
      burstStartedAt,
      burstMessageCount,
    };
    // Burst debounce replacements are internal queue state; the dashboard records the eventual evaluation.
    armPendingCandidate(key, candidate, randomBetween(mode.minDelayMs, mode.maxDelayMs), false);
  }

  function reschedulePendingBurstForTyping(
    kind: "ambient_pickup" | "lingering_attention",
    guildId: string,
    channelId: string,
    userId: string,
    config: AmbientAttentionConfig,
  ): void {
    const key = ambientPendingKey(kind, guildId, channelId, userId);
    const pending = ambientPendingCandidates.get(key);
    if (pending === undefined) return;
    deferAmbientCandidateForTyping(pending.candidate, config);
  }

  /** Keep an ambient candidate alive until Discord typing has gone idle. */
  function deferAmbientCandidateForTyping(
    candidate: AmbientCandidate,
    config: AmbientAttentionConfig,
  ): void {
    const key = ambientPendingKey(candidate.kind, candidate.guildId, candidate.channelId, candidate.userId);
    const activeMs = Math.max(ambientTypingActiveMs(config, candidate.kind), TYPING_INTERVAL_MS);
    const delayMs = candidate.kind === "ambient_pickup"
      ? activeMs + AMBIENT_TYPING_IDLE_GRACE_MS
      : activeMs + randomBetween(
          ambientModeConfig(config, candidate.kind).minDelayMs,
          ambientModeConfig(config, candidate.kind).maxDelayMs,
        );
    armPendingCandidate(key, candidate, delayMs, false);
  }

  function ambientHardGate(
    config: AmbientAttentionConfig,
    candidate: AmbientCandidate,
    phase: "evaluate" | "pre_send",
  ): { ok: true; history: HistoryMessage[] } | { ok: false; reason: string } {
    if (!config.enabled) return { ok: false, reason: "ambient attention disabled" };
    const mode = ambientModeConfig(config, candidate.kind);
    if (!mode.enabled) return { ok: false, reason: `${candidate.kind} disabled` };
    const now = Date.now();
    if (now - candidate.createdAt > config.staleAfterMs) return { ok: false, reason: "candidate stale" };
    if (ambientNormalTriggerInFlight(candidate.guildId, candidate.channelId, candidate.userId)) {
      return { ok: false, reason: "normal trigger in flight" };
    }
    if (!ambientBudgetAvailable(config, candidate, now)) return { ok: false, reason: "ambient budget exhausted" };
    if (phase === "evaluate" && !ambientCooldownReady(candidate, now)) return { ok: false, reason: "ambient cooldown active" };
    if (!ambientPickupChannelCooldownReady(candidate, now)) return { ok: false, reason: "ambient pickup channel cooldown active" };
    if (isAutonomousAttentionBusy(candidate.guildId, candidate.channelId)) {
      return { ok: false, reason: "scheduled task active" };
    }
    if (activeTypingInChannel(candidate.guildId, candidate.channelId, ambientTypingActiveMs(config, candidate.kind), now)) {
      return { ok: false, reason: "user typing active" };
    }

    const trigger = getMessageById(db, candidate.triggerMessageId, candidate.guildId);
    if (trigger === null || trigger.channelId !== candidate.channelId) return { ok: false, reason: "trigger message missing" };
    if (trigger.translatedContent.trim() === "") return { ok: false, reason: "empty trigger message" };

    const history = getHistoryMessages(db, candidate.channelId, config.historyLimit);
    const afterTrigger = history.filter((message) =>
      message.timestamp > candidate.triggerCreatedAt ||
      (message.timestamp === candidate.triggerCreatedAt && message.id > candidate.triggerMessageId)
    );
    const newHumanMessages = afterTrigger.filter((message) => !message.isBot);
    if (candidate.kind === "ambient_pickup") {
      const guildConfig = getGuildConfig(candidate.guildId);
      if (newHumanMessages.some((message) => deterministicHistoryTrigger(message, guildConfig) !== null)) {
        return { ok: false, reason: "newer normal trigger exists" };
      }
      if (afterTrigger.some((message) => message.isBot && message.isPromptOnly !== true)) {
        return { ok: false, reason: "bot spoke after trigger" };
      }
      if (newHumanMessages.length > 0) return { ok: false, reason: "newer human message exists" };
    }
    if (candidate.kind !== "ambient_pickup" && newHumanMessages.length > config.maxNewMessagesBeforeDrop) return { ok: false, reason: "too many newer human messages" };
    if (afterTrigger.some((message) => !message.isBot && message.replyToId === candidate.triggerMessageId && message.authorId !== candidate.userId)) {
      return { ok: false, reason: "another human replied to trigger" };
    }

    if (candidate.kind === "lingering_attention") {
      const lease = ambientLeases.get(ambientLeaseKey(candidate.guildId, candidate.channelId, candidate.userId));
      if (lease === undefined) return { ok: false, reason: "lingering lease missing" };
      if (lease.expiresAt <= now) return { ok: false, reason: "lingering lease expired" };
      if (newHumanMessages.length > 0) return { ok: false, reason: "newer human message exists" };
    }

    if (candidate.kind === "follow_up") {
      const lease = ambientLeases.get(ambientLeaseKey(candidate.guildId, candidate.channelId, candidate.userId));
      if (lease === undefined || lease.botMessageId !== candidate.triggerMessageId) return { ok: false, reason: "follow-up lease missing" };
      if (lease.followUpsSent >= config.followUp.maxPerExchange) return { ok: false, reason: "follow-up exchange budget used" };
      const newer = history.filter((message) =>
        message.timestamp > candidate.triggerCreatedAt ||
        (message.timestamp === candidate.triggerCreatedAt && message.id > candidate.triggerMessageId)
      );
      if (newer.length > 0) return { ok: false, reason: "follow-up silence broken" };
      if (now - candidate.triggerCreatedAt < config.followUp.silenceMs) return { ok: false, reason: "follow-up silence too short" };
    } else {
      if (isChannelBusy({
        db,
        guildId: candidate.guildId,
        channelId: candidate.channelId,
        config,
        now,
      })) return { ok: false, reason: "channel busy" };
      if (
        candidate.kind === "ambient_pickup" &&
        phase === "evaluate" &&
        newHumanMessages.length === 0 &&
        now - candidate.triggerCreatedAt < config.ambientPickup.minQuietMs
      ) {
        return { ok: false, reason: "quiet window too short" };
      }
    }

    return { ok: true, history };
  }

  async function evaluateAmbientCandidate(
    config: AmbientAttentionConfig,
    candidate: AmbientCandidate,
    history: HistoryMessage[],
    requestLog?: RequestLog,
  ): Promise<AmbientDecision | null> {
    const globalConfig = getGlobalConfig();
    const profile = resolveModelProfile(globalConfig, config.evaluator.modelProfile);
    const streamOptions = buildModelProfileStreamOptions(globalConfig, config.evaluator.modelProfile);
    const providerParams: Record<string, unknown> = { ...streamOptions };
    delete providerParams.apiKey;
    const provider = profile.provider;
    const system = [
      ambientEvaluatorPolicyForKind(candidate.kind),
      "Decide whether the configured persona should naturally speak in Discord ambient attention.",
      "Usually choose silence. Do not write the reply text.",
      "Return only compact JSON with should_reply, reply_probability, confidence, intent, and reason.",
      "reply_probability and confidence must be 0..1. reason should be one short sentence.",
    ].filter((part) => part.trim() !== "").join("\n\n");
    const user = [
      `kind: ${candidate.kind}`,
      `trigger_message_id: ${candidate.triggerMessageId}`,
      `trigger_user_id: ${candidate.userId}`,
      ...(candidate.burstMessageCount !== undefined
        ? [
            `burst_message_count: ${candidate.burstMessageCount}`,
            `burst_duration_ms: ${Date.now() - (candidate.burstStartedAt ?? candidate.triggerCreatedAt)}`,
          ]
        : []),
      `now: ${new Date().toISOString()}`,
      "",
      "Compact relationship signals:",
      renderAmbientRelationshipSignals(candidate, history, config),
      "",
      "Recent channel history:",
      renderAmbientHistory({
        history,
        timezone: getGuildConfig(candidate.guildId).timezone,
        ...(candidate.kind === "follow_up"
          ? { followUpAnchorMessageId: candidate.triggerMessageId }
          : { triggerMessageIds: candidate.triggerMessageIds }),
      }),
    ].join("\n");
    const messages: OpenRouterMessage[] = [{ role: "user", content: user }];
    let llmCompleted = false;
    try {
      const result = await completeLlmChat({
        provider,
        apiKey: streamOptions.apiKey,
        model: profile.model,
        systemPrompt: system,
        messages,
        providerParams,
        onPayload: (payload) => {
          requestLog?.recordLLMRequest(payload);
        },
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "ambient_attention_decision",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["should_reply", "reply_probability", "confidence", "intent", "reason"],
              properties: {
                should_reply: { type: "boolean" },
                reply_probability: { type: "number", minimum: 0, maximum: 1 },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                intent: { type: "string" },
                reason: { type: "string" },
              },
            },
          },
        },
        toolChoice: "none",
        parallelToolCalls: false,
        signal: AbortSignal.timeout(config.evaluator.llmOutputTimeoutMs),
      });
      requestLog?.recordLLMCompletion(result.messageForLogs);
      llmCompleted = true;
      const parsed = JSON.parse(result.text) as unknown;
      if (parsed === null || typeof parsed !== "object") return null;
      const record = parsed as Record<string, unknown>;
      return {
        should_reply: record.should_reply === true,
        reply_probability: typeof record.reply_probability === "number" ? Math.max(0, Math.min(1, record.reply_probability)) : 0,
        confidence: typeof record.confidence === "number" ? Math.max(0, Math.min(1, record.confidence)) : 0,
        intent: typeof record.intent === "string" ? record.intent : undefined,
        reason: typeof record.reason === "string" ? record.reason : "",
      };
    } catch (error) {
      if (!llmCompleted) requestLog?.recordLLMError(error);
      log.warn("ambient attention evaluation failed", {
        kind: candidate.kind,
        messageId: candidate.triggerMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  function ambientDecisionVerdict(
    config: AmbientAttentionConfig,
    candidate: AmbientCandidate,
    decision: AmbientDecision,
  ): AmbientDecisionVerdict {
    const mode = ambientModeConfig(config, candidate.kind);
    const lease = candidate.kind === "lingering_attention"
      ? ambientLeases.get(ambientLeaseKey(candidate.guildId, candidate.channelId, candidate.userId))
      : undefined;
    const weakLingering = lease !== undefined && Date.now() > lease.strongUntil;
    const probabilityThreshold = weakLingering
      ? Math.min(1, Math.max(mode.probabilityThreshold + 0.17, config.ambientPickup.probabilityThreshold))
      : mode.probabilityThreshold;
    const confidenceThreshold = weakLingering
      ? Math.min(1, Math.max(mode.confidenceThreshold + 0.1, config.ambientPickup.confidenceThreshold))
      : mode.confidenceThreshold;
    const jitter = mode.randomJitter > 0 ? (Math.random() * 2 - 1) * mode.randomJitter : 0;
    const adjustedProbability = Math.max(0, Math.min(1, decision.reply_probability + jitter));
    if (!decision.should_reply) {
      return {
        passed: false,
        probabilityThreshold,
        confidenceThreshold,
        adjustedProbability,
        jitter,
        weakLingering,
        decidingParameter: "should_reply",
        explanation: "Evaluator explicitly chose silence.",
      };
    }
    if (adjustedProbability < probabilityThreshold) {
      return {
        passed: false,
        probabilityThreshold,
        confidenceThreshold,
        adjustedProbability,
        jitter,
        weakLingering,
        decidingParameter: "reply_probability",
        explanation: `Adjusted reply probability ${adjustedProbability.toFixed(2)} was below threshold ${probabilityThreshold.toFixed(2)}.`,
      };
    }
    if (decision.confidence < confidenceThreshold) {
      return {
        passed: false,
        probabilityThreshold,
        confidenceThreshold,
        adjustedProbability,
        jitter,
        weakLingering,
        decidingParameter: "confidence",
        explanation: `Confidence ${decision.confidence.toFixed(2)} was below threshold ${confidenceThreshold.toFixed(2)}.`,
      };
    }
    return {
      passed: true,
      probabilityThreshold,
      confidenceThreshold,
      adjustedProbability,
      jitter,
      weakLingering,
      decidingParameter: "passed",
      explanation: "Evaluator decision cleared probability and confidence thresholds.",
    };
  }

  function ambientEvaluatorPolicyForKind(kind: AmbientAttentionKind): string {
    const policies = getPromptBundle().runtime.ambientAttentionEvaluator;
    const kindPolicy = kind === "ambient_pickup"
      ? policies.ambientPickup
      : kind === "lingering_attention"
        ? policies.lingeringAttention
        : policies.followUp;
    return [policies.shared, kindPolicy].filter((part) => part.trim() !== "").join("\n\n");
  }

  function scheduleAmbientCandidate(candidate: AmbientCandidate): void {
    const guildConfig = getGuildConfig(candidate.guildId);
    const config = guildConfig.ambientAttention;
    if (config === undefined || !config.enabled) return;
    const mode = ambientModeConfig(config, candidate.kind);
    if (!mode.enabled) return;
    const delayMs = randomBetween(mode.minDelayMs, mode.maxDelayMs);
    armPendingCandidate(ambientPendingKey(candidate.kind, candidate.guildId, candidate.channelId, candidate.userId), candidate, delayMs);
  }

  function clearAmbientAttentionState(): void {
    ambientAttentionGeneration += 1;
    for (const timer of ambientCandidateTimers.values()) clearTimeout(timer);
    ambientCandidateTimers.clear();
    ambientLeases.clear();
    ambientPendingCandidates.clear();
    ambientTypingByChannelUser.clear();
    ambientReplyTimesByUser.clear();
    ambientReplyTimesByChannel.clear();
    ambientCooldowns.clear();
    ambientPickupChannelCooldowns.clear();
    ambientNormalTriggerUsers.clear();
  }

  const genericAmbientInitiative = createGenericAmbientInitiativeRuntime({
    db,
    client,
    log,
    requestLogStore,
    agentJobs,
    getPromptBundle,
    getGlobalConfig,
    getGuildConfig,
    dashboardTriggerLocation,
    buildContext,
    buildAgentTools,
    promptLabDryRunTools,
    promptLabSyntheticId,
    promptLabSummary,
    resolveClientGuild,
    fetchAccessibleGuildChannel,
    createSyntheticReplyFallbackDeps,
    createBotDiscordMessageSender,
    createVisibleMaintenanceTools: input.createVisibleMaintenanceTools,
    createHandlerDeps,
    pendingAmbientCandidatesInChannel: (guildId, channelId) => {
      let count = 0;
      for (const pending of ambientPendingCandidates.values()) {
        if (pending.candidate.guildId === guildId && pending.candidate.channelId === channelId) count += 1;
      }
      return count;
    },
    isAutonomousAttentionBusy,
    ...(input.waitForSemanticMaintenance !== undefined
      ? { waitForSemanticMaintenance: input.waitForSemanticMaintenance }
      : {}),
    ...(preparePersonaModeTurn !== undefined ? { preparePersonaModeTurn } : {}),
    ...(input.runMaintenance !== undefined ? { runMaintenance: input.runMaintenance } : {}),
  });

  const runAmbientInitiativeOpportunity = genericAmbientInitiative.runOpportunity;
  const scheduleAmbientInitiativeGuild = genericAmbientInitiative.scheduleGuild;
  const startAmbientInitiativeLoops = genericAmbientInitiative.startLoops;
  const runPromptLabAmbientInitiative = genericAmbientInitiative.runPromptLab;
  const clearAmbientInitiativeState = genericAmbientInitiative.clear;

  async function runAmbientCandidate(candidate: AmbientCandidate): Promise<void> {
    const guildConfig = getGuildConfig(candidate.guildId);
    const config = guildConfig.ambientAttention;
    if (config === undefined) return;
    if (
      shouldDeferAmbientCandidateForTyping(candidate.kind, "evaluate", "user typing active")
      && activeTypingInChannel(
        candidate.guildId,
        candidate.channelId,
        ambientTypingActiveMs(config, candidate.kind),
        Date.now(),
      )
    ) {
      deferAmbientCandidateForTyping(candidate, config);
      return;
    }
    const requestLog = createAmbientRequestLog(candidate, "evaluating");
    requestLogStore.incrementActive();
    const gate = ambientHardGate(config, candidate, "evaluate");
    recordAmbientRuntimeAction(
      requestLog,
      `ambient-hard-gate:${candidate.id}:evaluate`,
      "ambient_hard_gate",
      {
        phase: "evaluate",
        kind: candidate.kind,
        triggerMessageId: candidate.triggerMessageId,
      },
      gate.ok
        ? {
            status: "passed",
            historyCount: gate.history.length,
            summary: "Hard gates passed; evaluator LLM will run.",
          }
        : {
            status: "dropped",
            reason: gate.reason,
            decidingParameter: `hard_gate.${gate.reason.replaceAll(" ", "_")}`,
            summary: `Dropped before evaluator: ${gate.reason}.`,
          },
    );
    if (!gate.ok) {
      log.debug("ambient candidate dropped", { kind: candidate.kind, messageId: candidate.triggerMessageId, reason: gate.reason });
      if (shouldDeferAmbientCandidateForTyping(candidate.kind, "evaluate", gate.reason)) {
        deferAmbientCandidateForTyping(candidate, config);
      } else {
        clearPendingForCandidate(candidate);
      }
      emitAmbientRequestLog(requestLog);
      return;
    }

    const decision = await evaluateAmbientCandidate(config, candidate, gate.history, requestLog);
    if (decision === null) {
      recordAmbientRuntimeAction(
        requestLog,
        `ambient-decision:${candidate.id}`,
        "ambient_decision",
        { kind: candidate.kind },
        {
          status: "dropped",
          decidingParameter: "evaluator_error",
          summary: "Evaluator did not return a usable decision.",
        },
        true,
      );
      clearPendingForCandidate(candidate);
      emitAmbientRequestLog(requestLog);
      return;
    }

    const verdict = ambientDecisionVerdict(config, candidate, decision);
    recordAmbientRuntimeAction(
      requestLog,
      `ambient-decision:${candidate.id}`,
      "ambient_decision",
      {
        kind: candidate.kind,
        decision,
        thresholds: {
          replyProbability: verdict.probabilityThreshold,
          confidence: verdict.confidenceThreshold,
        },
        adjustedProbability: verdict.adjustedProbability,
        randomJitter: verdict.jitter,
        weakLingering: verdict.weakLingering,
      },
      {
        status: verdict.passed ? "selected" : "dropped",
        decidingParameter: verdict.decidingParameter,
        explanation: verdict.explanation,
        shouldReply: decision.should_reply,
        replyProbability: decision.reply_probability,
        adjustedProbability: verdict.adjustedProbability,
        probabilityThreshold: verdict.probabilityThreshold,
        confidence: decision.confidence,
        confidenceThreshold: verdict.confidenceThreshold,
        reason: decision.reason,
        intent: decision.intent ?? "",
      },
    );
    emitAmbientRequestLog(requestLog);
    if (!verdict.passed) {
      clearPendingForCandidate(candidate);
      return;
    }

    markAmbientCooldown(config, candidate);
    clearPendingForCandidate(candidate);
    const writeState: { used: boolean; firstToolName?: string } = { used: false };
    const markWriteToolStarted = (toolName: string): void => {
      writeState.used = true;
      writeState.firstToolName ??= toolName;
      markAmbientNormalTriggerInFlight(candidate.guildId, candidate.channelId, candidate.userId);
      clearPendingAmbientForUser(candidate.guildId, candidate.channelId, candidate.userId);
    };
    try {
      await processTriggeredMessage(
        candidate.message,
        { reason: candidate.kind },
        candidate.kind === "follow_up" ? [candidate.message] : candidate.triggerMessages,
        {
          disableLiveOutput: true,
          onWriteToolStart: markWriteToolStarted,
          preSendCheck: () => {
            const preSendGate = ambientHardGate(config, candidate, "pre_send");
            if (writeState.used) {
              if (!preSendGate.ok) {
                const preSendLog = createAmbientRequestLog(candidate, "pre_send_committed");
                requestLogStore.incrementActive();
                recordAmbientRuntimeAction(
                  preSendLog,
                  `ambient-hard-gate:${candidate.id}:pre-send`,
                  "ambient_hard_gate",
                  {
                    phase: "pre_send",
                    kind: candidate.kind,
                    triggerMessageId: candidate.triggerMessageId,
                    firstWriteToolName: writeState.firstToolName,
                  },
                  {
                    status: "selected",
                    reason: preSendGate.reason,
                    decidingParameter: "write_tool_committed",
                    summary: `Pre-send gate bypassed after write tool: ${preSendGate.reason}.`,
                  },
                );
                emitAmbientRequestLog(preSendLog);
              }
              if (candidate.kind === "follow_up") {
                const lease = ambientLeases.get(ambientLeaseKey(candidate.guildId, candidate.channelId, candidate.userId));
                if (lease !== undefined && lease.botMessageId === candidate.triggerMessageId) lease.followUpsSent += 1;
              }
              recordAmbientReply(candidate);
              return true;
            }
            if (!preSendGate.ok) {
              if (shouldDeferAmbientCandidateForTyping(candidate.kind, "pre_send", preSendGate.reason)) {
                deferAmbientCandidateForTyping(candidate, config);
              }
              const preSendLog = createAmbientRequestLog(candidate, "pre_send_dropped");
              requestLogStore.incrementActive();
              recordAmbientRuntimeAction(
                preSendLog,
                `ambient-hard-gate:${candidate.id}:pre-send`,
                "ambient_hard_gate",
                {
                  phase: "pre_send",
                  kind: candidate.kind,
                  triggerMessageId: candidate.triggerMessageId,
                },
                {
                  status: "dropped",
                  reason: preSendGate.reason,
                  decidingParameter: `hard_gate.${preSendGate.reason.replaceAll(" ", "_")}`,
                  summary: `Dropped before Discord send: ${preSendGate.reason}.`,
                },
              );
              emitAmbientRequestLog(preSendLog);
              log.debug("ambient reply dropped before send", { kind: candidate.kind, messageId: candidate.triggerMessageId, reason: preSendGate.reason });
              return false;
            }
            if (candidate.kind === "follow_up") {
              const lease = ambientLeases.get(ambientLeaseKey(candidate.guildId, candidate.channelId, candidate.userId));
              if (lease !== undefined && lease.botMessageId === candidate.triggerMessageId) lease.followUpsSent += 1;
            }
            recordAmbientReply(candidate);
            return true;
          },
        },
      );
    } finally {
      if (writeState.used) clearAmbientNormalTriggerInFlight(candidate.guildId, candidate.channelId, candidate.userId);
    }
  }

  function maybeScheduleAmbientAttention(message: Message, triggerResult: TriggerResult): void {
    if (message.guildId === null || message.guild === null) return;
    if (message.author.bot) {
      clearPendingAmbientForUser(message.guildId, message.channelId, message.author.id);
      ambientLeases.delete(ambientLeaseKey(message.guildId, message.channelId, message.author.id));
      return;
    }
    const guildConfig = getGuildConfig(message.guildId);
    const config = guildConfig.ambientAttention;
    if (config === undefined || !config.enabled) return;
    if (triggerResult !== null) {
      markAmbientNormalTriggerInFlight(message.guildId, message.channelId, message.author.id);
      markAmbientPickupChannelCooldown(config, message.guildId, message.channelId);
      clearPendingAmbientKindInChannel("ambient_pickup", message.guildId, message.channelId);
      clearPendingCandidate(ambientPendingKey("lingering_attention", message.guildId, message.channelId, message.author.id));
      clearPendingCandidate(ambientPendingKey("follow_up", message.guildId, message.channelId, message.author.id));
      return;
    }
    if (ambientNormalTriggerInFlight(message.guildId, message.channelId, message.author.id)) return;
    const translatedContent = translateInbound(message.content, buildInboundResolvers(message.guild));
    if (translatedContent.trim() === "" && message.stickers.size === 0) return;
    const base = {
      message,
      createdAt: Date.now(),
      triggerCreatedAt: message.createdTimestamp,
      triggerMessageId: message.id,
      triggerMessageIds: [message.id],
      triggerMessages: [message],
      userId: message.author.id,
      channelId: message.channelId,
      guildId: message.guildId,
    };

    let lease = ambientLeases.get(ambientLeaseKey(message.guildId, message.channelId, message.author.id));
    if (lease === undefined && config.lingering.enabled) {
      lease = recoverAmbientLeaseForMessage(message, config);
    }
    if (lease !== undefined && lease.expiresAt > Date.now() && config.lingering.enabled) {
      schedulePendingBurstFromMessage(message, base, config, "lingering_attention");
      return;
    }

    if (config.ambientPickup.enabled && ambientPickupChannelReady(message.guildId, message.channelId)) {
      schedulePendingBurstFromMessage(message, base, config, "ambient_pickup");
    }
  }

  function noteAmbientTyping(typing: Typing): void {
    if (!typing.inGuild() || typing.user.bot) return;
    const config = getGuildConfig(typing.guild.id).ambientAttention;
    if (config === undefined || !config.enabled) return;
    const now = Date.now();
    ambientTypingByChannelUser.set(ambientChannelUserKey(typing.guild.id, typing.channel.id, typing.user.id), now);
    clearPendingCandidate(ambientPendingKey("follow_up", typing.guild.id, typing.channel.id, typing.user.id));
    const lease = ambientLeases.get(ambientLeaseKey(typing.guild.id, typing.channel.id, typing.user.id));
    if (lease === undefined || lease.expiresAt <= now) return;
    reschedulePendingBurstForTyping("lingering_attention", typing.guild.id, typing.channel.id, typing.user.id, config);
    if (lease.typingExtensions >= config.lingering.maxTypingExtensions) return;
    lease.typingExtensions += 1;
    lease.expiresAt = Math.max(lease.expiresAt, now + config.lingering.typingExtensionMs);
  }

  function clearAmbientLeaseForUser(guildId: string, channelId: string, userId: string): void {
    ambientLeases.delete(ambientLeaseKey(guildId, channelId, userId));
    clearPendingCandidate(ambientPendingKey("lingering_attention", guildId, channelId, userId));
  }

  function recoverAmbientLeaseForMessage(message: Message, config: AmbientAttentionConfig): AmbientLease | undefined {
    if (message.guildId === null || client.user?.id === undefined) return undefined;
    const now = Date.now();
    const key = ambientLeaseKey(message.guildId, message.channelId, message.author.id);
    const existing = ambientLeases.get(key);
    if (existing !== undefined && existing.expiresAt > now) return existing;

    const history = getHistoryMessages(db, message.channelId, Math.max(config.historyLimit, 20));
    const beforeCurrent = history.filter((item) =>
      item.timestamp < message.createdTimestamp ||
      (item.timestamp === message.createdTimestamp && item.id < message.id)
    );
    const botMessage = [...beforeCurrent].reverse().find((item) =>
      item.isBot &&
      item.authorId === client.user?.id &&
      item.isPromptOnly !== true &&
      !item.isSynthetic
    );
    if (botMessage === undefined) return undefined;
    if (message.createdTimestamp - botMessage.timestamp > config.lingering.weakWindowMs) return undefined;

    let sourceMessage = botMessage.replyToId !== null
      ? beforeCurrent.find((item) => item.id === botMessage.replyToId && item.authorId === message.author.id && !item.isBot)
      : undefined;
    if (sourceMessage === undefined) {
      sourceMessage = [...beforeCurrent]
        .filter((item) => item.timestamp <= botMessage.timestamp && !item.isBot && !item.isSynthetic)
        .at(-1);
      if (sourceMessage?.authorId !== message.author.id) return undefined;
      if (botMessage.timestamp - sourceMessage.timestamp > 10 * 60 * 1000) return undefined;
    }

    const lease: AmbientLease = {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      exchangeId: crypto.randomUUID(),
      sourceMessageId: sourceMessage.id,
      botMessageId: botMessage.id,
      botRepliedAt: botMessage.timestamp,
      strongUntil: botMessage.timestamp + config.lingering.strongWindowMs,
      expiresAt: botMessage.timestamp + config.lingering.weakWindowMs,
      typingExtensions: 0,
      followUpsSent: 0,
    };
    if (lease.expiresAt <= now) return undefined;
    ambientLeases.set(key, lease);
    log.debug("ambient lingering lease recovered", {
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      botMessageId: botMessage.id,
      sourceMessageId: sourceMessage.id,
    });
    return lease;
  }

  function noteAmbientBotReply(input: {
    guildId: string;
    channelId: string;
    userId: string;
    sourceMessageId: string;
    botMessageId: string;
    message?: Message;
    allowLease: boolean;
    allowFollowUp: boolean;
  }): void {
    const config = getGuildConfig(input.guildId).ambientAttention;
    if (config === undefined || !config.enabled || !config.lingering.enabled) return;
    if (!input.allowLease) return;
    const sourceRow = input.message === undefined
      ? db.raw
        .prepare("SELECT is_bot FROM messages WHERE id = ? AND guild_id = ? AND is_prompt_only = 0")
        .get(input.sourceMessageId, input.guildId) as { is_bot: number } | null
      : null;
    const sourceIsBot = input.message?.author.bot ?? (sourceRow?.is_bot === 1);
    if (sourceIsBot) {
      clearPendingAmbientForUser(input.guildId, input.channelId, input.userId);
      ambientLeases.delete(ambientLeaseKey(input.guildId, input.channelId, input.userId));
      return;
    }
    const now = Date.now();
    const botMessage = getMessageById(db, input.botMessageId, input.guildId);
    const botMessageCreatedAt = botMessage?.createdAt ?? now;
    const key = ambientLeaseKey(input.guildId, input.channelId, input.userId);
    clearPendingCandidate(ambientPendingKey("lingering_attention", input.guildId, input.channelId, input.userId));
    const lease: AmbientLease = {
      guildId: input.guildId,
      channelId: input.channelId,
      userId: input.userId,
      exchangeId: crypto.randomUUID(),
      sourceMessageId: input.sourceMessageId,
      botMessageId: input.botMessageId,
      botRepliedAt: botMessageCreatedAt,
      strongUntil: botMessageCreatedAt + config.lingering.strongWindowMs,
      expiresAt: botMessageCreatedAt + config.lingering.weakWindowMs,
      typingExtensions: 0,
      followUpsSent: 0,
    };
    ambientLeases.set(key, lease);
    if (!input.allowFollowUp || input.message === undefined || !config.followUp.enabled || config.followUp.maxPerExchange <= 0) return;
    scheduleAmbientCandidate({
      id: crypto.randomUUID(),
      kind: "follow_up",
      message: input.message,
      createdAt: now,
      triggerCreatedAt: botMessageCreatedAt,
      triggerMessageId: input.botMessageId,
      triggerMessageIds: [input.botMessageId],
      triggerMessages: [input.message],
      userId: input.userId,
      channelId: input.channelId,
      guildId: input.guildId,
    });
  }

  function clearAmbientTyping(guildId: string, channelId: string, userId: string): void {
    ambientTypingByChannelUser.delete(ambientChannelUserKey(guildId, channelId, userId));
  }

  return {
    runAmbientInitiativeOpportunity,
    scheduleAmbientInitiativeGuild,
    startAmbientInitiativeLoops,
    runPromptLabAmbientInitiative,
    maybeScheduleAmbientAttention,
    noteAmbientTyping,
    markAmbientPickupChannelCooldown,
    clearPendingAmbientKindInChannel,
    clearAmbientNormalTriggerInFlight,
    clearAmbientTyping,
    clearAmbientLeaseForUser,
    noteAmbientBotReply,
    clearAmbientAttentionState,
    clearAmbientInitiativeState,
  };
}
