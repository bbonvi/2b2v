import type { Database } from "../db/database.ts";
import type {
  PersonaMode,
  PersonaModeAvatarCandidate,
  PersonaModePresence,
  PersonaModesConfig,
} from "./types.ts";
import {
  contextConfig,
  createPersonaModeContextRuntime,
  type PersonaModeContextRuntime,
  type PersonaModeContextStatus,
  type PersonaModeLogger,
  type PersonaModeTimers,
} from "./context-runtime.ts";

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
  trackBackgroundTask?: (task: Promise<void>) => void;
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
    trackBackgroundTask: options.trackBackgroundTask,
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
      trackBackgroundTask: options.trackBackgroundTask,
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
    for (let index = config.modes.length - 1; index >= 0; index -= 1) {
      const mode = config.modes[index];
      if (mode === undefined || mode.id === config.defaultModeId) continue;
      if (runtimeForMode(mode, guildId).isModeActive(mode.id, observedAt)) return mode.id;
    }
    return config.defaultModeId;
  }

  function prepareNaturalTurn(guildId: string, observedAt: number): void {
    globalRuntime.reconcile(observedAt);
    const guildRuntime = ensureGuildRuntime(guildId);
    guildRuntime.reconcile(observedAt);
    if (config === undefined) return;
    for (let index = config.modes.length - 1; index >= 0; index -= 1) {
      const mode = config.modes[index];
      if (mode === undefined || mode.id === config.defaultModeId) continue;
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
