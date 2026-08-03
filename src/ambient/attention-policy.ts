import type { Client, Message } from "discord.js";
import type { Database } from "../db/database";
import { getChannelHumanActivityBuckets } from "../db/message-activity-repository";
import type {
  AmbientAttentionConfig,
  AmbientAttentionKind,
  AmbientAttentionModeConfig,
  GlobalConfig,
  GuildConfig,
} from "../config/types";
import type { HistoryMessage } from "../agent/history-types";
import { formatAssetMeta, formatHistoryContent } from "../agent/history-formatting";
import { formatLocalWallClock } from "../time/agent-time";
import { contentMentionsEveryone, shouldRespond, type TriggerResult } from "../agent/triggers";
import { buildComputedContactContextForUser } from "../agent/contact-context";
import type { PromptBundle } from "../config/instruction-bundle";
import type { Logger, RequestLog } from "../logger";
import type { RequestLogStore } from "../dashboard/store";
import { RequestLog as RuntimeRequestLog } from "../logger";
import { translateInbound } from "../discord/translation";
import { channelDisplayName } from "../discord/message-sender";
import { buildModelProfileStreamOptions, resolveModelProfile } from "../llm/client";
import { completeLlmChat } from "../llm/chat";
import type { OpenRouterMessage } from "../llm/types";
import { getHistoryMessages } from "../db/message-history-repository";
import { getMessageById } from "../db/message-search-repository";
import { getAssetsByMessageId } from "../db/asset-repository";

const CHANNEL_ACTIVITY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_ACTIVITY_BUCKET_MS = 60_000;
const BUSY_ACTIVITY_RATIO = 0.8;

export type AmbientCandidate = {
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

export type AmbientDecision = {
  should_reply: boolean;
  reply_probability: number;
  confidence: number;
  intent?: string;
  reason: string;
};

export type AmbientDecisionVerdict = {
  passed: boolean;
  probabilityThreshold: number;
  confidenceThreshold: number;
  adjustedProbability: number;
  jitter: number;
  weakLingering: boolean;
  decidingParameter: "should_reply" | "reply_probability" | "confidence" | "passed";
  explanation: string;
};

export type AmbientLeaseView = {
  botMessageId: string;
  strongUntil: number;
  expiresAt: number;
  followUpsSent: number;
};

export function ambientModeConfig(
  config: AmbientAttentionConfig,
  kind: AmbientAttentionKind,
): AmbientAttentionModeConfig {
  if (kind === "ambient_pickup") return config.ambientPickup;
  if (kind === "lingering_attention") return config.lingering;
  return config.followUp;
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
    const assets = formatAssetMeta(message.assets ?? []);
    const assetMeta = assets.length > 0 ? ` (${assets.join("; ")})` : "";
    return `[${formatLocalWallClock(message.timestamp, input.timezone)}] ${who} (${message.authorId})${reply}${marker}${assetMeta}: ${formatHistoryContent(message)}`;
  }).join("\n");
}

/** Treat stored attachments as message content for ambient attention. */
export function hasAmbientTriggerContent(db: Database, messageId: string, content: string): boolean {
  return content.trim() !== "" || getAssetsByMessageId(db, messageId).length > 0;
}

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

export function isAmbientChannelBusy(input: {
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
  return isAmbientChannelBusy(input) ? "busy_group_chat" : "group_chat_not_busy";
}

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

export function createAmbientAttentionPolicy(input: {
  db: Database;
  client: Client;
  log: Logger;
  requestLogStore: RequestLogStore;
  getGlobalConfig: () => GlobalConfig;
  getGuildConfig: (guildId: string) => GuildConfig;
  getPromptBundle: () => PromptBundle;
  buildInboundResolvers: (guild: NonNullable<Message["guild"]>) => Parameters<typeof translateInbound>[1];
  isAutonomousAttentionBusy: (guildId: string, channelId: string) => boolean;
  ambientNormalTriggerInFlight: (guildId: string, channelId: string, userId: string) => boolean;
  ambientBudgetAvailable: (config: AmbientAttentionConfig, candidate: AmbientCandidate, now?: number) => boolean;
  ambientCooldownReady: (candidate: AmbientCandidate, now?: number) => boolean;
  ambientPickupChannelCooldownReady: (candidate: AmbientCandidate, now?: number) => boolean;
  activeTypingInChannel: (guildId: string, channelId: string, activeMs: number, now?: number) => boolean;
  ambientTypingActiveMs: (config: AmbientAttentionConfig, kind: AmbientAttentionKind) => number;
  findAmbientLease: (guildId: string, channelId: string, userId: string) => AmbientLeaseView | undefined;
}) {
  const {
    db,
    client,
    log,
    requestLogStore,
    getGlobalConfig,
    getGuildConfig,
    getPromptBundle,
    buildInboundResolvers,
    isAutonomousAttentionBusy,
    ambientNormalTriggerInFlight,
    ambientBudgetAvailable,
    ambientCooldownReady,
    ambientPickupChannelCooldownReady,
    activeTypingInChannel,
    ambientTypingActiveMs,
    findAmbientLease,
  } = input;
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
    const requestLog = new RuntimeRequestLog(candidate.guildId, candidate.channelId, requestLogStore);
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
    if (!hasAmbientTriggerContent(db, trigger.id, trigger.translatedContent)) return { ok: false, reason: "empty trigger message" };

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
      const lease = findAmbientLease(candidate.guildId, candidate.channelId, candidate.userId);
      if (lease === undefined) return { ok: false, reason: "lingering lease missing" };
      if (lease.expiresAt <= now) return { ok: false, reason: "lingering lease expired" };
      if (newHumanMessages.length > 0) return { ok: false, reason: "newer human message exists" };
    }

    if (candidate.kind === "follow_up") {
      const lease = findAmbientLease(candidate.guildId, candidate.channelId, candidate.userId);
      if (lease === undefined || lease.botMessageId !== candidate.triggerMessageId) return { ok: false, reason: "follow-up lease missing" };
      if (lease.followUpsSent >= config.followUp.maxPerExchange) return { ok: false, reason: "follow-up exchange budget used" };
      const newer = history.filter((message) =>
        message.timestamp > candidate.triggerCreatedAt ||
        (message.timestamp === candidate.triggerCreatedAt && message.id > candidate.triggerMessageId)
      );
      if (newer.length > 0) return { ok: false, reason: "follow-up silence broken" };
      if (now - candidate.triggerCreatedAt < config.followUp.silenceMs) return { ok: false, reason: "follow-up silence too short" };
    } else {
      if (isAmbientChannelBusy({
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
      ? findAmbientLease(candidate.guildId, candidate.channelId, candidate.userId)
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

  return {
    createAmbientRequestLog,
    emitAmbientRequestLog,
    recordAmbientRuntimeAction,
    ambientHardGate,
    evaluateAmbientCandidate,
    ambientDecisionVerdict,
  };
}
