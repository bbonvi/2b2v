import { expect, test } from "bun:test";
import {
  renderVoiceHistory,
  renderVoiceMoveHandoff,
  sortVoiceHistoryNewestFirst,
} from "./history.ts";
import type { VoiceHistoryRecord } from "./repository.ts";

test("renders user ASR and only the audible portion of 2B's reply", () => {
  const history: VoiceHistoryRecord[] = [
    {
      kind: "transcript",
      startedAt: 1_000,
      transcript: {
        id: 1,
        sessionId: "session",
        userId: "user",
        username: "alice",
        startedAt: 1_000,
        endedAt: 1_500,
        rawText: "Привет",
        normalizedText: "Привет",
        language: "ru",
        sttModel: "base",
        source: "stt",
        synthetic: false,
      },
    },
    {
      kind: "output",
      startedAt: 2_000,
      output: {
        id: "output",
        sessionId: "session",
        plannedText: "Привет. Я тебя слышу.",
        audibleText: "Привет.",
        startedAt: 2_000,
        endedAt: 2_500,
        interruptedAt: 2_400,
        interruptedByUserId: "user",
        cutoff: true,
      },
    },
  ];

  expect(renderVoiceHistory(history, "UTC")).toBe([
    "[1970-01-01 00:00:01] [@alice]: Привет",
    "[1970-01-01 00:00:02] [@2B (interrupted)]: Привет.",
  ].join("\n"));
  expect(renderVoiceHistory(history, "UTC")).not.toContain("(user)");
  expect(renderVoiceHistory(history, "UTC")).not.toContain("T00:00");
});

test("timestamps every voice event even when speech is only seconds apart", () => {
  const history: VoiceHistoryRecord[] = [
    {
      kind: "transcript",
      startedAt: Date.UTC(2026, 6, 17, 12, 30, 4),
      transcript: {
        id: 1,
        sessionId: "session",
        userId: "alice",
        username: "alice",
        startedAt: Date.UTC(2026, 6, 17, 12, 30, 4),
        endedAt: Date.UTC(2026, 6, 17, 12, 30, 5),
        rawText: "One",
        normalizedText: "One",
        language: "en",
        sttModel: "small",
        source: "stt",
        synthetic: false,
      },
    },
    {
      kind: "transcript",
      startedAt: Date.UTC(2026, 6, 17, 12, 30, 7),
      transcript: {
        id: 2,
        sessionId: "session",
        userId: "bob",
        username: "bob",
        startedAt: Date.UTC(2026, 6, 17, 12, 30, 7),
        endedAt: Date.UTC(2026, 6, 17, 12, 30, 8),
        rawText: "Two",
        normalizedText: "Two",
        language: "en",
        sttModel: "small",
        source: "stt",
        synthetic: false,
      },
    },
  ];

  expect(renderVoiceHistory(history, "UTC").split("\n")).toEqual([
    "[2026-07-17 12:30:04] [@alice]: One",
    "[2026-07-17 12:30:07] [@bob]: Two",
  ]);
});

test("renders session and participant boundaries inline", () => {
  const history: VoiceHistoryRecord[] = [
    {
      kind: "presence",
      startedAt: 1_000,
      presence: { sessionId: "old", actor: "2b", action: "left" },
    },
    {
      kind: "presence",
      startedAt: 2_000,
      presence: { sessionId: "new", actor: "2b", action: "joined" },
    },
    {
      kind: "presence",
      startedAt: 2_000,
      presence: {
        sessionId: "new",
        actor: "user",
        action: "present",
        userId: "user",
        username: "alice",
      },
    },
    {
      kind: "presence",
      startedAt: 3_000,
      presence: {
        sessionId: "new",
        actor: "user",
        action: "left",
        userId: "user",
        username: "alice",
      },
    },
  ];

  expect(renderVoiceHistory(history, "UTC")).toContain("[room] 2B left the voice channel");
  expect(renderVoiceHistory(history, "UTC")).toContain("[room] 2B joined the voice channel");
  expect(renderVoiceHistory(history, "UTC")).toContain("@alice was already present when 2B joined");
  expect(renderVoiceHistory(history, "UTC")).toContain("@alice left the voice channel");
});

test("marks recovered unclean session endings honestly", () => {
  expect(renderVoiceHistory([{
    kind: "presence",
    startedAt: 1_000,
    presence: { sessionId: "old", actor: "2b", action: "disconnected" },
  }], "UTC")).toContain("2B was no longer connected after an unclean shutdown");
});

test("renders a moved session with scoped source-room continuity", () => {
  const rendered = renderVoiceMoveHandoff({
    sourceSessionId: "source-session",
    sourceGuildId: "guild-1",
    sourceGuildName: "Guild One",
    sourceChannelId: "voice-1",
    sourceChannelName: "Old Room",
    requestedByUserId: "user-1",
    requestedByUsername: "alice",
    reason: "Come to the other room.",
    priorSummary: "They were discussing a game.",
    recentExchange: "[@alice]: Come over.",
    movedAt: Date.UTC(2026, 6, 17, 12, 30),
  }, "UTC");

  expect(rendered).toContain("[2026-07-17 12:30]");
  expect(rendered).toContain("Old Room (voice-1)");
  expect(rendered).toContain("@alice asked: Come to the other room.");
  expect(rendered).toContain("Source-room summary:");
  expect(rendered).toContain("Recent source-room exchange:");
});

test("sorts every history row strictly newest-first", () => {
  const history: VoiceHistoryRecord[] = [
    {
      kind: "transcript",
      startedAt: 1_000,
      transcript: {
        id: 1,
        sessionId: "session",
        userId: "user",
        username: "alice",
        startedAt: 1_000,
        endedAt: 1_100,
        rawText: "first",
        normalizedText: "first",
        language: "ru",
        sttModel: "small",
        source: "stt",
        synthetic: false,
      },
    },
    {
      kind: "output",
      startedAt: 2_000,
      output: {
        id: "first-output",
        sessionId: "session",
        triggerSegmentId: 1,
        plannedText: "first reply",
        audibleText: "first reply",
        startedAt: 2_000,
        cutoff: false,
      },
    },
    {
      kind: "transcript",
      startedAt: 3_000,
      transcript: {
        id: 2,
        sessionId: "session",
        userId: "user",
        username: "alice",
        startedAt: 3_000,
        endedAt: 3_100,
        rawText: "second",
        normalizedText: "second",
        language: "ru",
        sttModel: "small",
        source: "stt",
        synthetic: false,
      },
    },
    {
      kind: "output",
      startedAt: 4_000,
      output: {
        id: "second-output",
        sessionId: "session",
        triggerSegmentId: 2,
        plannedText: "second reply",
        audibleText: "second reply",
        startedAt: 4_000,
        cutoff: false,
      },
    },
  ];

  expect(sortVoiceHistoryNewestFirst(history).map((entry) => entry.startedAt))
    .toEqual([4_000, 3_000, 2_000, 1_000]);
});
