import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "./database.ts";
import {
  claimEventWatchFire,
  createEventWatch,
  deleteEventWatch,
  getEventWatch,
  listCandidateEventWatches,
  listEventWatches,
  updateEventWatch,
} from "./event-watch-repository.ts";
import {
  DEFAULT_EVENT_WATCH_PRESSURE,
  type NormalizedWatchEvent,
  type WatchEvent,
} from "../event-watch/types.ts";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function createWatch(event: WatchEvent, overrides: Partial<Parameters<typeof createEventWatch>[1]> = {}): string {
  return createEventWatch(db, {
    source: { scope: "guild", guildId: "guild-1" },
    sourceGuildId: "guild-1",
    runInGuildId: "guild-1",
    runInChannelId: "channel-1",
    timezone: "UTC",
    event,
    instruction: "Notice it.",
    origin: "persona",
    cooldownSeconds: 0,
    ...overrides,
  });
}

function messageEvent(key: string, userId = "user-1"): Extract<NormalizedWatchEvent, { type: "message" }> {
  return {
    type: "message",
    eventKey: key,
    at: Date.now(),
    guildId: "guild-1",
    channelId: "channel-1",
    userId,
    webhookId: null,
    content: "alpha",
    assetKinds: [],
    authorIsSelf: false,
    messageId: key,
  };
}

describe("event watch repository", () => {
  test("stores typed state, handoff, origin, scope, and lifecycle changes", () => {
    const id = createWatch(
      { type: "presence_state", statuses: ["online", "idle"] },
      {
        source: { scope: "all_guilds" },
        after: "18:00",
        handoffNote: "Prior context.",
        origin: { userId: "user-1", username: "alice" },
        once: true,
        maxFireCount: 2,
      },
    );
    const watch = getEventWatch(db, id);
    expect(watch?.source).toEqual({ scope: "all_guilds" });
    expect(watch?.event).toEqual({ type: "presence_state", statuses: ["online", "idle"] });
    expect(watch?.after).toBe("18:00");
    expect(watch?.handoffNote).toBe("Prior context.");
    expect(watch?.origin).toEqual({ userId: "user-1", username: "alice" });
    expect(updateEventWatch(db, id, { handoffNote: "Next.", enabled: false })).toBe(true);
    expect(getEventWatch(db, id)?.enabled).toBe(false);
    expect(deleteEventWatch(db, id)).toBe(true);
    expect(getEventWatch(db, id)).toBeNull();
  });

  test("uses indexed source, user, and webhook selectors before detailed matching", () => {
    const messageId = createWatch({ type: "message", userId: "user-1", webhookId: "hook-1" });
    createWatch({ type: "message", userId: "user-2" });
    createWatch({ type: "voice", action: "join" });
    const event = { ...messageEvent("message-1"), webhookId: "hook-1" };
    expect(listCandidateEventWatches(db, event).map((watch) => watch.id)).toEqual([messageId]);
  });

  test("claims one-off events atomically and disables the watch", () => {
    const id = createWatch({ type: "message" }, { once: true });
    const event = messageEvent("message-1");
    const watch = getEventWatch(db, id);
    if (watch === null) throw new Error("watch missing");
    expect(claimEventWatchFire(db, watch, event, DEFAULT_EVENT_WATCH_PRESSURE)).not.toBeNull();
    expect(claimEventWatchFire(db, watch, event, DEFAULT_EVENT_WATCH_PRESSURE)).toBeNull();
    expect(getEventWatch(db, id)?.enabled).toBe(false);
    expect(getEventWatch(db, id)?.fireCount).toBe(1);
  });

  test("fires a rolling threshold once and rearms after the window falls below it", () => {
    const id = createWatch(
      { type: "message" },
      { occurrences: { count: 2, withinSeconds: 5 } },
    );
    const watch = getEventWatch(db, id);
    if (watch === null) throw new Error("watch missing");
    const base = Date.now();
    expect(claimEventWatchFire(db, watch, { ...messageEvent("m1"), at: base }, DEFAULT_EVENT_WATCH_PRESSURE)).toBeNull();
    expect(claimEventWatchFire(db, watch, { ...messageEvent("m2"), at: base + 1_000 }, DEFAULT_EVENT_WATCH_PRESSURE)).not.toBeNull();
    expect(claimEventWatchFire(db, watch, { ...messageEvent("m3"), at: base + 2_000 }, DEFAULT_EVENT_WATCH_PRESSURE)).toBeNull();
    expect(claimEventWatchFire(db, watch, { ...messageEvent("m4"), at: base + 8_000 }, DEFAULT_EVENT_WATCH_PRESSURE)).toBeNull();
    expect(claimEventWatchFire(db, watch, { ...messageEvent("m5"), at: base + 9_000 }, DEFAULT_EVENT_WATCH_PRESSURE)).not.toBeNull();
  });

  test("lists execution scope independently from observation scope", () => {
    const current = createWatch({ type: "member", action: "join" });
    const otherChannel = createWatch(
      { type: "member", action: "leave" },
      { runInChannelId: "channel-2" },
    );
    const otherGuild = createWatch(
      { type: "voice", action: "join" },
      { runInGuildId: "guild-2", runInChannelId: "channel-3" },
    );
    expect(listEventWatches(db, {
      guildId: "guild-1",
      channelId: "channel-1",
      scope: "current_channel",
    }).map((watch) => watch.id)).toEqual([current]);
    expect(listEventWatches(db, {
      guildId: "guild-1",
      channelId: "channel-1",
      scope: "current_guild",
    }).map((watch) => watch.id)).toEqual([current, otherChannel]);
    expect(listEventWatches(db, {
      guildId: "guild-1",
      channelId: "channel-1",
      scope: "all_guilds",
    }).map((watch) => watch.id)).toEqual([current, otherChannel, otherGuild]);
  });

  test("persists a message evaluation inbox row in the message insert transaction", () => {
    db.raw.prepare(`INSERT INTO messages
      (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
      VALUES ('message-1', 'guild-1', 'channel-1', 'user-1', 'alice', 'x', 'x', 0, ?)`)
      .run(Date.now());
    const row = db.raw.prepare(
      "SELECT state FROM event_watch_message_inbox WHERE message_id = 'message-1'",
    ).get() as { state: string } | null;
    expect(row?.state).toBe("pending");
  });

  test("enforces cooldown without consuming a later rolling event", () => {
    const id = createWatch({ type: "message" }, { cooldownSeconds: 30 });
    const watch = getEventWatch(db, id);
    if (watch === null) throw new Error("watch missing");
    expect(claimEventWatchFire(db, watch, messageEvent("m1"), DEFAULT_EVENT_WATCH_PRESSURE)).not.toBeNull();
    expect(claimEventWatchFire(db, watch, messageEvent("m2"), DEFAULT_EVENT_WATCH_PRESSURE)).toBeNull();
    db.raw.prepare("UPDATE event_watch_fires SET created_at = created_at - 31000 WHERE watch_id = ?").run(id);
    expect(claimEventWatchFire(db, watch, messageEvent("m3"), DEFAULT_EVENT_WATCH_PRESSURE)).not.toBeNull();
  });
});
