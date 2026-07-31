import type { Database } from "./database";

export interface MessageActivity {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  authorUsername: string;
  createdAt: number;
  isBot: boolean;
}

export interface ChannelActivityBucket {
  bucketIndex: number;
  messageCount: number;
}

export interface BotChannelUsage {
  guildId: string;
  channelId: string;
  messageCount: number;
}

export interface DiscordChannelUsage extends BotChannelUsage {
  recentBotMessageCount: number;
  activeHumanPosterCount: number;
}

export interface BotChannelActivityUsage extends BotChannelUsage {
  lastHumanActivityAt: number | null;
}


export function listBotChannelUsage(
  db: Database,
  botUserId: string,
  limit: number,
): BotChannelUsage[] {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const rows = db.raw.prepare(
    `SELECT guild_id, channel_id, COUNT(*) AS message_count, MAX(created_at) AS latest_at
     FROM messages
     WHERE user_id = ? AND is_bot = 1 AND is_synthetic = 0 AND is_prompt_only = 0
       AND deleted_at IS NULL
     GROUP BY guild_id, channel_id
     ORDER BY message_count DESC, latest_at DESC, channel_id ASC
     LIMIT ?`,
  ).all(botUserId, boundedLimit) as Array<{
    guild_id: string;
    channel_id: string;
    message_count: number;
  }>;
  return rows.map((row) => ({
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageCount: row.message_count,
  }));
}

/** List the bot's most-used channels with stable recent activity signals for prompt context. */
export function listDiscordChannelUsage(
  db: Database,
  input: {
    botUserId: string;
    limit: number;
    recentBotSince: number;
    activeHumanSince: number;
  },
): DiscordChannelUsage[] {
  const boundedLimit = Math.max(1, Math.min(input.limit, 100));
  const rows = db.raw.prepare(
    `WITH bot_usage AS (
       SELECT guild_id, channel_id, COUNT(*) AS message_count, MAX(created_at) AS latest_at,
         SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent_bot_message_count
       FROM messages
       WHERE user_id = ? AND is_bot = 1 AND is_synthetic = 0 AND is_prompt_only = 0
         AND deleted_at IS NULL
       GROUP BY guild_id, channel_id
       ORDER BY message_count DESC, latest_at DESC, channel_id ASC
       LIMIT ?
     ),
     human_activity AS (
       SELECT human.guild_id, human.channel_id,
         COUNT(DISTINCT human.user_id) AS active_human_poster_count
       FROM messages AS human
       INNER JOIN bot_usage
         ON bot_usage.guild_id = human.guild_id AND bot_usage.channel_id = human.channel_id
       WHERE human.created_at >= ? AND human.is_bot = 0
         AND human.is_synthetic = 0 AND human.is_prompt_only = 0
         AND human.deleted_at IS NULL
       GROUP BY human.guild_id, human.channel_id
     )
     SELECT bot_usage.guild_id, bot_usage.channel_id, bot_usage.message_count,
       bot_usage.recent_bot_message_count,
       COALESCE(human_activity.active_human_poster_count, 0) AS active_human_poster_count
     FROM bot_usage
     LEFT JOIN human_activity
       ON human_activity.guild_id = bot_usage.guild_id
       AND human_activity.channel_id = bot_usage.channel_id
     ORDER BY bot_usage.message_count DESC, bot_usage.latest_at DESC, bot_usage.channel_id ASC`,
  ).all(
    input.recentBotSince,
    input.botUserId,
    boundedLimit,
    input.activeHumanSince,
  ) as Array<{
    guild_id: string;
    channel_id: string;
    message_count: number;
    recent_bot_message_count: number;
    active_human_poster_count: number;
  }>;
  return rows.map((row) => ({
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageCount: row.message_count,
    recentBotMessageCount: row.recent_bot_message_count,
    activeHumanPosterCount: row.active_human_poster_count,
  }));
}

/** List the bot's most-used channels with their latest real human activity. */
export function listBotChannelActivityUsage(
  db: Database,
  botUserId: string,
  limit: number,
): BotChannelActivityUsage[] {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const rows = db.raw.prepare(
    `WITH bot_usage AS (
       SELECT guild_id, channel_id, COUNT(*) AS message_count, MAX(created_at) AS latest_at
       FROM messages
       WHERE user_id = ? AND is_bot = 1 AND is_synthetic = 0 AND is_prompt_only = 0
         AND deleted_at IS NULL
       GROUP BY guild_id, channel_id
       ORDER BY message_count DESC, latest_at DESC, channel_id ASC
       LIMIT ?
     )
     SELECT bot_usage.guild_id, bot_usage.channel_id, bot_usage.message_count, bot_usage.latest_at,
       MAX(human.created_at) AS last_human_activity_at
     FROM bot_usage
     LEFT JOIN messages AS human
       ON human.guild_id = bot_usage.guild_id AND human.channel_id = bot_usage.channel_id
       AND human.is_bot = 0 AND human.is_synthetic = 0 AND human.is_prompt_only = 0
       AND human.deleted_at IS NULL
     GROUP BY bot_usage.guild_id, bot_usage.channel_id, bot_usage.message_count, bot_usage.latest_at
     ORDER BY bot_usage.message_count DESC, bot_usage.latest_at DESC, bot_usage.channel_id ASC`,
  ).all(botUserId, boundedLimit) as Array<{
    guild_id: string;
    channel_id: string;
    message_count: number;
    last_human_activity_at: number | null;
  }>;
  return rows.map((row) => ({
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageCount: row.message_count,
    lastHumanActivityAt: row.last_human_activity_at,
  }));
}


export function getLatestMessageActivityBefore(
  db: Database,
  filter: {
    beforeCreatedAt: number;
    beforeMessageId?: string;
    guildId?: string;
    channelId?: string;
    userId?: string;
    isBot?: boolean;
  },
): MessageActivity | null {
  const conditions = [
    "is_synthetic = 0",
    "is_prompt_only = 0",
    "(created_at < ? OR (created_at = ? AND id < ?))",
  ];
  const params: Array<string | number> = [
    filter.beforeCreatedAt,
    filter.beforeCreatedAt,
    filter.beforeMessageId ?? "",
  ];

  if (filter.guildId !== undefined) {
    conditions.push("guild_id = ?");
    params.push(filter.guildId);
  }
  if (filter.channelId !== undefined) {
    conditions.push("channel_id = ?");
    params.push(filter.channelId);
  }
  if (filter.userId !== undefined) {
    conditions.push("user_id = ?");
    params.push(filter.userId);
  }
  if (filter.isBot !== undefined) {
    conditions.push("is_bot = ?");
    params.push(filter.isBot ? 1 : 0);
  }

  const row = db.raw
    .prepare(
      `SELECT id, guild_id, channel_id, user_id, author_username, created_at, is_bot
       FROM messages
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(...params) as {
      id: string;
      guild_id: string;
      channel_id: string;
      user_id: string;
      author_username: string;
      created_at: number;
      is_bot: number;
    } | null;

  if (row === null) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    userId: row.user_id,
    authorUsername: row.author_username,
    createdAt: row.created_at,
    isBot: row.is_bot === 1,
  };
}


export function getChannelHumanActivityBuckets(
  db: Database,
  guildId: string,
  channelId: string,
  after: number,
  before: number,
  bucketMs: number,
): ChannelActivityBucket[] {
  if (before <= after || bucketMs <= 0) return [];
  return db.raw
    .prepare(
      `SELECT CAST((created_at - ?) / ? AS INTEGER) AS bucketIndex, COUNT(*) AS messageCount
       FROM messages
       WHERE guild_id = ?
         AND channel_id = ?
         AND is_bot = 0
         AND is_synthetic = 0
         AND is_prompt_only = 0
         AND created_at >= ?
         AND created_at < ?
       GROUP BY bucketIndex
       ORDER BY bucketIndex ASC`
    )
    .all(after, bucketMs, guildId, channelId, after, before) as ChannelActivityBucket[];
}


