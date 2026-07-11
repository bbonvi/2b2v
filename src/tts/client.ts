import type { TextNormalizationMode, TtsResult } from "./types.ts";

/** Minimal fetch-like function signature for dependency injection. */
export type FetchFn = (
  url: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface ElevenLabsClientDeps {
  apiKey: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

export interface GenerateSpeechParams {
  text: string;
  voiceId: string;
  model: string;
  seed?: number;
  applyTextNormalization?: TextNormalizationMode;
  outputFormat?: string;
  voiceSettings: {
    stability: number;
    similarityBoost: number;
    speed: number;
    style: number;
    useSpeakerBoost: boolean;
  };
}

export interface ElevenLabsClient {
  generate: (params: GenerateSpeechParams) => Promise<TtsResult>;
}

const DEFAULT_TIMEOUT_MS = 90_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

async function readElevenLabsError(response: Response): Promise<string | undefined> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (text.trim() === "") return undefined;

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return text.trim();

    const detail = parsed.detail;
    if (typeof detail === "string" && detail.trim() !== "") return detail.trim();
    if (isRecord(detail)) {
      const status = pickString(detail, "status");
      const message = pickString(detail, "message");
      if (status !== undefined && message !== undefined) return `${status}: ${message}`;
      return message ?? status;
    }

    const message = pickString(parsed, "message");
    const status = pickString(parsed, "status");
    if (status !== undefined && message !== undefined) return `${status}: ${message}`;
    return message ?? status ?? text.trim();
  } catch {
    return text.trim();
  }
}

async function formatElevenLabsHttpError(response: Response): Promise<string> {
  const apiMessage = await readElevenLabsError(response);
  if (apiMessage !== undefined) {
    return `ElevenLabs API error ${response.status}: ${apiMessage}`;
  }
  if (response.status === 401) {
    return "Invalid ElevenLabs API key";
  }
  if (response.status === 429) {
    return "ElevenLabs rate limit exceeded";
  }
  if (response.status >= 500) {
    return "ElevenLabs service unavailable";
  }
  return `ElevenLabs API error: ${response.status}`;
}

export function createElevenLabsClient(deps: ElevenLabsClientDeps): ElevenLabsClient {
  const { apiKey, fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = deps;

  return {
    async generate(params: GenerateSpeechParams): Promise<TtsResult> {
      const { text, voiceId, model, seed, applyTextNormalization, outputFormat, voiceSettings } = params;
      const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`);
      if (outputFormat !== undefined && outputFormat.trim() !== "") {
        url.searchParams.set("output_format", outputFormat.trim());
      }

      const body = JSON.stringify({
        text,
        model_id: model,
        ...(seed !== undefined ? { seed } : {}),
        ...(applyTextNormalization !== undefined
          ? { apply_text_normalization: applyTextNormalization }
          : {}),
        voice_settings: {
          stability: voiceSettings.stability,
          similarity_boost: voiceSettings.similarityBoost,
          speed: voiceSettings.speed,
          style: voiceSettings.style,
          use_speaker_boost: voiceSettings.useSpeakerBoost,
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
          return { ok: false, error: await formatElevenLabsHttpError(response) };
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
