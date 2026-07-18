import type { VoiceSttConfig } from "../config/types.ts";

interface ScribeEvent {
  message_type?: unknown;
  text?: unknown;
  error?: unknown;
  message?: unknown;
}

export interface ScribeCommitResult {
  text: string;
  audioMs: number;
}

export interface ScribeCallbacks {
  onOpen?: () => void;
  onPartial?: (text: string) => void;
}

interface PendingCommit {
  audioMs: number;
  resolve: (result: ScribeCommitResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * One ElevenLabs Scribe Realtime connection.
 *
 * Silence is filtered before this boundary. Only locally confirmed 16 kHz mono
 * PCM reaches ElevenLabs, and a committed result is the sole durable output.
 */
export class ElevenLabsScribeSession {
  private readonly socket: WebSocket;
  private readonly ready: Promise<void>;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  private readonly pendingCommits: PendingCommit[] = [];
  private sentBytesSinceCommit = 0;
  private sentFirstAudio = false;
  private closed = false;

  constructor(
    apiKey: string,
    private readonly config: VoiceSttConfig,
    private readonly callbacks: ScribeCallbacks = {},
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch(() => {});
    const url = new URL("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    url.searchParams.set("model_id", config.model);
    url.searchParams.set("audio_format", "pcm_16000");
    url.searchParams.set("language_code", config.language);
    url.searchParams.set("commit_strategy", "manual");
    url.searchParams.set("include_timestamps", "false");
    url.searchParams.set("include_language_detection", "false");
    url.searchParams.set("no_verbatim", "false");
    url.searchParams.set("filter_background_audio", String(config.filterBackgroundAudio));
    const ScribeWebSocket = WebSocket as unknown as {
      new(url: string | URL, options: Bun.WebSocketOptions): WebSocket;
    };
    const socket = new ScribeWebSocket(url, {
      headers: { "xi-api-key": apiKey },
    });
    this.socket = socket;
    socket.addEventListener("open", () => this.callbacks.onOpen?.());
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("error", () => {
      this.fail(new Error("ElevenLabs Scribe WebSocket failed"));
    });
    socket.addEventListener("close", (event) => {
      if (this.closed && event.code === 1000) return;
      this.fail(new Error(`ElevenLabs Scribe WebSocket closed (${event.code} ${event.reason})`));
    });
  }

  async push(pcm: Buffer): Promise<void> {
    if (pcm.length === 0) return;
    await this.ready;
    this.sendAudio(pcm, false);
  }

  async commit(pcm: Buffer = Buffer.alloc(0)): Promise<ScribeCommitResult> {
    await this.ready;
    if (this.closed) throw new Error("ElevenLabs Scribe session is closed");
    if (pcm.length > 0) this.sentBytesSinceCommit += pcm.length;
    const audioMs = Math.round(this.sentBytesSinceCommit / (16_000 * 2) * 1_000);
    this.sentBytesSinceCommit = 0;
    const pending = new Promise<ScribeCommitResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.pendingCommits.findIndex((candidate) => candidate.resolve === resolve);
        if (index >= 0) this.pendingCommits.splice(index, 1);
        reject(new Error("ElevenLabs Scribe did not commit before the timeout"));
      }, this.config.timeoutMs);
      this.pendingCommits.push({ audioMs, resolve, reject, timeout });
    });
    this.sendAudio(pcm, true, false);
    return await pending;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(1000);
    const error = new Error("ElevenLabs Scribe session closed");
    this.rejectReady?.(error);
    this.rejectPending(error);
  }

  /** Audio already sent in the current, not-yet-committed utterance. */
  uncommittedAudioMs(): number {
    return Math.round(this.sentBytesSinceCommit / (16_000 * 2) * 1_000);
  }

  private sendAudio(pcm: Buffer, commit: boolean, countBytes = true): void {
    if (this.closed) throw new Error("ElevenLabs Scribe session is closed");
    if (countBytes) this.sentBytesSinceCommit += pcm.length;
    const message: Record<string, unknown> = {
      message_type: "input_audio_chunk",
      audio_base_64: pcm.toString("base64"),
      sample_rate: 16_000,
      commit,
    };
    if (!this.sentFirstAudio) {
      this.sentFirstAudio = true;
      if (this.config.previousText.trim() !== "") message.previous_text = this.config.previousText.trim();
    }
    this.socket.send(JSON.stringify(message));
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let event: ScribeEvent;
    try {
      event = JSON.parse(data) as ScribeEvent;
    } catch {
      return;
    }
    if (event.message_type === "session_started") {
      this.resolveReady?.();
      return;
    }
    if (event.message_type === "partial_transcript" && typeof event.text === "string") {
      this.callbacks.onPartial?.(event.text);
      return;
    }
    if (
      (event.message_type === "committed_transcript"
        || event.message_type === "committed_transcript_with_timestamps")
      && typeof event.text === "string"
    ) {
      const pending = this.pendingCommits.shift();
      if (pending === undefined) return;
      clearTimeout(pending.timeout);
      pending.resolve({ text: event.text, audioMs: pending.audioMs });
      return;
    }
    if (
      typeof event.message_type === "string"
      && (
        event.message_type.endsWith("_error")
        || [
          "error",
          "quota_exceeded",
          "rate_limited",
          "queue_overflow",
          "resource_exhausted",
          "session_time_limit_exceeded",
          "chunk_size_exceeded",
          "insufficient_audio_activity",
        ].includes(event.message_type)
      )
    ) {
      const detail = typeof event.error === "string"
        ? event.error
        : typeof event.message === "string"
          ? event.message
          : event.message_type;
      this.fail(new Error(`ElevenLabs Scribe error: ${detail}`));
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectReady?.(error);
    this.rejectPending(error);
    this.socket.close();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingCommits.splice(0)) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }
}
