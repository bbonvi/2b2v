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
 * - N <= trimTarget → newer = min(windowSize, N), older = N - newer
 * - trimTarget < N < trimTrigger → older = olderCount (stable), newer = N - olderCount (grows)
 * - N >= trimTrigger → drop oldest (N - trimTarget), then older = olderCount, newer = windowSize
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

  if (N <= trimTarget) {
    const newerCount = Math.min(windowSize, N);
    const olderSize = N - newerCount;
    return {
      older: sorted.slice(0, olderSize),
      newer: sorted.slice(olderSize),
    };
  }

  if (N < trimTrigger) {
    // older stays stable at olderCount; newer grows
    return {
      older: sorted.slice(0, olderCount),
      newer: sorted.slice(olderCount),
    };
  }

  // N >= trimTrigger: drop oldest, then split
  const dropCount = N - trimTarget;
  const trimmed = sorted.slice(dropCount);
  return {
    older: trimmed.slice(0, olderCount),
    newer: trimmed.slice(olderCount),
  };
}
