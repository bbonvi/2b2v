import type { HistoryMessage } from "./history-types.ts";
import type { ReplyContext } from "./history-formatting.ts";

export interface ResolveRepliesInput {
  older: HistoryMessage[];
  newer: HistoryMessage[];
  /** The latest user message (already detached from slices), or null. */
  latestUserMessage: HistoryMessage | null;
  /**
   * Original Discord message ID → immediately previous Discord message ID.
   * Use this when formatted rows can represent more than one message or cross slices.
   */
  previousMessageIdByMessageId?: ReadonlyMap<string, string | null>;
  /** Additional messages for lookup only (e.g. fetched reply targets). Not iterated for output. */
  extraLookup?: HistoryMessage[];
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
 * Build a lookup map of message ID → HistoryMessage from all available messages.
 */
function buildLookup(
  older: HistoryMessage[],
  newer: HistoryMessage[],
  latestUserMessage: HistoryMessage | null,
  extra?: HistoryMessage[],
): Map<string, HistoryMessage> {
  const map = new Map<string, HistoryMessage>();
  const add = (message: HistoryMessage): void => {
    map.set(message.id, message);
    for (const id of message.mergedMessageIds ?? []) {
      map.set(id, message);
    }
  };
  if (extra !== undefined) {
    for (const m of extra) add(m);
  }
  for (const m of older) add(m);
  for (const m of newer) add(m);
  if (latestUserMessage !== null) add(latestUserMessage);
  return map;
}

/**
 * Build a ReplyContext for a message, given its slice context.
 *
 * @param immediatelyPrevious - message immediately before this one in visible history (or null).
 */
function buildReplyContext(
  message: HistoryMessage,
  lookup: Map<string, HistoryMessage>,
  immediatelyPrevious: HistoryMessage | null,
  previousMessageIdByMessageId: ReadonlyMap<string, string | null> | undefined,
  visibleMessageIds: ReadonlySet<string>,
): ReplyContext | null {
  if (message.replyToId === null) return null;

  const target = lookup.get(message.replyToId);

  if (target === undefined) {
    return {
      targetAuthor: "unknown",
      replyMsgId: message.replyToId,
      missingTarget: true,
    };
  }

  const originalPreviousId = previousMessageIdByMessageId?.get(message.id);
  const isImmediatePrevious = visibleMessageIds.has(message.replyToId) && (
    originalPreviousId !== undefined
      ? originalPreviousId === message.replyToId
      : immediatelyPrevious !== null
        && (immediatelyPrevious.mergedMessageIds?.at(-1) ?? immediatelyPrevious.id) === message.replyToId
  );

  return {
    targetAuthor: target.author,
    ...(target.authorDisplayName !== undefined ? { targetDisplayName: target.authorDisplayName } : {}),
    replyMsgId: isImmediatePrevious ? null : message.replyToId,
    missingTarget: false,
  };
}

/**
 * Resolve reply contexts for all messages in older/newer slices and the latest user message.
 *
 * Rules per spec:
 * - Immediate visible target: include the target author without a redundant ID.
 * - Other targets: include ReplyMsgID so the model can inspect the exact message on demand.
 * - Missing targets: flagged with missingTarget=true, author="unknown".
 */
export function resolveReplies(input: ResolveRepliesInput): ResolveRepliesResult {
  const {
    older,
    newer,
    latestUserMessage,
    previousMessageIdByMessageId,
    extraLookup,
  } = input;
  const lookup = buildLookup(older, newer, latestUserMessage, extraLookup);
  const visibleMessageIds = new Set(
    [...older, ...newer].flatMap((message) => [message.id, ...(message.mergedMessageIds ?? [])]),
  );

  const olderMap = new Map<string, ReplyContext>();
  for (let i = 0; i < older.length; i++) {
    const m = older[i];
    if (m === undefined) continue;
    const prev = i > 0 ? older[i - 1] ?? null : null;
    const ctx = buildReplyContext(
      m,
      lookup,
      prev,
      previousMessageIdByMessageId,
      visibleMessageIds,
    );
    if (ctx !== null) olderMap.set(m.id, ctx);
  }

  const newerMap = new Map<string, ReplyContext>();
  for (let i = 0; i < newer.length; i++) {
    const m = newer[i];
    if (m === undefined) continue;
    const prev = i > 0 ? newer[i - 1] ?? null : older.at(-1) ?? null;
    const ctx = buildReplyContext(
      m,
      lookup,
      prev,
      previousMessageIdByMessageId,
      visibleMessageIds,
    );
    if (ctx !== null) newerMap.set(m.id, ctx);
  }

  let latestUser: ReplyContext | null = null;
  if (latestUserMessage !== null && latestUserMessage.replyToId !== null) {
    const lastVisible = newer.at(-1) ?? older.at(-1) ?? null;
    latestUser = buildReplyContext(
      latestUserMessage,
      lookup,
      lastVisible,
      previousMessageIdByMessageId,
      visibleMessageIds,
    );
  }

  return { older: olderMap, newer: newerMap, latestUser };
}
