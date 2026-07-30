import type { RepertoireConfig } from "../config/types.ts";
import type { Database } from "../db/database.ts";

type ExcerptKind = "mention" | "reply" | "adjacent" | "standalone";

interface SourceChannelRow {
  guild_id: string;
  channel_id: string;
}

interface CandidateRow {
  id: string;
  guild_id: string;
  channel_id: string;
  translated_content: string;
  created_at: number;
  previous_id: string | null;
  previous_raw_content: string | null;
  previous_content: string | null;
  previous_is_bot: number | null;
  previous_created_at: number | null;
  reply_id: string | null;
  reply_raw_content: string | null;
  reply_content: string | null;
  reply_created_at: number | null;
}

interface ExcerptMessage {
  id: string;
  content: string;
  createdAt: number;
}

interface RepertoireExcerpt {
  kind: ExcerptKind;
  sourceGuildId: string;
  sourceChannelId: string;
  cue?: ExcerptMessage;
  responses: ExcerptMessage[];
}

interface CacheEntry {
  expiresAt: number;
  fingerprint: string;
  excerpts: RepertoireExcerpt[];
}

export interface RepertoireContextInput {
  db: Database;
  config: RepertoireConfig;
  instruction: string;
  botUserId: string;
  currentGuildId: string;
  currentChannelId: string;
  mergeMessageGapSeconds: number;
  now?: number;
  random?: () => number;
}

const EXCERPT_KINDS: readonly ExcerptKind[] = ["mention", "reply", "adjacent", "standalone"];
const cache = new Map<string, CacheEntry>();

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex] as T, result[index] as T];
  }
  return result;
}

function mentionsBot(rawContent: string, botUserId: string): boolean {
  return rawContent.includes(`<@${botUserId}>`) || rawContent.includes(`<@!${botUserId}>`);
}

function cueFromRow(
  row: CandidateRow,
  botUserId: string,
  mergeGapMs: number,
): { cue?: ExcerptMessage; kind: ExcerptKind } {
  if (row.reply_id !== null && row.reply_content !== null && row.reply_created_at !== null) {
    return {
      cue: { id: row.reply_id, content: row.reply_content, createdAt: row.reply_created_at },
      kind: mentionsBot(row.reply_raw_content ?? "", botUserId) ? "mention" : "reply",
    };
  }
  if (
    row.previous_id === null
    || row.previous_content === null
    || row.previous_created_at === null
    || row.previous_is_bot !== 0
    || row.created_at - row.previous_created_at > mergeGapMs
  ) {
    return { kind: "standalone" };
  }
  return {
    cue: {
      id: row.previous_id,
      content: row.previous_content,
      createdAt: row.previous_created_at,
    },
    kind: mentionsBot(row.previous_raw_content ?? "", botUserId) ? "mention" : "adjacent",
  };
}

function buildChannelExcerpts(
  rows: readonly CandidateRow[],
  botUserId: string,
  mergeGapMs: number,
): RepertoireExcerpt[] {
  const excerpts: RepertoireExcerpt[] = [];
  for (const row of rows) {
    const previousExcerpt = excerpts.at(-1);
    const previousResponse = previousExcerpt?.responses.at(-1);
    if (
      previousExcerpt !== undefined
      && previousResponse !== undefined
      && row.previous_id === previousResponse.id
      && row.created_at - previousResponse.createdAt <= mergeGapMs
    ) {
      previousExcerpt.responses.push({
        id: row.id,
        content: row.translated_content,
        createdAt: row.created_at,
      });
      continue;
    }
    const { cue, kind } = cueFromRow(row, botUserId, mergeGapMs);
    excerpts.push({
      kind,
      sourceGuildId: row.guild_id,
      sourceChannelId: row.channel_id,
      ...(cue === undefined ? {} : { cue }),
      responses: [{
        id: row.id,
        content: row.translated_content,
        createdAt: row.created_at,
      }],
    });
  }
  return excerpts;
}

function orderByKind(
  excerpts: readonly RepertoireExcerpt[],
  random: () => number,
): RepertoireExcerpt[] {
  const queues = shuffle(
    EXCERPT_KINDS
      .map((kind) => shuffle(excerpts.filter((excerpt) => excerpt.kind === kind), random))
      .filter((queue) => queue.length > 0),
    random,
  );
  const ordered: RepertoireExcerpt[] = [];
  while (queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const excerpt = queue.shift();
      if (excerpt !== undefined) ordered.push(excerpt);
    }
  }
  return ordered;
}

function normalizeContent(content: string, foreignGuild: boolean): string {
  if (!foreignGuild) return content;
  return content.replace(/<a?:([A-Za-z0-9_]+):\d+>/g, ":$1:");
}

function renderExcerpt(excerpt: RepertoireExcerpt, currentGuildId: string): string {
  const foreignGuild = excerpt.sourceGuildId !== currentGuildId;
  return [
    ...(excerpt.cue === undefined
      ? []
      : [`Participant: ${normalizeContent(excerpt.cue.content, foreignGuild)}`]),
    ...excerpt.responses.map(
      (message) => `2B: ${normalizeContent(message.content, foreignGuild)}`,
    ),
  ].join("\n");
}

function selectExcerpts(
  channelExcerpts: readonly RepertoireExcerpt[][],
  input: RepertoireContextInput,
  random: () => number,
): RepertoireExcerpt[] {
  const queues = shuffle(
    channelExcerpts.map((excerpts) => orderByKind(excerpts, random)),
    random,
  );
  const selected: RepertoireExcerpt[] = [];
  let messageCount = 0;
  let charCount = input.instruction.trim().length;

  while (queues.some((queue) => queue.length > 0)) {
    let added = false;
    for (const queue of queues) {
      while (queue.length > 0) {
        const excerpt = queue.shift();
        if (excerpt === undefined) break;
        const excerptMessageCount = excerpt.responses.length + (excerpt.cue === undefined ? 0 : 1);
        const rendered = renderExcerpt(excerpt, input.currentGuildId);
        if (
          messageCount + excerptMessageCount > input.config.maxMessages
          || charCount + 2 + rendered.length > input.config.maxChars
        ) {
          continue;
        }
        selected.push(excerpt);
        messageCount += excerptMessageCount;
        charCount += 2 + rendered.length;
        added = true;
        break;
      }
    }
    if (!added) break;
  }
  return selected;
}

function loadExcerpts(
  input: RepertoireContextInput,
  now: number,
  random: () => number,
): RepertoireExcerpt[] {
  const since = now - input.config.lookbackHours * 60 * 60 * 1_000;
  const sourceChannels = input.db.raw.prepare(
    `SELECT guild_id, channel_id
     FROM messages
     WHERE user_id = ? AND is_bot = 1
       AND channel_id <> ? AND created_at >= ?
       AND is_synthetic = 0 AND is_prompt_only = 0
       AND deleted_at IS NULL AND TRIM(translated_content) <> ''
     GROUP BY guild_id, channel_id
     ORDER BY COUNT(*) DESC, MAX(created_at) DESC, guild_id, channel_id
     LIMIT ?`,
  ).all(
    input.botUserId,
    input.currentChannelId,
    since,
    input.config.maxSourceChannels,
  ) as SourceChannelRow[];

  const candidateStatement = input.db.raw.prepare(
    `SELECT b.id, b.guild_id, b.channel_id, b.translated_content, b.created_at,
            p.id AS previous_id, p.raw_content AS previous_raw_content,
            p.translated_content AS previous_content,
            p.is_bot AS previous_is_bot, p.created_at AS previous_created_at,
            r.id AS reply_id, r.raw_content AS reply_raw_content,
            r.translated_content AS reply_content,
            r.created_at AS reply_created_at
     FROM messages b
     LEFT JOIN messages r
       ON r.id = b.reply_to_id AND r.guild_id = b.guild_id AND r.channel_id = b.channel_id
      AND r.is_bot = 0 AND r.is_synthetic = 0 AND r.is_prompt_only = 0
      AND r.deleted_at IS NULL AND TRIM(r.translated_content) <> ''
     LEFT JOIN messages p ON p.id = (
       SELECT p2.id
       FROM messages p2
       WHERE p2.guild_id = b.guild_id AND p2.channel_id = b.channel_id
         AND (p2.created_at < b.created_at OR (p2.created_at = b.created_at AND p2.id < b.id))
         AND p2.is_synthetic = 0 AND p2.is_prompt_only = 0
         AND p2.deleted_at IS NULL AND TRIM(p2.translated_content) <> ''
       ORDER BY p2.created_at DESC, p2.id DESC
       LIMIT 1
     )
     WHERE b.guild_id = ? AND b.channel_id = ? AND b.user_id = ? AND b.is_bot = 1
       AND b.created_at >= ? AND b.is_synthetic = 0 AND b.is_prompt_only = 0
       AND b.deleted_at IS NULL AND TRIM(b.translated_content) <> ''
     ORDER BY b.created_at ASC, b.id ASC`,
  );

  const mergeGapMs = input.mergeMessageGapSeconds * 1_000;
  const channelExcerpts = sourceChannels.map((source) => {
    const rows = candidateStatement.all(
      source.guild_id,
      source.channel_id,
      input.botUserId,
      since,
    ) as CandidateRow[];
    return buildChannelExcerpts(rows, input.botUserId, mergeGapMs);
  });
  return selectExcerpts(channelExcerpts, input, random);
}

/** Build the periodically rotated, cross-room repertoire section for an actor turn. */
export function buildRepertoireContext(input: RepertoireContextInput): string {
  if (!input.config.enabled) return "";
  const instruction = input.instruction.trim();
  if (instruction === "" || instruction.length >= input.config.maxChars) return "";

  const now = input.now ?? Date.now();
  const random = input.random ?? Math.random;
  const cacheKey = `${input.botUserId}:${input.currentChannelId}`;
  const fingerprint = JSON.stringify([input.config, instruction, input.mergeMessageGapSeconds]);
  let entry = cache.get(cacheKey);
  if (entry === undefined || entry.expiresAt <= now || entry.fingerprint !== fingerprint) {
    entry = {
      expiresAt: now + input.config.refreshMinutes * 60 * 1_000,
      fingerprint,
      excerpts: loadExcerpts(input, now, random),
    };
    cache.set(cacheKey, entry);
  }
  if (entry.excerpts.length === 0) return "";
  return [
    instruction,
    ...entry.excerpts.map((excerpt) => renderExcerpt(excerpt, input.currentGuildId)),
  ].join("\n\n");
}
