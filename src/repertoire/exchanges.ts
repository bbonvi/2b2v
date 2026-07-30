import type { Database } from "../db/database.ts";

export interface RepertoireExchange {
  id: string;
  guildId: string;
  channelId: string;
  cue: { messageId: string; text: string };
  responses: Array<{ messageId: string; text: string }>;
  respondedAt: number;
}

export interface RepertoireCursor {
  messageId: string;
  createdAt: number;
}

export interface RepertoireSnapshotEntry {
  tier: "recent" | "anchor";
  condition: string | null;
  position: number;
  exchange: RepertoireExchange;
}

interface ExchangeMessageRow {
  id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  translated_content: string;
  is_bot: number;
  created_at: number;
  reply_to_id: string | null;
}

const MAX_EXCHANGE_MESSAGE_CHARS = 1_000;
const MIN_CUE_LOOKBACK_MS = 15 * 60 * 1_000;

function boundedText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_EXCHANGE_MESSAGE_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_EXCHANGE_MESSAGE_CHARS - 1)}…`;
}

function beforeOrAt(row: ExchangeMessageRow, cursor: RepertoireCursor): boolean {
  return row.created_at < cursor.createdAt
    || (row.created_at === cursor.createdAt && row.id <= cursor.messageId);
}

/** Build grounded human-cue/2B-response exchanges from chronological visible rows. */
export function buildRepertoireExchanges(
  rows: readonly ExchangeMessageRow[],
  input: {
    botUserId: string;
    responseSince: number;
    mergeMessageGapSeconds: number;
  },
): RepertoireExchange[] {
  const cueLookbackMs = Math.max(
    MIN_CUE_LOOKBACK_MS,
    input.mergeMessageGapSeconds * 1_000,
  );
  const humanById = new Map<string, ExchangeMessageRow>();
  let latestHuman: ExchangeMessageRow | undefined;
  let current: RepertoireExchange | undefined;
  let currentLastResponseAt = 0;
  const exchanges: RepertoireExchange[] = [];

  for (const row of rows) {
    if (row.is_bot === 0) {
      humanById.set(row.id, row);
      latestHuman = row;
      current = undefined;
      currentLastResponseAt = 0;
      continue;
    }
    if (row.user_id !== input.botUserId || row.created_at < input.responseSince) continue;

    const previousResponse = current?.responses.at(-1);
    if (
      current !== undefined
      && previousResponse !== undefined
      && row.created_at - currentLastResponseAt <= input.mergeMessageGapSeconds * 1_000
    ) {
      current.responses.push({ messageId: row.id, text: boundedText(row.translated_content) });
      currentLastResponseAt = row.created_at;
      continue;
    }

    const repliedCue = row.reply_to_id === null ? undefined : humanById.get(row.reply_to_id);
    const precedingCue = latestHuman !== undefined
      && row.created_at - latestHuman.created_at <= cueLookbackMs
      ? latestHuman
      : undefined;
    const cue = repliedCue ?? precedingCue;
    if (cue === undefined) {
      current = undefined;
      currentLastResponseAt = 0;
      continue;
    }

    current = {
      id: row.id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      cue: { messageId: cue.id, text: boundedText(cue.translated_content) },
      responses: [{ messageId: row.id, text: boundedText(row.translated_content) }],
      respondedAt: row.created_at,
    };
    currentLastResponseAt = row.created_at;
    exchanges.push(current);
  }
  return exchanges;
}

/** Return the latest eligible message cursor for the selected bot identity. */
export function getLatestEligibleBotCursor(
  db: Database,
  botUserId: string,
): RepertoireCursor | null {
  const row = db.raw.prepare(
    `SELECT id, created_at
     FROM messages
     WHERE user_id = ? AND is_bot = 1 AND is_synthetic = 0 AND is_prompt_only = 0
       AND deleted_at IS NULL AND TRIM(translated_content) <> ''
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).get(botUserId) as { id: string; created_at: number } | null;
  return row === null ? null : { messageId: row.id, createdAt: row.created_at };
}

/** Count eligible bot output strictly after a durable refresh cursor. */
export function countEligibleBotMessagesAfter(
  db: Database,
  botUserId: string,
  cursor: RepertoireCursor | null,
): number {
  const row = cursor === null
    ? db.raw.prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE user_id = ? AND is_bot = 1 AND is_synthetic = 0 AND is_prompt_only = 0
           AND deleted_at IS NULL AND TRIM(translated_content) <> ''`,
      ).get(botUserId)
    : db.raw.prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE user_id = ? AND is_bot = 1 AND is_synthetic = 0 AND is_prompt_only = 0
           AND deleted_at IS NULL AND TRIM(translated_content) <> ''
           AND (created_at > ? OR (created_at = ? AND id > ?))`,
      ).get(botUserId, cursor.createdAt, cursor.createdAt, cursor.messageId);
  return (row as { count: number } | null)?.count ?? 0;
}

/** Select bounded recent exchanges from channels ranked by recent eligible 2B output. */
export function listRepertoireExchanges(
  db: Database,
  input: {
    botUserId: string;
    since: number;
    through: RepertoireCursor;
    mergeMessageGapSeconds: number;
    maxCandidates: number;
    maxSourceChannels: number;
    maxEntriesPerChannel: number;
    maxEntriesPerGuild: number;
  },
): RepertoireExchange[] {
  const channels = db.raw.prepare(
    `SELECT guild_id, channel_id, COUNT(*) AS message_count, MAX(created_at) AS latest_at
     FROM messages
     WHERE user_id = ? AND is_bot = 1 AND is_synthetic = 0 AND is_prompt_only = 0
       AND deleted_at IS NULL AND TRIM(translated_content) <> '' AND created_at >= ?
       AND (created_at < ? OR (created_at = ? AND id <= ?))
     GROUP BY guild_id, channel_id
     ORDER BY message_count DESC, latest_at DESC, guild_id ASC, channel_id ASC
     LIMIT ?`,
  ).all(
    input.botUserId,
    input.since,
    input.through.createdAt,
    input.through.createdAt,
    input.through.messageId,
    input.maxSourceChannels,
  ) as Array<{ guild_id: string; channel_id: string }>;

  const cueSince = input.since - Math.max(
    MIN_CUE_LOOKBACK_MS,
    input.mergeMessageGapSeconds * 1_000,
  );
  const candidates: RepertoireExchange[] = [];
  for (const channel of channels) {
    const rows = db.raw.prepare(
      `SELECT id, guild_id, channel_id, user_id, translated_content, is_bot, created_at, reply_to_id
       FROM messages
       WHERE guild_id = ? AND channel_id = ? AND created_at >= ?
         AND (created_at < ? OR (created_at = ? AND id <= ?))
         AND is_synthetic = 0 AND is_prompt_only = 0 AND deleted_at IS NULL
         AND TRIM(translated_content) <> ''
       ORDER BY created_at ASC, id ASC`,
    ).all(
      channel.guild_id,
      channel.channel_id,
      cueSince,
      input.through.createdAt,
      input.through.createdAt,
      input.through.messageId,
    ) as ExchangeMessageRow[];
    const rowIds = new Set(rows.map((row) => row.id));
    const missingReplyIds = [...new Set(rows.flatMap((row) => (
      row.user_id === input.botUserId
      && row.reply_to_id !== null
      && !rowIds.has(row.reply_to_id)
        ? [row.reply_to_id]
        : []
    )))];
    const directCues = missingReplyIds.length === 0
      ? []
      : db.raw.prepare(
          `SELECT id, guild_id, channel_id, user_id, translated_content, is_bot, created_at, reply_to_id
           FROM messages
           WHERE id IN (${missingReplyIds.map(() => "?").join(",")})
             AND guild_id = ? AND channel_id = ? AND is_bot = 0
             AND is_synthetic = 0 AND is_prompt_only = 0 AND deleted_at IS NULL
             AND TRIM(translated_content) <> ''`,
        ).all(...missingReplyIds, channel.guild_id, channel.channel_id) as ExchangeMessageRow[];
    const boundedRows = [...rows, ...directCues]
      .filter((row) => beforeOrAt(row, input.through))
      .sort((a, b) => {
        const time = a.created_at - b.created_at;
        return time !== 0 ? time : a.id.localeCompare(b.id);
      });
    const channelExchanges = buildRepertoireExchanges(boundedRows, {
      botUserId: input.botUserId,
      responseSince: input.since,
      mergeMessageGapSeconds: input.mergeMessageGapSeconds,
    });
    candidates.push(...channelExchanges.slice(-input.maxEntriesPerChannel));
  }

  const guildCounts = new Map<string, number>();
  const selected: RepertoireExchange[] = [];
  for (const exchange of candidates.sort((a, b) => {
    const time = b.respondedAt - a.respondedAt;
    return time !== 0 ? time : b.id.localeCompare(a.id);
  })) {
    const guildCount = guildCounts.get(exchange.guildId) ?? 0;
    if (guildCount >= input.maxEntriesPerGuild) continue;
    selected.push(exchange);
    guildCounts.set(exchange.guildId, guildCount + 1);
    if (selected.length >= input.maxCandidates) break;
  }
  return selected.sort((a, b) => {
    const time = a.respondedAt - b.respondedAt;
    return time !== 0 ? time : a.id.localeCompare(b.id);
  });
}

/** Normalize custom emotes that cannot be resolved in the current guild. */
export function normalizeRepertoireEmotes(
  text: string,
  sourceGuildId: string,
  currentGuildId: string,
): string {
  if (sourceGuildId === currentGuildId) return text;
  return text.replace(/<a?:([A-Za-z0-9_]+):\d+>/g, ":$1:");
}

function renderExchange(
  entry: RepertoireSnapshotEntry,
  currentGuildId: string,
): string {
  const normalize = (text: string): string => normalizeRepertoireEmotes(
    text,
    entry.exchange.guildId,
    currentGuildId,
  );
  const heading = entry.tier === "anchor"
    ? `### Anchor example — use when: ${normalize(entry.condition ?? "")}`
    : "### Recent example";
  return [
    heading,
    `Participant: ${normalize(entry.exchange.cue.text)}`,
    ...entry.exchange.responses.map((response) => `2B: ${normalize(response.text)}`),
  ].join("\n");
}

/** Render one stable actor section, prioritizing anchors and enforcing hard caps. */
export function renderRepertoireContext(input: {
  instruction: string;
  entries: readonly RepertoireSnapshotEntry[];
  currentGuildId: string;
  maxEntriesPerChannel: number;
  maxChars: number;
}): string {
  const ordered = [...input.entries].sort((a, b) => {
    const tier = (a.tier === "anchor" ? 0 : 1) - (b.tier === "anchor" ? 0 : 1);
    if (tier !== 0) return tier;
    const position = a.position - b.position;
    return position !== 0 ? position : a.exchange.id.localeCompare(b.exchange.id);
  });
  const channelCounts = new Map<string, number>();
  const prefix = input.instruction.trim();
  const blocks: string[] = [];
  let length = prefix.length;

  for (const entry of ordered) {
    const channelCount = channelCounts.get(entry.exchange.channelId) ?? 0;
    if (channelCount >= input.maxEntriesPerChannel) continue;
    const block = renderExchange(entry, input.currentGuildId);
    const addedLength = (length === 0 ? 0 : 2) + block.length;
    if (length + addedLength > input.maxChars) continue;
    blocks.push(block);
    length += addedLength;
    channelCounts.set(entry.exchange.channelId, channelCount + 1);
  }
  if (blocks.length === 0) return "";
  return [prefix, blocks.join("\n\n")].filter((part) => part !== "").join("\n\n");
}

/** Render candidates with stable IDs and source scope for the private selector pass. */
export function renderRepertoireCandidates(
  candidates: readonly RepertoireExchange[],
): string {
  return candidates.map((exchange) => [
    `### Candidate ${exchange.id}`,
    `Source guild ID: ${exchange.guildId}`,
    `Source channel ID: ${exchange.channelId}`,
    `Participant: ${exchange.cue.text}`,
    ...exchange.responses.map((response) => `2B: ${response.text}`),
  ].join("\n")).join("\n\n");
}
