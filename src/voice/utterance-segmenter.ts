import type { VoiceSttConfig } from "../config/types.ts";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const BYTES_PER_MS = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE / 1_000;
const FRAME_BYTES = FRAME_MS * BYTES_PER_MS;
const TRAILING_PAD_MS = 100;

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

function rms(frame: Buffer): number {
  let sum = 0;
  const samples = Math.floor(frame.length / BYTES_PER_SAMPLE);
  for (let offset = 0; offset + 1 < frame.length; offset += BYTES_PER_SAMPLE) {
    const normalized = frame.readInt16LE(offset) / 32_768;
    sum += normalized * normalized;
  }
  return samples === 0 ? 0 : Math.sqrt(sum / samples);
}

/**
 * Splits a decoded Discord PCM stream on a pause in actual speech energy.
 * Constant low-level microphone packets therefore do not keep an utterance open.
 */
export class VoiceUtteranceSegmenter {
  private pending: Buffer = Buffer.alloc(0);
  private preRoll: Buffer[] = [];
  private activeFrames: Buffer[] = [];
  private elapsedMs = 0;
  private activeStartedOffsetMs = 0;
  private speechMs = 0;
  private quietMs = 0;

  constructor(private readonly config: Pick<
    VoiceSttConfig,
    "minUtteranceMs" | "maxUtteranceMs" | "speechPauseMs" | "speechPreRollMs" | "speechRmsThreshold"
  >) {}

  get isSpeaking(): boolean {
    return this.activeFrames.length > 0;
  }

  /** Cumulative speech-energy duration in the active utterance. */
  get activeSpeechMs(): number {
    return this.speechMs;
  }

  push(chunk: Buffer): SegmenterPushResult {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const utterances: VoiceUtterance[] = [];
    let speechStarted = false;
    while (this.pending.length >= FRAME_BYTES) {
      const frame = this.pending.subarray(0, FRAME_BYTES);
      this.pending = this.pending.subarray(FRAME_BYTES);
      const frameIsSpeech = rms(frame) >= this.config.speechRmsThreshold;
      if (!this.isSpeaking) {
        if (frameIsSpeech) {
          const preRollMs = this.preRoll.length * FRAME_MS;
          this.activeStartedOffsetMs = Math.max(0, this.elapsedMs - preRollMs);
          this.activeFrames = [...this.preRoll, Buffer.from(frame)];
          this.preRoll = [];
          this.speechMs = FRAME_MS;
          this.quietMs = 0;
          speechStarted = true;
        } else {
          this.pushPreRoll(frame);
        }
      } else {
        this.activeFrames.push(Buffer.from(frame));
        if (frameIsSpeech) {
          this.speechMs += FRAME_MS;
          this.quietMs = 0;
        } else {
          this.quietMs += FRAME_MS;
        }
        const activeMs = this.activeFrames.length * FRAME_MS;
        if (this.quietMs >= this.config.speechPauseMs || activeMs >= this.config.maxUtteranceMs) {
          const utterance = this.finalizeActive();
          if (utterance !== undefined) utterances.push(utterance);
        }
      }
      this.elapsedMs += FRAME_MS;
    }
    return { speechStarted, utterances };
  }

  flush(): VoiceUtterance[] {
    const utterance = this.finalizeActive();
    this.pending = Buffer.alloc(0);
    return utterance === undefined ? [] : [utterance];
  }

  private pushPreRoll(frame: Buffer): void {
    this.preRoll.push(Buffer.from(frame));
    const maxFrames = Math.ceil(this.config.speechPreRollMs / FRAME_MS);
    if (this.preRoll.length > maxFrames) this.preRoll.splice(0, this.preRoll.length - maxFrames);
  }

  private finalizeActive(): VoiceUtterance | undefined {
    if (!this.isSpeaking) return undefined;
    const frames = this.activeFrames;
    const speechMs = this.speechMs;
    const startedOffsetMs = this.activeStartedOffsetMs;
    const trimMs = Math.max(0, this.quietMs - TRAILING_PAD_MS);
    const full = Buffer.concat(frames);
    const trimBytes = Math.min(full.length, Math.floor(trimMs * BYTES_PER_MS));
    const pcm = trimBytes === 0 ? full : full.subarray(0, full.length - trimBytes);
    const endedOffsetMs = startedOffsetMs + Math.round(pcm.length / BYTES_PER_MS);
    const trailing = frames.slice(Math.max(0, frames.length - Math.ceil(this.config.speechPreRollMs / FRAME_MS)));
    this.preRoll = trailing.map((frame) => Buffer.from(frame));
    this.activeFrames = [];
    this.speechMs = 0;
    this.quietMs = 0;
    return speechMs < this.config.minUtteranceMs
      ? undefined
      : { pcm, startedOffsetMs, endedOffsetMs, finalizationLagMs: trimMs, speechMs };
  }
}
