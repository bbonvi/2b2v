import type { TtsConfig, VoicePreset } from "../tts/types.ts";

/** UI language for VPN panel. */
export type UiLang = "en" | "ru";

/** Bash tool configuration. Controls remote shell execution via SSH. */
export interface BashToolConfig {
  /** Whether the bash tool is enabled. Both global and guild must be true for tool to be available. */
  enabled: boolean;
  /** SSH connection settings for the bash-vm service. */
  ssh: {
    host: string;
    port: number;
    user: string;
  };
  /** Command execution timeout in milliseconds. Default 5000. */
  timeoutMs: number;
  /** Max output characters after redaction. Default 4000. */
  outputLimit: number;
  /** Regex patterns for blocked commands. Commands matching any pattern are rejected. */
  blocklist: string[];
}

/** VPN configuration (WireGuard profile management). */
export interface VpnConfig {
  enabled: boolean;
  apiUrl: string;
  vpnPeer: string;
}

/** Emote/emoji context configuration. */
export interface EmotesConfig {
  /** Whether to include available emojis in LLM context. Default false. */
  include: boolean;
}

/** Trigger configuration per guild. All independently toggleable. */
export interface TriggerConfig {
  mention: boolean;
  keywords: string[];
  randomChance: number; // 0–1
}

/** Per-trigger-type custom instructions injected into agent context. */
export interface TriggerInstructions {
  mention?: string;
  keyword?: string;
  random?: string;
  scheduled?: string;
}

/** Context window trimming thresholds (message count). */
export interface TrimConfig {
  trimTrigger: number;
  trimTarget: number;
  windowSize: number;
  messageCharLimit: number;
  replyQuoteChars: number;
}

/** Per-guild configuration. Source of truth is the YAML file. */
export interface GuildConfig {
  guildId: string;
  slug: string;
  triggers: TriggerConfig;
  triggerInstructions: TriggerInstructions;
  model?: string;
  modelParams?: Record<string, unknown>;
  thinkingLevel?: string;
  timezone: string;
  trim: TrimConfig;
  memoryRetentionDays: number;
  adminUserIds: string[];
  imageMaxDimension: number;
  mergeMessageGapSeconds: number;
  imageReadMaxPerCall: number;
  imageCaptioningEnabled: boolean;
  attachmentsDir: string;
  instructions: string;
  tts?: TtsConfig;
  /** Bash tool configuration. Undefined when disabled for this guild. */
  bashTool?: BashToolConfig;
  /** Emote/emoji context configuration. */
  emotes: EmotesConfig;
}

/** Global configuration loaded from file + env. */
export interface GlobalConfig {
  discordToken: string;
  openrouterApiKey: string;
  braveApiKey?: string;
  defaultModel: string;
  defaultModelParams: Record<string, unknown>;
  defaultThinkingLevel?: string;
  defaultTimezone: string;
  defaultTrim: TrimConfig;
  defaultTriggers: TriggerConfig;
  defaultTriggerInstructions: TriggerInstructions;
  defaultMemoryRetentionDays: number;
  defaultImageMaxDimension: number;
  defaultMergeMessageGapSeconds: number;
  defaultImageReadMaxPerCall: number;
  defaultImageCaptioningEnabled: boolean;
  defaultAttachmentsDir: string;
  defaultInstructions: string;
  personaPath: string;
  logLevel: string;
  dataDir: string;
  modelCacheDir: string;
  qdrantUrl: string;
  elevenLabsApiKey?: string;
  defaultTts?: TtsConfig;
  /** UI language for VPN panel. */
  uiLang: UiLang;
  /** VPN configuration. Undefined when disabled. */
  vpn?: VpnConfig;
  /** Default bash tool configuration. Undefined when disabled globally. */
  defaultBashTool?: BashToolConfig;
  /** Default emotes configuration. */
  defaultEmotes: EmotesConfig;
}

/** Full resolved app config. */
export interface AppConfig {
  global: GlobalConfig;
  guilds: Map<string, GuildConfig>;
}

/** Raw shape of a guild YAML file (partial, all fields optional). */
export interface GuildConfigYaml {
  triggers?: Partial<TriggerConfig>;
  triggerInstructions?: Partial<TriggerInstructions>;
  model?: string;
  modelParams?: Record<string, unknown>;
  thinkingLevel?: string;
  timezone?: string;
  trim?: Partial<TrimConfig>;
  memoryRetentionDays?: number;
  adminUserIds?: string[];
  imageMaxDimension?: number;
  mergeMessageGapSeconds?: number;
  imageReadMaxPerCall?: number;
  imageCaptioningEnabled?: boolean;
  attachmentsDir?: string;
  instructions?: string;
  instructionsPath?: string;
  tts?: Partial<TtsConfig> & { voices?: { normal?: Partial<VoicePreset>; whisper?: Partial<VoicePreset> } };
  bashTool?: {
    enabled?: boolean;
  };
  emotes?: {
    include?: boolean;
  };
}

/** Raw shape of the main config YAML file (config/config.yaml). All optional. */
export interface MainConfigYaml {
  model?: string;
  modelParams?: Record<string, unknown>;
  thinkingLevel?: string;
  timezone?: string;
  trim?: Partial<TrimConfig>;
  triggers?: Partial<TriggerConfig>;
  triggerInstructions?: Partial<TriggerInstructions>;
  memoryRetentionDays?: number;
  imageMaxDimension?: number;
  mergeMessageGapSeconds?: number;
  imageReadMaxPerCall?: number;
  imageCaptioningEnabled?: boolean;
  attachmentsDir?: string;
  personaPath?: string;
  instructions?: string;
  instructionsPath?: string;
  logLevel?: string;
  dataDir?: string;
  modelCacheDir?: string;
  qdrantUrl?: string;
  tts?: Partial<TtsConfig> & { voices?: { normal?: Partial<VoicePreset>; whisper?: Partial<VoicePreset> } };
  uiLang?: string;
  vpn?: {
    enabled?: boolean;
    apiUrl?: string;
    vpnPeer?: string;
  };
  bashTool?: {
    enabled?: boolean;
    ssh?: {
      host?: string;
      port?: number;
      user?: string;
    };
    timeoutMs?: number;
    outputLimit?: number;
    blocklist?: string[];
  };
  emotes?: {
    include?: boolean;
  };
}
