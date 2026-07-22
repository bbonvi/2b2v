import { describe, expect, test } from "bun:test";
import { DEFAULT_PRIVATE_LIFE } from "../config/defaults.ts";
import {
  privateLifeDayPhase,
  privateLifeNextDelayMs,
  privateLifePhaseBoundaryDelayMs,
  selectPrivateLifeCuriosity,
} from "./selector.ts";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("private-life curiosity selector", () => {
  test("uses local time for day, late-night, and sleep phases", () => {
    const config = { ...DEFAULT_PRIVATE_LIFE, lateNightStart: "22:30", sleepStart: "23:30", sleepEnd: "07:55" };

    expect(privateLifeDayPhase(config, "UTC", Date.UTC(2026, 6, 21, 12, 0))).toBe("day");
    expect(privateLifeDayPhase(config, "UTC", Date.UTC(2026, 6, 21, 23, 0))).toBe("late-night");
    expect(privateLifeDayPhase(config, "UTC", Date.UTC(2026, 6, 22, 2, 0))).toBe("sleep-window");
    expect(privateLifeDayPhase(config, "Europe/Moscow", Date.UTC(2026, 6, 21, 19, 45))).toBe("late-night");
  });

  test("reduces opportunity frequency at night", () => {
    const day = privateLifeNextDelayMs(DEFAULT_PRIVATE_LIFE, "day", 0.5);
    const late = privateLifeNextDelayMs(DEFAULT_PRIVATE_LIFE, "late-night", 0.5);
    const sleep = privateLifeNextDelayMs(DEFAULT_PRIVATE_LIFE, "sleep-window", 0.5);

    expect(late).toBeGreaterThan(day * 2);
    expect(sleep).toBe(day * 25);
    const expectedDailyOpportunities = 875 * 60_000 / day
      + 60 * 60_000 / late
      + 505 * 60_000 / sleep;
    expect(expectedDailyOpportunities).toBeCloseTo(DEFAULT_PRIVATE_LIFE.opportunitiesPerDay, 4);
    expect(privateLifePhaseBoundaryDelayMs(
      DEFAULT_PRIVATE_LIFE,
      "UTC",
      Date.UTC(2026, 6, 22, 7, 54),
    )).toBe(60_000);
  });

  test("composes many concrete directions without exhausting a fixed short list", () => {
    const random = seededRandom(42);
    const seeds = new Set<string>();
    const combinations = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const selection = selectPrivateLifeCuriosity({
        config: DEFAULT_PRIVATE_LIFE,
        phase: "day",
        recent: [],
        threads: [],
        random,
      });
      combinations.add(`${selection.origin}/${selection.mode}/${selection.territory}/${selection.actionScope}`);
      for (const seed of selection.candidateSeeds) seeds.add(seed);
    }

    expect(combinations.size).toBeGreaterThan(40);
    expect(seeds.size).toBeGreaterThan(300);
  });

  test("does not select unavailable history origins", () => {
    const config = {
      ...DEFAULT_PRIVATE_LIFE,
      originWeights: {
        spontaneous: 0,
        "continue-inner-thread": 100,
        "recent-residue": 100,
      },
    };
    const selection = selectPrivateLifeCuriosity({
      config,
      phase: "day",
      recent: [],
      threads: [],
      random: () => 0.5,
    });

    expect(selection.origin).toBe("spontaneous");
  });

  test("builds candidate seeds from operator-selected dimensions", () => {
    const selection = selectPrivateLifeCuriosity({
      config: DEFAULT_PRIVATE_LIFE,
      phase: "day",
      recent: [],
      threads: [],
      origin: "spontaneous",
      mode: "investigate",
      territory: "technical-material",
      random: () => 0,
    });

    expect(selection).toMatchObject({
      origin: "spontaneous",
      mode: "investigate",
      territory: "technical-material",
    });
    expect(selection.candidateSeeds[0]).toContain("worn mechanical seal");
  });

  test("makes reflection common and suppresses social opportunities when output is unavailable", () => {
    const random = seededRandom(7);
    const counts = new Map<string, number>();
    for (let index = 0; index < 2_000; index += 1) {
      const selection = selectPrivateLifeCuriosity({
        config: DEFAULT_PRIVATE_LIFE,
        phase: "day",
        recent: [],
        threads: [],
        random,
      });
      counts.set(selection.actionScope, (counts.get(selection.actionScope) ?? 0) + 1);
    }
    expect(counts.get("reflect-only") ?? 0).toBeGreaterThan(counts.get("quiet-exploration") ?? 0);
    expect(counts.get("social-opportunity") ?? 0).toBeLessThan(70);

    const unavailable = selectPrivateLifeCuriosity({
      config: {
        ...DEFAULT_PRIVATE_LIFE,
        actionScopeWeights: {
          "reflect-only": 0,
          "quiet-exploration": 0,
          "private-action": 0,
          "social-opportunity": 1,
        },
      },
      phase: "day",
      recent: [],
      threads: [],
      socialOutputAvailable: false,
      random: () => 0.5,
    });
    expect(unavailable.actionScope).toBe("reflect-only");
  });

  test("does not select external or social action during the sleep window", () => {
    const random = seededRandom(11);
    for (let index = 0; index < 500; index += 1) {
      const selection = selectPrivateLifeCuriosity({
        config: DEFAULT_PRIVATE_LIFE,
        phase: "sleep-window",
        recent: [],
        threads: [],
        random,
      });
      expect(["reflect-only", "quiet-exploration"]).toContain(selection.actionScope);
    }
  });
});
