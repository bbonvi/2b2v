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
  /** Debounce ms for mention triggers when typing-aware waits are disabled. Default 500. */
  mentionDebounceMs: number;
  /** Debounce ms for non-mention triggers (keyword, random). Default 2000. */
  defaultDebounceMs: number;
}

/** Human-paced typing indicator delays for visible Discord replies. */
export interface TypingSimulationConfig {
  /** Whether word-scaled typing simulation is enabled. Default false. */
  enabled: boolean;
  /** Reading speed used for hidden delay before the typing indicator appears after the agent starts. */
  inputReadingWpm: number;
  /** Minimum hidden typing-indicator delay for non-empty input. */
  inputMinDelayMs: number;
  /** Maximum hidden typing-indicator delay. */
  inputMaxDelayMs: number;
  /** Typing speed used for visible typing time before each message segment sends. */
  outputTypingWpm: number;
  /** Minimum visible typing time before each non-empty outgoing message segment sends. */
  outputMinHoldMs: number;
  /** Maximum visible typing hold before each outgoing message segment sends. */
  outputMaxHoldMs: number;
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

/** Hard caps for non-admin recurring scheduled-task pressure. */
export interface SchedulePressureConfig {
  maxRequesterRunsPerHour: number;
  maxRequesterRunsPerDay: number;
  maxGuildRunsPerHour: number;
  maxGuildRunsPerDay: number;
}

export type SchedulePressureConfigYaml = Partial<SchedulePressureConfig>;

/** Prompt caching controls. */
export interface PromptCachingConfig {
  enabled: boolean;
}

/** Prompt transport sections whose provider role/target can be tuned. */
export type PromptTransportSectionId =
  | "system"
  | "core"
  | "skills"
  | "runtime"
  | "stableContext"
  | "olderHistory"
  | "serverMembers"
  | "threadsInChannel"
  | "discordContext"
  | "upcomingSchedules"
  | "memories"
  | "recentHistory"
  | "currentContext"
  | "responseInstruction"
  | "currentTurn"
  | "finalActionInstruction";

/** LLM message roles supported by provider prompt transport. */
export type PromptTransportRole = "system" | "developer" | "user";

/** Where a stable Codex section is placed. OpenRouter always uses messages. */
export type PromptTransportTarget = "instructions" | "input";

/** Codex prompt transport mode. */
export type CodexPromptTransportMode = "legacy-instructions" | "split-input";

/** Placement policy for one logical prompt section. */
export interface PromptTransportSectionConfig {
  role: PromptTransportRole;
  target: PromptTransportTarget;
  cacheGroup?: string;
}

/** Provider-specific prompt transport policy. */
export interface ProviderPromptTransportConfig {
  mode: CodexPromptTransportMode;
  sections: Record<PromptTransportSectionId, PromptTransportSectionConfig>;
}

/** Prompt transport policy for all LLM providers. */
export interface PromptTransportConfig {
  openaiCodex: ProviderPromptTransportConfig;
  openrouter: ProviderPromptTransportConfig;
}

/** Supported hosted LLM backends. */
export type LlmProvider = "openrouter" | "openai-codex";

/** Reasoning effort requested from providers that expose thinking controls. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

/** Service tier override for providers that support it. */
export type ServiceTier = "flex" | "priority";

/** OpenAI Codex Responses transport. */
export type CodexTransport = "sse" | "websocket" | "websocket-cached" | "auto";

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

export type AmbientAttentionKind = "ambient_pickup" | "lingering_attention" | "follow_up";
export type AmbientInitiativeKind = "self_expression" | "targeted_checkin";

/** Shared evaluator model used by ambient attention candidate checks. */
export interface AmbientAttentionEvaluatorConfig {
  provider?: LlmProvider;
  model: string;
  modelParams: Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
  serviceTier?: ServiceTier;
  llmOutputTimeoutMs: number;
}

/** Per-mode ambient attention thresholds and timing. */
export interface AmbientAttentionModeConfig {
  enabled: boolean;
  minDelayMs: number;
  maxDelayMs: number;
  probabilityThreshold: number;
  confidenceThreshold: number;
  cooldownMs: number;
  typingActiveMs: number;
  maxRepliesPerUserPerHour: number;
  maxRepliesPerChannelPerHour: number;
  randomJitter: number;
  defaultReply: boolean;
}

/** Ambient attention behavior for quiet pickup, lingering attention, and follow-ups. */
export interface AmbientAttentionConfig {
  enabled: boolean;
  evaluator: AmbientAttentionEvaluatorConfig;
  historyLimit: number;
  busyWindowMs: number;
  busyMessageLimit: number;
  staleAfterMs: number;
  maxNewMessagesBeforeDrop: number;
  ambientPickup: AmbientAttentionModeConfig & {
    minQuietMs: number;
  };
  lingering: AmbientAttentionModeConfig & {
    strongWindowMs: number;
    weakWindowMs: number;
    typingExtensionMs: number;
    maxTypingExtensions: number;
  };
  followUp: AmbientAttentionModeConfig & {
    silenceMs: number;
    maxPerExchange: number;
  };
}

export type AmbientAttentionConfigYaml = Partial<Omit<
  AmbientAttentionConfig,
  "evaluator" | "ambientPickup" | "lingering" | "followUp"
>> & {
  evaluator?: Partial<AmbientAttentionEvaluatorConfig>;
  ambientPickup?: Partial<AmbientAttentionModeConfig & { minQuietMs: number }>;
  lingering?: Partial<AmbientAttentionModeConfig & {
    strongWindowMs: number;
    weakWindowMs: number;
    typingExtensionMs: number;
    maxTypingExtensions: number;
  }>;
  followUp?: Partial<AmbientAttentionModeConfig & {
    silenceMs: number;
    maxPerExchange: number;
  }>;
};

/** Shared evaluator model used by ambient initiative opportunity checks. */
export interface AmbientInitiativeEvaluatorConfig {
  provider?: LlmProvider;
  model: string;
  modelParams: Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
  serviceTier?: ServiceTier;
  llmOutputTimeoutMs: number;
}

/** Active local-time window where proactive speech may happen naturally. */
export interface AmbientInitiativeActiveHoursConfig {
  timezone?: string;
  start: string;
  end: string;
}

/** Per-kind proactive initiative pressure, budget, and timing controls. */
export interface AmbientInitiativeKindConfig {
  enabled: boolean;
  basePressure: number;
  pressureThreshold: number;
  probabilityThreshold: number;
  confidenceThreshold: number;
  cooldownMs: number;
  maxPerDay: number;
}

/** Ambient initiative behavior for proactive self-expression and check-ins. */
export interface AmbientInitiativeConfig {
  enabled: boolean;
  shadowMode: boolean;
  mainChannelId?: string;
  checkIntervalMinMs: number;
  checkIntervalMaxMs: number;
  activeHours: AmbientInitiativeActiveHoursConfig;
  historyLimit: number;
  recentActivityMinMs: number;
  recentActivityMaxMs: number;
  quietWindowMs: number;
  typingActiveMs: number;
  botCooldownMs: number;
  fatigueAfterAnyMs: number;
  maxPerDay: number;
  minMainChannelHumanMessages: number;
  mainChannelLookbackDays: number;
  evaluator: AmbientInitiativeEvaluatorConfig;
  selfExpression: AmbientInitiativeKindConfig;
  targetedCheckin: AmbientInitiativeKindConfig & {
    maxPerUserPerDay: number;
    openLoopMaxAgeMs: number;
  };
}

export type AmbientInitiativeConfigYaml = Partial<Omit<
  AmbientInitiativeConfig,
  "evaluator" | "activeHours" | "selfExpression" | "targetedCheckin"
>> & {
  activeHours?: Partial<AmbientInitiativeActiveHoursConfig>;
  evaluator?: Partial<AmbientInitiativeEvaluatorConfig>;
  selfExpression?: Partial<AmbientInitiativeKindConfig>;
  targetedCheckin?: Partial<AmbientInitiativeKindConfig & {
    maxPerUserPerDay: number;
    openLoopMaxAgeMs: number;
  }>;
};

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

/** Opaque Codex Responses continuation carried across nearby Discord turns. */
export interface ReasoningContinuationConfig {
  /** Whether to replay the latest encrypted Codex native continuation for the same user/channel. */
  enabled: boolean;
  /** Maximum age for a saved continuation before it is ignored. */
  maxAgeMs: number;
}

/** Trigger configuration per guild. All independently toggleable. */
export interface TriggerConfig {
  mention: boolean;
  keywords: string[];
  randomChance: number; // 0–1
  /** Debounce ms after a keyword trigger, and after typing-aware mention triggers, before the agent runs. */
  keywordDebounceMs: number;
  /** Treat typingStart from the keyword/mention-triggering user as active for this long. */
  typingIdleMs: number;
  /** Briefly wait after a same-author message clears recent typing, so continued typing can refresh. */
  typingResumeGraceMs: number;
  /** Maximum extra wait after a keyword/mention trigger, even if typing keeps refreshing. */
  typingMaxWaitMs: number;
}

/** Per-trigger-type custom instructions injected into agent context. */
export interface TriggerInstructions {
  mention?: string;
  keyword?: string;
  random?: string;
  scheduled?: string;
  ambient_pickup?: string;
  lingering_attention?: string;
  follow_up?: string;
  ambient_initiative?: string;
}

/** Context window trimming thresholds (message count). */
export interface TrimConfig {
  trimTrigger: number;
  trimTarget: number;
  windowSize: number;
  messageCharLimit: number;
  replyQuoteChars: number;
}

/** Automatic background memory extraction controls. */
export interface MemoryExtractionConfig {
  /** Run the existing silent memory pass after visible replies. */
  postReply: boolean;
  /** Maximum record_memory calls per silent maintenance pass. */
  maxToolCalls: number;
  /** Ambient extraction for non-triggered channel chatter. */
  ambient: {
    enabled: boolean;
    /** Human messages since the last successful memory pass before ambient extraction runs. */
    everyMessages: number;
    /** Maximum chronological messages reviewed in one ambient pass. */
    maxBatchMessages: number;
    /** Minimum seconds between ambient passes for the same channel. */
    minIntervalSeconds: number;
  };
}

/** Durable relationship-profile controls. */
export interface RelationshipConfig {
  enabled: boolean;
  promptInjection: boolean;
  maxAxisDeltaPerSignal: number;
  /** Maximum record_relationship calls per silent maintenance pass. */
  maxToolCalls: number;
}

export type RelationshipConfigYaml = Partial<RelationshipConfig>;

/** Limits for lazy message-asset reading and extraction. */
export interface AssetReadingConfig {
  maxCharsPerRead: number;
  textRangeBytes: number;
  maxDownloadBytes: number;
  maxTranscriptionDurationSeconds: number;
  videoPreviewMaxBytes: number;
  videoPreviewTimesSeconds: number[];
  videoPreviewTimeoutSeconds: number;
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
  assetReading?: AssetReadingConfig;
  instructions: string;
  tts?: TtsConfig;
  /** Emote/emoji context configuration. */
  emotes: EmotesConfig;
  /** Server members list configuration. */
  members: MembersConfig;
  /** Channel dispatcher configuration. */
  dispatcher: DispatcherConfig;
  /** Human-paced typing indicator delays. */
  typingSimulation: TypingSimulationConfig;
  /** Async agent job configuration. */
  agentJobs: AgentJobsConfig;
  /** Non-admin recurring scheduled-task pressure caps. */
  schedulePressure: SchedulePressureConfig;
  /** Prompt caching controls for supported provider requests. */
  promptCaching: PromptCachingConfig;
  /** Provider role/target placement for logical prompt sections. */
  promptTransport: PromptTransportConfig;
  /** Dedicated background LLM configuration. */
  backgroundLlm: BackgroundLlmConfig;
  /** Optional ambient attention engine configuration. */
  ambientAttention?: AmbientAttentionConfig;
  /** Optional ambient initiative engine configuration. */
  ambientInitiative?: AmbientInitiativeConfig;
  /** Native reply/tool loop runtime limits. */
  replyLoop: ReplyLoopConfig;
  /** Opaque Codex reasoning continuation across nearby user turns. */
  reasoningContinuation: ReasoningContinuationConfig;
  /** Background memory extraction behavior. */
  memoryExtraction: MemoryExtractionConfig;
  /** Durable relationship-profile behavior. */
  relationships?: RelationshipConfig;
}

/** Global configuration loaded from file + env. */
export interface GlobalConfig {
  discordToken: string;
  openrouterApiKey?: string;
  codexAuthPath: string;
  /** Default OpenAI Codex transport. */
  codexTransport: CodexTransport;
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
  defaultAssetReading?: AssetReadingConfig;
  defaultInstructions: string;
  logLevel: string;
  dataDir: string;
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
  /** Default human-paced typing indicator delays. */
  defaultTypingSimulation: TypingSimulationConfig;
  /** Default async agent job configuration. */
  defaultAgentJobs: AgentJobsConfig;
  /** Default non-admin recurring scheduled-task pressure caps. */
  defaultSchedulePressure: SchedulePressureConfig;
  /** Default prompt caching controls. */
  defaultPromptCaching: PromptCachingConfig;
  /** Default provider role/target placement for logical prompt sections. */
  defaultPromptTransport: PromptTransportConfig;
  /** Default background LLM overrides. Missing fields inherit main model settings per guild. */
  defaultBackgroundLlm: BackgroundLlmDefaults;
  /** Default ambient attention behavior. */
  defaultAmbientAttention?: AmbientAttentionConfig;
  /** Default ambient initiative behavior. */
  defaultAmbientInitiative?: AmbientInitiativeConfig;
  /** Default native reply/tool loop runtime limits. */
  defaultReplyLoop: ReplyLoopConfig;
  /** Default opaque Codex reasoning continuation behavior. */
  defaultReasoningContinuation: ReasoningContinuationConfig;
  /** Default background memory extraction behavior. */
  defaultMemoryExtraction: MemoryExtractionConfig;
  /** Default durable relationship-profile behavior. */
  defaultRelationships?: RelationshipConfig;
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
  assetReading?: Partial<AssetReadingConfig>;
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
  typingSimulation?: Partial<TypingSimulationConfig>;
  agentJobs?: {
    imageTimeoutMs?: number;
    imageCancelGraceMs?: number;
    terminalVisibleMs?: number;
    maxImageReplacements?: number;
  };
  schedulePressure?: SchedulePressureConfigYaml;
  promptCaching?: {
    enabled?: boolean;
  };
  promptTransport?: PromptTransportConfigYaml;
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
  ambientAttention?: AmbientAttentionConfigYaml;
  ambientInitiative?: AmbientInitiativeConfigYaml;
  relationships?: RelationshipConfigYaml;
  replyLoop?: {
    maxToolCalls?: number;
    wallClockTimeoutMs?: number;
    llmOutputTimeoutMs?: number;
  };
  reasoningContinuation?: {
    enabled?: boolean;
    maxAgeMs?: number;
  };
  memoryExtraction?: {
    postReply?: boolean;
    maxToolCalls?: number;
    ambient?: {
      enabled?: boolean;
      everyMessages?: number;
      maxBatchMessages?: number;
      minIntervalSeconds?: number;
    };
  };
}

/** Raw shape of the main config YAML file (config/config.yaml). All optional. */
export interface MainConfigYaml {
  llmProvider?: LlmProvider;
  model?: string;
  modelParams?: Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
  codexTransport?: CodexTransport;
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
  assetReading?: Partial<AssetReadingConfig>;
  logLevel?: string;
  dataDir?: string;
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
  typingSimulation?: Partial<TypingSimulationConfig>;
  agentJobs?: {
    imageTimeoutMs?: number;
    imageCancelGraceMs?: number;
    terminalVisibleMs?: number;
    maxImageReplacements?: number;
  };
  schedulePressure?: SchedulePressureConfigYaml;
  promptCaching?: {
    enabled?: boolean;
  };
  promptTransport?: PromptTransportConfigYaml;
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
  ambientAttention?: AmbientAttentionConfigYaml;
  ambientInitiative?: AmbientInitiativeConfigYaml;
  relationships?: RelationshipConfigYaml;
  replyLoop?: {
    maxToolCalls?: number;
    wallClockTimeoutMs?: number;
    llmOutputTimeoutMs?: number;
  };
  reasoningContinuation?: {
    enabled?: boolean;
    maxAgeMs?: number;
  };
  memoryExtraction?: {
    postReply?: boolean;
    maxToolCalls?: number;
    ambient?: {
      enabled?: boolean;
      everyMessages?: number;
      maxBatchMessages?: number;
      minIntervalSeconds?: number;
    };
  };
}

/** Raw prompt transport YAML shape. */
export interface PromptTransportConfigYaml {
  openaiCodex?: ProviderPromptTransportConfigYaml;
  openrouter?: ProviderPromptTransportConfigYaml;
}

export interface ProviderPromptTransportConfigYaml {
  mode?: CodexPromptTransportMode;
  sections?: Partial<Record<PromptTransportSectionId, Partial<PromptTransportSectionConfig>>>;
}
