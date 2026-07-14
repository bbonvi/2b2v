const DURATION_UNITS_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

/** Parse a compact duration such as `1000ms`, `20m`, `1.5h`, or `10d`. */
export function parseDurationMs(value: unknown, field: string, options: { allowZero?: boolean } = {}): number {
  if (options.allowZero === true && value === 0) return 0;
  if (typeof value !== "string") throw new Error(`${field} must be a duration string such as 20m or 10d`);
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  if (match === null) throw new Error(`${field} must use a compact duration such as 1000ms, 100s, 20m, 20h, or 10d`);
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof DURATION_UNITS_MS;
  const durationMs = amount * DURATION_UNITS_MS[unit];
  if (
    !Number.isFinite(durationMs)
    || durationMs < 0
    || (durationMs === 0 && options.allowZero !== true)
    || !Number.isSafeInteger(durationMs)
  ) {
    throw new Error(`${field} must resolve to ${options.allowZero === true ? "a non-negative" : "a positive"} safe integer number of milliseconds`);
  }
  return durationMs;
}
