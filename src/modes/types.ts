/** Discord presence statuses supported by persona modes. */
export type PersonaModePresenceStatus = "online" | "idle" | "dnd" | "invisible";

/** Bot activity types supported by Discord's Gateway presence payload. */
export type PersonaModeActivityType = "playing" | "streaming" | "listening" | "watching" | "custom" | "competing";

/** Whether a mode is shared by the bot or evaluated independently per guild. */
export type PersonaModeScope = "global" | "guild";

/** One validated avatar candidate discovered from a profile mode directory. */
export interface PersonaModeAvatarCandidate {
  id: string;
  path: string;
  contentHash: string;
}

/** Daily local-time window. Equal start/end means a full-day window. */
export interface PersonaModeWindow {
  start: string;
  end: string;
}

/** Optional Gateway presence applied while a mode is active. */
export interface PersonaModePresence {
  status: PersonaModePresenceStatus;
  activity?: {
    type: PersonaModeActivityType;
    name: string;
    state?: string;
    url?: string;
  };
}

/** Deterministic mode activation over one or more daily local-time windows. */
export interface ScheduledWindowActivation {
  type: "scheduledWindow";
  windows: PersonaModeWindow[];
}

/** Rare preplanned opportunity that activates only on a natural agent turn. */
export interface TriggeredEpisodeActivation {
  type: "triggeredEpisode";
  minIntervalMs: number;
  maxIntervalMs: number;
  cooldownMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  opportunityWindows: PersonaModeWindow[];
  maxVisibleTurns: number;
}

export type PersonaModeActivation = ScheduledWindowActivation | TriggeredEpisodeActivation;

/** Fully resolved profile-local persona mode. */
export interface PersonaMode {
  id: string;
  scope: PersonaModeScope;
  instructions: string;
  avatars: PersonaModeAvatarCandidate[];
  activation?: PersonaModeActivation;
  avatarRotation?: {
    minIntervalMs: number;
    maxIntervalMs: number;
  };
  presence?: PersonaModePresence;
  leadIn?: {
    durationMs: number;
    instructions: string;
  };
  aftermath?: {
    maxAgeMs: number;
    consumeOnVisibleTurn: boolean;
    instructions: string;
  };
}

/** Resolved profile-level persona mode configuration. Earlier modes win precedence. */
export interface PersonaModesConfig {
  defaultModeId: string;
  modes: PersonaMode[];
}

export interface PersonaModeYaml {
  id?: unknown;
  scope?: unknown;
  instructions?: unknown;
  avatar?: {
    rotation?: {
      minInterval?: unknown;
      maxInterval?: unknown;
    };
  };
  presence?: {
    status?: unknown;
    activity?: {
      type?: unknown;
      name?: unknown;
      state?: unknown;
      url?: unknown;
    };
  };
  activation?: {
    type?: unknown;
    windows?: unknown;
    minInterval?: unknown;
    maxInterval?: unknown;
    cooldown?: unknown;
    minDuration?: unknown;
    maxDuration?: unknown;
    opportunityWindows?: unknown;
    maxVisibleTurns?: unknown;
  };
  leadIn?: {
    duration?: unknown;
    instructions?: unknown;
  };
  aftermath?: {
    maxAge?: unknown;
    consumeOnVisibleTurn?: unknown;
    instructions?: unknown;
  };
}

/** Raw profile YAML shape for persona modes. */
export interface PersonaModesConfigYaml {
  default?: unknown;
  modes?: unknown;
}
