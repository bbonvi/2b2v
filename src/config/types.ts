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

/** Server members list configuration. */
export interface MembersConfig {
  /** Whether to include server members list in LLM context. Default true. */
  include: boolean;
}

/** Channel dispatcher configuration. Controls debounce and follow-up awareness. */
export interface DispatcherConfig {
  /** Whether the channel dispatcher is enabled. Default true. */
  enabled: boolean;
  /** Debounce ms for mention triggers. Default 500. */
  mentionDebounceMs: number;
  /** Debounce ms for non-mention triggers (keyword, random). Default 2000. */
  defaultDebounceMs: number;
  /** Max follow-up messages to surface per tool check. Default 5. */
  maxFollowUps: number;
}

/** Prompt caching controls. */
export interface PromptCachingConfig {
  enabled: boolean;
}

/** Structured action loop runtime limits. */
export interface ActionLoopConfig {
  /** Max tool calls allowed in one agent run. */
  maxToolCalls: number;
  /** Absolute wall-clock timeout for one agent run. */
  wallClockTimeoutMs: number;
  /** Timeout for a single model output turn before retry feedback. */
  llmOutputTimeoutMs: number;
}

/** File-based source for prompt profile content. */
export interface PromptFileSource {
  kind: "file";
  path: string;
  optional: boolean;
}

/** Inline text source for prompt profile content. */
export interface PromptInlineSource {
  kind: "inline";
  text: string;
}

/** Ordered prompt source chain for persona/tool/instructions sections. */
export type PromptSource = PromptFileSource | PromptInlineSource;

/** Config-driven prompt profile for stable instruction sections. */
export interface PromptProfileConfig {
  persona: PromptSource[];
  toolInstructions: PromptSource[];
  instructions: PromptSource[];
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
  /** Server members list configuration. */
  members: MembersConfig;
  /** Channel dispatcher configuration. */
  dispatcher: DispatcherConfig;
  /** Prompt caching controls for OpenRouter requests. */
  promptCaching: PromptCachingConfig;
  /** Structured action loop runtime limits. */
  actionLoop: ActionLoopConfig;
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
  promptProfile: PromptProfileConfig;
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
  /** Default members configuration. */
  defaultMembers: MembersConfig;
  /** Default dispatcher configuration. */
  defaultDispatcher: DispatcherConfig;
  /** Default prompt caching controls. */
  defaultPromptCaching: PromptCachingConfig;
  /** Default structured action loop runtime limits. */
  defaultActionLoop: ActionLoopConfig;
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
  members?: {
    include?: boolean;
  };
  dispatcher?: {
    enabled?: boolean;
    mentionDebounceMs?: number;
    defaultDebounceMs?: number;
    maxFollowUps?: number;
  };
  promptCaching?: {
    enabled?: boolean;
  };
  actionLoop?: {
    maxToolCalls?: number;
    wallClockTimeoutMs?: number;
    llmOutputTimeoutMs?: number;
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
  promptProfile?: {
    persona?: Array<{
      file?: string;
      text?: string;
      optional?: boolean;
    }>;
    toolInstructions?: Array<{
      file?: string;
      text?: string;
      optional?: boolean;
    }>;
    instructions?: Array<{
      file?: string;
      text?: string;
      optional?: boolean;
    }>;
  };
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
  members?: {
    include?: boolean;
  };
  dispatcher?: {
    enabled?: boolean;
    mentionDebounceMs?: number;
    defaultDebounceMs?: number;
    maxFollowUps?: number;
  };
  promptCaching?: {
    enabled?: boolean;
  };
  actionLoop?: {
    maxToolCalls?: number;
    wallClockTimeoutMs?: number;
    llmOutputTimeoutMs?: number;
  };
}
