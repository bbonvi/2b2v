import type { HistoryMessage } from "./history-types.ts";

/**
 * Normalize whitespace: collapse all tabs, newlines, carriage returns to single spaces.
 * Applied before trimming for determinism.
 */
export function normalizeWhitespace(content: string): string {
  return content.replace(/[\t\n\r]+/g, " ");
}

/**
 * Trim a message's content to messageCharLimit if it exceeds it.
 * Appends a deterministic marker with trimmed char count and MsgID.
 * Whitespace is normalized first.
 * Returns a new message object; does not mutate input.
 */
export function trimMessageContent(
  message: HistoryMessage,
  messageCharLimit: number,
): HistoryMessage {
  const normalized = normalizeWhitespace(message.content);

  if (normalized.length <= messageCharLimit) {
    return { ...message, content: normalized };
  }

  const trimmedCount = normalized.length - messageCharLimit;
  const truncated = normalized.slice(0, messageCharLimit);
  const marker = `\u2026 [trimmed ${trimmedCount} chars; MsgID: ${message.id}]`;

  return {
    ...message,
    content: `${truncated}${marker}`,
  };
}

/**
 * Apply trimming to all messages in a list.
 * Returns new array; does not mutate input.
 */
export function trimMessages(
  messages: HistoryMessage[],
  messageCharLimit: number,
): HistoryMessage[] {
  return messages.map((m) => trimMessageContent(m, messageCharLimit));
}
