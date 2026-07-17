import { PassThrough } from "node:stream";
import type { VoicePreset } from "../tts/types.ts";

interface ElevenLabsOutput {
  audio?: unknown;
  isFinal?: unknown;
  normalizedAlignment?: {
    chars?: unknown;
    charStartTimesMs?: unknown;
    charDurationsMs?: unknown;
  };
  message?: unknown;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

/** One incremental ElevenLabs WebSocket generation feeding an audio stream. */
export class ElevenLabsVoiceStream {
  readonly audio = new PassThrough();
  private socket: WebSocket | undefined;
  private ready: Promise<void>;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  private readonly done: Promise<void>;
  private resolveDone: (() => void) | undefined;
  private rejectDone: ((error: Error) => void) | undefined;
  private closed = false;
  private opened = false;
  private finalized = false;
  private readonly createdAt = Date.now();
  private firstAudioAt: number | undefined;
  private audioBytes = 0;
  private alignedText = "";
  private readonly alignedChars: string[] = [];
  private readonly alignedCharacterEndsMs: number[] = [];
  private alignmentOffsetMs = 0;

  constructor(
    apiKey: string,
    private readonly preset: VoicePreset,
    private readonly onAlignment?: (text: string) => void,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    const url = new URL(`wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(preset.voiceId)}/stream-input`);
    url.searchParams.set("model_id", preset.model);
    url.searchParams.set("output_format", preset.outputFormat ?? "mp3_44100_128");
    url.searchParams.set("sync_alignment", "true");
    url.searchParams.set("auto_mode", "true");
    url.searchParams.set("apply_text_normalization", preset.applyTextNormalization ?? "auto");
    if (preset.seed !== undefined) url.searchParams.set("seed", String(preset.seed));
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.opened = true;
      socket.send(JSON.stringify({
        text: " ",
        xi_api_key: apiKey,
        voice_settings: {
          stability: preset.stability,
          similarity_boost: preset.similarityBoost,
          speed: preset.speed,
          style: preset.style,
          use_speaker_boost: preset.useSpeakerBoost,
        },
      }));
      this.resolveReady?.();
    });
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("error", () => {
      this.fail(new Error("ElevenLabs live voice WebSocket failed"));
    });
    socket.addEventListener("close", (event) => {
      this.closed = true;
      this.audio.end();
      if (!this.opened) this.rejectReady?.(new Error(`ElevenLabs live voice WebSocket closed before opening (${event.code})`));
      if (this.finalized || event.code === 1000) {
        this.resolveDone?.();
      } else {
        this.rejectDone?.(new Error(`ElevenLabs live voice WebSocket closed unexpectedly (${event.code} ${event.reason})`));
      }
    });
  }

  async push(text: string, flush = false): Promise<void> {
    if (this.closed) throw new Error("ElevenLabs live voice stream is already closed");
    await this.ready;
    this.socket?.send(JSON.stringify({ text: `${text} `, flush }));
  }

  async finish(): Promise<void> {
    if (this.closed) return;
    await this.ready;
    // ElevenLabs treats an empty text frame as closeConnection. Adding flush
    // leaves the context open until its inactivity timeout.
    this.socket?.send(JSON.stringify({ text: "" }));
    const timeout = setTimeout(() => {
      this.fail(new Error("ElevenLabs live voice stream did not finalize within 15 seconds"));
      this.socket?.close();
    }, 15_000);
    try {
      await this.done;
    } finally {
      clearTimeout(timeout);
    }
  }

  abort(): void {
    this.closed = true;
    this.socket?.close();
    this.audio.end();
    this.resolveDone?.();
  }

  audibleText(): string {
    return this.alignedText.trim();
  }

  metrics(): { audioBytes: number; firstAudioLatencyMs?: number } {
    return {
      audioBytes: this.audioBytes,
      ...(this.firstAudioAt === undefined ? {} : { firstAudioLatencyMs: this.firstAudioAt - this.createdAt }),
    };
  }

  /** Return only characters whose aligned audio has reached the playback clock. */
  audibleTextAt(playbackMs: number): string {
    let count = 0;
    while ((this.alignedCharacterEndsMs[count] ?? Number.POSITIVE_INFINITY) <= playbackMs) count += 1;
    return this.alignedChars.slice(0, count).join("").trim();
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let output: ElevenLabsOutput;
    try {
      output = JSON.parse(data) as ElevenLabsOutput;
    } catch {
      return;
    }
    if (typeof output.message === "string" && output.message !== "") {
      this.fail(new Error(`ElevenLabs live voice error: ${output.message}`));
      this.socket?.close();
      return;
    }
    if (typeof output.audio === "string" && output.audio !== "") {
      const audio = Buffer.from(output.audio, "base64");
      this.firstAudioAt ??= Date.now();
      this.audioBytes += audio.length;
      this.audio.write(audio);
    }
    const chars = output.normalizedAlignment?.chars;
    const starts = output.normalizedAlignment?.charStartTimesMs;
    const durations = output.normalizedAlignment?.charDurationsMs;
    if (isStringArray(chars) && isNumberArray(starts) && isNumberArray(durations)) {
      const text = chars.join("");
      this.alignedText += text;
      this.alignedChars.push(...chars);
      for (let index = 0; index < chars.length; index += 1) {
        const start = starts[index];
        const duration = durations[index];
        if (start === undefined || duration === undefined) continue;
        this.alignedCharacterEndsMs.push(this.alignmentOffsetMs + start + duration);
      }
      const lastStart = starts.at(-1);
      const lastDuration = durations.at(-1);
      if (typeof lastStart === "number" && typeof lastDuration === "number") {
        this.alignmentOffsetMs += lastStart + lastDuration;
      }
      this.onAlignment?.(this.alignedText);
    }
    if (output.isFinal === true) {
      this.finalized = true;
      this.closed = true;
      this.audio.end();
      this.resolveDone?.();
      this.socket?.close();
    }
  }

  private fail(error: Error): void {
    this.closed = true;
    this.rejectReady?.(error);
    this.rejectDone?.(error);
    this.audio.destroy(error);
  }
}
