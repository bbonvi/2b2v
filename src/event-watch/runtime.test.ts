import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database.ts";
import {
  createEventWatch,
  getEventWatch,
  listPendingEventWatchFires,
} from "../db/event-watch-repository.ts";
import { createWatchMatcher } from "./matcher.ts";
import { createEventWatchRuntime } from "./runtime.ts";
import type { Logger } from "../logger.ts";
import {
  DEFAULT_EVENT_WATCH_PRESSURE,
  type EventWatchPressure,
  type NormalizedWatchEvent,
} from "./types.ts";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function messageEvent(): Extract<NormalizedWatchEvent, { type: "message" }> {
  return {
    type: "message",
    eventKey: "message:m1",
    at: Date.now(),
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    webhookId: null,
    content: "hello",
    assetKinds: [],
    authorIsSelf: false,
    messageId: "m1",
  };
}

describe("event watch runtime", () => {
  test("recovers and executes a pressure-deferred one-off fire", async () => {
    const watchId = createEventWatch(db, {
      source: { scope: "guild", guildId: "guild-1" },
      sourceGuildId: "guild-1",
      runInGuildId: "guild-1",
      runInChannelId: "channel-1",
      timezone: "UTC",
      event: { type: "message" },
      instruction: "Check.",
      origin: "persona",
      once: true,
      cooldownSeconds: 0,
    });
    const blocked: EventWatchPressure = {
      maxActivePerGuild: 100,
      maxActiveProfile: 500,
      maxPendingProfile: 250,
      maxWatchFiresPerHour: 0,
      maxWatchFiresPerDay: 0,
      maxGuildFiresPerHour: 0,
      maxGuildFiresPerDay: 0,
      maxProfileFiresPerHour: 0,
      maxProfileFiresPerDay: 0,
    };
    const blockingMatcher = createWatchMatcher({ db, pressure: blocked });
    expect(blockingMatcher.claim([watchId], messageEvent())).toHaveLength(0);
    expect(listPendingEventWatchFires(db)).toHaveLength(1);
    expect(getEventWatch(db, watchId)?.enabled).toBe(false);

    const recovered: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      logTokenUsage: () => {},
      child: () => logger,
    };
    const runtime = createEventWatchRuntime({
      db,
      matcher: createWatchMatcher({ db, pressure: DEFAULT_EVENT_WATCH_PRESSURE }),
      pressure: DEFAULT_EVENT_WATCH_PRESSURE,
      log: logger,
      onFire: (turn) => {
        recovered.push(...turn.fires.map((fire) => fire.id));
        return Promise.resolve({ visibleOutput: true });
      },
      pollIntervalMs: 60_000,
    });
    runtime.start();
    await runtime.drain();
    runtime.stop();
    expect(recovered).toHaveLength(1);
    expect(listPendingEventWatchFires(db)).toHaveLength(0);
    const state = db.raw.prepare("SELECT state FROM event_watch_fires").get() as { state: string };
    expect(state.state).toBe("delivered");
  });
});
