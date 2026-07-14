import { Temporal } from "@js-temporal/polyfill";
import type { PersonaModeWindow } from "./types.ts";

export interface EpochWindow {
  startAt: number;
  endAt: number;
}

function clockParts(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(":").map(Number);
  return { hour: hour ?? 0, minute: minute ?? 0 };
}

function epochFor(date: Temporal.PlainDate, clock: string, timezone: string): number {
  const { hour, minute } = clockParts(clock);
  return date.toPlainDateTime({ hour, minute }).toZonedDateTime(timezone, { disambiguation: "compatible" }).epochMilliseconds;
}

function epochWindowForDate(date: Temporal.PlainDate, window: PersonaModeWindow, timezone: string): EpochWindow {
  const startAt = epochFor(date, window.start, timezone);
  const endDate = window.end <= window.start ? date.add({ days: 1 }) : date;
  return { startAt, endAt: epochFor(endDate, window.end, timezone) };
}

function localDate(epochMs: number, timezone: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timezone).toPlainDate();
}

/** Enumerate daily local windows intersecting an epoch interval. */
export function enumerateEpochWindows(
  windows: readonly PersonaModeWindow[],
  timezone: string,
  fromMs: number,
  toMs: number,
): EpochWindow[] {
  let date = localDate(fromMs, timezone).subtract({ days: 1 });
  const endDate = localDate(toMs, timezone).add({ days: 1 });
  const result: EpochWindow[] = [];
  while (Temporal.PlainDate.compare(date, endDate) <= 0) {
    for (const window of windows) {
      const epochWindow = epochWindowForDate(date, window, timezone);
      if (epochWindow.endAt > fromMs && epochWindow.startAt <= toMs) result.push(epochWindow);
    }
    date = date.add({ days: 1 });
  }
  return result.sort((a, b) => {
    const startOrder = a.startAt - b.startAt;
    return startOrder !== 0 ? startOrder : a.endAt - b.endAt;
  });
}

/** Return the currently active local-time window, if any. */
export function activeEpochWindow(
  windows: readonly PersonaModeWindow[],
  timezone: string,
  now: number,
): EpochWindow | undefined {
  return enumerateEpochWindows(windows, timezone, now - 172_800_000, now + 172_800_000)
    .filter((window) => window.startAt <= now && now < window.endAt)
    .sort((a, b) => b.startAt - a.startAt)[0];
}

/** Return the next local-time window start strictly after now. */
export function nextEpochWindow(
  windows: readonly PersonaModeWindow[],
  timezone: string,
  now: number,
): EpochWindow | undefined {
  return enumerateEpochWindows(windows, timezone, now, now + 370 * 86_400_000)
    .find((window) => window.startAt > now);
}

/** Choose a uniformly distributed start from eligible local-time windows. */
export function randomStartInWindows(
  windows: readonly PersonaModeWindow[],
  timezone: string,
  earliestAt: number,
  latestAt: number,
  requiredDurationMs: number,
  random: () => number,
): { startsAt: number; windowEndsAt: number } | undefined {
  const segments = enumerateEpochWindows(windows, timezone, earliestAt, latestAt)
    .map((window) => ({
      first: Math.max(window.startAt, earliestAt),
      last: Math.min(window.endAt - requiredDurationMs, latestAt),
      windowEndsAt: window.endAt,
    }))
    .filter((segment) => segment.last >= segment.first);
  const total = segments.reduce((sum, segment) => sum + Math.max(1, segment.last - segment.first + 1), 0);
  if (total <= 0) return undefined;
  let offset = Math.floor(random() * total);
  for (const segment of segments) {
    const length = Math.max(1, segment.last - segment.first + 1);
    if (offset < length) return { startsAt: segment.first + offset, windowEndsAt: segment.windowEndsAt };
    offset -= length;
  }
  const fallback = segments.at(-1);
  return fallback === undefined ? undefined : { startsAt: fallback.last, windowEndsAt: fallback.windowEndsAt };
}
