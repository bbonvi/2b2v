import type { TrimConfig } from "../config/types.ts";

/** A stored message with full metadata for history processing. */
export interface HistoryMessage {
  /** Discord message snowflake ID. */
  id: string;
  /** Message author display name (translated). */
  author: string;
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
  /** Whether the message has embeds (prevents merging). */
  hasEmbeds: boolean;
  /** Whether this is a synthetic event (e.g., thread creation). Prevents merging. */
  isSynthetic: boolean;
  /** Thread ID this synthetic event references, or null. */
  relatedThreadId: string | null;
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
}

/** A formatted line in the output, either a message line or a date stamp. */
export type FormattedLine =
  | { type: "message"; text: string }
  | { type: "date"; text: string };
