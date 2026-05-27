import type { HistoryMessage, HistoryProcessingConfig } from "./history-types.ts";
import type { ReplyFallbackDeps } from "./reply-target-fallback.ts";
import { sortMessages, sliceHistory } from "./history-slicing.ts";
import { mergeConsecutiveMessages } from "./history-merge.ts";
import { trimMessages } from "./history-trimming.ts";
import { insertDateStamps } from "./history-dates.ts";
import { formatMessageLine, OLDER_LEGEND } from "./history-formatting.ts";
import { resolveReplies } from "./history-replies.ts";
import { fetchMissingReplyTargets } from "./reply-target-fallback.ts";

/**
 * Run the full history processing pipeline:
 * sort → merge → slice → trim → fallback fetch → resolve replies → date stamps → format.
 *
 * Returns two formatted text blocks: olderText (cached) and newerText (uncached).
 * Empty string if a slice has no messages.
 */
export async function processHistory(
  messages: HistoryMessage[],
  latestUserMessage: HistoryMessage,
  config: HistoryProcessingConfig & { replyQuoteChars: number },
  replyFallbackDeps: ReplyFallbackDeps,
): Promise<{ olderText: string; newerText: string }> {
  // 1. Sort deterministically
  const sorted = sortMessages(messages);

  // 2. Merge consecutive plain messages by same author
  const merged = mergeConsecutiveMessages(sorted, config.mergeMessageGapSeconds);

  // 3. Build normalized content map (pre-trim content for quote extraction)
  const normalizedContentMap = new Map<string, string>();
  for (const m of merged) {
    normalizedContentMap.set(m.id, m.content);
    for (const id of m.mergedMessageIds ?? []) {
      normalizedContentMap.set(id, m.content);
    }
  }
  normalizedContentMap.set(latestUserMessage.id, latestUserMessage.content);

  // 4. Slice into older/newer
  const { older, newer } = sliceHistory(merged, config.trim);

  // 5. Trim older slice only (newer messages kept intact for recency)
  const olderTrimmed = trimMessages(older, config.trim.messageCharLimit);
  const newerTrimmed = newer;

  // 6. Fetch missing reply targets from Discord
  const allForFallback = [...olderTrimmed, ...newerTrimmed, latestUserMessage];
  const fetched = await fetchMissingReplyTargets(replyFallbackDeps, allForFallback);

  // 7. Add fetched messages to normalized content map
  for (const m of fetched) {
    normalizedContentMap.set(m.id, m.content);
  }

  // 8. Resolve reply contexts
  const replyResult = resolveReplies({
    older: olderTrimmed,
    newer: newerTrimmed,
    latestUserMessage,
    replyQuoteChars: config.replyQuoteChars,
    captioningEnabled: config.imageCaptioningEnabled,
    normalizedContentMap,
    extraLookup: fetched,
  });

  // 9. Format older slice with date stamps
  let olderText = "";
  if (olderTrimmed.length > 0) {
    const dateEntries = insertDateStamps(olderTrimmed, config.timezone);
    const lines: string[] = [OLDER_LEGEND];
    for (const entry of dateEntries) {
      if (entry.type === "date") {
        lines.push(entry.text);
      } else {
        const m = olderTrimmed[entry.index];
        if (m === undefined) continue;
        lines.push(formatMessageLine({
          message: m,
          reply: replyResult.older.get(m.id) ?? null,
          captioningEnabled: config.imageCaptioningEnabled,
        }));
      }
    }
    olderText = `## Chat History — Older\n${lines.join("\n")}`;
  }

  // 10. Format newer slice with date stamps
  let newerText = "";
  const newerMessages = [...newerTrimmed, latestUserMessage];
  if (newerMessages.length > 0) {
    const newerDateEntries = insertDateStamps(newerMessages, config.timezone);
    const lines: string[] = [];
    for (const entry of newerDateEntries) {
      if (entry.type === "date") {
        lines.push(entry.text);
      } else {
        const m = newerMessages[entry.index];
        if (m === undefined) continue;
        let reply = replyResult.newer.get(m.id) ?? null;
        if (m.id === latestUserMessage.id && reply === null) {
          reply = replyResult.latestUser;
        }
        lines.push(formatMessageLine({
          message: m,
          reply,
          captioningEnabled: config.imageCaptioningEnabled,
        }));
      }
    }
    newerText = `## Chat History\n${lines.join("\n")}`;
  }

  return { olderText, newerText };
}
