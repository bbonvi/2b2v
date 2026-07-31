import type { RelationshipEvent, RelationshipProfile } from "./types";
import { RELATIONSHIP_AXES, relationshipEventAppliedAxes } from "./state";
import { relationshipPortrait } from "./portrait";

export interface RelationshipContextProfile {
  profile: RelationshipProfile;
  label: string;
  reason: "recent-chat" | "high-score" | "anchor";
}

const RELATIONSHIP_ANCHOR_MINIMUM_AXIS = 30;

function stripHeading(text: string): string {
  return text.trim().replace(/^#{1,6}\s+[^\n]*\n+/, "").trim();
}

/** Report whether a relationship profile contains prompt-relevant state. */
export function hasRelationshipData(profile: RelationshipProfile): boolean {
  return Object.values(profile.axes).some((value) => value !== 0)
    || profile.notes.length > 0
    || profile.boundaries.length > 0
    || profile.openLoops.length > 0
    || profile.recent.length > 0;
}

/** Select the strongest durable relationships, including negative and contradictory ones. */
export function selectRelationshipAnchorProfiles(
  profiles: readonly RelationshipProfile[],
  limit = 2,
): RelationshipProfile[] {
  return profiles
    .map((profile) => {
      const magnitudes = RELATIONSHIP_AXES.map((axis) => Math.abs(profile.axes[axis]));
      return {
        profile,
        peak: Math.max(...magnitudes),
        score: magnitudes.reduce((sum, value) => sum + value, 0),
      };
    })
    .filter((entry) => entry.peak >= RELATIONSHIP_ANCHOR_MINIMUM_AXIS)
    .sort((a, b) => {
      const scoreDifference = b.score - a.score;
      if (scoreDifference !== 0) return scoreDifference;
      const peakDifference = b.peak - a.peak;
      return peakDifference !== 0 ? peakDifference : b.profile.updatedAt - a.profile.updatedAt;
    })
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.profile);
}

function joinPromptItems(items: string[]): string {
  return items
    .map((item) => item.trim().replace(/[.;。；]+$/u, ""))
    .filter((item) => item !== "")
    .join("; ");
}

/** Render compact rounded axis values for model context. */
export function renderRelationshipAxisValues(profile: RelationshipProfile): string {
  return RELATIONSHIP_AXES
    .map((axis) => `${axis}=${Math.round(profile.axes[axis] * 100) / 100}`)
    .join(", ");
}

function exactList(label: string, values: readonly string[]): string {
  return values.length === 0
    ? `${label}: none`
    : `${label}:\n${values.map((value) => `- ${JSON.stringify(value)}`).join("\n")}`;
}

/** Render complete mutable state and bounded audit evidence for relationship maintenance. */
export function renderRelationshipMaintenanceContext(input: Array<{
  profile: RelationshipProfile;
  label: string;
  events?: readonly RelationshipEvent[];
}>): string {
  return [
    "## Current Relationship State",
    "Values are rounded durable starting points. Quoted boundary and open-matter text must be copied exactly for removal or closure.",
    ...input.map(({ profile, label, events = [] }) => {
      const changes = events
        .map((event) => {
          const axes = relationshipEventAppliedAxes(event);
          const rendered = RELATIONSHIP_AXES
            .filter((axis) => axes[axis] !== undefined && axes[axis] !== 0)
            .map((axis) => `${axis}=${axes[axis]}`)
            .join(", ");
          return rendered === "" ? "" : `- ${event.id}: ${rendered}; ${event.summary}`;
        })
        .filter((line) => line !== "")
        .slice(0, 8);
      return [
        `### ${label}`,
        `Raw durable axes: ${renderRelationshipAxisValues(profile)}`,
        exactList("Active notes", profile.notes),
        exactList("Active boundaries", profile.boundaries),
        exactList("Open matters", profile.openLoops),
        ...(changes.length === 0 ? [] : ["Recent applied axis changes:", ...changes]),
      ].join("\n");
    }),
  ].join("\n\n");
}

function shortPortrait(profile: RelationshipProfile): string {
  const prose = relationshipPortrait(profile.axes).prose;
  return prose.match(/^[^.!?]+[.!?]/u)?.[0] ?? prose;
}

function durableDetailLines(profile: RelationshipProfile): string[] {
  const notes = joinPromptItems(profile.notes.slice(-4));
  const boundaries = joinPromptItems(profile.boundaries.slice(-3));
  const loops = joinPromptItems(profile.openLoops.slice(-3));
  return [
    notes !== "" ? `- Notes: ${notes}.` : "",
    boundaries !== "" ? `- Specific boundaries: ${boundaries}.` : "",
    loops !== "" ? `- Unresolved matters: ${loops}.` : "",
  ].filter((line) => line !== "");
}

function compactProfileLine(entry: RelationshipContextProfile): string {
  const notes = entry.profile.notes.at(-1);
  const loop = entry.profile.openLoops.at(-1);
  const detail = notes ?? (loop !== undefined ? `unresolved: ${loop}` : undefined);
  return `- ${entry.label} — ${joinPromptItems([
    shortPortrait(entry.profile),
    `private values: ${renderRelationshipAxisValues(entry.profile)}`,
    ...(detail !== undefined ? [detail] : []),
  ])}.`;
}

function fullProfileBlock(entry: RelationshipContextProfile): string {
  const portrait = relationshipPortrait(entry.profile.axes);
  const details = durableDetailLines(entry.profile);
  return [
    `#### ${entry.label}`,
    "How this relationship sits with you:",
    portrait.prose,
    "Private reference values:",
    renderRelationshipAxisValues(entry.profile),
    ...(details.length > 0 ? ["Durable details:", ...details] : []),
  ].filter((line) => line !== "").join("\n");
}

function currentProfileBlock(profile: RelationshipProfile | undefined, label: string): string {
  if (profile === undefined) {
    return [
      "---",
      "### Current person",
      label,
      "No stored relationship profile yet.",
    ].join("\n\n");
  }
  const portrait = relationshipPortrait(profile.axes);
  const details = durableDetailLines(profile);
  return [
    "---",
    "### Current person",
    label,
    "How this relationship sits with you:",
    portrait.prose,
    "Private reference values:",
    renderRelationshipAxisValues(profile),
    ...(details.length > 0 ? ["Durable details:", ...details] : []),
    !hasRelationshipData(profile) ? "No durable relationship changes are stored yet." : "",
  ].filter((line) => line !== "").join("\n\n");
}

function otherPeopleBlock(
  anchors: readonly RelationshipContextProfile[],
  others: readonly RelationshipContextProfile[],
): string {
  if (anchors.length === 0 && others.length === 0) return "";
  return [
    "---",
    "### Other relevant people",
    anchors.length > 0 ? "#### People with lasting weight" : "",
    ...anchors.map(compactProfileLine),
    others.length > 0 ? "#### Others present or recently active" : "",
    ...others.map(compactProfileLine),
  ].filter((line) => line !== "").join("\n\n");
}

/** Render notable people for private-life turns without pretending the bot is the current subject. */
export function renderNotableRelationshipsContext(input: {
  full: RelationshipContextProfile[];
  compact: RelationshipContextProfile[];
  template?: string;
}): string {
  if (input.full.length === 0 && input.compact.length === 0) return "";
  const policy = input.template !== undefined && input.template.trim() !== ""
    ? stripHeading(input.template)
    : "Relationship state is private durable context. Use it quietly as background stance.";
  return [
    "## Relationships",
    policy,
    "---",
    input.full.length > 0 ? "### People with lasting weight" : "",
    ...input.full.map(fullProfileBlock),
    input.compact.length > 0 ? "### Other known people" : "",
    ...input.compact.map(compactProfileLine),
  ].filter((line) => line !== "").join("\n\n");
}

export function renderRelationshipPromptContext(input: {
  current: RelationshipProfile | undefined;
  currentLabel: string;
  anchors?: RelationshipContextProfile[];
  others?: RelationshipContextProfile[];
  priorExchanges?: string;
  template?: string;
  includeCurrent?: boolean;
}): string {
  const policy = input.template !== undefined && input.template.trim() !== ""
    ? stripHeading(input.template)
    : "Relationship state is private durable context. Use it quietly as background stance.";
  const includeCurrent = input.includeCurrent ?? true;
  const otherPeople = otherPeopleBlock(input.anchors ?? [], input.others ?? []);
  if (!includeCurrent) {
    if (otherPeople === "") return "";
    return [
      "## Relationships",
      policy,
      otherPeople,
    ].filter((line) => line !== "").join("\n\n");
  }
  return [
    "## Relationships",
    policy,
    currentProfileBlock(input.current, input.currentLabel),
    input.priorExchanges ?? "",
    otherPeople,
  ].filter((line) => line !== "").join("\n\n");
}
