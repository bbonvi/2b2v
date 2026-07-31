import type { Database } from "../db/database";
import type {
  RelationshipAxes,
  RelationshipAxis,
  RelationshipConfig,
  RelationshipEvent,
  RelationshipProfile,
  RelationshipScope,
  RelationshipSignalInput,
} from "./types";
import { RELATIONSHIP_AXES, relationshipEventAppliedAxes } from "./state";
import {
  appendRelationshipEvent,
  getRelationshipProfile,
  listRelationshipEvents,
  saveRelationshipProfile,
} from "./repository";

export interface RelationshipMutationResult {
  profiles: RelationshipProfile[];
  accepted: RelationshipSignalInput[];
  rejected: Array<{ signal: RelationshipSignalInput; reason: string }>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundAxis(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function cleanText(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed !== "" ? trimmed : undefined;
}

function withUniqueTail(values: string[], value: string | undefined, max: number): string[] {
  if (value === undefined) return values;
  return [...values.filter((existing) => existing !== value), value].slice(-max);
}

function withoutExact(values: string[], value: string | undefined): string[] {
  return value === undefined ? values : values.filter((existing) => existing !== value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface DeltaWindow {
  minimum: number;
  maximum: number;
}

/** Return the evidence floor and per-pass movement cap for one LLM axis update. */
export function relationshipDeltaWindow(axis: RelationshipAxis, startingValue: number): DeltaWindow {
  const magnitude = Math.abs(startingValue);
  const minimum = axis === "familiarity"
    ? 0.1
    : magnitude < 20
      ? 0.1
      : magnitude < 40
        ? 0.2
        : magnitude < 60
          ? 0.5
          : magnitude < 80
            ? 1
            : 2;
  const maximum = magnitude < 20
    ? 10
    : magnitude < 40
      ? 20
      : magnitude < 60
        ? 40
        : magnitude < 80
          ? 80
          : 200;
  return { minimum, maximum };
}

function repairCapacity(
  events: readonly RelationshipEvent[],
  axis: RelationshipAxis,
  direction: number,
): number {
  let laterRecovery = 0;
  let remainingOpposingMovement = 0;
  for (const event of events) {
    const delta = relationshipEventAppliedAxes(event)[axis];
    if (delta === undefined || delta === 0 || !Number.isFinite(delta)) continue;
    if (Math.sign(delta) === direction) {
      laterRecovery += Math.abs(delta);
      continue;
    }
    const offset = Math.min(laterRecovery, Math.abs(delta));
    laterRecovery -= offset;
    remainingOpposingMovement += Math.abs(delta) - offset;
  }
  return remainingOpposingMovement;
}

function recentProfileEvents(db: Database, profile: RelationshipProfile): RelationshipEvent[] {
  const ids = new Set(profile.recent.map((moment) => moment.id));
  if (ids.size === 0) return [];
  return listRelationshipEvents(db, { userId: profile.userId, limit: 100 })
    .filter((event) => ids.has(event.id));
}

export function applyRelationshipSignals(
  db: Database,
  config: RelationshipConfig,
  input: {
    signals: RelationshipSignalInput[];
    source: "llm" | "admin" | "system";
    scope?: RelationshipScope;
    now?: number;
    dryRun?: boolean;
  },
): RelationshipMutationResult {
  const now = Math.floor(input.now ?? Date.now());
  const profiles = new Map<string, RelationshipProfile>();
  const startingProfiles = new Map<string, RelationshipProfile>();
  const spentByUser = new Map<string, RelationshipAxes>();
  const recentEventsByUser = new Map<string, RelationshipEvent[]>();
  const accepted: RelationshipSignalInput[] = [];
  const rejected: Array<{ signal: RelationshipSignalInput; reason: string }> = [];

  for (const signal of input.signals) {
    const userId = cleanText(signal.userId) ?? input.scope?.userId;
    if (userId === undefined) {
      rejected.push({ signal, reason: "missing userId" });
      continue;
    }
    if (signal.confidence < 0.5) {
      rejected.push({ signal, reason: "confidence below floor" });
      continue;
    }

    let starting = startingProfiles.get(userId);
    if (starting === undefined) {
      starting = getRelationshipProfile(db, userId);
      startingProfiles.set(userId, starting);
      spentByUser.set(userId, Object.fromEntries(RELATIONSHIP_AXES.map((axis) => [axis, 0])) as RelationshipAxes);
      recentEventsByUser.set(userId, recentProfileEvents(db, starting));
    }
    const existing = profiles.get(userId) ?? starting;
    const spent = spentByUser.get(userId);
    if (spent === undefined) throw new Error(`Missing relationship delta budget for ${userId}.`);
    const axes = { ...existing.axes };
    const requestedAxes: Partial<RelationshipAxes> = {};
    const appliedAxes: Partial<RelationshipAxes> = {};
    for (const axis of RELATIONSHIP_AXES) {
      const requested = signal.axes?.[axis];
      if (requested === undefined || !Number.isFinite(requested)) continue;
      requestedAxes[axis] = requested;
      let limited = requested;
      if (input.source === "llm") {
        const window = relationshipDeltaWindow(axis, starting.axes[axis]);
        if (Math.abs(requested) < window.minimum) {
          appliedAxes[axis] = 0;
          continue;
        }
        const repairMaximum = signal.repair === true
          ? repairCapacity(recentEventsByUser.get(userId) ?? [], axis, Math.sign(requested))
          : 0;
        const passMaximum = Math.max(window.maximum, repairMaximum);
        const remaining = Math.max(0, passMaximum - spent[axis]);
        limited = Math.sign(requested) * Math.min(
          Math.abs(requested),
          config.maxAxisDeltaPerSignal,
          remaining,
        );
        spent[axis] += Math.abs(limited);
      }
      const next = roundAxis(clamp(axes[axis] + limited, -100, 100));
      appliedAxes[axis] = roundAxis(next - axes[axis]);
      axes[axis] = next;
    }

    const note = withUniqueTail(existing.notes, cleanText(signal.note), 30);
    const boundaries = withUniqueTail(
      withoutExact(existing.boundaries, cleanText(signal.removeBoundary)),
      cleanText(signal.boundary),
      20,
    );
    const openLoops = withUniqueTail(
      withoutExact(existing.openLoops, cleanText(signal.closeOpenLoop)),
      cleanText(signal.openLoop),
      20,
    );
    const axesChanged = RELATIONSHIP_AXES.some((axis) => axes[axis] !== existing.axes[axis]);
    const profileChanged = axesChanged
      || !sameStrings(note, existing.notes)
      || !sameStrings(boundaries, existing.boundaries)
      || !sameStrings(openLoops, existing.openLoops);
    const scoped = { ...input.scope, userId };
    const event = input.dryRun === true
      ? {
          id: crypto.randomUUID(),
          at: now,
          visibility: signal.visibility ?? "relationship-private",
        }
      : appendRelationshipEvent(db, {
          at: now,
          source: input.source,
          visibility: signal.visibility ?? "relationship-private",
          scope: scoped,
          summary: signal.summary,
          payload: {
            requestedAxes,
            appliedAxes,
            repair: signal.repair,
            note: signal.note,
            boundary: signal.boundary,
            removeBoundary: signal.removeBoundary,
            openLoop: signal.openLoop,
            closeOpenLoop: signal.closeOpenLoop,
            confidence: signal.confidence,
          },
        }, now);

    if (profileChanged) {
      const profile: RelationshipProfile = {
        ...existing,
        axes,
        notes: note,
        boundaries,
        openLoops,
        recent: [...existing.recent, {
          id: event.id,
          at: event.at,
          summary: signal.summary,
          visibility: event.visibility,
          scope: scoped,
        }].slice(-30),
        updatedAt: now,
      };
      profiles.set(userId, profile);
      if (input.dryRun !== true) saveRelationshipProfile(db, profile);
    }
    accepted.push(signal);
  }

  return { profiles: [...profiles.values()], accepted, rejected };
}
