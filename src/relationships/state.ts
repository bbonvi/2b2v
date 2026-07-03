import type { RelationshipAxes, RelationshipProfile } from "./types";

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
