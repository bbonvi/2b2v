import type { Guild, Message, TextChannel } from "discord.js";
import type { GuildConfig } from "../config/types";
import type { Database } from "../db/database";
import { cleanupDeletedBotMessage } from "../db/message-cleanup";
import { upsertBotMessageContent } from "../db/message-repository";
import type { ReplyFallbackDeps } from "../agent/reply-target-fallback";
import { syncMessageAssets } from "../db/asset-repository.ts";
import { assetsFromDiscordMessage } from "./message-assets.ts";

export function fetchedDiscordMessageToFallback(fetched: Message): Awaited<ReturnType<ReplyFallbackDeps["fetchDiscordMessage"]>> {
  return {
    id: fetched.id,
    authorId: fetched.author.id,
    authorUsername: fetched.author.username,
    authorDisplayName: fetched.member?.displayName ?? fetched.author.globalName ?? fetched.author.displayName,
    content: fetched.content,
    timestamp: fetched.createdTimestamp,
    isBot: fetched.author.bot,
    replyToId: fetched.reference?.messageId ?? null,
    attachments: [...fetched.attachments.values()].map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      url: attachment.url,
      contentType: attachment.contentType,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
      durationSeconds: attachment.duration,
    })),
    embeds: fetched.embeds.map((embed) => ({
      type: embed.data.type,
      url: embed.url,
      provider: embed.provider,
      ...(embed.image?.url !== undefined ? { image: { url: embed.image.url } } : {}),
      ...(embed.thumbnail?.url !== undefined ? { thumbnail: { url: embed.thumbnail.url } } : {}),
    })),
    stickers: [...fetched.stickers.values()].map((sticker) => ({
      name: sticker.name,
      url: sticker.url,
      format: sticker.format,
    })),
  };
}

export function createDiscordReplyFallbackDeps(input: {
  db: Database;
  clientChannelsFetch: (channelId: string) => Promise<unknown>;
  guild: Guild;
  guildId: string;
  channelId: string;
  guildConfig: GuildConfig;
  fetchUncached?: boolean;
}): ReplyFallbackDeps {
  return {
    db: input.db,
    guildId: input.guildId,
    channelId: input.channelId,
    fetchDiscordMessage: async (chId, msgId) => {
      const channel = input.fetchUncached === true
        ? await input.clientChannelsFetch(chId).catch(() => input.guild.channels.cache.get(chId) ?? null)
        : input.guild.channels.cache.get(chId) ?? null;
      if (channel === null || typeof channel !== "object" || !("messages" in channel)) return null;
      try {
        const message = await (channel as TextChannel).messages.fetch(msgId);
        syncMessageAssets(input.db, { messageId: message.id, assets: assetsFromDiscordMessage(message) });
        return fetchedDiscordMessageToFallback(message);
      } catch {
        return null;
      }
    },
  };
}

export function createSyntheticReplyFallbackDeps(input: {
  db: Database;
  guildId: string;
  channelId: string;
}): ReplyFallbackDeps {
  return {
    db: input.db,
    guildId: input.guildId,
    channelId: input.channelId,
    fetchDiscordMessage: () => Promise.resolve(null),
  };
}

export function syncEditedOwnBotMessage(input: {
  db: Database;
  messageId: string;
  guildId: string;
  channelId: string;
  botUserId: string;
  botUsername: string;
  rawContent: string;
  translatedContent: string;
  createdAt: number;
  replyToId: string | null;
}): Promise<void> {
  upsertBotMessageContent(input.db, {
    id: input.messageId,
    guildId: input.guildId,
    channelId: input.channelId,
    botUserId: input.botUserId,
    botUsername: input.botUsername,
    rawContent: input.rawContent,
    translatedContent: input.translatedContent,
    createdAt: input.createdAt,
    replyToId: input.replyToId,
  });
  return Promise.resolve();
}

export function syncDeletedOwnBotMessage(input: {
  db: Database;
  messageId: string;
  guildId: string;
  channelId: string;
  botUserId: string;
}): Promise<void> {
  cleanupDeletedBotMessage(input);
  return Promise.resolve();
}
