import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database.ts";
import {
  countActiveWatches,
  createEventWatch,
  deleteEventWatch,
  listEventWatches,
  type EventWatchScope,
} from "../db/event-watch-repository.ts";
import { parseLocalDateTimeToEpoch } from "../time/agent-time.ts";
import {
  DEFAULT_EVENT_COOLDOWN_SECONDS,
  DEFAULT_EVENT_WATCH_PRESSURE,
  PRESENCE_STATUSES,
  type EventWatch,
  type EventWatchPressure,
  type WatchEvent,
  type WatchSource,
} from "../event-watch/types.ts";
import type { WatchMatcher } from "../event-watch/matcher.ts";
import { markReadOnlyTool } from "./tool-effects.ts";

const AssetKindSchema = Type.Union([
  Type.Literal("any"),
  Type.Literal("image"),
  Type.Literal("gif"),
  Type.Literal("audio"),
  Type.Literal("video"),
  Type.Literal("text"),
  Type.Literal("file"),
]);
const StatusSchema = Type.Union(PRESENCE_STATUSES.map((status) => Type.Literal(status)));
const SourceSchema = Type.Union([
  Type.Object({
    scope: Type.Literal("channel"),
    channelId: Type.Optional(Type.String()),
  }),
  Type.Object({
    scope: Type.Literal("guild"),
    guildId: Type.Optional(Type.String()),
  }),
  Type.Object({ scope: Type.Literal("all_guilds") }),
]);
const EventSchema = Type.Union([
  Type.Object({
    type: Type.Literal("message"),
    userId: Type.Optional(Type.String()),
    webhookId: Type.Optional(Type.String()),
    webhookMessageId: Type.Optional(Type.String({ description: "Stored message ID whose exact webhook identity should be used." })),
    pattern: Type.Optional(Type.String()),
    assetKind: Type.Optional(AssetKindSchema),
    includeSelf: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    type: Type.Literal("presence_transition"),
    userId: Type.Optional(Type.String()),
    from: Type.Optional(Type.Array(StatusSchema)),
    to: Type.Array(StatusSchema, { minItems: 1 }),
  }),
  Type.Object({
    type: Type.Literal("presence_state"),
    userId: Type.Optional(Type.String()),
    statuses: Type.Array(StatusSchema, { minItems: 1 }),
  }),
  Type.Object({
    type: Type.Literal("voice"),
    userId: Type.Optional(Type.String()),
    action: Type.Union([Type.Literal("join"), Type.Literal("leave"), Type.Literal("move")]),
    channelId: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("member"),
    userId: Type.Optional(Type.String()),
    action: Type.Union([Type.Literal("join"), Type.Literal("leave")]),
  }),
  Type.Object({
    type: Type.Literal("reaction"),
    userId: Type.Optional(Type.String()),
    action: Type.Union([Type.Literal("add"), Type.Literal("remove")]),
    messageId: Type.Optional(Type.String()),
    emoji: Type.Optional(Type.String()),
    countAtLeast: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
]);

const CreateEventWatchParams = Type.Object({
  source: SourceSchema,
  event: EventSchema,
  instruction: Type.String(),
  handoffNote: Type.Optional(Type.String()),
  run_in_channel_id: Type.Optional(Type.String()),
  after: Type.Optional(Type.String({ description: "HH:mm or YYYY-MM-DD HH:mm in the watched guild timezone." })),
  occurrences: Type.Optional(Type.Object({
    count: Type.Integer({ minimum: 2 }),
    withinSeconds: Type.Integer({ minimum: 1 }),
  })),
  once: Type.Optional(Type.Boolean()),
  cooldownSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  maxFireCount: Type.Optional(Type.Integer({ minimum: 1 })),
  expiresAtLocalDateTime: Type.Optional(Type.String()),
  origin: Type.Optional(Type.Union([
    Type.Literal("persona"),
    Type.Literal("requester"),
  ], { description: "Whether this watch is self-chosen or requested." })),
});

const ListEventWatchesParams = Type.Object({
  scope: Type.Optional(Type.Union([
    Type.Literal("current_channel"),
    Type.Literal("current_guild"),
    Type.Literal("all_guilds"),
  ], { default: "current_channel" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

const DeleteEventWatchParams = Type.Object({
  watchId: Type.String(),
});

export interface EventWatchToolDeps {
  db: Database;
  matcher: WatchMatcher;
  guildId: string;
  channelId: string;
  timezone: string;
  currentRequest?: { requesterId: string; requesterUsername: string };
  pressure?: EventWatchPressure;
  resolveChannel?: (channelId: string) => Promise<{
    guildId: string;
    channelId: string;
    timezone: string;
  } | null>;
  resolveGuild?: (guildId: string) => Promise<{ guildId: string; timezone: string } | null>;
  onWatchCreated?: (watchId: string) => void;
  onWatchDeleted?: (watchId: string) => void;
}

export function createEventWatchTools(deps: EventWatchToolDeps): AgentTool[] {
  return [
    createEventWatchTool(deps),
    createListEventWatchesTool(deps),
    createDeleteEventWatchTool(deps),
  ];
}

export function createEventWatchTool(deps: EventWatchToolDeps): AgentTool {
  return {
    name: "create_event_watch",
    label: "create_event_watch",
    description: "Create a durable private event watch.",
    parameters: CreateEventWatchParams,
    async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<{ watchId?: string; error?: boolean }>> {
      const params = rawParams as {
        source?: WatchSource;
        event?: WatchEvent & { webhookMessageId?: string };
        instruction?: string;
        handoffNote?: string;
        run_in_channel_id?: string;
        after?: string;
        occurrences?: { count: number; withinSeconds: number };
        once?: boolean;
        cooldownSeconds?: number;
        maxFireCount?: number;
        expiresAtLocalDateTime?: string;
        origin?: "persona" | "requester";
      };
      const instruction = params.instruction?.trim();
      if (params.source === undefined || params.event === undefined || instruction === undefined || instruction === "") {
        return watchError("source, event, and instruction are required.");
      }
      if (params.event.type === "reaction"
          && params.event.countAtLeast !== undefined
          && params.occurrences !== undefined) {
        return watchError("Reaction countAtLeast and occurrences cannot be combined.");
      }
      if (params.source.scope === "channel"
          && params.event.type !== "message"
          && params.event.type !== "reaction") {
        return watchError("Channel observation scope is available only for message and reaction events.");
      }
      if (params.event.type === "message" && params.event.pattern !== undefined) {
        const pattern = params.event.pattern.trim();
        if (pattern === "") return watchError("pattern cannot be empty.");
        const patternError = await deps.matcher.validatePattern(pattern, signal);
        if (patternError !== null) return watchError(patternError);
        params.event = { ...params.event, pattern };
      }
      if (params.event.type === "message" && params.event.webhookMessageId !== undefined) {
        const webhookMessageId = params.event.webhookMessageId.trim();
        const row = deps.db.raw.prepare(
          "SELECT webhook_id FROM messages WHERE id = ? AND webhook_id IS NOT NULL",
        ).get(webhookMessageId) as { webhook_id: string } | null;
        if (row === null) return watchError("The referenced message has no stored webhook identity.");
        const { webhookMessageId: _resolvedMessageId, ...event } = params.event;
        params.event = { ...event, webhookId: row.webhook_id };
      }
      const source = await resolveSource(deps, params.source);
      if (typeof source === "string") return watchError(source);
      const execution = await resolveExecution(deps, params.run_in_channel_id);
      if (execution === null) return watchError("The execution channel is not accessible.");
      const afterError = validateAfter(params.after, source.timezone);
      if (afterError !== null) return watchError(afterError);
      let expiresAt: number | undefined;
      if (params.expiresAtLocalDateTime !== undefined) {
        const parsed = parseLocalDateTimeToEpoch(params.expiresAtLocalDateTime, source.timezone);
        if (!parsed.ok) return watchError(parsed.error);
        if (parsed.epochMs <= Date.now()) return watchError("Expiration must be in the future.");
        expiresAt = parsed.epochMs;
      }
      const pressure = deps.pressure ?? DEFAULT_EVENT_WATCH_PRESSURE;
      if (countActiveWatches(deps.db) >= pressure.maxActiveProfile) {
        return watchError("The profile active-watch limit is reached.");
      }
      if (countActiveWatches(deps.db, execution.guildId) >= pressure.maxActivePerGuild) {
        return watchError("The execution guild active-watch limit is reached.");
      }
      const origin: EventWatch["origin"] = params.origin === "persona"
        || deps.currentRequest === undefined
        || deps.currentRequest.requesterId === "scheduler"
        || deps.currentRequest.requesterId === "event-watch"
        ? "persona"
        : {
            userId: deps.currentRequest.requesterId,
            username: deps.currentRequest.requesterUsername,
          };
      const watchId = createEventWatch(deps.db, {
        source: source.source,
        sourceGuildId: source.guildId,
        runInGuildId: execution.guildId,
        runInChannelId: execution.channelId,
        timezone: source.timezone,
        event: params.event,
        ...(params.after === undefined ? {} : { after: params.after.trim() }),
        ...(params.occurrences === undefined ? {} : { occurrences: params.occurrences }),
        instruction,
        handoffNote: params.handoffNote?.trim() ?? "",
        origin,
        once: params.once === true,
        cooldownSeconds: params.cooldownSeconds ?? DEFAULT_EVENT_COOLDOWN_SECONDS[params.event.type],
        ...(params.maxFireCount === undefined ? {} : { maxFireCount: params.maxFireCount }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      deps.onWatchCreated?.(watchId);
      return {
        content: [{ type: "text", text: `Created event watch ${watchId}.` }],
        details: { watchId },
      };
    },
  };
}

export function createListEventWatchesTool(deps: EventWatchToolDeps): AgentTool {
  return markReadOnlyTool({
    name: "list_event_watches",
    label: "list_event_watches",
    description: "List active event watches by channel, guild, or profile scope.",
    parameters: ListEventWatchesParams,
    execute(_toolCallId, rawParams): Promise<AgentToolResult<{ count: number; total: number }>> {
      const params = rawParams as { scope?: EventWatchScope; limit?: number };
      const scope = params.scope ?? "current_channel";
      const limit = Math.max(1, Math.min(params.limit ?? 20, 50));
      const watches = listEventWatches(deps.db, {
        guildId: deps.guildId,
        channelId: deps.channelId,
        scope,
        enabledOnly: true,
      });
      const visible = watches.slice(0, limit);
      return Promise.resolve({
        content: [{
          type: "text",
          text: visible.length === 0
            ? `No active event watches in ${scope.replaceAll("_", " ")}.`
            : `Active event watches (${watches.length}):\n${visible.map(formatWatch).join("\n")}`,
        }],
        details: { count: visible.length, total: watches.length },
      });
    },
  });
}

export function createDeleteEventWatchTool(deps: EventWatchToolDeps): AgentTool {
  return {
    name: "delete_event_watch",
    label: "delete_event_watch",
    description: "Delete an event watch by exact ID.",
    parameters: DeleteEventWatchParams,
    execute(_toolCallId, rawParams): Promise<AgentToolResult<{ deleted: boolean; watchId?: string }>> {
      const watchId = (rawParams as { watchId?: string }).watchId?.trim();
      if (watchId === undefined || watchId === "") return Promise.resolve({
        content: [{ type: "text", text: "watchId is required." }],
        details: { deleted: false },
      });
      const deleted = deleteEventWatch(deps.db, watchId);
      if (deleted) deps.onWatchDeleted?.(watchId);
      return Promise.resolve({
        content: [{ type: "text", text: deleted ? `Deleted event watch ${watchId}.` : "No event watch with that ID exists." }],
        details: { deleted, watchId },
      });
    },
  };
}

async function resolveSource(
  deps: EventWatchToolDeps,
  source: WatchSource,
): Promise<{ source: WatchSource; guildId?: string; timezone: string } | string> {
  if (source.scope === "all_guilds") {
    return { source, timezone: deps.timezone };
  }
  if (source.scope === "guild") {
    const requestedGuildId = source.guildId?.trim();
    const guildId = requestedGuildId !== undefined && requestedGuildId !== "" ? requestedGuildId : deps.guildId;
    const resolvedGuild = guildId === deps.guildId
      ? { guildId, timezone: deps.timezone }
      : await deps.resolveGuild?.(guildId) ?? null;
    if (resolvedGuild === null) return "The source guild is not accessible.";
    return {
      source: { scope: "guild", guildId },
      guildId,
      timezone: resolvedGuild.timezone,
    };
  }
  const requestedChannelId = source.channelId?.trim();
  const channelId = requestedChannelId !== undefined && requestedChannelId !== "" ? requestedChannelId : deps.channelId;
  const resolved = channelId === deps.channelId
    ? { guildId: deps.guildId, channelId, timezone: deps.timezone }
    : await deps.resolveChannel?.(channelId) ?? null;
  if (resolved === null) return "The source channel is not accessible.";
  return {
    source: { scope: "channel", channelId: resolved.channelId },
    guildId: resolved.guildId,
    timezone: resolved.timezone,
  };
}

async function resolveExecution(
  deps: EventWatchToolDeps,
  channelId: string | undefined,
): Promise<{ guildId: string; channelId: string; timezone: string } | null> {
  const normalized = channelId?.trim();
  if (normalized === undefined || normalized === "" || normalized === deps.channelId) {
    return { guildId: deps.guildId, channelId: deps.channelId, timezone: deps.timezone };
  }
  return await deps.resolveChannel?.(normalized) ?? null;
}

function validateAfter(after: string | undefined, timezone: string): string | null {
  if (after === undefined) return null;
  const normalized = after.trim();
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized)) return null;
  const parsed = parseLocalDateTimeToEpoch(normalized, timezone);
  return parsed.ok ? null : parsed.error;
}

function formatWatch(watch: EventWatch): string {
  const source = watch.source.scope === "all_guilds"
    ? "all guilds"
    : watch.source.scope === "guild"
      ? `guild ${watch.source.guildId ?? "current"}`
      : `channel ${watch.source.channelId ?? "current"}`;
  const event = JSON.stringify(watch.event);
  return `- ${watch.id} [${source} -> ${watch.runInGuildId}/${watch.runInChannelId}; ${event}; fired=${watch.fireCount}]: ${watch.instruction.replaceAll("\n", " ").slice(0, 240)}`;
}

function watchError(text: string): AgentToolResult<{ error: boolean }> {
  return { content: [{ type: "text", text }], details: { error: true } };
}
