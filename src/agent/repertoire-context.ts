import { createHash } from "node:crypto";
import type { RepertoireConfig } from "../config/types.ts";
import type { Database } from "../db/database.ts";

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
  previous_content: string | null;
  previous_is_bot: number | null;
  previous_created_at: number | null;
  reply_id: string | null;
  reply_content: string | null;
  reply_created_at: number | null;
}

interface ExcerptMessage {
  id: string;
  content: string;
  createdAt: number;
}

interface RepertoireExcerpt {
  sourceGuildId: string;
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

// Four slices cap repeat pressure while keeping enough examples in each rotation.
const ROTATION_PARTITIONS = 4;
const cache = new Map<string, CacheEntry>();

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex] as T, result[index] as T];
  }
  return result;
}

function cueFromRow(
  row: CandidateRow,
  mergeGapMs: number,
): ExcerptMessage | undefined {
  if (row.reply_id !== null && row.reply_content !== null && row.reply_created_at !== null) {
    return { id: row.reply_id, content: row.reply_content, createdAt: row.reply_created_at };
  }
  if (
    row.previous_id === null
    || row.previous_content === null
    || row.previous_created_at === null
    || row.previous_is_bot !== 0
    || row.created_at - row.previous_created_at > mergeGapMs
  ) {
    return undefined;
  }
  return {
    id: row.previous_id,
    content: row.previous_content,
    createdAt: row.previous_created_at,
  };
}

function buildChannelExcerpts(
  rows: readonly CandidateRow[],
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
    const cue = cueFromRow(row, mergeGapMs);
    excerpts.push({
      sourceGuildId: row.guild_id,
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

function excerptMessageCount(excerpt: RepertoireExcerpt): number {
  return excerpt.responses.length + (excerpt.cue === undefined ? 0 : 1);
}

function poolMessageCount(excerpts: readonly RepertoireExcerpt[]): number {
  return excerpts.reduce((total, excerpt) => total + excerptMessageCount(excerpt), 0);
}

function orderForTarget(
  excerpts: readonly RepertoireExcerpt[],
  input: RepertoireContextInput,
  random: () => number,
): RepertoireExcerpt[] {
  if (input.random !== undefined) return shuffle(excerpts, random);
  return excerpts
    .map((excerpt) => ({
      excerpt,
      score: createHash("sha256")
        .update(`${input.botUserId}:${input.currentChannelId}:${excerpt.responses[0]?.id ?? ""}`)
        .digest("hex"),
    }))
    .sort((left, right) => left.score.localeCompare(right.score))
    .map(({ excerpt }) => excerpt);
}

function rotationPartition(
  excerpts: readonly RepertoireExcerpt[],
  input: RepertoireContextInput,
  now: number,
  random: () => number,
): RepertoireExcerpt[] {
  const quota = Math.floor(excerpts.length / ROTATION_PARTITIONS);
  if (quota === 0) return [];
  const ordered = orderForTarget(excerpts, input, random);
  const rotation = Math.floor(now / (input.config.refreshMinutes * 60 * 1_000));
  const start = rotation * quota % ordered.length;
  return Array.from(
    { length: quota },
    (_, index) => ordered[(start + index) % ordered.length],
  ).filter((excerpt) => excerpt !== undefined);
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
      : [`User: ${normalizeContent(excerpt.cue.content, foreignGuild)}`]),
    ...excerpt.responses.map(
      (message) => `2B: ${normalizeContent(message.content, foreignGuild)}`,
    ),
  ].join("\n");
}

function selectExcerpts(
  channelExcerpts: readonly RepertoireExcerpt[][],
  input: RepertoireContextInput,
  now: number,
  random: () => number,
): RepertoireExcerpt[] {
  const candidates = channelExcerpts
    .filter((excerpts) => excerpts.length >= ROTATION_PARTITIONS)
    .sort((left, right) => poolMessageCount(right) - poolMessageCount(left))
    .flatMap((excerpts) => rotationPartition(excerpts, input, now, random));
  const selected: RepertoireExcerpt[] = [];
  let messageCount = 0;
  let charCount = input.instruction.trim().length;

  for (const excerpt of candidates) {
    const excerptMessages = excerptMessageCount(excerpt);
    const rendered = renderExcerpt(excerpt, input.currentGuildId);
    if (
      messageCount + excerptMessages > input.config.maxMessages
      || charCount + 2 + rendered.length > input.config.maxChars
    ) {
      continue;
    }
    selected.push(excerpt);
    messageCount += excerptMessages;
    charCount += 2 + rendered.length;
  }
  return selected;
}

function loadChannelExcerpts(
  input: RepertoireContextInput,
  since: number,
): RepertoireExcerpt[][] {
  const sourceChannelStatement = input.db.raw.prepare(
    `SELECT guild_id, channel_id
     FROM messages
     WHERE user_id = ? AND is_bot = 1
       AND channel_id <> ? AND created_at >= ?
       AND is_synthetic = 0 AND is_prompt_only = 0
       AND deleted_at IS NULL AND TRIM(translated_content) <> ''
     GROUP BY guild_id, channel_id
     ORDER BY COUNT(*) DESC, MAX(created_at) DESC, guild_id, channel_id
     LIMIT ?`,
  );
  const sourceChannels = sourceChannelStatement.all(
    input.botUserId,
    input.currentChannelId,
    since,
    input.config.maxSourceChannels,
  ) as SourceChannelRow[];

  const candidateStatement = input.db.raw.prepare(
    `SELECT b.id, b.guild_id, b.channel_id, b.translated_content, b.created_at,
            p.id AS previous_id, p.translated_content AS previous_content,
            p.is_bot AS previous_is_bot, p.created_at AS previous_created_at,
            r.id AS reply_id, r.translated_content AS reply_content,
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
    return buildChannelExcerpts(rows, mergeGapMs);
  });
  return channelExcerpts;
}

function safeCapacity(channelExcerpts: readonly RepertoireExcerpt[][]): number {
  return channelExcerpts
    .filter((excerpts) => excerpts.length >= ROTATION_PARTITIONS)
    .reduce(
      (total, excerpts) => total + Math.floor(poolMessageCount(excerpts) / ROTATION_PARTITIONS),
      0,
    );
}

function loadExcerpts(
  input: RepertoireContextInput,
  now: number,
  random: () => number,
): RepertoireExcerpt[] {
  const lookbackMs = input.config.lookbackHours * 60 * 60 * 1_000;
  let channelExcerpts = loadChannelExcerpts(input, now - lookbackMs);
  if (safeCapacity(channelExcerpts) < input.config.maxMessages) {
    channelExcerpts = loadChannelExcerpts(input, now - lookbackMs * 2);
  }
  return selectExcerpts(channelExcerpts, input, now, random);
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
