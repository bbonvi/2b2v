import { createHash } from "node:crypto";
import { AttachmentBuilder, ChannelType, PermissionFlagsBits, type Client, type GuildBasedChannel, type GuildTextBasedChannel, type Message, type ThreadChannel } from "discord.js";
import { sendWithUnknownMessageReferenceFallback } from "./message-reference-retry";
import { splitMessage } from "./split-message";
import { translateOutbound, type OutboundResolvers } from "./translation";
import type { EmbeddingQueue } from "../embeddings/queue";
import type { MessageSender, OutboundAttachment } from "../agent/handler";
import type { Logger } from "../logger";
import type { Database } from "../db/database";
import { storeImageBufferUnmodified } from "../db/image-ingest";
import { markBotParticipating, updateThreadActivity, upsertThread } from "../db/thread-repository";
import type { RoutedMessageSource } from "../db/message-repository";

type AttachmentSendPayload = {
  content?: string;
  files?: AttachmentBuilder[];
  nonce?: string;
  enforceNonce?: boolean;
};

export type SendableGuildChannel = GuildTextBasedChannel & { sendTyping: () => Promise<void> };
export type ResolveTargetChannel = (channelId: string | undefined) => Promise<SendableGuildChannel>;

const TYPING_INTERVAL_MS = 8_000;

function discordMessageNonce(dedupeKey: string | undefined, part: string): string | undefined {
  if (dedupeKey === undefined || dedupeKey === "") return undefined;
  return createHash("sha256").update(`${dedupeKey}:${part}`).digest("base64url").slice(0, 25);
}

function buildAttachmentPayload(content: string, attachments: AttachmentBuilder[], nonce?: string): AttachmentSendPayload {
  return {
    ...(content !== "" ? { content } : {}),
    ...(attachments.length > 0 ? { files: attachments } : {}),
    ...(nonce !== undefined ? { nonce, enforceNonce: true } : {}),
  };
}

function voiceRawContent(content: string): string {
  return content === "" ? "[Voice Message]" : `${content}\n[Voice Message]`;
}

function unresolvedEmojiWarnings(warnings: string[]): string[] | undefined {
  const emojiWarnings = warnings
    .filter((w) => w.startsWith("Failed to resolve emoji:"))
    .map((w) => w.replace("Failed to resolve emoji: ", ""));
  return emojiWarnings.length > 0 ? emojiWarnings : undefined;
}

function createBotMessageStore(input: {
  db: Database;
  embeddingQueue: EmbeddingQueue;
  botUserId: string;
  botUsername: string;
  logger: Logger;
  routedFrom?: RoutedMessageSource;
}): (sentId: string, targetGuildId: string, targetChannelId: string, rawContent: string, plainContent: string, replyToId: string | null) => void {
  return (sentId, targetGuildId, targetChannelId, rawContent, plainContent, replyToId) => {
    const ts = Date.now();
    const routedFrom = input.routedFrom !== undefined
      && (input.routedFrom.routedFromGuildId !== targetGuildId || input.routedFrom.routedFromChannelId !== targetChannelId)
      ? input.routedFrom
      : undefined;
    input.db.raw
      .prepare(
        `INSERT OR IGNORE INTO messages
           (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id,
            routed_from_guild_id, routed_from_channel_id, routed_from_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sentId,
        targetGuildId,
        targetChannelId,
        input.botUserId,
        input.botUsername,
        rawContent,
        plainContent,
        1,
        ts,
        replyToId,
        routedFrom?.routedFromGuildId ?? null,
        routedFrom?.routedFromChannelId ?? null,
        routedFrom?.routedFromMessageId ?? null,
      );

    void input.embeddingQueue.enqueue({
      id: sentId,
      text: plainContent,
      target: "message",
      metadata: {
        guild_id: targetGuildId,
        channel_id: targetChannelId,
        user_id: input.botUserId,
        created_at: ts,
        is_bot: true,
        source: "live",
        embedding_kind: "single",
      },
    }).catch((err: unknown) => {
      input.logger.error("bot message embedding enqueue failed", {
        messageId: sentId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
}

export function isSendableGuildChannel(channel: unknown): channel is SendableGuildChannel {
  return channel !== null
    && typeof channel === "object"
    && "send" in channel
    && "sendTyping" in channel
    && "guild" in channel
    && "guildId" in channel;
}

export function channelTypeLabel(channel: GuildBasedChannel | ThreadChannel): string {
  if (channel.isThread()) return "thread";
  switch (channel.type) {
    case ChannelType.GuildText:
      return "text";
    case ChannelType.GuildAnnouncement:
      return "announcement";
    case ChannelType.GuildForum:
      return "forum";
    case ChannelType.GuildMedia:
      return "media";
    case ChannelType.GuildVoice:
      return "voice";
    case ChannelType.GuildStageVoice:
      return "stage";
    case ChannelType.GuildCategory:
      return "category";
    case ChannelType.AnnouncementThread:
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
      return "thread";
    default:
      return "channel";
  }
}

export function botChannelPermissions(client: Client, channel: GuildBasedChannel | ThreadChannel): {
  canView: boolean;
  canSend: boolean;
} {
  if (channel.isThread()) {
    const canView = channel.viewable && (channel.type !== ChannelType.PrivateThread || channel.joined || channel.manageable);
    return { canView, canSend: canView && channel.sendable };
  }

  const canView = channel.viewable;
  if (!canView) return { canView: false, canSend: false };

  const sendable = isSendableGuildChannel(channel);
  if (!sendable) return { canView, canSend: false };

  const permissions = client.user === null ? null : channel.permissionsFor(client.user);
  const hasAdmin = permissions?.has(PermissionFlagsBits.Administrator, false) ?? false;
  const timedOut = (channel.guild.members.me?.communicationDisabledUntilTimestamp ?? 0) > Date.now();
  const canSend = (hasAdmin || !timedOut) && (permissions?.has(PermissionFlagsBits.SendMessages) ?? false);
  return { canView, canSend };
}

export function channelDisplayName(channel: unknown): string | undefined {
  return channel !== null
    && typeof channel === "object"
    && "name" in channel
    && typeof channel.name === "string"
    && channel.name !== ""
    ? channel.name
    : undefined;
}

export async function fetchAccessibleGuildChannel(client: Client, channelId: string): Promise<SendableGuildChannel | null> {
  const cached = client.channels.cache.get(channelId);
  const resolved = cached ?? await client.channels.fetch(channelId).catch(() => null);
  if (!isSendableGuildChannel(resolved)) return null;
  return botChannelPermissions(client, resolved).canView ? resolved : null;
}

export function createTargetChannelResolver(discordClient: Client, defaultChannel: SendableGuildChannel): ResolveTargetChannel {
  return async (channelId) => {
    if (channelId === undefined) return defaultChannel;
    const cached = discordClient.channels.cache.get(channelId);
    const resolved = cached ?? await discordClient.channels.fetch(channelId).catch(() => null);
    if (resolved === null) throw new Error(`Invalid channel_id: channel "${channelId}" not found`);
    if (!isSendableGuildChannel(resolved)) {
      throw new Error(`Invalid channel_id: channel "${channelId}" is not a supported guild text channel or thread`);
    }
    return resolved;
  };
}

export function createTypingController(input: {
  defaultChannel: SendableGuildChannel;
  resolveTargetChannel: ResolveTargetChannel;
}): {
  getLastTypingAt: () => number;
  getTypingStartedAt: () => number;
  sendNow: (channelId?: string) => Promise<void>;
  startLoop: (channelId?: string) => void;
  scheduleStartLoop: (delayMs: number, channelId?: string) => void;
  stopLoop: () => void;
} {
  let lastTypingAt = 0;
  let typingStartedAt = 0;
  let typingTimer: ReturnType<typeof setInterval> | null = null;
  let scheduledStartTimer: ReturnType<typeof setTimeout> | null = null;
  let typingChannelId: string | undefined;

  const sendNow = async (channelId?: string): Promise<void> => {
    let targetChannel = input.defaultChannel;
    if (channelId !== undefined) {
      try {
        targetChannel = await input.resolveTargetChannel(channelId);
      } catch {
        targetChannel = input.defaultChannel;
      }
    }
    lastTypingAt = Date.now();
    await targetChannel.sendTyping().catch(() => {});
  };

  const clearScheduledStart = (): void => {
    if (scheduledStartTimer === null) return;
    clearTimeout(scheduledStartTimer);
    scheduledStartTimer = null;
  };

  const startLoop = (channelId?: string): void => {
    clearScheduledStart();
    const wasRunning = typingTimer !== null;
    const channelChanged = typingChannelId !== channelId;
    typingChannelId = channelId;
    if (!wasRunning) typingStartedAt = Date.now();
    if (!wasRunning || channelChanged) void sendNow(typingChannelId).catch(() => {});
    if (wasRunning) return;
    typingTimer = setInterval(() => { void sendNow(typingChannelId).catch(() => {}); }, TYPING_INTERVAL_MS);
  };

  const scheduleStartLoop = (delayMs: number, channelId?: string): void => {
    clearScheduledStart();
    if (delayMs <= 0) {
      startLoop(channelId);
      return;
    }
    scheduledStartTimer = setTimeout(() => {
      scheduledStartTimer = null;
      startLoop(channelId);
    }, delayMs);
  };

  const stopLoop = (): void => {
    clearScheduledStart();
    if (typingTimer !== null) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
    typingStartedAt = 0;
  };

  return {
    getLastTypingAt: () => lastTypingAt,
    getTypingStartedAt: () => typingStartedAt,
    sendNow,
    startLoop,
    scheduleStartLoop,
    stopLoop,
  };
}

export function createDiscordMessageSender(input: {
  db: Database;
  embeddingQueue: EmbeddingQueue;
  buildOutboundResolvers: (guild: SendableGuildChannel["guild"]) => OutboundResolvers;
  defaultChannel: SendableGuildChannel;
  resolveTargetChannel: ResolveTargetChannel;
  botUserId: string;
  botUsername: string;
  logger: Logger;
  replySourceMessage?: Message;
  getLastTypingAt?: () => number;
  getAttachmentsDir: (guildId: string) => string;
  routedFrom?: RoutedMessageSource;
}): MessageSender {
  const storeBotMessage = createBotMessageStore({
    db: input.db,
    embeddingQueue: input.embeddingQueue,
    botUserId: input.botUserId,
    botUsername: input.botUsername,
    logger: input.logger,
    routedFrom: input.routedFrom,
  });

  async function waitAfterRecentTyping(): Promise<void> {
    const lastTypingAt = input.getLastTypingAt?.() ?? 0;
    const sinceTypingMs = Date.now() - lastTypingAt;
    if (sinceTypingMs >= 0 && sinceTypingMs < 200) {
      await new Promise((resolve) => setTimeout(resolve, 200 - sinceTypingMs));
    }
  }

  async function storeBotImageAttachments(
    messageId: string,
    targetGuildId: string,
    targetChannelId: string,
    attachments: OutboundAttachment[] | undefined,
  ): Promise<void> {
    if (attachments === undefined || attachments.length === 0) return;
    const results = await Promise.allSettled(attachments.map((attachment) =>
      storeImageBufferUnmodified({
        db: input.db,
        attachmentsDir: input.getAttachmentsDir(targetGuildId),
      }, {
        buffer: attachment.buffer,
        mimeType: attachment.contentType,
        messageId,
        guildId: targetGuildId,
        channelId: targetChannelId,
        caption: attachment.historyText,
      })
    ));
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      if (result?.status !== "rejected") continue;
      input.logger.warn("bot image attachment ingest failed", {
        messageId,
        filename: attachments[i]?.filename,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  function attachmentBuilders(attachments: OutboundAttachment[] | undefined): AttachmentBuilder[] {
    if (attachments === undefined || attachments.length === 0) return [];
    return attachments.map((attachment) => new AttachmentBuilder(attachment.buffer, { name: attachment.filename }));
  }

  return async (text, reply, channelId, voice, _signal, replyToMessageId, attachments, dedupeKey) => {
    const targetChannel = await input.resolveTargetChannel(channelId);
    const targetGuildId = targetChannel.guildId;
    const targetChannelId = targetChannel.id;
    const outboundResolvers = input.buildOutboundResolvers(targetChannel.guild);
    type SentDelivery = { message: Message; replyToId: string | null };

    await waitAfterRecentTyping();

    const sendToTargetChannel = async (content: string | AttachmentSendPayload): Promise<Message> => {
      return typeof content === "string"
        ? await targetChannel.send(content)
        : await targetChannel.send(content);
    };

    const replyWithMessage = async (message: Message, content: string | AttachmentSendPayload): Promise<Message> => {
      return typeof content === "string"
        ? await message.reply(content)
        : await message.reply(content);
    };

    const replyToSpecific = async (content: string | AttachmentSendPayload): Promise<SentDelivery> => {
      if (replyToMessageId !== undefined) {
        let targetMsg: Message;
        try {
          targetMsg = await targetChannel.messages.fetch(replyToMessageId);
        } catch (err) {
          input.logger.warn("reply_to_message_id fetch failed, falling back to send", {
            replyToMessageId,
            channelId: targetChannel.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return { message: await sendToTargetChannel(content), replyToId: null };
        }

        return await sendWithUnknownMessageReferenceFallback<SentDelivery>(
          async () => ({ message: await replyWithMessage(targetMsg, content), replyToId: targetMsg.id }),
          async () => ({ message: await sendToTargetChannel(content), replyToId: null }),
          (err) => {
            input.logger.warn("reply_to_message_id target disappeared, falling back to send", {
              replyToMessageId,
              channelId: targetChannel.id,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        );
      }
      return { message: await sendToTargetChannel(content), replyToId: null };
    };

    const replyToSource = async (content: string | AttachmentSendPayload): Promise<SentDelivery> => {
      const sourceMessage = input.replySourceMessage;
      if (sourceMessage === undefined) return { message: await sendToTargetChannel(content), replyToId: null };
      if (sourceMessage.channelId !== targetChannel.id) return { message: await sendToTargetChannel(content), replyToId: null };

      return await sendWithUnknownMessageReferenceFallback<SentDelivery>(
        async () => ({ message: await replyWithMessage(sourceMessage, content), replyToId: sourceMessage.id }),
        async () => ({ message: await sendToTargetChannel(content), replyToId: null }),
        (err) => {
          input.logger.warn("reply source message disappeared, falling back to send", {
            replySourceMessageId: sourceMessage.id,
            channelId: targetChannel.id,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    };

    const noteThreadActivity = (sentMessageId: string): void => {
      if (!targetChannel.isThread()) return;
      const activityAt = Date.now();
      const updated = updateThreadActivity(input.db, targetChannelId, {
        lastActivityAt: activityAt,
        lastMessageId: sentMessageId,
        archivedAt: targetChannel.archived === true ? activityAt : null,
      });
      if (!updated) {
        upsertThread(input.db, {
          threadId: targetChannelId,
          guildId: targetGuildId,
          parentChatId: targetChannel.parentId ?? targetChannelId,
          starterMessageId: targetChannelId,
          threadName: targetChannel.name,
          createdAt: targetChannel.createdTimestamp ?? activityAt,
          lastActivityAt: activityAt,
          lastMessageId: sentMessageId,
          messageCount: targetChannel.messageCount ?? 1,
          createdByBot: targetChannel.ownerId === input.botUserId,
          archivedAt: targetChannel.archived === true ? activityAt : null,
        });
      }
      markBotParticipating(input.db, targetChannelId);
    };

    if (voice !== undefined) {
      const attachment = new AttachmentBuilder(voice.buffer, { name: voice.filename });
      const imageAttachments = attachmentBuilders(attachments);
      const warnings: string[] = [];
      const translated = translateOutbound(text, outboundResolvers, warnings);
      const chunks = splitMessage(translated);
      const firstChunk = chunks[0] ?? "";
      const payload = buildAttachmentPayload(
        firstChunk,
        [attachment, ...imageAttachments],
        discordMessageNonce(dedupeKey, "voice-0"),
      );
      let sent: Message;
      let sentReplyToId: string | null;
      if (replyToMessageId !== undefined) {
        const delivered = await replyToSpecific(payload);
        sent = delivered.message;
        sentReplyToId = delivered.replyToId;
      } else if (reply) {
        const delivered = await replyToSource(payload);
        sent = delivered.message;
        sentReplyToId = delivered.replyToId;
      } else {
        sent = await sendToTargetChannel(payload);
        sentReplyToId = null;
      }
      storeBotMessage(sent.id, targetGuildId, targetChannelId, voiceRawContent(firstChunk), voice.historyText ?? text, sentReplyToId);
      await storeBotImageAttachments(sent.id, targetGuildId, targetChannelId, attachments);
      for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i] as string;
        const followup = await sendToTargetChannel(buildAttachmentPayload(
          chunk,
          [],
          discordMessageNonce(dedupeKey, `voice-${i}`),
        ));
        storeBotMessage(followup.id, targetGuildId, targetChannelId, chunk, chunk, null);
      }
      noteThreadActivity(sent.id);
      return { sentMessageId: sent.id, warnings: unresolvedEmojiWarnings(warnings) };
    }

    const warnings: string[] = [];
    const translated = translateOutbound(text, outboundResolvers, warnings);
    const imageAttachments = attachmentBuilders(attachments);
    const chunks = splitMessage(translated);
    if (chunks.length === 0 && imageAttachments.length > 0) chunks.push("");
    let firstId = "";
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] as string;
      const payload = buildAttachmentPayload(
        chunk,
        i === 0 ? imageAttachments : [],
        discordMessageNonce(dedupeKey, `text-${i}`),
      );
      let sent: Message;
      let sentReplyToId: string | null;
      if (replyToMessageId !== undefined && i === 0) {
        const delivered = await replyToSpecific(payload);
        sent = delivered.message;
        sentReplyToId = delivered.replyToId;
      } else if (reply && i === 0) {
        const delivered = await replyToSource(payload);
        sent = delivered.message;
        sentReplyToId = delivered.replyToId;
      } else {
        sent = await sendToTargetChannel(payload);
        sentReplyToId = null;
      }
      if (i === 0) firstId = sent.id;
      storeBotMessage(sent.id, targetGuildId, targetChannelId, chunk, i === 0 ? text : chunk, sentReplyToId);
      if (i === 0) await storeBotImageAttachments(sent.id, targetGuildId, targetChannelId, attachments);
    }
    noteThreadActivity(firstId);
    return { sentMessageId: firstId, warnings: unresolvedEmojiWarnings(warnings) };
  };
}
