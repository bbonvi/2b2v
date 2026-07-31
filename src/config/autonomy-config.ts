import {
  DEFAULT_AMBIENT_ATTENTION,
  DEFAULT_AMBIENT_INITIATIVE,
  DEFAULT_PRIVATE_LIFE,
} from "./defaults.ts";
import type {
  AmbientAttentionConfig,
  AmbientAttentionConfigYaml,
  AmbientAttentionEvaluatorConfig,
  AmbientAttentionModeConfig,
  AmbientInitiativeConfig,
  AmbientInitiativeConfigYaml,
  AmbientInitiativeEvaluatorConfig,
} from "./types.ts";
import {
  PRIVATE_LIFE_ACTION_SCOPES,
  PRIVATE_LIFE_ATTENTION_ORIGINS,
  PRIVATE_LIFE_CURIOSITY_MODES,
  PRIVATE_LIFE_TERRITORIES,
  type PrivateLifeConfig,
  type PrivateLifeConfigYaml,
} from "../private-life/types.ts";

function clampProbabilityConfig(value: number, key: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${key} must be between 0 and 1`);
  }
}

function resolveAmbientEvaluatorConfig(
  defaults: AmbientAttentionEvaluatorConfig,
  partial: Partial<AmbientAttentionEvaluatorConfig> | undefined,
): AmbientAttentionEvaluatorConfig {
  const resolved = {
    modelProfile: partial?.modelProfile ?? defaults.modelProfile,
    llmOutputTimeoutMs: partial?.llmOutputTimeoutMs ?? defaults.llmOutputTimeoutMs,
  };
  if (!Number.isFinite(resolved.llmOutputTimeoutMs) || resolved.llmOutputTimeoutMs < 1000) {
    throw new Error("ambientAttention.evaluator.llmOutputTimeoutMs must be >= 1000");
  }
  return resolved;
}

function resolveAmbientInitiativeEvaluatorConfig(
  defaults: AmbientInitiativeEvaluatorConfig,
  partial: Partial<AmbientInitiativeEvaluatorConfig> | undefined,
): AmbientInitiativeEvaluatorConfig {
  const resolved: AmbientInitiativeEvaluatorConfig = {
    modelProfile: partial?.modelProfile ?? defaults.modelProfile,
    llmOutputTimeoutMs: partial?.llmOutputTimeoutMs ?? defaults.llmOutputTimeoutMs,
  };
  if (resolved.modelProfile.trim() === "") {
    throw new Error("ambientInitiative.evaluator.modelProfile must not be empty");
  }
  if (!Number.isFinite(resolved.llmOutputTimeoutMs) || resolved.llmOutputTimeoutMs < 1000) {
    throw new Error("ambientInitiative.evaluator.llmOutputTimeoutMs must be >= 1000");
  }
  return resolved;
}

function resolveAmbientModeConfig<T extends AmbientAttentionModeConfig>(
  defaults: T,
  partial: Partial<T> | undefined,
  keyPrefix: string,
): T {
  const resolved = {
    ...defaults,
    ...partial,
  };
  validateAmbientModeConfig(resolved, keyPrefix);
  return resolved;
}

export function resolveAmbientAttentionConfig(
  defaults: AmbientAttentionConfig | undefined,
  partial: AmbientAttentionConfigYaml | undefined,
): AmbientAttentionConfig | undefined {
  const base = defaults ?? DEFAULT_AMBIENT_ATTENTION;
  if (partial === undefined && defaults === undefined) return undefined;
  const resolved: AmbientAttentionConfig = {
    ...base,
    ...partial,
    evaluator: resolveAmbientEvaluatorConfig(base.evaluator, partial?.evaluator),
    ambientPickup: resolveAmbientModeConfig(base.ambientPickup, partial?.ambientPickup, "ambientAttention.ambientPickup"),
    lingering: resolveAmbientModeConfig(base.lingering, partial?.lingering, "ambientAttention.lingering"),
    followUp: resolveAmbientModeConfig(base.followUp, partial?.followUp, "ambientAttention.followUp"),
  };
  validateAmbientAttentionConfig(resolved, "ambientAttention");
  return resolved;
}

function parseAmbientInitiativeBotContactIds(value: unknown, fallback: readonly string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) {
    throw new Error("ambientInitiative.botContactIds must contain non-empty Discord user IDs");
  }
  const contactIds: string[] = [];
  for (const contactId of value as unknown[]) {
    if (typeof contactId !== "string" || contactId.trim() === "") {
      throw new Error("ambientInitiative.botContactIds must contain non-empty Discord user IDs");
    }
    contactIds.push(contactId);
  }
  return contactIds;
}

export function resolveAmbientInitiativeConfig(
  defaults: AmbientInitiativeConfig | undefined,
  partial: AmbientInitiativeConfigYaml | undefined,
): AmbientInitiativeConfig | undefined {
  const base = defaults ?? DEFAULT_AMBIENT_INITIATIVE;
  if (partial === undefined && defaults === undefined) return undefined;
  const resolved: AmbientInitiativeConfig = {
    ...base,
    ...partial,
    botContactIds: parseAmbientInitiativeBotContactIds(partial?.botContactIds, base.botContactIds),
    activeHours: {
      ...base.activeHours,
      ...partial?.activeHours,
    },
    evaluator: resolveAmbientInitiativeEvaluatorConfig(base.evaluator, partial?.evaluator),
  };
  validateAmbientInitiativeConfig(resolved, "ambientInitiative");
  return resolved;
}

function resolvePrivateLifeWeights<T extends string>(
  keys: readonly T[],
  defaults: Record<T, number>,
  partial: Partial<Record<T, number>> | undefined,
  keyPrefix: string,
): Record<T, number> {
  const resolved = { ...defaults };
  for (const key of keys) {
    const value = partial?.[key];
    if (value !== undefined) resolved[key] = value;
  }
  let total = 0;
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`${keyPrefix}.${key} must be a finite number >= 0`);
    }
    total += value;
  }
  if (total <= 0) throw new Error(`${keyPrefix} must contain at least one positive weight`);
  return resolved;
}

export function resolvePrivateLifeConfig(partial: PrivateLifeConfigYaml | undefined): PrivateLifeConfig {
  if (partial !== undefined && ("guildId" in partial || "channelId" in partial)) {
    throw new Error("privateLife.guildId and privateLife.channelId are not supported; location overrides belong to Prompt Lab");
  }
  const resolved: PrivateLifeConfig = {
    ...DEFAULT_PRIVATE_LIFE,
    ...partial,
    maintenance: {
      ...DEFAULT_PRIVATE_LIFE.maintenance,
      ...partial?.maintenance,
    },
    originWeights: resolvePrivateLifeWeights(
      PRIVATE_LIFE_ATTENTION_ORIGINS,
      DEFAULT_PRIVATE_LIFE.originWeights,
      partial?.originWeights,
      "privateLife.originWeights",
    ),
    modeWeights: resolvePrivateLifeWeights(
      PRIVATE_LIFE_CURIOSITY_MODES,
      DEFAULT_PRIVATE_LIFE.modeWeights,
      partial?.modeWeights,
      "privateLife.modeWeights",
    ),
    territoryWeights: resolvePrivateLifeWeights(
      PRIVATE_LIFE_TERRITORIES,
      DEFAULT_PRIVATE_LIFE.territoryWeights,
      partial?.territoryWeights,
      "privateLife.territoryWeights",
    ),
    actionScopeWeights: resolvePrivateLifeWeights(
      PRIVATE_LIFE_ACTION_SCOPES,
      DEFAULT_PRIVATE_LIFE.actionScopeWeights,
      partial?.actionScopeWeights,
      "privateLife.actionScopeWeights",
    ),
  };
  validateClockTime(resolved.lateNightStart, "privateLife.lateNightStart");
  validateClockTime(resolved.sleepStart, "privateLife.sleepStart");
  validateClockTime(resolved.sleepEnd, "privateLife.sleepEnd");
  if (!Number.isFinite(resolved.opportunitiesPerDay) || resolved.opportunitiesPerDay <= 0 || resolved.opportunitiesPerDay > 500) {
    throw new Error("privateLife.opportunitiesPerDay must be > 0 and <= 500");
  }
  if (!Number.isFinite(resolved.intervalJitter) || resolved.intervalJitter < 0 || resolved.intervalJitter > 1) {
    throw new Error("privateLife.intervalJitter must be between 0 and 1");
  }
  for (const key of ["lateNightRateMultiplier", "sleepRateMultiplier"] as const) {
    const value = resolved[key];
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      throw new Error(`privateLife.${key} must be > 0 and <= 1`);
    }
  }
  if (!Number.isInteger(resolved.maxVisiblePerDay) || resolved.maxVisiblePerDay < 0) {
    throw new Error("privateLife.maxVisiblePerDay must be >= 0");
  }
  if (!Number.isFinite(resolved.visibleOutputCooldownMinutes)
    || resolved.visibleOutputCooldownMinutes < 0
    || resolved.visibleOutputCooldownMinutes > 1_440) {
    throw new Error("privateLife.visibleOutputCooldownMinutes must be between 0 and 1440");
  }
  if (!Number.isInteger(resolved.maxToolCalls) || resolved.maxToolCalls < 0) {
    throw new Error("privateLife.maxToolCalls must be >= 0");
  }
  if (!Number.isFinite(resolved.wallClockTimeoutMs) || resolved.wallClockTimeoutMs < 1000) {
    throw new Error("privateLife.wallClockTimeoutMs must be >= 1000");
  }
  if (!Number.isInteger(resolved.recentThemeLimit) || resolved.recentThemeLimit < 1 || resolved.recentThemeLimit > 200) {
    throw new Error("privateLife.recentThemeLimit must be between 1 and 200");
  }
  if (!Number.isInteger(resolved.recentResidueHistoryLimit)
    || resolved.recentResidueHistoryLimit < 1
    || resolved.recentResidueHistoryLimit > 200) {
    throw new Error("privateLife.recentResidueHistoryLimit must be between 1 and 200");
  }
  if (!Number.isFinite(resolved.recentResidueMaxAgeHours)
    || resolved.recentResidueMaxAgeHours <= 0
    || resolved.recentResidueMaxAgeHours > 720) {
    throw new Error("privateLife.recentResidueMaxAgeHours must be > 0 and <= 720");
  }
  if (!Number.isInteger(resolved.candidateCount) || resolved.candidateCount < 2 || resolved.candidateCount > 12) {
    throw new Error("privateLife.candidateCount must be between 2 and 12");
  }
  if (!Number.isInteger(resolved.thoughtRetentionDays) || resolved.thoughtRetentionDays < 0 || resolved.thoughtRetentionDays > 365) {
    throw new Error("privateLife.thoughtRetentionDays must be between 0 and 365");
  }
  if (resolved.modelProfile.trim() === "") throw new Error("privateLife.modelProfile must not be empty");
  if (resolved.maintenance.modelProfile.trim() === "") {
    throw new Error("privateLife.maintenance.modelProfile must not be empty");
  }
  return resolved;
}

function validateAmbientModeConfig(config: AmbientAttentionModeConfig, keyPrefix: string): void {
  if (!Number.isFinite(config.minDelayMs) || config.minDelayMs < 0) throw new Error(`${keyPrefix}.minDelayMs must be >= 0`);
  if (!Number.isFinite(config.maxDelayMs) || config.maxDelayMs < config.minDelayMs) {
    throw new Error(`${keyPrefix}.maxDelayMs must be >= minDelayMs`);
  }
  clampProbabilityConfig(config.probabilityThreshold, `${keyPrefix}.probabilityThreshold`);
  clampProbabilityConfig(config.confidenceThreshold, `${keyPrefix}.confidenceThreshold`);
  if (!Number.isFinite(config.cooldownMs) || config.cooldownMs < 0) throw new Error(`${keyPrefix}.cooldownMs must be >= 0`);
  if (!Number.isFinite(config.typingActiveMs) || config.typingActiveMs < 0) throw new Error(`${keyPrefix}.typingActiveMs must be >= 0`);
  if (!Number.isInteger(config.maxRepliesPerUserPerHour) || config.maxRepliesPerUserPerHour < 0) {
    throw new Error(`${keyPrefix}.maxRepliesPerUserPerHour must be >= 0`);
  }
  if (!Number.isInteger(config.maxRepliesPerChannelPerHour) || config.maxRepliesPerChannelPerHour < 0) {
    throw new Error(`${keyPrefix}.maxRepliesPerChannelPerHour must be >= 0`);
  }
  if (!Number.isFinite(config.randomJitter) || config.randomJitter < 0 || config.randomJitter > 1) {
    throw new Error(`${keyPrefix}.randomJitter must be between 0 and 1`);
  }
}

function validateAmbientAttentionConfig(config: AmbientAttentionConfig, keyPrefix: string): void {
  if (!Number.isInteger(config.historyLimit) || config.historyLimit < 5) throw new Error(`${keyPrefix}.historyLimit must be >= 5`);
  if (!Number.isFinite(config.busyWindowMs) || config.busyWindowMs < 0) throw new Error(`${keyPrefix}.busyWindowMs must be >= 0`);
  if (!Number.isInteger(config.busyMessageLimit) || config.busyMessageLimit < 1) throw new Error(`${keyPrefix}.busyMessageLimit must be >= 1`);
  if (!Number.isFinite(config.staleAfterMs) || config.staleAfterMs < 1000) throw new Error(`${keyPrefix}.staleAfterMs must be >= 1000`);
  if (!Number.isInteger(config.maxNewMessagesBeforeDrop) || config.maxNewMessagesBeforeDrop < 0) {
    throw new Error(`${keyPrefix}.maxNewMessagesBeforeDrop must be >= 0`);
  }
  if (!Number.isFinite(config.ambientPickup.minQuietMs) || config.ambientPickup.minQuietMs < 0) {
    throw new Error(`${keyPrefix}.ambientPickup.minQuietMs must be >= 0`);
  }
  if (!Number.isFinite(config.lingering.strongWindowMs) || config.lingering.strongWindowMs < 0) {
    throw new Error(`${keyPrefix}.lingering.strongWindowMs must be >= 0`);
  }
  if (!Number.isFinite(config.lingering.weakWindowMs) || config.lingering.weakWindowMs < config.lingering.strongWindowMs) {
    throw new Error(`${keyPrefix}.lingering.weakWindowMs must be >= strongWindowMs`);
  }
  if (!Number.isFinite(config.lingering.typingExtensionMs) || config.lingering.typingExtensionMs < 0) {
    throw new Error(`${keyPrefix}.lingering.typingExtensionMs must be >= 0`);
  }
  if (!Number.isInteger(config.lingering.maxTypingExtensions) || config.lingering.maxTypingExtensions < 0) {
    throw new Error(`${keyPrefix}.lingering.maxTypingExtensions must be >= 0`);
  }
  if (!Number.isFinite(config.followUp.silenceMs) || config.followUp.silenceMs < 0) {
    throw new Error(`${keyPrefix}.followUp.silenceMs must be >= 0`);
  }
  if (!Number.isInteger(config.followUp.maxPerExchange) || config.followUp.maxPerExchange < 0) {
    throw new Error(`${keyPrefix}.followUp.maxPerExchange must be >= 0`);
  }
}

function validateClockTime(value: string, keyPrefix: string): void {
  if (!/^\d{2}:\d{2}$/.test(value)) throw new Error(`${keyPrefix} must use HH:mm`);
  const [hhRaw, mmRaw] = value.split(":");
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    throw new Error(`${keyPrefix} must use HH:mm`);
  }
}

function validateAmbientInitiativeConfig(config: AmbientInitiativeConfig, keyPrefix: string): void {
  if (new Set(config.botContactIds).size !== config.botContactIds.length) {
    throw new Error(`${keyPrefix}.botContactIds must not contain duplicates`);
  }
  if (!Number.isFinite(config.wallClockTimeoutMs) || config.wallClockTimeoutMs < 1000) {
    throw new Error(`${keyPrefix}.wallClockTimeoutMs must be >= 1000`);
  }
  if (!Number.isFinite(config.checkIntervalMinMs) || config.checkIntervalMinMs < 1000) {
    throw new Error(`${keyPrefix}.checkIntervalMinMs must be >= 1000`);
  }
  if (!Number.isFinite(config.checkIntervalMaxMs) || config.checkIntervalMaxMs < config.checkIntervalMinMs) {
    throw new Error(`${keyPrefix}.checkIntervalMaxMs must be >= checkIntervalMinMs`);
  }
  validateClockTime(config.activeHours.start, `${keyPrefix}.activeHours.start`);
  validateClockTime(config.activeHours.end, `${keyPrefix}.activeHours.end`);
  if (!Number.isInteger(config.historyLimit) || config.historyLimit < 5) throw new Error(`${keyPrefix}.historyLimit must be >= 5`);
  if (!Number.isFinite(config.recentActivityMinMs) || config.recentActivityMinMs < 0) throw new Error(`${keyPrefix}.recentActivityMinMs must be >= 0`);
  if (!Number.isFinite(config.recentActivityMaxMs) || config.recentActivityMaxMs < config.recentActivityMinMs) {
    throw new Error(`${keyPrefix}.recentActivityMaxMs must be >= recentActivityMinMs`);
  }
  if (!Number.isFinite(config.quietWindowMs) || config.quietWindowMs < 0) throw new Error(`${keyPrefix}.quietWindowMs must be >= 0`);
  if (!Number.isFinite(config.botCooldownMs) || config.botCooldownMs < 0) throw new Error(`${keyPrefix}.botCooldownMs must be >= 0`);
  clampProbabilityConfig(config.basePressure, `${keyPrefix}.basePressure`);
  clampProbabilityConfig(config.probabilityThreshold, `${keyPrefix}.probabilityThreshold`);
  clampProbabilityConfig(config.confidenceThreshold, `${keyPrefix}.confidenceThreshold`);
  if (!Number.isFinite(config.cooldownMs) || config.cooldownMs < 0) throw new Error(`${keyPrefix}.cooldownMs must be >= 0`);
  if (!Number.isInteger(config.maxPerDay) || config.maxPerDay < 0) throw new Error(`${keyPrefix}.maxPerDay must be >= 0`);
  if (!Number.isInteger(config.minMainChannelHumanMessages) || config.minMainChannelHumanMessages < 0) {
    throw new Error(`${keyPrefix}.minMainChannelHumanMessages must be >= 0`);
  }
  if (!Number.isFinite(config.mainChannelLookbackDays) || config.mainChannelLookbackDays <= 0) {
    throw new Error(`${keyPrefix}.mainChannelLookbackDays must be > 0`);
  }
}
