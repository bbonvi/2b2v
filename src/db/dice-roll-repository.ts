import type { Database } from "./database";

export type DiceRollMode = "normal" | "advantage" | "disadvantage";

export interface DiceRollRow {
  id: string;
  requestKey: string;
  guildId: string;
  channelId: string;
  sourceMessageId: string;
  resultMessageId: string | null;
  requestedByUserId: string;
  actorUserId: string;
  actorUsername: string;
  count: number;
  sides: number;
  modifier: number;
  mode: DiceRollMode;
  label: string | null;
  rolls: number[];
  kept: number[];
  total: number;
  target: number | null;
  succeeded: boolean | null;
  createdAt: number;
  deliveredAt: number | null;
}

export interface CreateDiceRollInput {
  requestKey: string;
  guildId: string;
  channelId: string;
  sourceMessageId: string;
  requestedByUserId: string;
  actorUserId: string;
  actorUsername: string;
  count: number;
  sides: number;
  modifier: number;
  mode: DiceRollMode;
  label?: string;
  rolls: number[];
  kept: number[];
  total: number;
  target?: number;
}

function parseIntegerArray(value: unknown, column: string): number[] {
  if (typeof value !== "string") throw new Error(`Invalid ${column} value in dice roll record.`);
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((entry) => Number.isInteger(entry))) {
    throw new Error(`Invalid ${column} value in dice roll record.`);
  }
  return parsed as number[];
}

function nullableString(value: unknown, column: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new Error(`Invalid ${column} value in dice roll record.`);
}

function mapDiceRollRow(row: Record<string, unknown>): DiceRollRow {
  const mode = row.mode;
  if (mode !== "normal" && mode !== "advantage" && mode !== "disadvantage") {
    throw new Error("Invalid mode value in dice roll record.");
  }
  return {
    id: String(row.id),
    requestKey: String(row.request_key),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    sourceMessageId: String(row.source_message_id),
    resultMessageId: nullableString(row.result_message_id, "result_message_id"),
    requestedByUserId: String(row.requested_by_user_id),
    actorUserId: String(row.actor_user_id),
    actorUsername: String(row.actor_username),
    count: Number(row.count),
    sides: Number(row.sides),
    modifier: Number(row.modifier),
    mode,
    label: nullableString(row.label, "label"),
    rolls: parseIntegerArray(row.rolls_json, "rolls_json"),
    kept: parseIntegerArray(row.kept_json, "kept_json"),
    total: Number(row.total),
    target: row.target === null ? null : Number(row.target),
    succeeded: row.succeeded === null ? null : Number(row.succeeded) === 1,
    createdAt: Number(row.created_at),
    deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
  };
}

/** Return the durable roll associated with one native tool call. */
export function getDiceRollByRequestKey(db: Database, requestKey: string): DiceRollRow | null {
  const row = db.raw.prepare("SELECT * FROM dice_rolls WHERE request_key = ?").get(requestKey) as Record<string, unknown> | null;
  return row === null ? null : mapDiceRollRow(row);
}

/** Persist a roll once, returning the existing values if the same tool call is retried. */
export function createOrGetDiceRoll(db: Database, input: CreateDiceRollInput): DiceRollRow {
  db.raw.prepare(
    `INSERT OR IGNORE INTO dice_rolls (
      id, request_key, guild_id, channel_id, source_message_id, result_message_id,
      requested_by_user_id, actor_user_id, actor_username, count, sides, modifier,
      mode, label, rolls_json, kept_json, total, target, succeeded, created_at, delivered_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    crypto.randomUUID(),
    input.requestKey,
    input.guildId,
    input.channelId,
    input.sourceMessageId,
    input.requestedByUserId,
    input.actorUserId,
    input.actorUsername,
    input.count,
    input.sides,
    input.modifier,
    input.mode,
    input.label ?? null,
    JSON.stringify(input.rolls),
    JSON.stringify(input.kept),
    input.total,
    input.target ?? null,
    input.target === undefined ? null : input.total >= input.target ? 1 : 0,
    Date.now(),
  );
  const row = getDiceRollByRequestKey(db, input.requestKey);
  if (row === null) throw new Error("Failed to persist dice roll.");
  return row;
}

/** Attach the public Discord result message to the producing instance's audit row. */
export function markDiceRollDelivered(
  db: Database,
  requestKey: string,
  resultMessageId: string,
  deliveredAt = Date.now(),
): DiceRollRow {
  db.raw.prepare(
    `UPDATE dice_rolls
     SET result_message_id = ?, delivered_at = ?
     WHERE request_key = ? AND (result_message_id IS NULL OR result_message_id = ?)`,
  ).run(resultMessageId, deliveredAt, requestKey, resultMessageId);
  const row = getDiceRollByRequestKey(db, requestKey);
  if (row === null || row.resultMessageId !== resultMessageId) {
    throw new Error("Failed to record delivered dice roll message.");
  }
  return row;
}
