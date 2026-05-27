/** ElevenLabs text normalization mode for a generation request. */
export type TextNormalizationMode = "auto" | "on" | "off";

/** Configuration for a single voice preset. */
export interface VoicePreset {
  voiceId: string;
  speed: number; // 0.5-2.0, default 1.0
  stability: number; // 0-1, default 0.5
  similarityBoost: number; // 0-1, default 0.75
  style: number; // 0-1, default 0
  useSpeakerBoost: boolean; // default false
  seed?: number;
  applyTextNormalization?: TextNormalizationMode;
  outputFormat?: string;
  model: string; // e.g., "eleven_v3"
}

/** TTS configuration block from config.yaml */
export interface TtsConfig {
  enabled: boolean;
  voices: {
    normal: VoicePreset;
  };
}

/** Result from TTS generation. */
export type TtsResult =
  | { ok: true; buffer: Buffer; contentType: string }
  | { ok: false; error: string };
