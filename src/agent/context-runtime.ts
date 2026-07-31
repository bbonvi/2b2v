import { type Logger } from "../logger";
import { type loadGlobalConfig } from "../config/loader";
import type { GuildConfig } from "../config/types";
import { buildDiscordContext } from "../discord/context-renderer";
import { buildDisplayNameContext, type InboundResolvers, type OutboundResolvers } from "../discord/translation";
import { type EmojiCache, buildEmojiContext, type EmojiEntry } from "../discord/emoji-cache";
import { guildEmojiEntries, syncGuildEmojiCache } from "../discord/emoji-cache-sync";
import { channelDisplayName, isSendableGuildChannel } from "../discord/message-sender";
import { assembleContext, type AssembledContext, type ThreadMetadata } from "../agent/context-assembly";
import { PRIVATE_HANDOFF_MESSAGE_ID_PREFIX, type HistoryMessage } from "../agent/history-types";
import { getLatestMessageActivityBefore, listDiscordChannelUsage, type MessageActivity } from "../db/message-activity-repository";
import { getContextHistoryMessages, getParentPreContext } from "../db/message-history-repository";
import { processHistory } from "../agent/history-pipeline";
import { trimMessages } from "../agent/history-trimming";
import { formatHistoryContent, formatMessageLine, OLDER_LEGEND } from "../agent/history-formatting";
import { insertDateStamps } from "../agent/history-dates";
import { formatRelativeAgo } from "../agent/history-dates";
import { currentLocalContext, formatElapsedDuration } from "../time/agent-time";
import type { ReplyFallbackDeps } from "../agent/reply-target-fallback";
import { buildMemoryContext, buildPrivateLifeMemoryContext } from "../agent/memory-context";
import { buildRepertoireContext } from "../agent/repertoire-context.ts";
import { buildNotebooksContext } from "../agent/notebook-service.ts";
import { buildInnerThreadsContext } from "../agent/inner-thread-service";
import { type AgentJobStore } from "../agent/job-runtime";
import { annotateHistoryJobs, renderAgentJobsContext } from "../agent/generated-image-runtime";
import { listEventWatches } from "../db/event-watch-repository.ts";
import { upsertThread, listThreadsForContext, getThreadMetadata, getThread } from "../db/thread-repository";
import { countUserMemoriesByUser } from "../db/memory-repository";
import { buildPriorExchangesContext, getRelationshipProfile, hasRelationshipData, listRelationshipEvents, listRelationshipProfiles, renderNotableRelationshipsContext, renderRelationshipPromptContext, selectRelationshipAnchorProfiles, type RelationshipContextProfile, type RelationshipConfig } from "../relationships";
import { listUpcomingForContext } from "../db/schedule-repository";
import { type PromptBundle } from "../config/instruction-bundle";
import type { Database } from "../db/database";
import { ChannelType, type Client, type Guild, type GuildMember, type Message } from "discord.js";

export function createContextRuntime(input: {
    db: Database;
    client: Client;
    emojiCache: EmojiCache;
    agentJobs: AgentJobStore;
    log: Logger;
    getGlobalConfig: () => ReturnType<typeof loadGlobalConfig>;
    getPromptBundle: () => PromptBundle;
    getRelationshipConfig: (guildConfig: GuildConfig) => RelationshipConfig;
    innerThreadsEnabled: (guildConfig: GuildConfig) => boolean;
    notebooksEnabled: (guildConfig: GuildConfig) => boolean;
    runtimeContextTemplate: (name: string, variables?: Record<string, string | number | boolean | undefined>, fallback?: string) => string;
    resolveStoredUsername: (userId: string) => string;
    voicePresenceContext: () => string;
    renderPersonaModeContext: (guildId: string) => string;
  }
) {
  const { db, client, emojiCache, agentJobs, log, getGlobalConfig, getPromptBundle, getRelationshipConfig, innerThreadsEnabled, notebooksEnabled, runtimeContextTemplate, resolveStoredUsername, voicePresenceContext, renderPersonaModeContext } = input;
const EMOJI_TTL_MS = 10 * 60 * 1000;
function buildInboundResolvers(guild: Guild): InboundResolvers {
  return {
    user: (id) => {
      const member = guild.members.cache.get(id);
      if (member === undefined) return undefined;
      return { username: member.user.username, displayName: member.displayName };
    },
    channel: (id) => {
      const ch = guild.channels.cache.get(id);
      return ch !== undefined ? ch.name : undefined;
    },
    role: (id) => {
      const role = guild.roles.cache.get(id);
      return role !== undefined ? role.name : undefined;
    },
  };
}

function buildOutboundResolvers(guild: Guild): OutboundResolvers {
  return {
    user: (username) => {
      return resolveGuildUsername(guild, username);
    },
    channel: (name) => {
      const ch = guild.channels.cache.find((c) => c.name === name);
      return ch !== undefined ? ch.id : undefined;
    },
    emoji: (name) => emojiCache.lookup(guild.id, name),
  };
}

function buildCurrentDisplayNameMap(guild: Guild): ReadonlyMap<string, string> {
  return new Map([...guild.members.cache.values()].map((member) => [member.id, member.displayName]));
}

function authorDisplayName(message: Message): string | undefined {
  return message.member?.displayName ?? message.author.globalName ?? message.author.displayName;
}

/** Resolve a guild member username case-insensitively, accepting an optional leading @. */
function resolveGuildUsername(guild: Guild, username: string): string | undefined {
  const normalized = username.trim().startsWith("@")
    ? username.trim().slice(1).trim().toLowerCase()
    : username.trim().toLowerCase();
  if (normalized === "") return undefined;
  const member = guild.members.cache.find((m) => m.user.username.toLowerCase() === normalized);
  return member?.id;
}

/** Resolve a username from the current guild first, then Discord's global user cache. */
function resolveKnownUsername(guild: Guild, username: string): string | undefined {
  const guildUserId = resolveGuildUsername(guild, username);
  if (guildUserId !== undefined) return guildUserId;
  const normalized = username.trim().replace(/^@+/, "").trim().toLowerCase();
  if (normalized === "") return undefined;
  return client.users.cache.find((user) => user.username.toLowerCase() === normalized)?.id;
}

/** Resolve a user ID for prompt labels from live Discord state or stored message history. */
function resolvePromptUsername(guild: Guild, userId: string): string | undefined {
  const live = guild.members.cache.get(userId)?.user.username ?? client.users.cache.get(userId)?.username;
  if (live !== undefined && live !== "") return live;
  const stored = resolveStoredUsername(userId);
  return stored !== userId && stored !== "" ? stored : undefined;
}

/** Resolve a guild member by raw mention, user ID, username, or @username. */
async function resolveGuildMemberReference(guild: Guild, reference: string): Promise<GuildMember | undefined> {
  const trimmed = reference.trim();
  if (trimmed === "") return undefined;

  const mentionId = /^<@!?(\d+)>$/.exec(trimmed)?.[1];
  const directUserId = /^\d{17,20}$/.test(trimmed) ? trimmed : undefined;
  const userId = mentionId ?? directUserId;
  if (userId !== undefined) {
    const cached = guild.members.cache.get(userId);
    if (cached !== undefined) return cached;
    try {
      return await guild.members.fetch(userId);
    } catch {
      return undefined;
    }
  }

  const cachedUsername = resolveGuildUsername(guild, trimmed);
  if (cachedUsername !== undefined) return guild.members.cache.get(cachedUsername);
  try {
    await guild.members.fetch();
  } catch {
    // Cache-only fallback below handles missing permissions.
  }
  const fetchedUsername = resolveGuildUsername(guild, trimmed);
  return fetchedUsername !== undefined ? guild.members.cache.get(fetchedUsername) : undefined;
}

// --- 18. Refresh emoji cache for a guild ---
function refreshEmojiCache(guild: Guild): void {
  if (!emojiCache.isStale(guild.id, EMOJI_TTL_MS)) return;
  syncGuildEmojiCache(emojiCache, guild);
}

async function fetchEmojiCache(guild: Guild): Promise<EmojiEntry[]> {
  await guild.emojis.fetch();
  const emojis = guildEmojiEntries(guild);
  emojiCache.set(guild.id, emojis);
  return emojis;
}

// --- 19. Build assembled context for a guild+channel ---
function elapsedLine(label: string, activity: MessageActivity | null, now: number): string {
  if (activity === null) return `${label}: none known`;
  return `${label}: ${formatElapsedDuration(activity.createdAt, now)}`;
}

interface CurrentTurnBoundary {
  timestamp: number;
  messageId: string;
}

function buildTemporalContext(input: {
  guildId: string;
  channelId: string;
  timezone: string;
  latestUserMessage: HistoryMessage;
  currentTurnBoundary?: CurrentTurnBoundary;
}): string {
  const now = Date.now();
  const botUserId = client.user?.id;
  const currentTurnBoundary = input.currentTurnBoundary ?? {
    timestamp: input.latestUserMessage.timestamp,
    messageId: input.latestUserMessage.id,
  };
  const before = {
    beforeCreatedAt: currentTurnBoundary.timestamp,
    beforeMessageId: currentTurnBoundary.messageId,
  };
  const previousChannelMessage = getLatestMessageActivityBefore(db, {
    ...before,
    guildId: input.guildId,
    channelId: input.channelId,
  });
  const previousUserChannelMessage = getLatestMessageActivityBefore(db, {
    ...before,
    guildId: input.guildId,
    channelId: input.channelId,
    userId: input.latestUserMessage.authorId,
    isBot: input.latestUserMessage.isBot,
  });
  const previousUserAnyMessage = getLatestMessageActivityBefore(db, {
    ...before,
    userId: input.latestUserMessage.authorId,
    isBot: input.latestUserMessage.isBot,
  });
  const previousBotChannelMessage = botUserId !== undefined
    ? getLatestMessageActivityBefore(db, {
      ...before,
      guildId: input.guildId,
      channelId: input.channelId,
      userId: botUserId,
      isBot: true,
    })
    : null;
  const previousBotAnyMessage = botUserId !== undefined
    ? getLatestMessageActivityBefore(db, {
      ...before,
      userId: botUserId,
      isBot: true,
    })
    : null;

  return [
    currentLocalContext(input.timezone, now),
    elapsedLine("Elapsed since previous visible message in this channel", previousChannelMessage, now),
    elapsedLine("Elapsed since this user's previous message in this channel", previousUserChannelMessage, now),
    elapsedLine("Elapsed since this user's previous message in any guild/channel", previousUserAnyMessage, now),
    elapsedLine("Elapsed since your previous visible message in this channel", previousBotChannelMessage, now),
    elapsedLine("Elapsed since your previous visible message in any guild/channel", previousBotAnyMessage, now),
  ].join("\n");
}

type RelationshipContextRunMode = "live" | "virtual" | "private-life";

function notableRelationshipProfiles(): RelationshipContextProfile[] {
  return listRelationshipProfiles(db, 100)
    .filter(hasRelationshipData)
    .map((profile) => ({
      profile,
      score: Object.values(profile.axes).reduce((sum, value) => sum + Math.abs(value), 0)
        + profile.notes.length * 3
        + profile.boundaries.length * 2
        + profile.openLoops.length * 4
        + profile.recent.length * 2,
    }))
    .sort((a, b) => {
      const scoreDifference = b.score - a.score;
      return scoreDifference !== 0 ? scoreDifference : b.profile.updatedAt - a.profile.updatedAt;
    })
    .slice(0, 13)
    .map(({ profile }) => ({ profile, label: profile.userId, reason: "high-score" }));
}

function buildRelationshipPromptContext(input: {
  guildConfig: GuildConfig;
  latestUserMessage: HistoryMessage;
  currentGuildId: string;
  currentChannelId: string;
  botUserId?: string;
  visibleUserIds: string[];
  resolveUserLabel: (userId: string) => string;
  mode: RelationshipContextRunMode;
  notable?: RelationshipContextProfile[];
  anchors?: RelationshipContextProfile[];
}): string {
  const config = getRelationshipConfig(input.guildConfig);
  if (!config.enabled || !config.promptInjection) return "";
  if (input.mode === "private-life") {
    const notable = input.notable ?? [];
    return renderNotableRelationshipsContext({
      full: notable.slice(0, 3),
      compact: notable.slice(3, 13),
      template: getPromptBundle().runtime.relationships.context,
    });
  }
  const currentUserId = input.latestUserMessage.authorId;
  const current = getRelationshipProfile(db, currentUserId);
  const anchorUserIds = new Set((input.anchors ?? []).map((entry) => entry.profile.userId));
  const anchors = (input.anchors ?? [])
    .filter((entry) => entry.profile.userId !== currentUserId)
    .map((entry): RelationshipContextProfile => ({
      ...entry,
      events: listRelationshipEvents(db, { userId: entry.profile.userId, limit: 500 }),
    }));
  const visible = input.visibleUserIds
    .filter((userId) => userId !== currentUserId)
    .map((userId): RelationshipContextProfile => ({
      profile: getRelationshipProfile(db, userId),
      label: input.resolveUserLabel(userId),
      reason: "recent-chat",
    }))
    .filter((entry) => hasRelationshipData(entry.profile) && !anchorUserIds.has(entry.profile.userId))
    .slice(0, 3)
    .map((entry): RelationshipContextProfile => ({
      ...entry,
      events: listRelationshipEvents(db, { userId: entry.profile.userId, limit: 500 }),
    }));
  return renderRelationshipPromptContext({
    current,
    currentLabel: input.resolveUserLabel(currentUserId),
    currentEvents: listRelationshipEvents(db, { userId: currentUserId, limit: 500 }),
    anchors,
    others: visible,
    priorExchanges: input.mode === "live" && input.botUserId !== undefined
      ? buildPriorExchangesContext({
          db,
          enabled: config.priorExchanges.enabled,
          profile: current,
          botUserId: input.botUserId,
          currentUserId,
          currentGuildId: input.currentGuildId,
          currentChannelId: input.currentChannelId,
          maxExchanges: config.priorExchanges.maxExchanges,
          maxMessageChars: config.priorExchanges.maxMessageChars,
          refreshMinutes: config.priorExchanges.refreshMinutes,
        })
      : "",
    template: getPromptBundle().runtime.relationships.context,
    includeCurrent: input.mode !== "virtual" || !input.latestUserMessage.isBot,
  });
}


async function buildContext(
  guildId: string,
  channelId: string,
  guild: Guild,
  guildConfig: GuildConfig,
  userMessage: string,
  latestUserMessage: HistoryMessage,
  replyFallbackDeps: ReplyFallbackDeps,
  isThread: boolean,
  currentTurnBoundary?: CurrentTurnBoundary,
  relationshipsMode: RelationshipContextRunMode = "live",
  excludeMessageIds?: readonly string[],
  historyOptions: {
    appendLatestToHistory?: boolean;
    triggerMessageIds?: readonly string[];
    additionalVisibleUserIds?: readonly string[];
    includeHistory?: boolean;
    historyLimit?: number;
    memoryFocusUserId?: string;
  } = {},
): Promise<AssembledContext> {
  // Chat history via the full processing pipeline
  const visibleJobs = agentJobs.listVisible(guildId, channelId);
  const displayNamesByUserId = buildCurrentDisplayNameMap(guild);
  const appendLatestToHistory = historyOptions.appendLatestToHistory ?? true;
  const loadedHistoryMessages = historyOptions.includeHistory === false
    ? []
    : getContextHistoryMessages(
        db,
        channelId,
        guildConfig.trim,
        appendLatestToHistory ? (excludeMessageIds ?? latestUserMessage.id) : excludeMessageIds,
      );
  const historyMessages = historyOptions.historyLimit === undefined
    ? loadedHistoryMessages
    : loadedHistoryMessages.slice(-historyOptions.historyLimit);
  const historyWithoutLatest = annotateHistoryJobs(
    historyMessages,
    guildId,
    channelId,
    agentJobs.annotationForMessage.bind(agentJobs),
  );
  const annotatedLatestUserMessage = {
    ...latestUserMessage,
    jobAnnotations: [
      ...(latestUserMessage.jobAnnotations ?? []),
      ...agentJobs.annotationForMessage(latestUserMessage.id, guildId, channelId),
    ],
  };
  const { olderText, newerText, visibleUserIds: historyVisibleUserIds } = await processHistory(
    historyWithoutLatest,
    appendLatestToHistory ? annotatedLatestUserMessage : null,
    {
      trim: guildConfig.trim,
      mergeMessageGapSeconds: guildConfig.mergeMessageGapSeconds,
      timezone: guildConfig.timezone,
      triggerMessageIds: historyOptions.triggerMessageIds,
      displayNamesByUserId,
    },
    replyFallbackDeps,
  );
  const visibleUserIds = [...new Set([
    ...historyVisibleUserIds,
    ...(historyOptions.additionalVisibleUserIds ?? []),
  ])];
  const memoryFocusUserId = historyOptions.memoryFocusUserId ?? latestUserMessage.authorId;
  const resolveRelationshipUserLabel = (userId: string): string => {
    const member = guild.members.cache.get(userId);
    const username = member?.user.username ?? userId;
    const displayName = member?.displayName;
    return displayName !== undefined && displayName !== username
      ? `@${username} (${displayName}) / ${userId}`
      : `@${username} / ${userId}`;
  };
  const relationshipConfig = getRelationshipConfig(guildConfig);
  const relationshipAnchors = relationshipsMode !== "private-life"
    && relationshipConfig.enabled
    && relationshipConfig.promptInjection
    ? selectRelationshipAnchorProfiles(listRelationshipProfiles(db, 500)).map(
        (profile): RelationshipContextProfile => ({
          profile,
          label: resolveRelationshipUserLabel(profile.userId),
          reason: "anchor",
        }),
      )
    : [];

  const notable = relationshipsMode === "private-life"
    ? notableRelationshipProfiles().map((entry) => ({
        ...entry,
        label: resolveRelationshipUserLabel(entry.profile.userId),
      }))
    : [];
  const memories = relationshipsMode === "private-life"
    ? buildPrivateLifeMemoryContext({
        db,
        guildId,
        notableUserIds: notable.slice(0, 3).map((entry) => entry.profile.userId),
        limit: guildConfig.memoryContext?.maxRows ?? 80,
        resolveUserId: (userId) => resolvePromptUsername(guild, userId),
        contextInstruction: getPromptBundle().runtime.contextTemplates.memory,
      })
    : buildMemoryContext({
        db,
        guildId,
        currentUserId: memoryFocusUserId,
        visibleUserIds,
        relationshipAnchorUserIds: relationshipAnchors.map((entry) => entry.profile.userId),
        limit: guildConfig.memoryContext?.maxRows ?? 80,
        resolveUserId: (userId) => resolvePromptUsername(guild, userId),
        contextInstruction: getPromptBundle().runtime.contextTemplates.memory,
      });
  const notebookConfig = guildConfig.notebooks ?? getGlobalConfig().defaultNotebooks;
  const notebooks = notebooksEnabled(guildConfig) && notebookConfig !== undefined
    ? buildNotebooksContext({
        db,
        guildId,
        visibleUserIds,
        maxTitles: notebookConfig.maxPromptTitles,
      })
    : "";

  const pendingSchedules = listUpcomingForContext(db, guildId, channelId);
  const oneOffCount = pendingSchedules.filter((s) => s.type === "one_off").length;
  const cronCount = pendingSchedules.length - oneOffCount;
  const activeWatches = listEventWatches(db, {
    guildId,
    channelId,
    scope: "current_channel",
    enabledOnly: true,
  });
  const upcomingSchedules = runtimeContextTemplate("private-commitments", {
    scheduleTotal: pendingSchedules.length,
    oneOffCount,
    cronCount,
    watchCount: activeWatches.length,
  }, `Private commitments in this channel: ${pendingSchedules.length} schedules, ${activeWatches.length} event watches.`);
  const liveChannel = await client.channels.fetch(channelId).catch(() => guild.channels.cache.get(channelId) ?? null);
  const currentChannelName = channelDisplayName(liveChannel);
  const discordActivityNow = Date.now();
  const discordContext = buildDiscordContext({
    client,
    currentGuildId: guildId,
    currentGuildName: guild.name,
    currentChannelId: channelId,
    currentChannelName,
    navigationTemplate: runtimeContextTemplate("discord-navigation", {}, "Guild shortlist for navigation context only."),
    popularChannels: client.user?.id === undefined
      ? []
      : listDiscordChannelUsage(db, {
          botUserId: client.user.id,
          limit: 25,
          recentBotSince: discordActivityNow - 24 * 60 * 60 * 1000,
          activeHumanSince: discordActivityNow - 7 * 24 * 60 * 60 * 1000,
        }),
  });

  // Emoji cache refresh (always needed for outbound translation)
  refreshEmojiCache(guild);

  // Emoji context — only include in prompt when enabled
  let emojiContext = "";
  if (guildConfig.emotes.include) {
    const emojis = [...(emojiCache.get(guildId) ?? [])]
      .sort((a, b) => {
        const nc = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        return nc !== 0 ? nc : a.id.localeCompare(b.id);
      });
    emojiContext = buildEmojiContext(emojis);
  }

  // Display name context — sorted by username (case-insensitive), then by member ID
  // Only included when members.include is true
  let displayNameContext = "";
  if (guildConfig.members.include) {
    const members = [...guild.members.cache.values()]
      .sort((a, b) => {
        const uc = a.user.username.toLowerCase().localeCompare(b.user.username.toLowerCase());
        return uc !== 0 ? uc : a.id.localeCompare(b.id);
      })
      .map((m) => ({ userId: m.user.id, username: m.user.username, displayName: m.displayName }));
    const memoryCounts = countUserMemoriesByUser(db, guildId);
    displayNameContext = buildDisplayNameContext(members, memoryCounts);
  }

  // Current context metadata — local wall-clock time plus compact elapsed activity facts.
  const currentContext = buildTemporalContext({
    guildId,
    channelId,
    timezone: guildConfig.timezone,
    latestUserMessage,
    currentTurnBoundary,
  });
  const relationshipsContext = buildRelationshipPromptContext({
    guildConfig,
    latestUserMessage,
    currentGuildId: guildId,
    currentChannelId: channelId,
    ...(client.user?.id !== undefined ? { botUserId: client.user.id } : {}),
    visibleUserIds,
    resolveUserLabel: resolveRelationshipUserLabel,
    mode: relationshipsMode,
    notable,
    anchors: relationshipAnchors,
  });

  if (liveChannel !== null && isSendableGuildChannel(liveChannel) && liveChannel.isThread()) {
    const existing = getThread(db, liveChannel.id);
    const createdAt = liveChannel.createdTimestamp ?? existing?.createdAt ?? Date.now();
    upsertThread(db, {
      threadId: liveChannel.id,
      guildId: liveChannel.guildId,
      parentChatId: liveChannel.parentId ?? channelId,
      starterMessageId: liveChannel.id,
      threadName: liveChannel.name,
      createdAt,
      lastActivityAt: existing?.lastActivityAt ?? createdAt,
      messageCount: liveChannel.messageCount ?? 0,
      botParticipating: false,
      createdByBot: liveChannel.ownerId === client.user?.id,
      archivedAt: liveChannel.archived === true ? liveChannel.archiveTimestamp : null,
    });
  }

  // Thread list for parent channels (bot-participating threads only)
  // Only shown when NOT in a thread
  let threadsInChat = "";
  if (!isThread) {
    for (const cached of guild.channels.cache.values()) {
      if (!cached.isThread() || cached.parentId !== channelId) continue;
      const existing = getThread(db, cached.id);
      const createdAt = cached.createdTimestamp ?? existing?.createdAt ?? Date.now();
      upsertThread(db, {
        threadId: cached.id,
        guildId: cached.guildId,
        parentChatId: channelId,
        starterMessageId: cached.id,
        threadName: cached.name,
        createdAt,
        lastActivityAt: existing?.lastActivityAt ?? createdAt,
        messageCount: cached.messageCount ?? 0,
        createdByBot: cached.ownerId === client.user?.id,
        archivedAt: cached.archived === true ? cached.archiveTimestamp : null,
      });
    }
    const threads = listThreadsForContext(db, channelId);
    threadsInChat = threads
      .map((t) => {
        const status = t.archivedAt !== null ? "closed" : "open";
        const handoff = t.createdByBot ? "handoff" : "recent";
        const last = t.lastMessageId !== null ? `, last MsgID ${t.lastMessageId}` : "";
        return `- "${t.threadName}" (channel_id: ${t.threadId}, starter_msg_id: ${t.starterMessageId}) — ${status} ${handoff}, ${t.messageCount} msgs, last active ${formatRelativeAgo(t.lastActivityAt)}${last}`;
      })
      .join("\n");
  }

  // Thread metadata and parent pre-context (only when in a thread)
  let threadMetadata: ThreadMetadata | undefined;
  let parentPreContext = "";
  if (isThread) {
    const meta = getThreadMetadata(db, channelId);
    if (meta !== null) {
      threadMetadata = {
        parentChannelId: meta.parentChatId,
        threadId: channelId,
        starterMessageId: meta.starterMessageId,
        threadName: meta.threadName,
        createdByBot: meta.createdByBot,
        archivedAt: meta.archivedAt,
      };

      // Fetch parent pre-context: last 20 messages before thread creation
      const PARENT_PRE_CONTEXT_LIMIT = 20;
      const parentMessages = getParentPreContext(db, meta.parentChatId, meta.createdAt, PARENT_PRE_CONTEXT_LIMIT);

      if (parentMessages.length > 0) {
        // Apply trimming (same rules as older history)
        const handoffs = parentMessages.filter((message) =>
          message.id.startsWith(PRIVATE_HANDOFF_MESSAGE_ID_PREFIX)
        );
        const trimmed = trimMessages(
          parentMessages.filter((message) =>
            !message.id.startsWith(PRIVATE_HANDOFF_MESSAGE_ID_PREFIX)
          ),
          guildConfig.trim.messageCharLimit,
        ).flatMap((message) => [
          message,
          ...handoffs
            .filter((handoff) => handoff.replyToId === message.id)
            .map((handoff) => ({ ...handoff, timestamp: message.timestamp })),
        ]);

        // Format with date stamps
        const dateEntries = insertDateStamps(trimmed, guildConfig.timezone);
        const lines: string[] = [OLDER_LEGEND];
        for (const entry of dateEntries) {
          if (entry.type === "date") {
            lines.push(entry.text);
          } else {
            const m = trimmed[entry.index];
            if (m === undefined) continue;
            // No reply resolution for parent pre-context (simplified)
            lines.push(m.id.startsWith(PRIVATE_HANDOFF_MESSAGE_ID_PREFIX)
              ? `[@${m.author}]: ${formatHistoryContent(m)}`
              : formatMessageLine({
                message: m,
                reply: null,
              }));
          }
        }
        parentPreContext = `## Parent Pre-Context\n${lines.join("\n")}`;
      }
    }
  }
  const contextMessageIds = Array.from(new Set([
    ...historyWithoutLatest.map((m) => m.id),
    ...(appendLatestToHistory ? [annotatedLatestUserMessage.id] : []),
  ]));
  // Discord voice channels are also text-based, but this context describes the
  // concurrent voice room and must not be fed back into that room's own turn.
  const voicePresence = liveChannel !== null
    && liveChannel.type !== ChannelType.GuildVoice
    && liveChannel.type !== ChannelType.GuildStageVoice
    && liveChannel.isTextBased()
    ? voicePresenceContext()
    : "";

  const innerThreadsText = innerThreadsEnabled(guildConfig)
    ? buildInnerThreadsContext({
        db,
        guildId,
        visibleUserIds,
        resolveUserId: (userId) => guild.members.cache.get(userId)?.user.username
          ?? client.users.cache.get(userId)?.username,
      })
    : "";
  const botUserId = client.user?.id;
  let repertoire = "";
  if (getGlobalConfig().repertoire.enabled && botUserId !== undefined) {
    try {
      repertoire = buildRepertoireContext({
        db,
        config: getGlobalConfig().repertoire,
        instruction: runtimeContextTemplate("repertoire"),
        botUserId,
        currentGuildId: guildId,
        currentChannelId: channelId,
        mergeMessageGapSeconds: guildConfig.mergeMessageGapSeconds,
      });
    } catch (error) {
      log.warn("failed to build repertoire context", {
        guildId,
        channelId,
        error: String(error),
      });
    }
  }
  const assembled = assembleContext({
      toolInstructions: "",
      instructions: guildConfig.instructions,
      emojis: emojiContext,
      members: displayNameContext,
      notebooks,
      innerThreads: innerThreadsText,
      memories,
      discordContext,
      upcomingSchedules,
      threadsInChat,
      threadMetadata,
      parentPreContext,
      repertoire,
      olderHistory: olderText,
      newerHistory: newerText,
      currentContext: [
        currentContext,
        relationshipsContext,
        voicePresence,
      ]
        .filter((part) => part !== "")
        .join("\n\n"),
      personaMode: renderPersonaModeContext(guildId),
      responseInstruction: "",
      userMessage,
  });
  assembled.memoryFocusUserId = memoryFocusUserId;
  assembled.visibleUserIds = visibleUserIds;
  const activeJobsText = renderAgentJobsContext(
    visibleJobs,
    runtimeContextTemplate("active-image-jobs", {}, "Image generation is asynchronous."),
    Date.now(),
    (jobId) => agentJobs.listAssets(jobId),
  );
  const activeJobsIndex = assembled.sections.findIndex((s) => s.label === "Chat History — Newer");
  const activeJobsInsertAt = activeJobsIndex === -1 ? assembled.sections.length : activeJobsIndex;
  const sections = activeJobsText === ""
    ? assembled.sections
    : [
      ...assembled.sections.slice(0, activeJobsInsertAt),
      { label: "Image Jobs", text: activeJobsText, cached: false, role: "developer" as const },
      ...assembled.sections.slice(activeJobsInsertAt),
    ];

  return {
    ...assembled,
    sections,
    contextMessageIds,
  };
}


  return { buildInboundResolvers, buildOutboundResolvers, authorDisplayName, resolveGuildUsername, resolveKnownUsername, resolvePromptUsername, resolveGuildMemberReference, refreshEmojiCache, fetchEmojiCache, buildRelationshipPromptContext, buildContext };
}
