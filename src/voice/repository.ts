import type { Database } from "../db/database.ts";

const UNCLEAN_VOICE_SESSION_ERROR = "Recovered after an unclean bot shutdown.";

export interface VoiceMoveHandoff {
  sourceSessionId: string;
  sourceGuildId: string;
  sourceGuildName: string;
  sourceChannelId: string;
  sourceChannelName: string;
  requestedByUserId: string;
  requestedByUsername: string;
  reason: string;
  priorSummary: string;
  recentExchange: string;
  movedAt: number;
}

export type VoiceInstructionStatus =
  | "queued"
  | "active"
  | "waiting"
  | "resolved"
  | "ignored"
  | "interrupted"
  | "failed";

export interface VoiceSessionRecord {
  id: string;
  guildId: string;
  channelId: string;
  state: "connecting" | "active" | "ended" | "failed";
  startedAt: number;
  endedAt?: number;
  rollingSummary: string;
  summaryThroughSegmentId?: number;
  finalSummary: string;
  handoff?: VoiceMoveHandoff;
  error?: string;
}

export interface VoiceTranscriptRecord {
  id: number;
  sessionId: string;
  instructionId?: string;
  userId: string;
  username: string;
  startedAt: number;
  endedAt: number;
  rawText: string;
  normalizedText: string;
  language: string;
  confidence?: number;
  sttModel: string;
  source: "stt" | "test_injection";
  synthetic: boolean;
}

export interface VoiceOutputTurnRecord {
  id: string;
  sessionId: string;
  instructionId?: string;
  triggerSegmentId?: number;
  plannedText: string;
  audibleText: string;
  startedAt: number;
  endedAt?: number;
  interruptedAt?: number;
  interruptedByUserId?: string;
  cutoff: boolean;
}

export interface VoiceParticipantRecord {
  sessionId: string;
  userId: string;
  username: string;
  joinedAt: number;
  leftAt?: number;
  presentAtStart: boolean;
}

export interface VoicePresenceRecord {
  sessionId: string;
  actor: "2b" | "user";
  action: "joined" | "left" | "present" | "disconnected";
  userId?: string;
  username?: string;
}

export type VoiceHistoryRecord =
  | { kind: "transcript"; startedAt: number; transcript: VoiceTranscriptRecord }
  | { kind: "output"; startedAt: number; output: VoiceOutputTurnRecord }
  | { kind: "presence"; startedAt: number; presence: VoicePresenceRecord };

export interface VoiceInstructionRecord {
  id: string;
  status: VoiceInstructionStatus;
  instruction: string;
  sourceGuildId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  sourceMessageText: string;
  requesterId: string;
  requesterUsername: string;
  targetSessionId: string;
  createdAt: number;
  activatedAt?: number;
  lastProgressAt?: number;
  resolvedAt?: number;
  resultSummary?: string;
  reportMessageId?: string;
}

interface SessionRow {
  id: string;
  guild_id: string;
  channel_id: string;
  state: VoiceSessionRecord["state"];
  started_at: number;
  ended_at: number | null;
  rolling_summary: string;
  summary_through_segment_id: number | null;
  final_summary: string;
  handoff_json: string | null;
  error: string | null;
}

interface SegmentRow {
  id: number;
  session_id: string;
  instruction_id: string | null;
  user_id: string;
  username: string;
  started_at: number;
  ended_at: number;
  raw_text: string;
  normalized_text: string;
  language: string;
  confidence: number | null;
  stt_model: string;
  source: VoiceTranscriptRecord["source"];
  synthetic: number;
}

interface OutputTurnRow {
  id: string;
  session_id: string;
  instruction_id: string | null;
  trigger_segment_id: number | null;
  planned_text: string;
  audible_text: string;
  started_at: number;
  ended_at: number | null;
  interrupted_at: number | null;
  interrupted_by_user_id: string | null;
  cutoff: number;
}

interface ParticipantRow {
  session_id: string;
  user_id: string;
  username: string;
  joined_at: number;
  left_at: number | null;
  present_at_start: number;
}

interface InstructionRow {
  id: string;
  status: VoiceInstructionStatus;
  instruction: string;
  source_guild_id: string;
  source_channel_id: string;
  source_message_id: string;
  source_message_text: string;
  requester_id: string;
  requester_username: string;
  target_session_id: string;
  created_at: number;
  activated_at: number | null;
  last_progress_at: number | null;
  resolved_at: number | null;
  result_summary: string | null;
  report_message_id: string | null;
}

function optional<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

function mapSession(row: SessionRow): VoiceSessionRecord {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    state: row.state,
    startedAt: row.started_at,
    endedAt: optional(row.ended_at),
    rollingSummary: row.rolling_summary,
    summaryThroughSegmentId: optional(row.summary_through_segment_id),
    finalSummary: row.final_summary,
    handoff: row.handoff_json === null
      ? undefined
      : JSON.parse(row.handoff_json) as VoiceMoveHandoff,
    error: optional(row.error),
  };
}

function mapSegment(row: SegmentRow): VoiceTranscriptRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    instructionId: optional(row.instruction_id),
    userId: row.user_id,
    username: row.username,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    rawText: row.raw_text,
    normalizedText: row.normalized_text,
    language: row.language,
    confidence: optional(row.confidence),
    sttModel: row.stt_model,
    source: row.source,
    synthetic: row.synthetic === 1,
  };
}

function mapOutputTurn(row: OutputTurnRow): VoiceOutputTurnRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    instructionId: optional(row.instruction_id),
    triggerSegmentId: optional(row.trigger_segment_id),
    plannedText: row.planned_text,
    audibleText: row.audible_text,
    startedAt: row.started_at,
    endedAt: optional(row.ended_at),
    interruptedAt: optional(row.interrupted_at),
    interruptedByUserId: optional(row.interrupted_by_user_id),
    cutoff: row.cutoff === 1,
  };
}

function mapParticipant(row: ParticipantRow): VoiceParticipantRecord {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    username: row.username,
    joinedAt: row.joined_at,
    leftAt: optional(row.left_at),
    presentAtStart: row.present_at_start === 1,
  };
}

function boundedHistory(history: VoiceHistoryRecord[], limit: number): VoiceHistoryRecord[] {
  const presence = history.filter((entry) => entry.kind === "presence");
  const conversation = history.filter((entry) => entry.kind !== "presence");
  const kept = [...presence, ...conversation.slice(-Math.max(0, limit - presence.length))];
  kept.sort((left, right) => left.startedAt - right.startedAt);
  return kept;
}

function mapInstruction(row: InstructionRow): VoiceInstructionRecord {
  return {
    id: row.id,
    status: row.status,
    instruction: row.instruction,
    sourceGuildId: row.source_guild_id,
    sourceChannelId: row.source_channel_id,
    sourceMessageId: row.source_message_id,
    sourceMessageText: row.source_message_text,
    requesterId: row.requester_id,
    requesterUsername: row.requester_username,
    targetSessionId: row.target_session_id,
    createdAt: row.created_at,
    activatedAt: optional(row.activated_at),
    lastProgressAt: optional(row.last_progress_at),
    resolvedAt: optional(row.resolved_at),
    resultSummary: optional(row.result_summary),
    reportMessageId: optional(row.report_message_id),
  };
}

/** SQLite persistence for durable live-voice sessions, transcripts, output, and instructions. */
export class VoiceRepository {
  constructor(private readonly db: Database) {}

  createSession(
    guildId: string,
    channelId: string,
    handoff?: VoiceMoveHandoff,
  ): VoiceSessionRecord {
    const record: VoiceSessionRecord = {
      id: crypto.randomUUID(),
      guildId,
      channelId,
      state: "connecting",
      startedAt: Date.now(),
      rollingSummary: "",
      finalSummary: "",
      ...(handoff !== undefined ? { handoff } : {}),
    };
    this.db.raw.prepare(`INSERT INTO voice_sessions
      (id, guild_id, channel_id, state, started_at, rolling_summary, final_summary, handoff_json)
      VALUES (?, ?, ?, ?, ?, '', '', ?)`)
      .run(
        record.id,
        guildId,
        channelId,
        record.state,
        record.startedAt,
        handoff === undefined ? null : JSON.stringify(handoff),
      );
    return record;
  }

  updateSession(id: string, input: Partial<Pick<VoiceSessionRecord, "state" | "rollingSummary" | "summaryThroughSegmentId" | "finalSummary" | "endedAt" | "error">>): void {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    const add = (column: string, value: string | number | null): void => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };
    if (input.state !== undefined) add("state", input.state);
    if (input.rollingSummary !== undefined) add("rolling_summary", input.rollingSummary);
    if (input.summaryThroughSegmentId !== undefined) add("summary_through_segment_id", input.summaryThroughSegmentId);
    if (input.finalSummary !== undefined) add("final_summary", input.finalSummary);
    if (input.endedAt !== undefined) add("ended_at", input.endedAt);
    if (input.error !== undefined) add("error", input.error);
    if (assignments.length === 0) return;
    this.db.raw.prepare(`UPDATE voice_sessions SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
  }

  getSession(id: string): VoiceSessionRecord | undefined {
    const row = this.db.raw.prepare("SELECT * FROM voice_sessions WHERE id = ?").get(id) as SessionRow | null;
    return row === null ? undefined : mapSession(row);
  }

  latestSessions(limit = 20): VoiceSessionRecord[] {
    return (this.db.raw.prepare("SELECT * FROM voice_sessions ORDER BY started_at DESC LIMIT ?").all(limit) as SessionRow[]).map(mapSession);
  }

  /** Close sessions left open by a killed process, using the next join as the best known upper bound. */
  recoverDanglingSessions(recoveredAt = Date.now()): number {
    const dangling = this.db.raw.prepare(`SELECT * FROM voice_sessions
      WHERE state IN ('connecting', 'active') AND ended_at IS NULL
      ORDER BY started_at ASC`).all() as SessionRow[];
    const update = this.db.raw.prepare(`UPDATE voice_sessions
      SET state = 'ended', ended_at = ?, error = ?
      WHERE id = ? AND ended_at IS NULL`);
    for (const session of dangling) {
      const next = this.db.raw.prepare(`SELECT started_at FROM voice_sessions
        WHERE guild_id = ? AND channel_id = ? AND started_at > ?
        ORDER BY started_at ASC LIMIT 1`).get(
        session.guild_id,
        session.channel_id,
        session.started_at,
      ) as { started_at: number } | null;
      update.run(next?.started_at ?? recoveredAt, UNCLEAN_VOICE_SESSION_ERROR, session.id);
    }
    return dangling.length;
  }

  listRoomSessionsSince(guildId: string, channelId: string, since: number, limit = 10): VoiceSessionRecord[] {
    const rows = this.db.raw.prepare(`SELECT * FROM (
      SELECT * FROM voice_sessions
      WHERE guild_id = ? AND channel_id = ? AND (ended_at IS NULL OR ended_at >= ?)
      ORDER BY started_at DESC LIMIT ?
    ) ORDER BY started_at ASC`).all(guildId, channelId, since, limit) as SessionRow[];
    return rows.map(mapSession);
  }

  addParticipant(
    sessionId: string,
    userId: string,
    username: string,
    joinedAt = Date.now(),
    presentAtStart = false,
  ): void {
    this.db.raw.prepare(`INSERT INTO voice_participants
      (session_id, user_id, username, joined_at, present_at_start) VALUES (?, ?, ?, ?, ?)`)
      .run(sessionId, userId, username, joinedAt, presentAtStart ? 1 : 0);
  }

  leaveParticipant(sessionId: string, userId: string, leftAt = Date.now()): void {
    this.db.raw.prepare(`UPDATE voice_participants SET left_at = ?
      WHERE session_id = ? AND user_id = ? AND left_at IS NULL`).run(leftAt, sessionId, userId);
  }

  listParticipants(sessionId: string): VoiceParticipantRecord[] {
    const rows = this.db.raw.prepare(`SELECT * FROM voice_participants
      WHERE session_id = ? ORDER BY joined_at ASC`).all(sessionId) as ParticipantRow[];
    return rows.map(mapParticipant);
  }

  addTranscript(input: Omit<VoiceTranscriptRecord, "id">): VoiceTranscriptRecord {
    const result = this.db.raw.prepare(`INSERT INTO voice_transcript_segments
      (session_id, instruction_id, user_id, username, started_at, ended_at, raw_text,
       normalized_text, language, confidence, stt_model, source, synthetic)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.sessionId,
        input.instructionId ?? null,
        input.userId,
        input.username,
        input.startedAt,
        input.endedAt,
        input.rawText,
        input.normalizedText,
        input.language,
        input.confidence ?? null,
        input.sttModel,
        input.source,
        input.synthetic ? 1 : 0,
      );
    return { ...input, id: Number(result.lastInsertRowid) };
  }

  listTranscript(sessionId: string, limit = 300): VoiceTranscriptRecord[] {
    const rows = this.db.raw.prepare(`SELECT * FROM (
      SELECT * FROM voice_transcript_segments WHERE session_id = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC`).all(sessionId, limit) as SegmentRow[];
    return rows.map(mapSegment);
  }

  listOutputTurns(sessionId: string, limit = 300): VoiceOutputTurnRecord[] {
    const rows = this.db.raw.prepare(`SELECT * FROM (
      SELECT * FROM voice_output_turns
      WHERE session_id = ? AND audible_text <> ''
      ORDER BY started_at DESC LIMIT ?
    ) ORDER BY started_at ASC`).all(sessionId, limit) as OutputTurnRow[];
    return rows.map(mapOutputTurn);
  }

  /** Returns one session's audible conversation with explicit room-presence boundaries. */
  listHistory(sessionId: string, limit = 300): VoiceHistoryRecord[] {
    const session = this.getSession(sessionId);
    if (session === undefined) return [];
    const history: VoiceHistoryRecord[] = [
      {
        kind: "presence",
        startedAt: session.startedAt,
        presence: { sessionId, actor: "2b", action: "joined" },
      },
      ...this.listTranscript(sessionId, limit).map((transcript) => ({
        kind: "transcript" as const,
        startedAt: transcript.startedAt,
        transcript,
      })),
      ...this.listOutputTurns(sessionId, limit).map((output) => ({
        kind: "output" as const,
        startedAt: output.startedAt,
        output,
      })),
    ];
    for (const participant of this.listParticipants(sessionId)) {
      history.push({
        kind: "presence",
        startedAt: participant.joinedAt,
        presence: {
          sessionId,
          actor: "user",
          action: participant.presentAtStart ? "present" : "joined",
          userId: participant.userId,
          username: participant.username,
        },
      });
      if (participant.leftAt !== undefined) {
        history.push({
          kind: "presence",
          startedAt: participant.leftAt,
          presence: {
            sessionId,
            actor: "user",
            action: "left",
            userId: participant.userId,
            username: participant.username,
          },
        });
      }
    }
    if (session.endedAt !== undefined) {
      history.push({
        kind: "presence",
        startedAt: session.endedAt,
        presence: {
          sessionId,
          actor: "2b",
          action: session.error === UNCLEAN_VOICE_SESSION_ERROR ? "disconnected" : "left",
        },
      });
    }
    return boundedHistory(history, limit);
  }

  /** Returns a bounded recent buffer across consecutive visits to the same voice channel. */
  listRoomHistory(
    guildId: string,
    channelId: string,
    since: number,
    limit = 160,
    currentSessionId?: string,
  ): VoiceHistoryRecord[] {
    const sessions = this.listRoomSessionsSince(guildId, channelId, since);
    if (currentSessionId !== undefined && !sessions.some((session) => session.id === currentSessionId)) {
      const current = this.getSession(currentSessionId);
      if (current !== undefined && current.guildId === guildId && current.channelId === channelId) sessions.push(current);
    }
    sessions.sort((left, right) => left.startedAt - right.startedAt);
    const history = sessions
      .flatMap((session) => this.listHistory(session.id, limit));
    return boundedHistory(history, limit);
  }

  createOutputTurn(sessionId: string, triggerSegmentId: number, instructionId?: string): string {
    const id = crypto.randomUUID();
    this.db.raw.prepare(`INSERT INTO voice_output_turns
      (id, session_id, instruction_id, trigger_segment_id, planned_text, audible_text, started_at)
      VALUES (?, ?, ?, ?, '', '', ?)`).run(
        id,
        sessionId,
        instructionId ?? null,
        triggerSegmentId,
        Date.now(),
      );
    return id;
  }

  /** Replaces generation-start time with the moment Discord begins audible playback. */
  markOutputPlaybackStarted(id: string, startedAt = Date.now()): void {
    this.db.raw.prepare("UPDATE voice_output_turns SET started_at = ? WHERE id = ?")
      .run(startedAt, id);
  }

  finishOutputTurn(id: string, plannedText: string, audibleText: string, interruptedByUserId?: string): void {
    const now = Date.now();
    this.db.raw.prepare(`UPDATE voice_output_turns
      SET planned_text = ?, audible_text = ?, ended_at = ?, interrupted_at = ?,
          interrupted_by_user_id = ?, cutoff = ?
      WHERE id = ?`).run(
        plannedText,
        audibleText,
        now,
        interruptedByUserId === undefined ? null : now,
        interruptedByUserId ?? null,
        interruptedByUserId === undefined ? 0 : 1,
        id,
      );
  }

  createInstruction(input: Omit<VoiceInstructionRecord, "id" | "status" | "createdAt">): VoiceInstructionRecord {
    const record: VoiceInstructionRecord = {
      ...input,
      id: crypto.randomUUID(),
      status: "queued",
      createdAt: Date.now(),
    };
    this.db.raw.prepare(`INSERT INTO voice_instructions
      (id, status, instruction, source_guild_id, source_channel_id, source_message_id,
       source_message_text, requester_id, requester_username, target_session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id,
      record.status,
      record.instruction,
      record.sourceGuildId,
      record.sourceChannelId,
      record.sourceMessageId,
      record.sourceMessageText,
      record.requesterId,
      record.requesterUsername,
      record.targetSessionId,
      record.createdAt,
    );
    return record;
  }

  updateInstruction(id: string, status: VoiceInstructionStatus, resultSummary?: string, reportMessageId?: string): void {
    const now = Date.now();
    this.db.raw.prepare(`UPDATE voice_instructions SET
      status = ?,
      activated_at = CASE WHEN ? = 'active' AND activated_at IS NULL THEN ? ELSE activated_at END,
      last_progress_at = ?,
      resolved_at = CASE WHEN ? IN ('resolved', 'ignored', 'interrupted', 'failed') THEN ? ELSE resolved_at END,
      result_summary = COALESCE(?, result_summary),
      report_message_id = COALESCE(?, report_message_id)
      WHERE id = ?`).run(status, status, now, now, status, now, resultSummary ?? null, reportMessageId ?? null, id);
  }

  listOpenInstructions(sessionId: string): VoiceInstructionRecord[] {
    const rows = this.db.raw.prepare(`SELECT * FROM voice_instructions
      WHERE target_session_id = ? AND status IN ('queued', 'active', 'waiting')
      ORDER BY created_at ASC`).all(sessionId) as InstructionRow[];
    return rows.map(mapInstruction);
  }

  getInstruction(id: string): VoiceInstructionRecord | undefined {
    const row = this.db.raw.prepare("SELECT * FROM voice_instructions WHERE id = ?").get(id) as InstructionRow | null;
    return row === null ? undefined : mapInstruction(row);
  }

  recentInstructions(limit = 30): VoiceInstructionRecord[] {
    return (this.db.raw.prepare("SELECT * FROM voice_instructions ORDER BY created_at DESC LIMIT ?").all(limit) as InstructionRow[])
      .map(mapInstruction);
  }

  setCheckpoint(sessionId: string, kind: "summary" | "memory" | "relationship", throughSegmentId: number): void {
    this.db.raw.prepare(`INSERT INTO voice_maintenance_checkpoints
      (session_id, kind, through_segment_id, last_run_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, kind) DO UPDATE SET
        through_segment_id = excluded.through_segment_id,
        last_run_at = excluded.last_run_at`)
      .run(sessionId, kind, throughSegmentId, Date.now());
  }
}
