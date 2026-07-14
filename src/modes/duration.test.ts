import { describe, expect, test } from "bun:test";
import { parseDurationMs } from "./duration.ts";

describe("parseDurationMs", () => {
  test("parses compact millisecond through day units", () => {
    expect(parseDurationMs("1000ms", "duration")).toBe(1_000);
    expect(parseDurationMs("100s", "duration")).toBe(100_000);
    expect(parseDurationMs("20m", "duration")).toBe(1_200_000);
    expect(parseDurationMs("1.5h", "duration")).toBe(5_400_000);
    expect(parseDurationMs("10d", "duration")).toBe(864_000_000);
  });

  test("rejects ambiguous or non-positive values", () => {
    expect(() => parseDurationMs("20", "duration")).toThrow("compact duration");
    expect(() => parseDurationMs("20 m", "duration")).toThrow("compact duration");
    expect(() => parseDurationMs("0m", "duration")).toThrow("positive safe integer");
  });

  test("allows an explicit zero only for fields with zero semantics", () => {
    expect(parseDurationMs(0, "minInterval", { allowZero: true })).toBe(0);
    expect(parseDurationMs("0s", "cooldown", { allowZero: true })).toBe(0);
    expect(() => parseDurationMs(0, "duration")).toThrow("duration string");
  });
});
