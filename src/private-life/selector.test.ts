import { describe, expect, test } from "bun:test";
import { DEFAULT_PRIVATE_LIFE } from "../config/defaults.ts";
import {
  privateLifeDayPhase,
  privateLifeNextDelayMs,
  privateLifePhaseBoundaryDelayMs,
  selectPrivateLifeAttention,
  selectPrivateLifeCuriosity,
  selectPrivateLifeResidueChannel,
} from "./selector.ts";
import type { InnerThread } from "../db/inner-thread-repository.ts";

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

  test("does not treat private episode summaries as room residue", () => {
    const selection = selectPrivateLifeCuriosity({
      config: {
        ...DEFAULT_PRIVATE_LIFE,
        originWeights: { spontaneous: 0, "continue-inner-thread": 0, "recent-residue": 1 },
      },
      phase: "day",
      recent: [{
        label: "old subject",
        themeKey: "old:subject",
        facets: [],
        createdAt: 1,
        territory: "open",
        mode: "unstructured",
      }],
      threads: [],
      recentResidueAvailable: false,
      random: () => 0.5,
    });

    expect(selection.origin).toBe("spontaneous");
  });

  test("selects an inner thread globally before choosing its runtime room", () => {
    const thread: InnerThread = {
      id: "thread-1",
      content: "Find out why this keeps happening.",
      aboutType: "self",
      aboutUserId: null,
      recallScope: "guild",
      recallGuildId: "guild-2",
      recallMode: "always",
      recallUserIds: [],
      salience: 0.8,
      pressure: 0.7,
      sourceMessageIds: ["message-1"],
      sourceGuildId: "guild-2",
      sourceChannelId: "channel-2",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
      expiresAt: null,
    };
    const attention = selectPrivateLifeAttention({
      config: DEFAULT_PRIVATE_LIFE,
      threads: [thread],
      recentResidueAvailable: false,
      origin: "continue-inner-thread",
      random: () => 0.5,
    });

    expect(attention).toEqual({ origin: "continue-inner-thread", thread });
  });

  test("selects room residue only from recently active candidate rooms", () => {
    const now = Date.UTC(2026, 6, 22, 12);
    const selected = selectPrivateLifeResidueChannel({
      candidates: [
        { guildId: "g1", channelId: "old", messageCount: 100, lastHumanActivityAt: now - 49 * 3_600_000 },
        { guildId: "g1", channelId: "none", messageCount: 100, lastHumanActivityAt: null },
        { guildId: "g2", channelId: "recent", messageCount: 4, lastHumanActivityAt: now - 3_600_000 },
      ],
      maxAgeHours: 48,
      now,
      random: () => 0.5,
    });

    expect(selected?.channelId).toBe("recent");
  });

  test("balances softened popularity with human recency", () => {
    const now = Date.UTC(2026, 6, 22, 12);
    const random = seededRandom(91);
    let recentCount = 0;
    for (let index = 0; index < 2_000; index += 1) {
      const selected = selectPrivateLifeResidueChannel({
        candidates: [
          { guildId: "g1", channelId: "popular-old", messageCount: 100, lastHumanActivityAt: now - 47 * 3_600_000 },
          { guildId: "g2", channelId: "recent", messageCount: 4, lastHumanActivityAt: now },
        ],
        maxAgeHours: 48,
        now,
        random,
      });
      if (selected?.channelId === "recent") recentCount += 1;
    }

    expect(recentCount).toBeGreaterThan(700);
    expect(recentCount).toBeLessThan(1_300);
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
