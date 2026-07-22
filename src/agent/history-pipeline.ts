import type { HistoryMessage, HistoryProcessingConfig } from "./history-types.ts";
import type { ReplyFallbackDeps } from "./reply-target-fallback.ts";
import { sortMessages, sliceHistory } from "./history-slicing.ts";
import { mergeConsecutiveMessages } from "./history-merge.ts";
import { trimMessages } from "./history-trimming.ts";
import { insertDateStamps, RECENT_HISTORY_DATE_STAMP_GAP_MS } from "./history-dates.ts";
import { formatMessageLine, NEWER_LEGEND, OLDER_LEGEND } from "./history-formatting.ts";
import { resolveReplies } from "./history-replies.ts";
import { fetchMissingReplyTargets } from "./reply-target-fallback.ts";

export interface ProcessedHistory {
  olderText: string;
  newerText: string;
  /** Human user IDs visible in the rendered chat history, newest visible activity first. */
  visibleUserIds: string[];
}

/**
 * Run the full history processing pipeline:
 * sort → merge → slice → trim → fallback fetch → resolve replies → date stamps → format.
 *
 * Returns two formatted text blocks: olderText (cached) and newerText (uncached).
 * Empty string if a slice has no messages.
 */
export async function processHistory(
  messages: HistoryMessage[],
  latestUserMessage: HistoryMessage | null,
  config: HistoryProcessingConfig & { replyQuoteChars: number },
  replyFallbackDeps: ReplyFallbackDeps,
  _nowMs = Date.now(),
): Promise<ProcessedHistory> {
  const triggerMessageIds = new Set(config.triggerMessageIds ?? []);

  // 1. Sort deterministically
  const sorted = sortMessages(applyDisplayNames(messages, config.displayNamesByUserId));
  const latestWithDisplayName = latestUserMessage !== null
    ? annotateTriggerMessage(applyDisplayName(latestUserMessage, config.displayNamesByUserId), triggerMessageIds)
    : null;

  // 2. Merge consecutive plain messages by same author
  const merged = annotateTriggerSpan(
    mergeConsecutiveMessages(sorted, config.mergeMessageGapSeconds, triggerMessageIds),
    triggerMessageIds,
  );

  // 3. Build normalized content map (pre-trim content for quote extraction)
  const normalizedContentMap = new Map<string, string>();
  for (const m of merged) {
    normalizedContentMap.set(m.id, m.content);
    for (const id of m.mergedMessageIds ?? []) {
      normalizedContentMap.set(id, m.content);
    }
  }
  if (latestWithDisplayName !== null) {
    normalizedContentMap.set(latestWithDisplayName.id, latestWithDisplayName.content);
  }

  // 4. Slice into older/newer
  const { older, newer } = sliceHistory(merged, config.trim);

  // 5. Trim older slice only (newer messages kept intact for recency)
  const olderTrimmed = trimMessages(older, config.trim.messageCharLimit);
  const newerTrimmed = newer;
  const newerMessages = latestWithDisplayName !== null
    ? [...newerTrimmed, latestWithDisplayName]
    : newerTrimmed;
  const oldestVisibleMessageId = [...olderTrimmed, ...newerTrimmed].find((m) => m.isPromptOnly !== true)?.id;

  // 6. Fetch missing reply targets from Discord
  const allForFallback = latestWithDisplayName !== null
    ? [...olderTrimmed, ...newerTrimmed, latestWithDisplayName]
    : [...olderTrimmed, ...newerTrimmed];
  const fetched = applyDisplayNames(await fetchMissingReplyTargets(replyFallbackDeps, allForFallback), config.displayNamesByUserId);

  // 7. Add fetched messages to normalized content map
  for (const m of fetched) {
    normalizedContentMap.set(m.id, m.content);
  }

  // 8. Resolve reply contexts
  const replyResult = resolveReplies({
    older: olderTrimmed,
    newer: newerTrimmed,
    latestUserMessage: latestWithDisplayName,
    replyQuoteChars: config.replyQuoteChars,
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
        }));
      }
    }
    olderText = `## Chat History — Older\n${lines.join("\n")}`;
  }

  // 10. Format newer slice with date stamps
  let newerText = "";
  if (newerMessages.length > 0) {
    const newerDateEntries = insertDateStamps(newerMessages, config.timezone, {
      minGapMs: RECENT_HISTORY_DATE_STAMP_GAP_MS,
    });
    const lines: string[] = [
      NEWER_LEGEND,
      ...(oldestVisibleMessageId !== undefined ? [`History cursor: oldest_visible_message_id=${oldestVisibleMessageId}`] : []),
    ];
    for (const entry of newerDateEntries) {
      if (entry.type === "date") {
        lines.push(entry.text);
      } else {
        const m = newerMessages[entry.index];
        if (m === undefined) continue;
        let reply = replyResult.newer.get(m.id) ?? null;
        if (latestUserMessage !== null && m.id === latestUserMessage.id && reply === null) {
          reply = replyResult.latestUser;
        }
        lines.push(formatMessageLine({
          message: m,
          reply,
          includeMessageIds: true,
          includeDisplayNames: true,
        }));
      }
    }
    newerText = `## Chat History\n${lines.join("\n")}`;
  }

  return {
    olderText,
    newerText,
    visibleUserIds: collectVisibleUserIds([...olderTrimmed, ...newerMessages]),
  };
}

function annotateTriggerSpan(
  messages: HistoryMessage[],
  triggerMessageIds: ReadonlySet<string>,
): HistoryMessage[] {
  if (triggerMessageIds.size === 0) return messages;
  return messages.map((message) => annotateTriggerMessage(message, triggerMessageIds));
}

function annotateTriggerMessage(
  message: HistoryMessage,
  triggerMessageIds: ReadonlySet<string>,
): HistoryMessage {
  const representedIds = message.mergedMessageIds ?? [message.id];
  if (!representedIds.some((id) => triggerMessageIds.has(id))) return message;
  const annotations = message.historyAnnotations ?? [];
  if (annotations.includes("<trigger>")) return message;
  return { ...message, historyAnnotations: [...annotations, "<trigger>"] };
}

function collectVisibleUserIds(messages: HistoryMessage[]): string[] {
  const recency = new Map<string, true>();
  for (const message of messages) {
    if (message.isBot) continue;
    recency.delete(message.authorId);
    recency.set(message.authorId, true);
  }
  return [...recency.keys()].reverse();
}

function applyDisplayNames(
  messages: HistoryMessage[],
  displayNamesByUserId: ReadonlyMap<string, string> | undefined,
): HistoryMessage[] {
  if (displayNamesByUserId === undefined) return messages;
  return messages.map((message) => applyDisplayName(message, displayNamesByUserId));
}

function applyDisplayName(
  message: HistoryMessage,
  displayNamesByUserId: ReadonlyMap<string, string> | undefined,
): HistoryMessage {
  if (displayNamesByUserId === undefined || message.authorDisplayName !== undefined) return message;
  const displayName = displayNamesByUserId.get(message.authorId);
  return displayName !== undefined ? { ...message, authorDisplayName: displayName } : message;
}
