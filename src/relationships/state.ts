import type { RelationshipAxes, RelationshipEvent, RelationshipProfile } from "./types";

export const RELATIONSHIP_AXES = [
  "familiarity",
  "trust",
  "warmth",
  "respect",
  "tension",
  "curiosity",
  "attraction",
  "intimacy",
  "attachment",
] as const;

export const RELATIONSHIP_VISIBILITIES = ["source-bound", "relationship-private", "private-internal"] as const;

/** Read applied axis movement from current events and legacy pre-window events. */
export function relationshipEventAppliedAxes(event: RelationshipEvent): Partial<RelationshipAxes> {
  const current = event.payload.appliedAxes;
  if (current !== null && typeof current === "object" && !Array.isArray(current)) {
    return current;
  }
  const legacy = event.payload.axes;
  return legacy !== null && typeof legacy === "object" && !Array.isArray(legacy)
    ? legacy
    : {};
}

export function baseRelationshipAxes(): RelationshipAxes {
  return Object.fromEntries(RELATIONSHIP_AXES.map((axis) => [axis, 0])) as RelationshipAxes;
}

export function emptyRelationshipProfile(userId: string, now = Date.now()): RelationshipProfile {
  return {
    userId,
    axes: baseRelationshipAxes(),
    notes: [],
    boundaries: [],
    openLoops: [],
    recent: [],
    updatedAt: Math.floor(now),
  };
}
