import { describe, expect, test } from "bun:test";
import { RELATIONSHIP_AXES, baseRelationshipAxes } from "./state";
import { relationshipPortrait, relationshipPortraitVariantIds } from "./portrait";

describe("relationship portraits", () => {
  test("provides at least 120 unique full-prose variants", () => {
    const ids = relationshipPortraitVariantIds();
    expect(ids.length).toBeGreaterThanOrEqual(120);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("keeps selection stable while every axis stays in the same band", () => {
    const first = baseRelationshipAxes();
    first.familiarity = 12;
    first.trust = 35;
    first.warmth = -12;
    first.attraction = 14;
    const second = { ...first, familiarity: 20, trust: 50, warmth: -20, attraction: 25 };

    expect(relationshipPortrait(first).id).toBe(relationshipPortrait(second).id);
  });

  test("selects combined contradictory shapes without dropping material axes", () => {
    const attractedDistrust = baseRelationshipAxes();
    attractedDistrust.familiarity = 40;
    attractedDistrust.trust = -35;
    attractedDistrust.attraction = 45;
    attractedDistrust.intimacy = -10;

    const damagedAttachment = baseRelationshipAxes();
    damagedAttachment.trust = -45;
    damagedAttachment.warmth = -40;
    damagedAttachment.respect = -30;
    damagedAttachment.attraction = 30;
    damagedAttachment.attachment = 60;

    expect(relationshipPortrait(attractedDistrust).id).toStartWith("attracted-distrustful-");
    expect(relationshipPortrait(damagedAttachment).id).toStartWith("damaged-bond-pull-");
  });

  test("treats moderate trust, high warmth, and personal access as a notable bond", () => {
    const axes = baseRelationshipAxes();
    Object.assign(axes, {
      familiarity: 14.5,
      trust: 30.9,
      warmth: 41.3,
      respect: 10.6,
      tension: -7.4,
      curiosity: 6,
      attraction: 5.5,
      intimacy: 21.8,
      attachment: 6,
    });

    expect(relationshipPortrait(axes).id).toStartWith("warm-trusted-open-");

    axes.intimacy = 0;
    expect(relationshipPortrait(axes).id).toStartWith("warm-trusted-");
  });

  test("keeps every registered variant reachable across combined band vectors", () => {
    const values = [-80, -45, -15, 0, 15, 45, 80];
    const registered = new Set(relationshipPortraitVariantIds());
    const seen = new Set<string>();
    let seed = 1;
    for (let index = 0; index < 2_000_000 && seen.size < registered.size; index += 1) {
      const axes = Object.fromEntries(RELATIONSHIP_AXES.map((axis) => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return [axis, values[seed % values.length] ?? 0];
      })) as ReturnType<typeof baseRelationshipAxes>;
      seen.add(relationshipPortrait(axes).id);
    }
    expect(seen).toEqual(registered);
  });
});
