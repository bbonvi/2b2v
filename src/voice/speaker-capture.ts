import { EndBehaviorType } from "@discordjs/voice";
import prism from "prism-media";
import type { Logger } from "../logger.ts";
import { DiscordPcmToMono16k } from "./pcm.ts";
import type { VoiceRepository, VoiceTranscriptRecord } from "./repository.ts";
import { ElevenLabsScribeSession } from "./scribe.ts";
import { FasterWhisperTranscriber } from "./stt.ts";
import type { ActiveSession, VoiceTranscriptTiming } from "./runtime-types.ts";
import {
  anchorUtteranceToWallClock,
  VoiceUtteranceSegmenter,
  VOICE_VAD_FRAME_BYTES,
  type VoiceUtterance,
  type VoiceUtteranceWallClock,
} from "./utterance-segmenter.ts";

export type VoiceSpeakerCaptureDeps = {
  elevenLabsApiKey?: string;
  log: Logger;
  repository: VoiceRepository;
  getActive: () => ActiveSession | undefined;
  onConfirmedSpeech: (active: ActiveSession, userId: string, username: string) => void;
  finalizeTranscript: (input: {
    userId: string;
    username: string;
    text: string;
    startedAt: number;
    endedAt: number;
    language: string;
    model: string;
    synthetic: boolean;
    deferTurn?: boolean;
    timing?: VoiceTranscriptTiming;
  }) => Promise<VoiceTranscriptRecord>;
  scheduleOpportunity: (active: ActiveSession) => void;
  fail: (error: unknown) => void;
  emit: () => void;
};

/** Captures one Discord speaker stream and commits its utterances to STT. */
export class VoiceSpeakerCapture {
  private transcriber: FasterWhisperTranscriber | undefined;

  constructor(private readonly deps: VoiceSpeakerCaptureDeps) {}

  shutdown(): void {
    this.transcriber?.shutdown();
    this.transcriber = undefined;
  }

  onSpeakingStart(userId: string): void {
    const active = this.deps.getActive();
    if (active === undefined || active.subscriptions.has(userId)) return;
    const member = active.channel.members.get(userId);
    if (member?.user.bot !== false) return;
    active.subscriptions.add(userId);
    const username = member.user.username;
    const segmenter = new VoiceUtteranceSegmenter(active.voiceConfig.stt);
    const converter = new DiscordPcmToMono16k();
    const streamId = `${active.id}:${userId}:${Date.now()}`;
    const opus = active.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterInactivity,
        duration: Math.max(5_000, active.voiceConfig.stt.speechPauseMs * 4),
      },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    let lastDecodedAt = Date.now();
    let vadBuffer: Buffer = Buffer.alloc(0);
    let processingQueue = Promise.resolve();
    let speakingSafetyTimer: ReturnType<typeof setTimeout> | undefined;
    let decoderFinalized = false;
    let remoteFailure: Error | undefined;
    let remoteBudgetExhausted = false;
    let attemptAudioMs = 0;
    let attemptStartedAt: number | undefined;
    let pendingCommitPcm = Buffer.alloc(0);
    let scribePcmBuffer = Buffer.alloc(0);

    const openScribe = (): ElevenLabsScribeSession => {
      const apiKey = this.deps.elevenLabsApiKey;
      if (apiKey === undefined || apiKey === "") throw new Error("ELEVENLABS_API_KEY is required for live voice.");
      return new ElevenLabsScribeSession(apiKey, active.voiceConfig.stt, {
        onPartial: (text) => {
          active.scribePartials.set(userId, {
            username,
            text,
            vadProbability: active.scribePartials.get(userId)?.vadProbability,
          });
          this.deps.emit();
        },
      });
    };
    let scribe = openScribe();

    const clearSpeaking = (): void => {
      if (speakingSafetyTimer !== undefined) {
        clearTimeout(speakingSafetyTimer);
        speakingSafetyTimer = undefined;
      }
      active.speakingSince.delete(userId);
      if (active.speaking.delete(userId)) this.deps.emit();
    };
    const armSpeakingSafety = (): void => {
      if (speakingSafetyTimer !== undefined) clearTimeout(speakingSafetyTimer);
      const timeoutMs = Math.max(1_500, active.voiceConfig.stt.speechPauseMs * 4);
      speakingSafetyTimer = setTimeout(() => {
        speakingSafetyTimer = undefined;
        if (active.speaking.delete(userId)) {
          active.speakingSince.delete(userId);
          this.deps.log.warn("cleared stale voice speaking state after receive inactivity", {
            userId,
            timeoutMs,
          });
          this.deps.emit();
        }
      }, timeoutMs);
    };
    const stageScribeChunk = async (chunk: Buffer): Promise<void> => {
      if (remoteFailure !== undefined) return;
      if (pendingCommitPcm.length > 0) {
        const pendingAudioMs = Math.round(pendingCommitPcm.length / (16_000 * 2) * 1_000);
        const limitMs = active.voiceConfig.stt.monthlyAudioLimitSeconds * 1_000;
        if (active.elevenLabsAudioMs + pendingAudioMs > limitMs) {
          remoteBudgetExhausted = true;
          remoteFailure = new Error("Monthly ElevenLabs voice audio limit reached");
          scribe.close();
          return;
        }
        try {
          await scribe.push(pendingCommitPcm);
          attemptAudioMs += pendingAudioMs;
          active.elevenLabsAudioMs += pendingAudioMs;
          active.sessionElevenLabsAudioMs += pendingAudioMs;
        } catch (error) {
          remoteFailure = error instanceof Error ? error : new Error(String(error));
          return;
        }
      }
      const audioMs = Math.round(chunk.length / (16_000 * 2) * 1_000);
      const limitMs = active.voiceConfig.stt.monthlyAudioLimitSeconds * 1_000;
      if (active.elevenLabsAudioMs + audioMs > limitMs) {
        remoteBudgetExhausted = true;
        remoteFailure = new Error("Monthly ElevenLabs voice audio limit reached");
        scribe.close();
        return;
      }
      attemptStartedAt ??= Date.now();
      pendingCommitPcm = Buffer.from(chunk);
    };
    const forwardToScribe = async (chunks: Buffer[]): Promise<void> => {
      if (chunks.length > 0) {
        const incoming = Buffer.concat(chunks);
        scribePcmBuffer = scribePcmBuffer.length === 0
          ? incoming
          : Buffer.concat([scribePcmBuffer, incoming]);
      }
      const targetBytes = active.voiceConfig.stt.vadBatchFrames * VOICE_VAD_FRAME_BYTES;
      while (scribePcmBuffer.length >= targetBytes && remoteFailure === undefined) {
        const chunk = Buffer.from(scribePcmBuffer.subarray(0, targetBytes));
        scribePcmBuffer = scribePcmBuffer.subarray(targetBytes);
        await stageScribeChunk(chunk);
      }
    };
    const flushScribeBuffer = async (): Promise<void> => {
      if (scribePcmBuffer.length === 0 || remoteFailure !== undefined) return;
      const chunk = Buffer.from(scribePcmBuffer);
      scribePcmBuffer = Buffer.alloc(0);
      await stageScribeChunk(chunk);
    };
    const processSegmenterResult = async (
      result: ReturnType<VoiceUtteranceSegmenter["push"]>,
      finalizedAt: number,
    ): Promise<void> => {
      if (result.speechStarted) active.speaking.add(userId);
      if (result.speechConfirmed) {
        active.speaking.add(userId);
        active.speakingSince.set(userId, Date.now() - segmenter.activeSpeechMs);
        this.deps.onConfirmedSpeech(active, userId, username);
      }
      if (segmenter.isSpeaking) {
        active.speaking.add(userId);
        armSpeakingSafety();
      } else {
        clearSpeaking();
      }
      await forwardToScribe(result.streamPcm);
      for (const utterance of result.utterances) {
        await flushScribeBuffer();
        const timing = anchorUtteranceToWallClock(utterance, finalizedAt);
        const originalScribe = scribe;
        const originalFailure = remoteFailure;
        const originalBudgetExhausted = remoteBudgetExhausted;
        const originalAudioMs = attemptAudioMs;
        const originalStartedAt = attemptStartedAt ?? finalizedAt;
        const originalCommitPcm = pendingCommitPcm;
        remoteFailure = undefined;
        remoteBudgetExhausted = false;
        attemptAudioMs = 0;
        attemptStartedAt = undefined;
        pendingCommitPcm = Buffer.alloc(0);
        scribePcmBuffer = Buffer.alloc(0);
        await this.completeUtteranceTranscription({
          active,
          userId,
          username,
          timing,
          utterance,
          finalizedAt,
          scribe: originalScribe,
          remoteFailure: originalFailure,
          remoteBudgetExhausted: originalBudgetExhausted,
          remoteAudioMs: originalAudioMs,
          remoteCommitPcm: originalCommitPcm,
          remoteStartedAt: originalStartedAt,
          replaceScribe: (replacement) => {
            scribe = replacement;
          },
          openScribe,
        });
      }
    };
    const enqueueVadBatch = (batch: Buffer, receivedAt: number): void => {
      processingQueue = processingQueue
        .then(async () => {
          if (active.sttController.signal.aborted) return;
          const probabilities = await active.vad.score(streamId, batch, active.sttController.signal);
          for (const [index, probability] of probabilities.entries()) {
            const frame = batch.subarray(index * VOICE_VAD_FRAME_BYTES, (index + 1) * VOICE_VAD_FRAME_BYTES);
            active.scribePartials.set(userId, {
              username,
              text: active.scribePartials.get(userId)?.text ?? "",
              vadProbability: probability,
            });
            const wasSpeaking = segmenter.isSpeaking;
            const result = segmenter.push(frame, probability);
            await processSegmenterResult(result, receivedAt);
            if (wasSpeaking !== segmenter.isSpeaking || result.speechStarted || result.speechConfirmed) this.deps.emit();
          }
        })
        .catch((error: unknown) => {
          if (!active.sttController.signal.aborted) this.deps.fail(error);
        });
    };
    const drainVadBuffer = (receivedAt: number, flush: boolean): void => {
      const normalBatchBytes = active.voiceConfig.stt.vadBatchFrames * VOICE_VAD_FRAME_BYTES;
      while (vadBuffer.length >= normalBatchBytes) {
        const batch = Buffer.from(vadBuffer.subarray(0, normalBatchBytes));
        vadBuffer = vadBuffer.subarray(normalBatchBytes);
        enqueueVadBatch(batch, receivedAt);
      }
      if (flush) {
        const completeBytes = Math.floor(vadBuffer.length / VOICE_VAD_FRAME_BYTES) * VOICE_VAD_FRAME_BYTES;
        if (completeBytes > 0) {
          enqueueVadBatch(Buffer.from(vadBuffer.subarray(0, completeBytes)), receivedAt);
          vadBuffer = vadBuffer.subarray(completeBytes);
        }
      }
    };
    const finalizeDecoder = (): void => {
      if (decoderFinalized) return;
      decoderFinalized = true;
      active.subscriptions.delete(userId);
      clearSpeaking();
      drainVadBuffer(lastDecodedAt, true);
      processingQueue = processingQueue
        .then(async () => {
          const result = segmenter.flush();
          await processSegmenterResult(result, lastDecodedAt);
          scribe.close();
          active.scribePartials.delete(userId);
          await active.vad.reset(streamId);
          this.deps.emit();
        })
        .catch((error: unknown) => {
          if (!active.sttController.signal.aborted) this.deps.fail(error);
        });
    };
    decoder.on("data", (chunk: Buffer | Uint8Array) => {
      lastDecodedAt = Date.now();
      const mono = converter.push(Buffer.from(chunk));
      if (mono.length === 0) return;
      vadBuffer = vadBuffer.length === 0 ? mono : Buffer.concat([vadBuffer, mono]);
      drainVadBuffer(lastDecodedAt, false);
    });
    decoder.once("end", finalizeDecoder);
    decoder.once("close", finalizeDecoder);
    decoder.once("error", (error: Error) => {
      this.deps.log.warn("Discord voice decoder stream failed", {
        userId,
        error: error.message,
      });
      finalizeDecoder();
    });
    opus.once("end", clearSpeaking);
    opus.once("close", () => {
      clearSpeaking();
      if (!decoder.writableEnded) decoder.end();
    });
    opus.once("error", (error: Error) => {
      this.deps.log.warn("Discord voice receive stream failed", {
        userId,
        error: error.message,
      });
      clearSpeaking();
      if (!decoder.writableEnded) decoder.end();
    });
    opus.pipe(decoder);
  }

  private async completeUtteranceTranscription(input: {
    active: ActiveSession;
    username: string;
    userId: string;
    timing: VoiceUtteranceWallClock;
    utterance: VoiceUtterance;
    finalizedAt: number;
    scribe: ElevenLabsScribeSession;
    remoteFailure?: Error;
    remoteBudgetExhausted: boolean;
    remoteAudioMs: number;
    remoteCommitPcm: Buffer;
    remoteStartedAt: number;
    replaceScribe: (scribe: ElevenLabsScribeSession) => void;
    openScribe: () => ElevenLabsScribeSession;
  }): Promise<void> {
    const { active, username, userId, timing, utterance, finalizedAt } = input;
    this.deps.log.debug("voice utterance finalized", {
      userId,
      audioMs: utterance.endedOffsetMs - utterance.startedOffsetMs,
      speechMs: utterance.speechMs,
    });
    const queuedAt = Date.now();
    active.pendingTranscriptions += 1;
    let sttStartedAt = input.remoteStartedAt;
    try {
      if (active.sttController.signal.aborted) return;
      let text: string | undefined;
      let language = active.voiceConfig.stt.language;
      let model = active.voiceConfig.stt.model;
      let remoteError = input.remoteFailure;
      let budgetExhausted = input.remoteBudgetExhausted;
      let finalAudioAttemptedMs = 0;
      const finalAudioMs = Math.round(input.remoteCommitPcm.length / (16_000 * 2) * 1_000);
      const limitMs = active.voiceConfig.stt.monthlyAudioLimitSeconds * 1_000;
      if (remoteError === undefined && active.elevenLabsAudioMs + finalAudioMs > limitMs) {
        budgetExhausted = true;
        remoteError = new Error("Monthly ElevenLabs voice audio limit reached");
      }
      if (remoteError === undefined) {
        try {
          finalAudioAttemptedMs = finalAudioMs;
          active.elevenLabsAudioMs += finalAudioMs;
          active.sessionElevenLabsAudioMs += finalAudioMs;
          const result = await input.scribe.commit(input.remoteCommitPcm);
          text = result.text.replace(/\s+/g, " ").trim();
          this.recordSttUsage(active, userId, "elevenlabs", model, input.remoteStartedAt, input.remoteAudioMs + finalAudioAttemptedMs, "committed");
        } catch (error) {
          remoteError = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (remoteError !== undefined) {
        this.recordSttUsage(active, userId, "elevenlabs", model, input.remoteStartedAt, input.remoteAudioMs + finalAudioAttemptedMs, "failed", remoteError.message);
        input.scribe.close();
        const utteranceAudioMs = Math.round(utterance.pcm.length / (16_000 * 2) * 1_000);
        const remainingBudgetMs = active.voiceConfig.stt.monthlyAudioLimitSeconds * 1_000 - active.elevenLabsAudioMs;
        if (!budgetExhausted && utteranceAudioMs <= remainingBudgetMs) {
          const retry = input.openScribe();
          let retryAudioMs = 0;
          const retryStartedAt = Date.now();
          try {
            const chunks: Buffer[] = [];
            for (let offset = 0; offset < utterance.pcm.length; offset += 3_200) {
              chunks.push(Buffer.from(utterance.pcm.subarray(offset, Math.min(utterance.pcm.length, offset + 3_200))));
            }
            const finalChunk = chunks.pop() ?? Buffer.alloc(0);
            for (const chunk of chunks) {
              await retry.push(chunk);
              const chunkMs = Math.round(chunk.length / (16_000 * 2) * 1_000);
              retryAudioMs += chunkMs;
              active.elevenLabsAudioMs += chunkMs;
              active.sessionElevenLabsAudioMs += chunkMs;
            }
            const finalChunkMs = Math.round(finalChunk.length / (16_000 * 2) * 1_000);
            retryAudioMs += finalChunkMs;
            active.elevenLabsAudioMs += finalChunkMs;
            active.sessionElevenLabsAudioMs += finalChunkMs;
            const result = await retry.commit(finalChunk);
            text = result.text.replace(/\s+/g, " ").trim();
            sttStartedAt = retryStartedAt;
            this.recordSttUsage(active, userId, "elevenlabs", model, retryStartedAt, retryAudioMs, "committed");
            input.replaceScribe(retry);
            remoteError = undefined;
          } catch (error) {
            const retryError = error instanceof Error ? error : new Error(String(error));
            this.recordSttUsage(active, userId, "elevenlabs", model, retryStartedAt, retryAudioMs, "failed", retryError.message);
            retry.close();
            remoteError = retryError;
          }
        }
      }
      if (remoteError !== undefined) {
        this.transcriber ??= new FasterWhisperTranscriber(
          active.voiceConfig.stt,
          this.deps.log.child({ component: "voice-stt-fallback" }),
        );
        sttStartedAt = Date.now();
        const fallbackAudioMs = Math.round(utterance.pcm.length / (16_000 * 2) * 1_000);
        try {
          const fallback = await this.transcriber.transcribe(utterance.pcm, active.sttController.signal);
          text = fallback.text;
          language = fallback.language;
          model = fallback.model;
          this.recordSttUsage(active, userId, "faster-whisper", model, sttStartedAt, fallbackAudioMs, "committed");
        } catch (error) {
          this.recordSttUsage(active, userId, "faster-whisper", active.voiceConfig.stt.modelPath, sttStartedAt, fallbackAudioMs, "failed", error instanceof Error ? error.message : String(error));
          throw error;
        }
        input.replaceScribe(input.openScribe());
      }
      const sttCompletedAt = Date.now();
      active.scribePartials.delete(userId);
      if (text === undefined || text === "" || this.deps.getActive() !== active) return;
      await this.deps.finalizeTranscript({
        userId,
        username,
        text,
        startedAt: timing.startedAt,
        endedAt: timing.endedAt,
        language,
        model,
        synthetic: false,
        deferTurn: true,
        timing: {
          speechStartedAt: timing.startedAt,
          speechEndedAt: timing.endedAt,
          vadFinalizedAt: finalizedAt,
          sttQueuedAt: queuedAt,
          sttStartedAt,
          sttCompletedAt,
        },
      });
    } catch (error) {
      if (!active.sttController.signal.aborted) this.deps.fail(error);
    } finally {
      active.pendingTranscriptions = Math.max(0, active.pendingTranscriptions - 1);
      if (
        active.pendingTranscriptions === 0
        && active.opportunity !== undefined
        && this.deps.getActive() === active
      ) {
        this.deps.scheduleOpportunity(active);
      }
    }
  }

  private recordSttUsage(
    active: ActiveSession,
    userId: string,
    provider: "elevenlabs" | "faster-whisper",
    model: string,
    startedAt: number,
    audioMs: number,
    outcome: "committed" | "failed",
    error?: string,
  ): void {
    this.deps.repository.addSttUsage({
      sessionId: active.id,
      userId,
      provider,
      model,
      startedAt,
      audioMs,
      outcome,
      ...(error === undefined ? {} : { error }),
    });
  }
}
