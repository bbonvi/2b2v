import { formatRelativeAgo } from "../agent/history-dates";
import type { RelationshipAxis, RelationshipEvent, RelationshipProfile } from "./types";
import { RELATIONSHIP_AXES, relationshipEventAppliedAxes } from "./state";
import { relationshipPortrait } from "./portrait";

export interface RelationshipContextProfile {
  profile: RelationshipProfile;
  label: string;
  reason: "recent-chat" | "high-score" | "anchor";
  events?: readonly RelationshipEvent[];
}

const RELATIONSHIP_ANCHOR_MINIMUM_AXIS = 30;
const RECENT_MOVEMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_MOVEMENT_MINIMUM = 5;
const RECENT_MOVEMENT_MAX_CONTRIBUTORS = 3;
const MAINTENANCE_NOTE_LIMIT = 20;
const MAINTENANCE_BOUNDARY_LIMIT = 15;
const MAINTENANCE_OPEN_MATTER_LIMIT = 15;
const MAINTENANCE_EVENT_LIMIT = 15;

interface RecentMovementContributor {
  event: RelationshipEvent;
  axes: Array<{ axis: RelationshipAxis; delta: number }>;
  score: number;
}

interface RecentRelationshipMovement {
  updateCount: number;
  net: Array<{ axis: RelationshipAxis; delta: number }>;
  contributors: RecentMovementContributor[];
}

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

/** Apply the ordinary current-person, anchor, and recent-person relationship selection. */
export function selectRelationshipContextProfiles(input: {
  currentUserId: string;
  anchors: readonly RelationshipContextProfile[];
  recent: readonly RelationshipContextProfile[];
  recentLimit?: number;
}): { anchors: RelationshipContextProfile[]; recent: RelationshipContextProfile[] } {
  const anchorUserIds = new Set(input.anchors.map((entry) => entry.profile.userId));
  return {
    anchors: input.anchors.filter((entry) => entry.profile.userId !== input.currentUserId),
    recent: input.recent
      .filter((entry) => entry.profile.userId !== input.currentUserId)
      .filter((entry) => hasRelationshipData(entry.profile) && !anchorUserIds.has(entry.profile.userId))
      .slice(0, Math.max(0, input.recentLimit ?? 3)),
  };
}

function joinPromptItems(items: string[]): string {
  return items
    .map((item) => item.trim().replace(/[.;。；]+$/u, ""))
    .filter((item) => item !== "")
    .join("; ");
}

function roundedPromptNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function signedAxisChange(axis: RelationshipAxis, delta: number): string {
  const rounded = roundedPromptNumber(delta);
  return `${axis} ${rounded > 0 ? "+" : ""}${rounded}`;
}

/** Derive bounded notable movement from recent immutable relationship events. */
function recentRelationshipMovement(
  events: readonly RelationshipEvent[],
  now: number,
): RecentRelationshipMovement | null {
  const recent = events
    .filter((event) => event.at >= now - RECENT_MOVEMENT_WINDOW_MS && event.at <= now)
    .map((event) => ({
      event,
      axes: RELATIONSHIP_AXES.flatMap((axis) => {
        const delta = relationshipEventAppliedAxes(event)[axis];
        return delta !== undefined && Number.isFinite(delta) && delta !== 0
          ? [{ axis, delta }]
          : [];
      }),
    }))
    .filter((entry) => entry.axes.length > 0);
  if (recent.length === 0) return null;

  const totals = new Map<RelationshipAxis, number>();
  for (const entry of recent) {
    for (const { axis, delta } of entry.axes) {
      totals.set(axis, (totals.get(axis) ?? 0) + delta);
    }
  }
  const net = RELATIONSHIP_AXES
    .flatMap((axis) => {
      const delta = roundedPromptNumber(totals.get(axis) ?? 0);
      return Math.abs(delta) >= RECENT_MOVEMENT_MINIMUM ? [{ axis, delta }] : [];
    });
  if (net.length === 0) return null;

  const notableAxes = new Set(net.map(({ axis }) => axis));
  const contributors = recent
    .map(({ event, axes }) => {
      const relevantAxes = axes.filter(({ axis }) => notableAxes.has(axis));
      return {
        event,
        axes: relevantAxes,
        score: relevantAxes.reduce((sum, { delta }) => sum + Math.abs(delta), 0),
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      const scoreDifference = right.score - left.score;
      return scoreDifference !== 0 ? scoreDifference : right.event.at - left.event.at;
    })
    .slice(0, RECENT_MOVEMENT_MAX_CONTRIBUTORS);

  return { updateCount: recent.length, net, contributors };
}

function renderRecentRelationshipMovement(
  events: readonly RelationshipEvent[],
  now: number,
  subject: string,
  detailed: boolean,
): string {
  const movement = recentRelationshipMovement(events, now);
  if (movement === null) return "";
  const net = movement.net.map(({ axis, delta }) => signedAxisChange(axis, delta)).join(", ");
  if (!detailed) return `Recent notable movement for ${subject} (last 7 days): ${net}.`;
  const updates = movement.updateCount === 1 ? "update" : "updates";
  return [
    `Recent notable movement for ${subject} (last 7 days):`,
    `Across ${movement.updateCount} recorded ${updates}: ${net}.`,
    "Largest recorded changes:",
    ...movement.contributors.map(({ event, axes }) =>
      `- ${formatRelativeAgo(event.at, now)}: ${axes.map(({ axis, delta }) => signedAxisChange(axis, delta)).join(", ")}. Recorded interpretation: ${JSON.stringify(event.summary.trim().slice(0, 300))}`
    ),
    // This prevents old maintenance judgments from becoming a fresh reaction mandate.
    "These are prior maintenance interpretations, not facts or a demand to repeat an old reaction. Current durable values remain authoritative. If present evidence clearly resolves their basis, let that repair matter now; durable state can catch up separately.",
  ].join("\n");
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

/** Render detailed current-user state and compact context for a few other relevant people. */
export function renderRelationshipMaintenanceContext(input: {
  current: {
    profile: RelationshipProfile;
    label: string;
    events?: readonly RelationshipEvent[];
  };
  others?: readonly RelationshipContextProfile[];
}): string {
  const { profile, label, events = [] } = input.current;
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
    .slice(0, MAINTENANCE_EVENT_LIMIT);
  return [
    "## Current Relationship State",
    "Values are rounded durable starting points. Quoted boundary and open-matter text must be copied exactly for removal or closure.",
    [
      "### Current person",
      label,
      `Raw durable axes: ${renderRelationshipAxisValues(profile)}`,
      exactList("Active notes", profile.notes.slice(-MAINTENANCE_NOTE_LIMIT)),
      exactList("Active boundaries", profile.boundaries.slice(-MAINTENANCE_BOUNDARY_LIMIT)),
      exactList("Open matters", profile.openLoops.slice(-MAINTENANCE_OPEN_MATTER_LIMIT)),
      ...(changes.length === 0 ? [] : ["Recent applied axis changes:", ...changes]),
    ].join("\n"),
    ...(input.others === undefined || input.others.length === 0
      ? []
      : [
          "### Other relevant people",
          ...input.others.map((entry) =>
            `- ${entry.label} — ${shortPortrait(entry.profile)}; private values: ${renderRelationshipAxisValues(entry.profile)}.`
          ),
        ]),
  ].join("\n\n");
}

function shortPortrait(profile: RelationshipProfile): string {
  return relationshipPortrait(profile.axes).compactProse;
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

function compactProfileLine(
  entry: RelationshipContextProfile,
  now?: number,
  detailedMovement = false,
): string {
  const notes = entry.profile.notes.at(-1);
  const loop = entry.profile.openLoops.at(-1);
  const detail = notes ?? (loop !== undefined ? `unresolved: ${loop}` : undefined);
  const profile = `- ${entry.label} — ${joinPromptItems([
    shortPortrait(entry.profile),
    `private values: ${renderRelationshipAxisValues(entry.profile)}`,
    ...(detail !== undefined ? [detail] : []),
  ])}.`;
  if (now === undefined || entry.events === undefined) return profile;
  const movement = renderRecentRelationshipMovement(entry.events, now, entry.label, detailedMovement);
  return movement === "" ? profile : `${profile}\n${movement}`;
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

function currentProfileBlock(
  profile: RelationshipProfile | undefined,
  label: string,
  events: readonly RelationshipEvent[],
  now: number,
): string {
  if (profile === undefined) {
    return [
      "### Current person",
      label,
      "No stored relationship profile yet.",
    ].join("\n\n");
  }
  const portrait = relationshipPortrait(profile.axes);
  const details = durableDetailLines(profile);
  return [
    "### Current person",
    label,
    "How this relationship sits with you:",
    portrait.prose,
    "Private reference values:",
    renderRelationshipAxisValues(profile),
    ...(details.length > 0 ? ["Durable details:", ...details] : []),
    renderRecentRelationshipMovement(events, now, "this relationship", true),
    !hasRelationshipData(profile) ? "No durable relationship changes are stored yet." : "",
  ].filter((line) => line !== "").join("\n\n");
}

function otherPeopleBlock(
  anchors: readonly RelationshipContextProfile[],
  others: readonly RelationshipContextProfile[],
  now?: number,
): string {
  if (anchors.length === 0 && others.length === 0) return "";
  return [
    "### Other relevant people",
    anchors.length > 0 ? "#### People with lasting weight" : "",
    ...anchors.map((entry, index) => compactProfileLine(entry, now, index === 0)),
    others.length > 0 ? "#### Others present or recently active" : "",
    ...others.map((entry) => compactProfileLine(entry, now)),
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
    ...input.compact.map((entry) => compactProfileLine(entry)),
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
  currentEvents?: readonly RelationshipEvent[];
  now?: number;
}): string {
  const policy = input.template !== undefined && input.template.trim() !== ""
    ? stripHeading(input.template)
    : "Relationship state is private durable context. Use it quietly as background stance.";
  const includeCurrent = input.includeCurrent ?? true;
  const now = input.now ?? Date.now();
  const otherPeople = otherPeopleBlock(input.anchors ?? [], input.others ?? [], now);
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
    currentProfileBlock(input.current, input.currentLabel, input.currentEvents ?? [], now),
    input.priorExchanges ?? "",
    otherPeople,
  ].filter((line) => line !== "").join("\n\n");
}
