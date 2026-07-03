import { describe, expect, test } from "bun:test";
import { createDatabase } from "../db/database";
import { applyRelationshipSignals, getRelationshipProfile, listRelationshipEvents, resetRelationships, type RelationshipConfig } from "./index";

function config(): RelationshipConfig {
  return { enabled: true, promptInjection: true, maxAxisDeltaPerSignal: 4 };
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
