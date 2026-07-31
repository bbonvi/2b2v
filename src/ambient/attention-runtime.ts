import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Client, Guild, Message, Typing } from "discord.js";
import type { Database } from "../db/database";
import type { Logger, RequestLog } from "../logger";
import type { RequestLogStore } from "../dashboard/store";
import type { AmbientAttentionConfig, AmbientAttentionKind, GuildConfig } from "../config/types";
import type { HistoryMessage } from "../agent/history-types";
import type { TriggerResult } from "../agent/triggers";
import type { AssembledContext } from "../agent/context-assembly";
import type { HandlerDeps, MemoryExtractionRequest, MessageSender } from "../agent/turn-types";
import type { AgentJobStore } from "../agent/job-runtime";
import type { PromptBundle } from "../config/instruction-bundle";
import type { GlobalConfig } from "../config/types";
import type { GeneratedImageAttachment } from "../agent/codex-image-tool";
import type { ResolveTargetChannel, SendableGuildChannel } from "../discord/message-sender";
import type { ReplyFallbackDeps } from "../agent/reply-target-fallback";
import type { PromptLabDryRun, PromptLabRunResult } from "../dashboard/prompt-lab-types";
import { translateInbound } from "../discord/translation";
import { getHistoryMessages } from "../db/message-history-repository";
import { getMessageById } from "../db/message-search-repository";
import type { createGeneratedImageRuntime } from "../agent/generated-image-runtime";
import {
  ambientPendingKey,
  ambientModeConfig,
  createAmbientAttentionPolicy,
  shouldDeferAmbientCandidateForTyping,
  type AmbientCandidate,
} from "./attention-policy";

const AMBIENT_TYPING_IDLE_GRACE_MS = 500;

export type AmbientAttentionRuntime = {
  maybeScheduleAmbientAttention: (message: Message, triggerResult: TriggerResult) => void;
  noteAmbientTyping: (typing: Typing) => void;
  markAmbientPickupChannelCooldown: (config: AmbientAttentionConfig | undefined, guildId: string, channelId: string, now?: number) => void;
  clearPendingAmbientKindInChannel: (kind: "ambient_pickup" | "lingering_attention", guildId: string, channelId: string) => void;
  clearAmbientNormalTriggerInFlight: (guildId: string, channelId: string, userId: string) => void;
  clearAmbientTyping: (guildId: string, channelId: string, userId: string) => void;
  clearAmbientLeaseForUser: (guildId: string, channelId: string, userId: string) => void;
  noteAmbientBotReply: (input: { guildId: string; channelId: string; userId: string; sourceMessageId: string; botMessageId: string; message?: Message; allowLease: boolean; allowFollowUp: boolean }) => void;
  clearAmbientAttentionState: () => void;
  pendingAmbientCandidatesInChannel: (guildId: string, channelId: string) => number;
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
      memoryFocusUserId?: string;
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

type AmbientAttentionRuntimeDeps = Pick<
  AmbientRuntimeDeps,
  | "db"
  | "client"
  | "log"
  | "requestLogStore"
  | "getPromptBundle"
  | "getGlobalConfig"
  | "typingIntervalMs"
  | "getGuildConfig"
  | "buildInboundResolvers"
  | "processTriggeredMessage"
  | "trackBackgroundTask"
  | "isAutonomousAttentionBusy"
>;

export function createAmbientAttentionRuntime(input: AmbientAttentionRuntimeDeps): AmbientAttentionRuntime {
  const { db, client, log, requestLogStore } = input;
  const getPromptBundle = input.getPromptBundle;
  const getGlobalConfig = input.getGlobalConfig;
  const TYPING_INTERVAL_MS = input.typingIntervalMs;

  function startTrackedAmbientTask(task: Promise<unknown>, label: string): void {
    const handled = task.catch((error: unknown) => {
      log.error(`${label} failed`, { error: error instanceof Error ? error.message : String(error) });
    });
    input.trackBackgroundTask?.(handled);
    void handled;
  }
  const getGuildConfig = input.getGuildConfig;
  const buildInboundResolvers = input.buildInboundResolvers;
  const processTriggeredMessage = input.processTriggeredMessage;
  const isAutonomousAttentionBusy = input.isAutonomousAttentionBusy ?? (() => false);
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

  const {
    createAmbientRequestLog,
    emitAmbientRequestLog,
    recordAmbientRuntimeAction,
    ambientHardGate,
    evaluateAmbientCandidate,
    ambientDecisionVerdict,
  } = createAmbientAttentionPolicy({
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
    findAmbientLease: (guildId, channelId, userId) =>
      ambientLeases.get(ambientLeaseKey(guildId, channelId, userId)),
  });

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

  function pendingAmbientCandidatesInChannel(guildId: string, channelId: string): number {
    let count = 0;
    for (const pending of ambientPendingCandidates.values()) {
      if (pending.candidate.guildId === guildId && pending.candidate.channelId === channelId) count += 1;
    }
    return count;
  }

  return {
    maybeScheduleAmbientAttention,
    noteAmbientTyping,
    markAmbientPickupChannelCooldown,
    clearPendingAmbientKindInChannel,
    clearAmbientNormalTriggerInFlight,
    clearAmbientTyping,
    clearAmbientLeaseForUser,
    noteAmbientBotReply,
    clearAmbientAttentionState,
    pendingAmbientCandidatesInChannel,
  };
}
