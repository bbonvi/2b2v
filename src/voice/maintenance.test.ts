import { expect, test } from "bun:test";
import { compactVoiceMaintenance } from "./maintenance.ts";
import type { VoiceHistoryRecord, VoiceTranscriptRecord } from "./repository.ts";

function transcript(
  id: number,
  userId: string,
  username: string,
  text: string,
): VoiceHistoryRecord {
  const record: VoiceTranscriptRecord = {
    id,
    sessionId: "session",
    userId,
    username,
    startedAt: id * 1_000,
    endedAt: id * 1_000 + 500,
    rawText: text,
    normalizedText: text,
    language: "ru",
    sttModel: "test",
    source: "stt",
    synthetic: false,
  };
  return { kind: "transcript", startedAt: record.startedAt, transcript: record };
}

test("compacts voice maintenance into merged timestamp-free speaker runs", () => {
  const history: VoiceHistoryRecord[] = [
    transcript(8, "u1", "alice", "old context"),
    transcript(9, "u1", "alice", "still old"),
    transcript(10, "u1", "alice", "туби слышишь"),
    {
      kind: "output",
      startedAt: 10_500,
      output: {
        id: "out",
        sessionId: "session",
        triggerSegmentId: 10,
        plannedText: "Слышу.",
        audibleText: "Слышу.",
        startedAt: 10_500,
        endedAt: 11_000,
        cutoff: false,
      },
    },
    transcript(11, "u1", "alice", "отлично"),
    transcript(12, "u1", "alice", "тогда продолжим"),
    transcript(13, "u2", "bob", "ambient"),
  ];

  const compact = compactVoiceMaintenance(history, 9, 8, 2_000);

  expect(compact.text).toBe([
    "@alice: old context still old туби слышишь",
    "@2B: Слышу.",
    "@alice: отлично тогда продолжим",
    "@bob: ambient",
  ].join("\n"));
  expect(compact.text).not.toContain("1970");
  expect(compact.text).not.toContain("[@");
  expect(compact.userIds).toEqual(["u1", "u2"]);
  expect(compact.latestSegmentId).toBe(13);
  expect(compact.newSegmentCount).toBe(4);
  expect(compact.hasNewOutput).toBe(true);
});

test("prefers exchanges with 2B and the newest ambient turns within a hard cap", () => {
  const history: VoiceHistoryRecord[] = [
    transcript(1, "old", "old", "drop me"),
    transcript(2, "alice", "alice", "question"),
    {
      kind: "output",
      startedAt: 2_500,
      output: {
        id: "out",
        sessionId: "session",
        triggerSegmentId: 2,
        plannedText: "answer",
        audibleText: "answer",
        startedAt: 2_500,
        cutoff: false,
      },
    },
    transcript(3, "alice", "alice", "followup"),
    transcript(4, "bob", "bob", "newest ambient"),
  ];

  const compact = compactVoiceMaintenance(history, 0, 4, 80);

  expect(compact.text).toContain("@alice: question");
  expect(compact.text).toContain("@2B: answer");
  expect(compact.text).toContain("@alice: followup");
  expect(compact.text.length).toBeLessThanOrEqual(80);
  expect(compact.text).not.toContain("@old:");
});
