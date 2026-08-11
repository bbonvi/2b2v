import {
  DEFAULT_AGENT_JOBS,
  DEFAULT_INNER_THREADS,
  DEFAULT_MEMORY_EXTRACTION,
  DEFAULT_NOTEBOOKS,
  DEFAULT_RELATIONSHIPS,
  DEFAULT_REPLY_LOOP,
  DEFAULT_REPERTOIRE,
  DEFAULT_SEMANTIC_MAINTENANCE,
} from "./defaults.ts";
import type {
  AgentJobsConfig,
  GuildConfigYaml,
  InnerThreadsConfig,
  InnerThreadsConfigYaml,
  MainConfigYaml,
  MemoryContextConfig,
  MemoryExtractionConfig,
  NotebooksConfig,
  NotebooksConfigYaml,
  RelationshipConfig,
  RelationshipConfigYaml,
  RepertoireConfig,
  ReplyLoopConfig,
  SchedulePressureConfig,
  SchedulePressureConfigYaml,
  TypingSimulationConfig,
  SemanticMaintenanceConfig,
  SemanticMaintenanceConfigYaml,
} from "./types.ts";
import { relativeDurationToMilliseconds } from "../time/relative-duration.ts";
import { parseDurationMs } from "../modes/duration.ts";

export function resolveGlobalReplyLoop(
  partial: MainConfigYaml["replyLoop"] | undefined
): ReplyLoopConfig {
  const resolved = {
    maxToolCalls: partial?.maxToolCalls ?? DEFAULT_REPLY_LOOP.maxToolCalls,
    wallClockTimeoutMs: partial?.wallClockTimeoutMs ?? DEFAULT_REPLY_LOOP.wallClockTimeoutMs,
    llmOutputTimeoutMs: partial?.llmOutputTimeoutMs ?? DEFAULT_REPLY_LOOP.llmOutputTimeoutMs,
  };
  validateReplyLoopConfig(resolved, "replyLoop");
  return resolved;
}

export function resolveGuildReplyLoop(
  global: ReplyLoopConfig,
  partial: GuildConfigYaml["replyLoop"] | undefined
): ReplyLoopConfig {
  const resolved = {
    maxToolCalls: partial?.maxToolCalls ?? global.maxToolCalls,
    wallClockTimeoutMs: partial?.wallClockTimeoutMs ?? global.wallClockTimeoutMs,
    llmOutputTimeoutMs: partial?.llmOutputTimeoutMs ?? global.llmOutputTimeoutMs,
  };
  validateReplyLoopConfig(resolved, "replyLoop");
  return resolved;
}

function validateReplyLoopConfig(config: ReplyLoopConfig, keyPrefix: string): void {
  if (!Number.isFinite(config.maxToolCalls) || config.maxToolCalls < 1) {
    throw new Error(`${keyPrefix}.maxToolCalls must be >= 1`);
  }
  if (!Number.isFinite(config.wallClockTimeoutMs) || config.wallClockTimeoutMs < 1000) {
    throw new Error(`${keyPrefix}.wallClockTimeoutMs must be >= 1000`);
  }
  if (!Number.isFinite(config.llmOutputTimeoutMs) || config.llmOutputTimeoutMs < 1000) {
    throw new Error(`${keyPrefix}.llmOutputTimeoutMs must be >= 1000`);
  }
}

export function resolveGlobalMemoryExtraction(
  partial: MainConfigYaml["memoryExtraction"] | undefined,
): MemoryExtractionConfig {
  const resolved = {
    modelProfile: partial?.modelProfile ?? DEFAULT_MEMORY_EXTRACTION.modelProfile,
    postReply: partial?.postReply ?? DEFAULT_MEMORY_EXTRACTION.postReply,
    maxToolCalls: partial?.maxToolCalls ?? DEFAULT_MEMORY_EXTRACTION.maxToolCalls,
    ambient: {
      enabled: partial?.ambient?.enabled ?? DEFAULT_MEMORY_EXTRACTION.ambient.enabled,
      everyMessages: partial?.ambient?.everyMessages ?? DEFAULT_MEMORY_EXTRACTION.ambient.everyMessages,
      maxBatchMessages: partial?.ambient?.maxBatchMessages ?? DEFAULT_MEMORY_EXTRACTION.ambient.maxBatchMessages,
      minIntervalSeconds: partial?.ambient?.minIntervalSeconds ?? DEFAULT_MEMORY_EXTRACTION.ambient.minIntervalSeconds,
    },
  };
  validateMemoryExtractionConfig(resolved, "memoryExtraction");
  return resolved;
}

export function resolveGuildMemoryExtraction(
  global: MemoryExtractionConfig,
  partial: GuildConfigYaml["memoryExtraction"] | undefined,
): MemoryExtractionConfig {
  const resolved = {
    modelProfile: partial?.modelProfile ?? global.modelProfile,
    postReply: partial?.postReply ?? global.postReply,
    maxToolCalls: partial?.maxToolCalls ?? global.maxToolCalls,
    ambient: {
      enabled: partial?.ambient?.enabled ?? global.ambient.enabled,
      everyMessages: partial?.ambient?.everyMessages ?? global.ambient.everyMessages,
      maxBatchMessages: partial?.ambient?.maxBatchMessages ?? global.ambient.maxBatchMessages,
      minIntervalSeconds: partial?.ambient?.minIntervalSeconds ?? global.ambient.minIntervalSeconds,
    },
  };
  validateMemoryExtractionConfig(resolved, "memoryExtraction");
  return resolved;
}

function validateMemoryExtractionConfig(config: MemoryExtractionConfig, keyPrefix: string): void {
  if (config.modelProfile.trim() === "") {
    throw new Error(`${keyPrefix}.modelProfile must not be empty`);
  }
  if (!Number.isInteger(config.maxToolCalls) || config.maxToolCalls < 1) {
    throw new Error(`${keyPrefix}.maxToolCalls must be >= 1`);
  }
  if (!Number.isInteger(config.ambient.everyMessages) || config.ambient.everyMessages < 1) {
    throw new Error(`${keyPrefix}.ambient.everyMessages must be >= 1`);
  }
  if (!Number.isInteger(config.ambient.maxBatchMessages) || config.ambient.maxBatchMessages < 1) {
    throw new Error(`${keyPrefix}.ambient.maxBatchMessages must be >= 1`);
  }
  if (!Number.isFinite(config.ambient.minIntervalSeconds) || config.ambient.minIntervalSeconds < 0) {
    throw new Error(`${keyPrefix}.ambient.minIntervalSeconds must be >= 0`);
  }
}

/** Resolve profile defaults or a per-guild semantic-maintenance override. */
export function resolveSemanticMaintenanceConfig(
  base: SemanticMaintenanceConfig | undefined,
  partial: SemanticMaintenanceConfigYaml | undefined,
): SemanticMaintenanceConfig {
  const fallback = base ?? DEFAULT_SEMANTIC_MAINTENANCE;
  const resolved: SemanticMaintenanceConfig = {
    burst: {
      enabled: partial?.burst?.enabled ?? fallback.burst.enabled,
      modelProfile: partial?.burst?.modelProfile ?? fallback.burst.modelProfile,
      quietAfterMs: partial?.burst?.quietAfter === undefined
        ? fallback.burst.quietAfterMs
        : parseDurationMs(partial.burst.quietAfter, "semanticMaintenance.burst.quietAfter"),
      maxWaitMs: partial?.burst?.maxWait === undefined
        ? fallback.burst.maxWaitMs
        : parseDurationMs(partial.burst.maxWait, "semanticMaintenance.burst.maxWait"),
      memoryMaxRows: partial?.burst?.memoryMaxRows ?? fallback.burst.memoryMaxRows,
      memoryMaxChars: partial?.burst?.memoryMaxChars ?? fallback.burst.memoryMaxChars,
    },
    sweep: {
      enabled: partial?.sweep?.enabled ?? fallback.sweep.enabled,
      modelProfile: partial?.sweep?.modelProfile ?? fallback.sweep.modelProfile,
      everyMs: partial?.sweep?.every === undefined
        ? fallback.sweep.everyMs
        : parseDurationMs(partial.sweep.every, "semanticMaintenance.sweep.every"),
      memories: { ...fallback.sweep.memories, ...partial?.sweep?.memories },
      relationships: { ...fallback.sweep.relationships, ...partial?.sweep?.relationships },
      innerThreads: { ...fallback.sweep.innerThreads, ...partial?.sweep?.innerThreads },
    },
  };
  if (resolved.burst.maxWaitMs < resolved.burst.quietAfterMs) {
    throw new Error("semanticMaintenance.burst.maxWait must be at least quietAfter");
  }
  const positiveInteger = (value: number, field: string): void => {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  };
  positiveInteger(resolved.burst.memoryMaxRows, "semanticMaintenance.burst.memoryMaxRows");
  positiveInteger(resolved.burst.memoryMaxChars, "semanticMaintenance.burst.memoryMaxChars");
  positiveInteger(resolved.sweep.memories.maxRows, "semanticMaintenance.sweep.memories.maxRows");
  positiveInteger(resolved.sweep.memories.maxChars, "semanticMaintenance.sweep.memories.maxChars");
  positiveInteger(resolved.sweep.relationships.maxProfiles, "semanticMaintenance.sweep.relationships.maxProfiles");
  positiveInteger(resolved.sweep.relationships.maxChars, "semanticMaintenance.sweep.relationships.maxChars");
  positiveInteger(resolved.sweep.innerThreads.maxRows, "semanticMaintenance.sweep.innerThreads.maxRows");
  positiveInteger(resolved.sweep.innerThreads.maxChars, "semanticMaintenance.sweep.innerThreads.maxChars");
  for (const [profile, field] of [
    [resolved.burst.modelProfile, "semanticMaintenance.burst.modelProfile"],
    [resolved.sweep.modelProfile, "semanticMaintenance.sweep.modelProfile"],
  ] as const) {
    if (profile.trim() === "") throw new Error(`${field} must not be empty`);
  }
  return resolved;
}

export function resolveMemoryContext(
  base: MemoryContextConfig | undefined,
  partial: Partial<MemoryContextConfig> | undefined,
): MemoryContextConfig {
  const resolved = {
    maxRows: partial?.maxRows ?? base?.maxRows ?? 80,
  };
  if (!Number.isInteger(resolved.maxRows) || resolved.maxRows < 1 || resolved.maxRows > 500) {
    throw new Error("memoryContext.maxRows must be an integer from 1 to 500");
  }
  return resolved;
}

export function resolveRepertoireConfig(partial: MainConfigYaml["repertoire"]): RepertoireConfig {
  const resolved: RepertoireConfig = {
    enabled: partial?.enabled ?? DEFAULT_REPERTOIRE.enabled,
    lookbackHours: partial?.lookbackHours ?? DEFAULT_REPERTOIRE.lookbackHours,
    refreshMinutes: partial?.refreshMinutes ?? DEFAULT_REPERTOIRE.refreshMinutes,
    maxSourceChannels: partial?.maxSourceChannels ?? DEFAULT_REPERTOIRE.maxSourceChannels,
    maxMessages: partial?.maxMessages ?? DEFAULT_REPERTOIRE.maxMessages,
    maxChars: partial?.maxChars ?? DEFAULT_REPERTOIRE.maxChars,
  };
  for (const [key, value] of Object.entries(resolved)) {
    if (key === "enabled") continue;
    if (!Number.isInteger(value) || Number(value) < 1) {
      throw new Error(`repertoire.${key} must be a positive integer`);
    }
  }
  return resolved;
}

export function resolveRelationshipConfig(
  defaults: RelationshipConfig | undefined,
  partial: RelationshipConfigYaml | undefined,
): RelationshipConfig {
  const base = defaults ?? DEFAULT_RELATIONSHIPS;
  const resolved: RelationshipConfig = {
    modelProfile: partial?.modelProfile ?? base.modelProfile,
    enabled: partial?.enabled ?? base.enabled,
    promptInjection: partial?.promptInjection ?? base.promptInjection,
    priorExchanges: {
      enabled: partial?.priorExchanges?.enabled ?? base.priorExchanges.enabled,
      maxExchanges: partial?.priorExchanges?.maxExchanges ?? base.priorExchanges.maxExchanges,
      maxMessageChars: partial?.priorExchanges?.maxMessageChars ?? base.priorExchanges.maxMessageChars,
      refreshMinutes: partial?.priorExchanges?.refreshMinutes ?? base.priorExchanges.refreshMinutes,
    },
    maxAxisDeltaPerSignal: partial?.maxAxisDeltaPerSignal ?? base.maxAxisDeltaPerSignal,
    maxToolCalls: partial?.maxToolCalls ?? base.maxToolCalls,
  };
  if (!Number.isInteger(resolved.priorExchanges.maxExchanges) || resolved.priorExchanges.maxExchanges < 1) {
    throw new Error("relationships.priorExchanges.maxExchanges must be >= 1");
  }
  if (!Number.isInteger(resolved.priorExchanges.maxMessageChars) || resolved.priorExchanges.maxMessageChars < 1) {
    throw new Error("relationships.priorExchanges.maxMessageChars must be >= 1");
  }
  if (!Number.isInteger(resolved.priorExchanges.refreshMinutes) || resolved.priorExchanges.refreshMinutes < 1) {
    throw new Error("relationships.priorExchanges.refreshMinutes must be >= 1");
  }
  if (!Number.isFinite(resolved.maxAxisDeltaPerSignal) || resolved.maxAxisDeltaPerSignal < 0) {
    throw new Error("relationships.maxAxisDeltaPerSignal must be >= 0");
  }
  if (!Number.isInteger(resolved.maxToolCalls) || resolved.maxToolCalls < 1) {
    throw new Error("relationships.maxToolCalls must be >= 1");
  }
  return resolved;
}

export function resolveInnerThreadsConfig(
  defaults: InnerThreadsConfig | undefined,
  partial: InnerThreadsConfigYaml | undefined,
): InnerThreadsConfig {
  const base = defaults ?? DEFAULT_INNER_THREADS;
  return {
    enabled: partial?.enabled ?? base.enabled,
    modelProfile: partial?.modelProfile ?? base.modelProfile,
  };
}

export function resolveNotebooksConfig(
  defaults: NotebooksConfig | undefined,
  partial: NotebooksConfigYaml | undefined,
): NotebooksConfig {
  const base = defaults ?? DEFAULT_NOTEBOOKS;
  const resolved = {
    enabled: partial?.enabled ?? base.enabled,
    maxPromptTitles: partial?.maxPromptTitles ?? base.maxPromptTitles,
    defaultShelfAfterMs: partial?.defaultShelfAfter === undefined
      ? base.defaultShelfAfterMs
      : relativeDurationToMilliseconds(partial.defaultShelfAfter),
  };
  if (!Number.isInteger(resolved.maxPromptTitles) || resolved.maxPromptTitles < 1 || resolved.maxPromptTitles > 100) {
    throw new Error("notebooks.maxPromptTitles must be an integer from 1 to 100");
  }
  return resolved;
}

export function resolveTypingSimulationConfig(
  defaults: TypingSimulationConfig,
  partial: Partial<TypingSimulationConfig> | undefined,
): TypingSimulationConfig {
  return {
    enabled: partial?.enabled ?? defaults.enabled,
    inputReadingWpm: partial?.inputReadingWpm ?? defaults.inputReadingWpm,
    inputMinDelayMs: partial?.inputMinDelayMs ?? defaults.inputMinDelayMs,
    inputMaxDelayMs: partial?.inputMaxDelayMs ?? defaults.inputMaxDelayMs,
    outputTypingWpm: partial?.outputTypingWpm ?? defaults.outputTypingWpm,
    outputMinHoldMs: partial?.outputMinHoldMs ?? defaults.outputMinHoldMs,
    outputMaxHoldMs: partial?.outputMaxHoldMs ?? defaults.outputMaxHoldMs,
  };
}

export function resolveAgentJobs(
  partial: MainConfigYaml["agentJobs"] | undefined,
): AgentJobsConfig {
  const resolved = {
    imageTimeoutMs: partial?.imageTimeoutMs ?? DEFAULT_AGENT_JOBS.imageTimeoutMs,
    imageCancelGraceMs: partial?.imageCancelGraceMs ?? DEFAULT_AGENT_JOBS.imageCancelGraceMs,
    terminalVisibleMs: partial?.terminalVisibleMs ?? DEFAULT_AGENT_JOBS.terminalVisibleMs,
    yieldedAutoDismissMs: partial?.yieldedAutoDismissMs ?? DEFAULT_AGENT_JOBS.yieldedAutoDismissMs,
    maxImageReplacements: partial?.maxImageReplacements ?? DEFAULT_AGENT_JOBS.maxImageReplacements,
    agentTimeoutMs: partial?.agentTimeoutMs ?? DEFAULT_AGENT_JOBS.agentTimeoutMs,
    agentMaxToolCalls: partial?.agentMaxToolCalls !== undefined
      ? partial.agentMaxToolCalls
      : DEFAULT_AGENT_JOBS.agentMaxToolCalls,
    agentCompactionReserveTokens: partial?.agentCompactionReserveTokens ?? DEFAULT_AGENT_JOBS.agentCompactionReserveTokens,
    agentCompactionKeepRecentTokens: partial?.agentCompactionKeepRecentTokens ?? DEFAULT_AGENT_JOBS.agentCompactionKeepRecentTokens,
  };
  validateAgentJobsConfig(resolved, "agentJobs");
  return resolved;
}

function validateAgentJobsConfig(config: AgentJobsConfig, keyPrefix: string): void {
  if (!Number.isFinite(config.imageTimeoutMs) || config.imageTimeoutMs < 10_000) {
    throw new Error(`${keyPrefix}.imageTimeoutMs must be >= 10000`);
  }
  if (!Number.isFinite(config.imageCancelGraceMs) || config.imageCancelGraceMs < 0) {
    throw new Error(`${keyPrefix}.imageCancelGraceMs must be >= 0`);
  }
  if (!Number.isFinite(config.terminalVisibleMs) || config.terminalVisibleMs < 0) {
    throw new Error(`${keyPrefix}.terminalVisibleMs must be >= 0`);
  }
  if (!Number.isFinite(config.yieldedAutoDismissMs) || config.yieldedAutoDismissMs < 0) {
    throw new Error(`${keyPrefix}.yieldedAutoDismissMs must be >= 0`);
  }
  if (!Number.isInteger(config.maxImageReplacements) || config.maxImageReplacements < 0) {
    throw new Error(`${keyPrefix}.maxImageReplacements must be >= 0`);
  }
  if (!Number.isFinite(config.agentTimeoutMs) || config.agentTimeoutMs < 10_000) {
    throw new Error(`${keyPrefix}.agentTimeoutMs must be >= 10000`);
  }
  if (config.agentMaxToolCalls !== null && (!Number.isInteger(config.agentMaxToolCalls) || config.agentMaxToolCalls < 1)) {
    throw new Error(`${keyPrefix}.agentMaxToolCalls must be null or >= 1`);
  }
  if (!Number.isInteger(config.agentCompactionReserveTokens) || config.agentCompactionReserveTokens < 1) {
    throw new Error(`${keyPrefix}.agentCompactionReserveTokens must be >= 1`);
  }
  if (!Number.isInteger(config.agentCompactionKeepRecentTokens) || config.agentCompactionKeepRecentTokens < 1) {
    throw new Error(`${keyPrefix}.agentCompactionKeepRecentTokens must be >= 1`);
  }
}

export function resolveSchedulePressure(
  defaults: SchedulePressureConfig,
  partial: SchedulePressureConfigYaml | undefined,
  keyPrefix: string,
): SchedulePressureConfig {
  const resolved = {
    maxRequesterRunsPerHour: partial?.maxRequesterRunsPerHour ?? defaults.maxRequesterRunsPerHour,
    maxRequesterRunsPerDay: partial?.maxRequesterRunsPerDay ?? defaults.maxRequesterRunsPerDay,
    maxGuildRunsPerHour: partial?.maxGuildRunsPerHour ?? defaults.maxGuildRunsPerHour,
    maxGuildRunsPerDay: partial?.maxGuildRunsPerDay ?? defaults.maxGuildRunsPerDay,
  };
  validateSchedulePressureConfig(resolved, keyPrefix);
  return resolved;
}

function validateSchedulePressureConfig(config: SchedulePressureConfig, keyPrefix: string): void {
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${keyPrefix}.${key} must be a positive integer`);
    }
  }
}
