import type { HistoryAsset, HistoryMessage } from "./history-types.ts";
import { formatFileSize } from "./format-file-size.ts";

const DELETED_MESSAGE_MARKER = "[deleted]";

export function formatHistoryContent(message: Pick<HistoryMessage, "content" | "isDeleted">): string {
  return message.isDeleted === true
    ? `${message.content} ${DELETED_MESSAGE_MARKER}`
    : message.content;
}

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
  /** Lazy assets on the reply target. */
  replyAssets?: HistoryAsset[];
}

/** Input for formatting a single message line. */
export interface FormatInput {
  message: HistoryMessage;
  reply: ReplyContext | null;
  includeMessageIds?: boolean;
  includeDisplayNames?: boolean;
}

/**
 * Format a single message line per the deterministic grammar:
 * `[@<author>{ to @<target>}{ (<meta>)}]: <content>`
 *
 * Synthetic events (e.g., thread creation) are formatted as-is without author prefix.
 *
 * Meta keys in order: Quote, MissingTarget, typed reply assets, typed assets, jobs, and reactions.
 */
export function formatMessageLine(input: FormatInput): string {
  const { message, reply, includeMessageIds, includeDisplayNames } = input;

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
    if (reply.replyAssets !== undefined) metaParts.push(...formatAssetMeta("Reply", reply.replyAssets));
  }

  if (message.assets !== undefined) metaParts.push(...formatAssetMeta("", message.assets));
  if (message.jobAnnotations !== undefined && message.jobAnnotations.length > 0) {
    metaParts.push(...message.jobAnnotations);
  }
  if (message.historyAnnotations !== undefined && message.historyAnnotations.length > 0) {
    metaParts.push(...message.historyAnnotations);
  }
  if (includeMessageIds === true && message.reactions !== undefined && message.reactions !== "") {
    metaParts.push(`Reactions: ${message.reactions}`);
  }

  const authorPart = `@${message.author}${formatDisplayNameSuffix(message.author, message.authorDisplayName, includeDisplayNames)}`;
  const targetPart = reply !== null
    ? ` to @${reply.targetAuthor}${formatDisplayNameSuffix(reply.targetAuthor, reply.targetDisplayName, includeDisplayNames)}`
    : "";
  const metaPart = metaParts.length > 0 ? ` (${metaParts.join("; ")})` : "";
  const content = formatHistoryContent(message);

  return `[${authorPart}${targetPart}${metaPart}]: ${content}`;
}

/** Format lazy assets consistently in history and current-event metadata. */
export function formatAssetMeta(prefix: "Reply" | "", assets: readonly HistoryAsset[]): string[] {
  const labels = {
    image: "Images",
    gif: "GIFs",
    audio: "Audio",
    video: "Video",
    text: "Text",
    file: "Files",
  } as const;
  const parts: string[] = [];
  for (const kind of ["image", "gif", "audio", "video", "text", "file"] as const) {
    const matching = assets.filter((asset) => asset.kind === kind);
    if (matching.length === 0) continue;
    const values = matching.map((asset) => {
      const name = asset.filename?.replace(/[\t\n\r,;()[\]]+/g, " ").trim();
      let detail = "";
      if ((kind === "text" || kind === "file") && asset.size !== null) detail = formatFileSize(asset.size);
      if ((kind === "audio" || kind === "video") && asset.durationSeconds !== null) {
        const totalSeconds = Math.round(asset.durationSeconds);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        detail = minutes > 0 ? `${minutes}m${seconds > 0 ? `${seconds}s` : ""}` : `${seconds}s`;
      }
      return `#${asset.id}${name !== undefined && name !== "" ? ` ${name}` : ""}${detail !== "" ? ` (${detail})` : ""}${asset.jobId !== undefined ? ` [Job ${asset.jobId}]` : ""}`;
    });
    parts.push(`${prefix}${labels[kind]}: ${values.join(", ")}`);
  }
  return parts;
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
  "Legend: [@author (display name) to @target (display name) (MsgID/MsgIDs/Quote/ReplyImages/ReplyGIFs/ReplyAudio/ReplyVideo/ReplyText/ReplyFiles/Images/GIFs/Audio/Video/Text/Files/ImageJob/Reactions/<trigger>)]: content",
  "Legend: [YYYY-MM-DD] sets the guild-local date and [HH:mm] sets the guild-local time for following messages; recent history repeats time after roughly 1+ minute gaps and date at each local day change.",
  "Legend: Parenthesized names are current Discord display names, not stable identity, and may contain jokes, moods, or temporary labels; use @username for exact pings.",
].join("\n");

/** The legend block prepended to the older slice. */
export const OLDER_LEGEND = [
  "Legend: [@author to @target (MsgID/MsgIDs/Quote/ReplyImages/ReplyGIFs/ReplyAudio/ReplyVideo/ReplyText/ReplyFiles/Images/GIFs/Audio/Video/Text/Files/ImageJob)]: content",
  "Legend: [YYYY-MM-DD] sets the guild-local date and [HH:mm] sets the guild-local time for following messages; older history repeats time after roughly 5+ minute gaps and date at each local day change. Newer history exposes MsgID for reply_to; merged messages use history-only [msg-break], search results expose MsgIDs for contextual browsing, and typed asset IDs use read_asset.",
].join("\n");
