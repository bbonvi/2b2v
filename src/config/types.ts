/** Trigger configuration per guild. All independently toggleable. */
export interface TriggerConfig {
  mention: boolean;
  keywords: string[];
  randomChance: number; // 0–1
}

/** Context window trimming thresholds (message count). */
export interface TrimConfig {
  trimTrigger: number;
  trimTarget: number;
}

/** Per-guild configuration. Source of truth is the YAML file. */
export interface GuildConfig {
  guildId: string;
  slug: string;
  triggers: TriggerConfig;
  model?: string;
  modelParams?: Record<string, unknown>;
  thinkingLevel: string;
  timezone: string;
  trim: TrimConfig;
  memoryRetentionDays: number;
  adminUserIds: string[];
  imageMaxDimension: number;
}

/** Global configuration loaded from file + env. */
export interface GlobalConfig {
  discordToken: string;
  openrouterApiKey: string;
  braveApiKey?: string;
  defaultModel: string;
  defaultThinkingLevel: string;
  defaultTimezone: string;
  defaultTrim: TrimConfig;
  defaultMemoryRetentionDays: number;
  defaultImageMaxDimension: number;
  personaPath: string;
  logLevel: string;
  dataDir: string;
  modelCacheDir: string;
  qdrantUrl: string;
}

/** Full resolved app config. */
export interface AppConfig {
  global: GlobalConfig;
  guilds: Map<string, GuildConfig>;
}

/** Raw shape of a guild YAML file (partial, all fields optional). */
export interface GuildConfigYaml {
  triggers?: Partial<TriggerConfig>;
  model?: string;
  modelParams?: Record<string, unknown>;
  thinkingLevel?: string;
  timezone?: string;
  trim?: Partial<TrimConfig>;
  memoryRetentionDays?: number;
  adminUserIds?: string[];
  imageMaxDimension?: number;
}
