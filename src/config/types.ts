import type { TtsConfig, VoicePreset } from "../tts/types.ts";
import type { AssetKind } from "../db/asset-repository.ts";
import type { PersonaModesConfig, PersonaModesConfigYaml } from "../modes/types.ts";
import type { PrivateLifeConfig, PrivateLifeConfigYaml } from "../private-life/types.ts";
import type {
  RelationshipConfig,
  RelationshipConfigYaml,
} from "../relationships/types.ts";
export type {
  RelationshipConfig,
  RelationshipConfigYaml,
} from "../relationships/types.ts";

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
  | "innerThreads"
  | "recentHistory"
  | "currentContext"
  | "personaMode"
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
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Service tier override for providers that support it. */
export type ServiceTier = "flex" | "priority";

/** OpenAI Codex Responses transport. */
export type CodexTransport = "sse" | "websocket" | "websocket-cached" | "auto";

/** Complete named model execution policy shared by LLM workloads. */
export interface ModelProfileConfig {
  provider: LlmProvider;
  model: string;
  modelParams: Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
  serviceTier?: ServiceTier;
  codexTransport: CodexTransport;
  promptCaching: PromptCachingConfig;
}

/** YAML shape for one named model execution policy. */
export interface ModelProfileConfigYaml {
  provider: LlmProvider;
  model: string;
  modelParams?: Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
  serviceTier?: ServiceTier;
  codexTransport?: CodexTransport;
  promptCaching?: PromptCachingConfig;
}

export type AmbientAttentionKind = "ambient_pickup" | "lingering_attention" | "follow_up";

/** Shared evaluator model used by ambient attention candidate checks. */
export interface AmbientAttentionEvaluatorConfig {
  modelProfile: string;
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
  modelProfile: string;
  llmOutputTimeoutMs: number;
}

/** Active local-time window where proactive speech may happen naturally. */
export interface AmbientInitiativeActiveHoursConfig {
  timezone?: string;
  start: string;
  end: string;
}

/** Generic Ambient Initiative opportunity behavior. */
export interface AmbientInitiativeConfig {
  enabled: boolean;
  /** Known Discord bot contacts the actor may choose to address. */
  botContactIds: string[];
  shadowMode: boolean;
  mainChannelId?: string;
  checkIntervalMinMs: number;
  checkIntervalMaxMs: number;
  activeHours: AmbientInitiativeActiveHoursConfig;
  historyLimit: number;
  recentActivityMinMs: number;
  recentActivityMaxMs: number;
  quietWindowMs: number;
  botCooldownMs: number;
  basePressure: number;
  probabilityThreshold: number;
  confidenceThreshold: number;
  cooldownMs: number;
  maxPerDay: number;
  minMainChannelHumanMessages: number;
  mainChannelLookbackDays: number;
  evaluator: AmbientInitiativeEvaluatorConfig;
}

export type AmbientInitiativeConfigYaml = Partial<Omit<
  AmbientInitiativeConfig,
  "evaluator" | "activeHours"
>> & {
  activeHours?: Partial<AmbientInitiativeActiveHoursConfig>;
  evaluator?: Partial<AmbientInitiativeEvaluatorConfig>;
};

/** Dedicated image-reading fallback configuration. */
export interface ImageReadingConfig {
  /** Whether to describe images with a separate vision model when the main model cannot read them. */
  fallbackEnabled: boolean;
  /** Named model profile used for fallback image descriptions. */
  fallbackModelProfile: string;
}

/** Quality sent to Codex image generation. */
export type ImageGenerationQuality = "auto" | "low" | "medium" | "high";

/** Dedicated image-generation request configuration. */
export interface ImageGenerationConfig {
  /** Quality passed to the backend image_generation tool. Default auto. */
  quality: ImageGenerationQuality;
  /** Named Codex model profile used to orchestrate image generation. */
  modelProfile: string;
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
  /** Named model profile used by post-reply and ambient memory maintenance. */
  modelProfile: string;
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

/** Maximum stored memory rows injected into an ordinary actor prompt. */
export interface MemoryContextConfig {
  maxRows: number;
}

/** Durable private inner-thread behavior. */
export interface InnerThreadsConfig {
  /** Enable prompt context, retrieval, and maintenance. */
  enabled: boolean;
  /** Named model profile used by inner-thread maintenance. */
  modelProfile: string;
}

export type InnerThreadsConfigYaml = Partial<InnerThreadsConfig>;

/** Limits for lazy message-asset reading and extraction. */
export interface AssetReadingConfig {
  maxCharsPerRead: number;
  maxDownloadBytes: number;
  maxTranscriptionDurationSeconds: number;
  videoPreviewMaxBytes: number;
  videoPreviewTimesSeconds: number[];
  videoPreviewTimeoutSeconds: number;
  timeoutSeconds: Record<AssetKind, number>;
}

export type AssetReadingConfigYaml = Omit<Partial<AssetReadingConfig>, "timeoutSeconds"> & {
  timeoutSeconds?: Partial<Record<AssetKind, number>>;
};

/** Limits for downloading untrusted web images. */
export interface ExternalImagesConfig {
  maxImagesPerCall: number;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  maxDimension: number;
  maxPageImages: number;
}

/** Realtime speech recognition with local voice detection and a lazy local fallback. */
export interface VoiceSttConfig {
  provider: "elevenlabs";
  model: string;
  previousText: string;
  /** Ask Scribe to suppress nearby speech and ambient background audio. */
  filterBackgroundAudio: boolean;
  monthlyAudioLimitSeconds: number;
  estimatedPricePerAudioHourUsd: number;
  vadCommand: string;
  vadModelPath: string;
  vadServerPort: number;
  vadThreshold: number;
  vadBatchFrames: number;
  /** Local faster-whisper fallback. It is not started while Scribe is healthy. */
  command: string;
  modelPath: string;
  computeType: string;
  language: string;
  initialPrompt: string;
  serverPort: number;
  threads: number;
  timeoutMs: number;
  minUtteranceMs: number;
  maxUtteranceMs: number;
  speechPauseMs: number;
  speechPreRollMs: number;
}

/** Restricted synthetic-input controls used by /voice-test and the dashboard. */
export interface VoiceTestingConfig {
  enabled: boolean;
  guildIds: string[];
  userIds: string[];
  includeSyntheticInMaintenance: boolean;
}

/** Discord playback buffering and Opus silence padding for live TTS. */
export interface VoicePlaybackConfig {
  /** Linear source-volume multiplier applied before Discord encoding. */
  volume: number;
  prebufferMs: number;
  initialSilenceFrames: number;
  trailingSilenceFrames: number;
}

/** Periodic rolling-summary maintenance for live voice sessions. */
export interface VoiceSummaryMaintenanceConfig {
  modelProfile: string;
  everySegments: number;
  minIntervalMs: number;
  maxTurns: number;
  maxChars: number;
}

/** Less frequent durable memory and relationship extraction from voice. */
export interface VoiceExtractionMaintenanceConfig {
  modelProfile: string;
  everySegments: number;
  minIntervalMs: number;
  maxTurns: number;
  maxChars: number;
}

/** Independent live voice maintenance workloads. */
export interface VoiceMaintenanceConfig {
  summary: VoiceSummaryMaintenanceConfig;
  extraction: VoiceExtractionMaintenanceConfig;
}

/** Live Discord voice agent behavior. */
export interface VoiceConfig {
  enabled: boolean;
  /** Named model profile used only for immediate conversational voice turns. */
  modelProfile: string;
  wakeWords: string[];
  lingeringAttentionMs: number;
  roomQuietMs: number;
  /** Maximum time another participant may postpone an owned response opportunity. */
  otherSpeakerGraceMs: number;
  /** Maximum audible delay before a pending interruption forces a cutoff. */
  yieldBoundaryMaxWaitMs: number;
  emptyChannelGraceMs: number;
  recentSessionContextMs: number;
  maintenance: VoiceMaintenanceConfig;
  playback: VoicePlaybackConfig;
  stt: VoiceSttConfig;
  testing: VoiceTestingConfig;
}

export type VoiceConfigYaml = Partial<Omit<VoiceConfig, "maintenance" | "playback" | "stt" | "testing">> & {
  maintenance?: {
    summary?: Partial<VoiceSummaryMaintenanceConfig>;
    extraction?: Partial<VoiceExtractionMaintenanceConfig>;
  };
  playback?: Partial<VoicePlaybackConfig>;
  stt?: Partial<VoiceSttConfig>;
  testing?: Partial<VoiceTestingConfig>;
};

/** Per-guild configuration. Source of truth is the YAML file. */
export interface GuildConfig {
  guildId: string;
  slug: string;
  triggers: TriggerConfig;
  modelProfile: string;
  timezone: string;
  trim: TrimConfig;
  adminUserIds: string[];
  mergeMessageGapSeconds: number;
  imageReferenceMaxPerCall: number;
  /** Dedicated fallback for image tool results when the main model cannot read image input. */
  imageReading: ImageReadingConfig;
  /** Dedicated image-generation request settings. */
  imageGeneration: ImageGenerationConfig;
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
  /** Provider role/target placement for logical prompt sections. */
  promptTransport: PromptTransportConfig;
  /** Optional ambient attention engine configuration. */
  ambientAttention?: AmbientAttentionConfig;
  /** Optional ambient initiative engine configuration. */
  ambientInitiative?: AmbientInitiativeConfig;
  /** Native reply/tool loop runtime limits. */
  replyLoop: ReplyLoopConfig;
  /** Background memory extraction behavior. */
  memoryExtraction: MemoryExtractionConfig;
  /** Bounded durable memory context for ordinary actor turns. */
  memoryContext?: MemoryContextConfig;
  /** Durable relationship-profile behavior. */
  relationships?: RelationshipConfig;
  /** Durable private inner-thread behavior. */
  innerThreads?: InnerThreadsConfig;
  /** Live Discord voice agent behavior. */
  voice?: VoiceConfig;
}

/** Global configuration loaded from file + env. */
export interface GlobalConfig {
  /** Active bot profile family used for cache routing and diagnostics. */
  runtimeProfileId?: string;
  discordToken: string;
  openrouterApiKey?: string;
  codexAuthPath: string;
  braveApiKey?: string;
  externalImages?: ExternalImagesConfig;
  /** Named model execution policies available to all guilds and workloads. */
  modelProfiles: Record<string, ModelProfileConfig>;
  /** Default profile used by normal visible agent turns. */
  defaultModelProfile: string;
  defaultTimezone: string;
  defaultTrim: TrimConfig;
  defaultTriggers: TriggerConfig;
  defaultMergeMessageGapSeconds: number;
  defaultImageReferenceMaxPerCall: number;
  /** Default fallback for image tool results when the main model cannot read image input. */
  defaultImageReading: ImageReadingConfig;
  /** Default image-generation request settings. */
  defaultImageGeneration: ImageGenerationConfig;
  defaultAssetReading?: AssetReadingConfig;
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
  /** Default provider role/target placement for logical prompt sections. */
  defaultPromptTransport: PromptTransportConfig;
  /** Default ambient attention behavior. */
  defaultAmbientAttention?: AmbientAttentionConfig;
  /** Default ambient initiative behavior. */
  defaultAmbientInitiative?: AmbientInitiativeConfig;
  /** Profile-wide private curiosity runtime. */
  privateLife?: PrivateLifeConfig;
  /** Default native reply/tool loop runtime limits. */
  defaultReplyLoop: ReplyLoopConfig;
  /** Default background memory extraction behavior. */
  defaultMemoryExtraction: MemoryExtractionConfig;
  defaultMemoryContext?: MemoryContextConfig;
  /** Default durable relationship-profile behavior. */
  defaultRelationships?: RelationshipConfig;
  /** Default durable private inner-thread behavior. */
  defaultInnerThreads?: InnerThreadsConfig;
  /** Default live Discord voice agent behavior. */
  defaultVoice?: VoiceConfig;
  /** Profile-local timed persona modes and presentation state. */
  personaModes?: PersonaModesConfig;
}

/** Full resolved app config. */
export interface AppConfig {
  global: GlobalConfig;
  guilds: Map<string, GuildConfig>;
}

/** Raw shape of a guild YAML file (partial, all fields optional). */
export interface GuildConfigYaml {
  triggers?: Partial<TriggerConfig>;
  modelProfile?: string;
  timezone?: string;
  trim?: Partial<TrimConfig>;
  adminUserIds?: string[];
  mergeMessageGapSeconds?: number;
  imageReferenceMaxPerCall?: number;
  imageReading?: {
    fallbackEnabled?: boolean;
    fallbackModelProfile?: string;
  };
  imageGeneration?: {
    quality?: ImageGenerationQuality;
    modelProfile?: string;
  };
  assetReading?: AssetReadingConfigYaml;
  instructions?: string;
  instructionsPath?: string;
  tts?: Partial<TtsConfig> & {
    voices?: {
      normal?: Partial<VoicePreset>;
      voiceChannel?: Partial<VoicePreset>;
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
  promptTransport?: PromptTransportConfigYaml;
  ambientAttention?: AmbientAttentionConfigYaml;
  ambientInitiative?: AmbientInitiativeConfigYaml;
  relationships?: RelationshipConfigYaml;
  innerThreads?: InnerThreadsConfigYaml;
  voice?: VoiceConfigYaml;
  replyLoop?: {
    maxToolCalls?: number;
    wallClockTimeoutMs?: number;
    llmOutputTimeoutMs?: number;
  };
  memoryExtraction?: {
    modelProfile?: string;
    postReply?: boolean;
    maxToolCalls?: number;
    ambient?: {
      enabled?: boolean;
      everyMessages?: number;
      maxBatchMessages?: number;
      minIntervalSeconds?: number;
    };
  };
  memoryContext?: Partial<MemoryContextConfig>;
}

/** Raw shape of a profile's config YAML file. All optional. */
export interface MainConfigYaml {
  modelProfiles?: Record<string, ModelProfileConfigYaml>;
  modelProfile?: string;
  timezone?: string;
  trim?: Partial<TrimConfig>;
  triggers?: Partial<TriggerConfig>;
  mergeMessageGapSeconds?: number;
  imageReferenceMaxPerCall?: number;
  imageReading?: {
    fallbackEnabled?: boolean;
    fallbackModelProfile?: string;
  };
  imageGeneration?: {
    quality?: ImageGenerationQuality;
    modelProfile?: string;
  };
  externalImages?: Partial<ExternalImagesConfig>;
  assetReading?: AssetReadingConfigYaml;
  logLevel?: string;
  dataDir?: string;
  tts?: Partial<TtsConfig> & {
    voices?: {
      normal?: Partial<VoicePreset>;
      voiceChannel?: Partial<VoicePreset>;
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
  promptTransport?: PromptTransportConfigYaml;
  ambientAttention?: AmbientAttentionConfigYaml;
  ambientInitiative?: AmbientInitiativeConfigYaml;
  privateLife?: PrivateLifeConfigYaml;
  relationships?: RelationshipConfigYaml;
  innerThreads?: InnerThreadsConfigYaml;
  voice?: VoiceConfigYaml;
  personaModes?: PersonaModesConfigYaml;
  replyLoop?: {
    maxToolCalls?: number;
    wallClockTimeoutMs?: number;
    llmOutputTimeoutMs?: number;
  };
  memoryExtraction?: {
    modelProfile?: string;
    postReply?: boolean;
    maxToolCalls?: number;
    ambient?: {
      enabled?: boolean;
      everyMessages?: number;
      maxBatchMessages?: number;
      minIntervalSeconds?: number;
    };
  };
  memoryContext?: Partial<MemoryContextConfig>;
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
