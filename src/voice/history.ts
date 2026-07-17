import { formatMessageLine } from "../agent/history-formatting.ts";
import { formatDateStamp } from "../agent/history-dates.ts";
import type { HistoryMessage } from "../agent/history-types.ts";
import type { VoiceHistoryRecord, VoiceMoveHandoff } from "./repository.ts";

/** Renders the private, scoped continuity carried into a moved voice session. */
export function renderVoiceMoveHandoff(
  handoff: VoiceMoveHandoff,
  timezone: string,
): string {
  return [
    "## Voice Move Handoff",
    `${formatDateStamp(handoff.movedAt, timezone)} You moved here from voice channel ${handoff.sourceChannelName} (${handoff.sourceChannelId}) in guild ${handoff.sourceGuildName} (${handoff.sourceGuildId}).`,
    `@${handoff.requestedByUsername} asked: ${handoff.reason}`,
    "This is private continuity from the source room. People in the current room did not hear it; use it to understand why you moved, but do not expose sensitive source-room details.",
    handoff.priorSummary === "" ? "" : `Source-room summary: ${handoff.priorSummary}`,
    handoff.recentExchange === "" ? "" : `Recent source-room exchange:\n${handoff.recentExchange}`,
  ].filter((line) => line !== "").join("\n");
}

/** Renders chronological voice events with per-event local timestamps precise to seconds. */
export function renderVoiceHistory(
  history: readonly VoiceHistoryRecord[],
  timezone: string,
): string {
  const messages: HistoryMessage[] = history.map((entry) => {
    if (entry.kind === "presence") {
      let content: string;
      if (entry.presence.actor === "2b") {
        const action = entry.presence.action === "joined"
          ? "joined the voice channel"
          : entry.presence.action === "disconnected"
            ? "was no longer connected after an unclean shutdown"
            : "left the voice channel";
        content = `[room] 2B ${action}`;
      } else {
        const user = `@${entry.presence.username ?? "unknown"}`;
        const action = entry.presence.action === "present"
          ? "was already present when 2B joined"
          : `${entry.presence.action} the voice channel`;
        content = `[room] ${user} ${action}`;
      }
      return {
        id: `voice-presence:${entry.presence.sessionId}:${entry.startedAt}`,
        author: "room",
        authorId: "voice-room",
        content,
        isBot: true,
        timestamp: entry.startedAt,
        replyToId: null,
        hasEmbeds: false,
        isSynthetic: true,
        relatedThreadId: null,
      };
    }
    if (entry.kind === "transcript") {
      const segment = entry.transcript;
      return {
        id: `voice-transcript:${segment.id}`,
        author: segment.username,
        authorId: segment.userId,
        content: segment.normalizedText,
        isBot: false,
        timestamp: segment.startedAt,
        replyToId: null,
        hasEmbeds: false,
        isSynthetic: false,
        relatedThreadId: null,
        ...(segment.synthetic ? { historyAnnotations: ["synthetic/instruction"] } : {}),
      };
    }
    return {
      id: `voice-output:${entry.output.id}`,
      author: "2B",
      authorId: "2b",
      content: entry.output.audibleText,
      isBot: true,
      timestamp: entry.output.startedAt,
      replyToId: null,
      hasEmbeds: false,
      isSynthetic: false,
      relatedThreadId: null,
      ...(entry.output.cutoff ? { historyAnnotations: ["interrupted"] } : {}),
    };
  });
  return messages.map((message) =>
    `${formatDateStamp(message.timestamp, timezone, { includeSeconds: true })} ${formatMessageLine({
      message,
      reply: null,
    })}`
  ).join("\n");
}

/** Sorts every room-history event newest-first without changing the source array. */
export function sortVoiceHistoryNewestFirst(
  history: readonly VoiceHistoryRecord[],
): VoiceHistoryRecord[] {
  return [...history].sort((left, right) => right.startedAt - left.startedAt);
}
