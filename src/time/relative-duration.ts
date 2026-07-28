import { Type } from "typebox";

export type RelativeDurationUnit = "minutes" | "hours" | "days" | "weeks" | "months";

export interface RelativeDuration {
  amount: number;
  unit: RelativeDurationUnit;
}

export const RelativeDurationSchema = Type.Object({
  amount: Type.Number({ exclusiveMinimum: 0 }),
  unit: Type.Union([
    Type.Literal("minutes"),
    Type.Literal("hours"),
    Type.Literal("days"),
    Type.Literal("weeks"),
    Type.Literal("months"),
  ]),
}, { additionalProperties: false });

export function isRelativeDuration(value: unknown): value is RelativeDuration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { amount, unit } = value as { amount?: unknown; unit?: unknown };
  return typeof amount === "number"
    && Number.isFinite(amount)
    && amount > 0
    && (unit === "minutes" || unit === "hours" || unit === "days" || unit === "weeks" || unit === "months");
}

/** Convert the human-facing relative duration format to the runtime millisecond clock. */
export function relativeDurationToMilliseconds(value: unknown): number {
  if (!isRelativeDuration(value)) throw new Error("Duration requires a positive amount and a valid unit.");
  const minuteMs = 60 * 1000;
  const unitMs: Record<RelativeDurationUnit, number> = {
    minutes: minuteMs,
    hours: 60 * minuteMs,
    days: 24 * 60 * minuteMs,
    weeks: 7 * 24 * 60 * minuteMs,
    months: 30 * 24 * 60 * minuteMs,
  };
  const milliseconds = Math.round(value.amount * unitMs[value.unit]);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) throw new Error("Duration is outside the supported range.");
  return milliseconds;
}
