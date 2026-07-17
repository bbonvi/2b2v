import type { VoiceSttConfig } from "../config/types.ts";
import type { Logger } from "../logger.ts";

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
  private child: ReturnType<typeof Bun.spawn> | undefined;
  private ready: Promise<void> | undefined;

  constructor(
    private readonly config: VoiceSttConfig,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    this.ready ??= this.startServer();
    await this.ready;
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
        audioMs: Math.round(pcm.length / (48_000 * 2 * 2) * 1_000),
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
    this.child?.kill();
    this.child = undefined;
    this.ready = undefined;
  }

  private async startServer(): Promise<void> {
    const startedAt = Date.now();
    const child = Bun.spawn([
      this.config.command,
      "--host", "127.0.0.1",
      "--port", String(this.config.serverPort),
      "--model", this.config.modelPath,
      "--language", this.config.language,
      "--threads", String(this.config.threads),
      "--prompt", this.config.initialPrompt,
      "--compute-type", this.config.computeType,
    ], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    this.child = child;
    const deadline = Date.now() + Math.min(this.config.timeoutMs, 20_000);
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`faster-whisper server exited during startup (${child.exitCode})`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${this.config.serverPort}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          await response.body?.cancel();
          this.log.info("persistent voice transcription server ready", {
            durationMs: Date.now() - startedAt,
            model: this.config.modelPath,
            computeType: this.config.computeType,
            language: this.config.language,
            threads: this.config.threads,
          });
          return;
        }
      } catch {
        // Model loading keeps the loopback port unavailable until the server is ready.
      }
      await Bun.sleep(100);
    }
    child.kill();
    throw new Error("faster-whisper server did not become ready before the startup timeout");
  }
}
