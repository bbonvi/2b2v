import type {
  AgentJobsConfig,
  AssetReadingConfig,
  AmbientAttentionConfig,
  AmbientAttentionModeConfig,
  AmbientInitiativeConfig,
  DispatcherConfig,
  EmotesConfig,
  ExternalImagesConfig,
  ImageGenerationConfig,
  ImageReadingConfig,
  InnerThreadsConfig,
  LlmProvider,
  MembersConfig,
  MemoryExtractionConfig,
  PromptCachingConfig,
  PromptTransportConfig,
  PromptTransportSectionId,
  RelationshipConfig,
  ReplyLoopConfig,
  SchedulePressureConfig,
  TriggerConfig,
  TrimConfig,
  TypingSimulationConfig,
} from "./types.ts";
import type { VoicePreset } from "../tts/types.ts";
import type { PrivateLifeConfig } from "../private-life/types.ts";

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

export const DEFAULT_EXTERNAL_IMAGES: ExternalImagesConfig = {
  maxImagesPerCall: 5,
  maxBytes: 20 * 1024 * 1024,
  timeoutMs: 15_000,
  maxRedirects: 5,
  maxDimension: 1024,
  maxPageImages: 10,
};

export const DEFAULT_MEMORY_EXTRACTION: MemoryExtractionConfig = {
  modelProfile: "main",
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
  modelProfile: "main",
  enabled: true,
  promptInjection: true,
  maxAxisDeltaPerSignal: 4,
  maxToolCalls: 5,
};

export const DEFAULT_INNER_THREADS: InnerThreadsConfig = {
  enabled: true,
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
};

export const DEFAULT_AMBIENT_ATTENTION: AmbientAttentionConfig = {
  enabled: false,
  evaluator: {
    modelProfile: "main",
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

export const DEFAULT_AMBIENT_INITIATIVE: AmbientInitiativeConfig = {
  enabled: false,
  botContactIds: [],
  shadowMode: false,
  checkIntervalMinMs: 10 * 60 * 1000,
  checkIntervalMaxMs: 20 * 60 * 1000,
  activeHours: {
    start: "10:00",
    end: "01:00",
  },
  historyLimit: 60,
  recentActivityMinMs: 5 * 60 * 1000,
  recentActivityMaxMs: 3 * 60 * 60 * 1000,
  quietWindowMs: 6 * 60 * 1000,
  botCooldownMs: 45 * 60 * 1000,
  basePressure: 0.18,
  probabilityThreshold: 0.55,
  confidenceThreshold: 0.6,
  cooldownMs: 2 * 60 * 60 * 1000,
  maxPerDay: 5,
  minMainChannelHumanMessages: 20,
  mainChannelLookbackDays: 7,
  evaluator: {
    modelProfile: "main",
    llmOutputTimeoutMs: 8_000,
  },
};

export const DEFAULT_PRIVATE_LIFE: PrivateLifeConfig = {
  enabled: false,
  modelProfile: "main",
  opportunitiesPerDay: 50,
  intervalJitter: 0.45,
  lateNightStart: "22:30",
  sleepStart: "23:30",
  sleepEnd: "07:55",
  lateNightRateMultiplier: 0.45,
  sleepRateMultiplier: 0.04,
  allowVisibleOutput: true,
  maxVisiblePerDay: 3,
  visibleOutputCooldownMinutes: 20,
  maxToolCalls: 20,
  recentThemeLimit: 24,
  candidateCount: 5,
  thoughtRetentionDays: 14,
  originWeights: {
    spontaneous: 0.55,
    "continue-inner-thread": 0.30,
    "recent-residue": 0.15,
  },
  modeWeights: {
    unstructured: 0.20,
    investigate: 0.19,
    "make-or-change": 0.12,
    "imagine-possibility": 0.18,
    "offscreen-event-candidate": 0.09,
    "social-impulse": 0.08,
    "observe-or-collect": 0.14,
  },
  territoryWeights: {
    open: 0.20,
    external: 0.12,
    "technical-material": 0.12,
    "creative-aesthetic": 0.09,
    "mundane-private": 0.10,
    embodied: 0.09,
    sexual: 0.06,
    "social-personal": 0.08,
    community: 0.03,
    "transgressive-ugly": 0.04,
    "playful-absurd": 0.07,
  },
  actionScopeWeights: {
    "reflect-only": 0.55,
    "quiet-exploration": 0.30,
    "private-action": 0.13,
    "social-opportunity": 0.02,
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
  fallbackModelProfile: "main",
};

export const DEFAULT_IMAGE_GENERATION: ImageGenerationConfig = {
  quality: "auto",
  modelProfile: "main",
};

export const DEFAULT_REPLY_LOOP: ReplyLoopConfig = {
  maxToolCalls: 64,
  wallClockTimeoutMs: 45_000,
  llmOutputTimeoutMs: 12_000,
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
  "innerThreads",
  "recentHistory",
  "currentContext",
  "personaMode",
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
      innerThreads: { role: "developer", target: "input" },
      recentHistory: { role: "user", target: "input" },
      currentContext: { role: "user", target: "input" },
      personaMode: { role: "developer", target: "input" },
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
      innerThreads: { role: "developer", target: "input" },
      recentHistory: { role: "user", target: "input" },
      currentContext: { role: "user", target: "input" },
      personaMode: { role: "developer", target: "input" },
      responseInstruction: { role: "developer", target: "input" },
      currentTurn: { role: "user", target: "input" },
      finalActionInstruction: { role: "user", target: "input" },
    },
  },
};
