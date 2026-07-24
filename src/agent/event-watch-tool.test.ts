import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createDatabase, type Database } from "../db/database.ts";
import { getEventWatch, listEventWatches } from "../db/event-watch-repository.ts";
import { createWatchMatcher } from "../event-watch/matcher.ts";
import { createUpdateCurrentEventWatchTool } from "../event-watch/current-watch-tool.ts";
import { DEFAULT_EVENT_WATCH_PRESSURE } from "../event-watch/types.ts";
import {
  createDeleteEventWatchTool,
  createEventWatchTool,
  createListEventWatchesTool,
  type EventWatchToolDeps,
} from "./event-watch-tool.ts";

let db: Database;
let deps: EventWatchToolDeps;
let createTool: AgentTool;

beforeEach(() => {
  db = createDatabase(":memory:");
  const matcher = createWatchMatcher({ db, pressure: DEFAULT_EVENT_WATCH_PRESSURE });
  deps = {
    db,
    matcher,
    guildId: "guild-1",
    channelId: "channel-1",
    timezone: "UTC",
    currentRequest: { requesterId: "user-1", requesterUsername: "alice" },
    resolveChannel: (channelId) => Promise.resolve(
      channelId === "channel-2"
        ? { guildId: "guild-2", channelId, timezone: "Europe/Helsinki" }
        : null,
    ),
    resolveGuild: (guildId) => Promise.resolve(
      guildId === "guild-2" ? { guildId, timezone: "Europe/Helsinki" } : null,
    ),
  };
  createTool = createEventWatchTool(deps);
});

afterEach(() => {
  db.close();
});

describe("event watch tools", () => {
  test("creates a cross-guild watch with regex and destination channel", async () => {
    const result = await createTool.execute("call", {
      source: { scope: "guild", guildId: "guild-2" },
      event: { type: "message", pattern: "(?i)reactor", assetKind: "image" },
      instruction: "See whether it matters.",
      run_in_channel_id: "channel-2",
      after: "18:00",
      occurrences: { count: 3, withinSeconds: 300 },
    }, new AbortController().signal, () => {});
    const watchId = (result.details as { watchId?: string }).watchId;
    expect(watchId).toBeString();
    const watch = getEventWatch(db, watchId ?? "");
    expect(watch?.runInGuildId).toBe("guild-2");
    expect(watch?.runInChannelId).toBe("channel-2");
    expect(watch?.timezone).toBe("Europe/Helsinki");
    expect(watch?.origin).toEqual({ userId: "user-1", username: "alice" });
    expect(watch?.occurrences).toEqual({ count: 3, withinSeconds: 300 });
  });

  test("rejects invalid regex and conflicting reaction thresholds", async () => {
    const invalid = await createTool.execute("invalid", {
      source: { scope: "channel" },
      event: { type: "message", pattern: "[" },
      instruction: "Check.",
    }, new AbortController().signal, () => {});
    expect((invalid.details as { error?: boolean }).error).toBe(true);
    const conflict = await createTool.execute("conflict", {
      source: { scope: "guild" },
      event: { type: "reaction", action: "add", countAtLeast: 3 },
      occurrences: { count: 2, withinSeconds: 60 },
      instruction: "Check.",
    }, new AbortController().signal, () => {});
    expect((conflict.details as { error?: boolean }).error).toBe(true);
  });

  test("resolves an exact webhook identity from a stored message ID", async () => {
    db.raw.prepare(`INSERT INTO messages
      (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, webhook_id, created_at)
      VALUES ('webhook-message', 'guild-1', 'channel-1', 'hook-user', 'GitHub', 'x', 'x', 1, 'hook-1', ?)`)
      .run(Date.now());
    const result = await createTool.execute("webhook", {
      source: { scope: "channel" },
      event: { type: "message", webhookMessageId: "webhook-message" },
      instruction: "Check publication.",
    }, new AbortController().signal, () => {});
    const watchId = (result.details as { watchId?: string }).watchId ?? "";
    expect(getEventWatch(db, watchId)?.event).toEqual({ type: "message", webhookId: "hook-1" });
  });

  test("lists by scope and deletes any exact profile-local ID", async () => {
    await createTool.execute("current", {
      source: { scope: "channel" },
      event: { type: "message" },
      instruction: "Current.",
    }, new AbortController().signal, () => {});
    const cross = await createTool.execute("cross", {
      source: { scope: "all_guilds" },
      event: { type: "member", action: "join" },
      instruction: "Cross.",
      run_in_channel_id: "channel-2",
    }, new AbortController().signal, () => {});
    const crossId = (cross.details as { watchId?: string }).watchId ?? "";
    const listTool = createListEventWatchesTool(deps);
    const current = await listTool.execute("list-current", {}, new AbortController().signal, () => {});
    expect((current.details as { total: number }).total).toBe(1);
    const all = await listTool.execute("list-all", { scope: "all_guilds" }, new AbortController().signal, () => {});
    expect((all.details as { total: number }).total).toBe(2);
    const deleteTool = createDeleteEventWatchTool(deps);
    const deleted = await deleteTool.execute("delete", { watchId: crossId }, new AbortController().signal, () => {});
    expect((deleted.details as { deleted: boolean }).deleted).toBe(true);
    expect(listEventWatches(db, {
      guildId: "guild-1",
      channelId: "channel-1",
      scope: "all_guilds",
    })).toHaveLength(1);
  });

  test("updates only watches attached to the current turn", async () => {
    const created = await createTool.execute("create", {
      source: { scope: "guild" },
      event: { type: "presence_state", statuses: ["online"] },
      instruction: "Check.",
    }, new AbortController().signal, () => {});
    const watchId = (created.details as { watchId?: string }).watchId ?? "";
    const tool = createUpdateCurrentEventWatchTool({ db, watchIds: [watchId] });
    const rejected = await tool.execute("reject", {
      watchId: "other",
      handoffNote: "No.",
    }, new AbortController().signal, () => {});
    expect((rejected.details as { updated: boolean }).updated).toBe(false);
    const updated = await tool.execute("update", {
      watchId,
      handoffNote: "Full next context.",
      complete: true,
    }, new AbortController().signal, () => {});
    expect((updated.details as { updated: boolean }).updated).toBe(true);
    expect(getEventWatch(db, watchId)?.handoffNote).toBe("Full next context.");
    expect(getEventWatch(db, watchId)?.enabled).toBe(false);
  });
});
