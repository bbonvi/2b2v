import type { TtsConfig, VoicePreset } from "../tts/types.ts";

/** UI language for VPN panel. */
export type UiLang = "en" | "ru";

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

/** Async agent job configuration. Currently only image generation uses it. */
export interface AgentJobsConfig {
  /** Maximum runtime for one async image generation job. Default 300000. */
  imageTimeoutMs: number;
  /** Window where active image jobs can be cancelled/replaced for corrections. Default 60000. */
  imageCancelGraceMs: number;
  /** How long terminal jobs stay visible in prompt context. Default 600000. */
  terminalVisibleMs: number;
  /** Maximum replacement cancellations per original image request. Default 2. */
  maxImageReplacements: number;
}

/** Prompt caching controls. */
export interface PromptCachingConfig {
  enabled: boolean;
}

/** Supported hosted LLM backends. */
export type LlmProvider = "openrouter" | "openai-codex";

/** Reasoning effort requested from providers that expose thinking controls. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

/** Service tier override for providers that support it. */
export type ServiceTier = "flex" | "priority";

/** Dedicated background LLM configuration. */
export interface BackgroundLlmConfig {
  /** Provider used for background LLM work. */
  provider?: LlmProvider;
  /** Effective model id for background LLM work. */
  model: string;
  /** Effective provider request parameters for background LLM work. */
  modelParams: Record<string, unknown>;
  /** Optional reasoning effort requested for background LLM work. */
  thinkingLevel?: ThinkingLevel;
  /** Optional service tier. Undefined means no provider service tier is sent. */
  serviceTier?: ServiceTier;
  /** Prompt caching controls for background LLM work. */
  promptCaching: PromptCachingConfig;
}

/** Global defaults for background LLM configuration. Missing fields inherit main model settings per guild. */
export interface BackgroundLlmDefaults {
  provider?: LlmProvider;
  model?: string;
  modelParams: Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
  serviceTier?: ServiceTier;
  promptCaching?: PromptCachingConfig;
}

/** Dedicated image-reading fallback configuration. */
export interface ImageReadingConfig {
  /** Whether to describe images with a separate vision model when the main model cannot read them. */
  fallbackEnabled: boolean;
  /** Provider used for fallback image descriptions. */
  fallbackProvider?: LlmProvider;
  /** Model id used for fallback image descriptions. */
  fallbackModel: string;
  /** Provider request parameters for fallback image description calls. */
  fallbackModelParams: Record<string, unknown>;
}

/** Quality sent to Codex image generation. */
export type ImageGenerationQuality = "auto" | "low" | "medium" | "high";

/** Dedicated image-generation request configuration. */
export interface ImageGenerationConfig {
  /** Quality passed to the backend image_generation tool. Default auto. */
  quality: ImageGenerationQuality;
}

/** Native reply/tool loop runtime limits. */
export interface ReplyLoopConfig {
  /** Hard cap on tool calls allowed in one agent run. */
  maxToolCalls: number;
  /** Wall-clock budget before tool gathering stops and a final no-tools reply is forced. */
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
  llmProvider?: LlmProvider;
  model?: string;
  modelParams?: Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
  timezone: string;
  trim: TrimConfig;
  adminUserIds: string[];
  /** Longest edge for canonical stored user images. */
  imageMaxDimension: number;
  mergeMessageGapSeconds: number;
  imageReadMaxPerCall: number;
  imageCaptioningEnabled: boolean;
  /** Dedicated fallback for image tool results when the main model cannot read image input. */
  imageReading: ImageReadingConfig;
  /** Dedicated image-generation request settings. */
  imageGeneration: ImageGenerationConfig;
  attachmentsDir: string;
  instructions: string;
  tts?: TtsConfig;
  /** Emote/emoji context configuration. */
  emotes: EmotesConfig;
  /** Server members list configuration. */
  members: MembersConfig;
  /** Channel dispatcher configuration. */
  dispatcher: DispatcherConfig;
  /** Async agent job configuration. */
  agentJobs: AgentJobsConfig;
  /** Prompt caching controls for supported provider requests. */
  promptCaching: PromptCachingConfig;
  /** Dedicated background LLM configuration. */
  backgroundLlm: BackgroundLlmConfig;
  /** Native reply/tool loop runtime limits. */
  replyLoop: ReplyLoopConfig;
}

/** Global configuration loaded from file + env. */
export interface GlobalConfig {
  discordToken: string;
  openrouterApiKey?: string;
  codexAuthPath: string;
  braveApiKey?: string;
  defaultLlmProvider: LlmProvider;
  defaultModel: string;
  defaultModelParams: Record<string, unknown>;
  defaultThinkingLevel?: ThinkingLevel;
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
  /** Default image-generation request settings. */
  defaultImageGeneration: ImageGenerationConfig;
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
  /** Default emotes configuration. */
  defaultEmotes: EmotesConfig;
  /** Default members configuration. */
  defaultMembers: MembersConfig;
  /** Default dispatcher configuration. */
  defaultDispatcher: DispatcherConfig;
  /** Default async agent job configuration. */
  defaultAgentJobs: AgentJobsConfig;
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
  llmProvider?: LlmProvider;
  model?: string;
  modelParams?: Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
  timezone?: string;
  trim?: Partial<TrimConfig>;
  adminUserIds?: string[];
  imageMaxDimension?: number;
  mergeMessageGapSeconds?: number;
  imageReadMaxPerCall?: number;
  imageCaptioningEnabled?: boolean;
  imageReading?: {
    fallbackEnabled?: boolean;
    fallbackProvider?: LlmProvider;
    fallbackModel?: string;
    fallbackModelParams?: Record<string, unknown>;
  };
  imageGeneration?: {
    quality?: ImageGenerationQuality;
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
  agentJobs?: {
    imageTimeoutMs?: number;
    imageCancelGraceMs?: number;
    terminalVisibleMs?: number;
    maxImageReplacements?: number;
  };
  promptCaching?: {
    enabled?: boolean;
  };
  backgroundLlm?: {
    provider?: LlmProvider;
    model?: string;
    modelParams?: Record<string, unknown>;
    thinkingLevel?: ThinkingLevel;
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
  llmProvider?: LlmProvider;
  model?: string;
  modelParams?: Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
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
    fallbackProvider?: LlmProvider;
    fallbackModel?: string;
    fallbackModelParams?: Record<string, unknown>;
  };
  imageGeneration?: {
    quality?: ImageGenerationQuality;
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
  agentJobs?: {
    imageTimeoutMs?: number;
    imageCancelGraceMs?: number;
    terminalVisibleMs?: number;
    maxImageReplacements?: number;
  };
  promptCaching?: {
    enabled?: boolean;
  };
  backgroundLlm?: {
    provider?: LlmProvider;
    model?: string;
    modelParams?: Record<string, unknown>;
    thinkingLevel?: ThinkingLevel;
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
