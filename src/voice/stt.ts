import type { VoiceSttConfig } from "../config/types.ts";
import type { Logger } from "../logger.ts";

export interface TranscriptionResult {
  text: string;
  language: string;
  model: string;
}

function wavBuffer(pcm: Buffer, sampleRate = 48_000, channels = 2): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Persistent local whisper.cpp adapter.
 *
 * The model is loaded once into whisper-server instead of once per utterance.
 * Audio remains local and is posted as an in-memory WAV, never retained.
 */
export class WhisperServerTranscriber {
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
      const form = new FormData();
      form.append("file", new Blob([Uint8Array.from(wavBuffer(pcm))], { type: "audio/wav" }), "utterance.wav");
      form.append("response_format", "text");
      form.append("language", this.config.language);
      form.append("prompt", this.config.initialPrompt);
      form.append("no_timestamps", "true");
      form.append("best_of", "1");
      form.append("beam_size", "-1");
      form.append("temperature", "0");
      form.append("temperature_inc", "0");
      form.append("suppress_nst", "true");
      const response = await fetch(`http://127.0.0.1:${this.config.serverPort}/inference`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`Local voice transcription failed (${response.status}): ${body.trim().slice(-600)}`);
      }
      const text = body.replace(/\[[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
      this.log.info("voice transcription completed", {
        durationMs: Date.now() - startedAt,
        audioMs: Math.round(pcm.length / (48_000 * 2 * 2) * 1_000),
        characters: text.length,
        language: this.config.language,
      });
      return {
        text,
        language: this.config.language,
        model: this.config.modelPath,
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
      "-m", this.config.modelPath,
      "-l", this.config.language,
      "-t", String(this.config.threads),
      "--prompt", this.config.initialPrompt,
      "--no-gpu",
      "--no-timestamps",
      "--suppress-nst",
    ], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    this.child = child;
    const deadline = Date.now() + Math.min(this.config.timeoutMs, 20_000);
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`whisper-server exited during startup (${child.exitCode})`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${this.config.serverPort}/`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          await response.body?.cancel();
          this.log.info("persistent voice transcription server ready", {
            durationMs: Date.now() - startedAt,
            model: this.config.modelPath,
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
    throw new Error("whisper-server did not become ready before the startup timeout");
  }
}
