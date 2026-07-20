import type { HistoryMessage } from "./history-types.ts";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

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

interface LocalDateTimeParts {
  date: string;
  time: string;
  seconds: string;
}

function localDateTimeParts(timestampMs: number, timezone: string): LocalDateTimeParts {
  const tz = isValidTimezone(timezone) ? timezone : "UTC";
  const date = new Date(timestampMs);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const hh = get("hour");
  const min = get("minute");
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${min}`, seconds: get("second") };
}

/** Format the self-contained first marker for a history slice. */
export function formatDateStamp(timestampMs: number, timezone: string): string {
  const parts = localDateTimeParts(timestampMs, timezone);
  return `[${parts.date}]\n[${parts.time}]`;
}

/** Format a compact full local timestamp for non-chat-history event streams. */
export function formatDateTimeStamp(timestampMs: number, timezone: string, includeSeconds = false): string {
  const parts = localDateTimeParts(timestampMs, timezone);
  return `[${parts.date} ${parts.time}${includeSeconds ? `:${parts.seconds}` : ""}]`;
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
 * Insert local calendar/time markers into a history slice.
 * - The first message always gets a date marker followed by a time marker.
 * - Subsequent time markers appear after the configured gap.
 * - A local calendar-day transition always gets a date and time marker.
 * Returns an array of strings: interleaved date stamps and message indices.
 */
export function insertDateStamps(
  messages: HistoryMessage[],
  timezone: string,
  options: { minGapMs?: number } = {},
): Array<{ type: "date"; text: string } | { type: "index"; index: number }> {
  if (messages.length === 0) return [];

  const result: Array<{ type: "date"; text: string } | { type: "index"; index: number }> = [];
  let lastDateTs = -Infinity;
  let lastCalendarDate: string | undefined;
  const minGapMs = options.minGapMs ?? FIVE_MINUTES_MS;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m === undefined) continue;
    const local = localDateTimeParts(m.timestamp, timezone);
    const elapsed = m.timestamp - lastDateTs;
    const calendarChanged = lastCalendarDate !== undefined && local.date !== lastCalendarDate;

    if (i === 0 || calendarChanged || elapsed >= minGapMs) {
      result.push({
        type: "date",
        text: i === 0 || calendarChanged
          ? `[${local.date}]\n[${local.time}]`
          : `[${local.time}]`,
      });
      lastDateTs = m.timestamp;
    }
    lastCalendarDate = local.date;

    result.push({ type: "index", index: i });
  }

  return result;
}

export const RECENT_HISTORY_DATE_STAMP_GAP_MS = ONE_MINUTE_MS;
