/**
 * Centralized time utilities for agent-facing surfaces.
 *
 * Contract: all agent-visible timestamps use local wall-clock time in guild timezone.
 * Internal representation stays epoch ms. No ISO Z strings in agent-facing output.
 */
import { Temporal } from "@js-temporal/polyfill";

/**
 * Format epoch ms as local wall-clock: `YYYY-MM-DD HH:mm`.
 * Falls back to UTC if timezone is invalid.
 */
export function formatLocalWallClock(epochMs: number, timezone: string): string {
  const tz = safeTimezone(timezone);
  const instant = Temporal.Instant.fromEpochMilliseconds(epochMs);
  const zdt = instant.toZonedDateTimeISO(tz);
  return formatZonedDateTime(zdt);
}

function formatZonedDateTime(zdt: Temporal.ZonedDateTime): string {
  const y = String(zdt.year).padStart(4, "0");
  const mo = String(zdt.month).padStart(2, "0");
  const d = String(zdt.day).padStart(2, "0");
  const h = String(zdt.hour).padStart(2, "0");
  const mi = String(zdt.minute).padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

function weekdayName(dayOfWeek: number): string {
  switch (dayOfWeek) {
    case 1: return "Monday";
    case 2: return "Tuesday";
    case 3: return "Wednesday";
    case 4: return "Thursday";
    case 5: return "Friday";
    case 6: return "Saturday";
    case 7: return "Sunday";
    default: return "Unknown";
  }
}

function daypart(hour: number): string {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

/**
 * Build the "Current Context" metadata block for agent system prompt.
 * Returns lines with timezone, local date/time, and local daypart.
 */
export function currentLocalContext(timezone: string, nowMs?: number): string {
  const tz = safeTimezone(timezone);
  const now = nowMs ?? Date.now();
  const zdt = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(tz);
  const weekday = weekdayName(zdt.dayOfWeek);
  const dayType = zdt.dayOfWeek >= 6 ? "weekend" : "weekday";
  return `Timezone: ${tz}\nLocal Date/Time: ${weekday}, ${formatZonedDateTime(zdt)}\nLocal Daypart: ${dayType} ${daypart(zdt.hour)}`;
}

/** Format elapsed wall time compactly for prompt metadata, e.g. `10h 13m`. */
export function formatElapsedDuration(fromMs: number, toMs: number): string {
  const elapsedMs = Math.max(0, toMs - fromMs);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (elapsedMs < minuteMs) return "<1m";

  const days = Math.floor(elapsedMs / dayMs);
  const hours = Math.floor((elapsedMs % dayMs) / hourMs);
  const minutes = Math.floor((elapsedMs % hourMs) / minuteMs);

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

/** Result of parsing a local datetime string. */
export type ParseResult =
  | { ok: true; epochMs: number }
  | { ok: false; error: string };

/**
 * Parse a `YYYY-MM-DD HH:mm` local datetime string into epoch ms.
 *
 * Rejects:
 * - Invalid format (anything other than exactly `YYYY-MM-DD HH:mm`)
 * - ISO 8601 with Z/offset suffixes
 * - DST nonexistent times (spring forward gap)
 * - DST ambiguous times (fall back overlap)
 * - Invalid timezone
 * - Out of range date/time values
 */
export function parseLocalDateTimeToEpoch(localDateTime: string, timezone: string): ParseResult {
  // Strict format validation: exactly YYYY-MM-DD HH:mm
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(localDateTime);
  if (match === null) {
    return { ok: false, error: "Invalid format. Expected: YYYY-MM-DD HH:mm" };
  }

  // Validate timezone
  if (!isValidTemporalTimezone(timezone)) {
    return { ok: false, error: `Invalid timezone: ${timezone}` };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);

  try {
    // PlainDateTime.from with overflow:'reject' would be ideal but it uses 'constrain' by default
    // and the polyfill clamps out-of-range values. We must validate after construction.
    const pdt = Temporal.PlainDateTime.from(
      { year, month, day, hour, minute },
    );

    // Detect clamping: if PlainDateTime fields don't match input, input was out of range
    if (pdt.year !== year || pdt.month !== month || pdt.day !== day ||
        pdt.hour !== hour || pdt.minute !== minute) {
      return { ok: false, error: `Invalid date/time: out of range values` };
    }

    // Convert to ZonedDateTime with disambiguation:'reject'.
    // Throws RangeError for nonexistent or ambiguous times.
    const zdt = pdt.toZonedDateTime(timezone, { disambiguation: "reject" });
    return { ok: true, epochMs: zdt.epochMilliseconds };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // The polyfill 0.5.x uses "multiple instants found" for both DST cases.
    // Distinguish by checking: resolve with 'earlier' and see if wall-clock matches input.
    if (/multiple instants/.test(message.toLowerCase())) {
      return classifyDstError(year, month, day, hour, minute, timezone);
    }

    return { ok: false, error: `Invalid date/time: ${message}` };
  }
}

/**
 * When Temporal rejects with "multiple instants found", distinguish between
 * nonexistent (spring forward gap) and ambiguous (fall back overlap) times.
 *
 * Strategy: resolve with 'earlier' disambiguation and check if the resulting
 * wall-clock time matches the input. If it matches, the time is ambiguous
 * (two valid instants for the same wall-clock). If it doesn't match, the time
 * is nonexistent (skipped during spring forward).
 */
function classifyDstError(
  year: number, month: number, day: number, hour: number, minute: number,
  timezone: string,
): ParseResult {
  try {
    const pdt = Temporal.PlainDateTime.from({ year, month, day, hour, minute });
    const zdt = pdt.toZonedDateTime(timezone, { disambiguation: "earlier" });
    if (zdt.hour === hour && zdt.minute === minute) {
      return { ok: false, error: "Ambiguous time due to DST fall-back. Choose a different time." };
    }
    return { ok: false, error: "Nonexistent time due to DST spring-forward. Choose a different time." };
  } catch {
    return { ok: false, error: "Invalid date/time due to DST transition." };
  }
}

/** Validate timezone string against Temporal. */
function isValidTemporalTimezone(tz: string): boolean {
  try {
    // In polyfill 0.5.x, pass timezone string directly to ZonedDateTime construction
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(tz);
    return true;
  } catch {
    return false;
  }
}

/** Validate and return timezone, falling back to UTC. */
function safeTimezone(timezone: string): string {
  return isValidTemporalTimezone(timezone) ? timezone : "UTC";
}
