import type { Client, Message, TextBasedChannel } from "discord.js";
import type { Database } from "../db/database.ts";
import type { Logger } from "../logger.ts";
import { syncAssetBackfillPage } from "../db/asset-repository.ts";
import { assetsFromDiscordMessage } from "./message-assets.ts";

interface ChannelBackfillRow {
  guild_id: string;
  channel_id: string;
  oldest_at: number;
  newest_at: number;
  before_message_id: string | null;
}

/** Backfill stored history assets newest-first in resumable 100-message Discord pages. */
export async function backfillMessageAssets(input: {
  db: Database;
  client: Client;
  logger: Logger;
  delayMs?: number;
}): Promise<void> {
  const failedChannels = new Set<string>();
  for (;;) {
    const channels = input.db.raw.prepare(`SELECT m.guild_id, m.channel_id, MIN(m.created_at) AS oldest_at,
        MAX(m.created_at) AS newest_at, c.before_message_id
      FROM messages m
      LEFT JOIN asset_backfill_checkpoints c ON c.channel_id = m.channel_id
      WHERE m.is_synthetic = 0 AND m.is_prompt_only = 0 AND m.id GLOB '[0-9]*'
        AND c.completed_at IS NULL
      GROUP BY m.guild_id, m.channel_id
      ORDER BY newest_at DESC`).all() as ChannelBackfillRow[];
    const pending = channels.filter((row) => !failedChannels.has(row.channel_id));
    if (pending.length === 0) return;
    for (const row of pending) {
      try {
        const channel = await input.client.channels.fetch(row.channel_id);
        if (channel === null || !("messages" in channel)) {
          failedChannels.add(row.channel_id);
          continue;
        }
        const page = await (channel as TextBasedChannel).messages.fetch({
          limit: 100,
          ...(row.before_message_id !== null ? { before: row.before_message_id } : {}),
        });
        const messages = [...page.values()] as Message[];
        const oldest = messages.at(-1);
        const localIds = localMessageIdsInRange(input.db, row.channel_id, row.before_message_id, oldest?.id ?? null);
        const live = new Map(messages.map((message) => [message.id, message]));
        const completed = messages.length < 100 || oldest === undefined || oldest.createdTimestamp <= row.oldest_at;
        syncAssetBackfillPage(input.db, {
          guildId: row.guild_id,
          channelId: row.channel_id,
          beforeMessageId: oldest?.id ?? row.before_message_id,
          completed,
          messages: [...localIds].map((messageId) => {
            const message = live.get(messageId);
            return { messageId, assets: message === undefined ? [] : assetsFromDiscordMessage(message) };
          }),
        });
      } catch (error) {
        failedChannels.add(row.channel_id);
        input.logger.warn("asset history backfill channel failed", {
          channelId: row.channel_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await Bun.sleep(input.delayMs ?? 250);
    }
  }
}

export function localMessageIdsInRange(db: Database, channelId: string, beforeId: string | null, oldestId: string | null): Set<string> {
  const rows = db.raw.prepare(`SELECT id FROM messages WHERE channel_id = ? AND assets_indexed_at IS NULL
      AND is_synthetic = 0 AND is_prompt_only = 0 AND id GLOB '[0-9]*'`)
    .all(channelId) as Array<{ id: string }>;
  const before = beforeId === null ? null : BigInt(beforeId);
  const oldest = oldestId === null ? null : BigInt(oldestId);
  return new Set(rows.filter((row) => {
    const id = BigInt(row.id);
    return (before === null || id < before) && (oldest === null || id >= oldest);
  }).map((row) => row.id));
}
