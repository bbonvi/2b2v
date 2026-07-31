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

function compactProfileLine(entry: RelationshipContextProfile): string {
  const notes = entry.profile.notes.at(-1);
  const loop = entry.profile.openLoops.at(-1);
  const detail = notes ?? (loop !== undefined ? `open: ${loop}` : undefined);
  return `- ${entry.label}: ${joinPromptItems([
    `raw axes: ${renderRelationshipAxisValues(entry.profile)}`,
    shortPortrait(entry.profile),
    ...(detail !== undefined ? [detail] : []),
  ])}.`;
}

function fullProfileBlock(entry: RelationshipContextProfile): string {
  const notes = joinPromptItems(entry.profile.notes.slice(-4));
  const boundaries = joinPromptItems(entry.profile.boundaries.slice(-3));
  const loops = joinPromptItems(entry.profile.openLoops.slice(-3));
  const portrait = relationshipPortrait(entry.profile.axes);
  return [
    `### ${entry.label}`,
    `Raw durable axes: ${renderRelationshipAxisValues(entry.profile)}`,
    `Contextual portrait [${portrait.id}]: ${portrait.prose}`,
    notes !== "" ? `Notes: ${notes}.` : "",
    boundaries !== "" ? `Boundaries: ${boundaries}.` : "",
    loops !== "" ? `Open loops: ${loops}.` : "",
  ].filter((line) => line !== "").join("\n");
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
    input.full.length > 0 ? "Notable people:" : "",
    ...input.full.map(fullProfileBlock),
    input.compact.length > 0 ? "Other known people:" : "",
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
  const anchorProfiles = input.anchors !== undefined && input.anchors.length > 0
    ? ["Relationship anchors:", ...input.anchors.map(fullProfileBlock)].join("\n\n")
    : "";
  const otherProfiles = input.others !== undefined && input.others.length > 0
    ? ["Other relevant relationship profiles:", ...input.others.map(compactProfileLine)].join("\n")
    : "";
  if (!includeCurrent) {
    if (anchorProfiles === "" && otherProfiles === "") return "";
    return [
      "## Relationships",
      policy,
      anchorProfiles,
      otherProfiles,
    ].filter((line) => line !== "").join("\n\n");
  }
  const current = input.current;
  if (current === undefined || !hasRelationshipData(current)) {
    const emptyProfile = current;
    return [
      "## Relationships",
      policy,
      `Subject: ${input.currentLabel}.`,
      "Raw values and prose are private durable background. They do not require a visible reaction, relationship performance, or another maintenance update.",
      ...(emptyProfile === undefined
        ? ["No stored relationship profile yet."]
        : [
            `Raw durable axes: ${renderRelationshipAxisValues(emptyProfile)}`,
            `Contextual portrait [${relationshipPortrait(emptyProfile.axes).id}]: ${relationshipPortrait(emptyProfile.axes).prose}`,
            "No stored durable changes beyond the neutral defaults.",
          ]),
      input.priorExchanges ?? "",
      anchorProfiles !== "" ? `\n${anchorProfiles}` : "",
      otherProfiles !== "" ? `\n${otherProfiles}` : "",
    ].filter((line) => line !== "").join("\n");
  }
  const notes = joinPromptItems(current.notes.slice(-4));
  const boundaries = joinPromptItems(current.boundaries.slice(-3));
  const loops = joinPromptItems(current.openLoops.slice(-3));
  const portrait = relationshipPortrait(current.axes);
  return [
    "## Relationships",
    policy,
    `Subject: ${input.currentLabel}.`,
    "Raw values and prose are private durable background. They do not require a visible reaction, relationship performance, or another maintenance update.",
    `Raw durable axes: ${renderRelationshipAxisValues(current)}`,
    `Contextual portrait [${portrait.id}]: ${portrait.prose}`,
    notes !== "" ? `Notes: ${notes}.` : "",
    boundaries !== "" ? `Boundaries: ${boundaries}.` : "",
    loops !== "" ? `Open loops: ${loops}.` : "",
    input.priorExchanges ?? "",
    anchorProfiles !== "" ? `\n${anchorProfiles}` : "",
    otherProfiles !== "" ? `\n${otherProfiles}` : "",
  ].filter((line) => line !== "").join("\n");
}
