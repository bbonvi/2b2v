import type { Database } from "../db/database";
import { formatElapsedDuration } from "../time/agent-time";
import { escapeRegex } from "./triggers";

const DIRECT_GAP_MS = 30 * 60 * 1000;
const TURN_MERGE_MS = 30 * 1000;
const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SALIENCE_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;
const STALE_CONTACT_MS = 30 * 24 * 60 * 60 * 1000;
const COLD_CONTACT_MS = 90 * 24 * 60 * 60 * 1000;
const URL_RE = /https?:\/\/\S+/i;

interface ContactMessageRow {
  id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  author_username: string;
  raw_content: string;
  translated_content: string;
  created_at: number;
  reply_to_id: string | null;
  is_bot: number;
}

interface ContactTurn {
  ids: string[];
  guild_id: string;
  channel_id: string;
  user_id: string;
  author_username: string;
  raw_content: string;
  translated_content: string;
  created_at: number;
  last_at: number;
  reply_to_ids: string[];
  is_bot: number;
}

interface UserContactStats {
  userId: string;
  username: string;
  totalMessages: number;
  localChannelMessages: number;
  directContactEvents: number;
  userToBotEvents: number;
  botToUserEvents: number;
  contactGuilds: Set<string>;
  contactChannels: Set<string>;
  activeContactDays: Set<string>;
  firstContactAt: number | null;
  lastContactAt: number | null;
  lastUserToBotAt: number | null;
  lastBotToUserAt: number | null;
  dialogueRunCount: number;
  multiTurnRunCount: number;
  longestRunTurns: number;
  recentContactEvents: number;
  recentContactWeight: number;
  recentDialogueTurns: number;
  instrumentalBotReplies: number;
  memoryCount: number;
  memoryRank: number | null;
  oneDayContactMax: number;
  familiarityScore: number;
  salienceScore: number;
  directRank: number | null;
  salienceRank: number | null;
}

interface ActiveDialogueRun {
  userId: string;
  channelId: string;
  lastAt: number;
  lastSpeaker: "user" | "bot";
  turns: number;
}

interface ContactEvent {
  userId: string;
  username: string;
  guildId: string;
  channelId: string;
  createdAt: number;
  direction: "user_to_bot" | "bot_to_user";
  instrumental: boolean;
}

export interface ComputedContactContext {
  userId: string;
  username: string;
  familiarityScore: number;
  salienceScore: number;
  directRank: number | null;
  salienceRank: number | null;
  directContactEvents: number;
  activeContactDays: number;
  contactGuilds: number;
  contactChannels: number;
  totalMessages: number;
  localChannelMessages: number;
  dialogueRunCount: number;
  multiTurnRunCount: number;
  longestRunTurns: number;
  recentContactEvents: number;
  recentContactWeight: number;
  instrumentalBotReplies: number;
  memoryCount: number;
  memoryRank: number | null;
  firstContactAt: number | null;
  lastContactAt: number | null;
  lastUserToBotAt: number | null;
  lastBotToUserAt: number | null;
  rendered: string;
}

interface BuildContactContextsInput {
  db: Database;
  botUserId: string;
  /** Fallback names and trigger keywords that count as direct address. */
  botAddressAliases?: readonly string[];
  /** Resolve names and trigger keywords for each historical guild. */
  botAddressAliasesForGuild?: (guildId: string) => readonly string[];
  now?: number;
  currentChannelId?: string;
  beforeCreatedAt?: number;
  beforeMessageId?: string;
}

/** Build deterministic user-to-bot familiarity context from stored chat history. */
export function buildComputedContactContexts(input: BuildContactContextsInput): ComputedContactContext[] {
  const now = input.now ?? Date.now();
  const addressPatterns = new Map<string, RegExp | null>();
  const botAddressPatternForGuild = (guildId: string): RegExp | null => {
    const cached = addressPatterns.get(guildId);
    if (cached !== undefined || addressPatterns.has(guildId)) return cached ?? null;
    const addressAliases = [...new Set(
      (input.botAddressAliasesForGuild?.(guildId) ?? input.botAddressAliases ?? [])
        .map((alias) => alias.trim())
        .filter((alias) => alias !== "")
        .map((alias) => alias.toLocaleLowerCase()),
    )];
    const pattern = addressAliases.length > 0
      ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${addressAliases.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}])`, "iu")
      : null;
    addressPatterns.set(guildId, pattern);
    return pattern;
  };
  const rows = loadContactRows(input);
  const turns = mergeContactTurns(rows);
  const visualAssetMessageIds = loadVisualAssetMessageIds(input.db);
  const memoryCounts = loadUserMemoryCounts(input.db, now);
  const stats = new Map<string, UserContactStats>();
  const messageUser = new Map<string, string>();
  const botMessageIds = new Set<string>();
  const lastByChannel = new Map<string, ContactTurn>();
  const activeRuns = new Map<string, ActiveDialogueRun>();
  const contactEvents: ContactEvent[] = [];
  const contactDaysByUser = new Map<string, Map<string, number>>();

  for (const row of rows) {
    messageUser.set(row.id, row.user_id);
    if (row.is_bot === 1 && row.user_id === input.botUserId) botMessageIds.add(row.id);
  }

  for (const turn of turns) {
    const isBot = turn.is_bot === 1 && turn.user_id === input.botUserId;
    if (!isBot) {
      const userStats = ensureStats(stats, turn.user_id, turn.author_username);
      userStats.totalMessages += 1;
      if (input.currentChannelId !== undefined && turn.channel_id === input.currentChannelId) {
        userStats.localChannelMessages += 1;
      }
      userStats.username = turn.author_username;
    }

    const previous = lastByChannel.get(turn.channel_id);
    const event = contactEventForTurn(
      turn,
      previous,
      input.botUserId,
      botAddressPatternForGuild(turn.guild_id),
      botMessageIds,
      messageUser,
      visualAssetMessageIds,
    );
    if (event !== null) {
      const userStats = ensureStats(stats, event.userId, event.username);
      addContactEvent(userStats, event, now, contactDaysByUser);
      contactEvents.push(event);
      updateDialogueRun(userStats, activeRuns, event);
    }

    lastByChannel.set(turn.channel_id, turn);
  }

  closeDialogueRuns(stats, activeRuns);
  for (const [userId, count] of memoryCounts) {
    const existing = stats.get(userId);
    if (existing !== undefined) existing.memoryCount = count;
  }
  for (const [userId, dayCounts] of contactDaysByUser) {
    const userStats = stats.get(userId);
    if (userStats === undefined) continue;
    userStats.oneDayContactMax = Math.max(...dayCounts.values());
  }

  const activeStats = [...stats.values()].filter((item) => item.directContactEvents > 0);
  const familiarityPopulation = activeStats.filter(isFamiliarityRankEligible);
  for (const item of activeStats) {
    item.familiarityScore = computeFamiliarityScore(item, familiarityPopulation, now);
  }
  assignRanks(activeStats, "directContactEvents", "directRank");
  assignRanks(activeStats, "recentContactWeight", "salienceRank");
  assignRanks(activeStats, "memoryCount", "memoryRank");
  for (const item of activeStats) {
    item.salienceScore = computeSalienceScore(item, activeStats, now);
  }

  return activeStats
    .map((item) => ({
      userId: item.userId,
      username: item.username,
      familiarityScore: item.familiarityScore,
      salienceScore: item.salienceScore,
      directRank: item.directRank,
      salienceRank: item.salienceRank,
      directContactEvents: item.directContactEvents,
      activeContactDays: item.activeContactDays.size,
      contactGuilds: item.contactGuilds.size,
      contactChannels: item.contactChannels.size,
      totalMessages: item.totalMessages,
      localChannelMessages: item.localChannelMessages,
      dialogueRunCount: item.dialogueRunCount,
      multiTurnRunCount: item.multiTurnRunCount,
      longestRunTurns: item.longestRunTurns,
      recentContactEvents: item.recentContactEvents,
      recentContactWeight: item.recentContactWeight,
      instrumentalBotReplies: item.instrumentalBotReplies,
      memoryCount: item.memoryCount,
      memoryRank: item.memoryRank,
      firstContactAt: item.firstContactAt,
      lastContactAt: item.lastContactAt,
      lastUserToBotAt: item.lastUserToBotAt,
      lastBotToUserAt: item.lastBotToUserAt,
      rendered: renderContactContext(item, now, input.currentChannelId !== undefined),
    }))
    .sort((a, b) => {
      const familiarityDiff = b.familiarityScore - a.familiarityScore;
      if (familiarityDiff !== 0) return familiarityDiff;
      return b.salienceScore - a.salienceScore;
    });
}

export function buildComputedContactContextForUser(
  input: BuildContactContextsInput & { userId: string },
): ComputedContactContext | null {
  return buildComputedContactContexts(input).find((item) => item.userId === input.userId) ?? null;
}

function loadContactRows(input: BuildContactContextsInput): ContactMessageRow[] {
  const conditions = ["is_synthetic = 0", "is_prompt_only = 0"];
  const params: Array<string | number> = [];
  if (input.beforeCreatedAt !== undefined) {
    conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(input.beforeCreatedAt, input.beforeCreatedAt, input.beforeMessageId ?? "");
  }
  return input.db.raw
    .prepare(
      `SELECT id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, created_at, reply_to_id, is_bot
       FROM messages
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at ASC, id ASC`
    )
    .all(...params) as ContactMessageRow[];
}

function mergeContactTurns(rows: ContactMessageRow[]): ContactTurn[] {
  const turns: ContactTurn[] = [];
  for (const row of rows) {
    const previous = turns[turns.length - 1];
    if (previous !== undefined
      && previous.guild_id === row.guild_id
      && previous.channel_id === row.channel_id
      && previous.user_id === row.user_id
      && previous.is_bot === row.is_bot
      && row.created_at - previous.last_at <= TURN_MERGE_MS) {
      previous.ids.push(row.id);
      previous.raw_content = joinTurnText(previous.raw_content, row.raw_content);
      previous.translated_content = joinTurnText(previous.translated_content, row.translated_content);
      previous.last_at = row.created_at;
      if (row.reply_to_id !== null) previous.reply_to_ids.push(row.reply_to_id);
      continue;
    }

    turns.push({
      ids: [row.id],
      guild_id: row.guild_id,
      channel_id: row.channel_id,
      user_id: row.user_id,
      author_username: row.author_username,
      raw_content: row.raw_content,
      translated_content: row.translated_content,
      created_at: row.created_at,
      last_at: row.created_at,
      reply_to_ids: row.reply_to_id !== null ? [row.reply_to_id] : [],
      is_bot: row.is_bot,
    });
  }
  return turns;
}

function joinTurnText(left: string, right: string): string {
  if (left === "") return right;
  if (right === "") return left;
  return `${left}\n${right}`;
}

function loadVisualAssetMessageIds(db: Database): Set<string> {
  const rows = db.raw
    .prepare("SELECT DISTINCT message_id FROM message_assets WHERE kind IN ('image', 'gif', 'video')")
    .all() as Array<{ message_id: string }>;
  return new Set(rows.map((row) => row.message_id));
}

function loadUserMemoryCounts(db: Database, now: number): Map<string, number> {
  const rows = db.raw
    .prepare(
      `SELECT about_user_id, COUNT(*) AS count
       FROM memories
       WHERE about_type = 'user'
         AND recall_scope = 'anywhere'
         AND about_user_id IS NOT NULL
         AND deleted_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       GROUP BY about_user_id`
    )
    .all(now) as Array<{ about_user_id: string; count: number }>;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.about_user_id, row.count);
  return counts;
}

function ensureStats(stats: Map<string, UserContactStats>, userId: string, username: string): UserContactStats {
  let existing = stats.get(userId);
  if (existing !== undefined) return existing;
  existing = {
    userId,
    username,
    totalMessages: 0,
    localChannelMessages: 0,
    directContactEvents: 0,
    userToBotEvents: 0,
    botToUserEvents: 0,
    contactGuilds: new Set(),
    contactChannels: new Set(),
    activeContactDays: new Set(),
    firstContactAt: null,
    lastContactAt: null,
    lastUserToBotAt: null,
    lastBotToUserAt: null,
    dialogueRunCount: 0,
    multiTurnRunCount: 0,
    longestRunTurns: 0,
    recentContactEvents: 0,
    recentContactWeight: 0,
    recentDialogueTurns: 0,
    instrumentalBotReplies: 0,
    memoryCount: 0,
    memoryRank: null,
    oneDayContactMax: 0,
    familiarityScore: 0,
    salienceScore: 0,
    directRank: null,
    salienceRank: null,
  };
  stats.set(userId, existing);
  return existing;
}

function contactEventForTurn(
  turn: ContactTurn,
  previous: ContactTurn | undefined,
  botUserId: string,
  botAddressPattern: RegExp | null,
  botMessageIds: Set<string>,
  messageUser: Map<string, string>,
  visualAssetMessageIds: Set<string>,
): ContactEvent | null {
  const isBot = turn.is_bot === 1 && turn.user_id === botUserId;
  const previousIsClose = previous !== undefined
    && turn.created_at - previous.last_at <= DIRECT_GAP_MS;
  if (!isBot) {
    const repliedToBot = turn.reply_to_ids.some((replyToId) => botMessageIds.has(replyToId));
    const followsBot = previousIsClose && previous.is_bot === 1 && previous.user_id === botUserId;
    const namesBot = botAddressPattern?.test(turn.translated_content) ?? false;
    const mentionsBot = turn.raw_content.includes(`<@${botUserId}>`) || turn.raw_content.includes(`<@!${botUserId}>`);
    if (!repliedToBot && !followsBot && !namesBot && !mentionsBot) return null;
    return {
      userId: turn.user_id,
      username: turn.author_username,
      guildId: turn.guild_id,
      channelId: turn.channel_id,
      createdAt: turn.last_at,
      direction: "user_to_bot",
      instrumental: false,
    };
  }

  const instrumental = botReplyLooksInstrumental(turn, visualAssetMessageIds);
  let repliedUserId: string | undefined;
  for (const replyToId of turn.reply_to_ids) {
    repliedUserId = messageUser.get(replyToId);
    if (repliedUserId !== undefined) break;
  }
  if (repliedUserId !== undefined && repliedUserId !== botUserId) {
    return {
      userId: repliedUserId,
      username: previous !== undefined && previous.user_id === repliedUserId ? previous.author_username : repliedUserId,
      guildId: turn.guild_id,
      channelId: turn.channel_id,
      createdAt: turn.last_at,
      direction: "bot_to_user",
      instrumental,
    };
  }
  if (previousIsClose && previous.is_bot === 0) {
    return {
      userId: previous.user_id,
      username: previous.author_username,
      guildId: turn.guild_id,
      channelId: turn.channel_id,
      createdAt: turn.last_at,
      direction: "bot_to_user",
      instrumental,
    };
  }
  return null;
}

function botReplyLooksInstrumental(turn: ContactTurn, visualAssetMessageIds: Set<string>): boolean {
  return turn.ids.some((id) => visualAssetMessageIds.has(id)) || URL_RE.test(turn.raw_content) || URL_RE.test(turn.translated_content);
}

function addContactEvent(
  stats: UserContactStats,
  event: ContactEvent,
  now: number,
  contactDaysByUser: Map<string, Map<string, number>>,
): void {
  stats.directContactEvents += 1;
  stats.contactGuilds.add(event.guildId);
  stats.contactChannels.add(event.channelId);
  stats.firstContactAt = stats.firstContactAt === null ? event.createdAt : Math.min(stats.firstContactAt, event.createdAt);
  stats.lastContactAt = stats.lastContactAt === null ? event.createdAt : Math.max(stats.lastContactAt, event.createdAt);
  const day = new Date(event.createdAt).toISOString().slice(0, 10);
  stats.activeContactDays.add(day);
  let dayCounts = contactDaysByUser.get(stats.userId);
  if (dayCounts === undefined) {
    dayCounts = new Map();
    contactDaysByUser.set(stats.userId, dayCounts);
  }
  dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  const ageMs = Math.max(0, now - event.createdAt);
  if (ageMs <= RECENT_WINDOW_MS) stats.recentContactEvents += 1;
  stats.recentContactWeight += Math.pow(0.5, ageMs / SALIENCE_HALF_LIFE_MS);
  if (event.direction === "user_to_bot") {
    stats.userToBotEvents += 1;
    stats.lastUserToBotAt = stats.lastUserToBotAt === null ? event.createdAt : Math.max(stats.lastUserToBotAt, event.createdAt);
  } else {
    stats.botToUserEvents += 1;
    if (event.instrumental) stats.instrumentalBotReplies += 1;
    stats.lastBotToUserAt = stats.lastBotToUserAt === null ? event.createdAt : Math.max(stats.lastBotToUserAt, event.createdAt);
  }
}

function updateDialogueRun(
  stats: UserContactStats,
  activeRuns: Map<string, ActiveDialogueRun>,
  event: ContactEvent,
): void {
  const lastSpeaker = event.direction === "user_to_bot" ? "user" : "bot";
  const key = `${event.userId}:${event.channelId}`;
  const active = activeRuns.get(key);
  if (active !== undefined
    && event.createdAt - active.lastAt <= DIRECT_GAP_MS
    && active.lastSpeaker !== lastSpeaker) {
    active.lastAt = event.createdAt;
    active.lastSpeaker = lastSpeaker;
    active.turns += 1;
    stats.recentDialogueTurns = active.turns;
    return;
  }

  if (active !== undefined) recordDialogueRun(stats, active.turns);
  activeRuns.set(key, {
    userId: event.userId,
    channelId: event.channelId,
    lastAt: event.createdAt,
    lastSpeaker,
    turns: 1,
  });
}

function closeDialogueRuns(stats: Map<string, UserContactStats>, activeRuns: Map<string, ActiveDialogueRun>): void {
  for (const run of activeRuns.values()) {
    const userStats = stats.get(run.userId);
    if (userStats !== undefined) recordDialogueRun(userStats, run.turns);
  }
}

function recordDialogueRun(stats: UserContactStats, turns: number): void {
  stats.dialogueRunCount += 1;
  stats.longestRunTurns = Math.max(stats.longestRunTurns, turns);
  if (turns >= 4) stats.multiTurnRunCount += 1;
}

function isFamiliarityRankEligible(stats: UserContactStats): boolean {
  return stats.directContactEvents >= 5 || stats.activeContactDays.size >= 2 || stats.multiTurnRunCount >= 1;
}

function computeFamiliarityScore(stats: UserContactStats, population: UserContactStats[], now: number): number {
  const direct = Math.min(30, Math.log1p(stats.directContactEvents) * 7);
  const days = Math.min(25, Math.log1p(stats.activeContactDays.size) * 9);
  const dialogue = Math.min(25, stats.multiTurnRunCount * 4 + stats.longestRunTurns * 1.8);
  const specificity = Math.min(10, (stats.directContactEvents / Math.max(1, stats.totalMessages)) * 24);
  const breadth = Math.min(4, Math.max(0, stats.contactChannels.size - 1) * 1.5 + Math.max(0, stats.contactGuilds.size - 1) * 2);
  const memorySupport = stats.memoryCount > 0 ? Math.min(2, Math.log1p(stats.memoryCount)) : 0;
  const percentileBoost = isFamiliarityRankEligible(stats)
    ? percentileOf(population, stats, (item) => item.directContactEvents) * 10
    : 0;
  const instrumentalRatio = stats.instrumentalBotReplies / Math.max(1, stats.botToUserEvents);
  const instrumentalPenalty = stats.instrumentalBotReplies >= 3 && instrumentalRatio >= 0.5
    ? 8
    : stats.instrumentalBotReplies >= 2 && instrumentalRatio >= 0.3 ? 4 : 0;
  let score = direct + days + dialogue + specificity + breadth + memorySupport + percentileBoost - instrumentalPenalty;

  if (stats.directContactEvents < 2) score = Math.min(score, 12);
  if (stats.directContactEvents < 5) score = Math.min(score, 25);
  if (stats.activeContactDays.size <= 1) score = Math.min(score, 55);
  if (stats.multiTurnRunCount === 0) {
    score = Math.min(score, stats.activeContactDays.size >= 4 ? 68 : 42);
  }
  if (stats.oneDayContactMax / Math.max(1, stats.directContactEvents) > 0.8) score = Math.min(score, 58);
  if (!isFamiliarityRankEligible(stats) || percentileOf(population, stats, (item) => item.directContactEvents) < 0.9) {
    score = Math.min(score, 85);
  }
  const lastContactAge = stats.lastContactAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now - stats.lastContactAt);
  if (lastContactAge > COLD_CONTACT_MS) score = Math.min(score, stats.multiTurnRunCount >= 3 ? 55 : 40);
  else if (lastContactAge > STALE_CONTACT_MS) score = Math.min(score, stats.multiTurnRunCount >= 3 ? 70 : 55);

  return clampScore(score);
}

function computeSalienceScore(stats: UserContactStats, population: UserContactStats[], now: number): number {
  const ageMs = stats.lastContactAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now - stats.lastContactAt);
  const rank = stats.salienceRank ?? population.length;
  const recencyBonus = ageMs <= 24 * 60 * 60 * 1000 ? 5 : ageMs <= 3 * 24 * 60 * 60 * 1000 ? 0 : -5;
  let score = 0;
  if (rank <= 5) {
    score = 92 - (rank - 1) * 3 + recencyBonus;
  } else if (rank <= 15) {
    score = 78 - (rank - 6) * 2 + recencyBonus;
  } else {
    score = 58 - Math.min(20, rank - 16) + recencyBonus;
  }
  if (ageMs > RECENT_WINDOW_MS) score = Math.min(score, 10);
  else if (ageMs > 14 * 24 * 60 * 60 * 1000) score = Math.min(score, 25);
  else if (ageMs > 3 * 24 * 60 * 60 * 1000) score = Math.min(score, 45);
  return clampScore(score);
}

function percentileOf<T>(population: T[], current: T, value: (item: T) => number): number {
  if (population.length <= 1) return 1;
  const currentValue = value(current);
  const belowOrEqual = population.filter((item) => value(item) <= currentValue).length;
  return belowOrEqual / population.length;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function assignRanks(
  stats: UserContactStats[],
  valueKey: "directContactEvents" | "salienceScore" | "recentContactWeight" | "memoryCount",
  rankKey: "directRank" | "salienceRank" | "memoryRank",
): void {
  const ranked = [...stats].sort((a, b) => {
    const valueDiff = b[valueKey] - a[valueKey];
    if (valueDiff !== 0) return valueDiff;
    return a.username.localeCompare(b.username);
  });
  for (let i = 0; i < ranked.length; i += 1) {
    const item = ranked[i];
    if (item !== undefined) item[rankKey] = i + 1;
  }
}

function renderContactContext(stats: UserContactStats, now: number, includeLocality: boolean): string {
  const sentences = [
    [rapportImplication(stats), recencySummary(stats, now)].filter((part) => part !== "").join(" "),
    [dialogueImplication(stats), timeShapeClause(stats), salienceImplication(stats, now), chatterImplication(stats)].filter((part) => part !== "").join(" "),
    [memoryImplication(stats), breadthImplication(stats), instrumentalImplication(stats), staleImplication(stats, now), rankClause(stats), includeLocality ? localityImplication(stats) : ""].filter((part) => part !== "").join(" "),
  ].filter((sentence) => sentence !== "");

  return `Known interaction history: observed exchanges with this user; familiarity. ${sentences.map(trimSentencePunctuation).join(". ")}.`;
}

function trimSentencePunctuation(text: string): string {
  return text.replace(/[.。]+$/u, "");
}

function rapportImplication(stats: UserContactStats): string {
  const score = stats.familiarityScore;
  if (score <= 10) return "Treat this as almost no prior exchange; do not assume rapport.";
  if (score <= 25) return "You have very little direct history with them; avoid familiar shortcuts.";
  if (score <= 40) return "You may recognize them, but they are not important by default.";
  if (score <= 55) return "Some continuity exists, but closeness is not implied.";
  if (score <= 70) return "You have enough history to treat them as a familiar regular, not as close.";
  if (score > 85 && stats.directRank !== null && stats.directRank <= 5) {
    return "They are one of the recurring people in your chat life; you can recognize them without introduction.";
  }
  if (score > 70 && stats.directRank !== null && stats.directRank <= 10) {
    return "You have a well-established history with them, but that still does not imply affection or obligation.";
  }
  return "You have recurring history with them, but they are not one of the central few.";
}

function recencySummary(stats: UserContactStats, now: number): string {
  if (stats.lastContactAt === null) return "";
  const lastContact = `Last direct exchange was ${formatElapsedDuration(stats.lastContactAt, now)} ago`;
  if (stats.lastUserToBotAt === null) return lastContact;
  if (stats.lastBotToUserAt === null) {
    return `${lastContact}; you have not clearly replied before`;
  }
  const delta = Math.abs(stats.lastUserToBotAt - stats.lastBotToUserAt);
  if (delta <= DIRECT_GAP_MS) return lastContact;
  return `${lastContact}; you last replied ${formatElapsedDuration(stats.lastBotToUserAt, now)} ago`;
}

function dialogueImplication(stats: UserContactStats): string {
  if (stats.longestRunTurns >= 8 || stats.multiTurnRunCount >= 3) {
    return "Their history includes real back-and-forth, so continuity can matter.";
  }
  if (stats.multiTurnRunCount > 0) return "They have had some back-and-forth, but not deep continuity.";
  if (stats.directContactEvents >= 5) return "Most prior exchanges are isolated or short; do not overread them.";
  return "Direct exchange history is thin.";
}

function salienceImplication(stats: UserContactStats, now: number): string {
  if (stats.lastContactAt === null) return "";
  const ageMs = Math.max(0, now - stats.lastContactAt);
  if (ageMs > RECENT_WINDOW_MS) return "Recent context should not carry much weight.";
  if (stats.salienceRank !== null && stats.salienceRank <= 5 && ageMs <= 24 * 60 * 60 * 1000) {
    return "Recent context is likely relevant right now.";
  }
  if (stats.salienceRank !== null && stats.salienceRank <= 15 && ageMs <= 3 * 24 * 60 * 60 * 1000) {
    return "Recent context matters, but they are not necessarily central.";
  }
  if (ageMs <= 3 * 24 * 60 * 60 * 1000) return "They interacted recently; use that lightly.";
  if (ageMs <= 14 * 24 * 60 * 60 * 1000) return "History exists, but today's interaction should keep some distance.";
  return "History is stale enough that distance should reset somewhat.";
}

function instrumentalImplication(stats: UserContactStats): string {
  if (stats.instrumentalBotReplies < 2) return "";
  const ratio = stats.instrumentalBotReplies / Math.max(1, stats.botToUserEvents);
  if (ratio >= 0.5) return "Many of their exchanges produce links/images, so do not mistake service-like exchanges for rapport.";
  if (ratio >= 0.25) return "Some exchanges are tool-like; do not treat that as closeness.";
  return "";
}

function memoryImplication(stats: UserContactStats): string {
  if (stats.memoryCount <= 0) return "";
  if (stats.memoryRank !== null && stats.memoryRank <= 5) {
    return "You have unusually much stored context about them; use it for continuity.";
  }
  if (stats.memoryRank !== null && stats.memoryRank <= 15) {
    return "You have a few stored notes about them; enough for continuity, not closeness.";
  }
  return "";
}

function breadthImplication(stats: UserContactStats): string {
  if (stats.contactGuilds.size > 1) return "They show up across multiple guilds, so this is not just one-room familiarity.";
  if (stats.contactChannels.size >= 3) return "They show up across multiple channels, so the recognition is broader than one room.";
  if (stats.contactChannels.size === 2) return "They are known across two channels, but still mostly ordinary chat context.";
  return "";
}

function staleImplication(stats: UserContactStats, now: number): string {
  if (stats.lastContactAt === null) return "";
  const ageMs = Math.max(0, now - stats.lastContactAt);
  if (ageMs > COLD_CONTACT_MS) return "Their shared history is now distant; treat them closer to recognizable than familiar.";
  if (ageMs > STALE_CONTACT_MS) return "They may be historically familiar, but current rapport is stale.";
  return "";
}

function chatterImplication(stats: UserContactStats): string {
  const share = stats.directContactEvents / Math.max(1, stats.totalMessages);
  if (stats.totalMessages <= 10 && share >= 0.4) return "They do not talk much overall, but when they do, you are a meaningful target.";
  if (stats.totalMessages >= 100 && share < 0.15) return "They talk a lot generally, so exchanges with you are only a small part of their room presence.";
  if (share >= 0.35) return "You are a frequent target of their chat presence.";
  return "";
}

function timeShapeClause(stats: UserContactStats): string {
  const activeDays = stats.activeContactDays.size;
  if (activeDays <= 1 && stats.directContactEvents >= 8) return "Most exchanges came from one burst, so durable familiarity is capped.";
  if (activeDays <= 1) return "Their exchanges are from today only.";
  if (activeDays <= 3) return "Their exchanges span only a few days.";
  if (activeDays <= 10) return "Their exchanges span multiple days.";
  return "Their exchange history is long-running.";
}

function rankClause(stats: UserContactStats): string {
  if (stats.directRank !== null && stats.directRank <= 5 && stats.directContactEvents >= 10) return "They are among the people you exchange messages with most often.";
  if (stats.directRank !== null && stats.directRank <= 20 && stats.directContactEvents >= 5) return "They are among the people you exchange messages with more often.";
  return "";
}

function localityImplication(stats: UserContactStats): string {
  if (stats.localChannelMessages === 0) return "They are not locally active in this channel.";
  const localShare = stats.localChannelMessages / Math.max(1, stats.totalMessages);
  if (localShare <= 0.2) return "Most familiarity comes from elsewhere, not this channel.";
  return "";
}
