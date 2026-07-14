import type { Database } from "../db/database.ts";
import { formatLocalWallClock } from "../time/agent-time.ts";
import { getPersonaModeStateJson, setPersonaModeStateJson } from "./repository.ts";
import type {
  PersonaMode,
  PersonaModeAvatarCandidate,
  PersonaModePresence,
  PersonaModesConfig,
  TriggeredEpisodeActivation,
} from "./types.ts";
import { activeEpochWindow, enumerateEpochWindows, nextEpochWindow, randomStartInWindows } from "./windows.ts";

interface PlannedEpisode {
  eligibleAt: number;
  opportunityEndsAt: number;
  durationMs: number;
  scheduleFingerprint: string;
}

interface ActiveEpisode {
  modeId: string;
  startedAt: number;
  endsAt: number;
  visibleTurns: number;
  maxVisibleTurns: number;
}

interface CycleOutcome {
  kind: "episode" | "missed";
  endedAt: number;
}

interface AftermathState {
  modeId: string;
  endedAt: number;
  expiresAt: number;
  reason: "duration" | "visible_turn_limit" | "scheduled_window_ended";
}

interface PersistedModeState {
  version: 2;
  initializedAt: number;
  lastResolvedModeId?: string;
  plannedEpisodes: Record<string, PlannedEpisode>;
  modeInitializedAt: Record<string, number>;
  lastCycleOutcomes: Record<string, CycleOutcome>;
  activeEpisode?: ActiveEpisode;
  aftermath?: AftermathState;
  selectedAvatars: Record<string, string>;
  nextAvatarRotations: Record<string, number>;
  appliedAvatarId?: string | null;
  appliedAvatarContentHash?: string;
  appliedDiscordAvatarHash?: string | null;
  avatarRetryNotBefore?: number;
  avatarFailures: number;
  appliedPresenceKey?: string;
}

interface ContextConfig {
  defaultModeId?: string;
  modes: PersonaMode[];
}

export interface PersonaModeLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

interface PersonaModeContextPresentationAdapter {
  currentAvatarHash(): string | null;
  applyAvatar(candidate: PersonaModeAvatarCandidate | null): Promise<{ discordAvatarHash: string | null }>;
  applyPresence?(presence: PersonaModePresence | undefined): void;
  clearAvatarWhenInactive: boolean;
}

export interface PersonaModePresentationAdapter {
  global: {
    currentAvatarHash(): string | null;
    applyAvatar(candidate: PersonaModeAvatarCandidate): Promise<{ discordAvatarHash: string | null }>;
    applyPresence(presence: PersonaModePresence | undefined): void;
  };
  guild: {
    currentAvatarHash(guildId: string): string | null;
    applyAvatar(guildId: string, candidate: PersonaModeAvatarCandidate | null): Promise<{ discordAvatarHash: string | null }>;
  };
}

export interface PersonaModeContextStatus {
  enabled: boolean;
  current?: {
    id: string;
    kind: "default" | "scheduled" | "episode";
    startedAt?: number;
    endsAt?: number;
    visibleTurns?: number;
    maxVisibleTurns?: number;
    avatarId: string;
    presence?: PersonaModePresence;
  };
  upcoming: Array<{
    modeId: string;
    kind: "scheduled" | "episode";
    startsAt: number;
    windowEndsAt: number;
    activationDeadlineAt?: number;
    leadInStartsAt?: number;
  }>;
  aftermath?: {
    modeId: string;
    endedAt: number;
    expiresAt: number;
  };
  presentation: {
    avatar: "disabled" | "applied" | "updating" | "waiting" | "retrying";
    desiredAvatarId?: string;
    appliedAvatarId?: string | null;
    retryAt?: number;
  };
}

export interface PersonaModeStatus extends PersonaModeContextStatus {
  timezone: string;
  guilds: Array<{ guildId: string; status: PersonaModeContextStatus }>;
}

export interface PersonaModeRuntime {
  start(): void;
  stop(): void;
  update(config: PersonaModesConfig | undefined, timezone: string): void;
  prepareNaturalTurn(guildId: string, now?: number): void;
  noteVisibleTurn(guildId: string, now?: number): void;
  renderPromptContext(guildId: string, now?: number): string;
  reapplyPresentation(): void;
  activeModeId(guildId: string, now?: number): string | undefined;
  getStatus(now?: number): PersonaModeStatus;
}

interface PersonaModeRuntimeOptions {
  db: Database;
  config: PersonaModesConfig | undefined;
  timezone: string;
  guildIds(): readonly string[];
  presentation: PersonaModePresentationAdapter;
  log: PersonaModeLogger;
  now?: () => number;
  random?: () => number;
  timers?: PersonaModeTimers;
}

interface PersonaModeTimers {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

interface PromptState {
  active?: { id: string; instructions: string };
  supplements: string[];
}

interface PersonaModeContextRuntime {
  start(): void;
  stop(): void;
  update(config: ContextConfig | undefined, timezone: string): void;
  reconcile(now: number): void;
  activateEligibleMode(modeId: string, now: number): boolean;
  noteVisibleTurn(now: number, winningModeId: string | undefined): void;
  renderPromptState(now: number): PromptState;
  reapplyPresentation(): void;
  activeModeId(now: number): string | undefined;
  isModeActive(modeId: string, now: number): boolean;
  getStatus(now: number): PersonaModeContextStatus;
}

interface PersonaModeContextRuntimeOptions {
  db: Database;
  scopeKey: string;
  config: ContextConfig | undefined;
  timezone: string;
  presentation: PersonaModeContextPresentationAdapter;
  log: PersonaModeLogger;
  now: () => number;
  random: () => number;
  timers: PersonaModeTimers;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const AVATAR_RETRY_BASE_MS = 5_000;
const AVATAR_RETRY_MAX_MS = 15 * 60_000;
const PLANNING_RETRY_MS = 60 * 60_000;
const INHERITED_AVATAR_CONTENT_HASH = "inherited";

function freshState(now: number): PersistedModeState {
  return {
    version: 2,
    initializedAt: now,
    plannedEpisodes: {},
    modeInitializedAt: {},
    lastCycleOutcomes: {},
    selectedAvatars: {},
    nextAvatarRotations: {},
    avatarFailures: 0,
  };
}

function loadState(db: Database, scopeKey: string, now: number, log: PersonaModeLogger): PersistedModeState {
  const raw = getPersonaModeStateJson(db, scopeKey);
  if (raw === null) return freshState(now);
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedModeState>;
    if (parsed.version !== 2 || typeof parsed.initializedAt !== "number") throw new Error("unsupported state version");
    return {
      ...freshState(parsed.initializedAt),
      ...parsed,
      plannedEpisodes: parsed.plannedEpisodes ?? {},
      modeInitializedAt: parsed.modeInitializedAt ?? {},
      lastCycleOutcomes: parsed.lastCycleOutcomes ?? {},
      selectedAvatars: parsed.selectedAvatars ?? {},
      nextAvatarRotations: parsed.nextAvatarRotations ?? {},
      avatarFailures: parsed.avatarFailures ?? 0,
    };
  } catch (error) {
    log.warn("persona mode state is invalid; starting fresh", {
      scopeKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return freshState(now);
  }
}

function randomInteger(min: number, max: number, random: () => number): number {
  if (max <= min) return min;
  return min + Math.floor(random() * (max - min + 1));
}

function rateLimitRetryAfter(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const retryAfter = (error as { retryAfter?: unknown }).retryAfter;
  return typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
}

function modeById(config: ContextConfig | undefined, id: string | undefined): PersonaMode | undefined {
  return id === undefined ? undefined : config?.modes.find((mode) => mode.id === id);
}

function triggeredScheduleFingerprint(activation: TriggeredEpisodeActivation, timezone: string): string {
  return JSON.stringify({
    timezone,
    minIntervalMs: activation.minIntervalMs,
    maxIntervalMs: activation.maxIntervalMs,
    cooldownMs: activation.cooldownMs,
    minDurationMs: activation.minDurationMs,
    maxDurationMs: activation.maxDurationMs,
    opportunityWindows: activation.opportunityWindows,
  });
}

function avatarCandidateSetFingerprint(mode: PersonaMode): string {
  return [...mode.avatars].map((candidate) => candidate.id).sort().join("\u0000");
}

function avatarRotationFingerprint(mode: PersonaMode): string {
  return mode.avatarRotation === undefined
    ? ""
    : `${mode.avatarRotation.minIntervalMs}:${mode.avatarRotation.maxIntervalMs}`;
}

function contextConfig(config: PersonaModesConfig | undefined, scope: "global" | "guild"): ContextConfig | undefined {
  if (config === undefined) return undefined;
  const modes = config.modes.filter((mode) => mode.scope === scope);
  if (modes.length === 0) return undefined;
  return {
    ...(scope === "global" ? { defaultModeId: config.defaultModeId } : {}),
    modes,
  };
}

/** Create one persistent mode state machine and latest-desired avatar reconciler. */
function createPersonaModeContextRuntime(options: PersonaModeContextRuntimeOptions): PersonaModeContextRuntime {
  let config = options.config;
  let timezone = options.timezone;
  const state = loadState(options.db, options.scopeKey, options.now(), options.log);
  let running = false;
  let lifecycleTimer: ReturnType<typeof setTimeout> | undefined;
  let avatarTimer: ReturnType<typeof setTimeout> | undefined;
  let avatarInFlight = false;
  let presenceNeedsApply = true;
  let desiredAvatar: PersonaModeAvatarCandidate | null | undefined;
  let desiredModeId: string | undefined;

  function persist(now = options.now()): void {
    setPersonaModeStateJson(options.db, options.scopeKey, JSON.stringify(state), now);
  }

  function clearLifecycleTimer(): void {
    if (lifecycleTimer !== undefined) options.timers.clearTimeout(lifecycleTimer);
    lifecycleTimer = undefined;
  }

  function clearAvatarTimer(): void {
    if (avatarTimer !== undefined) options.timers.clearTimeout(avatarTimer);
    avatarTimer = undefined;
  }

  function triggeredActivation(mode: PersonaMode): TriggeredEpisodeActivation | undefined {
    return mode.activation?.type === "triggeredEpisode" ? mode.activation : undefined;
  }

  function isIntrinsicallyActive(mode: PersonaMode, now: number): boolean {
    if (state.activeEpisode?.modeId === mode.id && now < state.activeEpisode.endsAt) return true;
    if (mode.activation === undefined) return mode.id === config?.defaultModeId;
    if (mode.activation.type === "scheduledWindow") {
      return activeEpochWindow(mode.activation.windows, timezone, now) !== undefined;
    }
    return false;
  }

  function resolvedMode(now: number): PersonaMode | undefined {
    if (config === undefined) return undefined;
    return config.modes.find((mode) => isIntrinsicallyActive(mode, now))
      ?? modeById(config, config.defaultModeId);
  }

  function chooseAvatar(mode: PersonaMode, forceDifferent: boolean): PersonaModeAvatarCandidate {
    const currentId = state.selectedAvatars[mode.id];
    const current = mode.avatars.find((candidate) => candidate.id === currentId);
    if (!forceDifferent && current !== undefined) return current;
    const pool = forceDifferent && mode.avatars.length > 1
      ? mode.avatars.filter((candidate) => candidate.id !== currentId)
      : mode.avatars;
    const chosen = pool[Math.floor(options.random() * pool.length)] ?? mode.avatars[0];
    if (chosen === undefined) throw new Error(`Persona mode ${mode.id} has no avatar candidates`);
    state.selectedAvatars[mode.id] = chosen.id;
    return chosen;
  }

  function planEpisode(mode: PersonaMode, activation: TriggeredEpisodeActivation, now: number): boolean {
    if (state.plannedEpisodes[mode.id] !== undefined || state.activeEpisode?.modeId === mode.id) return false;
    const modeStartedAt = state.modeInitializedAt[mode.id] ?? now;
    state.modeInitializedAt[mode.id] = modeStartedAt;
    const outcome = state.lastCycleOutcomes[mode.id];
    const baseline = outcome?.endedAt ?? modeStartedAt;
    const cooldownFloor = outcome?.kind === "episode" ? baseline + activation.cooldownMs : baseline;
    const earliestAt = Math.max(baseline + activation.minIntervalMs, cooldownFloor);
    const latestAt = Math.max(baseline + activation.maxIntervalMs, earliestAt);
    if (latestAt < now) {
      state.lastCycleOutcomes[mode.id] = { kind: "missed", endedAt: now };
      return true;
    }
    const durationMs = randomInteger(activation.minDurationMs, activation.maxDurationMs, options.random);
    const slot = randomStartInWindows(
      activation.opportunityWindows,
      timezone,
      Math.max(earliestAt, now),
      latestAt,
      durationMs,
      options.random,
    );
    if (slot === undefined) {
      options.log.error("persona mode episode has no eligible opportunity slot", {
        scopeKey: options.scopeKey,
        modeId: mode.id,
        earliestAt,
        latestAt,
      });
      return false;
    }
    state.plannedEpisodes[mode.id] = {
      eligibleAt: slot.startsAt,
      opportunityEndsAt: slot.windowEndsAt,
      durationMs,
      scheduleFingerprint: triggeredScheduleFingerprint(activation, timezone),
    };
    options.log.info("persona mode episode planned", {
      scopeKey: options.scopeKey,
      modeId: mode.id,
      eligibleAt: slot.startsAt,
      opportunityEndsAt: slot.windowEndsAt,
      durationMs,
    });
    return true;
  }

  function createAftermath(modeId: string, endedAt: number, reason: AftermathState["reason"], observedAt: number): void {
    const mode = modeById(config, modeId);
    if (mode?.aftermath === undefined || endedAt + mode.aftermath.maxAgeMs <= observedAt) return;
    state.aftermath = {
      modeId,
      endedAt,
      expiresAt: endedAt + mode.aftermath.maxAgeMs,
      reason,
    };
  }

  function applyTimeTransitions(now: number): boolean {
    let changed = false;
    if (state.aftermath !== undefined && now >= state.aftermath.expiresAt) {
      delete state.aftermath;
      changed = true;
    }
    if (state.activeEpisode !== undefined && now >= state.activeEpisode.endsAt) {
      const ended = state.activeEpisode;
      delete state.activeEpisode;
      state.lastCycleOutcomes[ended.modeId] = { kind: "episode", endedAt: ended.endsAt };
      createAftermath(ended.modeId, ended.endsAt, "duration", now);
      changed = true;
    }
    if (config === undefined) return changed;
    for (const mode of config.modes) {
      if (state.modeInitializedAt[mode.id] === undefined) {
        state.modeInitializedAt[mode.id] = now;
        changed = true;
      }
      const activation = triggeredActivation(mode);
      if (activation === undefined) continue;
      let planned = state.plannedEpisodes[mode.id];
      if (planned !== undefined && planned.scheduleFingerprint !== triggeredScheduleFingerprint(activation, timezone)) {
        Reflect.deleteProperty(state.plannedEpisodes, mode.id);
        planned = undefined;
        options.log.info("persona mode episode schedule changed; replanning", { scopeKey: options.scopeKey, modeId: mode.id });
        changed = true;
      }
      if (planned !== undefined && now > planned.opportunityEndsAt - planned.durationMs) {
        Reflect.deleteProperty(state.plannedEpisodes, mode.id);
        state.lastCycleOutcomes[mode.id] = {
          kind: "missed",
          endedAt: planned.opportunityEndsAt - planned.durationMs,
        };
        options.log.info("persona mode episode opportunity missed", { scopeKey: options.scopeKey, modeId: mode.id });
        changed = true;
      }
      changed = planEpisode(mode, activation, now) || changed;
    }
    return changed;
  }

  function ensureResolvedMode(now: number): { mode: PersonaMode | undefined; changed: boolean } {
    const mode = resolvedMode(now);
    let changed = false;
    if (state.lastResolvedModeId !== mode?.id) {
      const previous = modeById(config, state.lastResolvedModeId);
      if (previous !== undefined && !isIntrinsicallyActive(previous, now)) {
        const previousWindow = previous.activation?.type === "scheduledWindow"
          ? enumerateEpochWindows(previous.activation.windows, timezone, now - 370 * 86_400_000, now)
              .filter((window) => window.endAt <= now)
              .at(-1)
          : undefined;
        createAftermath(previous.id, previousWindow?.endAt ?? now, "scheduled_window_ended", now);
      }
      if (mode === undefined) delete state.lastResolvedModeId;
      else state.lastResolvedModeId = mode.id;
      if (mode !== undefined) chooseAvatar(mode, true);
      if (previous !== undefined) Reflect.deleteProperty(state.nextAvatarRotations, previous.id);
      changed = true;
      options.log.info("persona mode changed", { scopeKey: options.scopeKey, from: previous?.id, to: mode?.id });
    }
    if (mode !== undefined && mode.avatars.find((candidate) => candidate.id === state.selectedAvatars[mode.id]) === undefined) {
      chooseAvatar(mode, false);
      changed = true;
    }
    return { mode, changed };
  }

  function ensureAvatarRotation(mode: PersonaMode, now: number): boolean {
    if (mode.avatarRotation === undefined || mode.avatars.length < 2) {
      if (state.nextAvatarRotations[mode.id] !== undefined) {
        Reflect.deleteProperty(state.nextAvatarRotations, mode.id);
        return true;
      }
      return false;
    }
    const selected = mode.avatars.find((candidate) => candidate.id === state.selectedAvatars[mode.id]);
    const selectedApplied = selected !== undefined && state.appliedAvatarContentHash === selected.contentHash;
    const nextAt = state.nextAvatarRotations[mode.id];
    if (nextAt !== undefined && now >= nextAt) {
      chooseAvatar(mode, true);
      Reflect.deleteProperty(state.nextAvatarRotations, mode.id);
      return true;
    }
    if (nextAt === undefined && selectedApplied) {
      state.nextAvatarRotations[mode.id] = now + randomInteger(
        mode.avatarRotation.minIntervalMs,
        mode.avatarRotation.maxIntervalMs,
        options.random,
      );
      return true;
    }
    return false;
  }

  function desiredPresence(mode: PersonaMode | undefined): PersonaModePresence | undefined {
    if (mode?.presence !== undefined) return mode.presence;
    return modeById(config, config?.defaultModeId)?.presence;
  }

  function updatePresentation(mode: PersonaMode | undefined): void {
    desiredModeId = mode?.id;
    desiredAvatar = mode === undefined
      ? options.presentation.clearAvatarWhenInactive ? null : undefined
      : mode.avatars.find((candidate) => candidate.id === state.selectedAvatars[mode.id]);
    if (options.presentation.applyPresence !== undefined) {
      const presence = desiredPresence(mode);
      const presenceKey = JSON.stringify(presence ?? null);
      if (presenceNeedsApply || state.appliedPresenceKey !== presenceKey) {
        try {
          options.presentation.applyPresence(presence);
          state.appliedPresenceKey = presenceKey;
          presenceNeedsApply = false;
          persist();
        } catch (error) {
          options.log.warn("persona mode presence update failed", {
            scopeKey: options.scopeKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    scheduleAvatarReconcile();
  }

  function avatarAlreadyApplied(candidate: PersonaModeAvatarCandidate | null): boolean {
    if (candidate === null) return options.presentation.currentAvatarHash() === null;
    return state.appliedAvatarContentHash === candidate.contentHash
      && state.appliedDiscordAvatarHash === options.presentation.currentAvatarHash();
  }

  function scheduleAvatarReconcile(): void {
    if (!running || avatarInFlight || desiredAvatar === undefined) return;
    clearAvatarTimer();
    if (avatarAlreadyApplied(desiredAvatar)) return;
    const now = options.now();
    const retryAt = state.avatarRetryNotBefore ?? now;
    if (retryAt > now) {
      avatarTimer = options.timers.setTimeout(() => {
        avatarTimer = undefined;
        scheduleAvatarReconcile();
      }, Math.min(retryAt - now, MAX_TIMER_DELAY_MS));
      return;
    }
    const attempted = desiredAvatar;
    avatarInFlight = true;
    void options.presentation.applyAvatar(attempted).then((result) => {
      state.appliedAvatarId = attempted?.id ?? null;
      state.appliedAvatarContentHash = attempted?.contentHash ?? INHERITED_AVATAR_CONTENT_HASH;
      state.appliedDiscordAvatarHash = result.discordAvatarHash;
      state.avatarFailures = 0;
      delete state.avatarRetryNotBefore;
      options.log.info("persona mode avatar applied", {
        scopeKey: options.scopeKey,
        modeId: desiredModeId,
        avatar: attempted?.id ?? "inherited",
      });
    }).catch((error: unknown) => {
      const retryAfter = rateLimitRetryAfter(error);
      state.avatarFailures += 1;
      state.avatarRetryNotBefore = options.now() + (retryAfter ?? Math.min(
        AVATAR_RETRY_MAX_MS,
        AVATAR_RETRY_BASE_MS * 2 ** Math.min(state.avatarFailures - 1, 8),
      ));
      options.log.warn("persona mode avatar update deferred", {
        scopeKey: options.scopeKey,
        avatar: attempted?.id ?? "inherited",
        retryAt: state.avatarRetryNotBefore,
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      avatarInFlight = false;
      persist();
      reconcile(options.now());
    });
  }

  function lifecycleTimes(now: number): number[] {
    const times: number[] = [];
    if (config === undefined) return times;
    if (state.activeEpisode !== undefined) times.push(state.activeEpisode.endsAt);
    if (state.aftermath !== undefined) times.push(state.aftermath.expiresAt);
    for (const mode of config.modes) {
      if (mode.activation?.type === "scheduledWindow") {
        const active = activeEpochWindow(mode.activation.windows, timezone, now);
        if (active !== undefined) times.push(active.endAt);
        const next = nextEpochWindow(mode.activation.windows, timezone, now);
        if (next !== undefined) {
          times.push(next.startAt);
          if (mode.leadIn !== undefined) times.push(next.startAt - mode.leadIn.durationMs);
        }
      } else if (mode.activation?.type === "triggeredEpisode") {
        const planned = state.plannedEpisodes[mode.id];
        if (planned === undefined) times.push(now + PLANNING_RETRY_MS);
        else {
          times.push(planned.eligibleAt, planned.opportunityEndsAt - planned.durationMs + 1);
          if (mode.leadIn !== undefined) times.push(planned.eligibleAt - mode.leadIn.durationMs);
        }
      }
      const rotationAt = state.nextAvatarRotations[mode.id];
      if (rotationAt !== undefined) times.push(rotationAt);
    }
    return times.filter((time) => time > now);
  }

  function armLifecycle(now: number): void {
    clearLifecycleTimer();
    if (!running) return;
    const nextAt = lifecycleTimes(now).sort((a, b) => a - b)[0];
    if (nextAt === undefined) return;
    lifecycleTimer = options.timers.setTimeout(() => {
      lifecycleTimer = undefined;
      reconcile(options.now());
    }, Math.min(nextAt - now, MAX_TIMER_DELAY_MS));
  }

  function reconcile(now: number): void {
    let changed = applyTimeTransitions(now);
    const resolved = ensureResolvedMode(now);
    changed = resolved.changed || changed;
    if (resolved.mode !== undefined) changed = ensureAvatarRotation(resolved.mode, now) || changed;
    if (changed) persist(now);
    updatePresentation(resolved.mode);
    armLifecycle(now);
  }

  function activateEligibleMode(modeId: string, now: number): boolean {
    if (config === undefined || state.activeEpisode !== undefined) return false;
    const mode = modeById(config, modeId);
    if (mode === undefined) return false;
    const activation = triggeredActivation(mode);
    const planned = state.plannedEpisodes[mode.id];
    if (activation === undefined || planned === undefined) return false;
    if (now < planned.eligibleAt || now + planned.durationMs > planned.opportunityEndsAt) return false;
    state.activeEpisode = {
      modeId: mode.id,
      startedAt: now,
      endsAt: now + planned.durationMs,
      visibleTurns: 0,
      maxVisibleTurns: activation.maxVisibleTurns,
    };
    Reflect.deleteProperty(state.plannedEpisodes, mode.id);
    options.log.info("persona mode episode activated", {
      scopeKey: options.scopeKey,
      modeId: mode.id,
      endsAt: now + planned.durationMs,
    });
    persist(now);
    reconcile(now);
    return true;
  }

  function leadInText(now: number, activeModeId: string | undefined): string[] {
    if (config === undefined) return [];
    const blocks: string[] = [];
    for (const mode of config.modes) {
      if (mode.leadIn === undefined || mode.id === activeModeId || mode.activation === undefined) continue;
      if (mode.activation.type === "scheduledWindow") {
        const next = nextEpochWindow(mode.activation.windows, timezone, now);
        if (next === undefined || now < next.startAt - mode.leadIn.durationMs || now >= next.startAt) continue;
        blocks.push([
          `The '${mode.id}' mode is scheduled to start at ${formatLocalWallClock(next.startAt, timezone)} local time. Keep the exact time and scheduling private.`,
          mode.leadIn.instructions,
        ].join("\n"));
      } else {
        const planned = state.plannedEpisodes[mode.id];
        if (planned === undefined || now < planned.eligibleAt - mode.leadIn.durationMs || now >= planned.eligibleAt) continue;
        blocks.push([
          `The '${mode.id}' mode may become active after ${formatLocalWallClock(planned.eligibleAt, timezone)} local time if a natural turn occurs. Keep the exact time and scheduling private.`,
          mode.leadIn.instructions,
        ].join("\n"));
      }
    }
    return blocks;
  }

  function renderPromptState(now: number): PromptState {
    reconcile(now);
    const mode = resolvedMode(now);
    const supplements: string[] = [];
    if (state.aftermath !== undefined && now < state.aftermath.expiresAt) {
      const aftermathMode = modeById(config, state.aftermath.modeId);
      if (aftermathMode?.aftermath !== undefined) {
        supplements.push([
          `The '${aftermathMode.id}' mode ended at ${formatLocalWallClock(state.aftermath.endedAt, timezone)} local time. Treat that as your own recent state; do not mention mode or runtime machinery.`,
          aftermathMode.aftermath.instructions,
        ].join("\n"));
      }
    }
    supplements.push(...leadInText(now, mode?.id));
    return {
      ...(mode !== undefined ? { active: { id: mode.id, instructions: mode.instructions } } : {}),
      supplements,
    };
  }

  function status(now: number): PersonaModeContextStatus {
    reconcile(now);
    if (config === undefined) {
      const applied = desiredAvatar === null && avatarAlreadyApplied(null);
      return {
        enabled: false,
        upcoming: [],
        presentation: {
          avatar: desiredAvatar === undefined ? "disabled" : applied ? "applied" : avatarInFlight ? "updating" : "waiting",
        },
      };
    }
    const mode = resolvedMode(now);
    const upcoming: PersonaModeContextStatus["upcoming"] = [];
    for (const candidate of config.modes) {
      if (candidate.activation?.type === "scheduledWindow") {
        const next = nextEpochWindow(candidate.activation.windows, timezone, now);
        if (next !== undefined) {
          upcoming.push({
            modeId: candidate.id,
            kind: "scheduled",
            startsAt: next.startAt,
            windowEndsAt: next.endAt,
            ...(candidate.leadIn !== undefined ? { leadInStartsAt: next.startAt - candidate.leadIn.durationMs } : {}),
          });
        }
      } else if (candidate.activation?.type === "triggeredEpisode") {
        const planned = state.plannedEpisodes[candidate.id];
        if (planned !== undefined) {
          upcoming.push({
            modeId: candidate.id,
            kind: "episode",
            startsAt: planned.eligibleAt,
            windowEndsAt: planned.opportunityEndsAt,
            activationDeadlineAt: planned.opportunityEndsAt - planned.durationMs,
            ...(candidate.leadIn !== undefined ? { leadInStartsAt: planned.eligibleAt - candidate.leadIn.durationMs } : {}),
          });
        }
      }
    }
    upcoming.sort((a, b) => a.startsAt - b.startsAt);
    const activeWindow = mode?.activation?.type === "scheduledWindow"
      ? activeEpochWindow(mode.activation.windows, timezone, now)
      : undefined;
    const activeEpisode = mode?.activation?.type === "triggeredEpisode" && state.activeEpisode?.modeId === mode.id
      ? state.activeEpisode
      : undefined;
    const selectedAvatar = mode === undefined ? undefined : state.selectedAvatars[mode.id];
    const applied = desiredAvatar !== undefined && avatarAlreadyApplied(desiredAvatar);
    const avatarState = desiredAvatar === undefined
      ? "disabled"
      : applied
        ? "applied"
        : avatarInFlight
          ? "updating"
          : state.avatarRetryNotBefore !== undefined && state.avatarRetryNotBefore > now
            ? "retrying"
            : "waiting";
    return {
      enabled: true,
      ...(mode !== undefined && selectedAvatar !== undefined
        ? {
            current: {
              id: mode.id,
              kind: activeEpisode !== undefined ? "episode" as const : activeWindow !== undefined ? "scheduled" as const : "default" as const,
              ...(activeEpisode !== undefined
                ? {
                    startedAt: activeEpisode.startedAt,
                    endsAt: activeEpisode.endsAt,
                    visibleTurns: activeEpisode.visibleTurns,
                    maxVisibleTurns: activeEpisode.maxVisibleTurns,
                  }
                : activeWindow !== undefined
                  ? { startedAt: activeWindow.startAt, endsAt: activeWindow.endAt }
                  : {}),
              avatarId: selectedAvatar,
              ...(desiredPresence(mode) !== undefined ? { presence: desiredPresence(mode) } : {}),
            },
          }
        : {}),
      upcoming,
      ...(state.aftermath !== undefined
        ? { aftermath: { modeId: state.aftermath.modeId, endedAt: state.aftermath.endedAt, expiresAt: state.aftermath.expiresAt } }
        : {}),
      presentation: {
        avatar: avatarState,
        ...(desiredAvatar !== undefined && desiredAvatar !== null ? { desiredAvatarId: desiredAvatar.id } : {}),
        ...(state.appliedAvatarId !== undefined ? { appliedAvatarId: state.appliedAvatarId } : {}),
        ...(state.avatarRetryNotBefore !== undefined ? { retryAt: state.avatarRetryNotBefore } : {}),
      },
    };
  }

  return {
    start() {
      if (running) return;
      running = true;
      presenceNeedsApply = true;
      reconcile(options.now());
    },

    stop() {
      running = false;
      clearLifecycleTimer();
      clearAvatarTimer();
    },

    update(nextConfig, nextTimezone) {
      const previousConfig = config;
      const previousTimezone = timezone;
      const now = options.now();
      config = nextConfig;
      timezone = nextTimezone;
      const modeIds = new Set(nextConfig?.modes.map((mode) => mode.id) ?? []);
      for (const id of Object.keys(state.plannedEpisodes)) if (!modeIds.has(id)) Reflect.deleteProperty(state.plannedEpisodes, id);
      for (const id of Object.keys(state.modeInitializedAt)) if (!modeIds.has(id)) Reflect.deleteProperty(state.modeInitializedAt, id);
      for (const id of Object.keys(state.lastCycleOutcomes)) if (!modeIds.has(id)) Reflect.deleteProperty(state.lastCycleOutcomes, id);
      for (const id of Object.keys(state.selectedAvatars)) if (!modeIds.has(id)) Reflect.deleteProperty(state.selectedAvatars, id);
      for (const id of Object.keys(state.nextAvatarRotations)) if (!modeIds.has(id)) Reflect.deleteProperty(state.nextAvatarRotations, id);
      for (const mode of nextConfig?.modes ?? []) {
        const previous = modeById(previousConfig, mode.id);
        if (previous === undefined) state.modeInitializedAt[mode.id] = now;
        if (previous !== undefined && avatarCandidateSetFingerprint(previous) !== avatarCandidateSetFingerprint(mode)) {
          Reflect.deleteProperty(state.selectedAvatars, mode.id);
          Reflect.deleteProperty(state.nextAvatarRotations, mode.id);
        } else if (previous !== undefined && avatarRotationFingerprint(previous) !== avatarRotationFingerprint(mode)) {
          Reflect.deleteProperty(state.nextAvatarRotations, mode.id);
        }
        const activation = triggeredActivation(mode);
        const previousActivation = previous === undefined ? undefined : triggeredActivation(previous);
        if (activation === undefined) {
          Reflect.deleteProperty(state.plannedEpisodes, mode.id);
        } else if (
          previousActivation !== undefined
          && triggeredScheduleFingerprint(previousActivation, previousTimezone) !== triggeredScheduleFingerprint(activation, nextTimezone)
        ) {
          Reflect.deleteProperty(state.plannedEpisodes, mode.id);
        }
      }
      if (state.activeEpisode !== undefined && !modeIds.has(state.activeEpisode.modeId)) delete state.activeEpisode;
      if (state.aftermath !== undefined && !modeIds.has(state.aftermath.modeId)) delete state.aftermath;
      if (state.lastResolvedModeId !== undefined && !modeIds.has(state.lastResolvedModeId)) delete state.lastResolvedModeId;
      presenceNeedsApply = true;
      persist(now);
      reconcile(now);
    },

    reconcile,
    activateEligibleMode,

    noteVisibleTurn(now, winningModeId) {
      const consumedAftermath = state.aftermath;
      if (consumedAftermath !== undefined) {
        const mode = modeById(config, consumedAftermath.modeId);
        if (mode?.aftermath?.consumeOnVisibleTurn === true) delete state.aftermath;
      }
      const active = state.activeEpisode;
      if (active !== undefined && active.modeId === winningModeId) {
        active.visibleTurns += 1;
        if (active.visibleTurns >= active.maxVisibleTurns) {
          delete state.activeEpisode;
          state.lastCycleOutcomes[active.modeId] = { kind: "episode", endedAt: now };
          createAftermath(active.modeId, now, "visible_turn_limit", now);
        }
      }
      persist(now);
      reconcile(now);
    },

    renderPromptState,

    reapplyPresentation() {
      presenceNeedsApply = true;
      reconcile(options.now());
    },

    activeModeId(now) {
      reconcile(now);
      return resolvedMode(now)?.id;
    },

    isModeActive(modeId, now) {
      reconcile(now);
      const mode = modeById(config, modeId);
      return mode !== undefined && isIntrinsicallyActive(mode, now);
    },

    getStatus: status,
  };
}

/** Create the profile-level coordinator for global and independent guild mode state. */
export function createPersonaModeRuntime(options: PersonaModeRuntimeOptions): PersonaModeRuntime {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  };
  let config = options.config;
  let timezone = options.timezone;
  let running = false;
  const globalRuntime = createPersonaModeContextRuntime({
    db: options.db,
    scopeKey: "global",
    config: contextConfig(config, "global"),
    timezone,
    presentation: {
      currentAvatarHash: () => options.presentation.global.currentAvatarHash(),
      applyAvatar: (candidate) => {
        if (candidate === null) throw new Error("Global persona mode cannot clear its default avatar");
        return options.presentation.global.applyAvatar(candidate);
      },
      applyPresence: (presence) => options.presentation.global.applyPresence(presence),
      clearAvatarWhenInactive: false,
    },
    log: options.log,
    now,
    random,
    timers,
  });
  const guildRuntimes = new Map<string, PersonaModeContextRuntime>();

  function ensureGuildRuntime(guildId: string): PersonaModeContextRuntime {
    let runtime = guildRuntimes.get(guildId);
    if (runtime !== undefined) return runtime;
    runtime = createPersonaModeContextRuntime({
      db: options.db,
      scopeKey: `guild:${guildId}`,
      config: contextConfig(config, "guild"),
      timezone,
      presentation: {
        currentAvatarHash: () => options.presentation.guild.currentAvatarHash(guildId),
        applyAvatar: (candidate) => options.presentation.guild.applyAvatar(guildId, candidate),
        clearAvatarWhenInactive: true,
      },
      log: options.log,
      now,
      random,
      timers,
    });
    guildRuntimes.set(guildId, runtime);
    if (running) runtime.start();
    return runtime;
  }

  function runtimeForMode(mode: PersonaMode, guildId: string): PersonaModeContextRuntime {
    return mode.scope === "global" ? globalRuntime : ensureGuildRuntime(guildId);
  }

  function winningModeId(guildId: string, observedAt: number): string | undefined {
    if (config === undefined) return undefined;
    for (const mode of config.modes) {
      if (runtimeForMode(mode, guildId).isModeActive(mode.id, observedAt)) return mode.id;
    }
    return config.defaultModeId;
  }

  function prepareNaturalTurn(guildId: string, observedAt: number): void {
    globalRuntime.reconcile(observedAt);
    const guildRuntime = ensureGuildRuntime(guildId);
    guildRuntime.reconcile(observedAt);
    if (config === undefined) return;
    for (const mode of config.modes) {
      const runtime = runtimeForMode(mode, guildId);
      if (runtime.isModeActive(mode.id, observedAt)) return;
      if (mode.activation?.type === "triggeredEpisode" && runtime.activateEligibleMode(mode.id, observedAt)) return;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      globalRuntime.start();
      for (const guildId of options.guildIds()) ensureGuildRuntime(guildId);
    },

    stop() {
      running = false;
      globalRuntime.stop();
      for (const runtime of guildRuntimes.values()) runtime.stop();
    },

    update(nextConfig, nextTimezone) {
      config = nextConfig;
      timezone = nextTimezone;
      globalRuntime.update(contextConfig(nextConfig, "global"), nextTimezone);
      for (const runtime of guildRuntimes.values()) runtime.update(contextConfig(nextConfig, "guild"), nextTimezone);
      for (const guildId of options.guildIds()) ensureGuildRuntime(guildId);
    },

    prepareNaturalTurn(guildId, observedAt = now()) {
      prepareNaturalTurn(guildId, observedAt);
    },

    noteVisibleTurn(guildId, observedAt = now()) {
      const winner = winningModeId(guildId, observedAt);
      globalRuntime.noteVisibleTurn(observedAt, winner);
      ensureGuildRuntime(guildId).noteVisibleTurn(observedAt, winner);
    },

    renderPromptContext(guildId, observedAt = now()) {
      const globalState = globalRuntime.renderPromptState(observedAt);
      const guildState = ensureGuildRuntime(guildId).renderPromptState(observedAt);
      const winner = winningModeId(guildId, observedAt);
      const active = guildState.active?.id === winner ? guildState.active : globalState.active;
      if (active === undefined) return "";
      return [
        `Active mode: '${active.id}'.`,
        ...(active.instructions === "" ? [] : [active.instructions]),
        ...globalState.supplements,
        ...guildState.supplements,
      ].join("\n\n");
    },

    reapplyPresentation() {
      globalRuntime.reapplyPresentation();
      for (const runtime of guildRuntimes.values()) runtime.reapplyPresentation();
    },

    activeModeId(guildId, observedAt = now()) {
      return winningModeId(guildId, observedAt);
    },

    getStatus(observedAt = now()) {
      const globalStatus = globalRuntime.getStatus(observedAt);
      const guilds = options.guildIds().map((guildId) => ({
        guildId,
        status: ensureGuildRuntime(guildId).getStatus(observedAt),
      }));
      return {
        ...globalStatus,
        timezone,
        guilds,
      };
    },
  };
}
