import type { Database } from "./database.ts";
import {
  buildRepertoireExchanges,
  type RepertoireCursor,
  type RepertoireExchange,
  type RepertoireSnapshotEntry,
} from "../repertoire/exchanges.ts";

export interface RepertoireRefreshState {
  through: RepertoireCursor | null;
  lastAttemptAt: number;
  lastSuccessAt: number;
}

export interface RepertoireAnchorSelection {
  exchange: RepertoireExchange;
  scope: "profile" | "guild";
  condition: string;
}

interface EntryRow {
  id: string;
  tier: "recent" | "anchor";
  scope_type: "profile" | "guild";
  scope_guild_id: string | null;
  condition_text: string | null;
  source_message_ids_json: string;
  position: number;
  selected_at: number;
  last_selected_at: number;
}

interface SourceRow {
  id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  translated_content: string;
  is_bot: number;
  created_at: number;
  reply_to_id: string | null;
}

function parseSourceIds(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed)
      || parsed.length < 2
      || parsed.some((id) => typeof id !== "string" || id === "")
      || new Set(parsed).size !== parsed.length
    ) {
      return null;
    }
    return parsed as string[];
  } catch {
    return null;
  }
}

function resolveEntry(
  db: Database,
  row: EntryRow,
  botUserId: string,
  mergeMessageGapSeconds: number,
): RepertoireSnapshotEntry | null {
  const sourceIds = parseSourceIds(row.source_message_ids_json);
  if (sourceIds === null) return null;
  const placeholders = sourceIds.map(() => "?").join(",");
  const sourceRows = db.raw.prepare(
    `SELECT id, guild_id, channel_id, user_id, translated_content, is_bot, created_at, reply_to_id
     FROM messages
     WHERE id IN (${placeholders}) AND is_synthetic = 0 AND is_prompt_only = 0
       AND deleted_at IS NULL AND TRIM(translated_content) <> ''`,
  ).all(...sourceIds) as SourceRow[];
  if (sourceRows.length !== sourceIds.length) return null;
  const sourceById = new Map(sourceRows.map((source) => [source.id, source]));
  const cue = sourceById.get(sourceIds[0] ?? "");
  const firstResponse = sourceById.get(sourceIds[1] ?? "");
  const lastResponse = sourceById.get(sourceIds.at(-1) ?? "");
  if (
    cue === undefined
    || firstResponse === undefined
    || lastResponse === undefined
    || cue.is_bot !== 0
    || firstResponse.user_id !== botUserId
  ) {
    return null;
  }

  const rows = db.raw.prepare(
    `SELECT id, guild_id, channel_id, user_id, translated_content, is_bot, created_at, reply_to_id
     FROM messages
     WHERE guild_id = ? AND channel_id = ? AND created_at BETWEEN ? AND ?
       AND is_synthetic = 0 AND is_prompt_only = 0 AND deleted_at IS NULL
       AND TRIM(translated_content) <> ''
     ORDER BY created_at ASC, id ASC`,
  ).all(
    firstResponse.guild_id,
    firstResponse.channel_id,
    firstResponse.reply_to_id === cue.id
      ? firstResponse.created_at
      : Math.min(cue.created_at, firstResponse.created_at),
    lastResponse.created_at,
  ) as SourceRow[];
  if (!rows.some((message) => message.id === cue.id)) rows.unshift(cue);
  const exchange = buildRepertoireExchanges(rows, {
    botUserId,
    responseSince: firstResponse.created_at,
    mergeMessageGapSeconds,
  }).find((candidate) => candidate.id === row.id);
  if (
    exchange === undefined
    || exchange.cue.messageId !== sourceIds[0]
    || exchange.responses.map((response) => response.messageId).join("\0")
      !== sourceIds.slice(1).join("\0")
  ) {
    return null;
  }
  return {
    tier: row.tier,
    condition: row.condition_text,
    position: row.position,
    exchange,
  };
}

function entryRows(db: Database, where: string, ...params: Array<string | number>): EntryRow[] {
  return db.raw.prepare(
    `SELECT id, tier, scope_type, scope_guild_id, condition_text, source_message_ids_json,
       position, selected_at, last_selected_at
     FROM repertoire_entries
     WHERE ${where}
     ORDER BY CASE tier WHEN 'anchor' THEN 0 ELSE 1 END, position ASC, id ASC`,
  ).all(...params) as EntryRow[];
}

/** Load the actor snapshot that applies to the current guild. */
export function loadRepertoireSnapshot(
  db: Database,
  input: {
    currentGuildId: string;
    botUserId: string;
    mergeMessageGapSeconds: number;
  },
): RepertoireSnapshotEntry[] {
  return entryRows(
    db,
    "tier = 'recent' OR (tier = 'anchor' AND (scope_type = 'profile' OR scope_guild_id = ?))",
    input.currentGuildId,
  ).flatMap((row) => {
    const resolved = resolveEntry(db, row, input.botUserId, input.mergeMessageGapSeconds);
    return resolved === null ? [] : [resolved];
  });
}

/** Load every retained anchor as a candidate for the next profile-wide refresh. */
export function loadRepertoireAnchors(
  db: Database,
  botUserId: string,
  mergeMessageGapSeconds: number,
): RepertoireAnchorSelection[] {
  return entryRows(db, "tier = 'anchor'").flatMap((row) => {
    const resolved = resolveEntry(db, row, botUserId, mergeMessageGapSeconds);
    if (resolved === null || row.condition_text === null) return [];
    return [{
      exchange: resolved.exchange,
      scope: row.scope_type,
      condition: row.condition_text,
    }];
  });
}

/** Read the durable profile-wide refresh checkpoint without creating it. */
export function getRepertoireRefreshState(db: Database): RepertoireRefreshState {
  const row = db.raw.prepare(
    `SELECT through_message_id, through_created_at, last_attempt_at, last_success_at
     FROM repertoire_refresh_state WHERE singleton = 1`,
  ).get() as {
    through_message_id: string | null;
    through_created_at: number;
    last_attempt_at: number;
    last_success_at: number;
  } | null;
  return {
    through: row?.through_message_id === null || row?.through_message_id === undefined
      ? null
      : { messageId: row.through_message_id, createdAt: row.through_created_at },
    lastAttemptAt: row?.last_attempt_at ?? 0,
    lastSuccessAt: row?.last_success_at ?? 0,
  };
}

/** Record the attempt before inference so failures respect the retry cooldown. */
export function markRepertoireRefreshAttempt(db: Database, now: number): void {
  db.raw.prepare(
    `INSERT INTO repertoire_refresh_state (singleton, last_attempt_at)
     VALUES (1, ?)
     ON CONFLICT(singleton) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`,
  ).run(now);
}

/** Atomically replace both tiers and advance the successful cursor. */
export function replaceRepertoireSnapshot(
  db: Database,
  input: {
    recent: readonly RepertoireExchange[];
    anchors: readonly RepertoireAnchorSelection[];
    through: RepertoireCursor;
    now: number;
  },
): void {
  db.raw.transaction(() => {
    const previousAnchors = new Map(
      entryRows(db, "tier = 'anchor'").map((row) => [row.id, row]),
    );
    db.raw.prepare("DELETE FROM repertoire_entries").run();
    const insert = db.raw.prepare(
      `INSERT INTO repertoire_entries
       (id, tier, scope_type, scope_guild_id, condition_text, source_message_ids_json,
        position, selected_at, last_selected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [position, exchange] of input.recent.entries()) {
      insert.run(
        exchange.id,
        "recent",
        "profile",
        null,
        null,
        JSON.stringify([
          exchange.cue.messageId,
          ...exchange.responses.map((response) => response.messageId),
        ]),
        position,
        input.now,
        input.now,
      );
    }
    for (const [position, anchor] of input.anchors.entries()) {
      const previous = previousAnchors.get(anchor.exchange.id);
      insert.run(
        anchor.exchange.id,
        "anchor",
        anchor.scope,
        anchor.scope === "guild" ? anchor.exchange.guildId : null,
        anchor.condition,
        JSON.stringify([
          anchor.exchange.cue.messageId,
          ...anchor.exchange.responses.map((response) => response.messageId),
        ]),
        position,
        previous?.selected_at ?? input.now,
        input.now,
      );
    }
    db.raw.prepare(
      `INSERT INTO repertoire_refresh_state
       (singleton, through_message_id, through_created_at, last_attempt_at, last_success_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         through_message_id = excluded.through_message_id,
         through_created_at = excluded.through_created_at,
         last_attempt_at = excluded.last_attempt_at,
         last_success_at = excluded.last_success_at`,
    ).run(
      input.through.messageId,
      input.through.createdAt,
      input.now,
      input.now,
    );
  })();
}
