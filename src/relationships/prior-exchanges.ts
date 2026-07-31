import { createHash } from "node:crypto";
import type { Database } from "../db/database";
import type { RelationshipAxis, RelationshipEvent, RelationshipProfile } from "./types";
import { RELATIONSHIP_AXES, relationshipEventAppliedAxes } from "./state";
import { listRelationshipEvents } from "./repository";

interface ExchangeRow {
  cue_id: string;
  cue_guild_id: string;
  cue_channel_id: string;
  cue_content: string;
  response_id: string;
  response_content: string;
}

interface PriorExchange {
  cueId: string;
  guildId: string;
  cue: string;
  response: string;
  growthAxis?: RelationshipAxis;
}

export interface PriorExchangesContextInput {
  db: Database;
  enabled: boolean;
  profile: RelationshipProfile;
  botUserId: string;
  currentUserId: string;
  currentGuildId: string;
  currentChannelId: string;
  maxExchanges: number;
  maxMessageChars: number;
  refreshMinutes: number;
  now?: number;
}

const POSITIVE_GROWTH_AXES = RELATIONSHIP_AXES.filter(
  (axis) => axis !== "tension",
);
function growthAxis(event: RelationshipEvent): RelationshipAxis | undefined {
  const axes = relationshipEventAppliedAxes(event);
  return RELATIONSHIP_AXES
    .filter((axis) => {
      const value = axes[axis] ?? 0;
      return axis === "tension" ? value < 0 : POSITIVE_GROWTH_AXES.includes(axis) && value > 0;
    })
    .sort((left, right) => Math.abs(axes[right] ?? 0) - Math.abs(axes[left] ?? 0))[0];
}

function toExchange(row: ExchangeRow, axis?: RelationshipAxis): PriorExchange {
  return {
    cueId: row.cue_id,
    guildId: row.cue_guild_id,
    cue: row.cue_content,
    response: row.response_content,
    ...(axis === undefined ? {} : { growthAxis: axis }),
  };
}

function linkedExchanges(input: PriorExchangesContextInput): PriorExchange[] {
  const recentIds = new Set(input.profile.recent.map((moment) => moment.id));
  const events = new Map(
    listRelationshipEvents(input.db, { userId: input.currentUserId, limit: 100 })
      .filter((event) => recentIds.has(event.id))
      .map((event) => [event.id, event]),
  );
  const axesByMessageId = new Map<string, RelationshipAxis>();
  for (const moment of input.profile.recent) {
    const event = events.get(moment.id);
    const axis = event === undefined ? undefined : growthAxis(event);
    const sourceMessageId = moment.scope?.sourceMessageId;
    if (axis !== undefined && sourceMessageId !== undefined) axesByMessageId.set(sourceMessageId, axis);
  }
  const sourceMessageIds = [...axesByMessageId.keys()];
  if (sourceMessageIds.length === 0) return [];
  const placeholders = sourceMessageIds.map(() => "?").join(",");
  const rows = input.db.raw.prepare(
    `SELECT cue.id AS cue_id, cue.guild_id AS cue_guild_id,
            cue.channel_id AS cue_channel_id, cue.translated_content AS cue_content,
            response.id AS response_id, response.translated_content AS response_content
     FROM messages cue
     JOIN messages response ON response.id = (
       SELECT next.id
       FROM messages next
       WHERE next.guild_id = cue.guild_id AND next.channel_id = cue.channel_id
         AND (next.created_at > cue.created_at OR (next.created_at = cue.created_at AND next.id > cue.id))
         AND next.is_synthetic = 0 AND next.is_prompt_only = 0
         AND next.deleted_at IS NULL AND TRIM(next.translated_content) <> ''
       ORDER BY next.created_at ASC, next.id ASC
       LIMIT 1
     )
     WHERE cue.id IN (${placeholders}) AND cue.user_id = ? AND cue.is_bot = 0
       AND cue.is_synthetic = 0 AND cue.is_prompt_only = 0
       AND cue.deleted_at IS NULL AND TRIM(cue.translated_content) <> ''
       AND response.user_id = ? AND response.is_bot = 1`,
  ).all(...sourceMessageIds, input.currentUserId, input.botUserId) as ExchangeRow[];
  return rows
    .filter((row) => row.cue_channel_id !== input.currentChannelId)
    .map((row) => toExchange(row, axesByMessageId.get(row.cue_id)));
}

function ordinaryExchanges(input: PriorExchangesContextInput): PriorExchange[] {
  const rows = input.db.raw.prepare(
    `SELECT cue.id AS cue_id, cue.guild_id AS cue_guild_id,
            cue.channel_id AS cue_channel_id, cue.translated_content AS cue_content,
            response.id AS response_id, response.translated_content AS response_content
     FROM messages cue
     JOIN messages response ON response.id = (
       SELECT next.id
       FROM messages next
       WHERE next.guild_id = cue.guild_id AND next.channel_id = cue.channel_id
         AND (next.created_at > cue.created_at OR (next.created_at = cue.created_at AND next.id > cue.id))
         AND next.is_synthetic = 0 AND next.is_prompt_only = 0
         AND next.deleted_at IS NULL AND TRIM(next.translated_content) <> ''
       ORDER BY next.created_at ASC, next.id ASC
       LIMIT 1
     )
     WHERE cue.user_id = ? AND cue.is_bot = 0 AND cue.channel_id <> ?
       AND cue.is_synthetic = 0 AND cue.is_prompt_only = 0
       AND cue.deleted_at IS NULL AND TRIM(cue.translated_content) <> ''
       AND response.user_id = ? AND response.is_bot = 1
     ORDER BY cue.created_at DESC, cue.id DESC
     LIMIT 100`,
  ).all(
    input.currentUserId,
    input.currentChannelId,
    input.botUserId,
  ) as ExchangeRow[];
  return rows.map((row) => toExchange(row));
}

function score(exchange: PriorExchange, input: PriorExchangesContextInput): string {
  // Match repertoire's target-stable ordering; timed rotation changes the slice without rerolling it.
  return createHash("sha256")
    .update(`${input.botUserId}:${input.currentChannelId}:${exchange.cueId}`)
    .digest("hex");
}

function rotatingOrder(
  exchanges: readonly PriorExchange[],
  input: PriorExchangesContextInput,
): PriorExchange[] {
  const ordered = [...exchanges].sort((left, right) => score(left, input).localeCompare(score(right, input)));
  if (ordered.length === 0) return ordered;
  const rotation = Math.floor((input.now ?? Date.now()) / (input.refreshMinutes * 60 * 1_000));
  const start = rotation * input.maxExchanges % ordered.length;
  return [...ordered.slice(start), ...ordered.slice(0, start)];
}

function selectExchanges(input: PriorExchangesContextInput): PriorExchange[] {
  const linked = rotatingOrder(linkedExchanges(input), input);
  const diverse: PriorExchange[] = [];
  const seenAxes = new Set<RelationshipAxis>();
  for (const exchange of linked) {
    if (exchange.growthAxis === undefined || seenAxes.has(exchange.growthAxis)) continue;
    diverse.push(exchange);
    seenAxes.add(exchange.growthAxis);
  }
  const linkedIds = new Set(diverse.map((exchange) => exchange.cueId));
  const remainingLinked = linked.filter((exchange) => !linkedIds.has(exchange.cueId));
  const usedIds = new Set(linked.map((exchange) => exchange.cueId));
  const ordinary = rotatingOrder(
    ordinaryExchanges(input).filter((exchange) => !usedIds.has(exchange.cueId)),
    input,
  );
  return [...diverse, ...remainingLinked, ...ordinary].slice(0, input.maxExchanges);
}

function content(text: string, foreignGuild: boolean, maxChars: number): string {
  const normalized = foreignGuild
    ? text.replace(/<a?:([A-Za-z0-9_]+):\d+>/g, ":$1:")
    : text;
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Render deterministic same-user cross-room examples in volatile actor context. */
export function buildPriorExchangesContext(input: PriorExchangesContextInput): string {
  if (!input.enabled) return "";
  const exchanges = selectExchanges(input);
  if (exchanges.length === 0) return "";
  return [
    "#### Earlier exchanges with this person",
    "These earlier exchanges show conversational rhythm that has worked with this same person. They may inform recognition, timing, and natural range. They do not preserve old mood or facts, create permission, or override the current relationship and present exchange.",
    ...exchanges.map((exchange) => {
      const foreignGuild = exchange.guildId !== input.currentGuildId;
      return [
        `User: ${content(exchange.cue, foreignGuild, input.maxMessageChars)}`,
        `2B: ${content(exchange.response, foreignGuild, input.maxMessageChars)}`,
      ].join("\n");
    }),
  ].join("\n\n");
}
