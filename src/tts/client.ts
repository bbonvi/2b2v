import type { TtsResult } from "./types.ts";

export interface ElevenLabsClientDeps {
  apiKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface GenerateSpeechParams {
  text: string;
  voiceId: string;
  model: string;
  voiceSettings: {
    stability: number;
    similarityBoost: number;
    speed: number;
  };
}

export interface ElevenLabsClient {
  generate: (params: GenerateSpeechParams) => Promise<TtsResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createElevenLabsClient(deps: ElevenLabsClientDeps): ElevenLabsClient {
  const { apiKey, fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = deps;

  return {
    async generate(params: GenerateSpeechParams): Promise<TtsResult> {
      const { text, voiceId, model, voiceSettings } = params;
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

      const body = JSON.stringify({
        text,
        model_id: model,
        voice_settings: {
          stability: voiceSettings.stability,
          similarity_boost: voiceSettings.similarityBoost,
          speed: voiceSettings.speed,
        },
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchFn(url, {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          if (response.status === 401) {
            return { ok: false, error: "Invalid ElevenLabs API key" };
          }
          if (response.status === 429) {
            return { ok: false, error: "ElevenLabs rate limit exceeded" };
          }
          if (response.status >= 500) {
            return { ok: false, error: "ElevenLabs service unavailable" };
          }
          return { ok: false, error: `ElevenLabs API error: ${response.status}` };
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        return {
          ok: true,
          buffer,
          contentType: "audio/mpeg",
        };
      } catch (err) {
        clearTimeout(timeoutId);

        if (err instanceof Error) {
          if (err.name === "AbortError") {
            return { ok: false, error: "Voice generation timed out" };
          }
          if (err.message.includes("fetch") || err.message.includes("network")) {
            return { ok: false, error: "Network error during voice generation" };
          }
        }
        return { ok: false, error: "Network error during voice generation" };
      }
    },
  };
}
