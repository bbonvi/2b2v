import type { HistoryMessage } from "./history-types.ts";
import type { ImageSourceKind } from "../db/image-repository.ts";

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
  /** Source media kinds on the reply target, parallel to replyImageIds. */
  replyImageSourceKinds?: ImageSourceKind[];
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
 * Meta keys in order: Quote, MissingTarget, ReplyImageIDs, ReplyCaptions, ImageIDs, Captions, Reactions
 */
export function formatMessageLine(input: FormatInput): string {
  const { message, reply, captioningEnabled, includeMessageIds, includeDisplayNames } = input;

  // Synthetic events are pre-formatted, output content directly
  if (message.isSynthetic) {
    return message.content;
  }

  const metaParts: string[] = [];

  if (includeMessageIds === true && message.isPromptOnly !== true) {
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
      metaParts.push(...formatImageIdMeta("Reply", reply.replyImageIds, reply.replyImageSourceKinds));
    }
    if (captioningEnabled && reply.replyCaptions.length > 0) {
      metaParts.push(formatCaptionsMeta("Reply", reply.replyImageIds, reply.replyCaptions, reply.replyImageSourceKinds));
    }
  }

  if (message.imageIds.length > 0) {
    metaParts.push(...formatImageIdMeta("", message.imageIds, message.imageSourceKinds));
  }
  if (captioningEnabled && message.captions.length > 0) {
    metaParts.push(formatCaptionsMeta("", message.imageIds, message.captions, message.imageSourceKinds));
  }
  if (message.jobAnnotations !== undefined && message.jobAnnotations.length > 0) {
    metaParts.push(...message.jobAnnotations);
  }
  if (includeMessageIds === true && message.reactions !== undefined && message.reactions !== "") {
    metaParts.push(`Reactions: ${message.reactions}`);
  }

  const authorPart = `@${message.author}${formatDisplayNameSuffix(message.author, message.authorDisplayName, includeDisplayNames)}`;
  const targetPart = reply !== null
    ? ` to @${reply.targetAuthor}${formatDisplayNameSuffix(reply.targetAuthor, reply.targetDisplayName, includeDisplayNames)}`
    : "";
  const metaPart = metaParts.length > 0 ? ` (${metaParts.join("; ")})` : "";

  return `[${authorPart}${targetPart}${metaPart}]: ${message.content}`;
}

function formatImageIdMeta(prefix: "Reply" | "", imageIds: number[], sourceKinds: ImageSourceKind[] | undefined): string[] {
  const groups: Record<ImageSourceKind, number[]> = {
    image: [],
    gif: [],
    sticker: [],
  };
  for (let i = 0; i < imageIds.length; i++) {
    const id = imageIds[i];
    if (id === undefined) continue;
    const kind = sourceKinds?.[i];
    if (kind === "gif" || kind === "sticker") {
      groups[kind].push(id);
    } else {
      groups.image.push(id);
    }
  }

  const reply = prefix === "Reply" ? "Reply" : "";
  const parts: string[] = [];
  if (groups.image.length > 0) parts.push(`${reply}ImageIDs: [${groups.image.join(", ")}]`);
  if (groups.gif.length > 0) parts.push(`${reply}GIFImageIDs: [${groups.gif.join(", ")}]`);
  if (groups.sticker.length > 0) parts.push(`${reply}StickerImageIDs: [${groups.sticker.join(", ")}]`);
  return parts;
}

function formatCaptionsMeta(
  prefix: "Reply" | "",
  imageIds: number[],
  captions: string[],
  sourceKinds: ImageSourceKind[] | undefined,
): string {
  const key = prefix === "Reply" ? "ReplyCaptions" : "Captions";
  const hasTypedImages = sourceKinds?.some((kind) => kind === "gif" || kind === "sticker") === true;
  if (!hasTypedImages) return `${key}: [${captions.map((c) => `"${c}"`).join(", ")}]`;

  const typedKey = prefix === "Reply" ? "ReplyCaptionByImageID" : "CaptionByImageID";
  const entries = captions.map((caption, index) => {
    const id = imageIds[index];
    return id !== undefined ? `${id}: "${caption}"` : `"${caption}"`;
  });
  return `${typedKey}: [${entries.join(", ")}]`;
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
  "Legend: [@author (display name) to @target (display name) (MsgID/MsgIDs/Quote/ReplyImageIDs/ReplyGIFImageIDs/ReplyStickerImageIDs/ReplyCaptions/ReplyCaptionByImageID/ImageIDs/GIFImageIDs/StickerImageIDs/Captions/CaptionByImageID/ImageJob/Reactions)]: content",
  "Legend: Recent history date stamps appear at the first visible message and after roughly 1+ minute gaps; stamps include local time and relative age.",
  "Legend: Parenthesized names are current Discord display names, not stable identity, and may contain jokes, moods, or temporary labels; use @username for exact pings.",
].join("\n");

/** The legend block prepended to the older slice. */
export const OLDER_LEGEND = [
  "Legend: [@author to @target (MsgID/MsgIDs/Quote/ReplyImageIDs/ReplyGIFImageIDs/ReplyStickerImageIDs/ReplyCaptions/ReplyCaptionByImageID/ImageIDs/GIFImageIDs/StickerImageIDs/Captions/CaptionByImageID/ImageJob)]: content",
  "Legend: Older history date stamps appear at the first visible message and after roughly 5+ minute gaps; time markers use [...]. Newer history exposes MsgID for reply_to; merged messages use history-only [msg-break], quotes are excerpts for search_channel_messages(id), and images/GIF first frames/sticker previews use read_chat_images([id]).",
].join("\n");
