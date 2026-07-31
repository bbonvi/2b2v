import type { AudioPlayer, VoiceConnection } from "@discordjs/voice";
import type { Client, VoiceBasedChannel } from "discord.js";
import type { GuildConfig, VoiceConfig } from "../config/types.ts";
import type { Logger } from "../logger.ts";
import type {
  VoiceHistoryRecord,
  VoiceInstructionRecord,
  VoiceMoveHandoff,
  VoiceRepository,
  VoiceRuntimeEventRecord,
  VoiceRuntimePhase,
  VoiceSttUsageRecord,
  VoiceTranscriptRecord,
} from "./repository.ts";
import type { VoiceMessageDirective } from "./response-parser.ts";
import type { SileroVadClient } from "./silero-vad.ts";

export interface VoiceTurnRequest {
  sessionId: string;
  guildId: string;
  channelId: string;
  trigger: VoiceTranscriptRecord;
  transcript: VoiceTranscriptRecord[];
  history: VoiceHistoryRecord[];
  handoff?: VoiceMoveHandoff;
  instruction?: VoiceInstructionRecord;
  opportunity: VoiceTurnOpportunityContext;
  abortSignal: AbortSignal;
}

/** Volatile social state explaining why and amid whom a voice turn may run. */
export interface VoiceTurnOpportunityContext {
  source: "single_human" | "wake_word" | "lingering" | "instruction";
  openedAt: number;
  owner?: { userId: string; username: string };
  currentSpeakers: Array<{ userId: string; username: string; speakingForMs: number }>;
  recentInterrupters: Array<{ userId: string; username: string; at: number }>;
}

export interface VoiceRuntimeDeps {
  client: Client;
  repository: VoiceRepository;
  getGuildConfig: (guildId: string) => GuildConfig;
  elevenLabsApiKey?: string;
  log: Logger;
  onTurn: (request: VoiceTurnRequest) => Promise<void>;
  sendMessage: (
    message: VoiceMessageDirective,
    source: { sourceGuildId: string; sourceChannelId: string; sourceMessageId: string },
  ) => Promise<{ sentMessageId: string }>;
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
  attention: {
    humanCount: number;
    active: boolean;
    until: number;
    remainingMs: number;
    lastTriggerReason: "single_human" | "wake_word" | "lingering" | "none";
    lastWakeWord?: string;
    lastTriggerSegmentId?: number;
    pendingSegmentId?: number;
    ownerUserId?: string;
    ownerUsername?: string;
  };
  currentOutput?: { turnId: string; plannedText: string; audibleText: string; interrupted: boolean };
  lastError?: string;
  dependencyReport: string;
  transcript: VoiceTranscriptRecord[];
  history: VoiceHistoryRecord[];
  instructions: VoiceInstructionRecord[];
  runtimeEvents: VoiceRuntimeEventRecord[];
  stt: {
    provider: "elevenlabs";
    model: string;
    partials: Array<{ userId: string; username: string; text: string; vadProbability?: number }>;
    sessionAudioMs: number;
    monthlyAudioMs: number;
    monthlyAudioLimitMs: number;
    monthlyAttempts: number;
    monthlyFailures: number;
    estimatedMonthlyCostUsd: number;
    recentAttempts: VoiceSttUsageRecord[];
  };
}

export interface VoiceResponseSink {
  startModelTurn(): void;
  push(delta: string): Promise<boolean>;
  finish(finalText: string): Promise<{ visible: boolean; memoryText: string; malformed: boolean }>;
  isAudible(): boolean;
  requestInterruption(userId: string, username: string): void;
  abort(userId?: string, username?: string): void;
}

export interface VoiceResponseSinkInternal extends VoiceResponseSink {
  snapshot(): { turnId: string; plannedText: string; audibleText: string; interrupted: boolean };
}

export interface VoicePresenceActionOrigin {
  requesterId: string;
  requesterUsername: string;
  sourceMessageText: string;
}

export type PendingPresenceAction = {
  controller: AbortController;
  origin: VoicePresenceActionOrigin;
} & (
  | { kind: "leave" }
  | { kind: "move"; channelId: string }
);

export interface VoiceOpportunity {
  trigger: VoiceTranscriptRecord;
  source: VoiceTurnOpportunityContext["source"];
  openedAt: number;
  owner?: { userId: string; username: string };
  instruction?: VoiceInstructionRecord;
  recentInterrupters: Array<{ userId: string; username: string; at: number }>;
}

export interface ActiveSession {
  id: string;
  channel: VoiceBasedChannel;
  config: GuildConfig;
  voiceConfig: VoiceConfig;
  connection: VoiceConnection;
  player: AudioPlayer;
  vad: SileroVadClient;
  sttController: AbortController;
  pendingTranscriptions: number;
  elevenLabsAudioMs: number;
  sessionElevenLabsAudioMs: number;
  scribePartials: Map<string, { username: string; text: string; vadProbability?: number }>;
  attentionUntil: number;
  attentionOwner?: { userId: string; username: string };
  lastTriggerReason: VoiceRuntimeSnapshot["attention"]["lastTriggerReason"];
  lastWakeWord?: string;
  lastTriggerSegmentId?: number;
  pendingTurnSegmentId?: number;
  currentTurnSegmentId?: number;
  speaking: Set<string>;
  speakingSince: Map<string, number>;
  subscriptions: Set<string>;
  opportunity?: VoiceOpportunity;
  pendingTurn?: ReturnType<typeof setTimeout>;
  emptyTimer?: ReturnType<typeof setTimeout>;
  turnController?: AbortController;
  deferredTurnController?: AbortController;
  currentSink?: VoiceResponseSinkInternal;
  pendingPresenceAction?: PendingPresenceAction;
}

export interface VoiceTranscriptTiming {
  speechStartedAt: number;
  speechEndedAt: number;
  vadFinalizedAt: number;
  sttQueuedAt: number;
  sttStartedAt: number;
  sttCompletedAt: number;
}

export type AddVoiceRuntimeEvent = (
  phase: VoiceRuntimePhase,
  occurredAt: number,
  durationMs?: number,
  detail?: Record<string, string | number | boolean | null>,
) => void;
