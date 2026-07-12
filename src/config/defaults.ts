import type {
  AgentJobsConfig,
  AssetReadingConfig,
  AmbientAttentionConfig,
  AmbientAttentionModeConfig,
  AmbientInitiativeConfig,
  AmbientInitiativeKindConfig,
  DispatcherConfig,
  EmotesConfig,
  ImageGenerationConfig,
  ImageReadingConfig,
  LlmProvider,
  MembersConfig,
  MemoryExtractionConfig,
  PromptCachingConfig,
  PromptTransportConfig,
  PromptTransportSectionId,
  ReasoningContinuationConfig,
  RelationshipConfig,
  ReplyLoopConfig,
  SchedulePressureConfig,
  TriggerConfig,
  TrimConfig,
  TypingSimulationConfig,
} from "./types.ts";
import type { VoicePreset } from "../tts/types.ts";

export const DEFAULT_TRIGGER: TriggerConfig = {
  mention: true,
  keywords: [],
  randomChance: 0,
  keywordDebounceMs: 2500,
  typingIdleMs: 10000,
  typingResumeGraceMs: 3000,
  typingMaxWaitMs: 15000,
};

export const DEFAULT_TRIM: TrimConfig = {
  trimTrigger: 200,
  trimTarget: 150,
  windowSize: 20,
  messageCharLimit: 200,
  replyQuoteChars: 50,
};

export const DEFAULT_MEMORY_EXTRACTION: MemoryExtractionConfig = {
  postReply: true,
  maxToolCalls: 5,
  ambient: {
    enabled: false,
    everyMessages: 300,
    maxBatchMessages: 300,
    minIntervalSeconds: 600,
  },
};

export const DEFAULT_RELATIONSHIPS: RelationshipConfig = {
  enabled: true,
  promptInjection: true,
  maxAxisDeltaPerSignal: 4,
  maxToolCalls: 5,
};

export const DEFAULT_AMBIENT_ATTENTION_MODE: AmbientAttentionModeConfig = {
  enabled: false,
  minDelayMs: 3_000,
  maxDelayMs: 12_000,
  probabilityThreshold: 0.75,
  confidenceThreshold: 0.55,
  cooldownMs: 120_000,
  typingActiveMs: 8_000,
  maxRepliesPerUserPerHour: 4,
  maxRepliesPerChannelPerHour: 8,
  randomJitter: 0.04,
  defaultReply: false,
};

export const DEFAULT_AMBIENT_ATTENTION: AmbientAttentionConfig = {
  enabled: false,
  evaluator: {
    provider: "openai-codex",
    model: "gpt-5.3-codex-spark",
    modelParams: { textVerbosity: "low" },
    thinkingLevel: "minimal",
    llmOutputTimeoutMs: 8_000,
  },
  historyLimit: 40,
  busyWindowMs: 60_000,
  busyMessageLimit: 8,
  staleAfterMs: 180_000,
  maxNewMessagesBeforeDrop: 4,
  ambientPickup: {
    ...DEFAULT_AMBIENT_ATTENTION_MODE,
    minDelayMs: 8_000,
    maxDelayMs: 25_000,
    probabilityThreshold: 0.8,
    confidenceThreshold: 0.6,
    cooldownMs: 180_000,
    minQuietMs: 12_000,
  },
  lingering: {
    ...DEFAULT_AMBIENT_ATTENTION_MODE,
    enabled: true,
    minDelayMs: 1_500,
    maxDelayMs: 7_000,
    probabilityThreshold: 0.58,
    confidenceThreshold: 0.45,
    cooldownMs: 0,
    typingActiveMs: 1_000,
    maxRepliesPerUserPerHour: 24,
    maxRepliesPerChannelPerHour: 48,
    defaultReply: true,
    strongWindowMs: 45_000,
    weakWindowMs: 180_000,
    typingExtensionMs: 30_000,
    maxTypingExtensions: 4,
  },
  followUp: {
    ...DEFAULT_AMBIENT_ATTENTION_MODE,
    minDelayMs: 12_000,
    maxDelayMs: 45_000,
    probabilityThreshold: 0.88,
    confidenceThreshold: 0.7,
    cooldownMs: 300_000,
    typingActiveMs: 8_000,
    maxRepliesPerUserPerHour: 2,
    maxRepliesPerChannelPerHour: 4,
    silenceMs: 12_000,
    maxPerExchange: 1,
  },
};

export const DEFAULT_AMBIENT_INITIATIVE_KIND: AmbientInitiativeKindConfig = {
  enabled: false,
  basePressure: 0.12,
  pressureThreshold: 0.72,
  probabilityThreshold: 0.72,
  confidenceThreshold: 0.6,
  cooldownMs: 2 * 60 * 60 * 1000,
  maxPerDay: 2,
};

export const DEFAULT_AMBIENT_INITIATIVE: AmbientInitiativeConfig = {
  enabled: false,
  shadowMode: false,
  checkIntervalMinMs: 12 * 60 * 1000,
  checkIntervalMaxMs: 45 * 60 * 1000,
  activeHours: {
    start: "10:00",
    end: "01:00",
  },
  historyLimit: 60,
  recentActivityMinMs: 5 * 60 * 1000,
  recentActivityMaxMs: 3 * 60 * 60 * 1000,
  quietWindowMs: 6 * 60 * 1000,
  typingActiveMs: 10_000,
  botCooldownMs: 45 * 60 * 1000,
  fatigueAfterAnyMs: 60 * 60 * 1000,
  maxPerDay: 5,
  minMainChannelHumanMessages: 20,
  mainChannelLookbackDays: 7,
  evaluator: {
    provider: "openai-codex",
    model: "gpt-5.3-codex-spark",
    modelParams: { textVerbosity: "low" },
    thinkingLevel: "minimal",
    llmOutputTimeoutMs: 8_000,
  },
  selfExpression: {
    ...DEFAULT_AMBIENT_INITIATIVE_KIND,
    enabled: true,
    basePressure: 0.18,
    maxPerDay: 3,
    cooldownMs: 3 * 60 * 60 * 1000,
  },
  targetedCheckin: {
    ...DEFAULT_AMBIENT_INITIATIVE_KIND,
    enabled: true,
    basePressure: 0.16,
    maxPerDay: 3,
    cooldownMs: 2 * 60 * 60 * 1000,
    maxPerUserPerDay: 1,
    openLoopMaxAgeMs: 48 * 60 * 60 * 1000,
  },
};

export const DEFAULT_VOICE_PRESET: VoicePreset = {
  voiceId: "",
  speed: 1.0,
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: false,
  model: "eleven_v3",
};

export const DEFAULT_ASSET_READING: AssetReadingConfig = {
  maxCharsPerRead: 30_000,
  maxDownloadBytes: 100 * 1024 * 1024,
  maxTranscriptionDurationSeconds: 7_200,
  videoPreviewMaxBytes: 100 * 1024 * 1024,
  videoPreviewTimesSeconds: [0, 1, 5],
  videoPreviewTimeoutSeconds: 30,
  timeoutSeconds: {
    image: 30,
    gif: 30,
    audio: 90,
    video: 180,
    text: 30,
    file: 30,
  },
};

export const DEFAULT_EMOTES: EmotesConfig = {
  include: false,
};

export const DEFAULT_MEMBERS: MembersConfig = {
  include: true,
};

export const DEFAULT_DISPATCHER: DispatcherConfig = {
  enabled: true,
  mentionDebounceMs: 500,
  defaultDebounceMs: 2000,
};

export const DEFAULT_TYPING_SIMULATION: TypingSimulationConfig = {
  enabled: false,
  inputReadingWpm: 450,
  inputMinDelayMs: 300,
  inputMaxDelayMs: 3500,
  outputTypingWpm: 180,
  outputMinHoldMs: 700,
  outputMaxHoldMs: 3500,
};

export const DEFAULT_AGENT_JOBS: AgentJobsConfig = {
  imageTimeoutMs: 300_000,
  imageCancelGraceMs: 60_000,
  terminalVisibleMs: 600_000,
  maxImageReplacements: 2,
};

export const DEFAULT_SCHEDULE_PRESSURE: SchedulePressureConfig = {
  maxRequesterRunsPerHour: 120,
  maxRequesterRunsPerDay: 500,
  maxGuildRunsPerHour: 600,
  maxGuildRunsPerDay: 3_000,
};

export const DEFAULT_PROMPT_CACHING: PromptCachingConfig = {
  enabled: true,
};

export const DEFAULT_LLM_PROVIDER: LlmProvider = "openrouter";

export const DEFAULT_IMAGE_READING: ImageReadingConfig = {
  fallbackEnabled: false,
  fallbackProvider: "openrouter",
  fallbackModel: "moonshotai/kimi-k2.5",
  fallbackModelParams: {},
};

export const DEFAULT_IMAGE_GENERATION: ImageGenerationConfig = {
  quality: "auto",
};

export const DEFAULT_REPLY_LOOP: ReplyLoopConfig = {
  maxToolCalls: 64,
  wallClockTimeoutMs: 45_000,
  llmOutputTimeoutMs: 12_000,
};

export const DEFAULT_REASONING_CONTINUATION: ReasoningContinuationConfig = {
  enabled: true,
  maxAgeMs: 30 * 60 * 1000,
};

export const PROMPT_TRANSPORT_SECTION_IDS: readonly PromptTransportSectionId[] = [
  "system",
  "core",
  "skills",
  "runtime",
  "stableContext",
  "olderHistory",
  "serverMembers",
  "threadsInChannel",
  "discordContext",
  "upcomingSchedules",
  "memories",
  "recentHistory",
  "currentContext",
  "responseInstruction",
  "currentTurn",
  "finalActionInstruction",
] as const;

export const DEFAULT_PROMPT_TRANSPORT: PromptTransportConfig = {
  openaiCodex: {
    mode: "split-input",
    sections: {
      system: { role: "developer", target: "instructions", cacheGroup: "core" },
      core: { role: "developer", target: "input", cacheGroup: "core" },
      skills: { role: "developer", target: "input", cacheGroup: "runtime" },
      runtime: { role: "developer", target: "input", cacheGroup: "runtime" },
      stableContext: { role: "user", target: "input", cacheGroup: "stable-context" },
      olderHistory: { role: "user", target: "input", cacheGroup: "older-history" },
      serverMembers: { role: "user", target: "input" },
      threadsInChannel: { role: "user", target: "input" },
      discordContext: { role: "user", target: "input" },
      upcomingSchedules: { role: "user", target: "input" },
      memories: { role: "user", target: "input" },
      recentHistory: { role: "user", target: "input" },
      currentContext: { role: "user", target: "input" },
      responseInstruction: { role: "developer", target: "input" },
      currentTurn: { role: "user", target: "input" },
      finalActionInstruction: { role: "user", target: "input" },
    },
  },
  openrouter: {
    mode: "split-input",
    sections: {
      system: { role: "developer", target: "input", cacheGroup: "core" },
      core: { role: "developer", target: "input", cacheGroup: "core" },
      skills: { role: "developer", target: "input", cacheGroup: "runtime" },
      runtime: { role: "developer", target: "input", cacheGroup: "runtime" },
      stableContext: { role: "user", target: "input", cacheGroup: "stable-context" },
      olderHistory: { role: "user", target: "input", cacheGroup: "older-history" },
      serverMembers: { role: "user", target: "input" },
      threadsInChannel: { role: "user", target: "input" },
      discordContext: { role: "user", target: "input" },
      upcomingSchedules: { role: "user", target: "input" },
      memories: { role: "user", target: "input" },
      recentHistory: { role: "user", target: "input" },
      currentContext: { role: "user", target: "input" },
      responseInstruction: { role: "developer", target: "input" },
      currentTurn: { role: "user", target: "input" },
      finalActionInstruction: { role: "user", target: "input" },
    },
  },
};
