import type { HistoryMessage } from "./history-types.ts";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

// Time unit thresholds in milliseconds
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * Compact relative time: "<1m ago", "5m ago", "2h ago", "3d ago", "2w ago", "1mo ago", "1y ago"
 * @param timestampMs - Unix timestamp in milliseconds
 * @param nowMs - Optional for testing determinism (defaults to Date.now())
 */
export function formatRelativeAgo(timestampMs: number, nowMs?: number): string {
  const now = nowMs ?? Date.now();
  const elapsed = now - timestampMs;

  if (elapsed < MINUTE_MS) return "<1m ago";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  if (elapsed < WEEK_MS) return `${Math.floor(elapsed / DAY_MS)}d ago`;
  if (elapsed < MONTH_MS) return `${Math.floor(elapsed / WEEK_MS)}w ago`;
  if (elapsed < YEAR_MS) return `${Math.floor(elapsed / MONTH_MS)}mo ago`;
  return `${Math.floor(elapsed / YEAR_MS)}y ago`;
}

/**
 * Format memory timestamps for context display.
 * Returns "(Created: Xago)" or "(Created: Xago; Updated: Yago)"
 */
export function formatMemoryTimestamps(
  createdAt: number,
  updatedAt: number,
  nowMs?: number,
): string {
  const created = formatRelativeAgo(createdAt, nowMs);
  if (updatedAt === createdAt) {
    return `(Created: ${created})`;
  }
  const updated = formatRelativeAgo(updatedAt, nowMs);
  return `(Created: ${created}; Updated: ${updated})`;
}

/**
 * Format a single timestamp for journal context display.
 * Returns just "(Xago)" based on updatedAt.
 */
export function formatJournalTimestamp(updatedAt: number, nowMs?: number): string {
  return `(${formatRelativeAgo(updatedAt, nowMs)})`;
}

/**
 * Format a timestamp as a deterministic date stamp: `[DATE YYYY-MM-DD HH:mm]`
 * Uses the guild timezone with UTC fallback if invalid. No offset suffix,
 * timezone is communicated once via the Current Context block.
 */
export function formatDateStamp(timestampMs: number, timezone: string): string {
  const tz = isValidTimezone(timezone) ? timezone : "UTC";
  const date = new Date(timestampMs);

  // Use Intl for deterministic, locale-agnostic parts
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "00";

  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const hh = get("hour");
  const min = get("minute");

  return `[DATE ${yyyy}-${mm}-${dd} ${hh}:${min}]`;
}

/**
 * Test whether a timezone string is valid for Intl.
 */
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Insert date stamps into the older slice.
 * - First message always gets a date stamp.
 * - Subsequent stamps only when >= 5 minutes since last insertion.
 * Returns an array of strings: interleaved date stamps and message indices.
 */
export function insertDateStamps(
  messages: HistoryMessage[],
  timezone: string,
): Array<{ type: "date"; text: string } | { type: "index"; index: number }> {
  if (messages.length === 0) return [];

  const result: Array<{ type: "date"; text: string } | { type: "index"; index: number }> = [];
  let lastDateTs = -Infinity;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m === undefined) continue;
    const elapsed = m.timestamp - lastDateTs;

    if (i === 0 || elapsed >= FIVE_MINUTES_MS) {
      result.push({ type: "date", text: formatDateStamp(m.timestamp, timezone) });
      lastDateTs = m.timestamp;
    }

    result.push({ type: "index", index: i });
  }

  return result;
}
