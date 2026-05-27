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

/** Channel dispatcher configuration. Controls debounce and per-channel serialization. */
export interface DispatcherConfig {
  /** Whether the channel dispatcher is enabled. Default true. */
  enabled: boolean;
  /** Debounce ms for mention triggers. Default 500. */
  mentionDebounceMs: number;
  /** Debounce ms for non-mention triggers (keyword, random). Default 2000. */
  defaultDebounceMs: number;
}

/** Prompt caching controls. */
export interface PromptCachingConfig {
  enabled: boolean;
}

/** OpenRouter service tier override for background LLM calls. */
export type ServiceTier = "flex" | "priority";

/** Dedicated background LLM configuration. */
export interface BackgroundLlmConfig {
  /** Effective model id for background LLM work. */
  model: string;
  /** Effective OpenRouter request parameters for background LLM work. */
  modelParams: Record<string, unknown>;
  /** Optional reasoning level marker retained for config symmetry. */
  thinkingLevel?: string;
  /** Optional OpenRouter service tier. Undefined means no service_tier is sent. */
  serviceTier?: ServiceTier;
  /** Prompt caching controls for background LLM work. */
  promptCaching: PromptCachingConfig;
}

/** Global defaults for background LLM configuration. Missing fields inherit main model settings per guild. */
export interface BackgroundLlmDefaults {
  model?: string;
  modelParams: Record<string, unknown>;
  thinkingLevel?: string;
  serviceTier?: ServiceTier;
  promptCaching?: PromptCachingConfig;
}

/** Dedicated image-reading fallback configuration. */
export interface ImageReadingConfig {
  /** Whether to describe images with a separate vision model when the main model cannot read them. */
  fallbackEnabled: boolean;
  /** OpenRouter model id used for fallback image descriptions. */
  fallbackModel: string;
  /** OpenRouter request parameters for fallback image description calls. */
  fallbackModelParams: Record<string, unknown>;
}

/** Native reply/tool loop runtime limits. */
export interface ReplyLoopConfig {
  /** Max tool calls allowed in one agent run. */
  maxToolCalls: number;
  /** Absolute wall-clock timeout for one agent run. */
  wallClockTimeoutMs: number;
  /** Timeout for a single model output turn. */
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

/** Ordered prompt source chain for persona, optional tool guidance, and style sections. */
export type PromptSource = PromptFileSource | PromptInlineSource;

/** Config-driven prompt profile. `lateInstructions` is the stable style prompt. */
export interface PromptProfileConfig {
  persona: PromptSource[];
  toolInstructions: PromptSource[];
  instructions: PromptSource[];
  lateInstructions: PromptSource[];
}

/** Trigger configuration per guild. All independently toggleable. */
export interface TriggerConfig {
  mention: boolean;
  keywords: string[];
  randomChance: number; // 0–1
  /** Debounce ms after a keyword trigger before the agent runs. */
  keywordDebounceMs: number;
  /** Treat a typingStart from the keyword-triggering user as active for this long. */
  typingIdleMs: number;
  /** Maximum extra wait after a keyword trigger, even if typing keeps refreshing. */
  typingMaxWaitMs: number;
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
  adminUserIds: string[];
  imageMaxDimension: number;
  mergeMessageGapSeconds: number;
  imageReadMaxPerCall: number;
  imageCaptioningEnabled: boolean;
  /** Dedicated fallback for image tool results when the main model cannot read image input. */
  imageReading: ImageReadingConfig;
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
  /** Dedicated background LLM configuration. */
  backgroundLlm: BackgroundLlmConfig;
  /** Native reply/tool loop runtime limits. */
  replyLoop: ReplyLoopConfig;
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
  defaultImageMaxDimension: number;
  defaultMergeMessageGapSeconds: number;
  defaultImageReadMaxPerCall: number;
  defaultImageCaptioningEnabled: boolean;
  /** Default fallback for image tool results when the main model cannot read image input. */
  defaultImageReading: ImageReadingConfig;
  defaultAttachmentsDir: string;
  defaultInstructions: string;
  defaultLateInstruction: string;
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
  /** Default background LLM overrides. Missing fields inherit main model settings per guild. */
  defaultBackgroundLlm: BackgroundLlmDefaults;
  /** Default native reply/tool loop runtime limits. */
  defaultReplyLoop: ReplyLoopConfig;
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
  adminUserIds?: string[];
  imageMaxDimension?: number;
  mergeMessageGapSeconds?: number;
  imageReadMaxPerCall?: number;
  imageCaptioningEnabled?: boolean;
  imageReading?: {
    fallbackEnabled?: boolean;
    fallbackModel?: string;
    fallbackModelParams?: Record<string, unknown>;
  };
  attachmentsDir?: string;
  instructions?: string;
  instructionsPath?: string;
  tts?: Partial<TtsConfig> & {
    voices?: {
      normal?: Partial<VoicePreset>;
      /** Obsolete; ignored by runtime and kept only while old YAML is migrated away. */
      whisper?: Partial<VoicePreset>;
    };
  };
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
  };
  promptCaching?: {
    enabled?: boolean;
  };
  backgroundLlm?: {
    model?: string;
    modelParams?: Record<string, unknown>;
    thinkingLevel?: string;
    serviceTier?: ServiceTier;
    promptCaching?: {
      enabled?: boolean;
    };
  };
  replyLoop?: {
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
  imageMaxDimension?: number;
  mergeMessageGapSeconds?: number;
  imageReadMaxPerCall?: number;
  imageCaptioningEnabled?: boolean;
  imageReading?: {
    fallbackEnabled?: boolean;
    fallbackModel?: string;
    fallbackModelParams?: Record<string, unknown>;
  };
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
    lateInstructions?: Array<{
      file?: string;
      text?: string;
      optional?: boolean;
    }>;
  };
  logLevel?: string;
  dataDir?: string;
  modelCacheDir?: string;
  qdrantUrl?: string;
  tts?: Partial<TtsConfig> & {
    voices?: {
      normal?: Partial<VoicePreset>;
      /** Obsolete; ignored by runtime and kept only while old YAML is migrated away. */
      whisper?: Partial<VoicePreset>;
    };
  };
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
  };
  promptCaching?: {
    enabled?: boolean;
  };
  backgroundLlm?: {
    model?: string;
    modelParams?: Record<string, unknown>;
    thinkingLevel?: string;
    serviceTier?: ServiceTier;
    promptCaching?: {
      enabled?: boolean;
    };
  };
  replyLoop?: {
    maxToolCalls?: number;
    wallClockTimeoutMs?: number;
    llmOutputTimeoutMs?: number;
  };
}
