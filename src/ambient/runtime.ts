import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Client, Guild, Message, Typing } from "discord.js";
import type { Database } from "../db/database";
import { RequestLog, type Logger } from "../logger";
import type { RequestLogStore } from "../dashboard/store";
import type { AmbientAttentionConfig, AmbientAttentionKind, AmbientAttentionModeConfig, AmbientInitiativeConfig, AmbientInitiativeKind, AmbientInitiativeKindConfig, GuildConfig } from "../config/types";
import type { HistoryMessage } from "../agent/history-types";
import type { TriggerResult } from "../agent/triggers";
import type { AssembledContext } from "../agent/context-assembly";
import { handleMessage, type HandlerDeps, type MessageSender } from "../agent/handler";
import { formatHistoryContent } from "../agent/history-formatting";
import { trackWriteToolStarts } from "../agent/tool-access";
import { isActiveJobStatus, type AgentJobStore } from "../agent/job-runtime";
import type { PromptBundle } from "../config/instruction-bundle";
import type { GlobalConfig } from "../config/types";
import type { GeneratedImageAttachment } from "../agent/codex-image-tool";
import { botChannelPermissions, isSendableGuildChannel, type ResolveTargetChannel, type SendableGuildChannel } from "../discord/message-sender";
import type { ReplyFallbackDeps } from "../agent/reply-target-fallback";
import type { PromptLabDraftMessage, PromptLabDryRun, PromptLabRunResult } from "../dashboard/prompt-lab-types";
import { buildComputedContactContextForUser } from "../agent/contact-context";
import { shouldRespond } from "../agent/triggers";
import { translateInbound } from "../discord/translation";
import { buildAmbientAttentionStreamOptions, buildAmbientInitiativeStreamOptions, resolveGuildLlmProvider } from "../llm/client";
import { completeLlmChat } from "../llm/chat";
import type { OpenRouterMessage } from "../llm/types";
import { getChannelHumanActivityBuckets, getHistoryMessages, getMessageById } from "../db/message-repository";
import { countUserMemoriesByUser, listMemories } from "../db/memory-repository";
import { channelDisplayName, createTargetChannelResolver } from "../discord/message-sender";
import { createStoredAssetAttachmentResolver } from "../agent/stored-asset-attachments";
import { createDiscordAssetSourceResolver } from "../discord/asset-resolver";
import { DEFAULT_ASSET_READING } from "../config/defaults";
import { createGeneratedImageRuntime, shortQuote } from "../agent/generated-image-runtime";
import { formatLocalWallClock } from "../time/agent-time";

/** Apply bot-specific initiative pressure and normalize it for probability use. */
export function applyAmbientInitiativeBotPressure(
  pressure: number,
  botDirected: boolean,
  botPressure: number,
): number {
  return Math.max(0, Math.min(1, pressure + (botDirected ? botPressure : 0)));
}

/** Ensure a bot-directed initiative visibly pings its configured Discord target. */
export function ensureAmbientInitiativeBotMention(text: string, targetBotId: string): string {
  const mention = `<@${targetBotId}>`;
  if (text.includes(mention) || text.includes(`<@!${targetBotId}>`)) return text;
  return text === "" ? mention : `${mention} ${text}`;
}

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
  runAmbientInitiativeOpportunity: (guildId: string, forcedKind?: AmbientInitiativeKind, mode?: "automatic" | "draft" | "shadow", runToken?: string) => Promise<{ requestId?: string; error?: string }>;
  scheduleAmbientInitiativeGuild: (guildId: string) => void;
  startAmbientInitiativeLoops: () => void;
  runPromptLabAmbientInitiative: (input: { guildId: string; channelId: string; kind: AmbientInitiativeKind; force?: boolean; runToken?: string }) => Promise<PromptLabRunResult>;
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
  buildContext: (guildId: string, channelId: string, guild: Guild, guildConfig: GuildConfig, userMessage: string, latestUserMessage: HistoryMessage, replyFallbackDeps: ReplyFallbackDeps, isThread: boolean, currentTurnBoundary?: { timestamp: number; messageId: string }, relationshipsMode?: "live" | "virtual") => Promise<AssembledContext>;
  buildAgentTools: (guildId: string, channelId: string, guildConfig: GuildConfig, guild: Guild, contextMessageIds: string[], onGeneratedImage?: (attachment: GeneratedImageAttachment) => void, currentRequest?: { requesterId: string; requesterUsername: string; sourceMessageId: string; sourceQuote: string }, options?: Record<string, unknown>) => AgentTool[];
  promptLabDryRunTools: (tools: AgentTool[], dryRuns: PromptLabDryRun[]) => AgentTool[];
  promptLabSyntheticId: (offset?: number) => string;
  promptLabSummary: (entry: ReturnType<RequestLog["toEntry"]>) => Omit<PromptLabRunResult, "requestId" | "triggered" | "drafts" | "dryRuns" | "responseText" | "relationshipsContext" | "relationshipsExtraction" | "memoryExtraction" | "error">;
  resolveClientGuild: (guildId: string) => Promise<Guild | null>;
  fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
  promptLabUserFromGuild: (guild: Guild, userId: string) => { id: string; username: string; displayName?: string; globalName?: string };
  createBotDiscordMessageSender: (input: {
    defaultChannel: SendableGuildChannel;
    resolveTargetChannel: ResolveTargetChannel;
    botUserId: string;
    botUsername: string;
    logger: Logger;
  }) => MessageSender;
  createHandlerDeps: (input: CreateHandlerDepsInput) => HandlerDeps;
  processTriggeredMessage: (message: Message, triggerResult?: NonNullable<TriggerResult>, currentTurnMessages?: readonly Message[], options?: { disableLiveOutput?: boolean; defaultReply?: boolean; triggerInstruction?: string; currentTurnOverride?: { messageId: string; timestamp: number; content: string }; preSendCheck?: () => boolean; onWriteToolStart?: (toolName: string) => void }) => Promise<unknown>;
  isAutonomousAttentionBusy?: (guildId: string, channelId: string) => boolean;
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

export function createAmbientRuntime(input: AmbientRuntimeDeps): AmbientRuntime {
  const { db, client, log, requestLogStore, agentJobs } = input;
  const getPromptBundle = input.getPromptBundle;
  const getGlobalConfig = input.getGlobalConfig;
  const TYPING_INTERVAL_MS = input.typingIntervalMs;
  const getGuildConfig = input.getGuildConfig;
  const dashboardTriggerLocation = input.dashboardTriggerLocation;
  const buildInboundResolvers = input.buildInboundResolvers;
  const createSyntheticReplyFallbackDeps = input.createSyntheticReplyFallbackDeps;
  const buildContext = input.buildContext;
  const buildAgentTools = input.buildAgentTools;
  const promptLabDryRunTools = input.promptLabDryRunTools;
  const promptLabSyntheticId = input.promptLabSyntheticId;
  const promptLabSummary = input.promptLabSummary;
  const promptLabUserFromGuild = input.promptLabUserFromGuild;
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
    defaultReply: boolean;
    syntheticContent?: string;
    syntheticTimestamp?: number;
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
    default_reply?: boolean;
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
    const userKey = `${candidate.guildId}:${candidate.userId}`;
    const channelKey = `${candidate.guildId}:${candidate.channelId}`;
    const userTimes = pruneRecentTimes(ambientReplyTimesByUser.get(userKey) ?? [], now);
    const channelTimes = pruneRecentTimes(ambientReplyTimesByChannel.get(channelKey) ?? [], now);
    ambientReplyTimesByUser.set(userKey, userTimes);
    ambientReplyTimesByChannel.set(channelKey, channelTimes);
    const mode = ambientModeConfig(config, candidate.kind);
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
    if (contentMentionsBot(rawContent, botUserId)) return { reason: "mention" };
    if (storedMessageRepliesToOwnBot(message, guildConfig.guildId)) return { reason: "mention" };
    return shouldRespond(
      {
        content: message.content,
        authorId: message.authorId,
        authorIsBot: message.isBot,
        botUserId,
        mentionedUserIds: [],
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
    const translatedContent = candidate.syntheticContent ?? (guild !== null
      ? translateInbound(candidate.message.content, buildInboundResolvers(guild))
      : candidate.message.content);
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
        defaultReply: candidate.defaultReply,
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

  function ambientPendingKey(kind: AmbientAttentionKind, guildId: string, channelId: string, userId: string): string {
    return `${kind}:${guildId}:${channelId}:${userId}`;
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

  function armPendingCandidate(key: string, candidate: AmbientCandidate, delayMs: number): void {
    clearPendingCandidate(key);
    logAmbientScheduled(candidate, delayMs);
    const timer = setTimeout(() => {
      const pending = ambientPendingCandidates.get(key);
      if (pending?.candidate.id === candidate.id) ambientPendingCandidates.delete(key);
      ambientCandidateTimers.delete(candidate.id);
      void runAmbientCandidate(candidate);
    }, delayMs);
    ambientPendingCandidates.set(key, { candidate, timer });
    ambientCandidateTimers.set(candidate.id, timer);
  }

  function schedulePendingBurstFromMessage(
    message: Message,
    base: Omit<AmbientCandidate, "id" | "kind" | "defaultReply">,
    config: AmbientAttentionConfig,
    kind: "ambient_pickup" | "lingering_attention",
  ): void {
    const key = ambientPendingKey(kind, base.guildId, base.channelId, base.userId);
    const mode = ambientModeConfig(config, kind);
    const existing = ambientPendingCandidates.get(key);
    const burstStartedAt = existing?.candidate.burstStartedAt ?? message.createdTimestamp;
    const burstMessageCount = (existing?.candidate.burstMessageCount ?? 0) + 1;
    const triggerMessageIds = [...new Set([...(existing?.candidate.triggerMessageIds ?? []), message.id])];
    const triggerMessages = [
      ...(existing?.candidate.triggerMessages ?? []),
      message,
    ].filter((item, index, items) => items.findIndex((candidateMessage) => candidateMessage.id === item.id) === index);
    const candidate: AmbientCandidate = {
      ...base,
      id: crypto.randomUUID(),
      kind,
      defaultReply: mode.defaultReply,
      triggerMessageIds,
      triggerMessages,
      burstStartedAt,
      burstMessageCount,
    };
    armPendingCandidate(key, candidate, randomBetween(mode.minDelayMs, mode.maxDelayMs));
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
    const mode = ambientModeConfig(config, candidate.kind);
    const delayMs = Math.max(ambientTypingActiveMs(config, candidate.kind), TYPING_INTERVAL_MS)
      + randomBetween(mode.minDelayMs, mode.maxDelayMs);
    armPendingCandidate(key, candidate, delayMs);
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
    const streamOptions = buildAmbientAttentionStreamOptions(getGlobalConfig(), getGuildConfig(candidate.guildId));
    const providerParams: Record<string, unknown> = { ...streamOptions };
    delete providerParams.apiKey;
    const provider = config.evaluator.provider ?? resolveGuildLlmProvider(getGlobalConfig(), getGuildConfig(candidate.guildId));
    const mode = ambientModeConfig(config, candidate.kind);
    const system = [
      ambientEvaluatorPolicyForKind(candidate.kind),
      "Decide whether the configured persona should naturally speak in Discord ambient attention.",
      "Usually choose silence. Do not write the reply text.",
      "Return only compact JSON with should_reply, reply_probability, confidence, intent, default_reply, reason.",
      "reply_probability and confidence must be 0..1. reason should be one short sentence.",
    ].filter((part) => part.trim() !== "").join("\n\n");
    const user = [
      `kind: ${candidate.kind}`,
      `default_reply: ${mode.defaultReply}`,
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
        model: config.evaluator.model,
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
              required: ["should_reply", "reply_probability", "confidence", "intent", "default_reply", "reason"],
              properties: {
                should_reply: { type: "boolean" },
                reply_probability: { type: "number", minimum: 0, maximum: 1 },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                intent: { type: "string" },
                default_reply: { type: "boolean" },
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
        default_reply: typeof record.default_reply === "boolean" ? record.default_reply : candidate.defaultReply,
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

  function ambientTriggerInstruction(kind: AmbientAttentionKind, decision: AmbientDecision): string {
    const anchoring = decision.default_reply === true
      ? "The first visible message may reply to the triggering message when anchoring helps."
      : "The first visible message defaults to a normal channel message; set reply=\"true\" or reply_to only when anchoring is clearly better.";
    const followUp = kind === "follow_up"
      ? "Default to <ignore> unless there is a concrete natural follow-up intent."
      : "Silence remains allowed if current context changed or the beat no longer fits.";
    return [
      `Ambient attention selected this turn as ${kind}.`,
      `Evaluator intent: ${decision.intent ?? "unspecified"}.`,
      `Evaluator reason: ${decision.reason}`,
      anchoring,
      followUp,
    ].join(" ");
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

  type AmbientInitiativeDecision = {
    should_initiate: boolean;
    initiate_probability: number;
    kind: AmbientInitiativeKind;
    target_user_id: string | null;
    source: string;
    anchor: string;
    required_shape: string;
    avoid: string[];
    confidence: number;
    reason: string;
  };

  type AmbientInitiativeRunMode = "automatic" | "draft" | "shadow";

  type AmbientInitiativeCandidate = {
    id: string;
    guildId: string;
    channelId: string;
    kind: AmbientInitiativeKind;
    createdAt: number;
    mode: AmbientInitiativeRunMode;
    forced: boolean;
    forceDecision: boolean;
    targetBotId?: string;
    runToken?: string;
  };

  type AmbientInitiativeSignals = {
    now: number;
    inActiveHours: boolean;
    quietMs: number | null;
    lastHumanAt: number | null;
    lastBotAt: number | null;
    recentHumanCount: number;
    recentBotCount: number;
    activeTyping: boolean;
    pendingAmbientCandidates: number;
    activeImageJobs: number;
    familiarOnlineCount: number;
    openLoops: AmbientInitiativeOpenLoop[];
    recentInitiatives: AmbientInitiativeRecord[];
  };

  type AmbientInitiativeOpenLoop = {
    memoryId: number;
    userId: string | null;
    kind: string;
    content: string;
    ageMs: number;
  };

  type AmbientInitiativeRecord = {
    id: string;
    guildId: string;
    channelId: string;
    kind: AmbientInitiativeKind;
    targetUserId: string | null;
    summary: string;
    text: string;
    sent: boolean;
    ignored: boolean;
    createdAt: number;
  };

  type AmbientInitiativePressure = {
    kind: AmbientInitiativeKind;
    pressure: number;
    threshold: number;
    roll: number;
    passed: boolean;
    inputs: Record<string, number | boolean | string | null>;
  };

  const ambientInitiativeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const ambientInitiativeRunning = new Set<string>();
  const ambientInitiativeLastByKind = new Map<string, number>();
  const ambientInitiativeRecords: AmbientInitiativeRecord[] = [];
  const AMBIENT_INITIATIVE_RECORD_LIMIT = 300;

  function ambientInitiativeLockKey(guildId: string, channelId: string): string {
    return `${guildId}:${channelId}`;
  }

  function ambientInitiativeKindKey(kind: AmbientInitiativeKind, guildId: string, channelId: string): string {
    return `${kind}:${guildId}:${channelId}`;
  }

  function ambientInitiativeKindConfig(config: AmbientInitiativeConfig, kind: AmbientInitiativeKind): AmbientInitiativeKindConfig {
    if (kind === "self_expression") return config.selfExpression;
    return config.targetedCheckin;
  }

  function clearAmbientInitiativeState(): void {
    for (const timer of ambientInitiativeTimers.values()) clearTimeout(timer);
    ambientInitiativeTimers.clear();
    ambientInitiativeRunning.clear();
    ambientInitiativeLastByKind.clear();
  }

  function recordAmbientInitiativeEvent(record: AmbientInitiativeRecord): void {
    ambientInitiativeRecords.push(record);
    while (ambientInitiativeRecords.length > AMBIENT_INITIATIVE_RECORD_LIMIT) ambientInitiativeRecords.shift();
  }

  function recentAmbientInitiatives(guildId: string, channelId: string, now = Date.now()): AmbientInitiativeRecord[] {
    return ambientInitiativeRecords
      .filter((record) => record.guildId === guildId && record.channelId === channelId && now - record.createdAt <= 24 * 60 * 60 * 1000)
      .slice(-20);
  }

  function parseClockMinutes(value: string): number {
    const [hhRaw = "0", mmRaw = "0"] = value.split(":");
    return Number(hhRaw) * 60 + Number(mmRaw);
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

  function ambientInitiativeInActiveHours(config: AmbientInitiativeConfig, guildConfig: GuildConfig, now = Date.now()): boolean {
    const timezone = config.activeHours.timezone ?? guildConfig.timezone;
    const current = localClockMinutes(timezone, now);
    const start = parseClockMinutes(config.activeHours.start);
    const end = parseClockMinutes(config.activeHours.end);
    if (start === end) return true;
    if (start < end) return current >= start && current <= end;
    return current >= start || current <= end;
  }

  function ambientInitiativeDailyCount(input: {
    guildId: string;
    channelId: string;
    kind?: AmbientInitiativeKind;
    targetUserId?: string | null;
    now?: number;
  }): number {
    const now = input.now ?? Date.now();
    return ambientInitiativeRecords.filter((record) =>
      record.guildId === input.guildId &&
      record.channelId === input.channelId &&
      now - record.createdAt <= 24 * 60 * 60 * 1000 &&
      (input.kind === undefined || record.kind === input.kind) &&
      (input.targetUserId === undefined || record.targetUserId === input.targetUserId) &&
      record.sent
    ).length;
  }

  function resolveAmbientInitiativeMainChannel(guild: Guild, config: AmbientInitiativeConfig): SendableGuildChannel | null {
    if (config.mainChannelId !== undefined && config.mainChannelId !== "") {
      const configured = client.channels.cache.get(config.mainChannelId);
      return configured !== undefined && isSendableGuildChannel(configured) && configured.guildId === guild.id
        ? configured
        : null;
    }

    const after = Date.now() - config.mainChannelLookbackDays * 24 * 60 * 60 * 1000;
    const rows = db.raw
      .prepare(
        `SELECT channel_id, COUNT(*) AS count
         FROM messages
         WHERE guild_id = ? AND is_bot = 0 AND is_synthetic = 0 AND is_prompt_only = 0 AND created_at >= ?
         GROUP BY channel_id
         ORDER BY count DESC`
      )
      .all(guild.id, after) as Array<{ channel_id: string; count: number }>;

    for (const row of rows) {
      if (row.count < config.minMainChannelHumanMessages) continue;
      const channel = client.channels.cache.get(row.channel_id);
      if (channel === undefined || !isSendableGuildChannel(channel) || channel.guildId !== guild.id) continue;
      if (!botChannelPermissions(client, channel).canSend) continue;
      return channel;
    }

    return null;
  }

  function activeImageJobsInChannel(guildId: string, channelId: string): number {
    return agentJobs.listVisible(guildId, channelId).filter((job) => isActiveJobStatus(job.status)).length;
  }

  function pendingAmbientCandidatesInChannel(guildId: string, channelId: string): number {
    let count = 0;
    for (const pending of ambientPendingCandidates.values()) {
      if (pending.candidate.guildId === guildId && pending.candidate.channelId === channelId) count += 1;
    }
    return count;
  }

  function ambientInitiativeOpenLoops(guild: Guild, channelId: string, config: AmbientInitiativeConfig, now = Date.now()): AmbientInitiativeOpenLoop[] {
    const maxAgeMs = config.targetedCheckin.openLoopMaxAgeMs;
    const rows = db.raw
      .prepare(
        `SELECT memories.id, memories.scope, memories.subject_user_id, memories.kind, memories.content, memories.updated_at,
                messages.guild_id AS source_guild_id, messages.channel_id AS source_channel_id
         FROM memories
         LEFT JOIN messages ON messages.id = memories.source_message_id
         WHERE memories.deleted_at IS NULL
           AND (memories.expires_at IS NULL OR memories.expires_at > ?)
           AND memories.updated_at >= ?
           AND (
             (scope = 'user' AND subject_user_id IS NOT NULL)
             OR (scope = 'guild' AND memories.guild_id = ?)
           )
         ORDER BY memories.updated_at DESC, memories.id DESC
         LIMIT 20`
      )
      .all(now, now - maxAgeMs, guild.id) as Array<{
        id: number;
        scope: string;
        subject_user_id: string | null;
        kind: string;
        content: string;
        updated_at: number;
        source_guild_id: string | null;
        source_channel_id: string | null;
      }>;

    return rows
      .filter((row) => {
        if (row.scope === "user") {
          if (row.subject_user_id === null || !isHumanGuildMember(guild, row.subject_user_id)) return false;
          if (row.source_guild_id !== null && row.source_guild_id !== guild.id) return false;
        }
        if (row.scope === "guild" && row.source_channel_id !== null && row.source_channel_id !== channelId) return false;
        const content = row.content.toLowerCase();
        return row.kind === "scratchpad" || content.includes("check") || content.includes("later") || content.includes("собира");
      })
      .map((row) => ({
        memoryId: row.id,
        userId: row.subject_user_id,
        kind: row.kind,
        content: row.content,
        ageMs: now - row.updated_at,
      }));
  }

  function familiarOnlineCount(guild: Guild, guildId: string): number {
    const memoryCounts = countUserMemoriesByUser(db, guildId);
    let count = 0;
    for (const [userId, memoryCount] of memoryCounts) {
      if (memoryCount <= 0) continue;
      const member = guild.members.cache.get(userId);
      if (member?.user.bot === true) continue;
      const status = member?.presence?.status;
      if (status === "online" || status === "idle" || status === "dnd") count += 1;
    }
    return count;
  }

  function isHumanGuildMember(guild: Guild, userId: string): boolean {
    const member = guild.members.cache.get(userId);
    return member !== undefined && !member.user.bot;
  }

  function latestMessageStats(guildId: string, channelId: string, config: AmbientInitiativeConfig, now: number): {
    lastHumanAt: number | null;
    lastBotAt: number | null;
    recentHumanCount: number;
    recentBotCount: number;
  } {
    const after = now - config.recentActivityMaxMs;
    const rows = db.raw
      .prepare(
        `SELECT user_id, is_bot, created_at
         FROM messages
         WHERE guild_id = ? AND channel_id = ? AND is_synthetic = 0 AND is_prompt_only = 0 AND created_at >= ?
         ORDER BY created_at DESC, id DESC
         LIMIT 200`
      )
      .all(guildId, channelId, after) as Array<{ user_id: string; is_bot: number; created_at: number }>;
    let lastHumanAt: number | null = null;
    let lastBotAt: number | null = null;
    let recentHumanCount = 0;
    let recentBotCount = 0;
    for (const row of rows) {
      if (row.is_bot === 1 && row.user_id === client.user?.id) {
        recentBotCount += 1;
        lastBotAt ??= row.created_at;
      } else if (row.is_bot === 0) {
        recentHumanCount += 1;
        lastHumanAt ??= row.created_at;
      }
    }
    return { lastHumanAt, lastBotAt, recentHumanCount, recentBotCount };
  }

  function buildAmbientInitiativeSignals(guild: Guild, channelId: string, guildConfig: GuildConfig, config: AmbientInitiativeConfig): AmbientInitiativeSignals {
    const now = Date.now();
    const stats = latestMessageStats(guild.id, channelId, config, now);
    return {
      now,
      inActiveHours: ambientInitiativeInActiveHours(config, guildConfig, now),
      quietMs: stats.lastHumanAt !== null ? now - stats.lastHumanAt : null,
      ...stats,
      activeTyping: activeTypingInChannel(guild.id, channelId, config.typingActiveMs, now),
      pendingAmbientCandidates: pendingAmbientCandidatesInChannel(guild.id, channelId),
      activeImageJobs: activeImageJobsInChannel(guild.id, channelId),
      familiarOnlineCount: familiarOnlineCount(guild, guild.id),
      openLoops: ambientInitiativeOpenLoops(guild, channelId, config, now),
      recentInitiatives: recentAmbientInitiatives(guild.id, channelId, now),
    };
  }

  function ambientInitiativeHardGate(input: {
    guildId: string;
    channelId: string;
    kind?: AmbientInitiativeKind;
    config: AmbientInitiativeConfig;
    signals: AmbientInitiativeSignals;
    forced: boolean;
    phase: "opportunity" | "pre_send";
  }): { ok: true } | { ok: false; reason: string } {
    if (!input.config.enabled && !input.forced) return { ok: false, reason: "ambient initiative disabled" };
    if (!input.forced && isAutonomousAttentionBusy(input.guildId, input.channelId)) return { ok: false, reason: "scheduled task active" };
    if (input.phase === "pre_send" && input.signals.activeTyping) return { ok: false, reason: "user typing active" };
    if (input.signals.activeImageJobs > 0) return { ok: false, reason: "active image job visible" };
    if (input.signals.pendingAmbientCandidates > 0) return { ok: false, reason: "ambient attention pending" };
    if (!input.forced && !input.signals.inActiveHours) return { ok: false, reason: "outside active hours" };
    if (!input.forced && input.signals.activeTyping) return { ok: false, reason: "user typing active" };
    if (!input.forced && input.signals.lastBotAt !== null && input.signals.now - input.signals.lastBotAt < input.config.botCooldownMs) {
      return { ok: false, reason: "recent bot output" };
    }
    if (!input.forced && input.signals.quietMs !== null && input.signals.quietMs < input.config.quietWindowMs) {
      return { ok: false, reason: "quiet window too short" };
    }
    if (!input.forced && input.signals.lastHumanAt === null) return { ok: false, reason: "no recent human activity" };
    if (!input.forced && input.signals.lastHumanAt !== null && input.signals.now - input.signals.lastHumanAt < input.config.recentActivityMinMs) {
      return { ok: false, reason: "human activity too fresh" };
    }
    if (!input.forced && input.signals.lastHumanAt !== null && input.signals.now - input.signals.lastHumanAt > input.config.recentActivityMaxMs) {
      return { ok: false, reason: "room too dead" };
    }
    if (!input.forced && ambientInitiativeDailyCount({ guildId: input.guildId, channelId: input.channelId, now: input.signals.now }) >= input.config.maxPerDay) {
      return { ok: false, reason: "daily initiative budget exhausted" };
    }
    if (input.kind !== undefined) {
      const kindConfig = ambientInitiativeKindConfig(input.config, input.kind);
      if (!kindConfig.enabled && !input.forced) return { ok: false, reason: `${input.kind} disabled` };
      if (!input.forced && ambientInitiativeDailyCount({ guildId: input.guildId, channelId: input.channelId, kind: input.kind, now: input.signals.now }) >= kindConfig.maxPerDay) {
        return { ok: false, reason: `${input.kind} daily budget exhausted` };
      }
      const lastKind = ambientInitiativeLastByKind.get(ambientInitiativeKindKey(input.kind, input.guildId, input.channelId)) ?? 0;
      if (!input.forced && input.signals.now - lastKind < kindConfig.cooldownMs) return { ok: false, reason: `${input.kind} cooldown active` };
    }
    return { ok: true };
  }

  function ambientInitiativePressureForKind(
    config: AmbientInitiativeConfig,
    kind: AmbientInitiativeKind,
    signals: AmbientInitiativeSignals,
    botDirected = false,
  ): AmbientInitiativePressure {
    const kindConfig = ambientInitiativeKindConfig(config, kind);
    let pressure = kindConfig.basePressure;
    const quietMs = signals.quietMs ?? 0;
    if (signals.inActiveHours) pressure += 0.12;
    if (signals.lastHumanAt !== null && quietMs >= config.quietWindowMs) pressure += 0.18;
    if (signals.lastHumanAt !== null && quietMs <= config.recentActivityMaxMs) pressure += 0.08;
    if (signals.familiarOnlineCount > 0) pressure += Math.min(0.16, signals.familiarOnlineCount * 0.04);
    if (signals.openLoops.length > 0 && kind === "targeted_checkin") pressure += 0.24;
    if (signals.lastBotAt !== null) pressure -= Math.max(0, 0.25 - Math.min(0.25, (signals.now - signals.lastBotAt) / Math.max(1, config.fatigueAfterAnyMs) * 0.25));
    if (signals.recentInitiatives.length > 0) pressure -= 0.12;
    if (!signals.inActiveHours) pressure -= 0.35;
    if (signals.lastHumanAt === null) pressure -= 0.25;
    const finalPressure = applyAmbientInitiativeBotPressure(pressure, botDirected, config.botPressure);
    const roll = Math.random();
    return {
      kind,
      pressure: finalPressure,
      threshold: kindConfig.pressureThreshold,
      roll,
      passed: finalPressure >= kindConfig.pressureThreshold && roll <= finalPressure,
      inputs: {
        inActiveHours: signals.inActiveHours,
        quietMs,
        familiarOnlineCount: signals.familiarOnlineCount,
        openLoops: signals.openLoops.length,
        recentInitiatives: signals.recentInitiatives.length,
        lastBotAgeMs: signals.lastBotAt !== null ? signals.now - signals.lastBotAt : null,
        audience: botDirected ? "bots" : "humans",
        botPressure: botDirected ? config.botPressure : 0,
      },
    };
  }

  async function selectAmbientInitiativeBotTarget(guild: Guild, config: AmbientInitiativeConfig): Promise<string | null> {
    if (config.botTargetIds.length === 0) return null;
    const selfId = client.user?.id ?? "";
    const available: string[] = [];
    for (const targetId of config.botTargetIds) {
      if (targetId === selfId) continue;
      const cached = guild.members.cache.get(targetId);
      const member = cached ?? await guild.members.fetch(targetId).catch(() => null);
      if (member?.user.bot === true) available.push(targetId);
    }
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)] ?? null;
  }

  function ambientInitiativeAudienceText(guild: Guild, candidate: AmbientInitiativeCandidate): string {
    if (candidate.targetBotId === undefined) return "audience: humans";
    const member = guild.members.cache.get(candidate.targetBotId);
    return [
      "audience: bots",
      `target_bot_id: ${candidate.targetBotId}`,
      `target_bot_username: ${member?.user.username ?? "unknown"}`,
      "The target is another automated agent or LLM. The runtime adds its Discord mention to the first visible message.",
    ].join("\n");
  }

  function initiativeEvaluatorPolicyForKind(kind: AmbientInitiativeKind): string {
    const policies = getPromptBundle().runtime.ambientInitiative.evaluator;
    const kindPolicy = kind === "self_expression"
      ? policies.selfExpression
      : policies.targetedCheckin;
    return [policies.shared, kindPolicy].filter((part) => part.trim() !== "").join("\n\n");
  }

  function initiativeGenerationPolicyForKind(kind: AmbientInitiativeKind): string {
    const policies = getPromptBundle().runtime.ambientInitiative.generation;
    const kindPolicy = kind === "self_expression"
      ? policies.selfExpression
      : policies.targetedCheckin;
    return [policies.shared, kindPolicy].filter((part) => part.trim() !== "").join("\n\n");
  }

  function renderAmbientInitiativeSignals(signals: AmbientInitiativeSignals): string {
    return [
      `active_hours: ${signals.inActiveHours}`,
      `quiet_ms: ${signals.quietMs ?? "none"}`,
      `recent_human_count: ${signals.recentHumanCount}`,
      `recent_bot_count: ${signals.recentBotCount}`,
      `active_typing: ${signals.activeTyping}`,
      `pending_ambient_candidates: ${signals.pendingAmbientCandidates}`,
      `active_image_jobs: ${signals.activeImageJobs}`,
      `familiar_online_count: ${signals.familiarOnlineCount}`,
    ].join("\n");
  }

  function renderAmbientInitiativeOpenLoops(openLoops: AmbientInitiativeOpenLoop[]): string {
    if (openLoops.length === 0) return "none";
    return openLoops.slice(0, 8).map((loop) =>
      `- memory_id=${loop.memoryId} user_id=${loop.userId ?? "none"} kind=${loop.kind} age_ms=${loop.ageMs}: ${loop.content}`
    ).join("\n");
  }

  function renderAmbientInitiativeRecent(records: AmbientInitiativeRecord[]): string {
    if (records.length === 0) return "none";
    return records.slice(-8).map((record) =>
      `- ${new Date(record.createdAt).toISOString()} kind=${record.kind} target=${record.targetUserId ?? "none"} sent=${record.sent} ignored=${record.ignored}: ${record.summary}`
    ).join("\n");
  }

  function forcedAmbientInitiativeDecision(kind: AmbientInitiativeKind, signals: AmbientInitiativeSignals, history: HistoryMessage[]): AmbientInitiativeDecision | null {
    const loop = signals.openLoops.find((item) => item.userId !== null);
    const latestHuman = [...history].reverse().find((message) => !message.isBot);
    const targetUserId = kind === "targeted_checkin" ? loop?.userId ?? latestHuman?.authorId ?? null : null;
    if (kind === "targeted_checkin" && targetUserId === null) return null;
    return {
      should_initiate: true,
      initiate_probability: 1,
      kind,
      target_user_id: targetUserId,
      source: "prompt_lab_force",
      anchor: loop?.content ?? latestHuman?.content ?? "Prompt Lab forced initiative draft.",
      required_shape: kind === "self_expression" ? "concrete_incomplete_disposable" : "brief_anchored_followup",
      avoid: ["forced", "performative", "creepy", "polished"],
      confidence: 1,
      reason: "Prompt Lab force bypassed evaluator.",
    };
  }

  function createAmbientInitiativeRequestLog(input: {
    guild: Guild;
    channel: SendableGuildChannel;
    candidate: AmbientInitiativeCandidate;
    status: string;
  }): RequestLog {
    const requestLog = new RequestLog(input.candidate.guildId, input.candidate.channelId, requestLogStore);
    requestLog.setAuthor(input.candidate.mode === "draft" ? "prompt-lab:ambient-initiative" : "ambient-initiative");
    requestLog.setTrigger({
      type: "ambient_initiative_evaluator",
      kind: input.candidate.kind,
      audience: input.candidate.targetBotId !== undefined ? "bots" : "humans",
      ...(input.candidate.targetBotId !== undefined ? { targetBotId: input.candidate.targetBotId } : {}),
      status: input.status,
      mode: input.candidate.mode,
      ...(input.candidate.runToken !== undefined ? { runToken: input.candidate.runToken } : {}),
    });
    requestLog.setTriggerContext({
      ...dashboardTriggerLocation(input.guild, input.channel),
      messageId: input.candidate.id,
      authorUsername: "ambient-initiative",
      content: `${input.candidate.kind} opportunity`,
      translatedContent: `${input.candidate.kind} opportunity`,
    });
    requestLog.setAgentRan(true);
    return requestLog;
  }

  async function evaluateAmbientInitiativeCandidate(input: {
    guild: Guild;
    config: AmbientInitiativeConfig;
    guildConfig: GuildConfig;
    candidate: AmbientInitiativeCandidate;
    signals: AmbientInitiativeSignals;
    pressure: AmbientInitiativePressure;
    history: HistoryMessage[];
    requestLog: RequestLog;
  }): Promise<AmbientInitiativeDecision | null> {
    const streamOptions = buildAmbientInitiativeStreamOptions(getGlobalConfig(), input.guildConfig);
    const providerParams: Record<string, unknown> = { ...streamOptions };
    delete providerParams.apiKey;
    const provider = input.config.evaluator.provider ?? resolveGuildLlmProvider(getGlobalConfig(), input.guildConfig);
    const system = [
      initiativeEvaluatorPolicyForKind(input.candidate.kind),
      "Return only compact JSON with should_initiate, initiate_probability, kind, target_user_id, source, anchor, required_shape, avoid, confidence, reason.",
      "initiate_probability and confidence must be 0..1. avoid must be a short string array.",
    ].filter((part) => part.trim() !== "").join("\n\n");
    const user = [
      `forced_draft: ${input.candidate.forced}`,
      `candidate_kind: ${input.candidate.kind}`,
      `now: ${new Date(input.signals.now).toISOString()}`,
      "",
      "Audience:",
      ambientInitiativeAudienceText(input.guild, input.candidate),
      "",
      "Signals:",
      renderAmbientInitiativeSignals(input.signals),
      "",
      "Pressure:",
      JSON.stringify(input.pressure, null, 2),
      "",
      "Open loops / memory anchors:",
      renderAmbientInitiativeOpenLoops(input.signals.openLoops),
      "",
      "Recent initiatives to avoid repeating:",
      renderAmbientInitiativeRecent(input.signals.recentInitiatives),
      "",
      "Recent channel history:",
      renderAmbientHistory({
        history: input.history,
        timezone: input.guildConfig.timezone,
      }),
    ].join("\n");
    try {
      const result = await completeLlmChat({
        provider,
        apiKey: streamOptions.apiKey,
        model: input.config.evaluator.model,
        systemPrompt: system,
        messages: [{ role: "user", content: user }],
        providerParams,
        onPayload: (payload) => input.requestLog.recordLLMRequest(payload),
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "ambient_initiative_decision",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["should_initiate", "initiate_probability", "kind", "target_user_id", "source", "anchor", "required_shape", "avoid", "confidence", "reason"],
              properties: {
                should_initiate: { type: "boolean" },
                initiate_probability: { type: "number", minimum: 0, maximum: 1 },
                kind: { type: "string", enum: ["self_expression", "targeted_checkin"] },
                target_user_id: { type: ["string", "null"] },
                source: { type: "string" },
                anchor: { type: "string" },
                required_shape: { type: "string" },
                avoid: { type: "array", items: { type: "string" } },
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
      const kind = parsed.kind === "targeted_checkin" ? "targeted_checkin" : "self_expression";
      return {
        should_initiate: parsed.should_initiate === true,
        initiate_probability: typeof parsed.initiate_probability === "number" ? Math.max(0, Math.min(1, parsed.initiate_probability)) : 0,
        kind,
        target_user_id: typeof parsed.target_user_id === "string" && parsed.target_user_id !== "" ? parsed.target_user_id : null,
        source: typeof parsed.source === "string" ? parsed.source : "",
        anchor: typeof parsed.anchor === "string" ? parsed.anchor : "",
        required_shape: typeof parsed.required_shape === "string" ? parsed.required_shape : "",
        avoid: Array.isArray(parsed.avoid) ? parsed.avoid.filter((item): item is string => typeof item === "string") : [],
        confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      };
    } catch (error) {
      input.requestLog.recordLLMError(error);
      log.warn("ambient initiative evaluation failed", {
        kind: input.candidate.kind,
        guildId: input.candidate.guildId,
        channelId: input.candidate.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  function ambientInitiativeDecisionPassed(input: {
    config: AmbientInitiativeConfig;
    candidate: AmbientInitiativeCandidate;
    decision: AmbientInitiativeDecision;
    guild: Guild;
  }): { passed: boolean; explanation: string; probabilityThreshold: number; confidenceThreshold: number } {
    const kindConfig = ambientInitiativeKindConfig(input.config, input.candidate.kind);
    if (!input.decision.should_initiate) {
      return {
        passed: false,
        explanation: "Evaluator explicitly chose silence.",
        probabilityThreshold: kindConfig.probabilityThreshold,
        confidenceThreshold: kindConfig.confidenceThreshold,
      };
    }
    if (input.decision.kind !== input.candidate.kind) {
      return {
        passed: false,
        explanation: `Evaluator returned ${input.decision.kind} for a ${input.candidate.kind} candidate.`,
        probabilityThreshold: kindConfig.probabilityThreshold,
        confidenceThreshold: kindConfig.confidenceThreshold,
      };
    }
    if (input.decision.initiate_probability < kindConfig.probabilityThreshold) {
      return {
        passed: false,
        explanation: `Initiate probability ${input.decision.initiate_probability.toFixed(2)} was below threshold ${kindConfig.probabilityThreshold.toFixed(2)}.`,
        probabilityThreshold: kindConfig.probabilityThreshold,
        confidenceThreshold: kindConfig.confidenceThreshold,
      };
    }
    if (input.candidate.kind === "self_expression" && input.decision.target_user_id !== null) {
      return {
        passed: false,
        explanation: "Self-expression must not target a specific user.",
        probabilityThreshold: kindConfig.probabilityThreshold,
        confidenceThreshold: kindConfig.confidenceThreshold,
      };
    }
    if (input.candidate.kind === "targeted_checkin") {
      if (input.decision.target_user_id === null) {
        return {
          passed: false,
          explanation: "Targeted follow-up must name a target user.",
          probabilityThreshold: kindConfig.probabilityThreshold,
          confidenceThreshold: kindConfig.confidenceThreshold,
        };
      }
      if (!isHumanGuildMember(input.guild, input.decision.target_user_id)) {
        return {
          passed: false,
          explanation: "Targeted follow-up target must be a human guild member.",
          probabilityThreshold: kindConfig.probabilityThreshold,
          confidenceThreshold: kindConfig.confidenceThreshold,
        };
      }
      if (!input.candidate.forced && ambientInitiativeDailyCount({
        guildId: input.candidate.guildId,
        channelId: input.candidate.channelId,
        kind: input.candidate.kind,
        targetUserId: input.decision.target_user_id,
      }) >= input.config.targetedCheckin.maxPerUserPerDay) {
        return {
          passed: false,
          explanation: `Target user already reached daily cap ${input.config.targetedCheckin.maxPerUserPerDay}.`,
          probabilityThreshold: kindConfig.probabilityThreshold,
          confidenceThreshold: kindConfig.confidenceThreshold,
        };
      }
    }
    if (input.decision.confidence < kindConfig.confidenceThreshold) {
      return {
        passed: false,
        explanation: `Confidence ${input.decision.confidence.toFixed(2)} was below threshold ${kindConfig.confidenceThreshold.toFixed(2)}.`,
        probabilityThreshold: kindConfig.probabilityThreshold,
        confidenceThreshold: kindConfig.confidenceThreshold,
      };
    }
    return {
      passed: true,
      explanation: "Evaluator decision cleared kind and confidence thresholds.",
      probabilityThreshold: kindConfig.probabilityThreshold,
      confidenceThreshold: kindConfig.confidenceThreshold,
    };
  }

  function ambientInitiativeGenerationInstruction(
    guild: Guild,
    candidate: AmbientInitiativeCandidate,
    decision: AmbientInitiativeDecision,
  ): string {
    const target = decision.target_user_id !== null ? `target_user_id: ${decision.target_user_id}` : "target_user_id: none";
    return [
      "Ambient Initiative selected this proactive turn.",
      initiativeGenerationPolicyForKind(decision.kind),
      "",
      "Evaluator handoff:",
      `kind: ${decision.kind}`,
      target,
      ambientInitiativeAudienceText(guild, candidate),
      `source: ${decision.source}`,
      `anchor: ${decision.anchor}`,
      `required_shape: ${decision.required_shape}`,
      `avoid: ${decision.avoid.length > 0 ? decision.avoid.join(", ") : "none"}`,
      `reason: ${decision.reason}`,
      "",
      "You may still output <ignore> if the initiative no longer fits. Default visible message delivery is reply=false. Do not write the target bot mention yourself.",
    ].join("\n");
  }

  function selfMemoryConstraintText(guildId: string): string {
    const self = listMemories(db, {
      guildId,
      scope: "self",
      limit: 12,
    });
    if (self.length === 0) return "Self memory constraints: none.";
    return [
      "Self memory constraints, for contradiction avoidance only:",
      ...self.map((memory) => `- [${memory.kind}] ${memory.content}`),
    ].join("\n");
  }

  function initiativeTargetUser(guild: Guild, candidate: AmbientInitiativeCandidate, decision: AmbientInitiativeDecision): {
    id: string;
    username: string;
    displayName?: string;
    globalName?: string;
  } {
    if (candidate.targetBotId !== undefined) return promptLabUserFromGuild(guild, candidate.targetBotId);
    if (decision.target_user_id !== null) return promptLabUserFromGuild(guild, decision.target_user_id);
    return {
      id: "ambient-initiative",
      username: "ambient-initiative",
    };
  }

  async function runAmbientInitiativeGeneration(input: {
    guild: Guild;
    channel: SendableGuildChannel;
    guildConfig: GuildConfig;
    config: AmbientInitiativeConfig;
    candidate: AmbientInitiativeCandidate;
    decision: AmbientInitiativeDecision;
    requestLog: RequestLog;
    draft?: {
      drafts: PromptLabDraftMessage[];
      dryRuns: PromptLabDryRun[];
    };
  }): Promise<{ responseText?: string; sent: boolean; ignored: boolean }> {
    const botUserId = client.user?.id ?? "";
    const botUsername = client.user?.username ?? "bot";
    const now = Date.now();
    const syntheticContent = [
      ambientInitiativeGenerationInstruction(input.guild, input.candidate, input.decision),
      "",
      selfMemoryConstraintText(input.candidate.guildId),
    ].filter((part) => part !== "").join("\n");
    const actor = initiativeTargetUser(input.guild, input.candidate, input.decision);
    const actorIsBot = input.candidate.targetBotId !== undefined;
    const syntheticLatestMessage: HistoryMessage = {
      id: input.candidate.id,
      author: actor.username,
      authorDisplayName: actor.displayName,
      authorId: actor.id,
      content: syntheticContent,
      isBot: actorIsBot,
      timestamp: now,
      replyToId: null,
      hasEmbeds: false,
      isSynthetic: true,
      relatedThreadId: null,
    };

    const replyFallbackDeps = createSyntheticReplyFallbackDeps({
      db,
      guildId: input.candidate.guildId,
      channelId: input.candidate.channelId,
    });
    const context = await buildContext(
      input.candidate.guildId,
      input.candidate.channelId,
      input.guild,
      input.guildConfig,
      syntheticContent,
      syntheticLatestMessage,
      replyFallbackDeps,
      input.channel.isThread(),
      { timestamp: now, messageId: input.candidate.id },
      "virtual",
    );

    const generatedImages = createGeneratedImageRuntime();
    const writeState: { used: boolean; firstToolName?: string } = { used: false };
    const markWriteToolStarted = (toolName: string): void => {
      writeState.used = true;
      writeState.firstToolName ??= toolName;
    };
    const baseTools = trackWriteToolStarts(buildAgentTools(
      input.candidate.guildId,
      input.candidate.channelId,
      input.guildConfig,
      input.guild,
      context.contextMessageIds ?? [],
      generatedImages.onGeneratedImage,
      {
        requesterId: actor.id,
        requesterUsername: actor.username,
        sourceMessageId: input.candidate.id,
        sourceQuote: shortQuote(syntheticContent),
      },
    ), markWriteToolStarted);
    const tools = input.draft !== undefined ? promptLabDryRunTools(baseTools, input.draft.dryRuns) : baseTools;

    const resolveTargetChannel = createTargetChannelResolver(client, input.channel);
    const baseSender = createBotDiscordMessageSender({
      defaultChannel: input.channel,
      resolveTargetChannel,
      botUserId,
      botUsername,
      logger: log.child({ component: "ambient-initiative-send", guildId: input.candidate.guildId, channelId: input.candidate.channelId }),
    });
    const targetBotId = input.candidate.targetBotId;
    let targetMentionPending = targetBotId !== undefined;
    const draftSender: MessageSender = async (text, reply, destinationChannelId, voice, _signal, replyToMessageId, attachments) => {
      const shouldMention = targetMentionPending && targetBotId !== undefined;
      const visibleText = shouldMention
        ? ensureAmbientInitiativeBotMention(text, targetBotId)
        : text;
      if (input.draft === undefined) {
        const result = await baseSender(visibleText, reply, destinationChannelId, voice, _signal, replyToMessageId, attachments);
        if (shouldMention) targetMentionPending = false;
        return result;
      }
      const id = promptLabSyntheticId(input.draft.drafts.length + 1);
      input.draft.drafts.push({
        id,
        text: visibleText,
        reply,
        ...(destinationChannelId !== undefined ? { channelId: destinationChannelId } : {}),
        ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
        attachments: attachments?.map((attachment) => attachment.filename) ?? [],
        voice: voice !== undefined,
      });
      if (shouldMention) targetMentionPending = false;
      return { sentMessageId: id };
    };

    const preSendCheck = (): boolean => {
      const signals = buildAmbientInitiativeSignals(input.guild, input.candidate.channelId, input.guildConfig, input.config);
      const gate = ambientInitiativeHardGate({
        guildId: input.candidate.guildId,
        channelId: input.candidate.channelId,
        kind: input.candidate.kind,
        config: input.config,
        signals,
        forced: input.candidate.forced,
        phase: "pre_send",
      });
      if (writeState.used) {
        recordAmbientRuntimeAction(
          input.requestLog,
          `ambient-initiative-pre-send:${input.candidate.id}:committed`,
          "ambient_initiative_pre_send_gate",
          { kind: input.candidate.kind, mode: input.candidate.mode, firstWriteToolName: writeState.firstToolName },
          gate.ok
            ? { status: "passed", summary: "Pre-send gates passed after write tool." }
            : { status: "selected", reason: gate.reason, decidingParameter: "write_tool_committed", summary: `Pre-send gate bypassed after write tool: ${gate.reason}.` },
        );
        return true;
      }
      recordAmbientRuntimeAction(
        input.requestLog,
        `ambient-initiative-pre-send:${input.candidate.id}`,
        "ambient_initiative_pre_send_gate",
        { kind: input.candidate.kind, mode: input.candidate.mode },
        gate.ok
          ? { status: "passed", summary: "Pre-send gates passed." }
          : { status: "dropped", reason: gate.reason, decidingParameter: `hard_gate.${gate.reason.replaceAll(" ", "_")}` },
      );
      return gate.ok;
    };

    const result = await handleMessage(
      {
        content: syntheticContent,
        guildId: input.candidate.guildId,
        guildName: input.guild.name,
        channelId: input.candidate.channelId,
        channelName: channelDisplayName(input.channel),
        authorId: actor.id,
        authorUsername: actor.username,
        authorDisplayName: actor.displayName,
        authorGlobalName: actor.globalName,
        authorIsBot: actorIsBot,
        botUserId,
        mentionedUserIds: [],
        translatedContent: syntheticContent,
        messageId: input.candidate.id,
      },
      createHandlerDeps({
        guildConfig: input.guildConfig,
        context,
        currentChannelId: input.candidate.channelId,
        sender: draftSender,
        extraTools: tools,
        log: log.child({ guildId: input.candidate.guildId, channelId: input.candidate.channelId, requestId: input.requestLog.requestId, component: "ambient-initiative" }),
        requestLog: input.requestLog,
        generatedImages,
        resolveAssetAttachments: createStoredAssetAttachmentResolver({
          db,
          guildId: input.candidate.guildId,
          maxDownloadBytes: input.guildConfig.assetReading?.maxDownloadBytes ?? DEFAULT_ASSET_READING.maxDownloadBytes,
          resolveSource: createDiscordAssetSourceResolver({
            fetchMessage: async (channelId, messageId) => {
              const channel = await fetchAccessibleGuildChannel(channelId);
              if (channel === null) return null;
              try { return await channel.messages.fetch(messageId); } catch { return null; }
            },
          }),
          logger: log.child({ component: "stored-asset-attachments", guildId: input.candidate.guildId, channelId: input.candidate.channelId, requestId: input.requestLog.requestId }),
        }),
        overrides: {
          triggerOverride: { reason: "ambient_initiative" },
          triggerInstructions: {
            ...input.guildConfig.triggerInstructions,
            ambient_initiative: ambientInitiativeGenerationInstruction(input.guild, input.candidate, input.decision),
          },
          liveMessageTypingHoldMs: 0,
          disableLiveOutput: true,
          replyFirstOverride: false,
          preSendCheck,
        },
      }),
    );

    return {
      ...(result.responseText !== undefined ? { responseText: result.responseText } : {}),
      sent: result.responseText !== undefined && result.responseText !== "",
      ignored: result.responseText === undefined || result.responseText === "",
    };
  }

  async function runAmbientInitiativeCandidate(input: {
    guild: Guild;
    channel: SendableGuildChannel;
    candidate: AmbientInitiativeCandidate;
    draft?: {
      drafts: PromptLabDraftMessage[];
      dryRuns: PromptLabDryRun[];
    };
  }): Promise<{ requestId: string; drafts?: PromptLabDraftMessage[]; responseText?: string; sent: boolean; ignored: boolean; error?: string }> {
    const guildConfig = getGuildConfig(input.candidate.guildId);
    const config = guildConfig.ambientInitiative;
    if (config === undefined) throw new Error("Ambient initiative is not configured for this guild.");
    const lockKey = ambientInitiativeLockKey(input.candidate.guildId, input.candidate.channelId);
    const requestLog = createAmbientInitiativeRequestLog({
      guild: input.guild,
      channel: input.channel,
      candidate: input.candidate,
      status: "evaluating",
    });
    requestLogStore.incrementActive();
    if (ambientInitiativeRunning.has(lockKey)) {
      recordAmbientRuntimeAction(
        requestLog,
        `ambient-initiative-lock:${input.candidate.id}`,
        "ambient_initiative_lock",
        { kind: input.candidate.kind, mode: input.candidate.mode },
        { status: "dropped", reason: "initiative already running", decidingParameter: "lock.initiative_already_running" },
      );
      requestLog.emit(log);
      requestLogStore.decrementActive();
      return { requestId: requestLog.requestId, drafts: input.draft?.drafts, sent: false, ignored: true };
    }
    ambientInitiativeRunning.add(lockKey);
    let sent = false;
    let ignored = false;
    let responseText: string | undefined;

    try {
      const signals = buildAmbientInitiativeSignals(input.guild, input.candidate.channelId, guildConfig, config);
      const gate = ambientInitiativeHardGate({
        guildId: input.candidate.guildId,
        channelId: input.candidate.channelId,
        kind: input.candidate.kind,
        config,
        signals,
        forced: input.candidate.forced,
        phase: "opportunity",
      });
      recordAmbientRuntimeAction(
        requestLog,
        `ambient-initiative-hard-gate:${input.candidate.id}`,
        "ambient_initiative_hard_gate",
        { kind: input.candidate.kind, mode: input.candidate.mode, forced: input.candidate.forced },
        gate.ok
          ? { status: "passed", signals, summary: "Hard gates passed." }
          : { status: "dropped", reason: gate.reason, signals, decidingParameter: `hard_gate.${gate.reason.replaceAll(" ", "_")}` },
      );
      if (!gate.ok) {
        ignored = true;
        return { requestId: requestLog.requestId, drafts: input.draft?.drafts, sent, ignored };
      }

      const pressure = input.candidate.forced
        ? {
            kind: input.candidate.kind,
            pressure: 1,
            threshold: 0,
            roll: 0,
            passed: true,
            inputs: { forced: true },
          } satisfies AmbientInitiativePressure
        : ambientInitiativePressureForKind(config, input.candidate.kind, signals, input.candidate.targetBotId !== undefined);
      recordAmbientRuntimeAction(
        requestLog,
        `ambient-initiative-pressure:${input.candidate.id}`,
        "ambient_initiative_pressure",
        { kind: input.candidate.kind },
        {
          status: pressure.passed ? "passed" : "dropped",
          ...pressure,
          decidingParameter: pressure.passed ? "pressure.passed" : "pressure.roll_or_threshold",
        },
      );
      if (!pressure.passed) {
        ignored = true;
        return { requestId: requestLog.requestId, drafts: input.draft?.drafts, sent, ignored };
      }

      const history = getHistoryMessages(db, input.candidate.channelId, config.historyLimit);
      const decision = input.candidate.forceDecision
        ? forcedAmbientInitiativeDecision(input.candidate.kind, signals, history)
        : await evaluateAmbientInitiativeCandidate({
            guild: input.guild,
            config,
            guildConfig,
            candidate: input.candidate,
            signals,
            pressure,
            history,
            requestLog,
          });
      if (decision === null) {
        recordAmbientRuntimeAction(
          requestLog,
          `ambient-initiative-decision:${input.candidate.id}`,
          "ambient_initiative_decision",
          { kind: input.candidate.kind },
          input.candidate.forceDecision
            ? { status: "dropped", decidingParameter: "force.no_target", summary: "Forced targeted draft had no target user." }
            : { status: "dropped", decidingParameter: "evaluator_error", summary: "Evaluator did not return a usable decision." },
          true,
        );
        ignored = true;
        return { requestId: requestLog.requestId, drafts: input.draft?.drafts, sent, ignored };
      }

      const verdict = ambientInitiativeDecisionPassed({ config, candidate: input.candidate, decision, guild: input.guild });
      recordAmbientRuntimeAction(
        requestLog,
        `ambient-initiative-decision:${input.candidate.id}`,
        "ambient_initiative_decision",
        {
          kind: input.candidate.kind,
          decision,
          thresholds: {
            confidence: verdict.confidenceThreshold,
            probability: verdict.probabilityThreshold,
          },
        },
        {
          status: verdict.passed ? "selected" : "dropped",
          explanation: verdict.explanation,
          shouldInitiate: decision.should_initiate,
          confidence: decision.confidence,
          initiateProbability: decision.initiate_probability,
          probabilityThreshold: verdict.probabilityThreshold,
          confidenceThreshold: verdict.confidenceThreshold,
          reason: decision.reason,
          source: decision.source,
          anchor: decision.anchor,
          requiredShape: decision.required_shape,
          avoid: decision.avoid,
        },
      );
      if (!verdict.passed) {
        ignored = true;
        return { requestId: requestLog.requestId, drafts: input.draft?.drafts, sent, ignored };
      }

      const generation = await runAmbientInitiativeGeneration({
        guild: input.guild,
        channel: input.channel,
        guildConfig,
        config,
        candidate: input.candidate,
        decision,
        requestLog,
        draft: input.draft,
      });
      const producedVisibleDraftOrMessage = generation.sent && (input.draft === undefined || input.draft.drafts.length > 0);
      sent = producedVisibleDraftOrMessage && input.candidate.mode === "automatic";
      ignored = generation.ignored || !producedVisibleDraftOrMessage;
      responseText = generation.responseText;
      if (producedVisibleDraftOrMessage) {
        if (sent) {
          ambientInitiativeLastByKind.set(ambientInitiativeKindKey(input.candidate.kind, input.candidate.guildId, input.candidate.channelId), Date.now());
        }
        recordAmbientInitiativeEvent({
          id: input.candidate.id,
          guildId: input.candidate.guildId,
          channelId: input.candidate.channelId,
          kind: input.candidate.kind,
          targetUserId: input.candidate.targetBotId ?? decision.target_user_id,
          summary: decision.reason,
          text: responseText ?? "",
          sent,
          ignored,
          createdAt: Date.now(),
        });
      } else {
        recordAmbientInitiativeEvent({
          id: input.candidate.id,
          guildId: input.candidate.guildId,
          channelId: input.candidate.channelId,
          kind: input.candidate.kind,
          targetUserId: input.candidate.targetBotId ?? decision.target_user_id,
          summary: decision.reason,
          text: responseText ?? "",
          sent: false,
          ignored: true,
          createdAt: Date.now(),
        });
      }
      return { requestId: requestLog.requestId, drafts: input.draft?.drafts, responseText, sent, ignored };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      requestLog.setError(message);
      return { requestId: requestLog.requestId, drafts: input.draft?.drafts, sent, ignored: true, error: message };
    } finally {
      ambientInitiativeRunning.delete(lockKey);
      requestLog.emit(log);
      requestLogStore.decrementActive();
    }
  }

  async function runAmbientInitiativeOpportunity(guildId: string, forcedKind?: AmbientInitiativeKind, mode: AmbientInitiativeRunMode = "automatic", runToken?: string): Promise<{ requestId?: string; error?: string }> {
    const guild = await resolveClientGuild(guildId);
    if (guild === null) return { error: "Guild is unavailable." };
    const guildConfig = getGuildConfig(guildId);
    const config = guildConfig.ambientInitiative;
    if (config === undefined || (!config.enabled && mode !== "draft")) return { error: "Ambient initiative is disabled." };
    const channel = resolveAmbientInitiativeMainChannel(guild, config);
    if (channel === null) return { error: "No ambient initiative main channel is available." };
    if (config.audience === "bots" && forcedKind === "targeted_checkin") {
      return { error: "Bot-audience ambient initiative supports self-expression only." };
    }
    const availableBotTargetId = await selectAmbientInitiativeBotTarget(guild, config);
    if (config.audience === "bots" && availableBotTargetId === null) {
      return { error: "No configured ambient initiative bot target is available in the guild." };
    }
    const signals = buildAmbientInitiativeSignals(guild, channel.id, guildConfig, config);
    const botDirected = availableBotTargetId !== null
      && (config.audience === "bots" || (
        forcedKind !== "targeted_checkin"
        && config.selfExpression.enabled
        && ambientInitiativePressureForKind(config, "self_expression", signals, true).passed
      ));
    const targetBotId = botDirected ? availableBotTargetId : null;
    const candidateKinds: AmbientInitiativeKind[] = config.audience === "bots"
      ? ["self_expression"]
      : ["self_expression", "targeted_checkin"];
    const eligibleKinds = candidateKinds
      .filter((candidateKind) => ambientInitiativeKindConfig(config, candidateKind).enabled);
    const kind = botDirected ? "self_expression" : forcedKind ?? eligibleKinds
      .map((candidateKind) => ambientInitiativePressureForKind(config, candidateKind, signals))
      .sort((a, b) => b.pressure - a.pressure)[0]?.kind ?? "self_expression";
    const runMode: AmbientInitiativeRunMode = mode === "automatic" && config.shadowMode ? "shadow" : mode;
    const draft = runMode === "shadow" ? { drafts: [] as PromptLabDraftMessage[], dryRuns: [] as PromptLabDryRun[] } : undefined;
    const candidate: AmbientInitiativeCandidate = {
      id: `ambient-initiative:${crypto.randomUUID()}`,
      guildId,
      channelId: channel.id,
      kind,
      createdAt: Date.now(),
      mode: runMode,
      forced: runMode === "draft",
      forceDecision: false,
      ...(targetBotId !== null ? { targetBotId } : {}),
      ...(runToken !== undefined ? { runToken } : {}),
    };
    const result = await runAmbientInitiativeCandidate({ guild, channel, candidate, ...(draft !== undefined ? { draft } : {}) });
    return { requestId: result.requestId, ...(result.error !== undefined ? { error: result.error } : {}) };
  }

  function scheduleAmbientInitiativeGuild(guildId: string): void {
    const guildConfig = getGuildConfig(guildId);
    const config = guildConfig.ambientInitiative;
    if (config === undefined || !config.enabled) return;
    const existing = ambientInitiativeTimers.get(guildId);
    if (existing !== undefined) clearTimeout(existing);
    const delayMs = randomBetween(config.checkIntervalMinMs, config.checkIntervalMaxMs);
    const timer = setTimeout(() => {
      ambientInitiativeTimers.delete(guildId);
      void runAmbientInitiativeOpportunity(guildId).finally(() => scheduleAmbientInitiativeGuild(guildId));
    }, delayMs);
    timer.unref();
    ambientInitiativeTimers.set(guildId, timer);
  }

  function startAmbientInitiativeLoops(): void {
    for (const guild of client.guilds.cache.values()) {
      scheduleAmbientInitiativeGuild(guild.id);
    }
  }

  async function runPromptLabAmbientInitiative(input: {
    guildId: string;
    channelId: string;
    kind: AmbientInitiativeKind;
    force?: boolean;
    runToken?: string;
  }): Promise<PromptLabRunResult> {
    const guild = await resolveClientGuild(input.guildId);
    if (guild === null) throw new Error("Guild is unavailable.");
    const channel = await fetchAccessibleGuildChannel(input.channelId);
    if (channel === null || channel.guildId !== input.guildId) {
      throw new Error("Channel is unavailable or does not belong to the selected guild.");
    }
    const guildConfig = getGuildConfig(input.guildId);
    const config = guildConfig.ambientInitiative;
    if (config === undefined) throw new Error("Ambient initiative is not configured for this guild.");
    if (config.audience === "bots" && input.kind === "targeted_checkin") {
      throw new Error("Bot-audience ambient initiative supports self-expression only.");
    }
    const availableBotTargetId = await selectAmbientInitiativeBotTarget(guild, config);
    if (config.audience === "bots" && availableBotTargetId === null) {
      throw new Error("No configured ambient initiative bot target is available in the guild.");
    }
    const signals = buildAmbientInitiativeSignals(guild, input.channelId, guildConfig, config);
    const botDirected = availableBotTargetId !== null
      && input.kind === "self_expression"
      && (config.audience === "bots" || ambientInitiativePressureForKind(config, "self_expression", signals, true).passed);
    const targetBotId = botDirected ? availableBotTargetId : null;
    const drafts: PromptLabDraftMessage[] = [];
    const dryRuns: PromptLabDryRun[] = [];
    const candidate: AmbientInitiativeCandidate = {
      id: `prompt-lab:ambient-initiative:${crypto.randomUUID()}`,
      guildId: input.guildId,
      channelId: input.channelId,
      kind: input.kind,
      createdAt: Date.now(),
      mode: "draft",
      forced: true,
      forceDecision: input.force === true,
      ...(targetBotId !== null ? { targetBotId } : {}),
      ...(input.runToken !== undefined ? { runToken: input.runToken } : {}),
    };
    const result = await runAmbientInitiativeCandidate({
      guild,
      channel,
      candidate,
      draft: { drafts, dryRuns },
    });
    const entry = requestLogStore.getByRequestId(result.requestId);
    const summary = entry !== null
      ? promptLabSummary(entry)
      : { toolCount: 0, llmCallCount: 0, estimatedCostUsd: null, totalDurationMs: 0 };
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

  async function runAmbientCandidate(candidate: AmbientCandidate): Promise<void> {
    const guildConfig = getGuildConfig(candidate.guildId);
    const config = guildConfig.ambientAttention;
    if (config === undefined) return;
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
        defaultReply: decision.default_reply ?? candidate.defaultReply,
      },
    );
    emitAmbientRequestLog(requestLog);
    if (!verdict.passed) {
      clearPendingForCandidate(candidate);
      return;
    }

    candidate.defaultReply = decision.default_reply ?? candidate.defaultReply;
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
          defaultReply: candidate.defaultReply,
          triggerInstruction: ambientTriggerInstruction(candidate.kind, decision),
          currentTurnOverride: candidate.syntheticContent !== undefined && candidate.syntheticTimestamp !== undefined
            ? {
                messageId: candidate.triggerMessageId,
                timestamp: candidate.syntheticTimestamp,
                content: candidate.syntheticContent,
              }
            : undefined,
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
    reschedulePendingBurstForTyping("ambient_pickup", typing.guild.id, typing.channel.id, typing.user.id, config);
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
      defaultReply: config.followUp.defaultReply,
      syntheticContent: "Conversation is quiet after your previous reply. Decide whether one small follow-up is natural now.",
      syntheticTimestamp: botMessageCreatedAt,
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
