export const PRIVATE_LIFE_ATTENTION_ORIGINS = [
  "spontaneous",
  "continue-inner-thread",
  "recent-residue",
] as const;

export type PrivateLifeAttentionOrigin = typeof PRIVATE_LIFE_ATTENTION_ORIGINS[number];

export const PRIVATE_LIFE_CURIOSITY_MODES = [
  "unstructured",
  "investigate",
  "make-or-change",
  "imagine-possibility",
  "offscreen-event-candidate",
  "social-impulse",
  "observe-or-collect",
] as const;

export type PrivateLifeCuriosityMode = typeof PRIVATE_LIFE_CURIOSITY_MODES[number];

export const PRIVATE_LIFE_ACTION_SCOPES = [
  "reflect-only",
  "quiet-exploration",
  "private-action",
  "social-opportunity",
] as const;

export type PrivateLifeActionScope = typeof PRIVATE_LIFE_ACTION_SCOPES[number];

export const PRIVATE_LIFE_TERRITORIES = [
  "open",
  "external",
  "technical-material",
  "creative-aesthetic",
  "mundane-private",
  "embodied",
  "sexual",
  "social-personal",
  "community",
  "transgressive-ugly",
  "playful-absurd",
] as const;

export type PrivateLifeTerritory = typeof PRIVATE_LIFE_TERRITORIES[number];

export type PrivateLifeWeights<T extends string> = Record<T, number>;

export interface PrivateLifeConfig {
  enabled: boolean;
  modelProfile: string;
  opportunitiesPerDay: number;
  intervalJitter: number;
  lateNightStart: string;
  sleepStart: string;
  sleepEnd: string;
  lateNightRateMultiplier: number;
  sleepRateMultiplier: number;
  allowVisibleOutput: boolean;
  maxVisiblePerDay: number;
  visibleOutputCooldownMinutes: number;
  maxToolCalls: number;
  recentThemeLimit: number;
  recentResidueHistoryLimit: number;
  recentResidueMaxAgeHours: number;
  candidateCount: number;
  thoughtRetentionDays: number;
  originWeights: PrivateLifeWeights<PrivateLifeAttentionOrigin>;
  modeWeights: PrivateLifeWeights<PrivateLifeCuriosityMode>;
  territoryWeights: PrivateLifeWeights<PrivateLifeTerritory>;
  actionScopeWeights: PrivateLifeWeights<PrivateLifeActionScope>;
}

type PartialWeights<T extends string> = Partial<Record<T, number>>;

export type PrivateLifeConfigYaml = Partial<Omit<
  PrivateLifeConfig,
  "originWeights" | "modeWeights" | "territoryWeights" | "actionScopeWeights"
>> & {
  originWeights?: PartialWeights<PrivateLifeAttentionOrigin>;
  modeWeights?: PartialWeights<PrivateLifeCuriosityMode>;
  territoryWeights?: PartialWeights<PrivateLifeTerritory>;
  actionScopeWeights?: PartialWeights<PrivateLifeActionScope>;
};

export type PrivateLifeDayPhase = "day" | "late-night" | "sleep-window";

export interface PrivateLifeSelection {
  origin: PrivateLifeAttentionOrigin;
  mode: PrivateLifeCuriosityMode;
  territory: PrivateLifeTerritory;
  actionScope: PrivateLifeActionScope;
  candidateSeeds: string[];
  continuedThreadId?: string;
  continuedThreadContent?: string;
}

export interface PrivateLifeEpisodeSummary {
  label: string;
  themeKey: string;
  facets: string[];
}
