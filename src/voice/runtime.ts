import {
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  generateDependencyReport,
  joinVoiceChannel,
} from "@discordjs/voice";
import { ChannelType, PermissionsBitField, type VoiceBasedChannel, type VoiceState } from "discord.js";
import prism from "prism-media";
import type { GuildConfig, VoiceConfig } from "../config/types.ts";
import type {
  VoiceInstructionRecord,
  VoiceMoveHandoff,
  VoiceRuntimePhase,
  VoiceTranscriptRecord,
} from "./repository.ts";
import { SileroVadClient } from "./silero-vad.ts";
import { decideVoiceTrigger } from "./trigger.ts";
import { VoiceResponseSinkImpl } from "./response-sink.ts";
import { VoiceSpeakerCapture } from "./speaker-capture.ts";
import type {
  ActiveSession,
  PendingPresenceAction,
  VoiceOpportunity,
  VoicePresenceActionOrigin,
  VoiceResponseSink,
  VoiceRuntimeDeps,
  VoiceRuntimeSnapshot,
  VoiceTranscriptTiming,
} from "./runtime-types.ts";

export type {
  VoicePresenceActionOrigin,
  VoiceResponseSink,
  VoiceRuntimeDeps,
  VoiceRuntimeSnapshot,
  VoiceTurnOpportunityContext,
  VoiceTurnRequest,
} from "./runtime-types.ts";

function utcMonthStartedAt(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** Global single-connection Discord voice coordinator. */
export class VoiceRuntime {
  private active: ActiveSession | undefined;
  private vad: SileroVadClient | undefined;
  private state: VoiceRuntimeSnapshot["state"] = "disconnected";
  private lastError: string | undefined;
  private readonly listeners = new Set<(snapshot: VoiceRuntimeSnapshot) => void>();
  private readonly speakerCapture: VoiceSpeakerCapture;

  constructor(private readonly deps: VoiceRuntimeDeps) {
    this.speakerCapture = new VoiceSpeakerCapture({
      ...(deps.elevenLabsApiKey !== undefined ? { elevenLabsApiKey: deps.elevenLabsApiKey } : {}),
      log: deps.log,
      repository: deps.repository,
      getActive: () => this.active,
      onConfirmedSpeech: (active, userId, username) => this.onConfirmedSpeech(active, userId, username),
      finalizeTranscript: (input) => this.finalizeTranscript(input),
      scheduleOpportunity: (active) => this.scheduleOpportunity(active),
      fail: (error) => this.fail(error),
      emit: () => this.emit(),
    });
    const recovered = deps.repository.recoverDanglingSessions();
    if (recovered > 0) deps.log.warn("recovered dangling voice sessions", { count: recovered });
    deps.client.on("voiceStateUpdate", (oldState, newState) => this.onVoiceStateUpdate(oldState, newState));
  }

  subscribe(listener: (snapshot: VoiceRuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): VoiceRuntimeSnapshot {
    const active = this.active;
    const now = Date.now();
    const latestSessionId = active?.id ?? this.deps.repository.latestSessions(1)[0]?.id;
    const participants = active === undefined
      ? []
      : [...active.channel.members.values()]
        .filter((member) => !member.user.bot)
        .map((member) => ({ userId: member.id, username: member.user.username }));
    const currentOutput = active?.currentSink?.snapshot();
    const monthStartedAt = utcMonthStartedAt(now);
    const monthlyStt = this.deps.repository.summarizeSttUsage(monthStartedAt, "elevenlabs");
    const configuredVoice = active?.voiceConfig
      ?? [...this.deps.client.guilds.cache.keys()]
        .map((guildId) => this.deps.getGuildConfig(guildId).voice)
        .find((voice) => voice?.enabled === true);
    return {
      enabled: active?.voiceConfig.enabled
        ?? [...this.deps.client.guilds.cache.keys()]
          .some((guildId) => this.deps.getGuildConfig(guildId).voice?.enabled === true),
      state: this.state,
      ...(active !== undefined
        ? {
          sessionId: active.id,
          guildId: active.channel.guild.id,
          guildName: active.channel.guild.name,
          channelId: active.channel.id,
          channelName: active.channel.name,
        }
        : {}),
      participants,
      speakingUserIds: active === undefined ? [] : [...active.speaking],
      attention: {
        humanCount: participants.length,
        active: active !== undefined && active.attentionUntil >= now,
        until: active?.attentionUntil ?? 0,
        remainingMs: active === undefined ? 0 : Math.max(0, active.attentionUntil - now),
        lastTriggerReason: active?.lastTriggerReason ?? "none",
        ...(active?.lastWakeWord !== undefined ? { lastWakeWord: active.lastWakeWord } : {}),
        ...(active?.lastTriggerSegmentId !== undefined
          ? { lastTriggerSegmentId: active.lastTriggerSegmentId }
          : {}),
        ...(active?.pendingTurnSegmentId !== undefined
          ? { pendingSegmentId: active.pendingTurnSegmentId }
          : {}),
        ...(active?.attentionOwner === undefined
          ? {}
          : {
            ownerUserId: active.attentionOwner.userId,
            ownerUsername: active.attentionOwner.username,
          }),
      },
      ...(currentOutput !== undefined ? { currentOutput } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      dependencyReport: generateDependencyReport(),
      transcript: active === undefined ? [] : this.deps.repository.listTranscript(active.id, 150),
      history: active === undefined
        ? []
        : this.deps.repository.listRoomHistory(
          active.channel.guild.id,
          active.channel.id,
          Date.now() - active.voiceConfig.recentSessionContextMs,
          160,
          active.id,
        ),
      instructions: active === undefined
        ? this.deps.repository.recentInstructions(30)
        : this.deps.repository.listOpenInstructions(active.id),
      runtimeEvents: latestSessionId === undefined
        ? []
        : this.deps.repository.listRuntimeEvents(latestSessionId, 300),
      stt: {
        provider: "elevenlabs",
        model: configuredVoice?.stt.model ?? "scribe_v2_realtime",
        partials: active === undefined
          ? []
          : [...active.scribePartials.entries()].map(([userId, partial]) => ({
            userId,
            username: partial.username,
            text: partial.text,
            ...(partial.vadProbability === undefined ? {} : { vadProbability: partial.vadProbability }),
          })),
        sessionAudioMs: active?.sessionElevenLabsAudioMs ?? 0,
        monthlyAudioMs: active?.elevenLabsAudioMs ?? monthlyStt.audioMs,
        monthlyAudioLimitMs: (configuredVoice?.stt.monthlyAudioLimitSeconds ?? 0) * 1_000,
        monthlyAttempts: monthlyStt.attempts,
        monthlyFailures: monthlyStt.failures,
        estimatedMonthlyCostUsd: (active?.elevenLabsAudioMs ?? monthlyStt.audioMs)
          / (60 * 60 * 1_000)
          * (configuredVoice?.stt.estimatedPricePerAudioHourUsd ?? 0.39),
        recentAttempts: latestSessionId === undefined
          ? []
          : this.deps.repository.listSttUsage(latestSessionId, 20),
      },
    };
  }

  async join(
    channelId: string,
    handoff?: VoiceMoveHandoff,
  ): Promise<{ sessionId: string; channelId: string }> {
    if (this.active !== undefined) {
      throw new Error(`Already connected to voice channel ${this.active.channel.name} (${this.active.channel.id}). Leave it before joining another.`);
    }
    // opusscript's shared WASM decoder can abort the entire process on a bad
    // packet. Require the native decoder before admitting a voice session.
    const decoderProbe = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    const decoderType = prism.opus.Decoder.type;
    decoderProbe.destroy();
    if (decoderType !== "@discordjs/opus") {
      throw new Error(`Native Discord Opus decoder unavailable (loaded ${decoderType}).`);
    }
    const { channel, config, voiceConfig } = await this.resolveJoinTarget(channelId);
    this.vad ??= new SileroVadClient(
      voiceConfig.stt,
      this.deps.log.child({ component: "voice-vad" }),
    );
    await this.vad.start();
    const monthUsage = this.deps.repository.summarizeSttUsage(utcMonthStartedAt(Date.now()), "elevenlabs");

    const record = this.deps.repository.createSession(channel.guild.id, channel.id, handoff);
    this.state = "connecting";
    this.emit();
    try {
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
      connection.subscribe(player);
      const active: ActiveSession = {
        id: record.id,
        channel,
        config,
        voiceConfig,
        connection,
        player,
        vad: this.vad,
        sttController: new AbortController(),
        pendingTranscriptions: 0,
        elevenLabsAudioMs: monthUsage.audioMs,
        sessionElevenLabsAudioMs: 0,
        scribePartials: new Map(),
        attentionUntil: 0,
        lastTriggerReason: "none",
        speaking: new Set(),
        speakingSince: new Map(),
        subscriptions: new Set(),
      };
      this.active = active;
      this.state = "active";
      this.deps.repository.updateSession(record.id, { state: "active" });
      for (const memberEntry of channel.members.values()) {
        if (!memberEntry.user.bot) {
          this.deps.repository.addParticipant(
            record.id,
            memberEntry.id,
            memberEntry.user.username,
            record.startedAt,
            true,
          );
        }
      }
      connection.receiver.speaking.on("start", (userId) => this.speakerCapture.onSpeakingStart(userId));
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        void this.leave("Discord voice connection disconnected");
      });
      player.on("error", (error) => this.fail(error));
      this.scheduleEmptyLeave();
      this.emit();
      return { sessionId: record.id, channelId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.repository.updateSession(record.id, { state: "failed", endedAt: Date.now(), error: message });
      this.state = "failed";
      this.lastError = message;
      this.emit();
      throw error;
    }
  }

  async leave(
    reason = "Voice session ended",
    options: { awaitMaintenance?: boolean; runMaintenance?: boolean } = {},
  ): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    this.state = "leaving";
    this.emit();
    if (active.pendingTurn !== undefined) clearTimeout(active.pendingTurn);
    if (active.emptyTimer !== undefined) clearTimeout(active.emptyTimer);
    active.turnController?.abort(new Error(reason));
    active.deferredTurnController = undefined;
    active.sttController.abort(new Error(reason));
    active.currentSink?.abort();
    active.player.stop(true);
    active.connection.destroy();
    const endedAt = Date.now();
    this.deps.repository.updateSession(active.id, { state: "ended", endedAt });
    for (const instruction of this.deps.repository.listOpenInstructions(active.id)) {
      this.deps.repository.updateInstruction(instruction.id, "interrupted", reason);
    }
    this.active = undefined;
    this.state = "disconnected";
    this.emit();
    if (options.runMaintenance === false) return;
    const maintenance = this.deps.onMaintenance(active.id, true).catch((error: unknown) => {
      this.deps.log.warn("voice final maintenance failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    if (options.awaitMaintenance === false) {
      void maintenance;
    } else {
      await maintenance;
    }
  }

  /** Schedule a socially chosen departure after the current live turn finishes. */
  requestLeave(origin: VoicePresenceActionOrigin): { scheduled: true } {
    const active = this.active;
    if (active === undefined) throw new Error("2B is not connected to a voice channel.");
    const controller = active.turnController;
    if (controller === undefined) throw new Error("A live voice turn is not active.");
    if (active.pendingPresenceAction !== undefined) {
      throw new Error("A voice presence change is already scheduled for this turn.");
    }
    active.pendingPresenceAction = { kind: "leave", controller, origin };
    return { scheduled: true };
  }

  /** Validate and schedule a move after the current live turn finishes. */
  async requestMove(
    channelId: string,
    origin: VoicePresenceActionOrigin,
  ): Promise<{ scheduled: boolean; channelId: string }> {
    const active = this.active;
    if (active === undefined) throw new Error("2B is not connected to a voice channel.");
    if (active.channel.id === channelId) return { scheduled: false, channelId };
    await this.resolveJoinTarget(channelId);
    const controller = active.turnController;
    if (controller === undefined) throw new Error("A live voice turn is not active.");
    if (active.pendingPresenceAction !== undefined) {
      throw new Error("A voice presence change is already scheduled for this turn.");
    }
    active.pendingPresenceAction = { kind: "move", channelId, controller, origin };
    return { scheduled: true, channelId };
  }

  /** Move an existing presence now, or join normally when currently disconnected. */
  async move(
    channelId: string,
    origin: VoicePresenceActionOrigin,
  ): Promise<{ sessionId: string; channelId: string; moved: boolean }> {
    const active = this.active;
    if (active === undefined) {
      const joined = await this.join(channelId);
      return { ...joined, moved: false };
    }
    if (active.channel.id === channelId) {
      return { sessionId: active.id, channelId, moved: false };
    }
    await this.resolveJoinTarget(channelId);
    const handoff = this.buildMoveHandoff(active, origin);
    await this.leave(`2B moved to voice channel ${channelId}.`, { awaitMaintenance: false });
    const joined = await this.join(channelId, handoff);
    return { ...joined, moved: true };
  }

  async inject(input: { guildId: string; userId: string; username: string; text: string; trusted?: boolean }): Promise<VoiceTranscriptRecord> {
    const active = this.active;
    if (active === undefined) throw new Error("2B is not connected to a voice channel.");
    const config = active.voiceConfig.testing;
    if (!config.enabled) throw new Error("Synthetic voice input is disabled.");
    if (config.guildIds.length > 0 && !config.guildIds.includes(input.guildId)) {
      throw new Error("Synthetic voice input is not enabled in this guild.");
    }
    const adminIds = active.config.adminUserIds;
    const allowedIds = config.userIds.length > 0 ? config.userIds : adminIds;
    if (input.trusted !== true && !allowedIds.includes(input.userId)) throw new Error("Synthetic voice input is restricted.");
    return await this.finalizeTranscript({
      userId: input.userId,
      username: input.username,
      text: input.text,
      startedAt: Date.now(),
      endedAt: Date.now(),
      language: "test",
      model: "test-injection",
      synthetic: true,
    });
  }

  instruct(input: Omit<VoiceInstructionRecord, "id" | "status" | "createdAt" | "targetSessionId">): VoiceInstructionRecord {
    const active = this.active;
    if (active === undefined) throw new Error("2B is not connected to a voice channel.");
    const instruction = this.deps.repository.createInstruction({ ...input, targetSessionId: active.id });
    this.scheduleNextQueuedInstruction(active);
    this.emit();
    return instruction;
  }

  createResponseSink(triggerSegmentId: number, instructionId?: string): VoiceResponseSink {
    const active = this.active;
    if (active === undefined) throw new Error("Voice session ended before response generation.");
    const sink = new VoiceResponseSinkImpl({
      active,
      preset: active.config.tts?.voices.voiceChannel,
      apiKey: this.deps.elevenLabsApiKey,
      log: this.deps.log,
      repository: this.deps.repository,
      sendMessage: this.deps.sendMessage,
      emit: () => this.emit(),
      abortTurn: (userId) => {
        const controller = active.turnController;
        if (controller !== undefined && !controller.signal.aborted) {
          if (active.opportunity?.instruction !== undefined) {
            active.deferredTurnController = controller;
          }
          controller.abort(new Error(`Voice turn interrupted by ${userId}`));
        }
      },
      onInstructionResolved: (id, summary, messageId) => {
        this.deps.repository.updateInstruction(id, "resolved", summary, messageId);
      },
      onInstructionIgnored: (id) => this.deps.repository.updateInstruction(id, "ignored"),
      triggerSegmentId,
      instructionId,
      yieldBoundaryMaxWaitMs: active.voiceConfig.yieldBoundaryMaxWaitMs,
    });
    active.currentSink = sink;
    this.emit();
    return sink;
  }

  releaseResponseSink(sink: VoiceResponseSink): void {
    const active = this.active;
    if (active?.currentSink === sink) {
      active.currentSink = undefined;
      this.emit();
    }
  }

  presenceContext(now = Date.now()): string {
    const active = this.active;
    if (active !== undefined) {
      const people = [...active.channel.members.values()]
        .filter((member) => !member.user.bot)
        .map((member) => `@${member.user.username} (${member.id})`)
        .join(", ");
      const session = this.deps.repository.getSession(active.id);
      const open = this.deps.repository.listOpenInstructions(active.id);
      return [
        "## Live Voice Presence",
        `2B is currently in voice channel ${active.channel.name} (${active.channel.id}) in guild ${active.channel.guild.name} (${active.channel.guild.id}) and may appear distracted here.`,
        `People present: ${people === "" ? "none" : people}.`,
        session?.rollingSummary !== "" ? `Cached room summary: ${session?.rollingSummary}` : "",
        open.length > 0
          ? `Open voice instructions: ${open.map((item) => `${item.id} ${item.status}: ${item.instruction}`).join(" | ")}`
          : "",
      ].filter((line) => line !== "").join("\n");
    }
    const recent = this.deps.repository.latestSessions(1)[0];
    if (
      recent !== undefined
      && recent.endedAt !== undefined
      && recent.endedAt >= now - (this.deps.getGuildConfig(recent.guildId).voice?.recentSessionContextMs ?? 6 * 60 * 60 * 1000)
    ) {
      return [
        "## Recent Voice Presence",
        `2B recently left voice channel ${recent.channelId} in guild ${recent.guildId}.`,
        recent.finalSummary !== "" ? `Final room summary: ${recent.finalSummary}` : "",
      ].filter((line) => line !== "").join("\n");
    }
    return "";
  }

  async shutdown(): Promise<void> {
    // Final maintenance performs external model calls and must not hold container
    // termination open; the durable transcript remains available after restart.
    await this.leave("Bot shutdown", { runMaintenance: false });
    this.speakerCapture.shutdown();
    this.vad?.shutdown();
    this.vad = undefined;
  }

  private onConfirmedSpeech(active: ActiveSession, userId: string, username: string): void {
    if (this.active !== active) return;
    const opportunity = active.opportunity;
    if (opportunity !== undefined) {
      opportunity.recentInterrupters.push({ userId, username, at: Date.now() });
      if (opportunity.recentInterrupters.length > 8) {
        opportunity.recentInterrupters.splice(0, opportunity.recentInterrupters.length - 8);
      }
    }
    const sink = active.currentSink;
    if (sink?.isAudible() === true) {
      sink.requestInterruption(userId, username);
      return;
    }
    const controller = active.turnController;
    if (
      controller !== undefined
      && !controller.signal.aborted
      && opportunity?.owner?.userId === userId
    ) {
      // The person 2B was attending to resumed before she became audible, so
      // the draft is stale rather than "interrupted" and must be reconsidered.
      active.deferredTurnController = controller;
      controller.abort(new Error(`Attention owner @${username} resumed speaking.`));
      return;
    }
    if (opportunity !== undefined) this.scheduleOpportunity(active);
  }

  private finalizeTranscript(input: {
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
  }): Promise<VoiceTranscriptRecord> {
    const active = this.active;
    if (active === undefined) throw new Error("Voice session ended before transcript finalization.");
    const openInstructions = this.deps.repository.listOpenInstructions(active.id);
    // A newly activated request owns the current exchange; older waiting
    // requests remain durable but must not absorb unrelated room speech.
    const instruction = openInstructions.find((candidate) => candidate.status === "active")
      ?? openInstructions.find((candidate) => candidate.status === "waiting");
    const record = this.deps.repository.addTranscript({
      sessionId: active.id,
      ...(instruction !== undefined ? { instructionId: instruction.id } : {}),
      userId: input.userId,
      username: input.username,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      rawText: input.text,
      normalizedText: input.text.replace(/\s+/g, " ").trim(),
      language: input.language,
      sttModel: input.model,
      source: input.synthetic ? "test_injection" : "stt",
      synthetic: input.synthetic,
    });
    if (input.timing !== undefined) {
      const event = (
        phase: VoiceRuntimePhase,
        occurredAt: number,
        durationMs?: number,
        detail?: Record<string, string | number | boolean | null>,
      ): void => {
        this.deps.repository.addRuntimeEvent({
          sessionId: active.id,
          triggerSegmentId: record.id,
          phase,
          occurredAt,
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(detail === undefined ? {} : { detail }),
        });
      };
      event("speech_started", input.timing.speechStartedAt);
      event("speech_ended", input.timing.speechEndedAt);
      event("vad_finalized", input.timing.vadFinalizedAt, input.timing.vadFinalizedAt - input.timing.speechEndedAt);
      event("stt_queued", input.timing.sttQueuedAt);
      event("stt_started", input.timing.sttStartedAt, input.timing.sttStartedAt - input.timing.sttQueuedAt);
      event(
        "stt_completed",
        input.timing.sttCompletedAt,
        input.timing.sttCompletedAt - input.timing.sttStartedAt,
        {
          provider: input.model === active.voiceConfig.stt.model ? "elevenlabs" : "faster-whisper",
          model: input.model,
        },
      );
    }
    const humans = [...active.channel.members.values()].filter((member) => !member.user.bot).length;
    const decisionAt = Date.now();
    const decision = decideVoiceTrigger({
      text: record.normalizedText,
      userId: record.userId,
      humanCount: humans,
      wakeWords: active.voiceConfig.wakeWords,
      now: decisionAt,
      lingeringAttentionMs: active.voiceConfig.lingeringAttentionMs,
      state: {
        attentionUntil: active.attentionUntil,
        ...(active.attentionOwner === undefined
          ? {}
          : { attentionOwnerUserId: active.attentionOwner.userId }),
      },
    });
    active.attentionUntil = decision.attentionUntil;
    if (decision.attentionOwnerUserId === record.userId) {
      active.attentionOwner = { userId: record.userId, username: record.username };
    }
    active.lastTriggerReason = decision.reason;
    if (decision.wakeWord === undefined) {
      delete active.lastWakeWord;
    } else {
      active.lastWakeWord = decision.wakeWord;
    }
    active.lastTriggerSegmentId = record.id;
    this.deps.repository.addRuntimeEvent({
      sessionId: active.id,
      triggerSegmentId: record.id,
      phase: "trigger_decided",
      occurredAt: decisionAt,
      detail: {
        reason: decision.reason,
        humanCount: humans,
        shouldConsider: decision.shouldConsider,
        attentionUntil: decision.attentionUntil,
        attentionOwnerUserId: decision.attentionOwnerUserId ?? null,
        wakeWord: decision.wakeWord ?? null,
      },
    });
    if (decision.shouldConsider || instruction !== undefined) {
      const source = instruction === undefined
        ? decision.reason
        : "instruction";
      if (source !== "none") {
        const previousOpportunity = active.opportunity;
        const continuesOpportunity = previousOpportunity !== undefined && (
          (
            instruction !== undefined
            && previousOpportunity.instruction?.id === instruction.id
          )
          || (
            instruction === undefined
            && previousOpportunity.instruction === undefined
            && previousOpportunity.owner?.userId === record.userId
          )
        );
        this.queueOpportunity(active, {
          trigger: record,
          source,
          openedAt: continuesOpportunity ? previousOpportunity.openedAt : decisionAt,
          owner: { userId: record.userId, username: record.username },
          ...(instruction === undefined ? {} : { instruction }),
          recentInterrupters: continuesOpportunity
            ? previousOpportunity.recentInterrupters
            : [],
        }, input.deferTurn === true);
      }
    }
    this.maybeRunMaintenance();
    this.emit();
    return Promise.resolve(record);
  }

  private queueOpportunity(
    active: ActiveSession,
    opportunity: VoiceOpportunity,
    deferForTranscription: boolean,
  ): void {
    const previous = active.opportunity;
    active.opportunity = opportunity;
    active.pendingTurnSegmentId = opportunity.trigger.id;
    if (
      active.turnController !== undefined
      && active.currentSink?.isAudible() !== true
      && (
        opportunity.source === "wake_word"
        || previous?.owner?.userId === opportunity.owner?.userId
      )
    ) {
      active.deferredTurnController = active.turnController;
      active.turnController.abort(new Error("Voice response opportunity changed before playback."));
    }
    if (!deferForTranscription && active.pendingTranscriptions === 0) {
      this.scheduleOpportunity(active);
    }
  }

  private scheduleOpportunity(active: ActiveSession): void {
    const opportunity = active.opportunity;
    if (opportunity === undefined || this.active !== active) return;
    if (active.pendingTurn !== undefined) clearTimeout(active.pendingTurn);
    active.pendingTurn = undefined;
    if (active.turnController !== undefined || active.pendingTranscriptions > 0) return;
    if (
      opportunity.owner !== undefined
      && active.speaking.has(opportunity.owner.userId)
    ) return;
    const now = Date.now();
    const otherSpeakerStarts = [...active.speakingSince.entries()]
      .filter(([userId]) => userId !== opportunity.owner?.userId)
      .map(([, startedAt]) => startedAt);
    const otherSpeakerDelay = otherSpeakerStarts.length === 0
      ? 0
      : Math.max(0, active.voiceConfig.otherSpeakerGraceMs - (now - Math.min(...otherSpeakerStarts)));
    const delayMs = Math.max(active.voiceConfig.roomQuietMs, otherSpeakerDelay);
    this.deps.repository.addRuntimeEvent({
      sessionId: active.id,
      triggerSegmentId: opportunity.trigger.id,
      phase: "debounce_scheduled",
      occurredAt: now,
      durationMs: delayMs,
      detail: {
        attentionOwnerUserId: opportunity.owner?.userId ?? null,
        activeOtherSpeakers: otherSpeakerStarts.length,
      },
    });
    active.pendingTurn = setTimeout(() => {
      active.pendingTurn = undefined;
      const current = active.opportunity;
      if (current !== opportunity || this.active !== active) return;
      if (
        current.owner !== undefined
        && active.speaking.has(current.owner.userId)
      ) {
        return;
      }
      const currentNow = Date.now();
      const unconfirmedOtherSpeaker = [...active.speaking]
        .some((userId) =>
          userId !== current.owner?.userId
          && !active.speakingSince.has(userId)
        );
      const unexpiredOtherSpeaker = [...active.speakingSince.entries()]
        .filter(([userId]) => userId !== current.owner?.userId)
        .some(([, startedAt]) =>
          currentNow - startedAt < active.voiceConfig.otherSpeakerGraceMs
        );
      if (
        unconfirmedOtherSpeaker
        || unexpiredOtherSpeaker
        || active.pendingTranscriptions > 0
      ) {
        this.scheduleOpportunity(active);
        return;
      }
      active.pendingTurnSegmentId = undefined;
      this.deps.repository.addRuntimeEvent({
        sessionId: active.id,
        triggerSegmentId: current.trigger.id,
        phase: "debounce_fired",
        occurredAt: currentNow,
      });
      void this.runTurn(current);
    }, delayMs);
  }

  private async runTurn(opportunity: VoiceOpportunity): Promise<void> {
    const active = this.active;
    if (
      active === undefined
      || active.opportunity !== opportunity
      || active.turnController !== undefined
    ) return;
    const controller = new AbortController();
    active.turnController = controller;
    const { trigger, instruction } = opportunity;
    active.currentTurnSegmentId = trigger.id;
    this.deps.repository.addRuntimeEvent({
      sessionId: active.id,
      triggerSegmentId: trigger.id,
      phase: "agent_turn_started",
      occurredAt: Date.now(),
      detail: { instruction: instruction !== undefined },
    });
    try {
      await this.deps.onTurn({
        sessionId: active.id,
        guildId: active.channel.guild.id,
        channelId: active.channel.id,
        trigger,
        transcript: this.deps.repository.listTranscript(active.id, 80),
        history: this.deps.repository.listRoomHistory(
          active.channel.guild.id,
          active.channel.id,
          Date.now() - active.voiceConfig.recentSessionContextMs,
          160,
          active.id,
        ),
        ...(this.deps.repository.getSession(active.id)?.handoff !== undefined
          ? { handoff: this.deps.repository.getSession(active.id)?.handoff }
          : {}),
        ...(instruction !== undefined ? { instruction } : {}),
        opportunity: {
          source: opportunity.source,
          openedAt: opportunity.openedAt,
          ...(opportunity.owner === undefined ? {} : { owner: opportunity.owner }),
          currentSpeakers: [...active.speakingSince.entries()].map(([userId, startedAt]) => ({
            userId,
            username: active.channel.members.get(userId)?.user.username ?? userId,
            speakingForMs: Math.max(0, Date.now() - startedAt),
          })),
          recentInterrupters: [...opportunity.recentInterrupters],
        },
        abortSignal: controller.signal,
      });
      if (instruction !== undefined) {
        const current = this.deps.repository.listOpenInstructions(active.id).find((item) => item.id === instruction.id);
        if (current !== undefined && current.status !== "resolved" && current.status !== "ignored") {
          this.deps.repository.updateInstruction(instruction.id, "waiting");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) this.fail(error);
    } finally {
      const ownsTurn = active.turnController === controller;
      const retainOpportunity = active.deferredTurnController === controller;
      if (retainOpportunity) active.deferredTurnController = undefined;
      if (ownsTurn) {
        active.turnController = undefined;
        active.currentTurnSegmentId = undefined;
      }
      const pending = active.pendingPresenceAction?.controller === controller
        ? active.pendingPresenceAction
        : undefined;
      if (pending !== undefined) active.pendingPresenceAction = undefined;
      if (active.opportunity === opportunity && !retainOpportunity) {
        active.opportunity = undefined;
        active.pendingTurnSegmentId = undefined;
      }
      this.emit();
      if (
        ownsTurn
        && pending !== undefined
        && !controller.signal.aborted
        && this.active === active
      ) {
        await this.applyPresenceAction(active, pending);
      }
      if (ownsTurn && this.active === active) {
        if (active.opportunity === undefined) {
          this.scheduleNextQueuedInstruction(active);
        } else {
          this.scheduleOpportunity(active);
        }
      }
    }
  }

  private activateInstruction(active: ActiveSession, instruction: VoiceInstructionRecord): void {
    this.deps.repository.updateInstruction(instruction.id, "active");
    const synthetic = this.deps.repository.addTranscript({
      sessionId: active.id,
      instructionId: instruction.id,
      userId: instruction.requesterId,
      username: instruction.requesterUsername,
      startedAt: Date.now(),
      endedAt: Date.now(),
      rawText: instruction.instruction,
      normalizedText: instruction.instruction,
      language: "instruction",
      sttModel: "cross-surface-instruction",
      source: "test_injection",
      synthetic: true,
    });
    this.queueOpportunity(active, {
      trigger: synthetic,
      source: "instruction",
      openedAt: Date.now(),
      instruction,
      recentInterrupters: [],
    }, false);
  }

  private scheduleNextQueuedInstruction(active: ActiveSession): void {
    if (
      this.active !== active
      || active.opportunity !== undefined
      || active.turnController !== undefined
    ) return;
    const instruction = this.deps.repository.listOpenInstructions(active.id)
      .find((candidate) => candidate.status === "queued");
    if (instruction !== undefined) this.activateInstruction(active, instruction);
  }

  private maybeRunMaintenance(): void {
    const active = this.active;
    if (active === undefined) return;
    const sessionStartedAt = this.deps.repository.getSession(active.id)?.startedAt ?? Date.now();
    const due = (
      checkpointKind: "summary" | "memory",
      config: { everySegments: number; minIntervalMs: number },
    ): boolean => {
      const checkpoint = this.deps.repository.getCheckpoint(active.id, checkpointKind);
      const afterSegmentId = checkpoint?.throughSegmentId ?? 0;
      const newSegments = this.deps.repository.countTranscriptAfter(active.id, afterSegmentId);
      const lastRunAt = checkpoint?.lastRunAt ?? sessionStartedAt;
      return newSegments >= config.everySegments
        && Date.now() - lastRunAt >= config.minIntervalMs;
    };
    if (
      !due("summary", active.voiceConfig.maintenance.summary)
      && !due("memory", active.voiceConfig.maintenance.extraction)
    ) return;
    void this.deps.onMaintenance(active.id, false).catch((error: unknown) => {
      this.deps.log.warn("voice periodic maintenance failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const active = this.active;
    if (active === undefined) return;
    if (oldState.channelId !== active.channel.id && newState.channelId !== active.channel.id) return;
    const user = newState.member?.user ?? oldState.member?.user;
    if (user === undefined || user.bot) return;
    if (oldState.channelId !== active.channel.id && newState.channelId === active.channel.id) {
      this.deps.repository.addParticipant(active.id, user.id, user.username);
    } else if (oldState.channelId === active.channel.id && newState.channelId !== active.channel.id) {
      this.deps.repository.leaveParticipant(active.id, user.id);
    }
    this.scheduleEmptyLeave();
    this.emit();
  }

  private scheduleEmptyLeave(): void {
    const active = this.active;
    if (active === undefined) return;
    if (active.emptyTimer !== undefined) clearTimeout(active.emptyTimer);
    const humans = [...active.channel.members.values()].filter((member) => !member.user.bot).length;
    if (humans > 0) return;
    active.emptyTimer = setTimeout(() => {
      void this.leave("The voice channel remained empty.");
    }, active.voiceConfig.emptyChannelGraceMs);
  }

  private fail(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.deps.log.error("live voice runtime failed", { error: this.lastError });
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private async resolveJoinTarget(channelId: string): Promise<{
    channel: VoiceBasedChannel;
    config: GuildConfig;
    voiceConfig: VoiceConfig;
  }> {
    const channel = await this.deps.client.channels.fetch(channelId);
    if (
      channel === null
      || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)
    ) {
      throw new Error(`Channel ${channelId} is not a guild voice channel.`);
    }
    const config = this.deps.getGuildConfig(channel.guild.id);
    const voiceConfig = config.voice;
    if (voiceConfig?.enabled !== true) throw new Error("Live voice is disabled for this profile or guild.");
    if (config.tts?.voices.voiceChannel === undefined) {
      throw new Error("tts.voices.voiceChannel is required for live voice.");
    }
    if (this.deps.elevenLabsApiKey === undefined || this.deps.elevenLabsApiKey === "") {
      throw new Error("ELEVENLABS_API_KEY is required for live voice.");
    }
    const member = channel.guild.members.me;
    const permissions = member === null ? undefined : channel.permissionsFor(member);
    if (
      permissions === undefined
      || !permissions.has(PermissionsBitField.Flags.Connect)
      || !permissions.has(PermissionsBitField.Flags.Speak)
    ) {
      throw new Error(`The bot cannot connect and speak in ${channel.name}.`);
    }
    return { channel, config, voiceConfig };
  }

  private async applyPresenceAction(
    active: ActiveSession,
    action: PendingPresenceAction,
  ): Promise<void> {
    if (action.kind === "leave") {
      await this.leave("2B chose to leave the voice channel.");
      return;
    }
    const handoff = this.buildMoveHandoff(active, action.origin);
    await this.leave(`2B moved to voice channel ${action.channelId}.`, { awaitMaintenance: false });
    try {
      await this.join(action.channelId, handoff);
    } catch (error) {
      this.fail(error);
    }
  }

  private buildMoveHandoff(
    active: ActiveSession,
    origin: VoicePresenceActionOrigin,
  ): VoiceMoveHandoff {
    const session = this.deps.repository.getSession(active.id);
    const recentLines = this.deps.repository.listHistory(active.id, 80)
      .filter((entry) => entry.kind !== "presence")
      .slice(-12)
      .map((entry) => entry.kind === "transcript"
        ? `[@${entry.transcript.username}]: ${entry.transcript.normalizedText}`
        : `[@2B${entry.output.cutoff ? " (interrupted)" : ""}]: ${entry.output.audibleText}`
      );
    const recent = recentLines.join("\n");
    const recentExchange = recent.length <= 2_400
      ? recent
      : `…${recent.slice(-(2_400 - 1))}`;
    return {
      sourceSessionId: active.id,
      sourceGuildId: active.channel.guild.id,
      sourceGuildName: active.channel.guild.name,
      sourceChannelId: active.channel.id,
      sourceChannelName: active.channel.name,
      requestedByUserId: origin.requesterId,
      requestedByUsername: origin.requesterUsername,
      reason: origin.sourceMessageText.slice(0, 2_000),
      priorSummary: session?.rollingSummary ?? "",
      recentExchange,
      movedAt: Date.now(),
    };
  }
}
