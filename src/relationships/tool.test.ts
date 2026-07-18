import { describe, expect, test } from "bun:test";
import { createDatabase } from "../db/database";
import { createRecordRelationshipTool, getRelationshipProfile, listRelationshipEvents, type RelationshipConfig, type RelationshipMutationResult } from "./index";

function config(): RelationshipConfig {
  return { modelProfile: "main", enabled: true, promptInjection: true, maxAxisDeltaPerSignal: 4, maxToolCalls: 5 };
}

describe("record_relationship tool", () => {
  test("records relationship signals", async () => {
    const db = createDatabase(":memory:");
    const tool = createRecordRelationshipTool({ db, config: config(), scope: { userId: "u1" } });

    const result = await tool.execute("call-1", {
      signals: [{
        summary: "2B showed mild curiosity after the user's return.",
        confidence: 0.9,
        axes: { curiosity: 2, warmth: 1 },
        openLoop: "ask how the user has been after a gap",
      }],
    });

    expect((result.details as RelationshipMutationResult).accepted).toHaveLength(1);
    const profile = getRelationshipProfile(db, "u1");
    expect(profile.axes.curiosity).toBe(2);
    expect(profile.axes.warmth).toBe(1);
    expect(profile.openLoops).toContain("ask how the user has been after a gap");
    expect(listRelationshipEvents(db)).toHaveLength(1);
    db.close();
  });

  test("rejects invalid schema", async () => {
    const db = createDatabase(":memory:");
    const tool = createRecordRelationshipTool({ db, config: config() });

    const result = await tool.execute("call-1", { events: [] });

    expect(result.details).toEqual({ error: true });
    expect(listRelationshipEvents(db)).toHaveLength(0);
    db.close();
  });

  test("names unknown relationship axes before schema validation", () => {
    const db = createDatabase(":memory:");
    const tool = createRecordRelationshipTool({ db, config: config() });

    expect(() => tool.prepareArguments?.({
      signals: [{
        summary: "A relationship signal.",
        confidence: 0.8,
        axes: { friendship: 1 },
      }],
    })).toThrow(
      "signals[0].axes.friendship is unknown; allowed axes: familiarity, trust, warmth, respect, tension, curiosity, attraction, intimacy, attachment",
    );
    db.close();
  });
});
