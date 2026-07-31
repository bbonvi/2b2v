import { DEFAULT_VOICE_PRESET } from "./defaults.ts";
import type { GuildConfigYaml, MainConfigYaml, VoiceConfig, VoiceConfigYaml } from "./types.ts";
import type { TextNormalizationMode, TtsConfig, VoicePreset } from "../tts/types.ts";

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
export function resolveTtsConfig(
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

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
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
export function resolveVoiceConfig(defaults: VoiceConfig, partial: VoiceConfigYaml | undefined): VoiceConfig {
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
