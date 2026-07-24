import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database.ts";
import { createEventWatch } from "../db/event-watch-repository.ts";
import { createWatchMatcher, isWatchEligibleAfter } from "./matcher.ts";
import { DEFAULT_EVENT_WATCH_PRESSURE, type EventWatch, type NormalizedWatchEvent, type WatchEvent } from "./types.ts";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function add(event: WatchEvent): string {
  return createEventWatch(db, {
    source: { scope: "guild", guildId: "guild-1" },
    sourceGuildId: "guild-1",
    runInGuildId: "guild-1",
    runInChannelId: "channel-1",
    timezone: "UTC",
    event,
    instruction: "Check.",
    origin: "persona",
    cooldownSeconds: 0,
  });
}

function message(overrides: Partial<Extract<NormalizedWatchEvent, { type: "message" }>> = {}): Extract<NormalizedWatchEvent, { type: "message" }> {
  return {
    type: "message",
    eventKey: "message:m1",
    at: Date.now(),
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    webhookId: null,
    content: "the reactor is unstable",
    assetKinds: ["image"],
    authorIsSelf: false,
    messageId: "m1",
    ...overrides,
  };
}

describe("event watch matcher", () => {
  test("matches ripgrep regex, webhook identity, assets, and omitted-user semantics", async () => {
    const regex = add({ type: "message", pattern: "react(or|ion)", assetKind: "image" });
    const webhook = add({ type: "message", webhookId: "hook-1" });
    const anyUser = add({ type: "message" });
    const matcher = createWatchMatcher({ db, pressure: DEFAULT_EVENT_WATCH_PRESSURE });
    const result = await matcher.match(message({ webhookId: "hook-1" }));
    expect(new Set(result.watches.map((watch) => watch.id))).toEqual(new Set([regex, webhook, anyUser]));
    expect(result.metrics.processCount).toBe(1);
  });

  test("does not match persona output unless includeSelf is explicit", async () => {
    add({ type: "message" });
    const include = add({ type: "message", includeSelf: true });
    const matcher = createWatchMatcher({ db, pressure: DEFAULT_EVENT_WATCH_PRESSURE });
    const result = await matcher.match(message({ authorIsSelf: true }));
    expect(result.watches.map((watch) => watch.id)).toEqual([include]);
  });

  test("matches offline transitions to online and idle", async () => {
    const id = add({ type: "presence_transition", from: ["offline"], to: ["online", "idle"] });
    const matcher = createWatchMatcher({ db, pressure: DEFAULT_EVENT_WATCH_PRESSURE });
    for (const to of ["online", "idle"] as const) {
      const result = await matcher.match({
        type: "presence_transition",
        eventKey: `presence:${to}`,
        at: Date.now(),
        guildId: "guild-1",
        userId: "user-1",
        from: "offline",
        to,
      });
      expect(result.watches.map((watch) => watch.id)).toEqual([id]);
    }
  });

  test("applies daily and absolute local after boundaries", () => {
    const base = {
      id: "watch",
      source: { scope: "guild", guildId: "guild-1" },
      runInGuildId: "guild-1",
      runInChannelId: "channel-1",
      timezone: "UTC",
      event: { type: "presence_state", statuses: ["online"] },
      instruction: "Check.",
      handoffNote: "",
      origin: "persona",
      once: false,
      cooldownSeconds: 0,
      fireCount: 0,
      maxFireCount: null,
      expiresAt: null,
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    } satisfies Omit<EventWatch, "after">;
    expect(isWatchEligibleAfter({ ...base, after: "18:00" }, Date.UTC(2026, 6, 24, 17, 59))).toBe(false);
    expect(isWatchEligibleAfter({ ...base, after: "18:00" }, Date.UTC(2026, 6, 24, 18, 0))).toBe(true);
    expect(isWatchEligibleAfter({ ...base, after: "2026-07-24 18:00" }, Date.UTC(2026, 6, 24, 17, 59))).toBe(false);
    expect(isWatchEligibleAfter({ ...base, after: "2026-07-24 18:00" }, Date.UTC(2026, 6, 24, 18, 0))).toBe(true);
  });

  test("validates patterns with ripgrep syntax", async () => {
    const matcher = createWatchMatcher({ db, pressure: DEFAULT_EVENT_WATCH_PRESSURE });
    expect(await matcher.validatePattern("(?i)alpha")).toBeNull();
    expect(await matcher.validatePattern("[")).toContain("Invalid regex");
  });

  test("matches presence state, voice, member, and reaction event variants", async () => {
    const presence = add({ type: "presence_state", statuses: ["idle"] });
    const voice = add({ type: "voice", action: "move", channelId: "voice-2" });
    const member = add({ type: "member", action: "join" });
    const reaction = add({ type: "reaction", action: "add", messageId: "m1", emoji: "🔥" });
    const matcher = createWatchMatcher({ db, pressure: DEFAULT_EVENT_WATCH_PRESSURE });
    const cases: Array<{ event: NormalizedWatchEvent; id: string }> = [
      {
        id: presence,
        event: {
          type: "presence_state",
          eventKey: "presence:idle",
          at: Date.now(),
          guildId: "guild-1",
          userId: "user-1",
          status: "idle",
        },
      },
      {
        id: voice,
        event: {
          type: "voice",
          eventKey: "voice:move",
          at: Date.now(),
          guildId: "guild-1",
          userId: "user-1",
          action: "move",
          channelId: "voice-2",
          fromChannelId: "voice-1",
          toChannelId: "voice-2",
        },
      },
      {
        id: member,
        event: {
          type: "member",
          eventKey: "member:join",
          at: Date.now(),
          guildId: "guild-1",
          userId: "user-1",
          action: "join",
        },
      },
      {
        id: reaction,
        event: {
          type: "reaction",
          eventKey: "reaction:add",
          at: Date.now(),
          guildId: "guild-1",
          channelId: "channel-1",
          userId: "user-1",
          action: "add",
          messageId: "m1",
          emoji: "🔥",
          count: 1,
        },
      },
    ];
    for (const entry of cases) {
      const result = await matcher.match(entry.event);
      expect(result.watches.map((watch) => watch.id)).toEqual([entry.id]);
    }
  });

  test("uses aggregate reaction threshold crossing and rearms below the threshold", async () => {
    const id = add({ type: "reaction", action: "add", countAtLeast: 3 });
    const matcher = createWatchMatcher({ db, pressure: DEFAULT_EVENT_WATCH_PRESSURE });
    const event = (key: string, count: number): Extract<NormalizedWatchEvent, { type: "reaction" }> => ({
      type: "reaction",
      eventKey: key,
      at: Date.now(),
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      action: "add",
      messageId: "m1",
      emoji: "🔥",
      count,
    });
    expect((await matcher.match(event("r2", 2))).watches).toHaveLength(0);
    const first = event("r3", 3);
    expect(matcher.claim([id], first)).toHaveLength(1);
    expect(matcher.claim([id], event("r4", 4))).toHaveLength(0);
    expect((await matcher.match(event("r2b", 2))).watches).toHaveLength(0);
    expect(matcher.claim([id], event("r3b", 3))).toHaveLength(1);
  });
});
