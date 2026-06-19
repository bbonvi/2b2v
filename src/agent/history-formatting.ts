import type { HistoryMessage } from "./history-types.ts";

/** Reply context resolved for formatting. */
export interface ReplyContext {
  targetAuthor: string;
  /** Current Discord display name/nickname for the reply target, if available. */
  targetDisplayName?: string;
  /** Short quote (already truncated to replyQuoteChars), or null if not applicable. */
  quote: string | null;
  /**
   * Discord message ID of the reply target.
   *
   * Kept for future direct-reply support, but intentionally omitted from
   * prompt history while the model cannot target arbitrary message replies.
   */
  replyMsgId: string;
  /** Whether the reply target is missing from both slices. */
  missingTarget: boolean;
  /** Image IDs on the reply target. */
  replyImageIds: number[];
  /** Captions on the reply target. */
  replyCaptions: string[];
}

/** Input for formatting a single message line. */
export interface FormatInput {
  message: HistoryMessage;
  reply: ReplyContext | null;
  captioningEnabled: boolean;
  includeMessageIds?: boolean;
  includeDisplayNames?: boolean;
}

/**
 * Format a single message line per the deterministic grammar:
 * `[@<author>{ to @<target>}{ (<meta>)}]: <content>`
 *
 * Synthetic events (e.g., thread creation) are formatted as-is without author prefix.
 *
 * Meta keys in order: Quote, MissingTarget, ReplyImageIDs, ReplyCaptions, ImageIDs, Captions
 */
export function formatMessageLine(input: FormatInput): string {
  const { message, reply, captioningEnabled, includeMessageIds, includeDisplayNames } = input;

  // Synthetic events are pre-formatted, output content directly
  if (message.isSynthetic) {
    return message.content;
  }

  const metaParts: string[] = [];

  if (includeMessageIds === true) {
    const ids = message.mergedMessageIds ?? [message.id];
    if (ids.length > 1) {
      metaParts.push(`MsgIDs: [${ids.join(", ")}]`);
    } else {
      metaParts.push(`MsgID: ${ids[0] ?? message.id}`);
    }
  }

  if (reply !== null) {
    if (reply.quote !== null) {
      metaParts.push(`Quote: "${reply.quote}"`);
    }
    if (reply.missingTarget) {
      metaParts.push("MissingTarget: true");
    }
    if (reply.replyImageIds.length > 0) {
      metaParts.push(`ReplyImageIDs: [${reply.replyImageIds.join(", ")}]`);
    }
    if (captioningEnabled && reply.replyCaptions.length > 0) {
      metaParts.push(`ReplyCaptions: [${reply.replyCaptions.map((c) => `"${c}"`).join(", ")}]`);
    }
  }

  if (message.imageIds.length > 0) {
    metaParts.push(`ImageIDs: [${message.imageIds.join(", ")}]`);
  }
  if (captioningEnabled && message.captions.length > 0) {
    metaParts.push(`Captions: [${message.captions.map((c) => `"${c}"`).join(", ")}]`);
  }
  if (message.jobAnnotations !== undefined && message.jobAnnotations.length > 0) {
    metaParts.push(...message.jobAnnotations);
  }

  const authorPart = `@${message.author}${formatDisplayNameSuffix(message.author, message.authorDisplayName, includeDisplayNames)}`;
  const targetPart = reply !== null
    ? ` to @${reply.targetAuthor}${formatDisplayNameSuffix(reply.targetAuthor, reply.targetDisplayName, includeDisplayNames)}`
    : "";
  const metaPart = metaParts.length > 0 ? ` (${metaParts.join("; ")})` : "";

  return `[${authorPart}${targetPart}${metaPart}]: ${message.content}`;
}

function formatDisplayNameSuffix(
  username: string,
  displayName: string | undefined,
  includeDisplayNames: boolean | undefined,
): string {
  if (includeDisplayNames !== true || displayName === undefined) return "";
  const normalized = displayName.replace(/[\t\n\r]+/g, " ").trim();
  if (normalized === "" || normalized === username) return "";
  return ` (${normalized})`;
}

/** The legend block prepended to the newer slice. */
export const NEWER_LEGEND = [
  "Legend: [@author (display name) to @target (display name) (MsgID/MsgIDs/Quote/ReplyImageIDs/ReplyCaptions/ImageIDs/Captions/ImageJob)]: content",
  "Legend: Parenthesized names are current Discord display names, not stable identity. Users change them often and they may contain jokes, moods, or temporary labels; use @username for exact pings.",
].join("\n");

/** The legend block prepended to the older slice. */
export const OLDER_LEGEND = [
  "Legend: [@author to @target (MsgID/MsgIDs/Quote/ReplyImageIDs/ReplyCaptions/ImageIDs/Captions/ImageJob)]: content",
  "Legend: Newer history exposes MsgID for reply_to. Dates use [DATE ...]. Merged messages use history-only [msg-break]. Quotes are excerpts; use search_messages(id). Images use read_chat_images([id]).",
].join("\n");
