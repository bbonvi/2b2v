import type { HistoryMessage } from "./history-types.ts";

/** Reply context resolved for formatting. */
export interface ReplyContext {
  targetAuthor: string;
  /** Short quote (already truncated to replyQuoteChars), or null if not applicable. */
  quote: string | null;
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
}

/**
 * Format a single message line per the deterministic grammar:
 * `[@<author>{ to @<target>}{ (<meta>)}]: <content>`
 *
 * Meta keys in order: Quote, ReplyMsgID, MissingTarget, ReplyImageIDs, ReplyCaptions, ImageIDs, Captions
 */
export function formatMessageLine(input: FormatInput): string {
  const { message, reply, captioningEnabled } = input;

  const metaParts: string[] = [];

  if (reply !== null) {
    if (reply.quote !== null) {
      metaParts.push(`Quote: "${reply.quote}"`);
    }
    metaParts.push(`ReplyMsgID: ${reply.replyMsgId}`);
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

  const authorPart = `@${message.author}`;
  const targetPart = reply !== null ? ` to @${reply.targetAuthor}` : "";
  const metaPart = metaParts.length > 0 ? ` (${metaParts.join("; ")})` : "";

  return `[${authorPart}${targetPart}${metaPart}]: ${message.content}`;
}

/** The legend block prepended to the older slice. */
export const OLDER_LEGEND = [
  "Legend: [@author to @target (Quote/ReplyMsgID/ReplyImageIDs/ReplyCaptions/ImageIDs/Captions)]: content",
  "Legend: Dates use [DATE ...]. Merged messages use [msg-break]. Quotes are excerpts; use search_messages(id). Images use read_images([id]).",
].join("\n");
