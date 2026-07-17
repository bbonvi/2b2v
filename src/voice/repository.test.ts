import { describe, expect, test } from "bun:test";
import { createDatabase } from "../db/database.ts";
import { VoiceRepository } from "./repository.ts";

describe("VoiceRepository", () => {
  test("persists sessions, transcript, output and durable instructions", () => {
    const db = createDatabase(":memory:");
    const repository = new VoiceRepository(db);
    const session = repository.createSession("g1", "v1");
    repository.updateSession(session.id, { state: "active" });
    repository.addParticipant(session.id, "u1", "alice", session.startedAt, true);
    const segment = repository.addTranscript({
      sessionId: session.id,
      userId: "u1",
      username: "alice",
      startedAt: 1,
      endedAt: 2,
      rawText: "привет",
      normalizedText: "привет",
      language: "ru",
      sttModel: "small",
      source: "stt",
      synthetic: false,
    });
    const instruction = repository.createInstruction({
      instruction: "Ask Alice if she is ready.",
      sourceGuildId: "g2",
      sourceChannelId: "c2",
      sourceMessageId: "m2",
      sourceMessageText: "Can you ask Alice?",
      requesterId: "u2",
      requesterUsername: "bob",
      targetSessionId: session.id,
    });
    repository.updateInstruction(instruction.id, "waiting");
    const outputId = repository.createOutputTurn(session.id, segment.id, instruction.id);
    repository.markOutputPlaybackStarted(outputId, 3);
    repository.finishOutputTurn(outputId, "Are you ready?", "Are you", "u1");

    expect(repository.listTranscript(session.id)).toEqual([segment]);
    const history = repository.listHistory(session.id);
    expect(history[0]).toEqual({ kind: "transcript", startedAt: 1, transcript: segment });
    expect(history.some((entry) =>
      entry.kind === "presence"
      && entry.presence.actor === "2b"
      && entry.presence.action === "joined"
    )).toBe(true);
    expect(history.some((entry) =>
      entry.kind === "presence"
      && entry.presence.actor === "user"
      && entry.presence.action === "present"
    )).toBe(true);
    const output = history.find((entry) => entry.kind === "output");
    expect(output?.kind).toBe("output");
    if (output?.kind !== "output") throw new Error("Expected persisted output history");
    expect(output.output.id).toBe(outputId);
    expect(output.output.plannedText).toBe("Are you ready?");
    expect(output.output.audibleText).toBe("Are you");
    expect(output.output.startedAt).toBe(3);
    expect(output.output.cutoff).toBe(true);
    expect(repository.listOpenInstructions(session.id)[0]?.status).toBe("waiting");
    expect(repository.getInstruction(instruction.id)?.sourceMessageId).toBe("m2");
    expect(repository.latestSessions(1)[0]?.state).toBe("active");
    db.close();
  });

  test("carries bounded same-channel history across voice sessions", () => {
    const db = createDatabase(":memory:");
    const repository = new VoiceRepository(db);
    const prior = repository.createSession("g1", "v1");
    repository.addParticipant(prior.id, "u1", "alice", prior.startedAt, true);
    repository.addTranscript({
      sessionId: prior.id,
      userId: "u1",
      username: "alice",
      startedAt: prior.startedAt + 1,
      endedAt: prior.startedAt + 2,
      rawText: "помни это",
      normalizedText: "помни это",
      language: "ru",
      sttModel: "base",
      source: "stt",
      synthetic: false,
    });
    const priorSegment = repository.listTranscript(prior.id)[0];
    if (priorSegment === undefined) throw new Error("Expected prior transcript");
    const priorOutput = repository.createOutputTurn(prior.id, priorSegment.id);
    repository.finishOutputTurn(priorOutput, "Помню.", "Помню.");
    repository.updateSession(prior.id, { state: "ended", endedAt: prior.startedAt + 3 });

    const current = repository.createSession("g1", "v1");
    repository.addParticipant(current.id, "u1", "alice", current.startedAt, true);
    repository.createSession("g1", "different-channel");

    const history = repository.listRoomHistory("g1", "v1", 0, 160, current.id);
    expect(history.some((entry) =>
      entry.kind === "transcript" && entry.transcript.normalizedText === "помни это"
    )).toBe(true);
    expect(history.some((entry) =>
      entry.kind === "output" && entry.output.audibleText === "Помню."
    )).toBe(true);
    expect(history.filter((entry) =>
      entry.kind === "presence" && entry.presence.actor === "2b" && entry.presence.action === "joined"
    )).toHaveLength(2);
    expect(history.some((entry) =>
      entry.kind === "presence" && entry.presence.actor === "2b" && entry.presence.action === "left"
    )).toBe(true);
    db.close();
  });

  test("persists scoped context when voice presence moves between channels", () => {
    const db = createDatabase(":memory:");
    const repository = new VoiceRepository(db);
    const handoff = {
      sourceSessionId: "source-session",
      sourceGuildId: "g1",
      sourceGuildName: "Guild One",
      sourceChannelId: "v1",
      sourceChannelName: "Old Room",
      requestedByUserId: "u1",
      requestedByUsername: "alice",
      reason: "Join us in the other room.",
      priorSummary: "They were discussing a game.",
      recentExchange: "[@alice]: Come over.\\n[@2B]: One moment.",
      movedAt: 10,
    };

    const session = repository.createSession("g2", "v2", handoff);

    expect(repository.getSession(session.id)?.handoff).toEqual(handoff);
    db.close();
  });

  test("recovers dangling sessions at the next known join boundary", () => {
    const db = createDatabase(":memory:");
    const repository = new VoiceRepository(db);
    const dangling = repository.createSession("g1", "v1");
    const next = repository.createSession("g1", "v1");
    const nextStartedAt = dangling.startedAt + 100;
    db.raw.prepare("UPDATE voice_sessions SET started_at = ? WHERE id = ?").run(nextStartedAt, next.id);

    expect(repository.recoverDanglingSessions(nextStartedAt + 1_000)).toBe(2);
    expect(repository.getSession(dangling.id)?.endedAt).toBe(nextStartedAt);
    expect(repository.getSession(next.id)?.endedAt).toBe(nextStartedAt + 1_000);
    expect(repository.listHistory(dangling.id).some((entry) =>
      entry.kind === "presence"
      && entry.presence.actor === "2b"
      && entry.presence.action === "disconnected"
    )).toBe(true);
    db.close();
  });
});
