import { type Logger } from "../logger";
import { type loadGlobalConfig } from "../config/loader";
import type { GuildConfig } from "../config/types";
import { translateOutbound, type OutboundResolvers } from "../discord/translation";
import { splitMessage } from "../discord/split-message";
import { type EmojiCache, type EmojiEntry } from "../discord/emoji-cache";
import { botChannelPermissions, channelDisplayName, channelTypeLabel, isSendableGuildChannel, type SendableGuildChannel } from "../discord/message-sender";
import { type SchedulerEngine } from "../scheduler/engine";
import { listChannelMessages } from "../db/message-history-repository";
import { getMessageSearchMatchesByIds } from "../db/message-search-repository";
import { insertPromptOnlyBotMessage } from "../db/message-state-repository";
import { createSearchChannelMessagesTool } from "../agent/search-channel-messages-tool";
import { createScheduleTools } from "../agent/schedule-tool";
import { createEventWatchTools } from "../agent/event-watch-tool.ts";
import { createChatUserListTool, type MemberInfo } from "../agent/member-list-tool";
import { createChannelListTool, type ChannelInfo } from "../agent/channel-list-tool";
import { createEmojiListTool } from "../agent/emoji-list-tool";
import { createDiscordTimeoutTools, type TimeoutMember, type TimeoutMemberResolution } from "../agent/timeout-user-tool";
import { createSearchMemoriesTool } from "../agent/search-memories-tool";
import { createNotebookTools } from "../agent/notebook-service.ts";
import { createListInnerThreadsTool } from "../agent/inner-thread-service";
import { createListChannelMessagesTool } from "../agent/list-channel-messages-tool";
import { createOwnMessageTools } from "../agent/own-message-tool";
import { createBraveImageSearchTool, createBraveSearchTool } from "../agent/brave-search-tool";
import { createReadAssetTool, extractPdfText, extractRemoteVideoFrame, fetchAssetBuffer, type ReadAssetToolDeps } from "../agent/read-asset-tool";
import { createSearchAssetTool } from "../agent/search-asset-tool";
import { createReadUserAvatarTool, type AvatarSize } from "../agent/read-user-avatar-tool";
import { createFetchImagesTool } from "../agent/fetch-images-tool";
import { createCodexGenerateImageTool, type GeneratedImageAttachment, type ReferenceImageInput } from "../agent/codex-image-tool";
import { type AgentJobStore, type BackgroundHandoffTarget, createCancelAgentJobTool } from "../agent/job-runtime";
import { createAgentJobInspectionTools, renderAgentJobDetails } from "../agent/agent-job-tool";
import { loadAssetReferenceImage, loadStagedAssetReferenceImage, resolvedLinkReferenceImage } from "../agent/asset-reference-image";
import { createFetchUrlTool } from "../agent/fetch-url-tool";
import { type LinkContentCache, resolveLinkContent } from "../agent/link-content.ts";
import { createSummarizeVideoTool } from "../agent/summarize-video-tool";
import { createReactToMessageTool } from "../agent/react-to-message-tool";
import { createDiceRollTool, type DiceRollDelivery } from "../agent/dice-roll-tool";
import { applyRuntimeToolPrompts } from "../agent/runtime-tool-prompts";
import { resolveModelProfile } from "../llm/client";
import { cacheAssetExtraction, getAssetById } from "../db/asset-repository";
import { type createWatchMatcher } from "../event-watch/matcher.ts";
import { type createEventWatchRuntime } from "../event-watch/runtime.ts";
import { type EventWatchDiscordAdapters } from "../event-watch/discord-adapters.ts";
import { deleteStagedAsset, getStagedAsset, getStagedAssetForJob } from "../db/staged-asset-repository";
import { prepareImageBufferForContext } from "../agent/image-buffer";
import { countUserMemoriesByUser } from "../db/memory-repository";
import { type PromptBundle } from "../config/instruction-bundle";
import { resolveReactionEmojiInput } from "../discord/reaction-emoji";
import { guildEmojiEntries } from "../discord/emoji-cache-sync.ts";
import { syncDeletedOwnBotMessage, syncEditedOwnBotMessage } from "../discord/reply-fallback-runtime";
import { createDiscordAssetSourceResolver } from "../discord/asset-resolver";
import { DEFAULT_ASSET_READING, DEFAULT_EXTERNAL_IMAGES } from "../config/defaults";
import type { Database } from "../db/database";
import { ChannelType, PermissionFlagsBits, type Client, type Guild, type GuildBasedChannel, type GuildMember, type Message, type TextChannel, type ThreadChannel } from "discord.js";
import { type VoiceRuntime } from "../voice/runtime.ts";
import { createVoiceTools } from "../voice/tools.ts";
import { WorkspaceClient } from "../workspace/client.ts";
import { createWorkspaceTools } from "./workspace-tool.ts";
import { createAgentControlTools } from "./agent-control-tool.ts";
import { resolveStagedPath, unlinkStagedPath } from "./staged-path.ts";

export function createToolRuntime(input: {
    db: Database;
    client: Client;
    log: Logger;
    agentJobs: AgentJobStore;
    scheduler: SchedulerEngine;
    linkContentCache: LinkContentCache;
    getGlobalConfig: () => ReturnType<typeof loadGlobalConfig>;
    getPromptBundle: () => PromptBundle;
    getGuildConfig: (guildId: string) => GuildConfig;
    notebooksEnabled: (guildConfig: GuildConfig) => boolean;
    runtimeToolDescription: (toolName: string) => string | undefined;
    resolveClientGuild: (guildId: string) => Promise<Guild | null>;
    fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
    resolveGuildUsername: (guild: Guild, username: string) => string | undefined;
    resolveGuildMemberReference: (guild: Guild, reference: string) => Promise<GuildMember | undefined>;
    fetchEmojiCache: (guild: Guild) => Promise<EmojiEntry[]>;
    buildOutboundResolvers: (guild: Guild) => OutboundResolvers;
    runImageGenerationJob: (jobId: string) => Promise<void>;
    trackImageJob: (task: Promise<void>) => void;
    runAgentJob: (jobId: string) => Promise<void>;
    trackAgentJob: (task: Promise<void>) => void;
    watchMatcher: ReturnType<typeof createWatchMatcher>;
    getEventWatchRuntime: () => ReturnType<typeof createEventWatchRuntime>;
    getEventWatchDiscordAdapters: () => EventWatchDiscordAdapters | null;
    emojiCache: EmojiCache;
    innerThreadsEnabled: (guildConfig: GuildConfig) => boolean;
    refreshEmojiCache: (guild: Guild) => void;
    loadExternalReference: (url: string, signal?: AbortSignal) => Promise<ReferenceImageInput>;
    loadGuildAvatarReference: (guild: Guild, userId: string, signal?: AbortSignal) => Promise<ReferenceImageInput | null>;
    getVoiceRuntime: () => VoiceRuntime;
  }
) {
  const { db, client, log, agentJobs, scheduler, linkContentCache, getGlobalConfig, getPromptBundle, getGuildConfig, notebooksEnabled, runtimeToolDescription, resolveClientGuild, fetchAccessibleGuildChannel, resolveGuildUsername, resolveGuildMemberReference, fetchEmojiCache, buildOutboundResolvers, runImageGenerationJob, trackImageJob, runAgentJob, trackAgentJob, watchMatcher, getEventWatchRuntime, getEventWatchDiscordAdapters, emojiCache, innerThreadsEnabled, refreshEmojiCache, loadExternalReference, loadGuildAvatarReference, getVoiceRuntime } = input;
  const workspaceClient = new WorkspaceClient(process.env.WORKSPACE_SOCKET_PATH ?? "/run/2b2v/workspace.sock");
  const workspaceStagingRoot = process.env.WORKSPACE_STAGING_DIR ?? `${getGlobalConfig().dataDir}/staged-assets`;
const CONTEXT_IMAGE_MAX_DIMENSION = 1024;
const EMOJI_TTL_MS = 10 * 60 * 1000;
function buildAgentTools(
  guildId: string,
  channelId: string,
  guildConfig: GuildConfig,
  guild: Guild,
  excludedMessageIds?: Iterable<string>,
  onGeneratedImage?: (attachment: GeneratedImageAttachment) => void,
  currentRequest?: {
    requesterId: string;
    requesterUsername: string;
    sourceMessageId: string;
    sourceQuote: string;
  },
  options: {
    includeImageGenerationTools?: boolean;
    voiceToolSurface?: "text" | "voice";
    imageDelivery?: {
      guildId: string;
      channelId: string;
    };
    currentRequest?: {
      requesterId: string;
      requesterUsername: string;
      sourceMessageId: string;
      sourceQuote: string;
    };
    deliverDiceRoll?: (input: DiceRollDelivery) => Promise<{ sentMessageId: string }>;
    visibleUserIds?: readonly string[];
    onVisibleOutput?: () => void;
    /** Durable parent for jobs started inside a background agent. */
    parentJobId?: string;
    /** Actor surface that receives a root background handoff. */
    handoffTarget?: BackgroundHandoffTarget;
  } = {},
) {
  const includeImageGenerationTools = options.includeImageGenerationTools ?? true;
  const effectiveCurrentRequest = options.currentRequest ?? currentRequest;
  const resolveUsernameInGuild = async (username: string, targetGuildId: string): Promise<string | undefined> => {
    const targetGuild = targetGuildId === guild.id ? guild : await resolveClientGuild(targetGuildId);
    if (targetGuild === null) return undefined;
    const cached = resolveGuildUsername(targetGuild, username);
    if (cached !== undefined) return cached;
    try {
      await targetGuild.members.fetch();
    } catch {
      // Cache-only fallback below handles missing permissions.
    }
    return resolveGuildUsername(targetGuild, username);
  };

  const searchTool = createSearchChannelMessagesTool({
    db,
    guildId,
    currentChannelId: channelId,
    timezone: guildConfig.timezone,
    logger: log.child({ component: "message-search" }),
    resolveChannel: async (targetChannelId) => {
      const channel = await fetchAccessibleGuildChannel(targetChannelId);
      return channel === null ? null : { guildId: channel.guildId, channelId: channel.id };
    },
    canAccessGuild: async (targetGuildId) => await resolveClientGuild(targetGuildId) !== null,
  });

  const scheduleTools = createScheduleTools({
    db,
    guildId,
    channelId,
    timezone: guildConfig.timezone,
    ...(effectiveCurrentRequest !== undefined
      ? {
          currentRequest: {
            requesterId: effectiveCurrentRequest.requesterId,
            requesterUsername: effectiveCurrentRequest.requesterUsername,
          },
        }
      : {}),
    isRequesterAdmin: effectiveCurrentRequest?.requesterId !== undefined
      && effectiveCurrentRequest.requesterId !== "scheduler"
      && guildConfig.adminUserIds.includes(effectiveCurrentRequest.requesterId),
    onScheduleCreated: (id) => scheduler.addSchedule(id),
    onScheduleDeleted: (id) => scheduler.removeSchedule(id),
    resolveDestinationChannel: async (targetChannelId) => {
      const target = await fetchAccessibleGuildChannel(targetChannelId);
      if (target === null) return null;
      return {
        guildId: target.guildId,
        channelId: target.id,
        timezone: getGuildConfig(target.guildId).timezone,
        schedulePressure: getGuildConfig(target.guildId).schedulePressure,
      };
    },
  });

  const eventWatchTools = createEventWatchTools({
    db,
    matcher: watchMatcher,
    guildId,
    channelId,
    timezone: guildConfig.timezone,
    ...(effectiveCurrentRequest === undefined
      ? {}
      : {
          currentRequest: {
            requesterId: effectiveCurrentRequest.requesterId,
            requesterUsername: effectiveCurrentRequest.requesterUsername,
          },
        }),
    resolveChannel: async (targetChannelId) => {
      const target = await fetchAccessibleGuildChannel(targetChannelId);
      if (target === null) return null;
      return {
        guildId: target.guildId,
        channelId: target.id,
        timezone: getGuildConfig(target.guildId).timezone,
      };
    },
    resolveGuild: async (targetGuildId) => {
      const target = await resolveClientGuild(targetGuildId);
      return target === null ? null : { guildId: target.id, timezone: getGuildConfig(target.id).timezone };
    },
    onWatchCreated: () => getEventWatchDiscordAdapters()?.reconcilePresenceStates(),
    onWatchDeleted: (watchId) => getEventWatchRuntime().cancelWatch(watchId),
  });

  const chatUserListTool = createChatUserListTool({
    guildId,
    fetchMembers: async (_gId, onlineOnly) => {
      const members: MemberInfo[] = [];
      // Ensure members are fetched
      try {
        await guild.members.fetch();
      } catch {
        // May not have permission
      }
      for (const [, member] of guild.members.cache) {
        const status = member.presence?.status ?? "offline";
        if (onlineOnly && status === "offline") continue;
        members.push({
          userId: member.id,
          username: member.user.username,
          displayName: member.displayName,
          status: status as "online" | "idle" | "dnd" | "offline",
          isBot: member.user.bot,
          hasAdministratorPermission: member.permissions.has(PermissionFlagsBits.Administrator),
          ...(member.user.dmChannel === null ? {} : { dmChannelId: member.user.dmChannel.id }),
        });
      }
      return members;
    },
    getMemoryCounts: (gId) => countUserMemoriesByUser(db, gId),
    adminUserIds: guildConfig.adminUserIds,
  });

  const channelListTool = createChannelListTool({
    currentGuildId: guildId,
    resolveGuildName: (targetGuildId) => client.guilds.cache.get(targetGuildId)?.name,
    fetchChannels: async (targetGuildId) => {
      const targetGuild = targetGuildId === guild.id ? guild : await resolveClientGuild(targetGuildId);
      if (targetGuild === null) return [];
      try {
        await targetGuild.channels.fetch();
      } catch {
        // Cache-only fallback below handles missing permissions.
      }
      const activeThreads = await targetGuild.channels.fetchActiveThreads().catch(() => null);
      if (activeThreads === null) {
        // Threads already present in cache will still be listed.
      }

      const channels = new Map<string, GuildBasedChannel | ThreadChannel>();
      for (const [, channel] of targetGuild.channels.cache) {
        if (channel.type !== ChannelType.GuildCategory) channels.set(channel.id, channel);
      }
      for (const [, thread] of activeThreads?.threads ?? []) {
        channels.set(thread.id, thread);
      }
      for (const [, channel] of client.channels.cache) {
        if ("guildId" in channel && channel.guildId === targetGuild.id && "isThread" in channel && typeof channel.isThread === "function" && channel.isThread()) {
          channels.set(channel.id, channel);
        }
      }

      return [...channels.values()].map((channel): ChannelInfo => {
        const permissions = botChannelPermissions(client, channel);
        const parentName = channel.isThread() ? channel.parent?.name : undefined;
        const categoryName = channel.isThread() ? channel.parent?.parent?.name : channel.parent?.name;
        const isVoice = channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
        const voicePermissions = isVoice && targetGuild.members.me !== null
          ? channel.permissionsFor(targetGuild.members.me)
          : undefined;
        return {
          guildId: targetGuild.id,
          guildName: targetGuild.name,
          id: channel.id,
          name: channel.name,
          type: channelTypeLabel(channel),
          canView: permissions.canView,
          canSend: permissions.canSend,
          isCurrent: channel.id === channelId,
          ...(categoryName !== undefined ? { categoryName } : {}),
          ...(parentName !== undefined ? { parentName } : {}),
          ...(isVoice
            ? {
              canConnect: voicePermissions?.has(PermissionFlagsBits.Connect) === true,
              canSpeak: voicePermissions?.has(PermissionFlagsBits.Speak) === true,
              isVoiceConnected: getVoiceRuntime().snapshot().channelId === channel.id,
              voiceMembers: [...channel.members.values()]
                .filter((member) => !member.user.bot)
                .map((member) => `@${member.user.username} (${member.id})`),
              userLimit: channel.userLimit,
            }
            : {}),
        };
      });
    },
  });

  const emojiListTool = createEmojiListTool({
    guildId,
    getCachedEmojis: (gId) => emojiCache.get(gId),
    shouldRefresh: (gId) => emojiCache.isStale(gId, EMOJI_TTL_MS),
    refreshEmojis: async () => fetchEmojiCache(guild),
    getAllGuildEmojis: () => client.guilds.cache.map((candidate) => ({
      guildId: candidate.id,
      guildName: candidate.name,
      emojis: guildEmojiEntries(candidate),
    })),
    resolveEmoji: buildOutboundResolvers(guild).emoji,
  });

  const discordTimeoutTools = createDiscordTimeoutTools({
    guildId,
    botUserId: client.user?.id ?? "",
    guildOwnerId: guild.ownerId,
    resolveMember: async (target) => {
      const raw = target.trim();
      const mentionMatch = raw.match(/^<@!?(\d+)>$/);
      const userId = mentionMatch?.[1] ?? (/^\d{5,25}$/.test(raw) ? raw : undefined);
      const toTimeoutMember = (member: GuildMember): TimeoutMember => ({
        id: member.id,
        username: member.user.username,
        displayName: member.displayName,
        isBot: member.user.bot,
        moderatable: member.moderatable,
        timeout: async (durationMs, reason) => {
          await member.timeout(durationMs, reason);
        },
      });

      if (userId !== undefined) {
        try {
          return toTimeoutMember(await guild.members.fetch(userId));
        } catch {
          const cached = guild.members.cache.get(userId);
          return cached !== undefined ? toTimeoutMember(cached) : null;
        }
      }

      const normalized = raw.startsWith("@")
        ? raw.slice(1).trim().toLowerCase()
        : raw.toLowerCase();
      if (normalized === "") return null;
      const findCached = (): GuildMember[] => {
        const matches: GuildMember[] = [];
        for (const [, member] of guild.members.cache) {
          const nickname = member.nickname?.toLowerCase();
          if (
            member.user.username.toLowerCase() === normalized
            || member.displayName.toLowerCase() === normalized
            || nickname === normalized
          ) {
            matches.push(member);
          }
        }
        return matches;
      };

      let matches = findCached();
      if (matches.length === 0) {
        try {
          await guild.members.fetch();
        } catch {
          // Cache-only fallback below handles missing member-list permission.
        }
        matches = findCached();
      }
      if (matches.length === 0) return null;
      if (matches.length > 1) {
        return {
          error: "ambiguous_target",
          message: `Multiple guild members match '${target}'; use a mention or raw user ID.`,
        } satisfies TimeoutMemberResolution;
      }
      const member = matches[0];
      return member !== undefined ? toTimeoutMember(member) : null;
    },
  });

  const memorySearchTool = createSearchMemoriesTool({
    db,
    currentGuildId: guildId,
    resolveUsername: resolveUsernameInGuild,
    resolveGuildName: (targetGuildId) => client.guilds.cache.get(targetGuildId)?.name,
    resolveUsernameById: (userId) => client.users.cache.get(userId)?.username,
    canAccessGuild: async (targetGuildId) => await resolveClientGuild(targetGuildId) !== null,
    isUserInGuild: async (userId, targetGuildId) => {
      const targetGuild = await resolveClientGuild(targetGuildId);
      if (targetGuild === null) return false;
      if (targetGuild.members.cache.has(userId)) return true;
      try {
        await targetGuild.members.fetch(userId);
        return true;
      } catch {
        return false;
      }
    },
  });
  const innerThreadTools = innerThreadsEnabled(guildConfig)
    ? [createListInnerThreadsTool({
        db,
        guildId,
        visibleUserIds: options.visibleUserIds ?? [],
        description: runtimeToolDescription("list_inner_threads"),
        resolveUserId: (userId) => guild.members.cache.get(userId)?.user.username
          ?? client.users.cache.get(userId)?.username,
        resolveGuildId: (targetGuildId) => client.guilds.cache.get(targetGuildId)?.name,
      })]
    : [];
  const notebookConfig = guildConfig.notebooks ?? getGlobalConfig().defaultNotebooks;
  const notebookTools = notebooksEnabled(guildConfig) && notebookConfig !== undefined
    ? createNotebookTools({
        db,
        currentGuildId: guildId,
        defaultShelfAfterMs: notebookConfig.defaultShelfAfterMs,
      })
    : [];

  const listChannelMessagesTool = createListChannelMessagesTool({
    guildId,
    timezone: guildConfig.timezone,
    fetchMessages: async (input) => {
      const anchorMessageId = input.aroundMessageId ?? input.beforeMessageId ?? input.afterMessageId;
      const storedLocation = input.channelId === undefined && anchorMessageId !== undefined
        ? getMessageSearchMatchesByIds(db, [anchorMessageId])[0]
        : undefined;
      const targetChannelId = input.channelId ?? storedLocation?.channelId;
      if (targetChannelId === undefined) return null;
      const channel = await fetchAccessibleGuildChannel(targetChannelId);
      if (channel === null || !("messages" in channel)) return null;
      const messages = listChannelMessages(db, channel.guildId, channel.id, {
        limit: input.limit,
        ...(input.beforeMessageId !== undefined ? { beforeMessageId: input.beforeMessageId } : {}),
        ...(input.afterMessageId !== undefined ? { afterMessageId: input.afterMessageId } : {}),
        ...(input.aroundMessageId !== undefined ? { aroundMessageId: input.aroundMessageId } : {}),
      });
      return messages === null ? null : {
        location: {
          guildId: channel.guildId,
          guildName: channel.guild.name,
          channelId: channel.id,
          channelName: channelDisplayName(channel) ?? channel.id,
        },
        messages,
      };
    },
  });

  const ownMessageTools = createOwnMessageTools({
    currentChannelId: channelId,
    botUserId: client.user?.id ?? "",
    fetchMessage: async (messageChannelId, messageId) => {
      const channel = await fetchAccessibleGuildChannel(messageChannelId);
      if (channel === null || !("messages" in channel)) return null;
      try {
        const msg = await (channel as TextChannel | ThreadChannel).messages.fetch(messageId);
        return {
          id: msg.id,
          guildId: msg.guildId,
          channelId: msg.channelId,
          authorId: msg.author.id,
          authorUsername: msg.author.username,
          content: msg.content,
          createdAt: msg.createdTimestamp,
          replyToId: msg.reference?.messageId ?? null,
        };
      } catch {
        return null;
      }
    },
    editMessage: async (messageChannelId, messageId, content) => {
      const channel = await fetchAccessibleGuildChannel(messageChannelId);
      if (channel === null || !("messages" in channel)) throw new Error("Target channel is inaccessible.");
      const warnings: string[] = [];
      const translated = translateOutbound(content, buildOutboundResolvers(channel.guild), warnings);
      const chunks = splitMessage(translated);
      if (chunks.length !== 1) {
        throw new Error("Replacement content is too long for one Discord message.");
      }
      const msg = await (channel as TextChannel | ThreadChannel).messages.fetch(messageId);
      const edited = await msg.edit(chunks[0] ?? "");
      return { rawContent: edited.content };
    },
    deleteMessage: async (messageChannelId, messageId) => {
      const channel = await fetchAccessibleGuildChannel(messageChannelId);
      if (channel === null || !("messages" in channel)) throw new Error("Target channel is inaccessible.");
      const msg = await (channel as TextChannel | ThreadChannel).messages.fetch(messageId);
      await msg.delete();
    },
    afterEdit: (input) => syncEditedOwnBotMessage({
      db,
      ...input,
    }),
    afterDelete: (input) => syncDeletedOwnBotMessage({
      db,
      ...input,
      botUserId: client.user?.id ?? "",
    }),
  });

  const resolveAssetSource = createDiscordAssetSourceResolver({
    fetchMessage: async (targetChannelId, messageId) => {
      const target = await fetchAccessibleGuildChannel(targetChannelId);
      if (target === null || !("messages" in target)) return null;
      try {
        return await (target as TextChannel | ThreadChannel).messages.fetch(messageId);
      } catch {
        return null;
      }
    },
  });
  const workspaceTools = getPromptBundle().runtime.skills.byId.workspace === undefined ? [] : createWorkspaceTools({
    db,
    client: workspaceClient,
    stagingRoot: workspaceStagingRoot,
    guildId,
    channelId,
    loadAsset: async (assetId, signal) => {
      if (typeof assetId === "string") {
        const staged = getStagedAsset(db, assetId);
        if (staged === null || staged.ownerGuildId !== guildId) throw new Error(`Staged asset ${assetId} was not found.`);
        const file = Bun.file(await resolveStagedPath(workspaceStagingRoot, staged.storagePath));
        if (!await file.exists()) throw new Error(`Staged asset ${assetId} file is unavailable.`);
        return {
          buffer: Buffer.from(await file.arrayBuffer()),
          filename: staged.filename,
          contentType: staged.contentType,
        };
      }
      const asset = getAssetById(db, assetId);
      if (asset === null) throw new Error(`Asset ${assetId} was not found.`);
      const source = await resolveAssetSource(asset);
      if (source === null) throw new Error(`Asset ${assetId} source is unavailable.`);
      return {
        buffer: await fetchAssetBuffer(
          fetch,
          source.url,
          guildConfig.assetReading?.maxDownloadBytes ?? DEFAULT_ASSET_READING.maxDownloadBytes,
          signal,
        ),
        filename: source.filename ?? asset.filename ?? `asset-${assetId}`,
        contentType: source.contentType ?? asset.contentType ?? "application/octet-stream",
      };
    },
  });
  const assetToolDeps = {
    config: guildConfig.assetReading ?? { ...DEFAULT_ASSET_READING, videoPreviewTimesSeconds: [...DEFAULT_ASSET_READING.videoPreviewTimesSeconds] },
    elevenLabsApiKey: getGlobalConfig().elevenLabsApiKey,
    getAsset: (id) => getAssetById(db, id),
    getStagedAsset: (ref) => {
      const staged = getStagedAsset(db, ref);
      return staged?.ownerGuildId === guildId ? staged : null;
    },
    getStagedAssetMetadata: (jobId) => {
      const job = agentJobs.get(jobId);
      const result = job?.kind === "image_generation" ? job.result : undefined;
      return result === undefined ? null : { actualSize: result.actualSize };
    },
    resolveStagedPath: async (storagePath) => await resolveStagedPath(workspaceStagingRoot, storagePath),
    getProvenance: (id) => {
      const linked = agentJobs.getForAsset(id);
      return linked === undefined
        ? null
        : `Role: ${linked.role}\n${renderAgentJobDetails(linked.job, agentJobs.listAssets(linked.job.id))}`;
    },
    resolveOrigin: async (asset) => {
      const sourceChannel = await fetchAccessibleGuildChannel(asset.channelId);
      if (sourceChannel === null) return null;
      return {
        guildId: sourceChannel.guildId,
        guildName: sourceChannel.guild.name,
        channelId: sourceChannel.id,
        channelName: channelDisplayName(sourceChannel) ?? sourceChannel.id,
        location: sourceChannel.guildId !== guildId
          ? "other-guild"
          : sourceChannel.id !== channelId
            ? "other-channel"
            : "current-channel",
      };
    },
    resolveSource: resolveAssetSource,
    cacheExtraction: (id, text, provider) => cacheAssetExtraction(db, id, text, provider),
    prepareImage: (buffer, mimeType) => prepareImageBufferForContext(buffer, mimeType, CONTEXT_IMAGE_MAX_DIMENSION),
    extractPdfText,
    extractVideoFrame: extractRemoteVideoFrame,
    resolveLink: async (input, signal) => await resolveLinkContent({
      cache: linkContentCache,
      externalImages: getGlobalConfig().externalImages ?? DEFAULT_EXTERNAL_IMAGES,
    }, input, signal),
  } satisfies ReadAssetToolDeps;
  const readAssetTool = createReadAssetTool(assetToolDeps);
  const searchAssetTool = createSearchAssetTool(assetToolDeps);

  const readUserAvatarTool = createReadUserAvatarTool({
    resolveUserAvatar: async (reference: string, size: AvatarSize) => {
      const member = await resolveGuildMemberReference(guild, reference);
      if (member === undefined) return null;
      return {
        userId: member.id,
        username: member.user.username,
        displayName: member.displayName,
        avatarUrl: member.displayAvatarURL({ extension: "png", forceStatic: true, size }),
        requestedSize: size,
      };
    },
    fetchFn: async (url) => await fetch(url),
    prepareImageForContext: (buffer, mimeType) =>
      prepareImageBufferForContext(buffer, mimeType, CONTEXT_IMAGE_MAX_DIMENSION),
  });

  const fetchImagesTool = createFetchImagesTool({
    ...(getGlobalConfig().externalImages ?? DEFAULT_EXTERNAL_IMAGES),
  });

  const fetchUrlTool = createFetchUrlTool({
    maxPageImages: (getGlobalConfig().externalImages ?? DEFAULT_EXTERNAL_IMAGES).maxPageImages,
    externalImages: getGlobalConfig().externalImages ?? DEFAULT_EXTERNAL_IMAGES,
    cache: linkContentCache,
  });
  const summarizeVideoTool = createSummarizeVideoTool();
  const reactToMessageTool = createReactToMessageTool({
    currentChannelId: channelId,
    onVisibleOutput: options.onVisibleOutput,
    reactToMessage: async (input) => {
      const targetChannel = await fetchAccessibleGuildChannel(input.channelId);
      if (targetChannel === null || !("messages" in targetChannel)) {
        throw new Error(`Channel ${input.channelId} is not an accessible guild text channel or thread.`);
      }

      refreshEmojiCache(targetChannel.guild);
      const emoji = resolveReactionEmojiInput(
        input.emoji,
        buildOutboundResolvers(targetChannel.guild).emoji,
      );
      if (emoji === null) throw new Error("emoji is required.");

      let targetMessage: Message;
      try {
        targetMessage = await targetChannel.messages.fetch(input.messageId);
      } catch {
        throw new Error(`Message ${input.messageId} was not found or is not accessible in channel ${input.channelId}.`);
      }

      try {
        await targetMessage.react(emoji);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown reaction error";
        throw new Error(`Discord rejected the reaction: ${message}`);
      }

      return {
        messageId: targetMessage.id,
        channelId: targetChannel.id,
        emoji,
      };
    },
  });

  const diceRollTool = effectiveCurrentRequest === undefined || options.deliverDiceRoll === undefined
    ? undefined
    : createDiceRollTool({
        db,
        guildId,
        channelId,
        sourceUsername: client.user?.username ?? "bot",
        currentRequest: effectiveCurrentRequest,
        resolveActor: async (reference) => {
          const member = await resolveGuildMemberReference(guild, reference);
          return member === undefined
            ? null
            : { userId: member.id, username: member.user.username };
        },
        deliver: options.deliverDiceRoll,
        recordPrivate: (input) => {
          const botUser = client.user;
          if (botUser === null) return Promise.reject(new Error("Discord bot identity is unavailable."));
          insertPromptOnlyBotMessage(db, {
            id: `prompt-only:${input.dedupeKey}`,
            guildId,
            channelId,
            botUserId: botUser.id,
            botUsername: botUser.username,
            content: input.historyText,
            replyToId: input.sourceMessageId,
            createdAt: input.createdAt,
          });
          return Promise.resolve();
        },
      });

  const jobInspectionTools = createAgentJobInspectionTools({
    store: agentJobs,
    onDismiss: async (jobId) => {
      const queued = agentJobs.publishChildResult(jobId);
      if (queued.shouldRun && queued.parentJobId !== undefined) trackAgentJob(runAgentJob(queued.parentJobId));
      const staged = getStagedAssetForJob(db, jobId);
      if (staged === null) return;
      await unlinkStagedPath(workspaceStagingRoot, staged.storagePath).catch(() => {});
      deleteStagedAsset(db, staged.ref);
    },
  });
  const cancelJobTool = createCancelAgentJobTool({
    store: agentJobs,
    onCancelled: async (jobId) => {
      const queued = agentJobs.publishChildResult(jobId);
      if (queued.shouldRun && queued.parentJobId !== undefined) trackAgentJob(runAgentJob(queued.parentJobId));
      const staged = getStagedAssetForJob(db, jobId);
      if (staged === null) return;
      await unlinkStagedPath(workspaceStagingRoot, staged.storagePath).catch(() => {});
      deleteStagedAsset(db, staged.ref);
    },
  });
  const agentControlTools = effectiveCurrentRequest === undefined ? [] : createAgentControlTools({
    store: agentJobs,
    guildId,
    channelId,
    requesterId: effectiveCurrentRequest.requesterId,
    requesterUsername: effectiveCurrentRequest.requesterUsername,
    sourceMessageId: effectiveCurrentRequest.sourceMessageId,
    sourceQuote: effectiveCurrentRequest.sourceQuote,
    handoffTarget: options.handoffTarget ?? { kind: "channel", guildId, channelId },
    ...(options.parentJobId !== undefined ? { parentJobId: options.parentJobId } : {}),
    runAgentJob,
    trackAgentJob,
  });
  const tools = [searchTool, ...scheduleTools, ...eventWatchTools, chatUserListTool, channelListTool, emojiListTool, ...discordTimeoutTools, memorySearchTool, ...notebookTools, ...innerThreadTools, listChannelMessagesTool, ...ownMessageTools, readAssetTool, searchAssetTool, ...jobInspectionTools, cancelJobTool, ...agentControlTools, ...workspaceTools, readUserAvatarTool, fetchImagesTool, fetchUrlTool, summarizeVideoTool, reactToMessageTool];
  if (diceRollTool !== undefined) tools.push(diceRollTool);
  if (includeImageGenerationTools) {
    const imageProfile = resolveModelProfile(
      getGlobalConfig(),
      guildConfig.imageGeneration.modelProfile,
    );
    if (imageProfile.provider !== "openai-codex") {
      throw new Error(
        `Image generation model profile "${guildConfig.imageGeneration.modelProfile}" must use openai-codex`,
      );
    }
    const codexImageModel = imageProfile.model;
    const codexGenerateImageTool = createCodexGenerateImageTool({
      codexAuthPath: getGlobalConfig().codexAuthPath,
      model: codexImageModel,
      sessionId: `2b2v-image:${guildId}:${channelId}:${codexImageModel}`,
      logger: log.child({ component: "codex-image", guildId, channelId }),
      imageReferenceMaxPerCall: guildConfig.imageReferenceMaxPerCall,
      imageGenerationQuality: guildConfig.imageGeneration.quality,
      asyncJobAlreadyActiveTemplate: getPromptBundle().runtime.contextTemplates["codex-image-job-existing"],
      asyncJobStartedTemplate: getPromptBundle().runtime.contextTemplates["codex-image-job-started"],
      resolveReferenceImage: async (id) => {
        if (typeof id === "string") {
          const staged = getStagedAsset(db, id);
          if (staged === null || staged.ownerGuildId !== guildId) return null;
          return await loadStagedAssetReferenceImage({
            asset: staged,
            maxBytes: guildConfig.assetReading?.maxDownloadBytes
              ?? DEFAULT_ASSET_READING.maxDownloadBytes,
            stagingRoot: workspaceStagingRoot,
          });
        }
        const asset = getAssetById(db, id);
        if (asset === null) return null;
        const source = await resolveAssetSource(asset);
        if (source === null) return null;
        if (asset.kind === "link") {
          const resolved = await resolveLinkContent({
            cache: linkContentCache,
            externalImages: getGlobalConfig().externalImages ?? DEFAULT_EXTERNAL_IMAGES,
          }, { url: source.url });
          return resolvedLinkReferenceImage(asset.id, resolved.content);
        }
        return await loadAssetReferenceImage({
          asset,
          source,
          maxBytes: guildConfig.assetReading?.maxDownloadBytes ?? DEFAULT_ASSET_READING.maxDownloadBytes,
        });
      },
      resolveExternalReference: loadExternalReference,
      resolveAvatarReference: (userId, signal) => loadGuildAvatarReference(guild, userId, signal),
      onGeneratedImage: onGeneratedImage ?? (() => {}),
      ...(effectiveCurrentRequest === undefined ? {} : { enqueueImageJob: (input) => {
        const deliveryChannelId = options.imageDelivery?.channelId ?? channelId;
        const deliveryGuildId = options.imageDelivery?.guildId
          ?? (client.channels.cache.get(deliveryChannelId) !== undefined && isSendableGuildChannel(client.channels.cache.get(deliveryChannelId))
            ? (client.channels.cache.get(deliveryChannelId) as SendableGuildChannel).guildId
            : guildId);
        const result = agentJobs.enqueueImageJob({
          guildId,
          channelId,
          deliveryGuildId,
          deliveryChannelId,
          requesterId: effectiveCurrentRequest.requesterId,
          requesterUsername: effectiveCurrentRequest.requesterUsername,
          sourceMessageId: effectiveCurrentRequest.sourceMessageId,
          sourceQuote: effectiveCurrentRequest.sourceQuote,
          prompt: input.prompt,
          references: input.references,
          outputFormat: input.outputFormat,
          is4k: input.is4k,
          ...(input.replacesJobId !== undefined ? { replacesJobId: input.replacesJobId } : {}),
          ...(options.parentJobId !== undefined ? { parentJobId: options.parentJobId } : {}),
        });
        if (result.created) {
          trackImageJob(runImageGenerationJob(result.job.id).catch((err: unknown) => {
            log.error("async image job failed outside worker", {
              jobId: result.job.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }));
        }
        return result;
      } }),
    });

    tools.push(codexGenerateImageTool);
  }

  // Brave search if API key configured
  const braveApiKey = getGlobalConfig().braveApiKey;
  if (braveApiKey !== undefined && braveApiKey !== "") {
    tools.push(createBraveSearchTool({ apiKey: braveApiKey }));
    tools.push(createBraveImageSearchTool({ apiKey: braveApiKey }));
  }
  if (effectiveCurrentRequest !== undefined && guildConfig.voice?.enabled === true) {
    tools.push(...createVoiceTools({
      runtime: getVoiceRuntime(),
      origin: {
        guildId,
        channelId,
        sourceMessageId: effectiveCurrentRequest.sourceMessageId,
        sourceMessageText: effectiveCurrentRequest.sourceQuote,
        requesterId: effectiveCurrentRequest.requesterId,
        requesterUsername: effectiveCurrentRequest.requesterUsername,
      },
      surface: options.voiceToolSurface ?? "text",
    }));
  }

  return applyRuntimeToolPrompts(tools, getPromptBundle().runtime);
}


  return { buildAgentTools };
}
