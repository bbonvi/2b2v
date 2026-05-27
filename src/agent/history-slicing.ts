import type { HistoryMessage, SliceResult } from "./history-types.ts";
import type { TrimConfig } from "../config/types.ts";

/**
 * Sort messages by timestamp ascending, breaking ties by message ID ascending.
 * Returns a new sorted array; does not mutate input.
 */
export function sortMessages(messages: HistoryMessage[]): HistoryMessage[] {
  return [...messages].sort((a, b) => {
    const timeDiff = a.timestamp - b.timestamp;
    if (timeDiff !== 0) return timeDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Deterministic slicing algorithm per spec.
 *
 * Given a chronological list of messages (already sorted, latest user message excluded):
 * - olderCount = trimTarget - windowSize
 * - N == 0 → both slices empty
 * - Older history grows only in window-sized chunks, then caps at olderCount.
 * - Recent history gets the in-progress chunk after the last complete cached chunk.
 * - N >= trimTrigger → drop old messages in window-sized chunks before splitting.
 */
export function sliceHistory(
  sorted: HistoryMessage[],
  trim: TrimConfig,
): SliceResult {
  const N = sorted.length;

  if (N === 0) {
    return { older: [], newer: [] };
  }

  const { trimTrigger, trimTarget, windowSize } = trim;
  const olderCount = trimTarget - windowSize;
  const maxChunkedOlderSize = Math.floor(olderCount / windowSize) * windowSize;
  const dropCount = (() => {
    if (N < trimTrigger) return 0;
    const overage = N - trimTarget;
    return Math.floor(overage / windowSize) * windowSize;
  })();

  const trimmed = sorted.slice(dropCount);
  const desiredOlderSize = Math.max(0, trimmed.length - 1);
  const olderSize = Math.min(
    maxChunkedOlderSize,
    Math.floor(desiredOlderSize / windowSize) * windowSize,
  );

  return {
    older: trimmed.slice(0, olderSize),
    newer: trimmed.slice(olderSize),
  };
}
