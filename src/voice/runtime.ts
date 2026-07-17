import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  generateDependencyReport,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  ChannelType,
  PermissionsBitField,
  type Client,
  type VoiceBasedChannel,
  type VoiceState,
} from "discord.js";
import prism from "prism-media";
import type { GuildConfig, VoiceConfig } from "../config/types.ts";
import type { Logger } from "../logger.ts";
import type { VoicePreset } from "../tts/types.ts";
import { ElevenLabsVoiceStream } from "./elevenlabs-stream.ts";
import type {
  VoiceHistoryRecord,
  VoiceInstructionRecord,
  VoiceMoveHandoff,
  VoiceRepository,
  VoiceTranscriptRecord,
} from "./repository.ts";
import { VoiceResponseParser, type VoiceMessageDirective } from "./response-parser.ts";
import { WhisperServerTranscriber } from "./stt.ts";
import { decideVoiceTrigger } from "./trigger.ts";
import {
  anchorUtteranceToWallClock,
  VoiceUtteranceSegmenter,
  type VoiceUtterance,
  type VoiceUtteranceWallClock,
} from "./utterance-segmenter.ts";

export interface VoiceTurnRequest {
  sessionId: string;
  guildId: string;
  channelId: string;
  trigger: VoiceTranscriptRecord;
  transcript: VoiceTranscriptRecord[];
  history: VoiceHistoryRecord[];
  handoff?: VoiceMoveHandoff;
  instruction?: VoiceInstructionRecord;
  abortSignal: AbortSignal;
}

export interface VoiceRuntimeDeps {
  client: Client;
  repository: VoiceRepository;
  getGuildConfig: (guildId: string) => GuildConfig;
  elevenLabsApiKey?: string;
  log: Logger;
  onTurn: (request: VoiceTurnRequest) => Promise<void>;
  sendMessage: (message: VoiceMessageDirective) => Promise<{ sentMessageId: string }>;
  onMaintenance: (sessionId: string, final: boolean) => Promise<void>;
}

export interface VoiceRuntimeSnapshot {
  enabled: boolean;
  state: "disconnected" | "connecting" | "active" | "leaving" | "failed";
  sessionId?: string;
  guildId?: string;
  guildName?: string;
  channelId?: string;
  channelName?: string;
  participants: Array<{ userId: string; username: string }>;
  speakingUserIds: string[];
  currentOutput?: { turnId: string; plannedText: string; audibleText: string; interrupted: boolean };
  lastError?: string;
  dependencyReport: string;
  transcript: VoiceTranscriptRecord[];
  history: VoiceHistoryRecord[];
  instructions: VoiceInstructionRecord[];
}

export interface VoiceResponseSink {
  startModelTurn(): void;
  push(delta: string): Promise<boolean>;
  finish(finalText: string): Promise<{ visible: boolean; memoryText: string; malformed: boolean }>;
  abort(userId?: string): void;
}

export interface VoicePresenceActionOrigin {
  requesterId: string;
  requesterUsername: string;
  sourceMessageText: string;
}

type PendingPresenceAction = {
  controller: AbortController;
  origin: VoicePresenceActionOrigin;
} & (
  | { kind: "leave" }
  | { kind: "move"; channelId: string }
);

interface ActiveSession {
  id: string;
  channel: VoiceBasedChannel;
  config: GuildConfig;
  voiceConfig: VoiceConfig;
  connection: VoiceConnection;
  player: AudioPlayer;
  transcriber: WhisperServerTranscriber;
  sttController: AbortController;
  transcriptionQueue: Promise<void>;
  attentionUntil: number;
  speaking: Set<string>;
  subscriptions: Set<string>;
  pendingTurn?: ReturnType<typeof setTimeout>;
  emptyTimer?: ReturnType<typeof setTimeout>;
  turnController?: AbortController;
  currentSink?: VoiceResponseSinkImpl;
  pendingPresenceAction?: PendingPresenceAction;
}

/** Global single-connection Discord voice coordinator. */
export class VoiceRuntime {
  private active: ActiveSession | undefined;
  private transcriber: WhisperServerTranscriber | undefined;
  private state: VoiceRuntimeSnapshot["state"] = "disconnected";
  private lastError: string | undefined;
  private readonly listeners = new Set<(snapshot: VoiceRuntimeSnapshot) => void>();

  constructor(private readonly deps: VoiceRuntimeDeps) {
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
    const participants = active === undefined
      ? []
      : [...active.channel.members.values()]
        .filter((member) => !member.user.bot)
        .map((member) => ({ userId: member.id, username: member.user.username }));
    const currentOutput = active?.currentSink?.snapshot();
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
    };
  }

  async join(
    channelId: string,
    handoff?: VoiceMoveHandoff,
  ): Promise<{ sessionId: string; channelId: string }> {
    if (this.active !== undefined) {
      throw new Error(`Already connected to voice channel ${this.active.channel.name} (${this.active.channel.id}). Leave it before joining another.`);
    }
    const { channel, config, voiceConfig } = await this.resolveJoinTarget(channelId);
    this.transcriber ??= new WhisperServerTranscriber(
      voiceConfig.stt,
      this.deps.log.child({ component: "voice-stt" }),
    );
    await this.transcriber.start();

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
        transcriber: this.transcriber,
        sttController: new AbortController(),
        transcriptionQueue: Promise.resolve(),
        attentionUntil: 0,
        speaking: new Set(),
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
      connection.receiver.speaking.on("start", (userId) => this.onSpeakingStart(userId));
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
    options: { awaitMaintenance?: boolean } = {},
  ): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    this.state = "leaving";
    this.emit();
    if (active.pendingTurn !== undefined) clearTimeout(active.pendingTurn);
    if (active.emptyTimer !== undefined) clearTimeout(active.emptyTimer);
    active.turnController?.abort(new Error(reason));
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
    void this.runInstruction(instruction);
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
      onInstructionResolved: (id, summary, messageId) => {
        this.deps.repository.updateInstruction(id, "resolved", summary, messageId);
      },
      onInstructionIgnored: (id) => this.deps.repository.updateInstruction(id, "ignored"),
      triggerSegmentId,
      instructionId,
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
    await this.leave("Bot shutdown");
    this.transcriber?.shutdown();
    this.transcriber = undefined;
  }

  private onSpeakingStart(userId: string): void {
    const active = this.active;
    if (active === undefined || active.subscriptions.has(userId)) return;
    const member = active.channel.members.get(userId);
    if (member?.user.bot !== false) return;
    active.subscriptions.add(userId);
    const segmenter = new VoiceUtteranceSegmenter(active.voiceConfig.stt);
    const opus = active.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterInactivity,
        duration: Math.max(5_000, active.voiceConfig.stt.speechPauseMs * 4),
      },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    let lastDecodedAt = Date.now();
    decoder.on("data", (chunk: Buffer | Uint8Array) => {
      lastDecodedAt = Date.now();
      const wasSpeaking = segmenter.isSpeaking;
      const result = segmenter.push(Buffer.from(chunk));
      if (result.speechStarted) {
        active.speaking.add(userId);
        if (active.player.state.status !== AudioPlayerStatus.Idle) {
          active.currentSink?.abort(userId);
          active.player.stop(true);
        }
      }
      if (!segmenter.isSpeaking) active.speaking.delete(userId);
      if (wasSpeaking !== segmenter.isSpeaking || result.speechStarted) this.emit();
      for (const utterance of result.utterances) {
        this.enqueueTranscription(
          active,
          member.user.username,
          userId,
          anchorUtteranceToWallClock(utterance, lastDecodedAt),
          utterance,
        );
      }
    });
    opus.pipe(decoder);
    decoder.once("end", () => {
      active.subscriptions.delete(userId);
      active.speaking.delete(userId);
      this.emit();
      for (const utterance of segmenter.flush()) {
        this.enqueueTranscription(
          active,
          member.user.username,
          userId,
          anchorUtteranceToWallClock(utterance, lastDecodedAt),
          utterance,
        );
      }
    });
  }

  private enqueueTranscription(
    active: ActiveSession,
    username: string,
    userId: string,
    timing: VoiceUtteranceWallClock,
    utterance: VoiceUtterance,
  ): void {
    this.deps.log.debug("voice utterance finalized", {
      userId,
      audioMs: utterance.endedOffsetMs - utterance.startedOffsetMs,
      speechMs: utterance.speechMs,
    });
    active.transcriptionQueue = active.transcriptionQueue
      .then(async () => {
        if (active.sttController.signal.aborted) return;
        const result = await active.transcriber.transcribe(utterance.pcm, active.sttController.signal);
        if (result.text === "" || this.active !== active) return;
        await this.finalizeTranscript({
          userId,
          username,
          text: result.text,
          startedAt: timing.startedAt,
          endedAt: timing.endedAt,
          language: result.language,
          model: result.model,
          synthetic: false,
        });
      })
      .catch((error: unknown) => {
        if (!active.sttController.signal.aborted) this.fail(error);
      });
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
  }): Promise<VoiceTranscriptRecord> {
    const active = this.active;
    if (active === undefined) throw new Error("Voice session ended before transcript finalization.");
    const instruction = this.deps.repository.listOpenInstructions(active.id)
      .find((candidate) => candidate.status === "active" || candidate.status === "waiting");
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
    const humans = [...active.channel.members.values()].filter((member) => !member.user.bot).length;
    const decision = decideVoiceTrigger({
      text: record.normalizedText,
      humanCount: humans,
      wakeWords: active.voiceConfig.wakeWords,
      now: Date.now(),
      lingeringAttentionMs: active.voiceConfig.lingeringAttentionMs,
      state: { attentionUntil: active.attentionUntil },
    });
    active.attentionUntil = decision.attentionUntil;
    if (decision.shouldConsider) this.scheduleTurn(record);
    this.maybeRunMaintenance(record.id);
    this.emit();
    return Promise.resolve(record);
  }

  private scheduleTurn(trigger: VoiceTranscriptRecord): void {
    const active = this.active;
    if (active === undefined) return;
    if (active.pendingTurn !== undefined) clearTimeout(active.pendingTurn);
    active.pendingTurn = setTimeout(() => {
      active.pendingTurn = undefined;
      if (active.speaking.size > 0) {
        this.scheduleTurn(trigger);
        return;
      }
      void this.runTurn(trigger);
    }, active.voiceConfig.roomQuietMs);
  }

  private async runTurn(trigger: VoiceTranscriptRecord, instruction?: VoiceInstructionRecord): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    active.turnController?.abort(new Error("Superseded by a newer voice turn"));
    const controller = new AbortController();
    active.turnController = controller;
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
      if (ownsTurn) active.turnController = undefined;
      const pending = active.pendingPresenceAction?.controller === controller
        ? active.pendingPresenceAction
        : undefined;
      if (pending !== undefined) active.pendingPresenceAction = undefined;
      this.emit();
      if (
        ownsTurn
        && pending !== undefined
        && !controller.signal.aborted
        && this.active === active
      ) {
        await this.applyPresenceAction(active, pending);
      }
    }
  }

  private async runInstruction(instruction: VoiceInstructionRecord): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
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
    await this.runTurn(synthetic, instruction);
  }

  private maybeRunMaintenance(latestSegmentId: number): void {
    const active = this.active;
    if (active === undefined) return;
    if (latestSegmentId % active.voiceConfig.summaryEverySegments !== 0) return;
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

class VoiceResponseSinkImpl implements VoiceResponseSink {
  private readonly turnId: string;
  private parser: VoiceResponseParser;
  private tts: ElevenLabsVoiceStream | undefined;
  private rawText = "";
  private plannedText = "";
  private audibleText = "";
  private interruptedByUserId: string | undefined;
  private visible = false;

  constructor(private readonly deps: {
    active: ActiveSession;
    preset?: VoicePreset;
    apiKey?: string;
    log: Logger;
    repository: VoiceRepository;
    sendMessage: VoiceRuntimeDeps["sendMessage"];
    emit: () => void;
    onInstructionResolved: (id: string, summary: string, messageId: string) => void;
    onInstructionIgnored: (id: string) => void;
    triggerSegmentId: number;
    instructionId?: string;
  }) {
    this.turnId = deps.repository.createOutputTurn(
      deps.active.id,
      deps.triggerSegmentId,
      deps.instructionId,
    );
    this.parser = this.createParser();
  }

  startModelTurn(): void {
    if (this.rawText === "") return;
    this.rawText = "";
    this.parser = this.createParser();
  }

  async push(delta: string): Promise<boolean> {
    if (this.interruptedByUserId !== undefined) return false;
    this.rawText += delta;
    const before = this.visible;
    await this.parser.push(delta);
    return this.visible && !before;
  }

  async finish(finalText: string): Promise<{ visible: boolean; memoryText: string; malformed: boolean }> {
    if (this.interruptedByUserId === undefined && finalText !== this.rawText) {
      const hadStreamedText = this.rawText !== "";
      this.rawText = finalText;
      if (!hadStreamedText) {
        this.parser = this.createParser();
        await this.parser.push(finalText);
      }
    }
    const result = await this.parser.finish();
    this.plannedText = result.plannedSpeech;
    if (this.tts !== undefined) {
      await this.tts.finish();
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
    }
    this.refreshAudibleText();
    this.deps.repository.finishOutputTurn(
      this.turnId,
      this.plannedText,
      this.audibleText,
      this.interruptedByUserId,
    );
    this.deps.emit();
    return {
      visible: this.visible,
      memoryText: this.audibleText,
      malformed: result.malformed,
    };
  }

  abort(userId?: string): void {
    if (this.interruptedByUserId !== undefined) return;
    this.interruptedByUserId = userId ?? "unknown";
    this.refreshAudibleText();
    this.tts?.abort();
    this.deps.repository.finishOutputTurn(this.turnId, this.plannedText, this.audibleText, this.interruptedByUserId);
    this.deps.emit();
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
        if (this.interruptedByUserId !== undefined) return;
        const preset = this.deps.preset;
        const apiKey = this.deps.apiKey;
        if (preset === undefined || apiKey === undefined || apiKey === "") {
          throw new Error("Live voice TTS is unavailable.");
        }
        if (this.tts === undefined) {
          this.tts = new ElevenLabsVoiceStream(apiKey, preset, () => {
            this.refreshAudibleText();
            this.deps.emit();
          });
          const inputType = preset.outputFormat?.startsWith("opus_") === true
            ? StreamType.OggOpus
            : StreamType.Arbitrary;
          const resource = createAudioResource(this.tts.audio, { inputType });
          this.deps.active.player.play(resource);
          this.deps.active.player.once(AudioPlayerStatus.Playing, () => {
            this.deps.repository.markOutputPlaybackStarted(this.turnId);
            this.visible = true;
            this.deps.emit();
          });
        }
        this.plannedText = `${this.plannedText} ${text}`.trim();
        await this.tts.push(text, /[.!?…]$/.test(text));
      },
      onMessage: async (message) => {
        const result = await this.deps.sendMessage(message);
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
    this.audibleText = this.tts?.audibleTextAt(resource?.playbackDuration ?? 0) ?? this.audibleText;
  }
}
