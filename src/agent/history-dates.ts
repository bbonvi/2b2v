import type { HistoryMessage } from "./history-types.ts";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Format a timestamp as a deterministic date stamp: `[DATE YYYY-MM-DD HH:mm Z]`
 * Uses the guild timezone with UTC fallback if invalid.
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

  const offset = formatOffset(date, tz);

  return `[DATE ${yyyy}-${mm}-${dd} ${hh}:${min} ${offset}]`;
}

/**
 * Compute the UTC offset string like "+09:00" or "-05:00" for a given date and timezone.
 */
function formatOffset(date: Date, timezone: string): string {
  // Use Intl to get the offset
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  });
  const parts = formatter.formatToParts(date);
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  // tzPart is like "GMT+9:00" or "GMT-5:00" or "GMT"
  if (tzPart === "GMT") return "+00:00";
  const match = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(tzPart);
  if (match === null) return "+00:00";
  const sign = match[1] ?? "+";
  const hours = (match[2] ?? "00").padStart(2, "0");
  const minutes = (match[3] ?? "00").padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
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
