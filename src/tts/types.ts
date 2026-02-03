/** Configuration for a single voice preset. */
export interface VoicePreset {
  voiceId: string;
  speed: number; // 0.5-2.0, default 1.0
  stability: number; // 0-1, default 0.5
  similarityBoost: number; // 0-1, default 0.75
  model: string; // e.g., "eleven_flash_v2_5"
}

/** TTS configuration block from config.yaml */
export interface TtsConfig {
  enabled: boolean;
  voices: {
    normal: VoicePreset;
    whisper?: VoicePreset;
  };
}

/** Result from TTS generation. */
export type TtsResult =
  | { ok: true; buffer: Buffer; contentType: string }
  | { ok: false; error: string };
