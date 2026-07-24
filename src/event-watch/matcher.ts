import type { Database } from "../db/database.ts";
import {
  listCandidateEventWatches,
  setEventWatchThresholdArmed,
  type EventWatchFire,
} from "../db/event-watch-repository.ts";
import { runRipgrep } from "../agent/ripgrep.ts";
import { formatLocalWallClock, parseLocalDateTimeToEpoch } from "../time/agent-time.ts";
import type {
  EventWatch,
  EventWatchPressure,
  NormalizedWatchEvent,
} from "./types.ts";
import { claimEventWatchFire } from "../db/event-watch-repository.ts";

export interface WatchMatcherMetrics {
  processCount: number;
  durationMs: number;
  candidateCount: number;
}

export interface WatchMatcher {
  match(event: NormalizedWatchEvent, signal?: AbortSignal): Promise<{
    watches: EventWatch[];
    metrics: WatchMatcherMetrics;
  }>;
  claim(watchIds: readonly string[], event: NormalizedWatchEvent): EventWatchFire[];
  validatePattern(pattern: string, signal?: AbortSignal): Promise<string | null>;
}

export function isWatchEligibleAfter(watch: EventWatch, at: number, timezone = watch.timezone): boolean {
  if (watch.after === undefined) return true;
  if (/^\d{2}:\d{2}$/.test(watch.after)) {
    return formatLocalWallClock(at, timezone).slice(11) >= watch.after;
  }
  const parsed = parseLocalDateTimeToEpoch(watch.after, timezone);
  return parsed.ok && at >= parsed.epochMs;
}

function matchesAtomicEvent(watch: EventWatch, event: NormalizedWatchEvent): boolean {
  if (watch.event.type !== event.type) return false;
  switch (event.type) {
    case "message": {
      if (watch.event.type !== "message") return false;
      if (event.authorIsSelf && watch.event.includeSelf !== true) return false;
      if (watch.event.assetKind !== undefined) {
        if (event.assetKinds.length === 0) return false;
        if (watch.event.assetKind !== "any" && !event.assetKinds.includes(watch.event.assetKind)) return false;
      }
      return true;
    }
    case "presence_transition":
      return watch.event.type === "presence_transition"
        && (watch.event.from === undefined || watch.event.from.includes(event.from))
        && watch.event.to.includes(event.to);
    case "presence_state":
      return watch.event.type === "presence_state" && watch.event.statuses.includes(event.status);
    case "voice":
      return watch.event.type === "voice"
        && watch.event.action === event.action
        && (watch.event.channelId === undefined
          || watch.event.channelId === event.channelId
          || watch.event.channelId === event.fromChannelId
          || watch.event.channelId === event.toChannelId);
    case "member":
      return watch.event.type === "member" && watch.event.action === event.action;
    case "reaction":
      if (watch.event.type === "reaction"
          && watch.event.countAtLeast !== undefined
          && event.count < watch.event.countAtLeast) {
        return false;
      }
      return watch.event.type === "reaction"
        && watch.event.action === event.action
        && (watch.event.messageId === undefined || watch.event.messageId === event.messageId)
        && (watch.event.emoji === undefined || watch.event.emoji === event.emoji)
        && (watch.event.countAtLeast === undefined || event.count >= watch.event.countAtLeast);
  }
}

async function regexMatches(pattern: string, text: string, signal: AbortSignal): Promise<boolean> {
  const output = await runRipgrep([
    "--text",
    "--color=never",
    "--quiet",
    "--regexp",
    pattern,
  ], text.replace(/[\r\n]+/g, " "), signal);
  return output !== null;
}

/** Match indexed watch candidates, using ripgrep only for remaining message patterns. */
export function createWatchMatcher(input: {
  db: Database;
  pressure: EventWatchPressure;
  getTimezone?: (guildId: string) => string;
  onMetrics?: (metrics: WatchMatcherMetrics, event: NormalizedWatchEvent) => void;
}): WatchMatcher {
  return {
    async match(event, signal): Promise<{ watches: EventWatch[]; metrics: WatchMatcherMetrics }> {
      const startedAt = performance.now();
      const abortSignal = signal ?? AbortSignal.timeout(30_000);
      const candidates = listCandidateEventWatches(input.db, event);
      const watches: EventWatch[] = [];
      let processCount = 0;
      for (const watch of candidates) {
        if (event.type === "reaction"
            && watch.event.type === "reaction"
            && watch.event.countAtLeast !== undefined
            && event.count < watch.event.countAtLeast) {
          setEventWatchThresholdArmed(input.db, watch.id, true);
          continue;
        }
        const timezone = input.getTimezone?.(event.guildId) ?? watch.timezone;
        if (!isWatchEligibleAfter(watch, event.at, timezone) || !matchesAtomicEvent(watch, event)) continue;
        if (event.type === "message" && watch.event.type === "message" && watch.event.pattern !== undefined) {
          processCount += 1;
          if (!await regexMatches(watch.event.pattern, event.content, abortSignal)) continue;
        }
        watches.push(watch);
      }
      const metrics = {
        processCount,
        durationMs: Math.round(performance.now() - startedAt),
        candidateCount: candidates.length,
      };
      input.onMetrics?.(metrics, event);
      return { watches, metrics };
    },

    claim(watchIds, event): EventWatchFire[] {
      const claimed: EventWatchFire[] = [];
      const allowed = new Set(watchIds);
      for (const watch of listCandidateEventWatches(input.db, event)) {
        if (!allowed.has(watch.id)) continue;
        const fire = claimEventWatchFire(input.db, watch, event, input.pressure);
        if (fire !== null) claimed.push(fire);
      }
      return claimed;
    },

    async validatePattern(pattern, signal): Promise<string | null> {
      try {
        await regexMatches(pattern, "", signal ?? AbortSignal.timeout(5_000));
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : "Invalid regex.";
      }
    },
  };
}
