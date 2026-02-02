import type { HistoryMessage } from "./history-types.ts";

/**
 * Check if a message is "plain" — no reply, no images, no embeds.
 */
function isPlain(m: HistoryMessage): boolean {
  return m.replyToId === null && m.imageIds.length === 0 && !m.hasEmbeds;
}

/**
 * Check if two consecutive messages can be merged.
 * Same author, both plain, gap <= mergeMessageGapSeconds.
 */
function canMerge(
  prev: HistoryMessage,
  curr: HistoryMessage,
  mergeMessageGapSeconds: number,
): boolean {
  if (prev.authorId !== curr.authorId) return false;
  if (!isPlain(prev) || !isPlain(curr)) return false;
  const gapMs = curr.timestamp - prev.timestamp;
  return gapMs <= mergeMessageGapSeconds * 1000;
}

/**
 * Normalize whitespace: collapse tabs and newlines to single spaces.
 */
function normalizeContent(content: string): string {
  return content.replace(/[\t\n\r]+/g, " ");
}

/**
 * Merge consecutive plain messages by the same author within the time threshold.
 * Content is joined with ` [msg-break] ` separator. Original newlines collapsed to spaces.
 * The merged message retains the first message's ID and timestamp.
 * Returns a new array; does not mutate input.
 */
export function mergeConsecutiveMessages(
  messages: HistoryMessage[],
  mergeMessageGapSeconds: number,
): HistoryMessage[] {
  if (messages.length === 0) return [];

  const result: HistoryMessage[] = [];
  const first = messages[0];
  if (first === undefined) return [];
  let current = { ...first, content: normalizeContent(first.content) };

  for (let i = 1; i < messages.length; i++) {
    const next = messages[i];
    if (next === undefined) continue;
    if (canMerge(current, next, mergeMessageGapSeconds)) {
      current = {
        ...current,
        content: `${current.content} [msg-break] ${normalizeContent(next.content)}`,
      };
    } else {
      result.push(current);
      current = { ...next, content: normalizeContent(next.content) };
    }
  }

  result.push(current);
  return result;
}
