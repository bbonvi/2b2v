import type { Database } from "../db/database.ts";
import {
  getEventWatch,
  eventWatchFirePressureAllowsExecution,
  listPendingEventWatchFires,
  markWatchMessageProcessed,
  updateEventWatchFireState,
  type EventWatchFire,
} from "../db/event-watch-repository.ts";
import type { Logger } from "../logger.ts";
import type {
  EventWatch,
  EventWatchPressure,
  NormalizedWatchEvent,
} from "./types.ts";
import type { WatchMatcher } from "./matcher.ts";
import type { TriggerResult } from "../agent/triggers.ts";

export interface EventWatchTurn {
  watches: EventWatch[];
  fires: EventWatchFire[];
  event: NormalizedWatchEvent;
  ordinaryTrigger?: NonNullable<TriggerResult>;
  sourceMessage?: unknown;
}

export interface EventWatchRuntime {
  start(): void;
  stop(): void;
  drain(): Promise<void>;
  matchMessage(event: Extract<NormalizedWatchEvent, { type: "message" }>, signal?: AbortSignal): Promise<string[]>;
  claimMatched(watchIds: readonly string[], event: NormalizedWatchEvent): EventWatchTurn | null;
  executeClaimed(turn: EventWatchTurn): Promise<void>;
  ingest(event: Exclude<NormalizedWatchEvent, { type: "message" }>, stabilityMs?: number): void;
  cancelWatch(watchId: string): void;
}

/** Coordinate watch settlement, durable claims, restart recovery, and execution. */
export function createEventWatchRuntime(input: {
  db: Database;
  matcher: WatchMatcher;
  log: Logger;
  onFire: (turn: EventWatchTurn) => Promise<{ visibleOutput: boolean }>;
  pressure: EventWatchPressure;
  pollIntervalMs?: number;
}): EventWatchRuntime {
  const delayed = new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    event: Exclude<NormalizedWatchEvent, { type: "message" }>;
  }>();
  const active = new Set<Promise<void>>();
  const pollIntervalMs = Math.max(1_000, input.pollIntervalMs ?? 15_000);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function execute(turn: EventWatchTurn): Promise<void> {
    for (const fire of turn.fires) updateEventWatchFireState(input.db, fire.id, "running");
    try {
      const result = await input.onFire(turn);
      for (const fire of turn.fires) {
        updateEventWatchFireState(input.db, fire.id, result.visibleOutput ? "delivered" : "silent");
      }
    } catch (error) {
      for (const fire of turn.fires) updateEventWatchFireState(input.db, fire.id, "failed");
      input.log.error("event watch turn failed", {
        watchIds: turn.watches.map((watch) => watch.id),
        eventKey: turn.event.eventKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function track(task: Promise<void>): void {
    const tracked = task.finally(() => active.delete(tracked));
    active.add(tracked);
  }

  function turnFromFires(fires: EventWatchFire[]): EventWatchTurn | null {
    if (fires.length === 0) return null;
    const watches = fires
      .map((fire) => getEventWatch(input.db, fire.watchId))
      .filter((watch): watch is EventWatch => watch !== null);
    const event = fires.at(-1)?.event;
    return event === undefined || watches.length === 0 ? null : { watches, fires, event };
  }

  function runPending(): void {
    if (!running) return;
    const grouped = new Map<string, EventWatchFire[]>();
    for (const fire of listPendingEventWatchFires(input.db)) {
      if (!eventWatchFirePressureAllowsExecution(input.db, fire, input.pressure)) continue;
      const watch = getEventWatch(input.db, fire.watchId);
      if (watch === null) continue;
      const key = `${watch.runInGuildId}:${watch.runInChannelId}:${fire.event.eventKey}`;
      const group = grouped.get(key) ?? [];
      group.push(fire);
      grouped.set(key, group);
    }
    for (const fires of grouped.values()) {
      const turn = turnFromFires(fires);
      if (turn !== null) track(execute(turn));
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      runPending();
      pollTimer = setInterval(runPending, pollIntervalMs);
    },

    stop(): void {
      running = false;
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
      for (const pending of delayed.values()) clearTimeout(pending.timer);
      delayed.clear();
    },

    async drain(): Promise<void> {
      while (active.size > 0) await Promise.allSettled([...active]);
    },

    async matchMessage(event, signal): Promise<string[]> {
      const matched = await input.matcher.match(event, signal);
      const watchIds = matched.watches.map((watch) => watch.id);
      if (watchIds.length === 0) markWatchMessageProcessed(input.db, event.messageId);
      return watchIds;
    },

    claimMatched(watchIds, event): EventWatchTurn | null {
      try {
        return turnFromFires(input.matcher.claim(watchIds, event));
      } finally {
        if (event.type === "message") markWatchMessageProcessed(input.db, event.messageId);
      }
    },

    async executeClaimed(turn): Promise<void> {
      await execute(turn);
    },

    ingest(event, stabilityMs = 0): void {
      if (!running) return;
      const key = [
        event.type,
        event.guildId,
        "userId" in event ? event.userId : "",
        event.type === "reaction" ? `${event.messageId}:${event.emoji}:${event.action}` : "",
      ].join(":");
      const prior = delayed.get(key);
      if (prior !== undefined) clearTimeout(prior.timer);
      const settledEvent = prior?.event.type === "presence_transition" && event.type === "presence_transition"
        ? { ...event, from: prior.event.from }
        : event;
      const settle = async (): Promise<void> => {
        delayed.delete(key);
        const matched = await input.matcher.match(settledEvent);
        const turn = turnFromFires(input.matcher.claim(matched.watches.map((watch) => watch.id), settledEvent));
        if (turn !== null) await execute(turn);
      };
      if (stabilityMs <= 0) {
        track(settle());
      } else {
        delayed.set(key, {
          event: settledEvent,
          timer: setTimeout(() => track(settle()), stabilityMs),
        });
      }
    },

    cancelWatch(watchId): void {
      for (const [key, pending] of delayed) {
        if (!key.includes(watchId)) continue;
        clearTimeout(pending.timer);
        delayed.delete(key);
      }
    },
  };
}
