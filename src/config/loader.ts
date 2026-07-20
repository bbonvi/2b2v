import { parse, stringify } from "yaml";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
import { join, basename, dirname } from "path";
import {
  DEFAULT_AGENT_JOBS,
  DEFAULT_ASSET_READING,
  DEFAULT_AMBIENT_ATTENTION,
  DEFAULT_AMBIENT_INITIATIVE,
  DEFAULT_DISPATCHER,
  DEFAULT_EMOTES,
  DEFAULT_EXTERNAL_IMAGES,
  DEFAULT_IMAGE_GENERATION,
  DEFAULT_IMAGE_READING,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_MEMBERS,
  DEFAULT_MEMORY_EXTRACTION,
  DEFAULT_PROMPT_CACHING,
  DEFAULT_PROMPT_TRANSPORT,
  DEFAULT_RELATIONSHIPS,
  DEFAULT_REPLY_LOOP,
  DEFAULT_SCHEDULE_PRESSURE,
  DEFAULT_TRIGGER,
  DEFAULT_TRIM,
  DEFAULT_TYPING_SIMULATION,
  DEFAULT_VOICE_PRESET,
  PROMPT_TRANSPORT_SECTION_IDS,
} from "./defaults.ts";
import type {
  GlobalConfig,
  GuildConfig,
  GuildConfigYaml,
  MainConfigYaml,
  TrimConfig,
  ThinkingLevel,
  UiLang,
  VpnConfig,
  TypingSimulationConfig,
  AgentJobsConfig,
  PromptTransportConfig,
  PromptTransportConfigYaml,
  ProviderPromptTransportConfigYaml,
  CodexPromptTransportMode,
  PromptTransportRole,
  PromptTransportSectionConfig,
  PromptTransportSectionId,
  PromptTransportTarget,
  ModelProfileConfig,
  ModelProfileConfigYaml,
  ImageReadingConfig,
  ImageGenerationConfig,
  ImageGenerationQuality,
  ReplyLoopConfig,
  MemoryExtractionConfig,
  MemoryContextConfig,
  ServiceTier,
  LlmProvider,
  CodexTransport,
  AmbientAttentionConfig,
  AmbientAttentionModeConfig,
  AmbientAttentionEvaluatorConfig,
  AmbientAttentionConfigYaml,
  AmbientInitiativeConfig,
  AmbientInitiativeEvaluatorConfig,
  AmbientInitiativeConfigYaml,
  RelationshipConfig,
  RelationshipConfigYaml,
  SchedulePressureConfig,
  SchedulePressureConfigYaml,
  AssetReadingConfig,
  AssetReadingConfigYaml,
  ExternalImagesConfig,
  VoiceConfig,
  VoiceConfigYaml,
} from "./types.ts";
import type { TextNormalizationMode, TtsConfig, VoicePreset } from "../tts/types.ts";
import { resolvePersonaModesConfig } from "../modes/config.ts";
import { stripMarkdownComments } from "./instruction-text.ts";

function resolveAssetReadingConfig(input: AssetReadingConfigYaml | undefined, fallback: AssetReadingConfig = DEFAULT_ASSET_READING): AssetReadingConfig {
  const positive = (value: number | undefined, fallback: number, name: string): number => {
    const resolved = value ?? fallback;
    if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(`assetReading.${name} must be positive`);
    return resolved;
  };
  const times = input?.videoPreviewTimesSeconds ?? [...fallback.videoPreviewTimesSeconds];
  if (times.length === 0 || times.length > 10 || times.some((time) => !Number.isFinite(time) || time < 0)) {
    throw new Error("assetReading.videoPreviewTimesSeconds must contain 1-10 non-negative numbers");
  }
  return {
    maxCharsPerRead: positive(input?.maxCharsPerRead, fallback.maxCharsPerRead, "maxCharsPerRead"),
    maxDownloadBytes: positive(input?.maxDownloadBytes, fallback.maxDownloadBytes, "maxDownloadBytes"),
    maxTranscriptionDurationSeconds: positive(input?.maxTranscriptionDurationSeconds, fallback.maxTranscriptionDurationSeconds, "maxTranscriptionDurationSeconds"),
    videoPreviewMaxBytes: positive(input?.videoPreviewMaxBytes, fallback.videoPreviewMaxBytes, "videoPreviewMaxBytes"),
    videoPreviewTimesSeconds: times,
    videoPreviewTimeoutSeconds: positive(input?.videoPreviewTimeoutSeconds, fallback.videoPreviewTimeoutSeconds, "videoPreviewTimeoutSeconds"),
    timeoutSeconds: {
      image: positive(input?.timeoutSeconds?.image, fallback.timeoutSeconds.image, "timeoutSeconds.image"),
      gif: positive(input?.timeoutSeconds?.gif, fallback.timeoutSeconds.gif, "timeoutSeconds.gif"),
      audio: positive(input?.timeoutSeconds?.audio, fallback.timeoutSeconds.audio, "timeoutSeconds.audio"),
      video: positive(input?.timeoutSeconds?.video, fallback.timeoutSeconds.video, "timeoutSeconds.video"),
      text: positive(input?.timeoutSeconds?.text, fallback.timeoutSeconds.text, "timeoutSeconds.text"),
      file: positive(input?.timeoutSeconds?.file, fallback.timeoutSeconds.file, "timeoutSeconds.file"),
    },
  };
}

function resolveExternalImagesConfig(input: Partial<ExternalImagesConfig> | undefined): ExternalImagesConfig {
  const value = (key: keyof ExternalImagesConfig): number => {
    const resolved = input?.[key] ?? DEFAULT_EXTERNAL_IMAGES[key];
    if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`externalImages.${key} must be a positive integer`);
    return resolved;
  };
  return {
    maxImagesPerCall: value("maxImagesPerCall"),
    maxBytes: value("maxBytes"),
    timeoutMs: value("timeoutMs"),
    maxRedirects: value("maxRedirects"),
    maxDimension: value("maxDimension"),
    maxPageImages: value("maxPageImages"),
  };
}

function resolveImageReferenceMaxPerCall(value: number | undefined, fallback: number, key: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return resolved;
}

function resolveTextNormalizationMode(
  value: unknown,
): TextNormalizationMode | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "on" || value === "off") return value;
  throw new Error('tts.voices.normal.applyTextNormalization must be "auto", "on", or "off"');
}

/**
 * Resolve a partial VoicePreset from YAML against defaults.
 * Returns undefined if voiceId is not set (required field).
 */
function resolveVoicePreset(partial: Partial<VoicePreset> | undefined): VoicePreset | undefined {
  if (partial === undefined || partial.voiceId === undefined || partial.voiceId === "") {
    return undefined;
  }
  return {
    voiceId: partial.voiceId,
    speed: partial.speed ?? DEFAULT_VOICE_PRESET.speed,
    stability: partial.stability ?? DEFAULT_VOICE_PRESET.stability,
    similarityBoost: partial.similarityBoost ?? DEFAULT_VOICE_PRESET.similarityBoost,
    style: partial.style ?? DEFAULT_VOICE_PRESET.style,
    useSpeakerBoost: partial.useSpeakerBoost ?? DEFAULT_VOICE_PRESET.useSpeakerBoost,
    ...(partial.seed !== undefined ? { seed: partial.seed } : {}),
    ...(partial.applyTextNormalization !== undefined
      ? { applyTextNormalization: resolveTextNormalizationMode(partial.applyTextNormalization) }
      : {}),
    ...(partial.outputFormat !== undefined && partial.outputFormat.trim() !== ""
      ? { outputFormat: partial.outputFormat.trim() }
      : {}),
    ...(partial.languageCode !== undefined && partial.languageCode.trim() !== ""
      ? { languageCode: partial.languageCode.trim() }
      : {}),
    model: partial.model ?? DEFAULT_VOICE_PRESET.model,
  };
}

/**
 * Resolve TTS config from YAML partial.
 * Returns undefined if TTS is not enabled or no normal voice is configured.
 */
function resolveTtsConfig(
  partial: MainConfigYaml["tts"] | GuildConfigYaml["tts"] | undefined
): TtsConfig | undefined {
  if (partial === undefined) return undefined;
  if (partial.enabled !== true) return undefined;

  const normalVoice = resolveVoicePreset(partial.voices?.normal);
  if (normalVoice === undefined) return undefined;
  const voiceChannel = resolveVoicePreset(partial.voices?.voiceChannel);

  return {
    enabled: true,
    voices: {
      normal: normalVoice,
      ...(voiceChannel !== undefined ? { voiceChannel } : {}),
    },
  };
}

const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  enabled: false,
  modelProfile: "main",
  wakeWords: ["2b", "туби"],
  lingeringAttentionMs: 45_000,
  roomQuietMs: 700,
  otherSpeakerGraceMs: 3_000,
  yieldBoundaryMaxWaitMs: 1_500,
  emptyChannelGraceMs: 120_000,
  recentSessionContextMs: 6 * 60 * 60 * 1000,
  maintenance: {
    summary: {
      modelProfile: "main",
      everySegments: 40,
      minIntervalMs: 5 * 60 * 1000,
      maxTurns: 48,
      maxChars: 12_000,
    },
    extraction: {
      modelProfile: "main",
      everySegments: 120,
      minIntervalMs: 20 * 60 * 1000,
      maxTurns: 48,
      maxChars: 12_000,
    },
  },
  playback: {
    volume: 1,
    prebufferMs: 30,
    initialSilenceFrames: 2,
    trailingSilenceFrames: 3,
  },
  stt: {
    provider: "elevenlabs",
    model: "scribe_v2_realtime",
    previousText: "2B. Туби.",
    filterBackgroundAudio: false,
    monthlyAudioLimitSeconds: 36_000,
    estimatedPricePerAudioHourUsd: 0.39,
    vadCommand: "silero-vad-server",
    vadModelPath: "/opt/faster-whisper/models/silero-vad/silero_vad.onnx",
    vadServerPort: 18_081,
    vadThreshold: 0.5,
    vadBatchFrames: 3,
    command: "faster-whisper-server",
    modelPath: "/opt/faster-whisper/models/small",
    computeType: "int8",
    language: "ru",
    initialPrompt: "Туби, 2B. Разговорная русская речь.",
    serverPort: 18_080,
    threads: 8,
    timeoutMs: 20_000,
    minUtteranceMs: 180,
    maxUtteranceMs: 15_000,
    speechPauseMs: 450,
    speechPreRollMs: 160,
  },
  testing: {
    enabled: false,
    guildIds: [],
    userIds: [],
    includeSyntheticInMaintenance: false,
  },
};

function positiveVoiceInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${path} must be a positive integer`);
  return value;
}

function nonNegativeVoiceInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${path} must be a non-negative integer`);
  return value;
}

/** Resolve profile or guild voice configuration without enabling it implicitly. */
function resolveVoiceConfig(defaults: VoiceConfig, partial: VoiceConfigYaml | undefined): VoiceConfig {
  const resolved: VoiceConfig = {
    ...defaults,
    ...partial,
    wakeWords: partial?.wakeWords !== undefined ? [...partial.wakeWords] : [...defaults.wakeWords],
    maintenance: {
      summary: { ...defaults.maintenance.summary, ...partial?.maintenance?.summary },
      extraction: { ...defaults.maintenance.extraction, ...partial?.maintenance?.extraction },
    },
    playback: { ...defaults.playback, ...partial?.playback },
    stt: { ...defaults.stt, ...partial?.stt },
    testing: {
      ...defaults.testing,
      ...partial?.testing,
      guildIds: partial?.testing?.guildIds !== undefined
        ? [...partial.testing.guildIds]
        : [...defaults.testing.guildIds],
      userIds: partial?.testing?.userIds !== undefined
        ? [...partial.testing.userIds]
        : [...defaults.testing.userIds],
    },
  };
  if (resolved.modelProfile.trim() === "") throw new Error("voice.modelProfile must not be empty");
  if (resolved.stt.model.trim() === "") throw new Error("voice.stt.model must not be empty");
  if (resolved.stt.previousText.length > 50) throw new Error("voice.stt.previousText must be at most 50 characters");
  if (resolved.stt.vadCommand.trim() === "") throw new Error("voice.stt.vadCommand must not be empty");
  if (resolved.stt.vadModelPath.trim() === "") throw new Error("voice.stt.vadModelPath must not be empty");
  if (resolved.stt.command.trim() === "") throw new Error("voice.stt.command must not be empty");
  if (resolved.stt.modelPath.trim() === "") throw new Error("voice.stt.modelPath must not be empty");
  if (resolved.stt.computeType.trim() === "") throw new Error("voice.stt.computeType must not be empty");
  if (resolved.wakeWords.some((word) => word.trim() === "")) throw new Error("voice.wakeWords must contain non-empty strings");
  positiveVoiceInteger(resolved.lingeringAttentionMs, "voice.lingeringAttentionMs");
  positiveVoiceInteger(resolved.roomQuietMs, "voice.roomQuietMs");
  positiveVoiceInteger(resolved.otherSpeakerGraceMs, "voice.otherSpeakerGraceMs");
  positiveVoiceInteger(resolved.yieldBoundaryMaxWaitMs, "voice.yieldBoundaryMaxWaitMs");
  positiveVoiceInteger(resolved.emptyChannelGraceMs, "voice.emptyChannelGraceMs");
  positiveVoiceInteger(resolved.recentSessionContextMs, "voice.recentSessionContextMs");
  positiveVoiceInteger(resolved.maintenance.summary.everySegments, "voice.maintenance.summary.everySegments");
  positiveVoiceInteger(resolved.maintenance.summary.minIntervalMs, "voice.maintenance.summary.minIntervalMs");
  positiveVoiceInteger(resolved.maintenance.summary.maxTurns, "voice.maintenance.summary.maxTurns");
  positiveVoiceInteger(resolved.maintenance.summary.maxChars, "voice.maintenance.summary.maxChars");
  positiveVoiceInteger(resolved.maintenance.extraction.everySegments, "voice.maintenance.extraction.everySegments");
  positiveVoiceInteger(resolved.maintenance.extraction.minIntervalMs, "voice.maintenance.extraction.minIntervalMs");
  positiveVoiceInteger(resolved.maintenance.extraction.maxTurns, "voice.maintenance.extraction.maxTurns");
  positiveVoiceInteger(resolved.maintenance.extraction.maxChars, "voice.maintenance.extraction.maxChars");
  if (!Number.isFinite(resolved.playback.volume) || resolved.playback.volume <= 0) {
    throw new Error("voice.playback.volume must be a positive number");
  }
  nonNegativeVoiceInteger(resolved.playback.prebufferMs, "voice.playback.prebufferMs");
  nonNegativeVoiceInteger(resolved.playback.initialSilenceFrames, "voice.playback.initialSilenceFrames");
  nonNegativeVoiceInteger(resolved.playback.trailingSilenceFrames, "voice.playback.trailingSilenceFrames");
  positiveVoiceInteger(resolved.stt.timeoutMs, "voice.stt.timeoutMs");
  positiveVoiceInteger(resolved.stt.minUtteranceMs, "voice.stt.minUtteranceMs");
  positiveVoiceInteger(resolved.stt.maxUtteranceMs, "voice.stt.maxUtteranceMs");
  positiveVoiceInteger(resolved.stt.serverPort, "voice.stt.serverPort");
  positiveVoiceInteger(resolved.stt.vadServerPort, "voice.stt.vadServerPort");
  positiveVoiceInteger(resolved.stt.vadBatchFrames, "voice.stt.vadBatchFrames");
  positiveVoiceInteger(resolved.stt.threads, "voice.stt.threads");
  positiveVoiceInteger(resolved.stt.speechPauseMs, "voice.stt.speechPauseMs");
  positiveVoiceInteger(resolved.stt.speechPreRollMs, "voice.stt.speechPreRollMs");
  if (resolved.stt.serverPort > 65_535) throw new Error("voice.stt.serverPort must be <= 65535");
  if (resolved.stt.vadServerPort > 65_535) throw new Error("voice.stt.vadServerPort must be <= 65535");
  if (!Number.isFinite(resolved.stt.monthlyAudioLimitSeconds) || resolved.stt.monthlyAudioLimitSeconds < 0) {
    throw new Error("voice.stt.monthlyAudioLimitSeconds must be a non-negative number");
  }
  if (!Number.isFinite(resolved.stt.estimatedPricePerAudioHourUsd) || resolved.stt.estimatedPricePerAudioHourUsd < 0) {
    throw new Error("voice.stt.estimatedPricePerAudioHourUsd must be a non-negative number");
  }
  if (!Number.isFinite(resolved.stt.vadThreshold) || resolved.stt.vadThreshold <= 0.15 || resolved.stt.vadThreshold >= 1) {
    throw new Error("voice.stt.vadThreshold must be between 0.15 and 1");
  }
  if (resolved.stt.maxUtteranceMs < resolved.stt.minUtteranceMs) {
    throw new Error("voice.stt.maxUtteranceMs must be >= voice.stt.minUtteranceMs");
  }
  return resolved;
}

/**
 * Resolve VPN config from YAML partial.
 * Returns undefined if VPN is not enabled.
 */
function resolveVpnConfig(
  partial: MainConfigYaml["vpn"] | undefined,
  env: Record<string, string | undefined>,
): VpnConfig | undefined {
  if (partial?.enabled !== true) return undefined;
  const apiUrl = env.VPN_API_URL?.trim();
  const vpnPeer = env.VPN_PEER?.trim();
  return {
    enabled: true,
    apiUrl: apiUrl !== undefined && apiUrl !== "" ? apiUrl : partial.apiUrl ?? "",
    vpnPeer: vpnPeer !== undefined && vpnPeer !== "" ? vpnPeer : partial.vpnPeer ?? "",
  };
}

/**
 * Validate VPN config. Throws if enabled but missing required fields.
 */
export function validateVpnConfig(vpn: VpnConfig | undefined): void {
  if (vpn === undefined || !vpn.enabled) return;
  if (vpn.apiUrl === "") throw new Error("vpn.apiUrl required when vpn.enabled");
  if (vpn.vpnPeer === "") throw new Error("vpn.vpnPeer required when vpn.enabled");
}

function clonePromptTransport(config: PromptTransportConfig): PromptTransportConfig {
  return {
    openaiCodex: {
      mode: config.openaiCodex.mode,
      sections: Object.fromEntries(
        PROMPT_TRANSPORT_SECTION_IDS.map((id) => [id, { ...config.openaiCodex.sections[id] }]),
      ) as Record<PromptTransportSectionId, PromptTransportSectionConfig>,
    },
    openrouter: {
      mode: config.openrouter.mode,
      sections: Object.fromEntries(
        PROMPT_TRANSPORT_SECTION_IDS.map((id) => [id, { ...config.openrouter.sections[id] }]),
      ) as Record<PromptTransportSectionId, PromptTransportSectionConfig>,
    },
  };
}

function parsePromptTransportRole(value: unknown, key: string): PromptTransportRole | undefined {
  if (value === undefined) return undefined;
  if (value === "system" || value === "developer" || value === "user") return value;
  throw new Error(`${key} must be "system", "developer", or "user"`);
}

function parsePromptTransportTarget(value: unknown, key: string): PromptTransportTarget | undefined {
  if (value === undefined) return undefined;
  if (value === "instructions" || value === "input") return value;
  throw new Error(`${key} must be "instructions" or "input"`);
}

function parseCodexPromptTransportMode(value: unknown, key: string): CodexPromptTransportMode | undefined {
  if (value === undefined) return undefined;
  if (value === "legacy-instructions" || value === "split-input") return value;
  throw new Error(`${key}.mode must be "legacy-instructions" or "split-input"`);
}

function validatePromptTransportSectionKeys(
  sections: ProviderPromptTransportConfigYaml["sections"] | undefined,
  key: string,
): void {
  if (sections === undefined) return;
  const allowed = new Set<string>(PROMPT_TRANSPORT_SECTION_IDS);
  for (const sectionId of Object.keys(sections)) {
    if (!allowed.has(sectionId)) {
      throw new Error(`${key}.sections.${sectionId} is not a known prompt transport section`);
    }
  }
}

function resolveProviderPromptTransport(
  base: PromptTransportConfig["openaiCodex"],
  partial: ProviderPromptTransportConfigYaml | undefined,
  key: string,
): PromptTransportConfig["openaiCodex"] {
  validatePromptTransportSectionKeys(partial?.sections, key);
  const sections = Object.fromEntries(
    PROMPT_TRANSPORT_SECTION_IDS.map((id) => {
      const baseSection = base.sections[id];
      const partialSection = partial?.sections?.[id];
      return [id, {
        role: parsePromptTransportRole(partialSection?.role, `${key}.sections.${id}.role`) ?? baseSection.role,
        target: parsePromptTransportTarget(partialSection?.target, `${key}.sections.${id}.target`) ?? baseSection.target,
        cacheGroup: partialSection?.cacheGroup ?? baseSection.cacheGroup,
      }];
    }),
  ) as Record<PromptTransportSectionId, PromptTransportSectionConfig>;

  return {
    mode: parseCodexPromptTransportMode(partial?.mode, key) ?? base.mode,
    sections,
  };
}

function validateOpenAiCodexPromptTransport(config: PromptTransportConfig["openaiCodex"]): void {
  for (const sectionId of PROMPT_TRANSPORT_SECTION_IDS) {
    const section = config.sections[sectionId];
    if (section.role === "system" && section.target === "input") {
      throw new Error(`promptTransport.openaiCodex.sections.${sectionId} cannot use role "system" with target "input"; Codex input messages do not allow system roles`);
    }
  }
}

function resolveGlobalPromptTransport(
  partial: PromptTransportConfigYaml | undefined,
): PromptTransportConfig {
  const defaults = clonePromptTransport(DEFAULT_PROMPT_TRANSPORT);
  const openaiCodex = resolveProviderPromptTransport(defaults.openaiCodex, partial?.openaiCodex, "promptTransport.openaiCodex");
  validateOpenAiCodexPromptTransport(openaiCodex);
  return {
    openaiCodex,
    openrouter: resolveProviderPromptTransport(defaults.openrouter, partial?.openrouter, "promptTransport.openrouter"),
  };
}

function resolveGuildPromptTransport(
  global: PromptTransportConfig,
  partial: PromptTransportConfigYaml | undefined,
): PromptTransportConfig {
  const openaiCodex = resolveProviderPromptTransport(global.openaiCodex, partial?.openaiCodex, "promptTransport.openaiCodex");
  validateOpenAiCodexPromptTransport(openaiCodex);
  return {
    openaiCodex,
    openrouter: resolveProviderPromptTransport(global.openrouter, partial?.openrouter, "promptTransport.openrouter"),
  };
}

function resolveGlobalImageReading(
  partial: MainConfigYaml["imageReading"] | undefined,
): ImageReadingConfig {
  return {
    fallbackEnabled: partial?.fallbackEnabled ?? DEFAULT_IMAGE_READING.fallbackEnabled,
    fallbackModelProfile: partial?.fallbackModelProfile ?? DEFAULT_IMAGE_READING.fallbackModelProfile,
  };
}

function resolveGuildImageReading(
  global: ImageReadingConfig,
  partial: GuildConfigYaml["imageReading"] | undefined,
): ImageReadingConfig {
  return {
    fallbackEnabled: partial?.fallbackEnabled ?? global.fallbackEnabled,
    fallbackModelProfile: partial?.fallbackModelProfile ?? global.fallbackModelProfile,
  };
}

function parseImageGenerationQuality(value: unknown, key: string): ImageGenerationQuality | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "low" || value === "medium" || value === "high") return value;
  throw new Error(`${key} must be "auto", "low", "medium", or "high"`);
}

function resolveGlobalImageGeneration(
  partial: MainConfigYaml["imageGeneration"] | undefined,
): ImageGenerationConfig {
  return {
    quality: parseImageGenerationQuality(partial?.quality, "imageGeneration.quality")
      ?? DEFAULT_IMAGE_GENERATION.quality,
    modelProfile: partial?.modelProfile ?? DEFAULT_IMAGE_GENERATION.modelProfile,
  };
}

function resolveGuildImageGeneration(
  global: ImageGenerationConfig,
  partial: GuildConfigYaml["imageGeneration"] | undefined,
): ImageGenerationConfig {
  return {
    quality: parseImageGenerationQuality(partial?.quality, "imageGeneration.quality") ?? global.quality,
    modelProfile: partial?.modelProfile ?? global.modelProfile,
  };
}

function parseLlmProvider(value: unknown, key: string): LlmProvider | undefined {
  if (value === undefined) return undefined;
  if (value === "openrouter" || value === "openai-codex") return value;
  throw new Error(`${key} must be "openrouter" or "openai-codex"`);
}

function parseThinkingLevel(value: unknown, key: string): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (
    value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
  ) {
    return value;
  }
  throw new Error(`${key} must be "minimal", "low", "medium", "high", "xhigh", or "max"`);
}

function parseCodexTransport(value: unknown, key: string): CodexTransport | undefined {
  if (value === undefined) return undefined;
  if (value === "sse" || value === "websocket" || value === "websocket-cached" || value === "auto") {
    return value;
  }
  throw new Error(`${key} must be "sse", "websocket", "websocket-cached", or "auto"`);
}

function parseServiceTier(value: unknown, keyPrefix: string): ServiceTier | undefined {
  if (value === undefined) return undefined;
  if (value === "flex" || value === "priority") return value;
  throw new Error(`${keyPrefix}.serviceTier must be "flex" or "priority"`);
}

function resolveModelProfiles(
  partial: Record<string, ModelProfileConfigYaml> | undefined,
): Record<string, ModelProfileConfig> {
  const source = partial ?? {
    main: {
      provider: DEFAULT_LLM_PROVIDER,
      model: "moonshotai/kimi-k2.5",
      codexTransport: "websocket-cached",
    },
  };
  const resolved: Record<string, ModelProfileConfig> = {};
  for (const [id, profile] of Object.entries(source)) {
    if (id.trim() === "") throw new Error("modelProfiles keys must not be empty");
    const provider = parseLlmProvider(profile.provider, `modelProfiles.${id}.provider`);
    if (provider === undefined) throw new Error(`modelProfiles.${id}.provider is required`);
    if (typeof profile.model !== "string" || profile.model.trim() === "") {
      throw new Error(`modelProfiles.${id}.model must not be empty`);
    }
    resolved[id] = {
      provider,
      model: profile.model,
      modelParams: { ...profile.modelParams },
      thinkingLevel: parseThinkingLevel(profile.thinkingLevel, `modelProfiles.${id}.thinkingLevel`),
      serviceTier: parseServiceTier(profile.serviceTier, `modelProfiles.${id}`),
      codexTransport: parseCodexTransport(profile.codexTransport, `modelProfiles.${id}.codexTransport`)
        ?? "websocket-cached",
      promptCaching: {
        enabled: profile.promptCaching?.enabled ?? DEFAULT_PROMPT_CACHING.enabled,
      },
    };
  }
  if (Object.keys(resolved).length === 0) throw new Error("modelProfiles must define at least one profile");
  return resolved;
}

function requireModelProfile(
  profiles: Record<string, ModelProfileConfig>,
  id: string,
  path: string,
): string {
  if (id.trim() === "") throw new Error(`${path} must not be empty`);
  if (profiles[id] === undefined) throw new Error(`${path} references unknown model profile "${id}"`);
  return id;
}

function validateModelProfileReferences(
  profiles: Record<string, ModelProfileConfig>,
  references: ReadonlyArray<readonly [id: string, path: string]>,
): void {
  for (const [id, path] of references) {
    requireModelProfile(profiles, id, path);
  }
}

function clampProbabilityConfig(value: number, key: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${key} must be between 0 and 1`);
  }
}

function resolveAmbientEvaluatorConfig(
  defaults: AmbientAttentionEvaluatorConfig,
  partial: Partial<AmbientAttentionEvaluatorConfig> | undefined,
): AmbientAttentionEvaluatorConfig {
  const resolved = {
    modelProfile: partial?.modelProfile ?? defaults.modelProfile,
    llmOutputTimeoutMs: partial?.llmOutputTimeoutMs ?? defaults.llmOutputTimeoutMs,
  };
  if (!Number.isFinite(resolved.llmOutputTimeoutMs) || resolved.llmOutputTimeoutMs < 1000) {
    throw new Error("ambientAttention.evaluator.llmOutputTimeoutMs must be >= 1000");
  }
  return resolved;
}

function resolveAmbientInitiativeEvaluatorConfig(
  defaults: AmbientInitiativeEvaluatorConfig,
  partial: Partial<AmbientInitiativeEvaluatorConfig> | undefined,
): AmbientInitiativeEvaluatorConfig {
  const resolved: AmbientInitiativeEvaluatorConfig = {
    modelProfile: partial?.modelProfile ?? defaults.modelProfile,
    llmOutputTimeoutMs: partial?.llmOutputTimeoutMs ?? defaults.llmOutputTimeoutMs,
  };
  if (resolved.modelProfile.trim() === "") {
    throw new Error("ambientInitiative.evaluator.modelProfile must not be empty");
  }
  if (!Number.isFinite(resolved.llmOutputTimeoutMs) || resolved.llmOutputTimeoutMs < 1000) {
    throw new Error("ambientInitiative.evaluator.llmOutputTimeoutMs must be >= 1000");
  }
  return resolved;
}

function resolveAmbientModeConfig<T extends AmbientAttentionModeConfig>(
  defaults: T,
  partial: Partial<T> | undefined,
  keyPrefix: string,
): T {
  const resolved = {
    ...defaults,
    ...partial,
  };
  validateAmbientModeConfig(resolved, keyPrefix);
  return resolved;
}

function resolveAmbientAttentionConfig(
  defaults: AmbientAttentionConfig | undefined,
  partial: AmbientAttentionConfigYaml | undefined,
): AmbientAttentionConfig | undefined {
  const base = defaults ?? DEFAULT_AMBIENT_ATTENTION;
  if (partial === undefined && defaults === undefined) return undefined;
  const resolved: AmbientAttentionConfig = {
    ...base,
    ...partial,
    evaluator: resolveAmbientEvaluatorConfig(base.evaluator, partial?.evaluator),
    ambientPickup: resolveAmbientModeConfig(base.ambientPickup, partial?.ambientPickup, "ambientAttention.ambientPickup"),
    lingering: resolveAmbientModeConfig(base.lingering, partial?.lingering, "ambientAttention.lingering"),
    followUp: resolveAmbientModeConfig(base.followUp, partial?.followUp, "ambientAttention.followUp"),
  };
  validateAmbientAttentionConfig(resolved, "ambientAttention");
  return resolved;
}

function parseAmbientInitiativeBotContactIds(value: unknown, fallback: readonly string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) {
    throw new Error("ambientInitiative.botContactIds must contain non-empty Discord user IDs");
  }
  const contactIds: string[] = [];
  for (const contactId of value as unknown[]) {
    if (typeof contactId !== "string" || contactId.trim() === "") {
      throw new Error("ambientInitiative.botContactIds must contain non-empty Discord user IDs");
    }
    contactIds.push(contactId);
  }
  return contactIds;
}

function resolveAmbientInitiativeConfig(
  defaults: AmbientInitiativeConfig | undefined,
  partial: AmbientInitiativeConfigYaml | undefined,
): AmbientInitiativeConfig | undefined {
  const base = defaults ?? DEFAULT_AMBIENT_INITIATIVE;
  if (partial === undefined && defaults === undefined) return undefined;
  const resolved: AmbientInitiativeConfig = {
    ...base,
    ...partial,
    botContactIds: parseAmbientInitiativeBotContactIds(partial?.botContactIds, base.botContactIds),
    activeHours: {
      ...base.activeHours,
      ...partial?.activeHours,
    },
    evaluator: resolveAmbientInitiativeEvaluatorConfig(base.evaluator, partial?.evaluator),
  };
  validateAmbientInitiativeConfig(resolved, "ambientInitiative");
  return resolved;
}

function validateAmbientModeConfig(config: AmbientAttentionModeConfig, keyPrefix: string): void {
  if (!Number.isFinite(config.minDelayMs) || config.minDelayMs < 0) throw new Error(`${keyPrefix}.minDelayMs must be >= 0`);
  if (!Number.isFinite(config.maxDelayMs) || config.maxDelayMs < config.minDelayMs) {
    throw new Error(`${keyPrefix}.maxDelayMs must be >= minDelayMs`);
  }
  clampProbabilityConfig(config.probabilityThreshold, `${keyPrefix}.probabilityThreshold`);
  clampProbabilityConfig(config.confidenceThreshold, `${keyPrefix}.confidenceThreshold`);
  if (!Number.isFinite(config.cooldownMs) || config.cooldownMs < 0) throw new Error(`${keyPrefix}.cooldownMs must be >= 0`);
  if (!Number.isFinite(config.typingActiveMs) || config.typingActiveMs < 0) throw new Error(`${keyPrefix}.typingActiveMs must be >= 0`);
  if (!Number.isInteger(config.maxRepliesPerUserPerHour) || config.maxRepliesPerUserPerHour < 0) {
    throw new Error(`${keyPrefix}.maxRepliesPerUserPerHour must be >= 0`);
  }
  if (!Number.isInteger(config.maxRepliesPerChannelPerHour) || config.maxRepliesPerChannelPerHour < 0) {
    throw new Error(`${keyPrefix}.maxRepliesPerChannelPerHour must be >= 0`);
  }
  if (!Number.isFinite(config.randomJitter) || config.randomJitter < 0 || config.randomJitter > 1) {
    throw new Error(`${keyPrefix}.randomJitter must be between 0 and 1`);
  }
}

function validateAmbientAttentionConfig(config: AmbientAttentionConfig, keyPrefix: string): void {
  if (!Number.isInteger(config.historyLimit) || config.historyLimit < 5) throw new Error(`${keyPrefix}.historyLimit must be >= 5`);
  if (!Number.isFinite(config.busyWindowMs) || config.busyWindowMs < 0) throw new Error(`${keyPrefix}.busyWindowMs must be >= 0`);
  if (!Number.isInteger(config.busyMessageLimit) || config.busyMessageLimit < 1) throw new Error(`${keyPrefix}.busyMessageLimit must be >= 1`);
  if (!Number.isFinite(config.staleAfterMs) || config.staleAfterMs < 1000) throw new Error(`${keyPrefix}.staleAfterMs must be >= 1000`);
  if (!Number.isInteger(config.maxNewMessagesBeforeDrop) || config.maxNewMessagesBeforeDrop < 0) {
    throw new Error(`${keyPrefix}.maxNewMessagesBeforeDrop must be >= 0`);
  }
  if (!Number.isFinite(config.ambientPickup.minQuietMs) || config.ambientPickup.minQuietMs < 0) {
    throw new Error(`${keyPrefix}.ambientPickup.minQuietMs must be >= 0`);
  }
  if (!Number.isFinite(config.lingering.strongWindowMs) || config.lingering.strongWindowMs < 0) {
    throw new Error(`${keyPrefix}.lingering.strongWindowMs must be >= 0`);
  }
  if (!Number.isFinite(config.lingering.weakWindowMs) || config.lingering.weakWindowMs < config.lingering.strongWindowMs) {
    throw new Error(`${keyPrefix}.lingering.weakWindowMs must be >= strongWindowMs`);
  }
  if (!Number.isFinite(config.lingering.typingExtensionMs) || config.lingering.typingExtensionMs < 0) {
    throw new Error(`${keyPrefix}.lingering.typingExtensionMs must be >= 0`);
  }
  if (!Number.isInteger(config.lingering.maxTypingExtensions) || config.lingering.maxTypingExtensions < 0) {
    throw new Error(`${keyPrefix}.lingering.maxTypingExtensions must be >= 0`);
  }
  if (!Number.isFinite(config.followUp.silenceMs) || config.followUp.silenceMs < 0) {
    throw new Error(`${keyPrefix}.followUp.silenceMs must be >= 0`);
  }
  if (!Number.isInteger(config.followUp.maxPerExchange) || config.followUp.maxPerExchange < 0) {
    throw new Error(`${keyPrefix}.followUp.maxPerExchange must be >= 0`);
  }
}

function validateClockTime(value: string, keyPrefix: string): void {
  if (!/^\d{2}:\d{2}$/.test(value)) throw new Error(`${keyPrefix} must use HH:mm`);
  const [hhRaw, mmRaw] = value.split(":");
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    throw new Error(`${keyPrefix} must use HH:mm`);
  }
}

function validateAmbientInitiativeConfig(config: AmbientInitiativeConfig, keyPrefix: string): void {
  if (new Set(config.botContactIds).size !== config.botContactIds.length) {
    throw new Error(`${keyPrefix}.botContactIds must not contain duplicates`);
  }
  if (!Number.isFinite(config.checkIntervalMinMs) || config.checkIntervalMinMs < 1000) {
    throw new Error(`${keyPrefix}.checkIntervalMinMs must be >= 1000`);
  }
  if (!Number.isFinite(config.checkIntervalMaxMs) || config.checkIntervalMaxMs < config.checkIntervalMinMs) {
    throw new Error(`${keyPrefix}.checkIntervalMaxMs must be >= checkIntervalMinMs`);
  }
  validateClockTime(config.activeHours.start, `${keyPrefix}.activeHours.start`);
  validateClockTime(config.activeHours.end, `${keyPrefix}.activeHours.end`);
  if (!Number.isInteger(config.historyLimit) || config.historyLimit < 5) throw new Error(`${keyPrefix}.historyLimit must be >= 5`);
  if (!Number.isFinite(config.recentActivityMinMs) || config.recentActivityMinMs < 0) throw new Error(`${keyPrefix}.recentActivityMinMs must be >= 0`);
  if (!Number.isFinite(config.recentActivityMaxMs) || config.recentActivityMaxMs < config.recentActivityMinMs) {
    throw new Error(`${keyPrefix}.recentActivityMaxMs must be >= recentActivityMinMs`);
  }
  if (!Number.isFinite(config.quietWindowMs) || config.quietWindowMs < 0) throw new Error(`${keyPrefix}.quietWindowMs must be >= 0`);
  if (!Number.isFinite(config.botCooldownMs) || config.botCooldownMs < 0) throw new Error(`${keyPrefix}.botCooldownMs must be >= 0`);
  clampProbabilityConfig(config.basePressure, `${keyPrefix}.basePressure`);
  clampProbabilityConfig(config.probabilityThreshold, `${keyPrefix}.probabilityThreshold`);
  clampProbabilityConfig(config.confidenceThreshold, `${keyPrefix}.confidenceThreshold`);
  if (!Number.isFinite(config.cooldownMs) || config.cooldownMs < 0) throw new Error(`${keyPrefix}.cooldownMs must be >= 0`);
  if (!Number.isInteger(config.maxPerDay) || config.maxPerDay < 0) throw new Error(`${keyPrefix}.maxPerDay must be >= 0`);
  if (!Number.isInteger(config.minMainChannelHumanMessages) || config.minMainChannelHumanMessages < 0) {
    throw new Error(`${keyPrefix}.minMainChannelHumanMessages must be >= 0`);
  }
  if (!Number.isFinite(config.mainChannelLookbackDays) || config.mainChannelLookbackDays <= 0) {
    throw new Error(`${keyPrefix}.mainChannelLookbackDays must be > 0`);
  }
}

function resolveGlobalReplyLoop(
  partial: MainConfigYaml["replyLoop"] | undefined
): ReplyLoopConfig {
  const resolved = {
    maxToolCalls: partial?.maxToolCalls ?? DEFAULT_REPLY_LOOP.maxToolCalls,
    wallClockTimeoutMs: partial?.wallClockTimeoutMs ?? DEFAULT_REPLY_LOOP.wallClockTimeoutMs,
    llmOutputTimeoutMs: partial?.llmOutputTimeoutMs ?? DEFAULT_REPLY_LOOP.llmOutputTimeoutMs,
  };
  validateReplyLoopConfig(resolved, "replyLoop");
  return resolved;
}

function resolveGuildReplyLoop(
  global: ReplyLoopConfig,
  partial: GuildConfigYaml["replyLoop"] | undefined
): ReplyLoopConfig {
  const resolved = {
    maxToolCalls: partial?.maxToolCalls ?? global.maxToolCalls,
    wallClockTimeoutMs: partial?.wallClockTimeoutMs ?? global.wallClockTimeoutMs,
    llmOutputTimeoutMs: partial?.llmOutputTimeoutMs ?? global.llmOutputTimeoutMs,
  };
  validateReplyLoopConfig(resolved, "replyLoop");
  return resolved;
}

function validateReplyLoopConfig(config: ReplyLoopConfig, keyPrefix: string): void {
  if (!Number.isFinite(config.maxToolCalls) || config.maxToolCalls < 1) {
    throw new Error(`${keyPrefix}.maxToolCalls must be >= 1`);
  }
  if (!Number.isFinite(config.wallClockTimeoutMs) || config.wallClockTimeoutMs < 1000) {
    throw new Error(`${keyPrefix}.wallClockTimeoutMs must be >= 1000`);
  }
  if (!Number.isFinite(config.llmOutputTimeoutMs) || config.llmOutputTimeoutMs < 1000) {
    throw new Error(`${keyPrefix}.llmOutputTimeoutMs must be >= 1000`);
  }
}

function resolveGlobalMemoryExtraction(
  partial: MainConfigYaml["memoryExtraction"] | undefined,
): MemoryExtractionConfig {
  const resolved = {
    modelProfile: partial?.modelProfile ?? DEFAULT_MEMORY_EXTRACTION.modelProfile,
    postReply: partial?.postReply ?? DEFAULT_MEMORY_EXTRACTION.postReply,
    maxToolCalls: partial?.maxToolCalls ?? DEFAULT_MEMORY_EXTRACTION.maxToolCalls,
    ambient: {
      enabled: partial?.ambient?.enabled ?? DEFAULT_MEMORY_EXTRACTION.ambient.enabled,
      everyMessages: partial?.ambient?.everyMessages ?? DEFAULT_MEMORY_EXTRACTION.ambient.everyMessages,
      maxBatchMessages: partial?.ambient?.maxBatchMessages ?? DEFAULT_MEMORY_EXTRACTION.ambient.maxBatchMessages,
      minIntervalSeconds: partial?.ambient?.minIntervalSeconds ?? DEFAULT_MEMORY_EXTRACTION.ambient.minIntervalSeconds,
    },
  };
  validateMemoryExtractionConfig(resolved, "memoryExtraction");
  return resolved;
}

function resolveGuildMemoryExtraction(
  global: MemoryExtractionConfig,
  partial: GuildConfigYaml["memoryExtraction"] | undefined,
): MemoryExtractionConfig {
  const resolved = {
    modelProfile: partial?.modelProfile ?? global.modelProfile,
    postReply: partial?.postReply ?? global.postReply,
    maxToolCalls: partial?.maxToolCalls ?? global.maxToolCalls,
    ambient: {
      enabled: partial?.ambient?.enabled ?? global.ambient.enabled,
      everyMessages: partial?.ambient?.everyMessages ?? global.ambient.everyMessages,
      maxBatchMessages: partial?.ambient?.maxBatchMessages ?? global.ambient.maxBatchMessages,
      minIntervalSeconds: partial?.ambient?.minIntervalSeconds ?? global.ambient.minIntervalSeconds,
    },
  };
  validateMemoryExtractionConfig(resolved, "memoryExtraction");
  return resolved;
}

function validateMemoryExtractionConfig(config: MemoryExtractionConfig, keyPrefix: string): void {
  if (config.modelProfile.trim() === "") {
    throw new Error(`${keyPrefix}.modelProfile must not be empty`);
  }
  if (!Number.isInteger(config.maxToolCalls) || config.maxToolCalls < 1) {
    throw new Error(`${keyPrefix}.maxToolCalls must be >= 1`);
  }
  if (!Number.isInteger(config.ambient.everyMessages) || config.ambient.everyMessages < 1) {
    throw new Error(`${keyPrefix}.ambient.everyMessages must be >= 1`);
  }
  if (!Number.isInteger(config.ambient.maxBatchMessages) || config.ambient.maxBatchMessages < 1) {
    throw new Error(`${keyPrefix}.ambient.maxBatchMessages must be >= 1`);
  }
  if (!Number.isFinite(config.ambient.minIntervalSeconds) || config.ambient.minIntervalSeconds < 0) {
    throw new Error(`${keyPrefix}.ambient.minIntervalSeconds must be >= 0`);
  }
}

function resolveMemoryContext(
  base: MemoryContextConfig | undefined,
  partial: Partial<MemoryContextConfig> | undefined,
): MemoryContextConfig {
  const resolved = {
    maxRows: partial?.maxRows ?? base?.maxRows ?? 80,
  };
  if (!Number.isInteger(resolved.maxRows) || resolved.maxRows < 1 || resolved.maxRows > 500) {
    throw new Error("memoryContext.maxRows must be an integer from 1 to 500");
  }
  return resolved;
}

function resolveRelationshipConfig(
  defaults: RelationshipConfig | undefined,
  partial: RelationshipConfigYaml | undefined,
): RelationshipConfig {
  const base = defaults ?? DEFAULT_RELATIONSHIPS;
  const resolved: RelationshipConfig = {
    modelProfile: partial?.modelProfile ?? base.modelProfile,
    enabled: partial?.enabled ?? base.enabled,
    promptInjection: partial?.promptInjection ?? base.promptInjection,
    maxAxisDeltaPerSignal: partial?.maxAxisDeltaPerSignal ?? base.maxAxisDeltaPerSignal,
    maxToolCalls: partial?.maxToolCalls ?? base.maxToolCalls,
  };
  if (!Number.isFinite(resolved.maxAxisDeltaPerSignal) || resolved.maxAxisDeltaPerSignal < 0) {
    throw new Error("relationships.maxAxisDeltaPerSignal must be >= 0");
  }
  if (!Number.isInteger(resolved.maxToolCalls) || resolved.maxToolCalls < 1) {
    throw new Error("relationships.maxToolCalls must be >= 1");
  }
  return resolved;
}

function resolveTypingSimulationConfig(
  defaults: TypingSimulationConfig,
  partial: Partial<TypingSimulationConfig> | undefined,
): TypingSimulationConfig {
  return {
    enabled: partial?.enabled ?? defaults.enabled,
    inputReadingWpm: partial?.inputReadingWpm ?? defaults.inputReadingWpm,
    inputMinDelayMs: partial?.inputMinDelayMs ?? defaults.inputMinDelayMs,
    inputMaxDelayMs: partial?.inputMaxDelayMs ?? defaults.inputMaxDelayMs,
    outputTypingWpm: partial?.outputTypingWpm ?? defaults.outputTypingWpm,
    outputMinHoldMs: partial?.outputMinHoldMs ?? defaults.outputMinHoldMs,
    outputMaxHoldMs: partial?.outputMaxHoldMs ?? defaults.outputMaxHoldMs,
  };
}

function resolveGlobalAgentJobs(
  partial: MainConfigYaml["agentJobs"] | undefined,
): AgentJobsConfig {
  const resolved = {
    imageTimeoutMs: partial?.imageTimeoutMs ?? DEFAULT_AGENT_JOBS.imageTimeoutMs,
    imageCancelGraceMs: partial?.imageCancelGraceMs ?? DEFAULT_AGENT_JOBS.imageCancelGraceMs,
    terminalVisibleMs: partial?.terminalVisibleMs ?? DEFAULT_AGENT_JOBS.terminalVisibleMs,
    maxImageReplacements: partial?.maxImageReplacements ?? DEFAULT_AGENT_JOBS.maxImageReplacements,
  };
  validateAgentJobsConfig(resolved, "agentJobs");
  return resolved;
}

function resolveGuildAgentJobs(
  global: AgentJobsConfig,
  partial: GuildConfigYaml["agentJobs"] | undefined,
): AgentJobsConfig {
  const resolved = {
    imageTimeoutMs: partial?.imageTimeoutMs ?? global.imageTimeoutMs,
    imageCancelGraceMs: partial?.imageCancelGraceMs ?? global.imageCancelGraceMs,
    terminalVisibleMs: partial?.terminalVisibleMs ?? global.terminalVisibleMs,
    maxImageReplacements: partial?.maxImageReplacements ?? global.maxImageReplacements,
  };
  validateAgentJobsConfig(resolved, "agentJobs");
  return resolved;
}

function validateAgentJobsConfig(config: AgentJobsConfig, keyPrefix: string): void {
  if (!Number.isFinite(config.imageTimeoutMs) || config.imageTimeoutMs < 10_000) {
    throw new Error(`${keyPrefix}.imageTimeoutMs must be >= 10000`);
  }
  if (!Number.isFinite(config.imageCancelGraceMs) || config.imageCancelGraceMs < 0) {
    throw new Error(`${keyPrefix}.imageCancelGraceMs must be >= 0`);
  }
  if (!Number.isFinite(config.terminalVisibleMs) || config.terminalVisibleMs < 0) {
    throw new Error(`${keyPrefix}.terminalVisibleMs must be >= 0`);
  }
  if (!Number.isInteger(config.maxImageReplacements) || config.maxImageReplacements < 0) {
    throw new Error(`${keyPrefix}.maxImageReplacements must be >= 0`);
  }
}

function resolveSchedulePressure(
  defaults: SchedulePressureConfig,
  partial: SchedulePressureConfigYaml | undefined,
  keyPrefix: string,
): SchedulePressureConfig {
  const resolved = {
    maxRequesterRunsPerHour: partial?.maxRequesterRunsPerHour ?? defaults.maxRequesterRunsPerHour,
    maxRequesterRunsPerDay: partial?.maxRequesterRunsPerDay ?? defaults.maxRequesterRunsPerDay,
    maxGuildRunsPerHour: partial?.maxGuildRunsPerHour ?? defaults.maxGuildRunsPerHour,
    maxGuildRunsPerDay: partial?.maxGuildRunsPerDay ?? defaults.maxGuildRunsPerDay,
  };
  validateSchedulePressureConfig(resolved, keyPrefix);
  return resolved;
}

function validateSchedulePressureConfig(config: SchedulePressureConfig, keyPrefix: string): void {
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${keyPrefix}.${key} must be a positive integer`);
    }
  }
}

/**
 * Load and parse the main config YAML file.
 * Returns an empty object if the file does not exist.
 * Throws on malformed YAML.
 */
export function loadMainConfig(configPath: string): MainConfigYaml {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, "utf-8");
  return (parse(raw) ?? {}) as MainConfigYaml;
}

/**
 * Read an instructions file, returning its trimmed content.
 * Returns empty string if the path is empty or the file does not exist.
 */
export function readInstructionsFile(filePath: string): string {
  if (filePath === "") return "";
  if (!existsSync(filePath)) return "";
  return stripMarkdownComments(readFileSync(filePath, "utf-8")).trim();
}

/**
 * Resolve instructions from inline text and/or file path.
 * instructionsPath takes priority over inline instructions.
 * Returns empty string if neither is set.
 */
export function resolveInstructions(
  instructions: string | undefined,
  instructionsPath: string | undefined,
): string {
  if (instructionsPath !== undefined && instructionsPath !== "") {
    const fromFile = readInstructionsFile(instructionsPath);
    if (fromFile !== "") return fromFile;
  }
  return instructions ?? "";
}

function assertNoDeprecatedReplyLoopKey(yaml: MainConfigYaml | GuildConfigYaml, scope: string): void {
  const raw = yaml as Record<string, unknown>;
  if (raw.actionLoop !== undefined) {
    throw new Error(`Deprecated config key "${scope}.actionLoop" is no longer supported. Use ${scope}.replyLoop instead.`);
  }
}

/**
 * Build global config from main YAML config + env vars.
 * YAML provides non-secret defaults; env vars provide secrets and infrastructure overrides.
 * Throws if required secrets are missing.
 */
export function loadGlobalConfig(
  env: Record<string, string | undefined>,
  configPath: string,
): GlobalConfig {
  const discordToken = env.DISCORD_TOKEN;
  if (discordToken === undefined || discordToken === "") throw new Error("DISCORD_TOKEN is required");

  const yaml = loadMainConfig(configPath);
  const configuredRuntimeProfileId = env.PROFILE?.trim();
  const runtimeProfileId = configuredRuntimeProfileId !== undefined && configuredRuntimeProfileId !== ""
    ? configuredRuntimeProfileId
    : basename(dirname(configPath));
  assertNoDeprecatedReplyLoopKey(yaml, "global");
  const dataDir = yaml.dataDir ?? "data";
  const modelProfiles = resolveModelProfiles(yaml.modelProfiles);
  const defaultModelProfile = requireModelProfile(
    modelProfiles,
    yaml.modelProfile ?? "main",
    "modelProfile",
  );
  const defaultImageReading = resolveGlobalImageReading(yaml.imageReading);
  const defaultImageGeneration = resolveGlobalImageGeneration(yaml.imageGeneration);
  const defaultAmbientAttention = resolveAmbientAttentionConfig(undefined, yaml.ambientAttention);
  const defaultAmbientInitiative = resolveAmbientInitiativeConfig(undefined, yaml.ambientInitiative);
  const defaultMemoryExtraction = resolveGlobalMemoryExtraction(yaml.memoryExtraction);
  const defaultMemoryContext = resolveMemoryContext(undefined, yaml.memoryContext);
  const defaultRelationships = resolveRelationshipConfig(undefined, yaml.relationships);
  const defaultVoice = resolveVoiceConfig(DEFAULT_VOICE_CONFIG, yaml.voice);
  const personaModes = resolvePersonaModesConfig(yaml.personaModes, dirname(configPath));
  validateModelProfileReferences(modelProfiles, [
    [defaultModelProfile, "modelProfile"],
    [defaultImageReading.fallbackModelProfile, "imageReading.fallbackModelProfile"],
    [defaultImageGeneration.modelProfile, "imageGeneration.modelProfile"],
    [defaultMemoryExtraction.modelProfile, "memoryExtraction.modelProfile"],
    [defaultRelationships.modelProfile, "relationships.modelProfile"],
    [defaultVoice.modelProfile, "voice.modelProfile"],
    [defaultVoice.maintenance.summary.modelProfile, "voice.maintenance.summary.modelProfile"],
    [defaultVoice.maintenance.extraction.modelProfile, "voice.maintenance.extraction.modelProfile"],
    ...(defaultAmbientAttention !== undefined
      ? [[defaultAmbientAttention.evaluator.modelProfile, "ambientAttention.evaluator.modelProfile"] as const]
      : []),
    ...(defaultAmbientInitiative !== undefined
      ? [[defaultAmbientInitiative.evaluator.modelProfile, "ambientInitiative.evaluator.modelProfile"] as const]
      : []),
  ]);
  const openrouterApiKey = env.OPENROUTER_API_KEY;
  const usesOpenRouter = Object.values(modelProfiles).some((profile) => profile.provider === "openrouter");
  if (usesOpenRouter && (openrouterApiKey === undefined || openrouterApiKey === "")) {
    throw new Error("OPENROUTER_API_KEY is required when any OpenRouter LLM backend is enabled");
  }

  return {
    runtimeProfileId,
    discordToken,
    ...(openrouterApiKey !== undefined && openrouterApiKey !== "" ? { openrouterApiKey } : {}),
    codexAuthPath: env.CODEX_AUTH_PATH ?? `${dataDir}/codex-auth.json`,
    braveApiKey: env.BRAVE_API_KEY,
    externalImages: resolveExternalImagesConfig(yaml.externalImages),
    modelProfiles,
    defaultModelProfile,
    defaultTimezone: yaml.timezone ?? "UTC",
    defaultTrim: {
      trimTrigger: yaml.trim?.trimTrigger ?? DEFAULT_TRIM.trimTrigger,
      trimTarget: yaml.trim?.trimTarget ?? DEFAULT_TRIM.trimTarget,
      windowSize: yaml.trim?.windowSize ?? DEFAULT_TRIM.windowSize,
      messageCharLimit: yaml.trim?.messageCharLimit ?? DEFAULT_TRIM.messageCharLimit,
      replyQuoteChars: yaml.trim?.replyQuoteChars ?? DEFAULT_TRIM.replyQuoteChars,
    },
    defaultTriggers: {
      mention: yaml.triggers?.mention ?? DEFAULT_TRIGGER.mention,
      keywords: yaml.triggers?.keywords ?? [...DEFAULT_TRIGGER.keywords],
      randomChance: yaml.triggers?.randomChance ?? DEFAULT_TRIGGER.randomChance,
      keywordDebounceMs: yaml.triggers?.keywordDebounceMs ?? DEFAULT_TRIGGER.keywordDebounceMs,
      typingIdleMs: yaml.triggers?.typingIdleMs ?? DEFAULT_TRIGGER.typingIdleMs,
      typingResumeGraceMs: yaml.triggers?.typingResumeGraceMs ?? DEFAULT_TRIGGER.typingResumeGraceMs,
      typingMaxWaitMs: yaml.triggers?.typingMaxWaitMs ?? DEFAULT_TRIGGER.typingMaxWaitMs,
    },
    defaultMergeMessageGapSeconds: yaml.mergeMessageGapSeconds ?? 120,
    defaultImageReferenceMaxPerCall: resolveImageReferenceMaxPerCall(yaml.imageReferenceMaxPerCall, 10, "imageReferenceMaxPerCall"),
    defaultImageReading,
    defaultImageGeneration,
    defaultAssetReading: resolveAssetReadingConfig(yaml.assetReading),
    logLevel: yaml.logLevel ?? "info",
    dataDir,
    elevenLabsApiKey: env.ELEVENLABS_API_KEY,
    defaultTts: resolveTtsConfig(yaml.tts),
    uiLang: (yaml.uiLang === "ru" ? "ru" : "en") as UiLang,
    vpn: resolveVpnConfig(yaml.vpn, env),
    defaultEmotes: {
      include: yaml.emotes?.include ?? DEFAULT_EMOTES.include,
    },
    defaultMembers: {
      include: yaml.members?.include ?? DEFAULT_MEMBERS.include,
    },
    defaultDispatcher: {
      enabled: yaml.dispatcher?.enabled ?? DEFAULT_DISPATCHER.enabled,
      mentionDebounceMs: yaml.dispatcher?.mentionDebounceMs ?? DEFAULT_DISPATCHER.mentionDebounceMs,
      defaultDebounceMs: yaml.dispatcher?.defaultDebounceMs ?? DEFAULT_DISPATCHER.defaultDebounceMs,
    },
    defaultTypingSimulation: resolveTypingSimulationConfig(DEFAULT_TYPING_SIMULATION, yaml.typingSimulation),
    defaultAgentJobs: resolveGlobalAgentJobs(yaml.agentJobs),
    defaultSchedulePressure: resolveSchedulePressure(DEFAULT_SCHEDULE_PRESSURE, yaml.schedulePressure, "schedulePressure"),
    defaultPromptTransport: resolveGlobalPromptTransport(yaml.promptTransport),
    defaultAmbientAttention,
    defaultAmbientInitiative,
    defaultReplyLoop: resolveGlobalReplyLoop(yaml.replyLoop),
    defaultMemoryExtraction,
    defaultMemoryContext,
    defaultRelationships,
    defaultVoice,
    personaModes,
  };
}

/** Parse guild id and slug from filename like `123456-my-server.yaml`. */
function parseGuildFilename(filename: string): { guildId: string; slug: string } {
  const stem = filename.replace(/\.ya?ml$/, "");
  const dashIdx = stem.indexOf("-");
  if (dashIdx === -1) {
    return { guildId: stem, slug: "" };
  }
  return { guildId: stem.slice(0, dashIdx), slug: stem.slice(dashIdx + 1) };
}

/**
 * Load a single guild YAML file. Returns a partial config with guildId and slug
 * extracted from the filename.
 */
export function loadGuildConfigFile(
  filePath: string
): GuildConfigYaml & { guildId: string; slug: string } {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = (parse(raw) ?? {}) as GuildConfigYaml;
  assertNoDeprecatedReplyLoopKey(parsed, "guild");
  const { guildId, slug } = parseGuildFilename(basename(filePath));
  return { guildId, slug, ...parsed };
}

/** Merge a guild partial onto global defaults to produce a fully resolved GuildConfig. */
export function resolveGuildConfig(
  global: GlobalConfig,
  partial: GuildConfigYaml & { guildId: string; slug: string }
): GuildConfig {
  const instructions = resolveInstructions(partial.instructions, partial.instructionsPath);
  const config: GuildConfig = {
    guildId: partial.guildId,
    slug: partial.slug,
    triggers: {
      mention: partial.triggers?.mention ?? global.defaultTriggers.mention,
      keywords: partial.triggers?.keywords ?? [...global.defaultTriggers.keywords],
      randomChance: partial.triggers?.randomChance ?? global.defaultTriggers.randomChance,
      keywordDebounceMs: partial.triggers?.keywordDebounceMs ?? global.defaultTriggers.keywordDebounceMs,
      typingIdleMs: partial.triggers?.typingIdleMs ?? global.defaultTriggers.typingIdleMs,
      typingResumeGraceMs: partial.triggers?.typingResumeGraceMs ?? global.defaultTriggers.typingResumeGraceMs,
      typingMaxWaitMs: partial.triggers?.typingMaxWaitMs ?? global.defaultTriggers.typingMaxWaitMs,
    },
    modelProfile: requireModelProfile(
      global.modelProfiles,
      partial.modelProfile ?? global.defaultModelProfile,
      "modelProfile",
    ),
    timezone: partial.timezone ?? global.defaultTimezone,
    trim: {
      trimTrigger: partial.trim?.trimTrigger ?? global.defaultTrim.trimTrigger,
      trimTarget: partial.trim?.trimTarget ?? global.defaultTrim.trimTarget,
      windowSize: partial.trim?.windowSize ?? global.defaultTrim.windowSize,
      messageCharLimit: partial.trim?.messageCharLimit ?? global.defaultTrim.messageCharLimit,
      replyQuoteChars: partial.trim?.replyQuoteChars ?? global.defaultTrim.replyQuoteChars,
    },
    adminUserIds: partial.adminUserIds ?? [],
    mergeMessageGapSeconds: partial.mergeMessageGapSeconds ?? global.defaultMergeMessageGapSeconds,
    imageReferenceMaxPerCall: resolveImageReferenceMaxPerCall(
      partial.imageReferenceMaxPerCall,
      global.defaultImageReferenceMaxPerCall,
      "imageReferenceMaxPerCall",
    ),
    imageReading: resolveGuildImageReading(global.defaultImageReading, partial.imageReading),
    imageGeneration: resolveGuildImageGeneration(global.defaultImageGeneration, partial.imageGeneration),
    assetReading: resolveAssetReadingConfig(partial.assetReading, global.defaultAssetReading),
    instructions,
    tts: resolveTtsConfig(partial.tts) ?? global.defaultTts,
    emotes: {
      include: partial.emotes?.include ?? global.defaultEmotes.include,
    },
    members: {
      include: partial.members?.include ?? global.defaultMembers.include,
    },
    dispatcher: {
      enabled: partial.dispatcher?.enabled ?? global.defaultDispatcher.enabled,
      mentionDebounceMs: partial.dispatcher?.mentionDebounceMs ?? global.defaultDispatcher.mentionDebounceMs,
      defaultDebounceMs: partial.dispatcher?.defaultDebounceMs ?? global.defaultDispatcher.defaultDebounceMs,
    },
    typingSimulation: resolveTypingSimulationConfig(global.defaultTypingSimulation, partial.typingSimulation),
    agentJobs: resolveGuildAgentJobs(global.defaultAgentJobs, partial.agentJobs),
    schedulePressure: resolveSchedulePressure(global.defaultSchedulePressure, partial.schedulePressure, "schedulePressure"),
    promptTransport: resolveGuildPromptTransport(global.defaultPromptTransport, partial.promptTransport),
    ambientAttention: resolveAmbientAttentionConfig(global.defaultAmbientAttention, partial.ambientAttention),
    ambientInitiative: resolveAmbientInitiativeConfig(global.defaultAmbientInitiative, partial.ambientInitiative),
    replyLoop: resolveGuildReplyLoop(global.defaultReplyLoop, partial.replyLoop),
    memoryExtraction: resolveGuildMemoryExtraction(global.defaultMemoryExtraction, partial.memoryExtraction),
    memoryContext: resolveMemoryContext(global.defaultMemoryContext, partial.memoryContext),
    relationships: resolveRelationshipConfig(global.defaultRelationships, partial.relationships),
    voice: resolveVoiceConfig(global.defaultVoice ?? DEFAULT_VOICE_CONFIG, partial.voice),
  };
  validateModelProfileReferences(global.modelProfiles, [
    [config.modelProfile, "modelProfile"],
    [config.imageReading.fallbackModelProfile, "imageReading.fallbackModelProfile"],
    [config.imageGeneration.modelProfile, "imageGeneration.modelProfile"],
    [config.memoryExtraction.modelProfile, "memoryExtraction.modelProfile"],
    ...(config.relationships !== undefined
      ? [[config.relationships.modelProfile, "relationships.modelProfile"] as const]
      : []),
    ...(config.voice !== undefined
      ? [
        [config.voice.modelProfile, "voice.modelProfile"] as const,
        [config.voice.maintenance.summary.modelProfile, "voice.maintenance.summary.modelProfile"] as const,
        [config.voice.maintenance.extraction.modelProfile, "voice.maintenance.extraction.modelProfile"] as const,
      ]
      : []),
    ...(config.ambientAttention !== undefined
      ? [[config.ambientAttention.evaluator.modelProfile, "ambientAttention.evaluator.modelProfile"] as const]
      : []),
    ...(config.ambientInitiative !== undefined
      ? [[config.ambientInitiative.evaluator.modelProfile, "ambientInitiative.evaluator.modelProfile"] as const]
      : []),
  ]);
  return config;
}

/** Validate trim config invariants. Throws on violation. */
export function validateTrimConfig(trim: TrimConfig): void {
  if (trim.windowSize < 1) {
    throw new Error("trim.windowSize must be at least 1");
  }
  if (trim.trimTarget < trim.windowSize) {
    throw new Error("trim.trimTarget must be >= trim.windowSize");
  }
  if (trim.trimTrigger <= trim.trimTarget) {
    throw new Error("trim.trimTrigger must be > trim.trimTarget");
  }
}

/** Load all guild configs from a directory, resolved against global defaults. */
export function loadGuildConfigs(
  guildsDir: string,
  global: GlobalConfig
): Map<string, GuildConfig> {
  const result = new Map<string, GuildConfig>();
  if (!existsSync(guildsDir)) return result;

  const files = readdirSync(guildsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  for (const file of files) {
    const partial = loadGuildConfigFile(join(guildsDir, file));
    const resolved = resolveGuildConfig(global, partial);
    result.set(partial.guildId, resolved);
  }
  return result;
}

/** Persist a resolved guild config back to its YAML file (source of truth). */
export function saveGuildConfig(filePath: string, config: GuildConfig): void {
  // Write only the per-guild fields (not guildId/slug — those are in the filename)
  const yaml: GuildConfigYaml = {
    triggers: config.triggers,
    modelProfile: config.modelProfile,
    timezone: config.timezone,
    trim: config.trim,
    adminUserIds: config.adminUserIds.length > 0 ? config.adminUserIds : undefined,
    mergeMessageGapSeconds: config.mergeMessageGapSeconds,
    imageReferenceMaxPerCall: config.imageReferenceMaxPerCall,
    imageReading: config.imageReading,
    imageGeneration: config.imageGeneration,
    assetReading: config.assetReading,
    instructions: config.instructions !== "" ? config.instructions : undefined,
    tts: config.tts,
    emotes: config.emotes,
    members: config.members,
    dispatcher: config.dispatcher,
    typingSimulation: config.typingSimulation,
    promptTransport: config.promptTransport,
    ambientAttention: config.ambientAttention,
    relationships: config.relationships,
    voice: config.voice,
    replyLoop: config.replyLoop,
    memoryExtraction: config.memoryExtraction,
    memoryContext: config.memoryContext,
  };

  // Strip undefined keys before serializing
  const clean = JSON.parse(JSON.stringify(yaml)) as GuildConfigYaml;
  writeFileSync(filePath, stringify(clean));
}
