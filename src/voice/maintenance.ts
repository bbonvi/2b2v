import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { VoiceHistoryRecord } from "./repository.ts";

const VoiceSummarySchema = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2_000 }),
}, { additionalProperties: false });

interface MaintenanceTurn {
  speakerId: string;
  username: string;
  text: string;
  isBot: boolean;
  isNew: boolean;
}

export interface CompactVoiceMaintenance {
  text: string;
  userIds: string[];
  latestSegmentId: number;
  newSegmentCount: number;
  hasNewOutput: boolean;
}

/** Create the private tool that replaces one session's bounded rolling summary. */
export function createVoiceSummaryTool(
  onSummary: (summary: string) => void,
): AgentTool {
  return {
    name: "update_voice_summary",
    label: "update_voice_summary",
    description: "Replace the private rolling voice-room summary with 3-6 concise factual sentences.",
    parameters: VoiceSummarySchema,
    execute: (_toolCallId: string, params: unknown): Promise<AgentToolResult<{ updated: true } | { error: true }>> => {
      if (!Value.Check(VoiceSummarySchema, params)) {
        return Promise.resolve({
          content: [{ type: "text", text: "Voice summary update rejected: arguments did not match the schema." }],
          details: { error: true },
        });
      }
      const summary = (params as { summary: string }).summary.replace(/\s+/g, " ").trim();
      onSummary(summary);
      return Promise.resolve({
        content: [{ type: "text", text: "Voice summary updated." }],
        details: { updated: true },
      });
    },
  };
}

/**
 * Build a small exchange-biased maintenance view from chronological voice
 * history. Raw transcript retention remains the repository's responsibility.
 */
export function compactVoiceMaintenance(
  history: readonly VoiceHistoryRecord[],
  afterSegmentId: number,
  maxTurns: number,
  maxChars: number,
): CompactVoiceMaintenance {
  const turns: MaintenanceTurn[] = [];
  const userIds = new Set<string>();
  let latestSegmentId = afterSegmentId;
  let newSegmentCount = 0;
  let hasNewOutput = false;

  for (const entry of history) {
    if (entry.kind === "presence") continue;
    const isBot = entry.kind === "output";
    const speakerId = isBot ? "2b" : entry.transcript.userId;
    const username = isBot ? "2B" : entry.transcript.username;
    const segmentId = entry.kind === "transcript"
      ? entry.transcript.id
      : entry.output.triggerSegmentId ?? 0;
    const isNew = segmentId > afterSegmentId;
    const rawText = entry.kind === "transcript"
      ? entry.transcript.normalizedText
      : `${entry.output.audibleText}${entry.output.cutoff ? " [interrupted]" : ""}`;
    const text = rawText.replace(/\s+/g, " ").trim();
    if (text === "") continue;
    if (!isBot) {
      userIds.add(speakerId);
      latestSegmentId = Math.max(latestSegmentId, segmentId);
      if (isNew) newSegmentCount += 1;
    } else if (isNew) {
      hasNewOutput = true;
    }

    const previous = turns.at(-1);
    if (previous?.speakerId === speakerId) {
      previous.text = `${previous.text} ${text}`;
      previous.isNew ||= isNew;
    } else {
      turns.push({ speakerId, username, text, isBot, isNew });
    }
  }

  const mandatory = new Set<number>();
  for (const [index, turn] of turns.entries()) {
    if (!turn.isBot || !turn.isNew) continue;
    mandatory.add(index);
    if (index > 0) mandatory.add(index - 1);
    if (index + 1 < turns.length) mandatory.add(index + 1);
  }

  const perTurnLimit = Math.max(160, Math.min(1_200, maxChars));
  const lineAt = (index: number): string => {
    const turn = turns[index];
    if (turn === undefined) return "";
    const prefix = `@${turn.username}: `;
    const available = Math.max(1, perTurnLimit - prefix.length);
    const clipped = turn.text.length <= available
      ? turn.text
      : `${turn.text.slice(0, Math.max(1, available - 1)).trimEnd()}…`;
    return `${prefix}${clipped}`;
  };
  const priority = [
    ...[...mandatory].sort((left, right) => right - left),
    ...turns.map((_turn, index) => index).reverse(),
  ];
  const selected = new Set<number>();
  let usedChars = 0;
  for (const index of priority) {
    if (selected.has(index) || selected.size >= maxTurns) continue;
    const line = lineAt(index);
    const addedChars = line.length + (selected.size === 0 ? 0 : 1);
    if (usedChars + addedChars > maxChars) continue;
    selected.add(index);
    usedChars += addedChars;
  }
  const text = [...selected]
    .sort((left, right) => left - right)
    .map(lineAt)
    .join("\n");

  return {
    text,
    userIds: [...userIds],
    latestSegmentId,
    newSegmentCount,
    hasNewOutput,
  };
}
