import type { HistoryMessage, SliceResult } from "./history-types.ts";
import type { ContextHistoryConfig } from "../config/types.ts";
import { contextHistoryDropCount, contextHistoryOlderSize } from "../context-history.ts";

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
 * - N == 0 → both slices empty
 * - Recent history keeps at least recentMessages after enough history exists.
 * - Older history grows in recentMessages-sized cache batches, then caps.
 * - Each rollover drops one oldest batch and promotes one recent batch.
 */
export function sliceHistory(
  sorted: HistoryMessage[],
  config: ContextHistoryConfig,
): SliceResult {
  const N = sorted.length;

  if (N === 0) {
    return { older: [], newer: [] };
  }

  const dropCount = contextHistoryDropCount(N, config);
  const trimmed = sorted.slice(dropCount);
  const olderSize = contextHistoryOlderSize(trimmed.length, config);

  return {
    older: trimmed.slice(0, olderSize),
    newer: trimmed.slice(olderSize),
  };
}
