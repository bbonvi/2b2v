import type { QdrantClient } from "@qdrant/js-client-rest";
import type { Guild, Message, TextChannel } from "discord.js";
import type { GuildConfig } from "../config/types";
import type { Database } from "../db/database";
import { processAndStoreImage } from "../db/image-ingest";
import { cleanupDeletedBotMessage } from "../db/message-cleanup";
import { upsertBotMessageContent } from "../db/message-repository";
import { deleteMessagePointsByMessageId } from "../qdrant/adapter";
import type { EmbeddingQueue } from "../embeddings/queue";
import type { ReplyFallbackDeps } from "../agent/reply-target-fallback";

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
      url: attachment.url,
      contentType: attachment.contentType,
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
  embeddingQueue: EmbeddingQueue;
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
        return fetchedDiscordMessageToFallback(await (channel as TextChannel).messages.fetch(msgId));
      } catch {
        return null;
      }
    },
    enqueueEmbedding: async (id, text, metadata) => {
      await input.embeddingQueue.enqueue({ id, text, target: "message", metadata });
    },
    processImage: async (url, contentType, messageId, sourceKind) => {
      await processAndStoreImage({
        db: input.db,
        attachmentsDir: input.guildConfig.attachmentsDir,
        maxDimension: input.guildConfig.imageMaxDimension,
        fetchFn: fetch,
      }, {
        url,
        mimeType: contentType,
        messageId,
        guildId: input.guildId,
        channelId: input.channelId,
        sourceKind,
      });
    },
  };
}

export function createSyntheticReplyFallbackDeps(input: {
  db: Database;
  embeddingQueue: EmbeddingQueue;
  guildId: string;
  channelId: string;
}): ReplyFallbackDeps {
  return {
    db: input.db,
    guildId: input.guildId,
    channelId: input.channelId,
    fetchDiscordMessage: () => Promise.resolve(null),
    enqueueEmbedding: async (id, text, metadata) => {
      await input.embeddingQueue.enqueue({ id, text, target: "message", metadata });
    },
    processImage: async () => {},
  };
}

export async function syncEditedOwnBotMessage(input: {
  db: Database;
  qdrant: QdrantClient;
  embeddingQueue: EmbeddingQueue;
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
  const row = upsertBotMessageContent(input.db, {
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
  await deleteMessagePointsByMessageId(input.qdrant, { guildId: row.guildId, messageId: row.id });
  await input.embeddingQueue.enqueue({
    id: row.id,
    text: row.translatedContent,
    target: "message",
    metadata: {
      guild_id: row.guildId,
      channel_id: row.channelId,
      user_id: row.userId,
      created_at: row.createdAt,
      is_bot: true,
      source: "live",
      embedding_kind: "single",
    },
  });
}

export async function syncDeletedOwnBotMessage(input: {
  db: Database;
  qdrant: QdrantClient;
  messageId: string;
  guildId: string;
  channelId: string;
  botUserId: string;
}): Promise<void> {
  await cleanupDeletedBotMessage(input);
}
