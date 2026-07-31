import { type Logger } from "../logger";
import type { GuildConfig } from "../config/types";
import { translateInbound, type InboundResolvers } from "../discord/translation";
import { appendStickerTags, messageDisplayContent } from "../discord/message-media";
import { assetsFromDiscordMessage } from "../discord/message-assets";
import { type SendableGuildChannel } from "../discord/message-sender";
import { type TriggerResult } from "../agent/triggers";
import { cleanupDeletedDiscordMessage } from "../db/message-cleanup";
import { type createAmbientRuntime } from "../ambient/runtime";
import { syncMessageAssets } from "../db/asset-repository";
import { listPendingWatchMessageIds, markWatchMessageProcessed } from "../db/event-watch-repository.ts";
import { type createEventWatchRuntime } from "../event-watch/runtime.ts";
import { registerEventWatchDiscordAdapters } from "../event-watch/discord-adapters.ts";
import { upsertThread, updateThreadActivity } from "../db/thread-repository";
import { fetchMessagesAfterRestart } from "../discord/restart-catchup";
import { clearRestartRecoveryState, getRestartRecoveryState, listRecentDiscordChannels } from "../db/restart-recovery-repository";
import { type AsyncTaskTracker } from "../runtime/async-task-tracker";
import type { Database } from "../db/database";
import { type Client, type Guild, type Message, type Typing } from "discord.js";
import type { createAmbientMemoryRuntime } from "../agent/ambient-memory-runtime";
import type { createMessageTurnRuntime } from "./message-turn-runtime";

/** Buffer Discord messages until runtime wiring is ready. */
export function createStartupMessageQueue(client: Client) {
  const queue: Message[] = [];
  let handler: ((message: Message) => void) | undefined;
  client.on("messageCreate", (message) => {
    if (handler === undefined) queue.push(message);
    else handler(message);
  });
  return {
    attach: (next: (message: Message) => void): void => {
      handler = next;
      for (const message of queue.splice(0)) next(message);
    },
  };
}

export function registerMessageEvents(input: {
    db: Database;
    client: Client;
    log: Logger;
    inboundMessageTasks: AsyncTaskTracker;
    backgroundTasks: AsyncTaskTracker;
    getGuildConfig: (guildId: string) => GuildConfig;
    buildInboundResolvers: (guild: Guild) => InboundResolvers;
    fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
    evaluateMessageTrigger: ReturnType<typeof createMessageTurnRuntime>["evaluateMessageTrigger"];
    normalizedWatchMessage: ReturnType<typeof createMessageTurnRuntime>["normalizedWatchMessage"];
    processSettledWatchedMessage: ReturnType<typeof createMessageTurnRuntime>["processSettledWatchedMessage"];
    processTriggeredMessage: ReturnType<typeof createMessageTurnRuntime>["processTriggeredMessage"];
    getOrCreateDispatcher: ReturnType<typeof createMessageTurnRuntime>["getOrCreateDispatcher"];
    maybeRunAmbientMemoryExtraction: ReturnType<typeof createAmbientMemoryRuntime>["maybeRunAmbientMemoryExtraction"];
    ambientRuntime: ReturnType<typeof createAmbientRuntime>;
    eventWatchRuntime: ReturnType<typeof createEventWatchRuntime>;
    startupQueue: ReturnType<typeof createStartupMessageQueue>;
  }
) {
  const { db, client, log, inboundMessageTasks, backgroundTasks, getGuildConfig, buildInboundResolvers, fetchAccessibleGuildChannel, evaluateMessageTrigger, normalizedWatchMessage, processSettledWatchedMessage, processTriggeredMessage, getOrCreateDispatcher, maybeRunAmbientMemoryExtraction, ambientRuntime, eventWatchRuntime, startupQueue } = input;
  let acceptingDiscordMessages = true;
  const startupMessageQueue: Message[] = [];
  let startupMessageProcessingReady = false;
  let startupMessageQueueDraining = false;
  const RESTART_CATCHUP_MAX_AGE_MS = 30 * 60_000;
  const RESTART_CATCHUP_MAX_CHANNELS = 50;
  const RESTART_CATCHUP_MAX_MESSAGES_PER_CHANNEL = 500;
  startupQueue.attach(handleMessageCreateEvent);
function handleMessageCreateEvent(message: Message): void {
  if (!acceptingDiscordMessages) return;
  if (!startupMessageProcessingReady || startupMessageQueueDraining) {
    startupMessageQueue.push(message);
    return;
  }

  startInboundMessageTask(message);
}

function startInboundMessageTask(message: Message): void {
  void inboundMessageTasks.track(processDiscordMessageCreate(message));
}

function drainStartupMessageQueue(): void {
  if (startupMessageQueueDraining) return;
  startupMessageQueueDraining = true;
  const queued = startupMessageQueue.length;
  if (queued > 0) log.info("draining startup Discord message queue", { queued });
  try {
    while (startupMessageQueue.length > 0) {
      const message = startupMessageQueue.shift();
      if (message !== undefined) startInboundMessageTask(message);
    }
  } finally {
    startupMessageQueueDraining = false;
  }
}

/** Persist one live Discord message and report whether this process claimed it first. */
function persistInboundDiscordMessage(message: Message, rawContent: string, translatedContent: string): boolean {
  if (message.guild === null || message.guildId === null) return false;
  const guildId = message.guildId;
  const channelId = message.channelId;
  const messageCreatedAt = message.createdTimestamp;
  const now = Date.now();
  const inserted = db.raw
    .prepare(
      `INSERT OR IGNORE INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, webhook_id, created_at, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      message.id,
      guildId,
      channelId,
      message.author.id,
      message.author.username,
      rawContent,
      translatedContent,
      message.author.bot ? 1 : 0,
      message.webhookId,
      messageCreatedAt,
      message.reference?.messageId ?? null,
    );

  if (message.channel.isThread()) {
    const updated = updateThreadActivity(db, channelId, {
      lastActivityAt: messageCreatedAt,
      lastMessageId: message.id,
      archivedAt: message.channel.archived === true ? message.channel.archiveTimestamp : null,
    });
    if (!updated) {
      upsertThread(db, {
        threadId: channelId,
        guildId,
        parentChatId: message.channel.parentId ?? channelId,
        starterMessageId: channelId,
        threadName: message.channel.name,
        createdAt: message.channel.createdTimestamp ?? now,
        lastActivityAt: messageCreatedAt,
        lastMessageId: message.id,
        messageCount: message.channel.messageCount ?? 1,
        createdByBot: message.channel.ownerId === client.user?.id,
        archivedAt: message.channel.archived === true ? message.channel.archiveTimestamp : null,
      });
    }
  }

  syncMessageAssets(db, { messageId: message.id, assets: assetsFromDiscordMessage(message) });
  return inserted.changes > 0;
}

// --- 23. messageCreate handler ---
async function processDiscordMessageCreate(message: Message): Promise<void> {
  try {
    const authoredBySelf = message.author.id === client.user?.id;
    // Ignore DMs
    if (message.guild === null || message.guildId === null) return;

    const guild = message.guild;
    const guildId = message.guildId;
    const channelId = message.channelId;
    const guildConfig = getGuildConfig(guildId);
    // A delivered message consumes the user's previous typing indicator. Keep
    // ambient gates in sync with dispatcher typing, otherwise stale typing can
    // drop lingering/pickup/initiative candidates after the message arrived.
    ambientRuntime.clearAmbientTyping(guildId, channelId, message.author.id);

    // Build inbound resolvers and translate
    const inboundResolvers = buildInboundResolvers(guild);
    const displayContent = messageDisplayContent(message.content, message.components, message.author.username, message.embeds);
    const translatedContent = appendStickerTags(
      translateInbound(displayContent, inboundResolvers),
      message.stickers.values(),
    );
    const inserted = persistInboundDiscordMessage(message, displayContent, translatedContent);
    const pendingWatchEvaluation = db.raw.prepare(
      "SELECT 1 FROM event_watch_message_inbox WHERE message_id = ? AND state = 'pending'",
    ).get(message.id) !== null;
    if (!inserted && !pendingWatchEvaluation) return;

    const triggerResult = authoredBySelf ? null : evaluateMessageTrigger(message, guildConfig);
    const watchEvent = normalizedWatchMessage(message, translatedContent);
    const matchedWatchIds = await eventWatchRuntime.matchMessage(watchEvent);
    if (!authoredBySelf) ambientRuntime.maybeScheduleAmbientAttention(message, triggerResult);

    // Dispatch to handler: use channel dispatcher if enabled, otherwise call directly
    if (guildConfig.dispatcher.enabled) {
      getOrCreateDispatcher(guildId).enqueue(message, {
        authorId: message.author.id,
        triggerResult,
        matchedWatchIds,
      });
      if (!authoredBySelf && triggerResult === null && matchedWatchIds.length === 0) {
        void maybeRunAmbientMemoryExtraction(message, guildConfig);
      }
    } else {
      if (matchedWatchIds.length > 0) {
        await processSettledWatchedMessage(message, matchedWatchIds, triggerResult, [message]);
      } else if (!authoredBySelf && triggerResult === null) {
        void maybeRunAmbientMemoryExtraction(message, guildConfig);
      } else if (triggerResult !== null) {
        await processTriggeredMessage(message, triggerResult);
      }
    }
  } catch (err) {
    log.error("messageCreate handler error", {
      messageId: message.id,
      guildId: message.guildId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Recover deliberate triggers that arrived after coordinated shutdown stopped intake. */
async function recoverMessagesAfterRestart(): Promise<void> {
  const recovery = getRestartRecoveryState(db);
  if (recovery === null) return;

  const effectiveCutoffAt = Math.max(recovery.cutoffAt, Date.now() - RESTART_CATCHUP_MAX_AGE_MS);
  const channels = listRecentDiscordChannels(db, RESTART_CATCHUP_MAX_CHANNELS);
  let fetchedCount = 0;
  let claimedCount = 0;
  let triggerCount = 0;
  if (effectiveCutoffAt !== recovery.cutoffAt) {
    log.warn("restart catch-up cutoff was clamped", {
      storedCutoffAt: recovery.cutoffAt,
      effectiveCutoffAt,
      maxAgeMs: RESTART_CATCHUP_MAX_AGE_MS,
    });
  }

  for (const knownChannel of channels) {
    try {
      const channel = await fetchAccessibleGuildChannel(knownChannel.channelId);
      if (channel === null || channel.guildId !== knownChannel.guildId) continue;
      const fetched = await fetchMessagesAfterRestart<Message>({
        cutoffAt: effectiveCutoffAt,
        maxMessages: RESTART_CATCHUP_MAX_MESSAGES_PER_CHANNEL,
        fetchAfter: async (afterMessageId, limit) => {
          const page = await channel.messages.fetch({ after: afterMessageId, limit, cache: false });
          return [...page.values()];
        },
      });
      fetchedCount += fetched.fetched;
      if (fetched.capped) {
        log.warn("restart catch-up channel reached message cap", {
          guildId: knownChannel.guildId,
          channelId: knownChannel.channelId,
          maxMessages: RESTART_CATCHUP_MAX_MESSAGES_PER_CHANNEL,
        });
      }

      const recovered: Array<{ message: Message; triggerResult: TriggerResult; matchedWatchIds: string[] }> = [];
      for (const message of fetched.messages) {
        if (message.author.id === client.user?.id || message.guild === null || message.guildId === null) continue;
        const displayContent = messageDisplayContent(message.content, message.components, message.author.username, message.embeds);
        const translatedContent = appendStickerTags(
          translateInbound(displayContent, buildInboundResolvers(message.guild)),
          message.stickers.values(),
        );
        if (!persistInboundDiscordMessage(message, displayContent, translatedContent)) continue;
        claimedCount += 1;
        const guildConfig = getGuildConfig(message.guildId);
        const triggerResult = evaluateMessageTrigger(message, guildConfig, true);
        const matchedWatchIds = await eventWatchRuntime.matchMessage(normalizedWatchMessage(message, translatedContent));
        if (triggerResult !== null) triggerCount += 1;
        recovered.push({ message, triggerResult, matchedWatchIds });
      }

      if (!recovered.some((entry) => entry.triggerResult !== null || entry.matchedWatchIds.length > 0)) continue;
      const guildConfig = getGuildConfig(knownChannel.guildId);
      for (const entry of recovered) {
        if (entry.triggerResult !== null) {
          // Reuse only the normal-trigger guard; null recovered messages never seed ambient work.
          ambientRuntime.maybeScheduleAmbientAttention(entry.message, entry.triggerResult);
        }
        if (guildConfig.dispatcher.enabled) {
          getOrCreateDispatcher(knownChannel.guildId).enqueue(entry.message, {
            authorId: entry.message.author.id,
            triggerResult: entry.triggerResult,
            matchedWatchIds: entry.matchedWatchIds,
          });
        } else if (entry.matchedWatchIds.length > 0) {
          await processSettledWatchedMessage(entry.message, entry.matchedWatchIds, entry.triggerResult, [entry.message]);
        } else if (entry.triggerResult !== null) {
          await processTriggeredMessage(entry.message, entry.triggerResult);
        }
      }
    } catch (error) {
      log.warn("restart catch-up channel failed", {
        guildId: knownChannel.guildId,
        channelId: knownChannel.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  clearRestartRecoveryState(db);
  log.info("restart catch-up complete", {
    cutoffAt: effectiveCutoffAt,
    channels: channels.length,
    fetched: fetchedCount,
    claimed: claimedCount,
    triggers: triggerCount,
  });
}

/** Finish watch evaluation for messages committed before an interrupted live evaluation. */
async function recoverPendingWatchMessages(): Promise<void> {
  let recovered = 0;
  for (const messageId of listPendingWatchMessageIds(db)) {
    const row = db.raw.prepare(
      "SELECT guild_id, channel_id FROM messages WHERE id = ?",
    ).get(messageId) as { guild_id: string; channel_id: string } | null;
    if (row === null) continue;
    try {
      const channel = await fetchAccessibleGuildChannel(row.channel_id);
      if (channel === null || channel.guildId !== row.guild_id) {
        markWatchMessageProcessed(db, messageId);
        continue;
      }
      const message = await channel.messages.fetch(messageId);
      const displayContent = messageDisplayContent(message.content, message.components, message.author.username, message.embeds);
      const translatedContent = appendStickerTags(
        translateInbound(displayContent, buildInboundResolvers(message.guild)),
        message.stickers.values(),
      );
      const matchedWatchIds = await eventWatchRuntime.matchMessage(normalizedWatchMessage(message, translatedContent));
      if (matchedWatchIds.length > 0) {
        await processSettledWatchedMessage(message, matchedWatchIds, null, [message]);
      }
      recovered += 1;
    } catch (error) {
      log.warn("pending watch message recovery failed", {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (recovered > 0) log.info("pending watch messages recovered", { recovered });
}

let eventWatchDiscordAdapters: ReturnType<typeof registerEventWatchDiscordAdapters> | null = null;

function registerDiscordListeners(): void {
  if (eventWatchDiscordAdapters !== null) return;

client.on("messageUpdate", (_oldMessage, updatedMessage) => {
  if (!acceptingDiscordMessages) return;
  if (updatedMessage.guildId === null) return;
  const stored = db.raw.prepare("SELECT 1 AS present FROM messages WHERE id = ?").get(updatedMessage.id) as { present: number } | null;
  if (stored === null) return;
  const task = updatedMessage.fetch().then((message) => {
    syncMessageAssets(db, { messageId: message.id, assets: assetsFromDiscordMessage(message) });
  }).catch((error: unknown) => {
    log.warn("message asset update failed", { messageId: updatedMessage.id, error: error instanceof Error ? error.message : String(error) });
  });
  void backgroundTasks.track(task);
});

// --- 24. messageDelete handler ---
client.on("messageDelete", (message) => {
  if (!acceptingDiscordMessages) return;
  try {
    if (message.guildId === null) return;

    const messageId = message.id;
    const guildId = message.guildId;
    const result = cleanupDeletedDiscordMessage({ db, guildId, messageId });
    if (result.messagesDeleted === 0) return;

    log.debug("message deleted from Discord", { messageId, guildId });
  } catch (err) {
    log.error("messageDelete handler error", {
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

client.on("typingStart", (typing: Typing) => {
  if (!acceptingDiscordMessages) return;
  if (!typing.inGuild() || typing.user.bot) return;
  ambientRuntime.noteAmbientTyping(typing);
  if (!getGuildConfig(typing.guild.id).dispatcher.enabled) return;
  getOrCreateDispatcher(typing.guild.id).recordTyping(typing.channel.id, typing.user.id);
});

eventWatchDiscordAdapters = registerEventWatchDiscordAdapters({
  client,
  db,
  runtime: eventWatchRuntime,
  log,
  isAcceptingEvents: () => acceptingDiscordMessages,
  trackTask: (task) => { void backgroundTasks.track(task); },
});
}

  return {
    getEventWatchDiscordAdapters: () => eventWatchDiscordAdapters,
    recoverMessagesAfterRestart,
    recoverPendingWatchMessages,
    registerDiscordListeners,
    stop: () => {
      acceptingDiscordMessages = false;
      startupMessageProcessingReady = false;
      eventWatchDiscordAdapters?.stop();
    },
    start: () => { startupMessageProcessingReady = true; drainStartupMessageQueue(); },
    isAccepting: () => acceptingDiscordMessages,
  };
}
