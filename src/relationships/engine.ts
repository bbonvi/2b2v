import type { Database } from "../db/database";
import type { RelationshipConfig, RelationshipProfile, RelationshipScope, RelationshipSignalInput } from "./types";
import { RELATIONSHIP_AXES } from "./state";
import { appendRelationshipEvent, getRelationshipProfile, saveRelationshipProfile } from "./repository";

export interface RelationshipMutationResult {
  profiles: RelationshipProfile[];
  accepted: RelationshipSignalInput[];
  rejected: Array<{ signal: RelationshipSignalInput; reason: string }>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cleanText(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed !== "" ? trimmed : undefined;
}

function withUniqueTail(values: string[], value: string | undefined, max: number): string[] {
  if (value === undefined) return values;
  return [...new Set([...values, value])].slice(-max);
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

    const existing = profiles.get(userId) ?? getRelationshipProfile(db, userId);
    const axes = { ...existing.axes };
    for (const axis of RELATIONSHIP_AXES) {
      const delta = signal.axes?.[axis];
      if (delta !== undefined && Number.isFinite(delta)) {
        axes[axis] = clamp(
          axes[axis] + clamp(delta, -config.maxAxisDeltaPerSignal, config.maxAxisDeltaPerSignal),
          -100,
          100,
        );
      }
    }

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
          scope: { ...input.scope, userId },
          summary: signal.summary,
          payload: {
            axes: signal.axes ?? {},
            note: signal.note,
            boundary: signal.boundary,
            openLoop: signal.openLoop,
            confidence: signal.confidence,
          },
        }, now);

    const profile: RelationshipProfile = {
      ...existing,
      axes,
      notes: withUniqueTail(existing.notes, cleanText(signal.note), 30),
      boundaries: withUniqueTail(existing.boundaries, cleanText(signal.boundary), 20),
      openLoops: withUniqueTail(existing.openLoops, cleanText(signal.openLoop), 20),
      recent: [...existing.recent, {
        id: event.id,
        at: event.at,
        summary: signal.summary,
        visibility: event.visibility,
        scope: input.scope,
      }].slice(-30),
      updatedAt: now,
    };
    profiles.set(userId, profile);
    if (input.dryRun !== true) saveRelationshipProfile(db, profile);
    accepted.push(signal);
  }

  return { profiles: [...profiles.values()], accepted, rejected };
}
