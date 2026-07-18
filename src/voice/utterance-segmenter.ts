import type { VoiceSttConfig } from "../config/types.ts";

export const VOICE_PCM_SAMPLE_RATE = 16_000;
export const VOICE_VAD_FRAME_SAMPLES = 512;
export const VOICE_VAD_FRAME_BYTES = VOICE_VAD_FRAME_SAMPLES * 2;
export const VOICE_VAD_FRAME_MS = VOICE_VAD_FRAME_SAMPLES / VOICE_PCM_SAMPLE_RATE * 1_000;
const BYTES_PER_MS = VOICE_PCM_SAMPLE_RATE * 2 / 1_000;
const TRAILING_PAD_MS = 96;

export interface VoiceUtterance {
  pcm: Buffer;
  startedOffsetMs: number;
  endedOffsetMs: number;
  finalizationLagMs: number;
  speechMs: number;
}

export interface VoiceUtteranceWallClock {
  startedAt: number;
  endedAt: number;
}

export interface SegmenterPushResult {
  speechStarted: boolean;
  speechConfirmed: boolean;
  /** Confirmed audio that can be forwarded to Scribe immediately. */
  streamPcm: Buffer[];
  utterances: VoiceUtterance[];
}

/**
 * Anchors decoded audio duration to when the utterance was actually finalized.
 *
 * Discord receive streams omit wall-clock silence between speaking bursts, so
 * stream-relative PCM offsets cannot be used as conversation timestamps.
 */
export function anchorUtteranceToWallClock(
  utterance: Pick<VoiceUtterance, "startedOffsetMs" | "endedOffsetMs" | "finalizationLagMs">,
  finalizedAt: number,
): VoiceUtteranceWallClock {
  const durationMs = Math.max(0, utterance.endedOffsetMs - utterance.startedOffsetMs);
  const endedAt = finalizedAt - utterance.finalizationLagMs;
  return {
    startedAt: endedAt - durationMs,
    endedAt,
  };
}

/**
 * Converts stateful Silero probabilities into bounded utterances.
 *
 * Confirmed speech is released immediately, while possible ending silence is
 * held locally so idle microphone time is never billed by the remote STT.
 */
export class VoiceUtteranceSegmenter {
  private preRoll: Buffer[] = [];
  private activeFrames: Buffer[] = [];
  private elapsedMs = 0;
  private activeStartedOffsetMs = 0;
  private speechMs = 0;
  private quietMs = 0;
  private sentFrameCount = 0;
  private confirmed = false;

  constructor(private readonly config: Pick<
    VoiceSttConfig,
    "minUtteranceMs" | "maxUtteranceMs" | "speechPauseMs" | "speechPreRollMs" | "vadThreshold"
  >) {}

  get isSpeaking(): boolean {
    return this.activeFrames.length > 0;
  }

  get isConfirmed(): boolean {
    return this.confirmed;
  }

  /** Cumulative confident-speech duration in the active utterance. */
  get activeSpeechMs(): number {
    return this.speechMs;
  }

  push(frame: Buffer, probability: number): SegmenterPushResult {
    if (frame.length !== VOICE_VAD_FRAME_BYTES) {
      throw new Error(`Silero frame must contain exactly ${VOICE_VAD_FRAME_BYTES} PCM bytes`);
    }
    const utterances: VoiceUtterance[] = [];
    const streamPcm: Buffer[] = [];
    let speechStarted = false;
    let speechConfirmed = false;
    const frameIsSpeech = probability >= this.config.vadThreshold;
    const frameIsQuiet = probability < Math.max(0.01, this.config.vadThreshold - 0.15);

    if (!this.isSpeaking) {
      if (frameIsSpeech) {
        const preRollMs = this.preRoll.length * VOICE_VAD_FRAME_MS;
        this.activeStartedOffsetMs = Math.max(0, this.elapsedMs - preRollMs);
        this.activeFrames = [...this.preRoll, Buffer.from(frame)];
        this.preRoll = [];
        this.speechMs = VOICE_VAD_FRAME_MS;
        this.quietMs = 0;
        speechStarted = true;
      } else {
        this.pushPreRoll(frame);
      }
    } else {
      this.activeFrames.push(Buffer.from(frame));
      if (frameIsSpeech) {
        this.speechMs += VOICE_VAD_FRAME_MS;
        this.quietMs = 0;
      } else if (frameIsQuiet || this.quietMs > 0) {
        this.quietMs += VOICE_VAD_FRAME_MS;
      }
    }

    if (this.isSpeaking && !this.confirmed && this.speechMs >= this.config.minUtteranceMs) {
      this.confirmed = true;
      speechConfirmed = true;
      streamPcm.push(...this.unsentFrames());
    } else if (this.confirmed && this.quietMs === 0) {
      streamPcm.push(...this.unsentFrames());
    }

    if (this.isSpeaking) {
      const activeMs = this.activeFrames.length * VOICE_VAD_FRAME_MS;
      if (this.quietMs >= this.config.speechPauseMs || activeMs >= this.config.maxUtteranceMs) {
        const utterance = this.finalizeActive(streamPcm);
        if (utterance !== undefined) utterances.push(utterance);
      }
    }
    this.elapsedMs += VOICE_VAD_FRAME_MS;
    return { speechStarted, speechConfirmed, streamPcm, utterances };
  }

  flush(): SegmenterPushResult {
    const streamPcm: Buffer[] = [];
    const utterance = this.finalizeActive(streamPcm);
    return {
      speechStarted: false,
      speechConfirmed: false,
      streamPcm,
      utterances: utterance === undefined ? [] : [utterance],
    };
  }

  private pushPreRoll(frame: Buffer): void {
    this.preRoll.push(Buffer.from(frame));
    const maxFrames = Math.ceil(this.config.speechPreRollMs / VOICE_VAD_FRAME_MS);
    if (this.preRoll.length > maxFrames) this.preRoll.splice(0, this.preRoll.length - maxFrames);
  }

  private unsentFrames(): Buffer[] {
    const frames = this.activeFrames.slice(this.sentFrameCount);
    this.sentFrameCount = this.activeFrames.length;
    return frames.map((frame) => Buffer.from(frame));
  }

  private finalizeActive(streamPcm: Buffer[]): VoiceUtterance | undefined {
    if (!this.isSpeaking) return undefined;
    const frames = this.activeFrames;
    const speechMs = this.speechMs;
    const startedOffsetMs = this.activeStartedOffsetMs;
    const trimMs = Math.max(0, this.quietMs - TRAILING_PAD_MS);
    const full = Buffer.concat(frames);
    const trimBytes = Math.min(full.length, Math.floor(trimMs * BYTES_PER_MS));
    const pcm = trimBytes === 0 ? full : full.subarray(0, full.length - trimBytes);
    if (this.confirmed) {
      const sentBytes = Math.min(pcm.length, this.sentFrameCount * VOICE_VAD_FRAME_BYTES);
      if (sentBytes < pcm.length) streamPcm.push(Buffer.from(pcm.subarray(sentBytes)));
    }
    const endedOffsetMs = startedOffsetMs + Math.round(pcm.length / BYTES_PER_MS);
    const trailing = frames.slice(Math.max(0, frames.length - Math.ceil(this.config.speechPreRollMs / VOICE_VAD_FRAME_MS)));
    this.preRoll = trailing.map((frame) => Buffer.from(frame));
    const wasConfirmed = this.confirmed;
    this.activeFrames = [];
    this.speechMs = 0;
    this.quietMs = 0;
    this.sentFrameCount = 0;
    this.confirmed = false;
    return !wasConfirmed || speechMs < this.config.minUtteranceMs
      ? undefined
      : { pcm, startedOffsetMs, endedOffsetMs, finalizationLagMs: trimMs, speechMs };
  }
}
