import { describe, expect, test } from "bun:test";
import { createDatabase } from "../db/database";
import { applyRelationshipSignals, getRelationshipProfile, listRelationshipEvents, resetRelationships, type RelationshipConfig } from "./index";

function config(): RelationshipConfig {
  return { enabled: true, promptInjection: true, maxAxisDeltaPerSignal: 4, maxToolCalls: 5 };
}

describe("relationship engine", () => {
  test("stores relationship profiles directly and keeps event audit", () => {
    const db = createDatabase(":memory:");

    const result = applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { guildId: "g1", channelId: "c1", userId: "u1" },
      signals: [{
        summary: "2B warmly checked back in after a gap.",
        confidence: 0.9,
        axes: { warmth: 2, curiosity: 1 },
        note: "She is comfortable asking how the user is doing.",
      }],
    });

    expect(result.accepted).toHaveLength(1);
    const profile = getRelationshipProfile(db, "u1");
    expect(profile.axes.warmth).toBe(2);
    expect(profile.axes.curiosity).toBe(1);
    expect(profile.notes).toContain("She is comfortable asking how the user is doing.");
    expect(listRelationshipEvents(db)).toHaveLength(1);
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

  test("refreshes repeated boundaries to the prompt tail", () => {
    const db = createDatabase(":memory:");

    applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { userId: "u1" },
      signals: [{ summary: "Boundary set.", confidence: 0.9, boundary: "do not treat slurs as banter" }],
      now: 1,
    });
    applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { userId: "u1" },
      signals: Array.from({ length: 20 }, (_, index) => ({
        summary: `Other boundary ${index}.`,
        confidence: 0.9,
        boundary: `other boundary ${index}`,
      })),
      now: 2,
    });
    applyRelationshipSignals(db, config(), {
      source: "llm",
      scope: { userId: "u1" },
      signals: [{ summary: "Boundary repeated.", confidence: 0.9, boundary: "do not treat slurs as banter" }],
      now: 3,
    });

    const profile = getRelationshipProfile(db, "u1");
    expect(profile.boundaries).toHaveLength(20);
    expect(profile.boundaries.at(-1)).toBe("do not treat slurs as banter");
    expect(profile.boundaries.filter((boundary) => boundary === "do not treat slurs as banter")).toHaveLength(1);
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
