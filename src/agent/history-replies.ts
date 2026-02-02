import type { HistoryMessage } from "./history-types.ts";
import type { ReplyContext } from "./history-formatting.ts";

export interface ResolveRepliesInput {
  older: HistoryMessage[];
  newer: HistoryMessage[];
  /** The latest user message (already detached from slices), or null. */
  latestUserMessage: HistoryMessage | null;
  replyQuoteChars: number;
  captioningEnabled: boolean;
  /**
   * Optional map of message ID → normalized-but-untrimmed content.
   * When provided, quotes are derived from this map instead of message.content.
   * Per spec: "Reply quotes MUST be derived from the normalized original content
   * before messageCharLimit trimming is applied."
   */
  normalizedContentMap?: Map<string, string>;
}

export interface ResolveRepliesResult {
  /** ReplyContext keyed by message ID for older slice messages. */
  older: Map<string, ReplyContext>;
  /** ReplyContext keyed by message ID for newer slice messages. */
  newer: Map<string, ReplyContext>;
  /** ReplyContext for the latest user message, or null if no reply. */
  latestUser: ReplyContext | null;
}

/**
 * Normalize whitespace for quote extraction (same as trimming module).
 */
function normalizeForQuote(content: string): string {
  return content.replace(/[\t\n\r]+/g, " ");
}

/**
 * Truncate a quote to the char limit, appending "…" if truncated.
 */
function truncateQuote(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "…";
}

/**
 * Build a lookup map of message ID → HistoryMessage from all available messages.
 */
function buildLookup(
  older: HistoryMessage[],
  newer: HistoryMessage[],
  latestUserMessage: HistoryMessage | null,
): Map<string, HistoryMessage> {
  const map = new Map<string, HistoryMessage>();
  for (const m of older) map.set(m.id, m);
  for (const m of newer) map.set(m.id, m);
  if (latestUserMessage !== null) map.set(latestUserMessage.id, latestUserMessage);
  return map;
}

/**
 * Build a ReplyContext for a message, given its slice context.
 *
 * @param isOlderSlice - true if the message is in the older slice (no quotes).
 * @param immediatelyPreviousId - ID of the message immediately before this one in the newer slice (or null).
 */
function buildReplyContext(
  message: HistoryMessage,
  lookup: Map<string, HistoryMessage>,
  isOlderSlice: boolean,
  immediatelyPreviousId: string | null,
  replyQuoteChars: number,
  captioningEnabled: boolean,
  normalizedContentMap: Map<string, string> | undefined,
): ReplyContext | null {
  if (message.replyToId === null) return null;

  const target = lookup.get(message.replyToId);

  if (target === undefined) {
    return {
      targetAuthor: "unknown",
      quote: null,
      replyMsgId: message.replyToId,
      missingTarget: true,
      replyImageIds: [],
      replyCaptions: [],
    };
  }

  // Determine if quote should be included
  let quote: string | null = null;

  if (!isOlderSlice) {
    const isImmediatePrevious = immediatelyPreviousId === message.replyToId;
    if (!isImmediatePrevious) {
      const raw = normalizedContentMap?.get(target.id) ?? target.content;
      const normalized = normalizeForQuote(raw);
      quote = truncateQuote(normalized, replyQuoteChars);
    }
  }

  return {
    targetAuthor: target.author,
    quote,
    replyMsgId: message.replyToId,
    missingTarget: false,
    replyImageIds: target.imageIds,
    replyCaptions: captioningEnabled ? target.captions : [],
  };
}

/**
 * Resolve reply contexts for all messages in older/newer slices and the latest user message.
 *
 * Rules per spec:
 * - Older slice: no quote, include target author + ID.
 * - Newer slice: no quote if reply target is immediately previous message; otherwise include quote.
 * - Latest user message: treated like newer slice, with the last newer message as "immediately previous".
 * - Missing targets: flagged with missingTarget=true, author="unknown".
 * - Quotes: derived from normalized content, truncated to replyQuoteChars.
 */
export function resolveReplies(input: ResolveRepliesInput): ResolveRepliesResult {
  const { older, newer, latestUserMessage, replyQuoteChars, captioningEnabled, normalizedContentMap } = input;
  const lookup = buildLookup(older, newer, latestUserMessage);

  const olderMap = new Map<string, ReplyContext>();
  for (const m of older) {
    const ctx = buildReplyContext(m, lookup, true, null, replyQuoteChars, captioningEnabled, normalizedContentMap);
    if (ctx !== null) olderMap.set(m.id, ctx);
  }

  const newerMap = new Map<string, ReplyContext>();
  for (let i = 0; i < newer.length; i++) {
    const m = newer[i];
    if (m === undefined) continue;
    const prev = i > 0 ? newer[i - 1] : undefined;
    const prevId = prev !== undefined ? prev.id : null;
    const ctx = buildReplyContext(m, lookup, false, prevId, replyQuoteChars, captioningEnabled, normalizedContentMap);
    if (ctx !== null) newerMap.set(m.id, ctx);
  }

  let latestUser: ReplyContext | null = null;
  if (latestUserMessage !== null && latestUserMessage.replyToId !== null) {
    const lastNewer = newer.length > 0 ? newer[newer.length - 1] : undefined;
    const prevId = lastNewer !== undefined ? lastNewer.id : null;
    latestUser = buildReplyContext(
      latestUserMessage,
      lookup,
      false,
      prevId,
      replyQuoteChars,
      captioningEnabled,
      normalizedContentMap,
    );
  }

  return { older: olderMap, newer: newerMap, latestUser };
}
