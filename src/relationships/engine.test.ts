import { describe, expect, test } from "bun:test";
import { createDatabase } from "../db/database";
import {
  applyRelationshipSignals,
  getRelationshipProfile,
  listRelationshipEvents,
  relationshipDeltaWindow,
  resetRelationships,
  type RelationshipConfig,
} from "./index";

function config(maxAxisDeltaPerSignal = 200): RelationshipConfig {
  return {
    modelProfile: "main",
    enabled: true,
    promptInjection: true,
    priorExchanges: false,
    maxAxisDeltaPerSignal,
    maxToolCalls: 5,
  };
}

describe("relationship engine", () => {
  test("uses every symmetric milestone boundary", () => {
    expect(relationshipDeltaWindow("trust", 19.9)).toEqual({ minimum: 0.1, maximum: 10 });
    expect(relationshipDeltaWindow("trust", 20)).toEqual({ minimum: 0.2, maximum: 20 });
    expect(relationshipDeltaWindow("trust", -39.9)).toEqual({ minimum: 0.2, maximum: 20 });
    expect(relationshipDeltaWindow("trust", 40)).toEqual({ minimum: 0.5, maximum: 40 });
    expect(relationshipDeltaWindow("trust", -59.9)).toEqual({ minimum: 0.5, maximum: 40 });
    expect(relationshipDeltaWindow("trust", 60)).toEqual({ minimum: 1, maximum: 80 });
    expect(relationshipDeltaWindow("trust", -79.9)).toEqual({ minimum: 1, maximum: 80 });
    expect(relationshipDeltaWindow("trust", 80)).toEqual({ minimum: 2, maximum: 200 });
    expect(relationshipDeltaWindow("trust", -100)).toEqual({ minimum: 2, maximum: 200 });
  });

  test("applies low-score caps and records requested versus applied axes", () => {
    const db = createDatabase(":memory:");

    applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { guildId: "g1", channelId: "c1", userId: "u1" },
      signals: [{
        summary: "A severe first-turn trust loss.",
        confidence: 0.9,
        axes: { trust: -50, warmth: 30 },
      }],
    });

    expect(getRelationshipProfile(db, "u1").axes).toMatchObject({ trust: -10, warmth: 10 });
    expect(listRelationshipEvents(db).find((event) => event.summary === "A severe first-turn trust loss.")?.payload).toMatchObject({
      requestedAxes: { trust: -50, warmth: 30 },
      appliedAxes: { trust: -10, warmth: 10 },
    });
    db.close();
  });

  test("uses symmetric milestone floors while familiarity keeps 0.1", () => {
    const db = createDatabase(":memory:");
    applyRelationshipSignals(db, config(), {
      source: "admin",
      scope: { userId: "u1" },
      signals: [{
        summary: "Set starting values.",
        confidence: 1,
        axes: { trust: 25, familiarity: 25 },
      }],
    });

    applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { userId: "u1" },
      signals: [{
        summary: "One small new point of fluency.",
        confidence: 0.9,
        axes: { trust: 0.1, familiarity: 0.1 },
      }],
    });

    expect(getRelationshipProfile(db, "u1").axes).toMatchObject({
      trust: 25,
      familiarity: 25.1,
    });
    expect(listRelationshipEvents(db).find((event) => event.summary === "One small new point of fluency.")?.payload)
      .toMatchObject({ appliedAxes: { trust: 0, familiarity: 0.1 } });
    expect(relationshipDeltaWindow("trust", -25)).toEqual({ minimum: 0.2, maximum: 20 });
    expect(relationshipDeltaWindow("familiarity", 85)).toEqual({ minimum: 0.1, maximum: 200 });
    db.close();
  });

  test("uses the starting value and one cumulative per-pass budget", () => {
    const db = createDatabase(":memory:");

    applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { userId: "u1" },
      signals: [
        { summary: "First loss.", confidence: 0.9, axes: { trust: -10 } },
        { summary: "Split loss.", confidence: 0.9, axes: { trust: -10 } },
      ],
      now: 10,
    });

    const profile = getRelationshipProfile(db, "u1");
    expect(profile.axes.trust).toBe(-10);
    expect(profile.recent).toHaveLength(1);
    expect(listRelationshipEvents(db)).toHaveLength(2);
    expect(listRelationshipEvents(db).find((event) => event.summary === "Split loss.")?.payload)
      .toMatchObject({ appliedAxes: { trust: 0 } });
    db.close();
  });

  test("applies the same windows toward zero from positive and negative values", () => {
    const db = createDatabase(":memory:");
    applyRelationshipSignals(db, config(), {
      source: "admin",
      scope: { userId: "positive" },
      signals: [{ summary: "Set positive.", confidence: 1, axes: { trust: 25 } }],
    });
    applyRelationshipSignals(db, config(), {
      source: "admin",
      scope: { userId: "negative" },
      signals: [{ summary: "Set negative.", confidence: 1, axes: { trust: -25 } }],
    });

    applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { userId: "positive" },
      signals: [{ summary: "Move down.", confidence: 1, axes: { trust: -30 } }],
    });
    applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { userId: "negative" },
      signals: [{ summary: "Move up.", confidence: 1, axes: { trust: 30 } }],
    });

    expect(getRelationshipProfile(db, "positive").axes.trust).toBe(5);
    expect(getRelationshipProfile(db, "negative").axes.trust).toBe(-5);
    db.close();
  });

  test("lets admin and system changes bypass LLM windows", () => {
    const db = createDatabase(":memory:");
    applyRelationshipSignals(db, config(1), {
      source: "admin",
      scope: { userId: "u1" },
      signals: [{ summary: "Admin correction.", confidence: 1, axes: { trust: 80 } }],
    });
    applyRelationshipSignals(db, config(1), {
      source: "system",
      scope: { userId: "u1" },
      signals: [{ summary: "System correction.", confidence: 1, axes: { trust: -160 } }],
    });

    expect(getRelationshipProfile(db, "u1").axes.trust).toBe(-80);
    db.close();
  });

  test("allows repair to reverse only outstanding recent movement", () => {
    const db = createDatabase(":memory:");
    applyRelationshipSignals(db, config(), {
      source: "admin",
      scope: { userId: "u1" },
      signals: [{ summary: "Established trust.", confidence: 1, axes: { trust: 60 } }],
      now: 1,
    });
    applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { userId: "u1" },
      signals: [{ summary: "A serious apparent rupture.", confidence: 1, axes: { trust: -50 } }],
      now: 2,
    });
    applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { userId: "u1" },
      signals: [{ summary: "Part of the rupture was repaired.", confidence: 1, repair: true, axes: { trust: 20 } }],
      now: 3,
    });
    applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { userId: "u1" },
      signals: [{ summary: "The remaining misread was corrected.", confidence: 1, repair: true, axes: { trust: 80 } }],
      now: 4,
    });

    expect(getRelationshipProfile(db, "u1").axes.trust).toBe(60);
    expect(listRelationshipEvents(db)[0]?.payload).toMatchObject({
      repair: true,
      requestedAxes: { trust: 80 },
      appliedAxes: { trust: 30 },
    });
    db.close();
  });

  test("removes exact boundaries and closes exact open matters", () => {
    const db = createDatabase(":memory:");
    applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { userId: "u1" },
      signals: [{
        summary: "State added.",
        confidence: 0.9,
        boundary: "do not repeat this joke",
        openLoop: "decide whether the joke was serious",
      }],
    });
    applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { userId: "u1" },
      signals: [{
        summary: "The misread was corrected.",
        confidence: 0.9,
        removeBoundary: "do not repeat this joke",
        closeOpenLoop: "decide whether the joke was serious",
      }],
    });

    const profile = getRelationshipProfile(db, "u1");
    expect(profile.boundaries).toEqual([]);
    expect(profile.openLoops).toEqual([]);
    db.close();
  });

  test("keeps a suppressed-only audit event without mutating profile state", () => {
    const db = createDatabase(":memory:");
    applyRelationshipSignals(db, config(), {
      source: "admin",
      scope: { userId: "u1" },
      signals: [{ summary: "Set trust.", confidence: 1, axes: { trust: 25 } }],
      now: 1,
    });
    const before = getRelationshipProfile(db, "u1");

    const result = applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { userId: "u1" },
      signals: [{ summary: "Too small.", confidence: 0.9, axes: { trust: 0.1 } }],
      now: 2,
    });

    expect(result.profiles).toEqual([]);
    expect(getRelationshipProfile(db, "u1")).toEqual(before);
    expect(listRelationshipEvents(db)).toHaveLength(2);
    db.close();
  });

  test("dry run does not persist profiles or events", () => {
    const db = createDatabase(":memory:");

    const result = applyRelationshipSignals(db, config(), {
      source: "llm",
      dryRun: true,
      scope: { userId: "u1" },
      signals: [{ summary: "Warm signal.", confidence: 0.9, axes: { warmth: 2 } }],
    });

    expect(result.profiles[0]?.axes.warmth).toBe(2);
    expect(getRelationshipProfile(db, "u1").axes.warmth).toBe(0);
    expect(listRelationshipEvents(db)).toHaveLength(0);
    db.close();
  });

  test("reset clears profiles and audit events", () => {
    const db = createDatabase(":memory:");
    applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { userId: "u1" },
      signals: [{ summary: "Warm signal.", confidence: 0.9, axes: { warmth: 2 } }],
    });
    resetRelationships(db);

    expect(getRelationshipProfile(db, "u1").axes.warmth).toBe(0);
    expect(listRelationshipEvents(db)).toHaveLength(0);
    db.close();
  });
});
