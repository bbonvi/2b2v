import type { RelationshipProfile } from "./types";

export interface RelationshipContextProfile {
  profile: RelationshipProfile;
  label: string;
  reason: "recent-chat" | "high-score";
}

function stripHeading(text: string): string {
  return text.trim().replace(/^#{1,6}\s+[^\n]*\n+/, "").trim();
}

function hasRelationshipData(profile: RelationshipProfile): boolean {
  return Object.values(profile.axes).some((value) => value !== 0)
    || profile.notes.length > 0
    || profile.boundaries.length > 0
    || profile.openLoops.length > 0
    || profile.recent.length > 0;
}

function axesLine(profile: RelationshipProfile): string {
  const axes = Object.entries(profile.axes)
    .filter(([, value]) => Math.abs(value) >= 5)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 6)
    .map(([axis, value]) => `${axis} ${value > 0 ? "+" : ""}${value}`)
    .join(", ");
  return axes !== "" ? axes : "light/neutral";
}

function compactProfileLine(entry: RelationshipContextProfile): string {
  const notes = entry.profile.notes.at(-1);
  const loop = entry.profile.openLoops.at(-1);
  const suffix = notes !== undefined ? `; ${notes}` : loop !== undefined ? `; open: ${loop}` : "";
  return `- ${entry.label}: ${axesLine(entry.profile)}${suffix}`;
}

export function renderRelationshipPromptContext(input: {
  current: RelationshipProfile | undefined;
  currentLabel: string;
  computedContact?: string;
  others?: RelationshipContextProfile[];
  template?: string;
}): string {
  const policy = input.template !== undefined && input.template.trim() !== ""
    ? stripHeading(input.template)
    : "Relationship state is private durable context. Use it quietly as background stance.";
  const current = input.current;
  if (current === undefined || !hasRelationshipData(current)) {
    return [
      "## Relationship With Current User",
      policy,
      `Subject: ${input.currentLabel}.`,
      "This is 2B's stored relationship stance toward this user.",
      input.computedContact !== undefined ? `Computed contact: ${input.computedContact}` : "",
      "No stored relationship profile yet.",
      input.others !== undefined && input.others.length > 0
        ? ["", "Other relevant relationship profiles:", ...input.others.map(compactProfileLine)].join("\n")
        : "",
    ].filter((line) => line !== "").join("\n");
  }
  const notes = current.notes.slice(-4).join("; ");
  const loops = current.openLoops.slice(-3).join("; ");
  const recent = current.recent.slice(-3).map((item) => item.summary).join("; ");
  return [
    "## Relationship With Current User",
    policy,
    `Subject: ${input.currentLabel}.`,
    "This is 2B's stored relationship stance toward this user.",
    input.computedContact !== undefined ? `Computed contact: ${input.computedContact}` : "",
    `Axes: ${axesLine(current)}.`,
    notes !== "" ? `Notes: ${notes}.` : "",
    loops !== "" ? `Open loops: ${loops}.` : "",
    recent !== "" ? `Recent signals: ${recent}.` : "",
    input.others !== undefined && input.others.length > 0
      ? ["", "Other relevant relationship profiles:", ...input.others.map(compactProfileLine)].join("\n")
      : "",
  ].filter((line) => line !== "").join("\n");
}
