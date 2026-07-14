import type { RelationshipAxis, RelationshipProfile } from "./types";

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

function sentenceList(parts: string[]): string {
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1) ?? ""}`;
}

function joinPromptItems(items: string[]): string {
  return items
    .map((item) => item.trim().replace(/[.;。；]+$/u, ""))
    .filter((item) => item !== "")
    .join("; ");
}

function axisPhrase(axis: RelationshipAxis, value: number): string | undefined {
  const magnitude = Math.abs(value);
  const minimumMagnitude = axis === "warmth" || axis === "curiosity" || axis === "attraction" ? 2 : 5;
  if (magnitude < minimumMagnitude) return undefined;
  const level = magnitude >= 30 ? 2 : magnitude >= 12 ? 1 : 0;
  const positive = value > 0;
  const phrases: Record<RelationshipAxis, { positive: [string, string, string]; negative: [string, string, string] }> = {
    familiarity: {
      positive: ["recognizes them", "is familiar with them", "knows them well"],
      negative: ["has little stable familiarity with them", "does not know them well", "treats them as unfamiliar"],
    },
    trust: {
      positive: ["has some trust in them", "trusts them", "trusts them deeply"],
      negative: ["is cautious about trusting them", "does not fully trust them", "strongly distrusts them"],
    },
    warmth: {
      positive: ["has some warmth toward them", "feels warm toward them", "feels openly warm toward them"],
      negative: ["feels somewhat cool toward them", "keeps them at an emotional distance", "feels cold toward them"],
    },
    respect: {
      positive: ["has some respect for them", "respects them", "respects them strongly"],
      negative: ["has reservations about them", "does not fully respect them", "has strong respect concerns about them"],
    },
    tension: {
      positive: ["feels slight tension with them", "feels tension with them", "feels strong tension with them"],
      negative: ["feels fairly at ease with them", "feels at ease with them", "feels very at ease with them"],
    },
    curiosity: {
      positive: ["is a little curious about them", "wants to understand them better", "is strongly interested in understanding them"],
      negative: ["is not especially curious about them", "has little interest in understanding them further", "actively avoids investing curiosity in them"],
    },
    attraction: {
      positive: ["notices a faint private pull toward them", "feels privately drawn to them", "feels strongly drawn to them"],
      negative: ["does not feel personally drawn to them", "feels no personal pull toward them", "strongly avoids personal pull toward them"],
    },
    intimacy: {
      positive: ["is slightly more personally open with them", "is comfortable being more personally open with them", "is highly comfortable with personal closeness"],
      negative: ["keeps some personal distance", "keeps clear personal distance", "keeps strong personal distance"],
    },
    attachment: {
      positive: ["has a little attachment to them", "feels attached to them", "feels strongly attached to them"],
      negative: ["is not attached to them", "feels little attachment to them", "feels detached from them"],
    },
  };
  return phrases[axis][positive ? "positive" : "negative"][level];
}

function relationshipStance(profile: RelationshipProfile): string {
  const phrases = (Object.entries(profile.axes) as Array<[RelationshipAxis, number]>)
    .map(([axis, value]) => ({ phrase: axisPhrase(axis, value), value }))
    .filter((entry): entry is { phrase: string; value: number } => entry.phrase !== undefined)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 6)
    .map((entry) => entry.phrase);
  return phrases.length > 0
    ? `The persona ${sentenceList(phrases)}.`
    : "The persona has no strong stored feeling toward this user yet.";
}

function compactProfileLine(entry: RelationshipContextProfile): string {
  const notes = entry.profile.notes.at(-1);
  const loop = entry.profile.openLoops.at(-1);
  const detail = notes ?? (loop !== undefined ? `open: ${loop}` : undefined);
  return `- ${entry.label}: ${joinPromptItems([
    relationshipStance(entry.profile),
    ...(detail !== undefined ? [detail] : []),
  ])}.`;
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
      "This is your stored relationship stance toward this user.",
      input.computedContact !== undefined ? `Computed contact: ${input.computedContact}` : "",
      "No stored relationship profile yet.",
      input.others !== undefined && input.others.length > 0
        ? ["", "Other relevant relationship profiles:", ...input.others.map(compactProfileLine)].join("\n")
        : "",
    ].filter((line) => line !== "").join("\n");
  }
  const notes = joinPromptItems(current.notes.slice(-4));
  const boundaries = joinPromptItems(current.boundaries.slice(-3));
  const loops = joinPromptItems(current.openLoops.slice(-3));
  const recent = joinPromptItems(current.recent.slice(-3).map((item) => item.summary));
  return [
    "## Relationship With Current User",
    policy,
    `Subject: ${input.currentLabel}.`,
    "This is your stored relationship stance toward this user.",
    input.computedContact !== undefined ? `Computed contact: ${input.computedContact}` : "",
    `Relationship stance: ${relationshipStance(current)}`,
    notes !== "" ? `Notes: ${notes}.` : "",
    boundaries !== "" ? `Boundaries: ${boundaries}.` : "",
    loops !== "" ? `Open loops: ${loops}.` : "",
    recent !== "" ? `Recent signals: ${recent}.` : "",
    input.others !== undefined && input.others.length > 0
      ? ["", "Other relevant relationship profiles:", ...input.others.map(compactProfileLine)].join("\n")
      : "",
  ].filter((line) => line !== "").join("\n");
}
