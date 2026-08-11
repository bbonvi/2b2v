import { RequestLog, type Logger } from "../logger";
import { type requestLogStore } from "../dashboard/store";
import type { GuildConfig } from "../config/types";
import { translateInbound, type InboundResolvers } from "../discord/translation";
import { appendStickerTags, messageDisplayContent } from "../discord/message-media";
import { channelDisplayName, createTargetChannelResolver, createTypingController, type SendableGuildChannel } from "../discord/message-sender";
import { type IncomingMessage, type MessageSender } from "../agent/turn-types";
import { trackWriteToolStarts } from "../agent/tool-access";
import { contentMentionsEveryone, shouldRespond, shouldRespondDeliberately, type TriggerInput, type TriggerResult } from "../agent/triggers";
import { typingSimulationDelayMs } from "../agent/typing-simulation";
import { createChannelDispatcher, DispatchSupersededError, selectDispatchMessageForTrigger, selectDispatchMessagesForTrigger, selectNormalDispatchTrigger, type ChannelDispatcher, type DispatchOutcome } from "../discord/channel-dispatcher";
import { type HistoryMessage } from "../agent/history-types";
import { getRoutedMessageSource, insertPromptOnlyMessageHandoff, insertSyntheticEvent } from "../db/message-state-repository";
import { createGeneratedImageRuntime, shortQuote } from "../agent/generated-image-runtime";
import { createCloseThreadTool, createStartThreadTool } from "../agent/start-thread-tool";
import { applyRuntimeToolPrompts } from "../agent/runtime-tool-prompts";
import { type createAmbientRuntime } from "../ambient/runtime";
import { type createPersonaModeRuntime } from "../modes/runtime";
import { getAssetsByMessageId } from "../db/asset-repository";
import { getEventWatch } from "../db/event-watch-repository.ts";
import { type createEventWatchRuntime, type EventWatchTurn } from "../event-watch/runtime.ts";
import { createUpdateCurrentEventWatchTool } from "../event-watch/current-watch-tool.ts";
import { type NormalizedWatchEvent } from "../event-watch/types.ts";
import { normalizeDiscordWatchMessage } from "../event-watch/discord-adapters.ts";
import { upsertThread, markThreadArchived, getThread } from "../db/thread-repository";
import { dashboardTriggerLocation } from "../dashboard/management-runtime";
import { type PromptBundle } from "../config/instruction-bundle";
import { createDiscordReplyFallbackDeps } from "../discord/reply-fallback-runtime";
import type { Database } from "../db/database";
import { type Client, type Guild, type Message, type ThreadChannel } from "discord.js";
import type { createContextRuntime } from "../agent/context-runtime";
import type { createMaintenanceRuntime } from "../agent/maintenance-runtime";
import type { createToolRuntime } from "../agent/tool-runtime";
import type { createTurnRuntime } from "../agent/turn-runtime";
import type { AgentJobStore } from "../agent/job-runtime.ts";
import { runtimePromptsForPrivateLife } from "../private-life/runtime.ts";
import { createBackgroundHandoffRunner } from "./background-handoff-runtime.ts";

/** Coordinate scheduled and autonomous attention for one process. */
export function createScheduledAttentionGuard() {
  const busy = new Map<string, number>();
  const key = (guildId: string, channelId: string): string => `${guildId}:${channelId}`;
  return {
    markScheduledAttentionBusy: (guildId: string, channelId: string): (() => void) => {
      const attentionKey = key(guildId, channelId);
      busy.set(attentionKey, Number.POSITIVE_INFINITY);
      return () => { busy.set(attentionKey, Date.now() + 30_000); };
    },
    isScheduledAttentionBusy: (guildId: string, channelId: string): boolean => {
      const attentionKey = key(guildId, channelId);
      const until = busy.get(attentionKey);
      if (until === undefined) return false;
      if (until === Number.POSITIVE_INFINITY || until > Date.now()) return true;
      busy.delete(attentionKey);
      return false;
    },
  };
}

export function createMessageTurnRuntime(input: {
    db: Database;
    client: Client;
    log: Logger;
    requestLogStore: typeof requestLogStore;
    agentJobs: AgentJobStore;
    getGuildConfig: (guildId: string) => GuildConfig;
    getPromptBundle: () => PromptBundle;
    buildInboundResolvers: (guild: Guild) => InboundResolvers;
    authorDisplayName: (message: Message) => string | undefined;
    buildContext: ReturnType<typeof createContextRuntime>["buildContext"];
    buildAgentTools: ReturnType<typeof createToolRuntime>["buildAgentTools"];
    createBotDiscordMessageSender: ReturnType<typeof createTurnRuntime>["createBotDiscordMessageSender"];
    createHandlerDeps: ReturnType<typeof createTurnRuntime>["createHandlerDeps"];
    createAssetAttachmentResolver: ReturnType<typeof createTurnRuntime>["createAssetAttachmentResolver"];
    runLoggedAgentTurn: ReturnType<typeof createTurnRuntime>["runLoggedAgentTurn"];
    createTtsGenerator: ReturnType<typeof createTurnRuntime>["createTtsGenerator"];
    blockToolsExcept: ReturnType<typeof createMaintenanceRuntime>["blockToolsExcept"];
    createPostReplyMaintenanceTools: ReturnType<typeof createMaintenanceRuntime>["createPostReplyMaintenanceTools"];
    runMemoryPostReplyExtraction: ReturnType<typeof createMaintenanceRuntime>["runMemoryPostReplyExtraction"];
    runRelationshipPostReplyExtraction: ReturnType<typeof createMaintenanceRuntime>["runRelationshipPostReplyExtraction"];
    runInnerThreadPostReplyExtraction: ReturnType<typeof createMaintenanceRuntime>["runInnerThreadPostReplyExtraction"];
    runPostReplyMaintenanceBurst: ReturnType<typeof createMaintenanceRuntime>["runPostReplyMaintenanceBurst"];
    persistIgnoredBotReply: ReturnType<typeof createTurnRuntime>["persistIgnoredBotReply"];
    persistPrivateThoughts: ReturnType<typeof createTurnRuntime>["persistPrivateThoughts"];
    fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
    getAmbientRuntime: () => ReturnType<typeof createAmbientRuntime>;
    getEventWatchRuntime: () => ReturnType<typeof createEventWatchRuntime>;
    runtimeContextTemplate: (name: string, variables?: Record<string, string | number | boolean | undefined>, fallback?: string) => string;
    preparePersonaModeTurn: (guildId: string) => ReturnType<ReturnType<typeof createPersonaModeRuntime>["prepareNaturalTurn"]>;
  }
) {
  const { db, client, log, requestLogStore, agentJobs, getGuildConfig, getPromptBundle, buildInboundResolvers, authorDisplayName, buildContext, buildAgentTools, createBotDiscordMessageSender, createHandlerDeps, createAssetAttachmentResolver, runLoggedAgentTurn, createTtsGenerator, blockToolsExcept, createPostReplyMaintenanceTools, runPostReplyMaintenanceBurst, persistIgnoredBotReply, persistPrivateThoughts, fetchAccessibleGuildChannel, getAmbientRuntime, getEventWatchRuntime, runtimeContextTemplate, preparePersonaModeTurn } = input;
type CurrentTurnBoundary = NonNullable<Parameters<typeof buildContext>[8]>;

const dispatchers = new Map<string, ChannelDispatcher>();

/** Get or create a channel dispatcher for a guild. */
function getOrCreateDispatcher(guildId: string): ChannelDispatcher {
  let dispatcher = dispatchers.get(guildId);
  if (dispatcher !== undefined) return dispatcher;

  const config = getGuildConfig(guildId);
  dispatcher = createChannelDispatcher({
    config: config.dispatcher,
    triggers: config.triggers,
    debug: (event, fields) => log.debug(event, { guildId, ...fields }),
    handler: async (batch, trigger, control): Promise<DispatchOutcome> => {
      if (trigger === null) return { coveredMessageIds: [] };
      const selected = selectDispatchMessageForTrigger(batch, trigger);
      if (selected === undefined) return { coveredMessageIds: [] };
      const currentTurnMessages = selectDispatchMessagesForTrigger(batch, trigger)
        .map((pending) => pending.message as Message);
      const matchedWatchIds = [...new Set(batch.flatMap((pending) =>
        pending.authorId === trigger.message.authorId ? pending.matchedWatchIds ?? [] : []
      ))];
      const ordinaryTrigger = selectNormalDispatchTrigger(batch) ?? trigger.result;
      if (matchedWatchIds.length > 0) {
        return await processSettledWatchedMessage(
          selected.message as Message,
          matchedWatchIds,
          ordinaryTrigger,
          currentTurnMessages,
        );
      }
      if (trigger.result === null) return { coveredMessageIds: [] };
      control.enableSupersession();
      return await processTriggeredMessage(selected.message as Message, trigger.result, currentTurnMessages, {
        abortSignal: control.signal,
        onActionCommitted: () => { control.commit(); },
      });
    },
  });
  dispatchers.set(guildId, dispatcher);
  return dispatcher;
}

function enqueueChannelTask(guildId: string, channelId: string, task: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const accepted = getOrCreateDispatcher(guildId).enqueueTask(channelId, async () => {
      try {
        await task();
        resolve();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("Serialized channel task failed.");
        reject(failure);
        throw failure;
      }
    });
    if (!accepted) reject(new Error("Channel dispatcher is draining."));
  });
}

const runBackgroundHandoff = createBackgroundHandoffRunner({
  agentJobs,
  getPromptBundle,
  fetchAccessibleGuildChannel,
  enqueueChannelTask,
  createCarrier: syntheticEventProxyMessage,
  runActorTurn: async (carrier, options) =>
    await processTriggeredMessage(carrier, { reason: "scheduled" }, [carrier], options),
});

function messageRepliesToOwnBot(message: Message): boolean {
  if (message.guildId === null || message.reference?.messageId === undefined) return false;
  const botUserId = client.user?.id ?? "";
  if (botUserId === "") return false;
  const row = db.raw
    .prepare("SELECT user_id, is_bot FROM messages WHERE id = ? AND guild_id = ? AND is_prompt_only = 0")
    .get(message.reference.messageId, message.guildId) as { user_id: string; is_bot: number } | null;
  return row !== null && row.user_id === botUserId && row.is_bot === 1;
}

function messageTriggerMentionFields(
  message: Message,
): Pick<TriggerInput, "mentionedUserIds" | "mentionedRoleIds" | "botRoleIds" | "mentionedEveryone"> {
  const botMember = message.guild?.members.me;
  return {
    mentionedUserIds: [...message.mentions.users.keys()],
    mentionedRoleIds: [...message.mentions.roles.keys()],
    botRoleIds: botMember === null || botMember === undefined
      ? []
      : [...botMember.roles.cache.keys()],
    mentionedEveryone: message.mentions.everyone && contentMentionsEveryone(message.content),
  };
}

function evaluateMessageTrigger(message: Message, guildConfig: GuildConfig, deliberateOnly = false): TriggerResult {
  const triggerInput = {
    content: message.content,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    botUserId: client.user?.id ?? "",
    ...messageTriggerMentionFields(message),
    repliedToBot: messageRepliesToOwnBot(message),
  };
  return deliberateOnly
    ? shouldRespondDeliberately(triggerInput, guildConfig.triggers)
    : shouldRespond(triggerInput, guildConfig.triggers);
}

function formatTriggerReason(trigger: NonNullable<TriggerResult>): string {
  return trigger.reason === "keyword" ? `keyword "${trigger.keyword}"` : trigger.reason;
}

function normalizedWatchMessage(message: Message, content?: string): Extract<NormalizedWatchEvent, { type: "message" }> {
  return normalizeDiscordWatchMessage({
    db,
    message,
    ...(content === undefined ? {} : { content }),
    botUserId: client.user?.id,
  });
}

async function processEventWatchTurn(turn: EventWatchTurn): Promise<{ visibleOutput: boolean }> {
  const watch = turn.watches[0];
  if (watch === undefined) return { visibleOutput: false };
  let message: Message | null = turn.sourceMessage instanceof Object
    && "id" in turn.sourceMessage
    ? turn.sourceMessage as Message
    : null;
  const sourceMatchesExecution = turn.event.guildId === watch.runInGuildId
    && "channelId" in turn.event
    && turn.event.channelId === watch.runInChannelId;
  if (message === null && turn.event.type === "message") {
    const sourceChannel = await fetchAccessibleGuildChannel(turn.event.channelId);
    message = await sourceChannel?.messages.fetch(turn.event.messageId).catch(() => null) ?? null;
  }
  if (!sourceMatchesExecution || message === null) {
    const targetChannel = await fetchAccessibleGuildChannel(watch.runInChannelId);
    if (targetChannel === null || targetChannel.guildId !== watch.runInGuildId) {
      throw new Error(`Watch execution channel ${watch.runInChannelId} is unavailable.`);
    }
    message = syntheticEventProxyMessage(
      targetChannel,
      `event-watch:${turn.fires.map((fire) => fire.id).join(":")}`,
      turn.event.at,
    );
  }
  const eventContent = turn.event.type === "message" && sourceMatchesExecution
    ? undefined
    : [
        "Untrusted matched event data:",
        JSON.stringify(turn.event),
      ].join("\n");
  const outcome = await processTriggeredMessage(
    message,
    turn.ordinaryTrigger,
    [message],
    {
      eventWatchTurn: turn,
      ...(eventContent === undefined
        ? {}
        : {
            currentTurnOverride: {
              messageId: `event-watch:${turn.fires.map((fire) => fire.id).join(":")}`,
              timestamp: turn.event.at,
              content: eventContent,
            },
          }),
    },
  );
  return { visibleOutput: outcome.visibleOutputSent === true };
}

/** Minimal Discord message carrier for a synthetic event in an execution channel. */
function syntheticEventProxyMessage(
  channel: SendableGuildChannel,
  id: string,
  createdTimestamp: number,
): Message {
  const author = client.user;
  if (author === null) throw new Error("Discord bot identity is unavailable.");
  return {
    id,
    guildId: channel.guildId,
    guild: channel.guild,
    channelId: channel.id,
    channel,
    author,
    member: channel.guild.members.me,
    content: "",
    components: [],
    embeds: [],
    stickers: { values: () => [][Symbol.iterator]() },
    mentions: {
      users: new Map(),
      roles: new Map(),
      everyone: false,
    },
    reference: null,
    webhookId: null,
    createdTimestamp,
  } as unknown as Message;
}

async function processSettledWatchedMessage(
  message: Message,
  matchedWatchIds: readonly string[],
  ordinaryTrigger: NonNullable<TriggerResult> | null,
  currentTurnMessages: readonly Message[],
): Promise<DispatchOutcome> {
  const event = normalizedWatchMessage(message);
  const groups = new Map<string, string[]>();
  for (const watchId of matchedWatchIds) {
    const watch = getEventWatch(db, watchId);
    if (watch === null) continue;
    const key = `${watch.runInGuildId}:${watch.runInChannelId}`;
    const ids = groups.get(key) ?? [];
    ids.push(watchId);
    groups.set(key, ids);
  }
  let ordinaryHandled = false;
  for (const [key, watchIds] of groups) {
    const turn = getEventWatchRuntime().claimMatched(watchIds, event);
    if (turn === null) continue;
    turn.sourceMessage = message;
    if (key === `${message.guildId}:${message.channelId}` && ordinaryTrigger !== null) {
      turn.ordinaryTrigger = ordinaryTrigger;
      ordinaryHandled = true;
    }
    await getEventWatchRuntime().executeClaimed(turn);
  }
  if (ordinaryTrigger !== null && !ordinaryHandled) {
    return await processTriggeredMessage(message, ordinaryTrigger, currentTurnMessages);
  }
  return { coveredMessageIds: currentTurnMessages.map((current) => current.id) };
}

/** Ambient pickup is deliberately absent because its message may not address the actor. */
function shouldAnnotateTriggerMessage(trigger: NonNullable<TriggerResult>): boolean {
  return trigger.reason === "mention"
    || trigger.reason === "keyword"
    || trigger.reason === "random"
    || trigger.reason === "lingering_attention";
}

async function processTriggeredMessage(
  message: Message,
  triggerOverride?: NonNullable<TriggerResult>,
  currentTurnMessages: readonly Message[] = [message],
  options: {
    disableLiveOutput?: boolean;
    currentTurnOverride?: {
      messageId: string;
      timestamp: number;
      content: string;
      bare?: boolean;
      omitCurrentContext?: boolean;
    };
    preSendCheck?: (draftText: string) => boolean | Promise<boolean>;
    onWriteToolStart?: (toolName: string) => void;
    abortSignal?: AbortSignal;
    onActionCommitted?: () => void;
    eventWatchTurn?: EventWatchTurn;
    dashboardTrigger?: unknown;
    initialToolNames?: readonly string[];
    preloadedSkillIds?: readonly string[];
    focusUserId?: string;
    currentRequest?: {
      requesterId: string;
      requesterUsername: string;
      sourceMessageId: string;
      sourceQuote: string;
    };
    actorSurface?: "channel" | "private-life";
  } = {},
): Promise<DispatchOutcome> {
  if (message.guild === null || message.guildId === null) return { coveredMessageIds: [] };
  const guild = message.guild;

  const guildId = message.guildId;
  const channelId = message.channelId;
  requestLogStore.incrementActive();
  const requestLog = new RequestLog(guildId, channelId, requestLogStore);
  requestLog.setAuthor(message.author.username);
  // Keep the dashboard's active row identifiable before the agent turn completes.
  requestLog.setTrigger(options.dashboardTrigger ?? triggerOverride ?? null);
  let requestLogEmitted = false;
  let activeTyping: ReturnType<typeof createTypingController> | null = null;

  try {
    const guildConfig = getGuildConfig(guildId);
    const inboundResolvers = buildInboundResolvers(guild);
    const displayContent = messageDisplayContent(message.content, message.components, message.author.username, message.embeds);
    const translatedContent = appendStickerTags(
      translateInbound(displayContent, inboundResolvers),
      message.stickers.values(),
    );
    const currentTurnEventContent = options.currentTurnOverride?.content ?? currentTurnMessages
      .map((current) => appendStickerTags(
        translateInbound(messageDisplayContent(current.content, current.components, current.author.username, current.embeds), inboundResolvers),
        current.stickers.values(),
      ))
      .filter((content) => content !== "")
      .join(" [msg-break] ");
    requestLog.setTriggerContext({
      ...dashboardTriggerLocation(guild, message.channel),
      messageId: options.currentTurnOverride?.messageId ?? message.id,
      authorUsername: message.author.username,
      content: options.currentTurnOverride?.content ?? displayContent,
      translatedContent: options.currentTurnOverride?.content ?? translatedContent,
    });
    const currentChannelObj = message.channel as SendableGuildChannel;
    const privateActorTurn = options.actorSurface === "private-life";
    const resolveTargetChannel = createTargetChannelResolver(client, currentChannelObj);
    const typing = createTypingController({
      defaultChannel: currentChannelObj,
      resolveTargetChannel,
    });
    activeTyping = typing;
    const typingStartDelayMs = typingSimulationDelayMs(guildConfig.typingSimulation, "input", currentTurnEventContent);
    if (!privateActorTurn) {
      if (guildConfig.typingSimulation.enabled) typing.scheduleStartLoop(typingStartDelayMs);
      else typing.startLoop();
    }
    const baseSender = createBotDiscordMessageSender({
      defaultChannel: currentChannelObj,
      resolveTargetChannel,
      botUserId: client.user?.id ?? "",
      botUsername: client.user?.username ?? "bot",
      logger: log,
      ...(options.currentTurnOverride === undefined ? { replySourceMessage: message } : {}),
      getLastTypingAt: typing.getLastTypingAt,
      routedFrom: {
        routedFromGuildId: guildId,
        routedFromChannelId: channelId,
        routedFromMessageId: message.id,
      },
    });
    const sentBotMessageIds: string[] = [];
    const sender: MessageSender = async (...args) => {
      const result = await baseSender(...args);
      if (result.sentMessageId !== "") {
        sentBotMessageIds.push(result.sentMessageId);
        const destinationChannelId = args[2] ?? channelId;
        getAmbientRuntime().markAmbientPickupChannelCooldown(guildConfig.ambientAttention, guildId, destinationChannelId);
        getAmbientRuntime().clearPendingAmbientKindInChannel("ambient_pickup", guildId, destinationChannelId);
      }
      return result;
    };
    let externalVisibleOutputSent = false;
    let noteExternalVisibleOutput = (): void => {};
    const markExternalVisibleOutput = (): void => {
      externalVisibleOutputSent = true;
      noteExternalVisibleOutput();
    };

    const currentAssets = options.currentTurnOverride === undefined
      ? currentTurnMessages.flatMap((current) => getAssetsByMessageId(db, current.id))
      : [];
    const currentTurnBoundary = options.currentTurnOverride !== undefined
      ? { timestamp: options.currentTurnOverride.timestamp, messageId: options.currentTurnOverride.messageId }
      : currentTurnMessages.reduce<CurrentTurnBoundary>(
        (earliest, current) => {
          if (
            current.createdTimestamp < earliest.timestamp ||
            (current.createdTimestamp === earliest.timestamp && current.id < earliest.messageId)
          ) {
            return { timestamp: current.createdTimestamp, messageId: current.id };
          }
          return earliest;
        },
        { timestamp: message.createdTimestamp, messageId: message.id },
      );
    const currentTurnMessageIds = options.currentTurnOverride !== undefined
      ? [options.currentTurnOverride.messageId]
      : [...new Set(currentTurnMessages.map((current) => current.id))];
    const repliedToBotRouteSource = message.reference?.messageId !== undefined
      ? getRoutedMessageSource(db, {
          messageId: message.reference.messageId,
          guildId,
          channelId,
        })
      : null;
    const latestUserMessage: HistoryMessage = {
      id: options.currentTurnOverride?.messageId ?? message.id,
      author: message.author.username,
      authorDisplayName: authorDisplayName(message),
      authorId: message.author.id,
      content: options.currentTurnOverride?.content ?? translatedContent,
      isBot: message.author.bot,
      ...(message.webhookId !== null ? { webhookId: message.webhookId } : {}),
      timestamp: options.currentTurnOverride?.timestamp ?? message.createdTimestamp,
      replyToId: options.currentTurnOverride === undefined ? message.reference?.messageId ?? null : null,
      assets: currentAssets.map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        sourceKind: asset.sourceKind,
        filename: asset.filename,
        contentType: asset.contentType,
        size: asset.size,
        width: asset.width,
        height: asset.height,
        durationSeconds: asset.durationSeconds,
        ...(asset.originalAssetId !== undefined ? { originalAssetId: asset.originalAssetId } : {}),
      })),
      hasEmbeds: options.currentTurnOverride === undefined && message.embeds.length > 0,
      isSynthetic: options.currentTurnOverride !== undefined,
      relatedThreadId: null,
    };

    const replyFallbackDeps = createDiscordReplyFallbackDeps({
      db,
      clientChannelsFetch: (chId) => client.channels.fetch(chId),
      guild,
      guildId,
      channelId,
      guildConfig,
    });

    const isThread = message.channel.isThread();
    preparePersonaModeTurn(guildId);
    const context = await buildContext(
      guildId,
      channelId,
      guild,
      guildConfig,
      options.currentTurnOverride?.content ?? translatedContent,
      latestUserMessage,
      replyFallbackDeps,
      isThread,
      currentTurnBoundary,
      options.actorSurface === "private-life" ? "private-life" : "live",
      options.currentTurnOverride !== undefined ? currentTurnMessageIds : undefined,
      {
        // Synthetic runtime events belong in their own LLM message, not canonical Discord history.
        appendLatestToHistory: options.currentTurnOverride === undefined,
        ...(options.focusUserId !== undefined
          ? { additionalVisibleUserIds: [options.focusUserId], memoryFocusUserId: options.focusUserId }
          : {}),
        ...(triggerOverride !== undefined && shouldAnnotateTriggerMessage(triggerOverride)
          ? { triggerMessageIds: currentTurnMessageIds }
          : {}),
      },
    );
    if (options.currentTurnOverride?.omitCurrentContext === true) {
      context.sections = context.sections.filter((section) => section.label !== "Current Context");
    }
    for (const skillId of options.preloadedSkillIds ?? []) {
      const skill = getPromptBundle().runtime.skills.byId[skillId];
      if (skill === undefined) continue;
      context.sections.push({
        label: `Loaded Skill: ${skill.title}`,
        role: "developer",
        cached: false,
        text: skill.content,
      });
    }
    if (options.actorSurface === "private-life") {
      const privateLifeInstruction = getPromptBundle().runtime.privateLife?.trim() ?? "";
      if (privateLifeInstruction !== "") {
        context.sections.push({
          label: "Private-Life Instruction",
          role: "developer",
          cached: false,
          text: privateLifeInstruction,
        });
      }
    }
    if (options.eventWatchTurn !== undefined) {
      const watchLines = options.eventWatchTurn.watches.flatMap((watch) => [
        `Watch ${watch.id}: ${watch.instruction}`,
        `Previous handoff: ${watch.handoffNote.trim() === "" ? "(none)" : watch.handoffNote.trim()}`,
      ]);
      context.sections.push({
        label: "Event Watch",
        role: "developer",
        cached: false,
        text: [
          "## Event Watch",
          runtimeContextTemplate("event-watch-execution-mode", {}, "Act on this matched watch only if it still matters."),
          options.eventWatchTurn.ordinaryTrigger === undefined
            ? ""
            : `This watched message also triggered ordinary attention through ${formatTriggerReason(options.eventWatchTurn.ordinaryTrigger)}. Handle both reasons in this action turn.`,
          ...watchLines,
        ].filter((line) => line !== "").join("\n"),
      });
    }

    const startThreadTool = createStartThreadTool({
      guildId,
      createThread: async (name: string) => {
        const thread = await message.startThread({ name });
        return {
          threadId: thread.id,
          threadName: thread.name,
          parentChannelId: channelId,
          starterMessageId: message.id,
        };
      },
      persistThread: (input) => upsertThread(db, {
        threadId: input.threadId,
        guildId: input.guildId,
        parentChatId: input.parentChannelId,
        starterMessageId: input.starterMessageId,
        threadName: input.threadName,
        createdByBot: true,
      }),
      onPersistError: (err) => {
        log.error("failed to persist thread record", {
          error: err instanceof Error ? err.message : String(err),
        });
      },
      onSuccess: (payload) => {
        try {
          insertSyntheticEvent(db, {
            id: crypto.randomUUID(),
            guildId,
            channelId: payload.parentChannelId,
            botUserId: client.user?.id ?? "",
            botUsername: client.user?.username ?? "bot",
            threadId: payload.threadId,
            threadName: payload.threadName,
          });
        } catch (err) {
          log.error("failed to insert synthetic event for thread", {
            threadId: payload.threadId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });
    const closeThreadTool = createCloseThreadTool({
      currentGuildId: guildId,
      currentChannelId: channelId,
      currentIsThread: isThread,
      lookupThread: (threadId) => {
        const row = getThread(db, threadId);
        if (row === null) return null;
        return {
          threadId: row.threadId,
          guildId: row.guildId,
          threadName: row.threadName,
          parentChannelId: row.parentChatId,
          createdByBot: row.createdByBot,
        };
      },
      closeThread: async (threadId) => {
        const resolved = await createTargetChannelResolver(client, currentChannelObj)(threadId);
        if (!resolved.isThread()) throw new Error("Target channel is not a thread.");
        await (resolved as ThreadChannel).setArchived(true, "closed by close_thread tool");
        return {
          threadId: resolved.id,
          threadName: resolved.name,
          parentChannelId: resolved.parentId ?? channelId,
        };
      },
      persistArchived: (threadId) => {
        markThreadArchived(db, threadId);
      },
    });
    const generatedImages = createGeneratedImageRuntime();
    const toolRequest = options.currentRequest ?? (options.eventWatchTurn === undefined
      ? {
          requesterId: message.author.id,
          requesterUsername: message.author.username,
          sourceMessageId: message.id,
          sourceQuote: shortQuote(translatedContent),
        }
      : {
          requesterId: "event-watch",
          requesterUsername: client.user?.username ?? "persona",
          sourceMessageId: options.currentTurnOverride?.messageId ?? message.id,
          sourceQuote: shortQuote(options.currentTurnOverride?.content ?? translatedContent),
        });
    const agentTools = buildAgentTools(
      guildId,
      channelId,
      guildConfig,
      guild,
      context.contextMessageIds,
      generatedImages.onGeneratedImage,
      toolRequest,
      {
        visibleUserIds: context.visibleUserIds ?? [],
        onVisibleOutput: markExternalVisibleOutput,
        deliverDiceRoll: async (input) => {
          const result = await sender(
            input.text,
            false,
            undefined,
            undefined,
            input.signal,
            input.sourceMessageId,
            undefined,
            input.dedupeKey,
            {
              kind: "components_v2_card",
              accentColor: 0x8f73ff,
              componentId: input.componentId,
              history: { text: input.historyText },
            },
          );
          if (result.sentMessageId === "") throw new Error("Discord did not return a roll result message ID.");
          markExternalVisibleOutput();
          return { sentMessageId: result.sentMessageId };
        },
      },
    );
    const threadTools = options.currentTurnOverride === undefined
      ? applyRuntimeToolPrompts([startThreadTool, closeThreadTool], getPromptBundle().runtime)
      : [];
    const watchUpdateTool = options.eventWatchTurn === undefined
      ? []
      : [createUpdateCurrentEventWatchTool({
          db,
          watchIds: options.eventWatchTurn.watches.map((watch) => watch.id),
          onCompleted: (watchId) => getEventWatchRuntime().cancelWatch(watchId),
        })];
    const baseExtraTools = [...agentTools, ...threadTools, ...watchUpdateTool];
    const extraTools = options.onWriteToolStart !== undefined
      ? trackWriteToolStarts(baseExtraTools, options.onWriteToolStart)
      : baseExtraTools;

    const incoming: IncomingMessage = {
      content: options.currentTurnOverride?.content ?? message.content,
      guildId,
      guildName: guild.name,
      channelId,
      channelName: channelDisplayName(message.channel),
      authorId: message.author.id,
      authorUsername: message.author.username,
      authorDisplayName: authorDisplayName(message),
      authorGlobalName: message.author.globalName ?? message.author.displayName,
      authorIsBot: message.author.bot,
      botUserId: client.user?.id ?? "",
      ...messageTriggerMentionFields(message),
      translatedContent: options.currentTurnOverride?.content ?? translatedContent,
      eventContent: currentTurnEventContent !== "" ? currentTurnEventContent : translatedContent,
      bareCurrentTurn: options.currentTurnOverride?.bare === true,
      currentContentInHistory: options.currentTurnOverride === undefined,
      messageId: options.currentTurnOverride?.messageId ?? message.id,
      ...(options.currentTurnOverride === undefined
        ? {
            replyToMessageId: message.reference?.messageId,
            repliedToBot: messageRepliesToOwnBot(message),
          }
        : { repliedToBot: false }),
      assets: latestUserMessage.assets,
      ...(repliedToBotRouteSource !== null
        ? {
            repliedToBotRouteSource: {
              sourceGuildId: repliedToBotRouteSource.routedFromGuildId,
              sourceChannelId: repliedToBotRouteSource.routedFromChannelId,
              sourceMessageId: repliedToBotRouteSource.routedFromMessageId,
              ...(repliedToBotRouteSource.handoff !== undefined
                && context.contextMessageIds?.includes(message.reference?.messageId ?? "") !== true
                ? { handoff: repliedToBotRouteSource.handoff }
                : {}),
            },
          }
        : {}),
    };
    const visibleMaintenanceTools = blockToolsExcept(createPostReplyMaintenanceTools({
      guild,
      guildConfig,
      memoryRequest: {
        sourceMessageId: options.currentTurnOverride?.messageId ?? message.id,
        userMessage: options.currentTurnOverride?.content ?? translatedContent,
        assistantReply: "",
        recentContext: "",
        context,
        incomingMessage: incoming,
        visibleReplySent: false,
      },
      currentUserId: message.author.id,
      currentUsername: message.author.username,
      sourceMessageId: options.currentTurnOverride?.messageId ?? message.id,
      sourceRequestId: requestLog.requestId,
    }), "", "visible reply mode");

    const tts = createTtsGenerator(guildConfig);

    const deps = createHandlerDeps({
      guildId,
      guildConfig,
      context,
      currentChannelId: channelId,
      sender,
      extraTools: [...extraTools, ...visibleMaintenanceTools],
      log: log.child({ guildId, channelId, requestId: requestLog.requestId }),
      requestLog,
      tts,
      generatedImages,
      resolveAssetAttachments: createAssetAttachmentResolver(guildId, guildConfig,
        log.child({ component: "stored-asset-attachments", guildId, channelId, requestId: requestLog.requestId })),
      overrides: {
        initialToolNames: options.initialToolNames,
        loadedSkillIds: options.preloadedSkillIds,
        ...(options.actorSurface === "private-life"
          ? {
              runtimePrompts: runtimePromptsForPrivateLife(getPromptBundle()),
              externalResponseSink: {
                startModelTurn: () => {},
                push: () => Promise.resolve(false),
                finish: (text: string) => Promise.resolve({ visible: false, memoryText: text, malformed: false }),
                abort: () => {},
              },
            }
          : {}),
        onTriggered: () => {
          if (!privateActorTurn && !guildConfig.typingSimulation.enabled) typing.startLoop();
        },
        ...(privateActorTurn
          ? {}
          : { onStillWorking: (destinationChannelId: string | undefined) => { typing.startLoop(destinationChannelId); } }),
        getTypingStartedAt: typing.getTypingStartedAt,
        onVisibleOutput: typing.stopLoop,
        hasExternalVisibleOutput: () => externalVisibleOutputSent,
        onAgentEnd: typing.stopLoop,
        triggerOverride,
        forceTrigger: options.eventWatchTurn !== undefined ? true : undefined,
        disableLiveOutput: options.disableLiveOutput,
        preSendCheck: options.preSendCheck,
        abortSignal: options.abortSignal,
        onActionCommitted: options.onActionCommitted,
        onIgnoredReply: ({ channelId: destinationChannelId, historyText }) => {
          persistIgnoredBotReply({
            guildId,
            channelId,
            destinationChannelId,
            botUserId: client.user?.id ?? "",
            botUsername: client.user?.username ?? "bot",
            sourceMessageId: message.id,
            historyText,
          });
          getAmbientRuntime().clearAmbientLeaseForUser(guildId, destinationChannelId ?? channelId, message.author.id);
        },
        onHandoffDelivered: (handoff) => {
          insertPromptOnlyMessageHandoff(db, {
            sourceGuildId: guildId,
            sourceChannelId: channelId,
            sourceMessageId: message.id,
            destinationGuildId: handoff.destinationGuildId,
            destinationChannelId: handoff.destinationChannelId,
            routedMessageId: handoff.routedMessageId,
            botUserId: client.user?.id ?? "",
            botUsername: client.user?.username ?? "bot",
            handoff: handoff.handoff,
          });
        },
        afterReply: async (memoryRequest) => {
          if (options.actorSurface === "private-life") return;
          if (options.currentTurnOverride !== undefined && options.eventWatchTurn !== undefined) return;
          await runPostReplyMaintenanceBurst({
            guildConfig,
            memoryRequest,
            guild,
            channel: message.channel,
            sourceRequestId: requestLog.requestId,
            source: "post_reply",
          });
        },
      },
    });
    noteExternalVisibleOutput = () => { deps.onVisibleOutput?.(); };

    try {
      await runLoggedAgentTurn({
        incoming,
        deps,
        requestLog,
        logger: log,
        dashboardTrigger: options.dashboardTrigger,
        afterSuccess: (result) => {
          persistPrivateThoughts({
            guildId,
            channelId,
            botUserId: client.user?.id ?? "",
            botUsername: client.user?.username ?? "bot",
            sourceMessageId: message.id,
            requestId: requestLog.requestId,
            thoughts: result.privateThoughts ?? [],
            maxChars: guildConfig.contextHistory.messageCharLimit,
          });
          const botMessageId = sentBotMessageIds.at(-1);
          // Attachment-only and intermediate-only replies have no response text;
          // the delivered Discord message is the durable signal for lingering attention.
          if (botMessageId === undefined) return;
          getAmbientRuntime().noteAmbientBotReply({
            guildId,
            channelId,
            userId: message.author.id,
            sourceMessageId: message.id,
            botMessageId,
            message,
            allowLease: triggerOverride?.reason === "mention" ||
              triggerOverride?.reason === "keyword" ||
              triggerOverride?.reason === "ambient_pickup" ||
              triggerOverride?.reason === "lingering_attention",
            allowFollowUp: triggerOverride?.reason === "mention" || triggerOverride?.reason === "keyword",
          });
        },
        onFinally: (completed, error) => {
          typing.stopLoop();
          if (error instanceof DispatchSupersededError) return;
          const completedTrigger = completed?.triggerResult ?? triggerOverride;
          if (
            completedTrigger?.reason === "mention" ||
            completedTrigger?.reason === "keyword" ||
            completedTrigger?.reason === "random"
          ) {
            getAmbientRuntime().clearAmbientNormalTriggerInFlight(guildId, channelId, message.author.id);
          }
        },
      });
    } finally {
      requestLogEmitted = true;
    }
    return {
      coveredMessageIds: currentTurnMessageIds,
      visibleOutputSent: sentBotMessageIds.length > 0 || externalVisibleOutputSent,
    };
  } catch (err) {
    if (err instanceof DispatchSupersededError) {
      log.debug("message turn superseded before model action", {
        messageId: message.id,
        guildId: message.guildId,
      });
      return { coveredMessageIds: [] };
    }
    if (!requestLogEmitted) {
      requestLog.setError(err instanceof Error ? err.message : String(err));
      requestLog.emit(log);
      requestLogEmitted = true;
    }
    log.error("messageCreate handler error", {
      messageId: message.id,
      guildId: message.guildId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { coveredMessageIds: [] };
  } finally {
    activeTyping?.stopLoop();
    requestLogStore.decrementActive();
  }
}


  return { dispatchers, getOrCreateDispatcher, enqueueChannelTask, runBackgroundHandoff, evaluateMessageTrigger, normalizedWatchMessage, processEventWatchTurn, processSettledWatchedMessage, processTriggeredMessage };
}
