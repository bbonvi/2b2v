import { createHash } from "node:crypto";
import { AttachmentBuilder, ChannelType, ContainerBuilder, MessageFlags, PermissionFlagsBits, TextDisplayBuilder, type Client, type GuildBasedChannel, type GuildTextBasedChannel, type Message, type ThreadChannel } from "discord.js";
import { sendWithUnknownMessageReferenceFallback } from "./message-reference-retry";
import { splitMessage } from "./split-message";
import { translateOutbound, type OutboundResolvers } from "./translation";
import type { MessagePresentation, MessageSender, OutboundAttachment } from "../agent/handler";
import type { Logger } from "../logger";
import type { Database } from "../db/database";
import { syncMessageAssets } from "../db/asset-repository.ts";
import { assetsFromDiscordMessage } from "./message-assets.ts";
import { markBotParticipating, updateThreadActivity, upsertThread } from "../db/thread-repository";
import type { RoutedMessageSource } from "../db/message-repository";

type AttachmentSendPayload = {
  content?: string;
  files?: AttachmentBuilder[];
  nonce?: string;
  enforceNonce?: boolean;
  components?: ContainerBuilder[];
  flags?: MessageFlags.IsComponentsV2;
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

export function buildComponentsV2CardPayload(content: string, presentation: MessagePresentation, nonce?: string): AttachmentSendPayload {
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
  if (presentation.accentColor !== undefined) container.setAccentColor(presentation.accentColor);
  if (presentation.componentId !== undefined) container.setId(presentation.componentId);
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
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
  botUserId: string;
  botUsername: string;
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
  buildOutboundResolvers: (guild: SendableGuildChannel["guild"]) => OutboundResolvers;
  defaultChannel: SendableGuildChannel;
  resolveTargetChannel: ResolveTargetChannel;
  botUserId: string;
  botUsername: string;
  logger: Logger;
  replySourceMessage?: Message;
  getLastTypingAt?: () => number;
  routedFrom?: RoutedMessageSource;
}): MessageSender {
  const storeBotMessage = createBotMessageStore({
    db: input.db,
    botUserId: input.botUserId,
    botUsername: input.botUsername,
    routedFrom: input.routedFrom,
  });

  async function waitAfterRecentTyping(): Promise<void> {
    const lastTypingAt = input.getLastTypingAt?.() ?? 0;
    const sinceTypingMs = Date.now() - lastTypingAt;
    if (sinceTypingMs >= 0 && sinceTypingMs < 200) {
      await new Promise((resolve) => setTimeout(resolve, 200 - sinceTypingMs));
    }
  }

  function storeBotAssets(message: Message): void {
    syncMessageAssets(input.db, { messageId: message.id, assets: assetsFromDiscordMessage(message) });
  }

  function attachmentBuilders(attachments: OutboundAttachment[] | undefined): AttachmentBuilder[] {
    if (attachments === undefined || attachments.length === 0) return [];
    return attachments.map((attachment) => new AttachmentBuilder(attachment.buffer, { name: attachment.filename }));
  }

  return async (text, reply, channelId, voice, _signal, replyToMessageId, attachments, dedupeKey, presentation) => {
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
      storeBotAssets(sent);
      for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i] as string;
        const followup = await sendToTargetChannel(buildAttachmentPayload(
          chunk,
          [],
          discordMessageNonce(dedupeKey, `voice-${i}`),
        ));
        storeBotMessage(followup.id, targetGuildId, targetChannelId, chunk, chunk, null);
        storeBotAssets(followup);
      }
      noteThreadActivity(sent.id);
      return { sentMessageId: sent.id, warnings: unresolvedEmojiWarnings(warnings) };
    }

    const warnings: string[] = [];
    const translated = translateOutbound(text, outboundResolvers, warnings);
    const imageAttachments = attachmentBuilders(attachments);
    if (presentation?.kind === "components_v2_card") {
      if (imageAttachments.length > 0) throw new Error("Components V2 cards cannot use legacy attachments through this sender.");
      const payload = buildComponentsV2CardPayload(
        translated,
        presentation,
        discordMessageNonce(dedupeKey, "card-0"),
      );
      const delivered = replyToMessageId !== undefined
        ? await replyToSpecific(payload)
        : reply
          ? await replyToSource(payload)
          : { message: await sendToTargetChannel(payload), replyToId: null };
      storeBotMessage(
        delivered.message.id,
        targetGuildId,
        targetChannelId,
        text,
        presentation.history?.text ?? text,
        delivered.replyToId,
      );
      noteThreadActivity(delivered.message.id);
      return { sentMessageId: delivered.message.id, warnings: unresolvedEmojiWarnings(warnings) };
    }
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
      storeBotAssets(sent);
    }
    noteThreadActivity(firstId);
    return { sentMessageId: firstId, warnings: unresolvedEmojiWarnings(warnings) };
  };
}
