import type { VoiceSttConfig } from "../config/types.ts";
import type { Logger } from "../logger.ts";
import { LocalVoiceService } from "./local-service.ts";

export interface TranscriptionResult {
  text: string;
  language: string;
  model: string;
}

function transcriptionResult(value: unknown): TranscriptionResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.text !== "string"
    || typeof record.language !== "string"
    || typeof record.model !== "string"
  ) return undefined;
  return {
    text: record.text,
    language: record.language,
    model: record.model,
  };
}

/**
 * Persistent local faster-whisper adapter.
 *
 * The CTranslate2 model is loaded once in a loopback service. Discord PCM remains
 * local and is posted directly from memory, never retained.
 */
export class FasterWhisperTranscriber {
  private readonly service: LocalVoiceService;

  constructor(
    private readonly config: VoiceSttConfig,
    private readonly log: Logger,
  ) {
    this.service = new LocalVoiceService(
      "persistent voice transcription server",
      [
        config.command,
        "--host", "127.0.0.1",
        "--port", String(config.serverPort),
        "--model", config.modelPath,
        "--language", config.language,
        "--threads", String(config.threads),
        "--prompt", config.initialPrompt,
        "--compute-type", config.computeType,
      ],
      config.serverPort,
      Math.min(config.timeoutMs, 20_000),
      log,
    );
  }

  async start(): Promise<void> {
    await this.service.start();
  }

  async transcribe(pcm: Buffer, signal?: AbortSignal): Promise<TranscriptionResult> {
    await this.start();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Local voice transcription timed out")), this.config.timeoutMs);
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const startedAt = Date.now();
    try {
      const response = await fetch(`http://127.0.0.1:${this.config.serverPort}/inference`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: Uint8Array.from(pcm),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        let detail = "Unknown faster-whisper error";
        if (typeof body === "object" && body !== null) {
          const error = (body as Record<string, unknown>).error;
          if (typeof error === "string") detail = error;
        }
        throw new Error(`Local voice transcription failed (${response.status}): ${detail}`);
      }
      const result = transcriptionResult(body);
      if (result === undefined) throw new Error("Local voice transcription returned an invalid response");
      const text = result.text.replace(/\[[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
      this.log.info("voice transcription completed", {
        durationMs: Date.now() - startedAt,
        audioMs: Math.round(pcm.length / (16_000 * 2) * 1_000),
        characters: text.length,
        language: result.language,
      });
      return {
        text,
        language: result.language,
        model: result.model,
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  shutdown(): void {
    this.service.shutdown();
  }
}
