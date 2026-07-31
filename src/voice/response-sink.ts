import { PassThrough } from "node:stream";
import {
  AudioPlayerStatus,
  StreamType,
  createAudioResource,
  entersState,
} from "@discordjs/voice";
import prism from "prism-media";
import type { Logger } from "../logger.ts";
import type { VoicePreset } from "../tts/types.ts";
import { ElevenLabsVoiceStream } from "./elevenlabs-stream.ts";
import type { VoiceRepository } from "./repository.ts";
import { VoiceResponseParser } from "./response-parser.ts";
import type {
  ActiveSession,
  VoiceResponseSinkInternal,
  VoiceRuntimeDeps,
} from "./runtime-types.ts";

const OPUS_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

export class VoiceResponseSinkImpl implements VoiceResponseSinkInternal {
  private readonly turnId: string;
  private parser: VoiceResponseParser;
  private tts: ElevenLabsVoiceStream | undefined;
  private rawText = "";
  private plannedText = "";
  private audibleText = "";
  private interruptedByUserId: string | undefined;
  private aborted = false;
  private visible = false;
  private speechQueued = false;
  private firstPhraseRecorded = false;
  private firstDeltaRecorded = false;
  private readonly yieldBoundaries: number[] = [];
  private pendingInterruption: { userId: string; username: string } | undefined;
  private interruptionDeadline?: ReturnType<typeof setTimeout>;
  private boundaryStopTimer?: ReturnType<typeof setTimeout>;
  private pendingPlaybackResource: ReturnType<typeof createAudioResource> | undefined;
  private playbackStartTimer?: ReturnType<typeof setTimeout>;
  private playbackStartPromise: Promise<void> | undefined;
  private resolvePlaybackStart: (() => void) | undefined;
  private initialPlaybackSilenceMs = 0;

  constructor(private readonly deps: {
    active: ActiveSession;
    preset?: VoicePreset;
    apiKey?: string;
    log: Logger;
    repository: VoiceRepository;
    sendMessage: VoiceRuntimeDeps["sendMessage"];
    emit: () => void;
    abortTurn: (userId: string) => void;
    onInstructionResolved: (id: string, summary: string, messageId: string) => void;
    onInstructionIgnored: (id: string) => void;
    triggerSegmentId: number;
    instructionId?: string;
    yieldBoundaryMaxWaitMs: number;
  }) {
    this.turnId = deps.repository.createOutputTurn(
      deps.active.id,
      deps.triggerSegmentId,
      deps.instructionId,
    );
    this.parser = this.createParser();
    this.prepareTts();
  }

  startModelTurn(): void {
    this.deps.repository.addRuntimeEvent({
      sessionId: this.deps.active.id,
      triggerSegmentId: this.deps.triggerSegmentId,
      outputTurnId: this.turnId,
      phase: "model_turn_started",
      occurredAt: Date.now(),
    });
    this.firstDeltaRecorded = false;
    if (this.rawText !== "") {
      this.rawText = "";
      this.parser = this.createParser();
    }
  }

  async push(delta: string): Promise<boolean> {
    if (this.aborted) return false;
    if (!this.firstDeltaRecorded && delta !== "") {
      this.firstDeltaRecorded = true;
      this.deps.repository.addRuntimeEvent({
        sessionId: this.deps.active.id,
        triggerSegmentId: this.deps.triggerSegmentId,
        outputTurnId: this.turnId,
        phase: "model_first_delta",
        occurredAt: Date.now(),
      });
    }
    this.rawText += delta;
    const before = this.visible;
    await this.parser.push(delta);
    return this.visible && !before;
  }

  async finish(finalText: string): Promise<{ visible: boolean; memoryText: string; malformed: boolean }> {
    if (!this.aborted && finalText !== this.rawText) {
      const hadStreamedText = this.rawText !== "";
      this.rawText = finalText;
      if (!hadStreamedText) {
        this.parser = this.createParser();
        await this.parser.push(finalText);
      }
    }
    const result = await this.parser.finish();
    this.plannedText = result.plannedSpeech;
    this.recordYieldBoundary(this.plannedText.length);
    if (this.tts !== undefined && this.speechQueued) {
      await this.tts.finish();
      await this.playbackStartPromise;
      try {
        await entersState(this.deps.active.player, AudioPlayerStatus.Idle, 20_000);
      } catch (error) {
        this.deps.active.player.stop(true);
        throw new Error(
          `Live voice playback did not become idle: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const metrics = this.tts.metrics();
      this.deps.log.info("live voice playback completed", {
        turnId: this.turnId,
        ...metrics,
        played: this.visible,
      });
      if (metrics.audioBytes === 0) throw new Error("ElevenLabs returned no live voice audio.");
      if (!this.visible) throw new Error("Discord audio player never entered the playing state.");
      this.deps.repository.addRuntimeEvent({
        sessionId: this.deps.active.id,
        triggerSegmentId: this.deps.triggerSegmentId,
        outputTurnId: this.turnId,
        phase: "playback_completed",
        occurredAt: Date.now(),
      });
    } else {
      this.tts?.abort();
    }
    this.refreshAudibleText();
    this.deps.repository.finishOutputTurn(
      this.turnId,
      this.plannedText,
      this.audibleText,
      this.interruptedByUserId,
    );
    this.clearInterruptionTimers();
    this.deps.emit();
    return {
      visible: this.visible,
      memoryText: this.audibleText,
      malformed: result.malformed,
    };
  }

  isAudible(): boolean {
    return this.visible
      && !this.aborted
      && this.deps.active.player.state.status !== AudioPlayerStatus.Idle;
  }

  requestInterruption(userId: string, username: string): void {
    if (!this.isAudible() || this.pendingInterruption !== undefined) return;
    this.pendingInterruption = { userId, username };
    this.interruptionDeadline = setTimeout(() => {
      this.interruptionDeadline = undefined;
      this.forceAbort(userId, username);
    }, this.deps.yieldBoundaryMaxWaitMs);
    this.maybeScheduleBoundaryStop();
  }

  abort(userId?: string, username?: string): void {
    if (this.aborted) return;
    if (!this.visible) {
      this.aborted = true;
      this.tts?.abort();
      this.cancelPendingPlayback();
      this.clearInterruptionTimers();
      this.deps.repository.finishOutputTurn(this.turnId, this.plannedText, this.audibleText);
      this.deps.emit();
      return;
    }
    this.forceAbort(userId ?? "unknown", username);
  }

  private forceAbort(userId: string, username?: string): void {
    if (this.aborted) return;
    this.aborted = true;
    this.interruptedByUserId = userId;
    this.refreshAudibleText();
    this.tts?.abort();
    this.cancelPendingPlayback();
    if (this.deps.active.player.state.status !== AudioPlayerStatus.Idle) {
      this.deps.active.player.stop(true);
    }
    this.clearInterruptionTimers();
    if (userId !== "unknown") {
      this.deps.repository.addRuntimeEvent({
        sessionId: this.deps.active.id,
        triggerSegmentId: this.deps.triggerSegmentId,
        outputTurnId: this.turnId,
        phase: "interrupted",
        occurredAt: Date.now(),
        detail: {
          userId,
          username: username ?? null,
          audibleCharacters: this.audibleText.length,
        },
      });
    }
    this.deps.repository.finishOutputTurn(this.turnId, this.plannedText, this.audibleText, this.interruptedByUserId);
    this.deps.emit();
    this.deps.abortTurn(userId);
  }

  snapshot(): { turnId: string; plannedText: string; audibleText: string; interrupted: boolean } {
    return {
      turnId: this.turnId,
      plannedText: this.plannedText,
      audibleText: this.audibleText,
      interrupted: this.interruptedByUserId !== undefined,
    };
  }

  private createParser(): VoiceResponseParser {
    return new VoiceResponseParser({
      onSpeech: async (text) => {
        if (this.aborted) return;
        this.plannedText = `${this.plannedText} ${text}`.trim();
        if (!this.firstPhraseRecorded) {
          this.firstPhraseRecorded = true;
          this.deps.repository.addRuntimeEvent({
            sessionId: this.deps.active.id,
            triggerSegmentId: this.deps.triggerSegmentId,
            outputTurnId: this.turnId,
            phase: "tts_first_phrase",
            occurredAt: Date.now(),
            detail: { characters: text.length },
          });
        }
        const preset = this.deps.preset;
        const apiKey = this.deps.apiKey;
        if (preset === undefined || apiKey === undefined || apiKey === "") {
          throw new Error("Live voice TTS is unavailable.");
        }
        this.prepareTts();
        if (this.tts === undefined) throw new Error("Live voice TTS did not initialize.");
        if (!this.speechQueued) {
          this.speechQueued = true;
          const playbackVolume = this.deps.active.voiceConfig.playback.volume;
          const useInlineVolume = playbackVolume !== 1;
          const inputType = preset.outputFormat?.startsWith("opus_") === true
            ? StreamType.OggOpus
            : StreamType.Arbitrary;
          if (inputType === StreamType.OggOpus) {
            const opusPackets = this.tts.audio.pipe(new prism.opus.OggDemuxer());
            const prefixedPackets = new PassThrough({ objectMode: true });
            this.pendingPlaybackResource = createAudioResource(prefixedPackets, {
              inputType: StreamType.Opus,
              inlineVolume: useInlineVolume,
              silencePaddingFrames: this.deps.active.voiceConfig.playback.trailingSilenceFrames,
            });
            for (let frame = 0; frame < this.deps.active.voiceConfig.playback.initialSilenceFrames; frame += 1) {
              prefixedPackets.write(OPUS_SILENCE_FRAME);
            }
            opusPackets.pipe(prefixedPackets);
            this.initialPlaybackSilenceMs = this.deps.active.voiceConfig.playback.initialSilenceFrames * 20;
          } else {
            this.pendingPlaybackResource = createAudioResource(this.tts.audio, {
              inputType,
              inlineVolume: useInlineVolume,
              silencePaddingFrames: this.deps.active.voiceConfig.playback.trailingSilenceFrames,
            });
          }
          this.pendingPlaybackResource.volume?.setVolume(playbackVolume);
        }
        // auto_mode can begin complete phrases immediately; forcing every
        // sentence creates isolated micro-generations and audible seams.
        await this.tts.push(text);
      },
      onYieldBoundary: (characterOffset) => {
        this.recordYieldBoundary(characterOffset);
      },
      onMessage: async (message) => {
        const result = await this.deps.sendMessage(message, {
          sourceGuildId: this.deps.active.channel.guild.id,
          sourceChannelId: this.deps.active.channel.id,
          sourceMessageId: `voice:${this.deps.active.id}:${this.deps.triggerSegmentId}`,
        });
        if (message.resolvesInstruction !== undefined) {
          this.deps.onInstructionResolved(message.resolvesInstruction, message.text, result.sentMessageId);
        }
      },
      onIgnore: (instructionId) => {
        const id = instructionId ?? this.deps.instructionId;
        if (id !== undefined) this.deps.onInstructionIgnored(id);
      },
    });
  }

  private prepareTts(): void {
    if (this.tts !== undefined) return;
    const preset = this.deps.preset;
    const apiKey = this.deps.apiKey;
    if (preset === undefined || apiKey === undefined || apiKey === "") return;
    const startedAt = Date.now();
    this.deps.repository.addRuntimeEvent({
      sessionId: this.deps.active.id,
      triggerSegmentId: this.deps.triggerSegmentId,
      outputTurnId: this.turnId,
      phase: "tts_socket_started",
      occurredAt: startedAt,
    });
    this.tts = new ElevenLabsVoiceStream(apiKey, preset, {
      onOpen: () => {
        this.deps.repository.addRuntimeEvent({
          sessionId: this.deps.active.id,
          triggerSegmentId: this.deps.triggerSegmentId,
          outputTurnId: this.turnId,
          phase: "tts_socket_opened",
          occurredAt: Date.now(),
          durationMs: Date.now() - startedAt,
        });
        this.deps.emit();
      },
      onFirstAudio: () => {
        this.schedulePlaybackStart();
        this.deps.repository.addRuntimeEvent({
          sessionId: this.deps.active.id,
          triggerSegmentId: this.deps.triggerSegmentId,
          outputTurnId: this.turnId,
          phase: "tts_first_audio",
          occurredAt: Date.now(),
        });
        this.deps.emit();
      },
      onAlignment: () => {
        this.refreshAudibleText();
        this.maybeScheduleBoundaryStop();
        this.deps.emit();
      },
    });
  }

  private schedulePlaybackStart(): void {
    if (
      this.aborted
      || this.pendingPlaybackResource === undefined
      || this.playbackStartPromise !== undefined
    ) return;
    this.playbackStartPromise = new Promise<void>((resolve) => {
      this.resolvePlaybackStart = resolve;
      this.playbackStartTimer = setTimeout(() => {
        this.playbackStartTimer = undefined;
        const resource = this.pendingPlaybackResource;
        this.pendingPlaybackResource = undefined;
        if (!this.aborted && resource !== undefined) {
          this.deps.active.player.once(AudioPlayerStatus.Playing, () => {
            const startedAt = Date.now();
            this.deps.repository.markOutputPlaybackStarted(this.turnId, startedAt);
            this.deps.repository.addRuntimeEvent({
              sessionId: this.deps.active.id,
              triggerSegmentId: this.deps.triggerSegmentId,
              outputTurnId: this.turnId,
              phase: "playback_started",
              occurredAt: startedAt,
            });
            this.visible = true;
            this.deps.emit();
          });
          this.deps.active.player.play(resource);
        }
        this.resolvePlaybackStart?.();
        this.resolvePlaybackStart = undefined;
      }, this.deps.active.voiceConfig.playback.prebufferMs);
    });
  }

  private cancelPendingPlayback(): void {
    if (this.playbackStartTimer !== undefined) {
      clearTimeout(this.playbackStartTimer);
      this.playbackStartTimer = undefined;
    }
    this.pendingPlaybackResource = undefined;
    this.resolvePlaybackStart?.();
    this.resolvePlaybackStart = undefined;
  }

  private refreshAudibleText(): void {
    if (
      this.tts !== undefined
      && this.visible
      && this.interruptedByUserId === undefined
      && this.deps.active.player.state.status === AudioPlayerStatus.Idle
    ) {
      const aligned = this.tts.audibleText();
      this.audibleText = aligned !== "" ? aligned : this.plannedText;
      return;
    }
    const resource = this.deps.active.player.state.status === AudioPlayerStatus.Idle
      ? undefined
      : this.deps.active.player.state.resource;
    const audioPlaybackMs = Math.max(
      0,
      (resource?.playbackDuration ?? 0) - this.initialPlaybackSilenceMs,
    );
    this.audibleText = this.tts?.audibleTextAt(audioPlaybackMs) ?? this.audibleText;
  }

  private recordYieldBoundary(characterOffset: number): void {
    if (
      characterOffset <= 0
      || this.yieldBoundaries.at(-1) === characterOffset
    ) return;
    this.yieldBoundaries.push(characterOffset);
    this.maybeScheduleBoundaryStop();
  }

  private maybeScheduleBoundaryStop(): void {
    if (
      this.pendingInterruption === undefined
      || this.boundaryStopTimer !== undefined
      || this.tts === undefined
      || this.deps.active.player.state.status === AudioPlayerStatus.Idle
    ) return;
    const playbackMs = Math.max(
      0,
      this.deps.active.player.state.resource.playbackDuration - this.initialPlaybackSilenceMs,
    );
    for (const boundary of this.yieldBoundaries) {
      const boundaryMs = this.tts.alignedEndMsAtCharacterOffset(boundary);
      if (boundaryMs === undefined || boundaryMs <= playbackMs) continue;
      const pending = this.pendingInterruption;
      this.boundaryStopTimer = setTimeout(() => {
        this.boundaryStopTimer = undefined;
        this.forceAbort(pending.userId, pending.username);
      }, boundaryMs - playbackMs);
      return;
    }
  }

  private clearInterruptionTimers(): void {
    if (this.interruptionDeadline !== undefined) {
      clearTimeout(this.interruptionDeadline);
      this.interruptionDeadline = undefined;
    }
    if (this.boundaryStopTimer !== undefined) {
      clearTimeout(this.boundaryStopTimer);
      this.boundaryStopTimer = undefined;
    }
  }
}
