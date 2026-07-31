import { describe, expect, test } from "bun:test";
import { RELATIONSHIP_AXES, baseRelationshipAxes } from "./state";
import { relationshipPortrait, relationshipPortraitVariantIds } from "./portrait";
import type { RelationshipPortrait } from "./portrait";

describe("relationship portraits", () => {
  test("provides at least 150 unique full-prose variants", () => {
    const ids = relationshipPortraitVariantIds();
    expect(ids.length).toBeGreaterThanOrEqual(150);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("keeps selection stable while every axis stays in the same band", () => {
    const first = baseRelationshipAxes();
    first.familiarity = 12;
    first.trust = 25;
    first.warmth = -12;
    first.attraction = 8;
    const second = { ...first, familiarity: 20, trust: 40, warmth: -20, attraction: 14 };

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

  test("keeps severe low-history relationships adverse instead of merely wary", () => {
    const axes = baseRelationshipAxes();
    Object.assign(axes, {
      familiarity: 0.5,
      trust: -39.95,
      warmth: -65.75,
      respect: -33.33,
      tension: 33.33,
      intimacy: -1,
    });

    const portrait = relationshipPortrait(axes);

    expect(portrait.id).toStartWith("unfamiliar-adverse-");
    expect(portrait.compactProse).toContain("distinctly adverse shape");
    expect(portrait.compactProse).not.toContain("first stable impression is wary rather than warm");

    axes.curiosity = 30;
    expect(relationshipPortrait(axes).id).toStartWith("unfamiliar-adverse-");

    Object.assign(axes, baseRelationshipAxes(), { trust: -5 });
    expect(relationshipPortrait(axes).id).toStartWith("unfamiliar-wary-");
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

    expect(relationshipPortrait(axes).id).toStartWith("warm-trusted-open-pull-");

    axes.intimacy = 0;
    expect(relationshipPortrait(axes).id).toStartWith("warm-trusted-");
  });

  test("lets strong warmth and intimacy outweigh mild remaining tension", () => {
    const axes = baseRelationshipAxes();
    Object.assign(axes, {
      familiarity: 40.9,
      trust: 2.6,
      warmth: 69.6,
      respect: -2.7,
      tension: 9.666667,
      curiosity: 6.1,
      attraction: 24.84,
      intimacy: 27.6,
      attachment: 16.4,
    });

    expect(relationshipPortrait(axes).id).toStartWith("warm-open-");
  });

  test("lets quieter trust and attraction register before easily accumulated axes", () => {
    const axes = baseRelationshipAxes();

    axes.attraction = 2;
    expect(relationshipPortrait(axes).id).toStartWith("unknown-neutral-");
    axes.attraction = 3;
    expect(relationshipPortrait(axes).id).toStartWith("attracted-detached-");

    Object.assign(axes, baseRelationshipAxes());
    axes.trust = 4;
    expect(relationshipPortrait(axes).id).toStartWith("unknown-neutral-");
    axes.trust = 5;
    expect(relationshipPortrait(axes).id).toStartWith("trusted-distant-");

    Object.assign(axes, baseRelationshipAxes());
    axes.familiarity = 9;
    expect(relationshipPortrait(axes).id).toStartWith("unknown-neutral-");
    axes.familiarity = 10;
    expect(relationshipPortrait(axes).id).toStartWith("familiar-neutral-");
  });

  test("keeps every registered variant reachable across combined band vectors", () => {
    const values = [-80, -45, -15, 0, 15, 45, 80];
    const registered = new Set(relationshipPortraitVariantIds());
    const seen = new Map<string, RelationshipPortrait>();
    let seed = 1;
    for (let index = 0; index < 2_000_000 && seen.size < registered.size; index += 1) {
      const axes = Object.fromEntries(RELATIONSHIP_AXES.map((axis) => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return [axis, values[seed % values.length] ?? 0];
      })) as ReturnType<typeof baseRelationshipAxes>;
      const portrait = relationshipPortrait(axes);
      seen.set(portrait.id, portrait);
    }
    expect(new Set(seen.keys())).toEqual(registered);
    const portraits = [...seen.values()];
    const wordCounts = portraits.map(({ prose }) => prose.trim().split(/\s+/u).length);
    const compactWordCounts = portraits
      .map(({ compactProse }) => compactProse.trim().split(/\s+/u).length);
    expect(Math.min(...wordCounts)).toBeGreaterThanOrEqual(90);
    expect(wordCounts.reduce((sum, count) => sum + count, 0) / wordCounts.length)
      .toBeGreaterThanOrEqual(110);
    expect(Math.min(...compactWordCounts)).toBeGreaterThanOrEqual(45);
  });
});
