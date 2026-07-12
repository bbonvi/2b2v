import type { TrimConfig } from "../config/types.ts";
import type { ImageSourceKind } from "../db/image-repository.ts";
import type { AssetKind, AssetSourceKind } from "../db/asset-repository.ts";

export interface HistoryAsset {
  id: number;
  kind: AssetKind;
  sourceKind: AssetSourceKind;
  filename: string | null;
  contentType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

/** A stored message with full metadata for history processing. */
export interface HistoryMessage {
  /** Discord message snowflake ID. */
  id: string;
  /** Discord message IDs represented by this formatted row after merge. */
  mergedMessageIds?: string[];
  /** Stable Discord username used for exact pings. */
  author: string;
  /** Current Discord display name/nickname. Volatile and may differ from username. */
  authorDisplayName?: string;
  /** Author user ID. */
  authorId: string;
  /** Translated message content. */
  content: string;
  /** Whether the author is the bot. */
  isBot: boolean;
  /** Unix epoch ms. */
  timestamp: number;
  /** Reply target message ID, or null. */
  replyToId: string | null;
  /** Image IDs attached to this message. */
  imageIds: number[];
  /** Image captions (parallel to imageIds), empty strings if no caption. */
  captions: string[];
  /** Source media kinds (parallel to imageIds), used to mark GIF/sticker previews in history. */
  imageSourceKinds?: ImageSourceKind[];
  /** Lazy message assets shown as typed short IDs. */
  assets?: HistoryAsset[];
  /** Whether the message has embeds (prevents merging). */
  hasEmbeds: boolean;
  /** Whether this is a synthetic event (e.g., thread creation). Prevents merging. */
  isSynthetic: boolean;
  /** Whether this row is prompt-visible only and must never be searchable or tool-retrievable. */
  isPromptOnly?: boolean;
  /** Whether Discord has deleted this message; rendered history appends a deletion marker. */
  isDeleted?: boolean;
  /** Thread ID this synthetic event references, or null. */
  relatedThreadId: string | null;
  /** Runtime-only prompt annotations, e.g. async jobs triggered by this message. */
  jobAnnotations?: string[];
  /** Runtime-only prompt markers, e.g. the message that caused this turn. */
  historyAnnotations?: string[];
  /** Durable reaction summary shown only in volatile recent history. */
  reactions?: string;
}

/** Result of the slicing algorithm. */
export interface SliceResult {
  older: HistoryMessage[];
  newer: HistoryMessage[];
}

/** Configuration for history processing, combining trim and guild settings. */
export interface HistoryProcessingConfig {
  trim: TrimConfig;
  mergeMessageGapSeconds: number;
  timezone: string;
  imageCaptioningEnabled: boolean;
  /** Current Discord display names keyed by user ID. Used only for volatile recent history. */
  displayNamesByUserId?: ReadonlyMap<string, string>;
}

/** A formatted line in the output, either a message line or a date stamp. */
export type FormattedLine =
  | { type: "message"; text: string }
  | { type: "date"; text: string };
