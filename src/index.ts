import { createLogger, RequestLog, type LogLevel, type Logger } from "./logger";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { requestLogStore } from "./dashboard/store";
import { parseDashboardPasswordlessCidrs, startDashboard } from "./dashboard/server";
import { loadGlobalConfig, loadGuildConfigs, resolveGuildConfig, validateTrimConfig, validateVpnConfig } from "./config/loader";
import type { GuildConfig } from "./config/types";
import { createDatabase } from "./db/database";
import { createDiscordClient, loginDiscordClient } from "./discord/client";
import { buildDiscordContext } from "./discord/context-renderer";
import { registerInteractionRuntime } from "./discord/interaction-runtime";
import { translateInbound, translateOutbound, buildDisplayNameContext, type InboundResolvers, type OutboundResolvers } from "./discord/translation";
import { splitMessage } from "./discord/split-message";
import { EmojiCache, buildEmojiContext, type EmojiEntry } from "./discord/emoji-cache";
import { appendStickerTags, messageDisplayContent } from "./discord/message-media";
import { assetsFromDiscordMessage } from "./discord/message-assets";
import { botChannelPermissions, channelDisplayName, channelTypeLabel, createDiscordMessageSender, createTargetChannelResolver, createTypingController, fetchAccessibleGuildChannel as fetchAccessibleDiscordGuildChannel, isSendableGuildChannel, type SendableGuildChannel } from "./discord/message-sender";
import { registerReactionSyncRuntime } from "./discord/reaction-sync-runtime";
import { createSchedulerEngine, type SchedulerEngine } from "./scheduler/engine";
import { createScheduledTaskRunner } from "./scheduler/scheduled-task-runtime";
import { handleMessage, hasMaintenanceMaterial, runSilentMemoryAgentPass, runSilentToolAgentPass, type HandleResult, type AssetAttachmentResolver, type IncomingMessage, type HandlerDeps, type MemoryExtractionRequest, type MessageSender, type OutboundAttachment } from "./agent/handler";
import { trackWriteToolStarts } from "./agent/tool-access";
import { buildComputedContactContextForUser } from "./agent/contact-context";
import { shouldRespond, shouldRespondDeliberately, type TriggerResult } from "./agent/triggers";
import { typingSimulationDelayMs } from "./agent/typing-simulation";
import { createChannelDispatcher, selectDispatchMessageForTrigger, selectDispatchMessagesForTrigger, type ChannelDispatcher, type DispatchOutcome } from "./discord/channel-dispatcher";
import { assembleContext, type AssembledContext, type ThreadMetadata } from "./agent/context-assembly";
import type { HistoryMessage } from "./agent/history-types";
import { getContextHistoryMessages, insertSyntheticEvent, insertPromptOnlyBotMessage, getParentPreContext, listBotChannelUsage, listChannelMessages, getRoutedMessageSource, getLatestMessageActivityBefore, type MessageActivity } from "./db/message-repository";
import { cleanupDeletedDiscordMessage } from "./db/message-cleanup";
import {
  countMessagesSinceMemoryExtraction,
  getMemoryExtractionCheckpoint,
  getMessagesSinceMemoryExtraction,
  markMemoryExtractionCheckpoint,
  markMemoryExtractionCheckpointAtMessage,
} from "./db/memory-extraction-repository";
import { processHistory } from "./agent/history-pipeline";
import { trimMessages } from "./agent/history-trimming";
import { formatMessageLine, OLDER_LEGEND } from "./agent/history-formatting";
import { insertDateStamps } from "./agent/history-dates";
import { formatRelativeAgo } from "./agent/history-dates";
import { currentLocalContext, formatElapsedDuration } from "./time/agent-time";
import type { ReplyFallbackDeps } from "./agent/reply-target-fallback";

import { createElevenLabsClient, type ElevenLabsClient } from "./tts/client";
import type { TtsResult } from "./tts/types";
import { buildMemoryContext, buildMemoryMaintenanceContext, buildPrivateLifeMemoryContext, buildVisibleUserMemoryContext, createRecordMemoryTool } from "./agent/memory-service";
import { createSearchChannelMessagesTool } from "./agent/search-channel-messages-tool";
import { createScheduleTools } from "./agent/schedule-tool";
import { createChatUserListTool, type MemberInfo } from "./agent/member-list-tool";
import { createChannelListTool, type ChannelInfo } from "./agent/channel-list-tool";
import { createEmojiListTool } from "./agent/emoji-list-tool";
import { createDiscordTimeoutTools, MAX_DISCORD_TIMEOUT_SECONDS, type TimeoutMember, type TimeoutMemberResolution } from "./agent/timeout-user-tool";
import { createSearchMemoriesTool } from "./agent/search-memories-tool";
import { buildInnerThreadsContext, createListInnerThreadsTool, createRecordInnerThreadsTool } from "./agent/inner-thread-service";
import { listInnerThreads } from "./db/inner-thread-repository";
import { createListChannelMessagesTool } from "./agent/list-channel-messages-tool";
import { createOwnMessageTools } from "./agent/own-message-tool";
import { createBraveImageSearchTool, createBraveSearchTool } from "./agent/brave-search-tool";
import { createReadAssetTool, extractRemoteVideoFrame, type ReadAssetToolDeps } from "./agent/read-asset-tool";
import { createSearchAssetTool } from "./agent/search-asset-tool";
import { createReadUserAvatarTool, type AvatarSize } from "./agent/read-user-avatar-tool";
import { createFetchImagesTool } from "./agent/fetch-images-tool";
import { loadExternalImage } from "./agent/external-image";
import { createCodexGenerateImageTool, type GeneratedImageAttachment, type ReferenceImageInput } from "./agent/codex-image-tool";
import { AgentJobStore, createCancelAgentJobTool, isActiveJobStatus, type ImageGenerationJobResult } from "./agent/job-runtime";
import { createAgentJobInspectionTools, renderAgentJobDetails } from "./agent/agent-job-tool";
import { annotateHistoryJobs, createGeneratedImageRuntime, imageReferencesForToolInput, renderAgentJobsContext, renderImageGenerationInput, shortQuote, type GeneratedImageRuntime } from "./agent/generated-image-runtime";
import { createStoredAssetAttachmentResolver } from "./agent/stored-asset-attachments";
import { loadAssetReferenceImage, loadStagedAssetReferenceImage } from "./agent/asset-reference-image";
import { createFetchUrlTool } from "./agent/fetch-url-tool";
import { createSummarizeVideoTool } from "./agent/summarize-video-tool";
import { createCloseThreadTool, createStartThreadTool } from "./agent/start-thread-tool";
import { createReactToMessageTool } from "./agent/react-to-message-tool";
import { createDiceRollTool, type DiceRollDelivery } from "./agent/dice-roll-tool";
import { applyRuntimeToolPrompts, type ToolPromptVariables } from "./agent/runtime-tool-prompts";
import {
  isToolAllowedInMaintenance,
  type MaintenanceWriteToolName,
} from "./agent/tool-effects.ts";
import {
  commitStagedMaintenanceCalls,
  SemanticMaintenanceCoordinator,
  stageMaintenanceTools,
  type StagedMaintenanceCall,
} from "./agent/semantic-maintenance-coordinator.ts";
import { createModelImageSupportStore } from "./llm/model-image-support";
import { resolveModelProfile } from "./llm/client";
import { createAmbientRuntime } from "./ambient/runtime";
import { createPrivateLifeRuntime } from "./private-life/runtime.ts";
import { createPrivateLifeSummaryTool } from "./private-life/summary-tool.ts";
import {
  PRIVATE_LIFE_ACTION_SCOPES,
  PRIVATE_LIFE_ATTENTION_ORIGINS,
  PRIVATE_LIFE_CURIOSITY_MODES,
  PRIVATE_LIFE_TERRITORIES,
} from "./private-life/types.ts";
import { clearExpiredPrivateLifeThoughts } from "./db/private-life-repository.ts";
import { createPersonaModeRuntime } from "./modes/runtime";
import type { PersonaModeActivityType } from "./modes/types";
import { cacheAssetExtraction, getAssetById, getAssetsByMessageId, syncMessageAssets } from "./db/asset-repository";
import {
  createStagedAsset,
  deleteStagedAsset,
  getStagedAsset,
  getStagedAssetForJob,
  listStagedAssets,
  reconcileStagedAsset,
} from "./db/staged-asset-repository";
import { upsertThread, updateThreadActivity, markThreadArchived, listThreadsForContext, getThreadMetadata, getThread } from "./db/thread-repository";
import { prepareImageBufferForContext } from "./agent/image-buffer";
import { deleteExpiredMemories, countUserMemoriesByUser } from "./db/memory-repository";
import { createRelationshipsManagementApi } from "./dashboard/relationships-management";
import { createDashboardManagementRuntime, dashboardTriggerLocation } from "./dashboard/management-runtime";
import { createPromptLabRunner, promptLabDryRunTools, promptLabSummary, promptLabSyntheticId } from "./dashboard/prompt-lab-runtime";
import {
  createRecordRelationshipTool,
  getRelationshipProfile,
  listRelationshipProfiles,
  renderNotableRelationshipsContext,
  renderRelationshipPromptContext,
  type RelationshipContextProfile,
  type RelationshipConfig,
  type RelationshipMutationResult,
} from "./relationships";
import { listUpcomingForContext } from "./db/schedule-repository";
import { registerGuildSlashCommands, registerSlashCommands } from "./commands/registry";
import { statusCommandDefinition } from "./commands/status";
import { scheduleCommandDefinition } from "./commands/schedule";
import { memoryWipeCommandDefinition } from "./commands/memory-wipe";
import { vpnCommandDefinition } from "./commands/vpn";
import { voiceTestCommandDefinition } from "./commands/voice-test.ts";
import { createVpnClient, type VpnClient } from "./vpn/api-client";
import { createSessionStore, type SessionStore } from "./vpn/session";
import { loadInstructionBundle, type PromptBundle } from "./config/instruction-bundle";
import { requireProfileConfigPath } from "./config/profile";
import { renderPromptTemplate } from "./config/prompt-template";
import { resolveReactionEmojiInput } from "./discord/reaction-emoji";
import { createDiscordReplyFallbackDeps, createSyntheticReplyFallbackDeps, syncDeletedOwnBotMessage, syncEditedOwnBotMessage } from "./discord/reply-fallback-runtime";
import { createDiscordAssetSourceResolver } from "./discord/asset-resolver";
import { backfillMessageAssets } from "./discord/asset-backfill";
import { fetchMessagesAfterRestart } from "./discord/restart-catchup";
import { clearRestartRecoveryState, getRestartRecoveryState, listRecentDiscordChannels, setRestartRecoveryCutoff } from "./db/restart-recovery-repository";
import { AsyncTaskTracker } from "./runtime/async-task-tracker";
import { DEFAULT_ASSET_READING, DEFAULT_EXTERNAL_IMAGES } from "./config/defaults";
import { join } from "path";
import { mkdirSync, existsSync, readdirSync, statSync, watch, type FSWatcher } from "fs";
import { unlink } from "fs/promises";
import type { Database } from "./db/database";
import { ActivityType, ChannelType, PermissionFlagsBits, type Client, type Guild, type GuildBasedChannel, type GuildMember, type Message, type TextChannel, type ThreadChannel, type Typing } from "discord.js";
import { renderVoiceHistory, renderVoiceMoveHandoff } from "./voice/history.ts";
import { compactVoiceMaintenance, createVoiceSummaryTool } from "./voice/maintenance.ts";
import {
  VoiceRepository,
} from "./voice/repository.ts";
import { VoiceRuntime, type VoiceTurnRequest } from "./voice/runtime.ts";
import { createVoiceTools } from "./voice/tools.ts";

const pkg = await Bun.file(new URL("../package.json", import.meta.url).pathname).json() as { version?: string };
const CONTEXT_IMAGE_MAX_DIMENSION = 1024;
const version: string = pkg.version ?? "0.0.0";

const startTime = Date.now();
const logLevel = (process.env.LOG_LEVEL ?? "info") as LogLevel;
const log = createLogger({ level: logLevel });

const TYPING_INTERVAL_MS = 8_000;
const RESTART_CATCHUP_MAX_AGE_MS = 30 * 60_000;
const RESTART_CATCHUP_MAX_CHANNELS = 50;
const RESTART_CATCHUP_MAX_MESSAGES_PER_CHANNEL = 500;

const inboundMessageTasks = new AsyncTaskTracker();
const imageJobTasks = new AsyncTaskTracker();
const backgroundTasks = new AsyncTaskTracker();
const assetBackfillController = new AbortController();
let acceptingDiscordMessages = true;

async function runImageGenerationJob(jobId: string): Promise<void> {
  const job = agentJobs.get(jobId);
  if (job === undefined) return;
  const sourceGuildConfig = getGuildConfig(job.guildId);
  const deliveryGuildConfig = getGuildConfig(job.deliveryGuildId);
  const sourceGuild = client.guilds.cache.get(job.guildId);
  const guild = client.guilds.cache.get(job.deliveryGuildId);
  if (guild === undefined) {
    agentJobs.markFailed(job.id, "Delivery guild is unavailable.");
    return;
  }
  const channel = await client.channels.fetch(job.deliveryChannelId).catch(() => guild.channels.cache.get(job.deliveryChannelId) ?? null);
  if (channel === null || !("send" in channel) || !("sendTyping" in channel)) {
    agentJobs.markFailed(job.id, "Delivery channel is unavailable.");
    return;
  }
  if (!isSendableGuildChannel(channel)) {
    agentJobs.markFailed(job.id, "Delivery channel is not a supported guild text channel.");
    return;
  }
  const textChannel = channel;
  const typing = createTypingController({
    defaultChannel: textChannel,
    resolveTargetChannel: createTargetChannelResolver(client, textChannel),
  });
  typing.startLoop();
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Image job ${job.id} timed out after ${deliveryGuildConfig.agentJobs.imageTimeoutMs}ms`));
  }, deliveryGuildConfig.agentJobs.imageTimeoutMs);
  const requestLog = new RequestLog(job.deliveryGuildId, job.deliveryChannelId, requestLogStore);
  requestLog.setAuthor(job.requesterUsername);
  requestLog.setTriggerContext({
    ...dashboardTriggerLocation(guild, textChannel),
    authorUsername: job.requesterUsername,
    sourceMessageId: job.sourceMessageId,
    sourceQuote: job.sourceQuote,
  });
  requestLog.setTrigger({ type: "async_image_generation", jobId: job.id, sourceMessageId: job.sourceMessageId });
  requestLog.setAgentRan(true);
  requestLogStore.incrementActive();
  const imageToolCallId = `async-image-generate-${job.id}`;
  let imageToolStarted = false;
  let imageToolEnded = false;

  const runAsyncImageStatusTurn = async (input: {
    event: "ready" | "failed";
    instruction: string;
  }): Promise<string | undefined> => {
    let sourceMessage: Message | undefined;
    try {
      sourceMessage = await textChannel.messages.fetch(job.sourceMessageId);
    } catch {
      sourceMessage = undefined;
    }
    const sender = createBotDiscordMessageSender({
      defaultChannel: textChannel,
      resolveTargetChannel: createTargetChannelResolver(client, textChannel),
      botUserId: client.user?.id ?? "",
      botUsername: client.user?.username ?? "bot",
      logger: log,
      getLastTypingAt: typing.getLastTypingAt,
      ...(sourceMessage !== undefined ? { replySourceMessage: sourceMessage } : {}),
      routedFrom: {
        routedFromGuildId: job.guildId,
        routedFromChannelId: job.channelId,
        routedFromMessageId: job.sourceMessageId,
      },
    });

    const replyFallbackDeps = createDiscordReplyFallbackDeps({
      db,
      clientChannelsFetch: (chId) => client.channels.fetch(chId),
      guild,
      guildId: job.deliveryGuildId,
      channelId: job.deliveryChannelId,
      guildConfig: deliveryGuildConfig,
      fetchUncached: true,
    });
    const syntheticLatestMessage: HistoryMessage = {
      id: `async-image-${input.event}-${job.id}`,
      author: client.user?.username ?? "bot",
      authorId: client.user?.id ?? "",
      content: input.instruction,
      isBot: true,
      timestamp: Date.now(),
      replyToId: job.sourceMessageId,
      hasEmbeds: false,
      isSynthetic: true,
      relatedThreadId: null,
    };
    const context = await buildContext(
      job.deliveryGuildId,
      job.deliveryChannelId,
      guild,
      deliveryGuildConfig,
      input.instruction,
      syntheticLatestMessage,
      replyFallbackDeps,
      textChannel.isThread(),
      { timestamp: Date.now(), messageId: `async-image-${input.event}-${job.id}` },
      "virtual",
      undefined,
      { appendLatestToHistory: false, additionalVisibleUserIds: [job.requesterId] },
    );
    const extraTools = buildAgentTools(
      job.deliveryGuildId,
      job.deliveryChannelId,
      deliveryGuildConfig,
      guild,
      context.contextMessageIds,
      undefined,
      undefined,
      {
        includeImageGenerationTools: input.event === "failed",
        visibleUserIds: context.visibleUserIds ?? [],
      },
    );
    let sentMessageId: string | undefined;
    const completionSender: MessageSender = async (...args) => {
      const sent = await sender(...args);
      sentMessageId ??= sent.sentMessageId;
      return sent;
    };
    const tts = createTtsGenerator(deliveryGuildConfig);
    const completionIncoming: IncomingMessage = {
      content: input.instruction,
      guildId: job.deliveryGuildId,
      guildName: guild.name,
      channelId: job.deliveryChannelId,
      channelName: channelDisplayName(textChannel),
      authorId: client.user?.id ?? "",
      authorUsername: client.user?.username ?? "bot",
      authorIsBot: true,
      botUserId: client.user?.id ?? "",
      mentionedUserIds: [],
      translatedContent: input.instruction,
      messageId: syntheticLatestMessage.id,
      replyToMessageId: job.sourceMessageId,
      eventPrompt: {
        metadataHeading: input.event === "ready" ? "Async Job Ready" : "Async Job Failed",
        contentHeading: "Job Event",
        metadataText: "This is factual runtime state. The original requester is provenance, not the owner of this turn or a default reply target.",
      },
      // Do not feed finished generated images back into the chat model by default.
      // The Codex subscription Responses backend accepts some `input_image` URLs but
      // is unreliable with base64 data URLs, while this turn only needs to send the
      // already-generated Discord attachment and short delivery text.
    };
    extraTools.push(...blockToolsExcept(createPostReplyMaintenanceTools({
      guild,
      guildConfig: deliveryGuildConfig,
      memoryRequest: {
        sourceMessageId: syntheticLatestMessage.id,
        userMessage: input.instruction,
        assistantReply: "",
        recentContext: "",
        context,
        incomingMessage: completionIncoming,
        visibleReplySent: false,
      },
      currentUserId: job.requesterId,
      currentUsername: job.requesterUsername,
      sourceMessageId: syntheticLatestMessage.id,
      sourceRequestId: requestLog.requestId,
    }), "", "visible reply mode"));
    const completionResult = await handleMessage(completionIncoming, createHandlerDeps({
      guildId: job.deliveryGuildId,
      guildConfig: deliveryGuildConfig,
      context,
      currentChannelId: job.deliveryChannelId,
      sender: completionSender,
      extraTools,
      log: log.child({ component: `async-image-${input.event}`, guildId: job.deliveryGuildId, channelId: job.deliveryChannelId, sourceGuildId: job.guildId, sourceChannelId: job.channelId, jobId: job.id, requestId: requestLog.requestId }),
      requestLog,
      tts,
      resolveAssetAttachments: createAssetAttachmentResolver(job.deliveryGuildId, deliveryGuildConfig,
        log.child({ component: "stored-asset-attachments", guildId: job.deliveryGuildId, channelId: job.deliveryChannelId, jobId: job.id })),
      overrides: {
        forceTrigger: true,
        onStillWorking: (destinationChannelId) => { typing.startLoop(destinationChannelId); },
        getTypingStartedAt: typing.getTypingStartedAt,
        onVisibleOutput: typing.stopLoop,
        onAgentEnd: typing.stopLoop,
        afterReply: async (memoryRequest) => {
          await runMemoryPostReplyExtraction({
            guildConfig: deliveryGuildConfig,
            memoryRequest,
            guild,
            channel: textChannel,
            sourceRequestId: requestLog.requestId,
            source: `async_image_${input.event}`,
            currentUserId: job.requesterId,
            currentUsername: job.requesterUsername,
          });
          await runRelationshipPostReplyExtraction({
            guildConfig: deliveryGuildConfig,
            memoryRequest,
            guild,
            channel: textChannel,
            sourceRequestId: requestLog.requestId,
            source: `async_image_${input.event}`,
            currentUserId: job.requesterId,
            currentUsername: job.requesterUsername,
          });
          await runInnerThreadPostReplyExtraction({
            guildConfig: deliveryGuildConfig,
            memoryRequest,
            guild,
            channel: textChannel,
            sourceRequestId: requestLog.requestId,
          });
        },
        onIgnoredReply: ({ channelId: destinationChannelId, historyText }) => {
          persistIgnoredBotReply({
            guildId: job.deliveryGuildId,
            channelId: job.deliveryChannelId,
            destinationChannelId,
            botUserId: client.user?.id ?? "",
            botUsername: client.user?.username ?? "bot",
            sourceMessageId: syntheticLatestMessage.id,
            historyText,
          });
        },
      },
    }));
    return completionResult.agentRan ? sentMessageId : undefined;
  }

  try {
    if (job.status === "ready") {
      const staged = getStagedAssetForJob(db, job.id);
      if (staged === null) {
        agentJobs.markFailed(job.id, "Ready job has no durable staged asset.");
        return;
      }
      await runAsyncImageStatusTurn({
        event: "ready",
        instruction: [
          `[Async Image Job Ready] Job ${job.id} remains ready after restart.`,
          `Staged asset ref: ${staged.ref}.`,
          `Original requester: @${job.requesterUsername} (${job.requesterId}).`,
          `Source: guild ${job.guildId}, channel ${job.channelId}, MsgID ${job.sourceMessageId}; quote: ${JSON.stringify(job.sourceQuote)}.`,
          `Intended delivery room: guild ${job.deliveryGuildId}, channel ${job.deliveryChannelId}.`,
          "This event does not instruct you to send it. You may inspect it, deliver it explicitly, defer it, or dismiss the job deliberately.",
        ].join("\n"),
      });
      return;
    }
    agentJobs.start(job.id, () => controller.abort(new Error(`Image job ${job.id} cancelled.`)));
    const generated = createGeneratedImageRuntime();
    const imageProfile = resolveModelProfile(
      globalConfig,
      sourceGuildConfig.imageGeneration.modelProfile,
    );
    if (imageProfile.provider !== "openai-codex") {
      throw new Error(
        `Image generation model profile "${sourceGuildConfig.imageGeneration.modelProfile}" must use openai-codex`,
      );
    }
    const jobAssetSource = createDiscordAssetSourceResolver({
      fetchMessage: async (targetChannelId, messageId) => {
        const target = await fetchAccessibleGuildChannel(targetChannelId);
        if (target === null || !("messages" in target)) return null;
        try { return await (target as TextChannel | ThreadChannel).messages.fetch(messageId); } catch { return null; }
      },
    });
    const tool = createCodexGenerateImageTool({
      codexAuthPath: globalConfig.codexAuthPath,
      model: imageProfile.model,
      sessionId: `2b2v-image-job:${job.guildId}:${job.channelId}:${job.deliveryGuildId}:${job.deliveryChannelId}:${job.id}`,
      logger: log.child({ component: "async-image-job", guildId: job.deliveryGuildId, channelId: job.deliveryChannelId, sourceGuildId: job.guildId, sourceChannelId: job.channelId, jobId: job.id }),
      imageReferenceMaxPerCall: sourceGuildConfig.imageReferenceMaxPerCall,
      imageGenerationQuality: sourceGuildConfig.imageGeneration.quality,
      asyncJobAlreadyActiveTemplate: promptBundle.runtime.contextTemplates["codex-image-job-existing"],
      asyncJobStartedTemplate: promptBundle.runtime.contextTemplates["codex-image-job-started"],
      resolveReferenceImage: async (id) => {
        if (typeof id === "string") {
          const staged = getStagedAsset(db, id);
          return staged === null
            ? null
            : await loadStagedAssetReferenceImage({
                asset: staged,
                maxBytes: sourceGuildConfig.assetReading?.maxDownloadBytes
                  ?? DEFAULT_ASSET_READING.maxDownloadBytes,
              });
        }
        const asset = getAssetById(db, id);
        if (asset === null) return null;
        const source = await jobAssetSource(asset);
        if (source === null) return null;
        return await loadAssetReferenceImage({
          asset,
          source,
          maxBytes: sourceGuildConfig.assetReading?.maxDownloadBytes ?? DEFAULT_ASSET_READING.maxDownloadBytes,
        });
      },
      resolveExternalReference: loadExternalReference,
      resolveAvatarReference: async (userId, signal) => {
        if (sourceGuild === undefined) throw new Error("Source guild is unavailable for the avatar reference.");
        return await loadGuildAvatarReference(sourceGuild, userId, signal);
      },
      onGeneratedImage: generated.onGeneratedImage,
    });
    const referenceImages = imageReferencesForToolInput(job.input.references);
    const imageToolArgs = {
      jobId: job.id,
      prompt: job.input.prompt,
      reference_images: referenceImages,
      output_format: job.input.outputFormat,
      "4k": job.input.is4k,
    };
    requestLog.recordToolStart(imageToolCallId, "codex_generate_image", imageToolArgs);
    imageToolStarted = true;
    const result = await tool.execute(job.id, {
      prompt: job.input.prompt,
      reference_images: referenceImages,
      output_format: job.input.outputFormat,
      "4k": job.input.is4k,
    }, controller.signal);
    requestLog.recordToolEnd(imageToolCallId, false, result);
    imageToolEnded = true;
    const details = result.details as {
      generatedAttachmentIds?: string[];
      revisedPrompt?: string;
      transport?: string;
      requestedSize?: string;
      actualSize?: string;
      is4k?: boolean;
    } | undefined;
    const attachmentIds = details?.generatedAttachmentIds ?? [];
    const attachments = generated.consumeGeneratedAttachments(attachmentIds);
    const attachment = attachments[0];
    if (attachment === undefined) {
      throw new Error("Image generation finished without an attachment.");
    }

    const latest = agentJobs.get(job.id);
    if (latest === undefined || !isActiveJobStatus(latest.status)) return;
    const generationInput = renderImageGenerationInput(job.input);
    const outboundAttachment: OutboundAttachment = attachment;
    const stagedRef = `job_${job.id.replace(/[^A-Za-z0-9]/g, "")}`;
    const stagedDirectory = join(globalConfig.dataDir, "staged-assets", stagedRef);
    mkdirSync(stagedDirectory, { recursive: true });
    const stagedPath = join(stagedDirectory, outboundAttachment.filename);
    await Bun.write(stagedPath, outboundAttachment.buffer);
    createStagedAsset(db, {
      ref: stagedRef,
      jobId: job.id,
      ownerGuildId: job.deliveryGuildId,
      ownerChannelId: job.deliveryChannelId,
      filename: outboundAttachment.filename,
      contentType: outboundAttachment.contentType,
      storagePath: stagedPath,
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    agentJobs.markReady(job.id, {
      stagedAssetRef: stagedRef,
      attachmentId: outboundAttachment.id,
      filename: outboundAttachment.filename,
      contentType: outboundAttachment.contentType,
      is4k: job.input.is4k,
      ...(details?.transport !== undefined ? { transport: details.transport } : {}),
      ...(details?.requestedSize !== undefined ? { requestedSize: details.requestedSize } : {}),
      ...(details?.actualSize !== undefined ? { actualSize: details.actualSize } : {}),
      ...(typeof details?.revisedPrompt === "string" ? { revisedPrompt: details.revisedPrompt } : {}),
    } satisfies ImageGenerationJobResult);

    const completionInstruction = runtimeContextTemplate("async-image-ready", {
      jobId: job.id,
      stagedAssetRef: stagedRef,
      requesterUsername: job.requesterUsername,
      requesterId: job.requesterId,
      is4k: job.input.is4k ? "yes" : "no",
      transportLine: details?.transport !== undefined ? `Transport: ${details.transport}\n` : "",
      requestedSizeLine: details?.requestedSize !== undefined ? `Requested size: ${details.requestedSize}\n` : "",
      actualSizeLine: details?.actualSize !== undefined ? `Actual size: ${details.actualSize}\n` : "",
      sourceMessageId: job.sourceMessageId,
      sourceQuote: job.sourceQuote,
      generationInput,
      revisedPromptLine: typeof details?.revisedPrompt === "string" ? `Revised prompt: ${details.revisedPrompt}\n` : "",
      deliveryGuildId: job.deliveryGuildId,
      deliveryChannelId: job.deliveryChannelId,
    }, [
      `[Async Image Job Ready] Job ${job.id} generated an image.`,
      `Staged asset ref: ${stagedRef}.`,
      `Original requester: @${job.requesterUsername} (${job.requesterId}).`,
      `Source: guild ${job.guildId}, channel ${job.channelId}, MsgID ${job.sourceMessageId}; quote: ${JSON.stringify(job.sourceQuote)}.`,
      `Intended delivery room: guild ${job.deliveryGuildId}, channel ${job.deliveryChannelId}.`,
      "This event does not instruct you to send it. You may inspect it, deliver it with an explicit message asset_ids reference, defer it, or dismiss the job deliberately.",
    ].join("\n"));
    const sentMessageId = await runAsyncImageStatusTurn({
      event: "ready",
      instruction: completionInstruction,
    });
    if (sentMessageId !== undefined && agentJobs.get(job.id)?.status === "delivered") {
      ambientRuntime.noteAmbientBotReply({
        guildId: job.deliveryGuildId,
        channelId: job.deliveryChannelId,
        userId: job.requesterId,
        sourceMessageId: job.sourceMessageId,
        botMessageId: sentMessageId,
        allowLease: true,
        allowFollowUp: false,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    requestLog.setError(message);
    if (imageToolStarted && !imageToolEnded) {
      requestLog.recordToolEnd(imageToolCallId, true, {
        content: [{ type: "text", text: message }],
      });
      imageToolEnded = true;
    }
    if (controller.signal.aborted && agentJobs.get(job.id)?.status === "dismissed") return;
    const timedOut = controller.signal.aborted && message.includes("timed out");
    agentJobs.markFailed(job.id, timedOut ? `Timed out: ${message}` : message);
    const latest = agentJobs.get(job.id);
    if (latest?.status === "failed") {
      try {
        const failureInstruction = runtimeContextTemplate("async-image-failed", {
          jobId: job.id,
          statusText: timedOut ? "timed out" : "failed",
          requesterUsername: job.requesterUsername,
          sourceMessageId: job.sourceMessageId,
          sourceQuote: job.sourceQuote,
          generationInput: renderImageGenerationInput(job.input),
          failureDetail: message,
        }, `[Async Image Job Failed] Job ${job.id} ${latest.status}.`);
        await runAsyncImageStatusTurn({
          event: "failed",
          instruction: failureInstruction,
        });
      } catch (sendErr) {
        log.warn("async image failure notification failed", {
          jobId: job.id,
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
      }
    }
  } finally {
    clearTimeout(timeout);
    typing.stopLoop();
    requestLog.emit(log);
    requestLogStore.decrementActive();
  }
}

function persistIgnoredBotReply(input: {
  guildId: string;
  channelId: string;
  destinationChannelId?: string;
  botUserId: string;
  botUsername: string;
  sourceMessageId: string;
  historyText: string;
}): void {
  insertPromptOnlyBotMessage(db, {
    id: `prompt-only:ignore:${input.sourceMessageId}`,
    guildId: input.guildId,
    channelId: input.destinationChannelId ?? input.channelId,
    botUserId: input.botUserId,
    botUsername: input.botUsername,
    content: input.historyText,
    replyToId: input.sourceMessageId,
  });
}

function createBotDiscordMessageSender(
  input: Omit<Parameters<typeof createDiscordMessageSender>[0], "db" | "buildOutboundResolvers">,
): MessageSender {
  const callerOnDelivered = input.onDelivered;
  return createDiscordMessageSender({
    db,
    buildOutboundResolvers,
    ...input,
    onDelivered: async (delivery) => {
      await callerOnDelivered?.(delivery);
      for (const attachment of delivery.attachments) {
        if (!attachment.id.startsWith("staged-")) continue;
        const ref = attachment.id.slice("staged-".length);
        const staged = getStagedAsset(db, ref);
        if (staged === null || staged.deliveredMessageId !== undefined) continue;
        const permanent = getAssetsByMessageId(db, delivery.messageId)
          .find((asset) => asset.filename === staged.filename);
        const reconciled = reconcileStagedAsset(db, {
          ref,
          deliveredMessageId: delivery.messageId,
          ...(permanent !== undefined ? { permanentAssetId: permanent.id } : {}),
        });
        if (!reconciled) continue;
        if (permanent !== undefined) agentJobs.linkAsset(staged.jobId, permanent.id);
        const job = agentJobs.get(staged.jobId);
        if (job?.status === "ready") {
          agentJobs.markDelivered(staged.jobId, delivery.messageId, {
            ...(job.result ?? {}),
            stagedAssetRef: ref,
          });
        }
        await unlink(staged.storagePath).catch((error: unknown) => {
          log.warn("delivered staged asset cleanup failed", {
            ref,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    },
  });
}

async function resolveClientGuild(guildId: string): Promise<Guild | null> {
  const cached = client.guilds.cache.get(guildId);
  if (cached !== undefined) return cached;
  return await client.guilds.fetch(guildId).catch(() => null);
}

async function fetchAccessibleGuildChannel(channelId: string): Promise<SendableGuildChannel | null> {
  return await fetchAccessibleDiscordGuildChannel(client, channelId);
}

function createTtsGenerator(guildConfig: GuildConfig): {
  ttsEnabled: boolean;
  generateSpeech?: (text: string) => Promise<TtsResult>;
} {
  const ttsEnabled = ttsClient !== undefined && guildConfig.tts?.enabled === true;
  if (!ttsEnabled || ttsClient === undefined || guildConfig.tts === undefined) {
    return { ttsEnabled };
  }
  const client = ttsClient;
  return {
    ttsEnabled,
    generateSpeech: async (text: string): Promise<TtsResult> => {
      const preset = guildConfig.tts?.voices.normal;
      if (preset === undefined) {
        return { ok: false, error: "Normal voice is not configured" };
      }
      return client.generate({
        text,
        voiceId: preset.voiceId,
        model: preset.model,
        seed: preset.seed,
        applyTextNormalization: preset.applyTextNormalization,
        outputFormat: preset.outputFormat,
        languageCode: preset.languageCode,
        voiceSettings: {
          stability: preset.stability,
          similarityBoost: preset.similarityBoost,
          speed: preset.speed,
          style: preset.style,
          useSpeakerBoost: preset.useSpeakerBoost,
        },
      });
    },
  };
}

function createHandlerDeps(input: {
  guildId: string;
  guildConfig: GuildConfig;
  context: AssembledContext;
  currentChannelId: string;
  sender: MessageSender;
  extraTools: AgentTool[];
  log: Logger;
  requestLog: RequestLog;
  tts?: {
    ttsEnabled: boolean;
    generateSpeech?: (text: string) => Promise<TtsResult>;
  };
  generatedImages?: GeneratedImageRuntime;
  resolveAssetAttachments?: AssetAttachmentResolver;
  modeLifecycle?: boolean;
  overrides?: Partial<HandlerDeps>;
}): HandlerDeps {
  let visibleModeOutput = false;
  const onVisibleOutput = input.overrides?.onVisibleOutput;
  const onAgentEnd = input.overrides?.onAgentEnd;
  return {
    globalConfig,
    guildConfig: input.guildConfig,
    context: input.context,
    currentChannelId: input.currentChannelId,
    systemPrompt: promptBundle.systemPrompt,
    personaPrompt: promptBundle.corePrompt,
    runtimePrompts: promptBundle.runtime,
    sender: input.sender,
    extraTools: input.extraTools,
    log: input.log,
    requestLog: input.requestLog,
    modelImageInputSupport: modelImageSupport.get(
      globalConfig,
      input.overrides?.modelProfile ?? input.guildConfig.modelProfile,
    ),
    ...(input.tts ?? {}),
    ...(input.generatedImages !== undefined
      ? { consumeGeneratedAttachments: input.generatedImages.consumeGeneratedAttachments }
      : {}),
    ...(input.resolveAssetAttachments !== undefined ? { resolveAssetAttachments: input.resolveAssetAttachments } : {}),
    trackBackgroundTask: (task) => {
      void backgroundTasks.track(task);
    },
    ...input.overrides,
    onVisibleOutput: () => {
      onVisibleOutput?.();
      visibleModeOutput = true;
    },
    onAgentEnd: () => {
      onAgentEnd?.();
      if (input.modeLifecycle === false || !visibleModeOutput) return;
      personaModeRuntime.noteVisibleTurn(input.guildId);
    },
  };
}

function createAssetAttachmentResolver(_guildId: string, guildConfig: GuildConfig, logger: Logger): AssetAttachmentResolver {
  const resolveSource = createDiscordAssetSourceResolver({
    fetchMessage: async (channelId, messageId) => {
      const channel = await fetchAccessibleGuildChannel(channelId);
      if (channel === null || !("messages" in channel)) return null;
      try {
        return await (channel as TextChannel | ThreadChannel).messages.fetch(messageId);
      } catch {
        return null;
      }
    },
  });
  return createStoredAssetAttachmentResolver({
    db,
    stagedGuildId: _guildId,
    maxDownloadBytes: guildConfig.assetReading?.maxDownloadBytes ?? DEFAULT_ASSET_READING.maxDownloadBytes,
    resolveSource,
    logger,
  });
}

async function runLoggedAgentTurn(input: {
  incoming: IncomingMessage;
  deps: HandlerDeps;
  requestLog: RequestLog;
  logger: Logger;
  afterSuccess?: (result: HandleResult) => void | Promise<void>;
  onFinally?: (result: HandleResult | undefined) => void;
}): Promise<HandleResult> {
  let result: HandleResult | undefined;
  try {
    result = await handleMessage(input.incoming, input.deps);
    await input.afterSuccess?.(result);
    return result;
  } catch (err) {
    input.requestLog.setError(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    input.onFinally?.(result);
    if (result !== undefined) {
      input.requestLog.setTrigger(result.triggerResult);
      input.requestLog.setAgentRan(result.agentRan);
    }
    input.requestLog.emit(input.logger);
  }
}

log.info("bot starting", {
  version,
  runtime: `bun ${Bun.version}`,
  pid: process.pid,
});

// --- 1. Load global config (throws on missing secrets) ---
const configuredProfile = process.env.PROFILE?.trim();
if (configuredProfile === undefined || configuredProfile === "") {
  throw new Error("PROFILE is required (for example, PROFILE=2b or PROFILE=delamain)");
}
const profile = configuredProfile;
const profilesDir = "profiles";
const profileDir = join(profilesDir, profile);
const configPath = requireProfileConfigPath(profilesDir, profile);
const guildsDir = join(profileDir, "guilds");
let globalConfig = loadGlobalConfig(process.env as Record<string, string | undefined>, configPath);
validateTrimConfig(globalConfig.defaultTrim);
validateVpnConfig(globalConfig.vpn);
log.info("profile loaded", {
  profile,
  modelProfile: globalConfig.defaultModelProfile,
  model: resolveModelProfile(globalConfig, globalConfig.defaultModelProfile).model,
  configPath,
});

async function loadExternalReference(url: string, signal?: AbortSignal): Promise<ReferenceImageInput> {
  const image = await loadExternalImage(url, globalConfig.externalImages ?? DEFAULT_EXTERNAL_IMAGES, {}, signal);
  return {
    id: image.finalUrl,
    data: image.preview.toString("base64"),
    mimeType: image.previewMimeType,
    width: image.width,
    height: image.height,
  };
}

/** Resolve a current guild display avatar as an ephemeral image-generation reference. */
async function loadGuildAvatarReference(guild: Guild, userId: string, signal?: AbortSignal): Promise<ReferenceImageInput | null> {
  const member = await resolveGuildMemberReference(guild, userId);
  if (member === undefined) return null;
  const url = member.displayAvatarURL({ extension: "png", forceStatic: true, size: 2048 });
  const image = await loadExternalReference(url, signal);
  return { ...image, id: `avatar:${userId}` };
}

const startupMessageQueue: Message[] = [];
let startupMessageProcessingReady = false;
let startupMessageQueueDraining = false;

const client: Client = createDiscordClient(globalConfig, log);
client.on("messageCreate", handleMessageCreateEvent);
const discordLoginPromise = loginDiscordClient(client, globalConfig.discordToken);
void discordLoginPromise.catch(() => {});

// --- 2. Ensure data directory exists ---
if (!existsSync(globalConfig.dataDir)) {
  mkdirSync(globalConfig.dataDir, { recursive: true });
}

// --- 3. Init SQLite ---
const dbPath = join(globalConfig.dataDir, "bot.db");
const db: Database = createDatabase(dbPath);
log.info("database ready", { path: dbPath });

function discordActivityType(type: PersonaModeActivityType): ActivityType {
  const types: Record<PersonaModeActivityType, ActivityType> = {
    playing: ActivityType.Playing,
    streaming: ActivityType.Streaming,
    listening: ActivityType.Listening,
    watching: ActivityType.Watching,
    custom: ActivityType.Custom,
    competing: ActivityType.Competing,
  };
  return types[type];
}

const personaModeRuntime = createPersonaModeRuntime({
  db,
  config: globalConfig.personaModes,
  timezone: globalConfig.defaultTimezone,
  log: log.child({ component: "persona-modes" }),
  trackBackgroundTask: (task) => {
    void backgroundTasks.track(task);
  },
  guildIds: () => [...client.guilds.cache.keys()],
  presentation: {
    global: {
      currentAvatarHash: () => client.user?.avatar ?? null,
      applyAvatar: async (candidate) => {
        const user = client.user;
        if (user === null) throw new Error("Discord client is not ready");
        const bytes = Buffer.from(await Bun.file(candidate.path).arrayBuffer());
        const updated = await user.setAvatar(bytes);
        return { discordAvatarHash: updated.avatar };
      },
      applyPresence: (presence) => {
        const user = client.user;
        if (user === null) throw new Error("Discord client is not ready");
        user.setPresence({
          status: presence?.status ?? "online",
          activities: presence?.activity === undefined
            ? []
            : [{
                type: discordActivityType(presence.activity.type),
                name: presence.activity.name,
                ...(presence.activity.state !== undefined ? { state: presence.activity.state } : {}),
                ...(presence.activity.url !== undefined ? { url: presence.activity.url } : {}),
              }],
        });
      },
    },
    guild: {
      currentAvatarHash: (guildId) => client.guilds.cache.get(guildId)?.members.me?.avatar ?? null,
      applyAvatar: async (guildId, candidate) => {
        const guild = client.guilds.cache.get(guildId);
        if (guild === undefined) throw new Error(`Discord guild ${guildId} is not available`);
        const avatar = candidate === null
          ? null
          : Buffer.from(await Bun.file(candidate.path).arrayBuffer());
        const updated = await guild.members.editMe({ avatar });
        return { discordAvatarHash: updated.avatar };
      },
    },
  },
});
client.on("shardResume", () => personaModeRuntime.reapplyPresentation());

// --- 4. Load guild configs ---
const guildConfigs = loadGuildConfigs(guildsDir, globalConfig);
log.info("guild configs loaded", { count: guildConfigs.size });

const agentJobs = new AgentJobStore(db, globalConfig.defaultAgentJobs);

const modelImageSupport = createModelImageSupportStore({ log });
await modelImageSupport.refresh(globalConfig, guildConfigs, "startup");

// --- 8. Load shared instructions plus the selected profile overlay.
let promptBundle: PromptBundle = loadInstructionBundle(profilesDir, profile, log);

function runtimeToolDescription(
  toolName: string,
  variables: Record<string, string | number | boolean | undefined> = {},
): string | undefined {
  const template = promptBundle.runtime.toolDescriptions[toolName];
  return template === undefined ? undefined : renderPromptTemplate(template, variables);
}

function runtimeContextTemplate(
  name: string,
  variables: Record<string, string | number | boolean | undefined> = {},
  fallback = "",
): string {
  const template = promptBundle.runtime.contextTemplates[name];
  return template === undefined ? fallback : renderPromptTemplate(template, variables);
}

function defaultPersonaModeForMaintenance(): {
  id: string;
  instructions: string;
} {
  const config = globalConfig.personaModes;
  const mode = config?.modes.find((candidate) => candidate.id === config.defaultModeId);
  return {
    id: config?.defaultModeId ?? "default",
    instructions: mode?.instructions ?? "",
  };
}

// --- 9. Emoji cache ---
const emojiCache = new EmojiCache();
const EMOJI_TTL_MS = 10 * 60 * 1000; // 10 minutes

// --- 9b. TTS client (optional) ---
let ttsClient: ElevenLabsClient | undefined;
if (globalConfig.elevenLabsApiKey !== undefined && globalConfig.elevenLabsApiKey !== "") {
  ttsClient = createElevenLabsClient({ apiKey: globalConfig.elevenLabsApiKey });
  log.info("tts client ready");
}

// --- 9c. VPN client and session store ---
const vpnConfig = globalConfig.vpn;
const vpnEnabled = vpnConfig !== undefined;
const vpnClient: VpnClient | null = vpnEnabled ? createVpnClient(vpnConfig.apiUrl) : null;
const vpnSessionStore: SessionStore = createSessionStore();

if (vpnEnabled) {
  log.info("vpn client ready", { apiUrl: vpnConfig.apiUrl });
} else {
  log.info("vpn disabled");
}

// Periodic VPN session cleanup (every 5 minutes)
const VPN_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const vpnSessionCleanupTimer = setInterval(() => {
  vpnSessionStore.cleanExpired();
}, VPN_SESSION_CLEANUP_INTERVAL_MS);

// --- 10. Guild config resolver ---
function getGuildConfig(guildId: string): GuildConfig {
  const existing = guildConfigs.get(guildId);
  if (existing !== undefined) return existing;
  // Resolve default-only guilds on demand so global hot-reload changes such as
  // TTS settings cannot be hidden behind a stale cached default config.
  return resolveGuildConfig(globalConfig, { guildId, slug: "" });
}

function getRelationshipConfig(guildConfig: GuildConfig): RelationshipConfig {
  const config = guildConfig.relationships ?? globalConfig.defaultRelationships;
  if (config === undefined) throw new Error("relationships is not configured");
  return config;
}

function innerThreadsEnabled(guildConfig: GuildConfig): boolean {
  return (guildConfig.innerThreads ?? globalConfig.defaultInnerThreads)?.enabled !== false;
}

const voiceRepository = new VoiceRepository(db);
const voiceMaintenanceBusy = new Set<string>();

function getVoiceConfig(guildConfig: GuildConfig) {
  const voice = guildConfig.voice ?? globalConfig.defaultVoice;
  if (voice === undefined) throw new Error("voice configuration is unavailable");
  return voice;
}

async function voiceAssembledContext(
  request: VoiceTurnRequest,
  guild: Guild,
  guildConfig: GuildConfig,
): Promise<AssembledContext> {
  const instruction = request.instruction;
  const lastOutputIndex = request.history.findLastIndex((entry) => entry.kind === "output");
  // Keep the exchange around 2B's latest audible turn near the prompt tail,
  // while bounding unusually long runs of uninterrupted human speech.
  const immediateStart = Math.max(
    0,
    request.history.length - 16,
    lastOutputIndex === -1 ? request.history.length - 8 : lastOutputIndex - 2,
  );
  const earlierHistory = renderVoiceHistory(
    request.history.slice(0, immediateStart),
    guildConfig.timezone,
  );
  const immediateExchange = renderVoiceHistory(
    request.history.slice(immediateStart),
    guildConfig.timezone,
  );
  const latestUserMessage: HistoryMessage = {
    id: `voice:${request.sessionId}:${request.trigger.id}`,
    author: request.trigger.username,
    authorDisplayName: guild.members.cache.get(request.trigger.userId)?.displayName,
    authorId: request.trigger.userId,
    content: request.trigger.normalizedText,
    isBot: false,
    timestamp: request.trigger.startedAt,
    replyToId: null,
    hasEmbeds: false,
    isSynthetic: request.trigger.synthetic,
    relatedThreadId: null,
  };
  const replyFallbackDeps = createDiscordReplyFallbackDeps({
    db,
    clientChannelsFetch: (channelId) => client.channels.fetch(channelId),
    guild,
    guildId: request.guildId,
    channelId: request.channelId,
    guildConfig,
  });
  const base = await buildContext(
    request.guildId,
    request.channelId,
    guild,
    guildConfig,
    request.trigger.normalizedText,
    latestUserMessage,
    replyFallbackDeps,
    false,
    {
      timestamp: request.trigger.startedAt,
      messageId: latestUserMessage.id,
    },
    "live",
    undefined,
    {
      appendLatestToHistory: false,
      additionalVisibleUserIds: request.transcript
        .filter((segment) => !segment.synthetic)
        .map((segment) => segment.userId),
    },
  );
  const voiceSection = {
    label: "Live Voice Room",
    text: [
      "## Live Voice Room",
      `GuildID: ${request.guildId}`,
      `Voice ChannelID: ${request.channelId}`,
      "The sections below are chronological and may span recent visits to this channel. Every line begins with its local event or audible-speech start time precise to seconds. [room] lines mark presence boundaries; user speech is fallible ASR output; 2B lines are words previously audible in the room, and [interrupted] marks a partial reply.",
      earlierHistory === "" ? "" : `## Earlier Voice Room Context\n${earlierHistory}`,
      `## Immediate Voice Exchange\n${immediateExchange}`,
      [
        "## Current Voice Opportunity",
        `Source: ${request.opportunity.source}`,
        request.opportunity.owner === undefined
          ? "Attention owner: none; this is a room-level or external instruction opportunity."
          : `Attention owner: @${request.opportunity.owner.username} (${request.opportunity.owner.userId})`,
        `OpenedAt: ${new Date(request.opportunity.openedAt).toISOString()}`,
        request.opportunity.currentSpeakers.length === 0
          ? "Currently speaking: nobody."
          : `Currently speaking: ${request.opportunity.currentSpeakers.map((speaker) =>
            `@${speaker.username} (${speaker.userId}) for ${speaker.speakingForMs}ms`
          ).join(", ")}`,
        request.opportunity.recentInterrupters.length === 0
          ? "Recent interrupters in this opportunity: none."
          : `Recent interrupters: ${request.opportunity.recentInterrupters.map((speaker) =>
            `@${speaker.username} (${speaker.userId})`
          ).join(", ")}`,
      ].join("\n"),
      instruction === undefined
        ? ""
        : [
          "",
          "## Open Voice Instruction",
          `InstructionID: ${instruction.id}`,
          `Status: ${instruction.status}`,
          `Requester: @${instruction.requesterUsername} (${instruction.requesterId})`,
          `Source GuildID: ${instruction.sourceGuildId}`,
          `Source ChannelID: ${instruction.sourceChannelId}`,
          `Source MsgID: ${instruction.sourceMessageId}`,
          `Original asking message: ${instruction.sourceMessageText}`,
          `Instruction: ${instruction.instruction}`,
        ].join("\n"),
    ].filter((part) => part !== "").join("\n"),
    cached: false,
    role: "developer" as const,
  };
  const handoffSection = request.handoff === undefined
    ? undefined
    : {
      label: "Voice Move Handoff",
      text: renderVoiceMoveHandoff(request.handoff, guildConfig.timezone),
      cached: false,
      role: "developer" as const,
    };
  const currentContextIndex = base.sections.findIndex((section) => section.label === "Current Context");
  const insertAt = currentContextIndex === -1 ? base.sections.length : currentContextIndex;
  return {
    ...base,
    sections: [
      ...base.sections.slice(0, insertAt),
      ...(handoffSection === undefined ? [] : [handoffSection]),
      voiceSection,
      ...base.sections.slice(insertAt),
    ],
    userMessage: request.trigger.normalizedText,
  };
}

async function resolveDefaultVoiceTextChannel(guildId: string): Promise<SendableGuildChannel | null> {
  const guild = await resolveClientGuild(guildId);
  if (guild === null) return null;
  const configured = getGuildConfig(guildId).ambientInitiative?.mainChannelId;
  if (configured !== undefined && configured !== "") {
    const channel = client.channels.cache.get(configured) ?? await client.channels.fetch(configured).catch(() => null);
    if (channel !== null && isSendableGuildChannel(channel)) return channel;
  }
  if (guild.systemChannel !== null && isSendableGuildChannel(guild.systemChannel)) return guild.systemChannel;
  const row = db.raw.prepare(`SELECT channel_id FROM messages
    WHERE guild_id = ? AND is_bot = 0 AND deleted_at IS NULL
    GROUP BY channel_id ORDER BY COUNT(*) DESC LIMIT 1`).get(guildId) as { channel_id: string } | null;
  if (row !== null) {
    const channel = client.channels.cache.get(row.channel_id) ?? await client.channels.fetch(row.channel_id).catch(() => null);
    if (channel !== null && isSendableGuildChannel(channel)) return channel;
  }
  return null;
}

async function sendVoiceTextDirective(message: {
  channelId?: string;
  replyTo?: string;
  resolvesInstruction?: string;
  text: string;
}): Promise<{ sentMessageId: string }> {
  const snapshot = voiceRuntime.snapshot();
  const instruction = message.resolvesInstruction === undefined
    ? undefined
    : voiceRepository.getInstruction(message.resolvesInstruction);
  const guildId = instruction?.sourceGuildId ?? snapshot.guildId;
  const explicit = message.channelId ?? instruction?.sourceChannelId;
  let channel: SendableGuildChannel | null = null;
  if (explicit !== undefined) {
    const fetched = client.channels.cache.get(explicit) ?? await client.channels.fetch(explicit).catch(() => null);
    if (fetched !== null && isSendableGuildChannel(fetched)) channel = fetched;
  } else if (guildId !== undefined) {
    channel = await resolveDefaultVoiceTextChannel(guildId);
  }
  if (channel === null) throw new Error("No sendable default text channel is available for the voice message.");
  let sent: Message | undefined;
  if (message.replyTo !== undefined && "messages" in channel) {
    const target = await channel.messages.fetch(message.replyTo).catch(() => null);
    if (target !== null) {
      sent = await target.reply({
        content: message.text,
        allowedMentions: { repliedUser: true, users: instruction === undefined ? [] : [instruction.requesterId] },
      });
    }
  }
  if (sent === undefined) {
    const fallback = instruction === undefined || message.text.includes(`<@${instruction.requesterId}>`)
      ? message.text
      : `<@${instruction.requesterId}> ${message.text}`;
    sent = await channel.send({
      content: fallback,
      allowedMentions: { users: instruction === undefined ? [] : [instruction.requesterId] },
    });
  }
  return { sentMessageId: sent.id };
}

async function runVoiceAgentTurn(request: VoiceTurnRequest): Promise<void> {
  const runtime = voiceRuntime;
  const guild = await resolveClientGuild(request.guildId);
  if (guild === null) throw new Error(`Voice guild ${request.guildId} is unavailable.`);
  const baseConfig = getGuildConfig(request.guildId);
  const voiceConfig = getVoiceConfig(baseConfig);
  const guildConfig = baseConfig;
  const context = await voiceAssembledContext(request, guild, guildConfig);
  const origin = request.instruction === undefined
    ? {
      requesterId: request.trigger.userId,
      requesterUsername: request.trigger.username,
      sourceMessageId: `voice:${request.sessionId}:${request.trigger.id}`,
      sourceQuote: request.trigger.normalizedText,
    }
    : {
      requesterId: request.instruction.requesterId,
      requesterUsername: request.instruction.requesterUsername,
      sourceMessageId: request.instruction.sourceMessageId,
      sourceQuote: request.instruction.sourceMessageText,
    };
  const allowedToolNames = new Set([
    "list_channels",
    "search_memories",
    "read_asset",
    "search_asset",
    "read_user_avatar",
    "fetch_images",
    "fetch_url",
    "web_search",
    "search_images",
    "summarize_video",
    // Live image generation remains skill-gated, so its prerequisite loader
    // must survive the otherwise restrictive voice-tool allowlist.
    "load_skill",
    "join_voice_channel",
    "leave_voice_channel",
    "codex_generate_image",
    "cancel_agent_job",
    "list_agent_jobs",
    "read_agent_job",
  ]);
  const imageDeliveryChannel = await resolveDefaultVoiceTextChannel(request.guildId);
  const tools = buildAgentTools(
    request.guildId,
    request.channelId,
    guildConfig,
    guild,
    undefined,
    undefined,
    origin,
    {
      includeImageGenerationTools: imageDeliveryChannel !== null,
      voiceToolSurface: "voice",
      ...(imageDeliveryChannel === null
        ? {}
        : {
          imageDelivery: {
            guildId: imageDeliveryChannel.guildId,
            channelId: imageDeliveryChannel.id,
          },
        }),
    },
  ).filter((tool) => allowedToolNames.has(tool.name));
  const sink = runtime.createResponseSink(request.trigger.id, request.instruction?.id);
  const requestLog = new RequestLog(request.guildId, request.channelId, requestLogStore);
  requestLog.setAuthor(request.trigger.username);
  requestLog.setTrigger({
    type: "voice_turn",
    sessionId: request.sessionId,
    segmentId: request.trigger.id,
    instructionId: request.instruction?.id,
  });
  requestLog.setAgentRan(true);
  const runtimePrompts = {
    ...promptBundle.runtime,
    reply: promptBundle.runtime.voice?.runtime ?? "",
    finalActionInstruction: promptBundle.runtime.voice?.finalActionInstruction ?? "",
  };
  const incoming: IncomingMessage = {
    content: request.trigger.normalizedText,
    guildId: request.guildId,
    guildName: guild.name,
    channelId: request.channelId,
    channelName: voiceRuntime.snapshot().channelName ?? request.channelId,
    authorId: request.trigger.userId,
    authorUsername: request.trigger.username,
    authorIsBot: false,
    botUserId: client.user?.id ?? "",
    mentionedUserIds: [],
    translatedContent: request.trigger.normalizedText,
    eventContent: [
      "The room is available for your next action. Base it on the latest coherent exchange in Immediate Voice Exchange, including recent speech from all participants and your last audible reply.",
      "The final ASR segment merely caused this turn to run; it is not a privileged standalone message and may be inaccurate, incomplete, incidental, or addressed to someone else. Do not answer it in isolation. Respond to what is socially current in the room, or remain silent when no response is appropriate.",
      "Speech only seconds apart is likely part of one exchange, including quick replies and interruptions, but timing is evidence rather than proof; syntax, addressee, topic, and room context remain authoritative.",
    ].join("\n\n"),
    eventPrompt: {
      metadataHeading: "Voice Turn Metadata",
      contentHeading: "Live Voice Response Opportunity",
      metadataText: [
        `GuildID: ${request.guildId}`,
        `GuildName: ${guild.name}`,
        `Voice ChannelID: ${request.channelId}`,
        `Voice ChannelName: ${voiceRuntime.snapshot().channelName ?? request.channelId}`,
        `Response Boundary SegmentID: ${request.trigger.id}`,
      ].join("\n"),
    },
    messageId: `voice:${request.sessionId}:${request.trigger.id}`,
  };
  try {
    await handleMessage(incoming, createHandlerDeps({
      guildId: request.guildId,
      guildConfig,
      context,
      currentChannelId: request.channelId,
      sender: () => Promise.resolve({ sentMessageId: `voice:${crypto.randomUUID()}` }),
      extraTools: tools,
      log: log.child({ component: "voice-agent", sessionId: request.sessionId }),
      requestLog,
      modeLifecycle: false,
      overrides: {
        forceTrigger: true,
        modelProfile: voiceConfig.modelProfile,
        systemPrompt: promptBundle.systemPrompt,
        personaPrompt: promptBundle.corePrompt,
        runtimePrompts,
        externalResponseSink: sink,
        abortSignal: request.abortSignal,
        afterReply: undefined,
      },
    }));
  } catch (error) {
    sink.abort();
    throw error;
  } finally {
    runtime.releaseResponseSink(sink);
    requestLog.emit(log);
  }
}

async function runVoiceMaintenance(sessionId: string, final: boolean): Promise<void> {
  if (voiceMaintenanceBusy.has(sessionId)) return;
  const session = voiceRepository.getSession(sessionId);
  if (session === undefined) return;
  const guild = await resolveClientGuild(session.guildId);
  if (guild === null) return;
  const baseConfig = getGuildConfig(session.guildId);
  const voiceConfig = getVoiceConfig(baseConfig);
  const guildConfig = baseConfig;
  const includeSynthetic = voiceConfig.testing.includeSyntheticInMaintenance;
  const maintenanceChannel = client.channels.cache.get(session.channelId)
    ?? await client.channels.fetch(session.channelId).catch(() => null);
  const maintenanceChannelName = maintenanceChannel !== null
    && "name" in maintenanceChannel
    && typeof maintenanceChannel.name === "string"
    ? maintenanceChannel.name
    : session.channelId;
  voiceMaintenanceBusy.add(sessionId);
  try {
    const workloadDue = (
      checkpointKind: "summary" | "memory",
      config: { everySegments: number; minIntervalMs: number },
    ): boolean => {
      if (final) return true;
      const checkpoint = voiceRepository.getCheckpoint(sessionId, checkpointKind);
      const afterSegmentId = checkpoint?.throughSegmentId ?? 0;
      const newSegments = voiceRepository.countTranscriptAfter(sessionId, afterSegmentId);
      const lastRunAt = checkpoint?.lastRunAt ?? session.startedAt;
      return newSegments >= config.everySegments
        && Date.now() - lastRunAt >= config.minIntervalMs;
    };
    const loadBatch = (
      checkpointKind: "summary" | "memory",
      config: { everySegments: number; maxTurns: number; maxChars: number },
    ) => {
      const checkpoint = voiceRepository.getCheckpoint(sessionId, checkpointKind);
      const afterSegmentId = checkpoint?.throughSegmentId ?? 0;
      const history = voiceRepository.listMaintenanceHistory(
        sessionId,
        afterSegmentId,
        Math.max(config.everySegments, config.maxTurns * 6),
      ).filter((entry) =>
        entry.kind !== "transcript" || includeSynthetic || !entry.transcript.synthetic
      );
      const compact = compactVoiceMaintenance(
        history,
        afterSegmentId,
        config.maxTurns,
        config.maxChars,
      );
      const segments = history.flatMap((entry) =>
        entry.kind === "transcript" && entry.transcript.id > afterSegmentId
          ? [entry.transcript]
          : []
      );
      return { compact, segments };
    };
    const shouldSkipBatch = (batch: ReturnType<typeof loadBatch>): boolean =>
      batch.compact.newSegmentCount === 0
      || batch.compact.text === ""
      || (final && !batch.compact.hasNewOutput && batch.compact.newSegmentCount < 12);
    const createMaintenanceLog = (
      kind: "summary" | "extraction",
      last: { username: string },
      sourceMessageId: string,
      context: AssembledContext,
    ): RequestLog => {
      const requestLog = new RequestLog(guild.id, session.channelId, requestLogStore);
      requestLog.setAuthor(last.username);
      requestLog.setTrigger({
        type: "background_memory_extraction",
        source: `voice_session_${kind}`,
        sourceRequestId: sessionId,
      });
      requestLog.setTriggerContext({
        guildName: guild.name,
        channelName: maintenanceChannelName,
        messageId: sourceMessageId,
        authorUsername: last.username,
        content: context.userMessage,
        translatedContent: context.userMessage,
      });
      requestLog.setAgentRan(true);
      return requestLog;
    };
    const runLoggedPass = async (
      requestLog: RequestLog,
      pass: Parameters<typeof runSilentToolAgentPass>[0],
    ): Promise<void> => {
      requestLogStore.incrementActive();
      try {
        await runSilentToolAgentPass(pass);
      } catch (error) {
        requestLog.setError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        requestLog.emit(log);
        requestLogStore.decrementActive();
      }
    };

    if (workloadDue("summary", voiceConfig.maintenance.summary)) {
      const batch = loadBatch("summary", voiceConfig.maintenance.summary);
      const last = batch.segments.at(-1);
      if (last !== undefined && !shouldSkipBatch(batch)) {
        const sourceMessageId = `voice:${sessionId}:${batch.compact.latestSegmentId}:summary`;
        const context: AssembledContext = {
          sections: [{
            label: "Current Context",
            text: [
              session.rollingSummary === ""
                ? ""
                : `## Existing Rolling Summary\n${session.rollingSummary}`,
              `## Compact Voice Delta\n${batch.compact.text}`,
            ].filter((part) => part !== "").join("\n\n"),
            cached: false,
            role: "developer",
          }],
          userMessage: "Refresh the rolling voice-room summary.",
          visibleUserIds: batch.compact.userIds,
        };
        const incomingMessage: IncomingMessage = {
          content: context.userMessage,
          guildId: session.guildId,
          guildName: guild.name,
          channelId: session.channelId,
          channelName: maintenanceChannelName,
          authorId: last.userId,
          authorUsername: last.username,
          authorIsBot: false,
          botUserId: client.user?.id ?? "",
          mentionedUserIds: [],
          translatedContent: context.userMessage,
          messageId: sourceMessageId,
        };
        let refreshedSummary: string | undefined;
        const requestLog = createMaintenanceLog("summary", last, sourceMessageId, context);
        await runLoggedPass(requestLog, {
          globalConfig,
          guildConfig,
          context,
          systemPrompt: "Maintain a concise rolling summary from a compact live-voice transcript. ASR wording may be inaccurate. Never answer the conversation.",
          personaPrompt: "",
          runtimePrompts: promptBundle.runtime,
          incomingMessage,
          userContent: context.userMessage,
          assistantReply: "",
          visibleReplySent: false,
          tools: [createVoiceSummaryTool((summary) => {
            refreshedSummary = summary;
            voiceRepository.updateSession(sessionId, {
              rollingSummary: summary,
              summaryThroughSegmentId: batch.compact.latestSegmentId,
              ...(final ? { finalSummary: summary } : {}),
            });
          })],
          runtimeInstruction: "This is private voice-summary maintenance. Only update_voice_summary is available.",
          controlMessage: "Call update_voice_summary once with a refreshed 3-6 sentence summary combining the existing summary and new delta. Retry only if the tool reports an error.",
          modelProfile: voiceConfig.maintenance.summary.modelProfile,
          maxToolCalls: 2,
          terminateAfterSuccessfulToolRoundNames: ["update_voice_summary"],
          requestLog,
          log: log.child({ component: "voice-summary-maintenance", sessionId }),
        });
        if (refreshedSummary === undefined) {
          log.warn("voice summary maintenance completed without refreshing summary", { sessionId });
        }
        // A completed no-op must still advance cadence; otherwise one malformed
        // summary turn is retried after every subsequent transcript segment.
        voiceRepository.setCheckpoint(sessionId, "summary", batch.compact.latestSegmentId);
      }
    }

    if (workloadDue("memory", voiceConfig.maintenance.extraction)) {
      const batch = loadBatch("memory", voiceConfig.maintenance.extraction);
      const last = batch.segments.at(-1);
      if (last !== undefined && !shouldSkipBatch(batch)) {
        const usernameById = new Map(batch.segments.map((segment) => [segment.userId, segment.username]));
        const userIds = batch.compact.userIds.filter((userId) => usernameById.has(userId)).slice(0, 8);
        const sourceMessageId = `voice:${sessionId}:${batch.compact.latestSegmentId}:extraction`;
        const relationshipConfig = getRelationshipConfig(guildConfig);
        const enableInnerThreads = innerThreadsEnabled(guildConfig);
        const createVoiceExtractionTools = (dryRun: boolean): AgentTool[] => {
          const tools: AgentTool[] = [];
          if (guildConfig.memoryExtraction.postReply) {
            tools.push(createRecordMemoryTool({
              db,
              guildId: guild.id,
              currentUserId: last.userId,
              currentUsername: last.username,
              sourceMessageId,
              dryRun,
              recordMemoryDescription: runtimeToolDescription("record_memory", {}),
              resolveUsername: async (username) => {
                const cached = resolveKnownUsername(guild, username);
                if (cached !== undefined) return cached;
                try {
                  await guild.members.fetch();
                } catch {
                  // Cache-only fallback below handles missing permissions.
                }
                return resolveKnownUsername(guild, username);
              },
            }));
          }
          if (relationshipConfig.enabled) {
            tools.push(createRecordRelationshipTool({
              db,
              config: relationshipConfig,
              dryRun,
              description: runtimeToolDescription("record_relationship", {}),
              scope: {
                guildId: session.guildId,
                channelId: session.channelId,
                sourceMessageId,
              },
            }));
          }
          if (enableInnerThreads) {
            tools.push(createRecordInnerThreadsTool({
              db,
              guildId: guild.id,
              channelId: session.channelId,
              requestId: sessionId,
              description: runtimeToolDescription("record_inner_threads", {})
                ?? "Privately maintain durable inner threads.",
              dryRun,
            }));
          }
          return applyRuntimeToolPrompts(tools, promptBundle.runtime);
        };
        const validationTools = createVoiceExtractionTools(true);
        const commitTools = createVoiceExtractionTools(false);
        const stagedCalls: StagedMaintenanceCall[] = [];
        const stagedToolNames = new Set(validationTools.map((tool) => tool.name));
        const tools = stageMaintenanceTools(validationTools, stagedCalls, stagedToolNames);
        if (tools.length > 0) {
          const memoryContext = buildMemoryContext({
            db,
            guildId: guild.id,
            currentUserId: last.userId,
            visibleUserIds: userIds,
            resolveUserId: (userId) => usernameById.get(userId)
              ?? resolvePromptUsername(guild, userId),
            limit: 40,
            recentUserMaxUsers: 8,
            recentUserMaxMemoriesPerUser: 5,
            recentUserMaxRows: 30,
            contextInstruction: "Use these rows only to avoid duplicate or contradictory maintenance updates.",
          });
          const relationshipContext = relationshipConfig.enabled
            ? renderRelationshipPromptContext({
                current: getRelationshipProfile(db, last.userId),
                currentLabel: `@${last.username} (${last.userId})`,
                others: userIds
                  .filter((userId) => userId !== last.userId)
                  .map((userId): RelationshipContextProfile => ({
                    profile: getRelationshipProfile(db, userId),
                    label: `@${usernameById.get(userId) ?? userId} (${userId})`,
                    reason: "recent-chat",
                  })),
                template: promptBundle.runtime.relationships.context,
              })
            : "";
          const context: AssembledContext = {
            sections: [{
              label: "Current Context",
              text: [
                session.rollingSummary === ""
                  ? ""
                  : `## Existing Rolling Summary\n${session.rollingSummary}`,
                memoryContext === "" ? "" : `## Existing Memory Context\n${memoryContext}`,
                relationshipContext,
                enableInnerThreads
                  ? buildInnerThreadsContext({
                      db,
                      guildId: guild.id,
                      visibleUserIds: userIds,
                      limit: 30,
                      resolveUserId: (userId) => usernameById.get(userId)
                        ?? guild.members.cache.get(userId)?.user.username,
                    })
                  : "",
                `## Voice Speaker IDs\n${userIds.map((userId) =>
                  `@${usernameById.get(userId) ?? userId} = ${userId}`
                ).join("\n")}`,
                `## Compact Voice Delta\n${batch.compact.text}`,
              ].filter((part) => part !== "").join("\n\n"),
              cached: false,
              role: "developer",
            }],
            userMessage: "Review the compact voice delta for durable maintenance.",
            visibleUserIds: userIds,
          };
          const incomingMessage: IncomingMessage = {
            content: context.userMessage,
            guildId: session.guildId,
            guildName: guild.name,
            channelId: session.channelId,
            channelName: maintenanceChannelName,
            authorId: last.userId,
            authorUsername: last.username,
            authorIsBot: false,
            botUserId: client.user?.id ?? "",
            mentionedUserIds: [],
            translatedContent: context.userMessage,
            messageId: sourceMessageId,
          };
          const requestLog = createMaintenanceLog("extraction", last, sourceMessageId, context);
          const ticket = semanticMaintenanceCoordinator.reserve();
          const defaultMode = defaultPersonaModeForMaintenance();
          try {
            await runLoggedPass(requestLog, {
              globalConfig,
              guildConfig,
              context,
              systemPrompt: [
                promptBundle.systemPrompt,
                "Maintain private durable semantic state from a compact live-voice transcript. ASR wording may be inaccurate. Never answer the conversation.",
              ].filter((part) => part !== "").join("\n\n"),
              personaPrompt: promptBundle.corePrompt,
              runtimePrompts: promptBundle.runtime,
              incomingMessage,
              userContent: context.userMessage,
              assistantReply: "",
              visibleReplySent: false,
              tools,
              runtimeInstruction: promptBundle.runtime.reply,
              controlMessage: [
                runtimeContextTemplate(
                  "semantic-maintenance-execution-mode",
                  {
                    defaultPersonaModeId: defaultMode.id,
                    defaultPersonaModeInstructions: defaultMode.instructions,
                  },
                ),
                "Voice transcripts may contain ASR errors; require clear evidence before mutation.",
                "Every relationship signal must include the target userId from Voice Speaker IDs.",
                guildConfig.memoryExtraction.postReply
                  ? runtimeContextTemplate("memory-pass-decision")
                  : "",
                relationshipConfig.enabled
                  ? runtimeContextTemplate("relationship-pass-decision")
                  : "",
                enableInnerThreads
                  ? runtimeContextTemplate("inner-thread-pass-decision")
                  : "",
              ].filter((part) => part !== "").join("\n\n"),
              modelProfile: voiceConfig.maintenance.extraction.modelProfile,
              maxToolCalls: (guildConfig.memoryExtraction.postReply
                ? guildConfig.memoryExtraction.maxToolCalls
                : 0)
                + (relationshipConfig.enabled ? relationshipConfig.maxToolCalls : 0)
                + (enableInnerThreads ? 3 : 0),
              terminateAfterSuccessfulToolRoundNames: tools.map((tool) => tool.name),
              requestLog,
              log: log.child({ component: "voice-extraction-maintenance", sessionId }),
            });
            await ticket.commit(async () => {
              await commitStagedMaintenanceCalls({ calls: stagedCalls, tools: commitTools });
            });
          } catch (error) {
            ticket.skip();
            throw error;
          }
        }
        voiceRepository.setCheckpoint(sessionId, "memory", batch.compact.latestSegmentId);
        voiceRepository.setCheckpoint(sessionId, "relationship", batch.compact.latestSegmentId);
      }
    }
  } finally {
    voiceMaintenanceBusy.delete(sessionId);
  }
}

const voiceRuntime = new VoiceRuntime({
  client,
  repository: voiceRepository,
  getGuildConfig,
  elevenLabsApiKey: globalConfig.elevenLabsApiKey,
  log: log.child({ component: "voice" }),
  onTurn: runVoiceAgentTurn,
  sendMessage: sendVoiceTextDirective,
  onMaintenance: runVoiceMaintenance,
});

const SCHEDULED_ATTENTION_COOLDOWN_MS = 30_000;
const scheduledAttentionBusy = new Map<string, number>();

function scheduledAttentionKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

function markScheduledAttentionBusy(guildId: string, channelId: string): () => void {
  const key = scheduledAttentionKey(guildId, channelId);
  scheduledAttentionBusy.set(key, Number.POSITIVE_INFINITY);
  return () => {
    scheduledAttentionBusy.set(key, Date.now() + SCHEDULED_ATTENTION_COOLDOWN_MS);
  };
}

function isScheduledAttentionBusy(guildId: string, channelId: string): boolean {
  const until = scheduledAttentionBusy.get(scheduledAttentionKey(guildId, channelId));
  if (until === undefined) return false;
  if (until === Number.POSITIVE_INFINITY || until > Date.now()) return true;
  scheduledAttentionBusy.delete(scheduledAttentionKey(guildId, channelId));
  return false;
}

// --- 12. Init scheduler ---
const scheduler: SchedulerEngine = createSchedulerEngine({
  db,
  onFire: createScheduledTaskRunner({
    client,
    db,
    requestLogStore,
    log,
    getGuildConfig,
    createSyntheticReplyFallbackDeps,
    buildContext,
    buildAgentTools,
    createVisibleMaintenanceTools: (maintenanceInput) => blockToolsExcept(
      createPostReplyMaintenanceTools(maintenanceInput),
      "",
      "visible reply mode",
    ),
    createBotDiscordMessageSender,
    createTtsGenerator,
    createHandlerDeps,
    resolveAssetAttachments: createAssetAttachmentResolver,
    runLoggedAgentTurn,
    runMemoryPostReplyExtraction,
    runRelationshipPostReplyExtraction,
    runInnerThreadPostReplyExtraction,
    onScheduleCompleted: (id) => scheduler.removeSchedule(id),
    markScheduledAttentionBusy,
    preparePersonaModeTurn: (guildId) => personaModeRuntime.prepareNaturalTurn(guildId),
  }),
  log,
});
scheduler.start();
log.info("scheduler started", { jobs: scheduler.activeCount() });

// --- Periodic expired memory cleanup (hourly) ---
const MEMORY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const memoryCleanupTimer = setInterval(() => {
  const deleted = deleteExpiredMemories(db);
  if (deleted > 0) {
    log.info("expired memories cleaned", { deleted });
  }
  const thoughtRetentionDays = globalConfig.privateLife?.thoughtRetentionDays ?? 0;
  const clearedThoughts = clearExpiredPrivateLifeThoughts(
    db,
    Date.now() - thoughtRetentionDays * 86_400_000,
  );
  if (clearedThoughts > 0) {
    log.info("expired private-life thoughts cleared", { clearedThoughts, thoughtRetentionDays });
  }
  const expiredStaged = listStagedAssets(db, { unresolvedOnly: true, limit: 500 })
    .filter((asset) => asset.expiresAt <= Date.now());
  for (const staged of expiredStaged) {
    agentJobs.markExpired(staged.jobId);
    void unlink(staged.storagePath).catch(() => {});
    deleteStagedAsset(db, staged.ref);
  }
  if (expiredStaged.length > 0) {
    log.info("expired staged assets cleaned", { deleted: expiredStaged.length });
  }
  const deletedAgentJobs = agentJobs.cleanup();
  if (deletedAgentJobs > 0) {
    log.info("expired unlinked agent jobs cleaned", { deleted: deletedAgentJobs });
  }
}, MEMORY_CLEANUP_INTERVAL_MS);

// --- 13. Wait for Discord client login ---
await discordLoginPromise;
personaModeRuntime.start();

// --- 14. Register slash commands ---
const botUser = client.user;
if (botUser !== null) {
  try {
    const commandCount = await registerSlashCommands({
      token: globalConfig.discordToken,
      clientId: botUser.id,
      commands: [
        statusCommandDefinition.toJSON(),
        scheduleCommandDefinition.toJSON(),
        memoryWipeCommandDefinition.toJSON(),
        vpnCommandDefinition.toJSON(),
      ],
    });
    log.info("slash commands registered", { count: commandCount });
    const voiceTestGuildIds = [...new Set([
      ...(globalConfig.defaultVoice?.testing.guildIds ?? []),
      ...[...guildConfigs.values()]
        .filter((config) => config.voice?.enabled === true && config.voice.testing.enabled)
        .flatMap((config) => config.voice?.testing.guildIds ?? []),
    ])];
    if (profile === "2b" && globalConfig.defaultVoice?.enabled === true && globalConfig.defaultVoice.testing.enabled && voiceTestGuildIds.length > 0) {
      const accessibleGuildIds = voiceTestGuildIds.filter((guildId) => client.guilds.cache.has(guildId));
      const skippedGuildIds = voiceTestGuildIds.filter((guildId) => !client.guilds.cache.has(guildId));
      if (accessibleGuildIds.length > 0) {
        const voiceCommandCount = await registerGuildSlashCommands({
          token: globalConfig.discordToken,
          clientId: botUser.id,
          guildIds: accessibleGuildIds,
          commands: [voiceTestCommandDefinition.toJSON()],
        });
        log.info("voice test slash command registered", { guilds: accessibleGuildIds.length, count: voiceCommandCount });
      }
      if (skippedGuildIds.length > 0) {
        log.warn("voice test slash command skipped inaccessible guilds", { guildIds: skippedGuildIds });
      }
    }
  } catch (err) {
    log.error("failed to register slash commands", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

registerInteractionRuntime({
  client,
  db,
  scheduler,
  getGlobalConfig: () => globalConfig,
  getGuildConfig,
  vpnClient,
  vpnSessionStore,
  vpnEnabled,
  startTime,
  log,
  voiceRuntime,
  isAcceptingEvents: () => acceptingDiscordMessages,
  trackTask: (task) => {
    void backgroundTasks.track(task);
  },
});

// --- 17. Build resolvers from a Discord guild ---
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
  const stored = dashboardManagementRuntime.userName(userId);
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
function mapGuildEmojis(guild: Guild): EmojiEntry[] {
  return guild.emojis.cache.map((e) => ({
    name: e.name,
    id: e.id,
    animated: e.animated,
  }));
}

function refreshEmojiCache(guild: Guild): void {
  if (!emojiCache.isStale(guild.id, EMOJI_TTL_MS)) return;
  emojiCache.set(guild.id, mapGuildEmojis(guild));
}

async function fetchEmojiCache(guild: Guild): Promise<EmojiEntry[]> {
  await guild.emojis.fetch();
  const emojis = mapGuildEmojis(guild);
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
    .filter((profile) => Object.values(profile.axes).some((value) => value !== 0)
      || profile.notes.length > 0
      || profile.boundaries.length > 0
      || profile.openLoops.length > 0
      || profile.recent.length > 0)
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
  visibleUserIds: string[];
  resolveUserLabel: (userId: string) => string;
  contactContext?: string;
  mode: RelationshipContextRunMode;
  notable?: RelationshipContextProfile[];
}): string {
  const config = getRelationshipConfig(input.guildConfig);
  if (!config.enabled || !config.promptInjection) return "";
  if (input.mode === "private-life") {
    const notable = input.notable ?? [];
    return renderNotableRelationshipsContext({
      full: notable.slice(0, 3),
      compact: notable.slice(3, 13),
      template: promptBundle.runtime.relationships.context,
    });
  }
  const currentUserId = input.latestUserMessage.authorId;
  const visible = input.visibleUserIds
    .filter((userId) => userId !== currentUserId)
    .slice(0, 3)
    .map((userId): RelationshipContextProfile => ({
      profile: getRelationshipProfile(db, userId),
      label: input.resolveUserLabel(userId),
      reason: "recent-chat",
    }))
    .filter((entry) => Object.values(entry.profile.axes).some((value) => value !== 0) || entry.profile.notes.length > 0 || entry.profile.openLoops.length > 0);
  const used = new Set([currentUserId, ...visible.map((entry) => entry.profile.userId)]);
  const highScore = listRelationshipProfiles(db, 50)
    .filter((profile) => !used.has(profile.userId))
    .map((profile) => ({
      profile,
      score: Math.max(...Object.values(profile.axes).map((value) => Math.abs(value))),
    }))
    .filter((entry) => entry.score >= 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry): RelationshipContextProfile => ({
      profile: entry.profile,
      label: input.resolveUserLabel(entry.profile.userId),
      reason: "high-score",
    }));
  return renderRelationshipPromptContext({
    current: getRelationshipProfile(db, currentUserId),
    currentLabel: input.resolveUserLabel(currentUserId),
    computedContact: input.contactContext,
    others: [...visible, ...highScore].slice(0, 5),
    template: promptBundle.runtime.relationships.context,
    includeCurrent: input.mode !== "virtual" || !input.latestUserMessage.isBot,
  });
}

function blockToolsExcept(tools: AgentTool[], allowedName: string, passLabel: string): AgentTool[] {
  const allowedNames = new Set([allowedName]);
  return tools.map((tool) => allowedNames.has(tool.name)
    ? tool
    : {
        ...tool,
        execute: (_toolCallId: string, _params: unknown): Promise<AgentToolResult<unknown>> => Promise.resolve({
          content: [{
            type: "text",
            text: allowedName === ""
              ? `Blocked: ${passLabel} cannot use ${tool.name}. record_memory, record_relationship, and record_inner_threads are not available in this mode.`
              : `Blocked: ${passLabel} may only use ${allowedName}. Do not call ${tool.name} in this pass.`,
          }],
          details: { blocked: true, pass: passLabel, allowedTool: allowedName, tool: tool.name },
        }),
	      });
}

const maintenanceToolNames = new Set([
  "record_memory",
  "record_relationship",
  "record_inner_threads",
  "record_private_life_episode",
]);
const semanticMaintenanceCoordinator = new SemanticMaintenanceCoordinator();

function latestHumanIdentity(guildId: string, channelId: string): {
  userId: string;
  username: string;
} {
  const latestHuman = db.raw.prepare(
    `SELECT user_id, author_username
     FROM messages
     WHERE guild_id = ? AND channel_id = ? AND is_bot = 0
       AND is_synthetic = 0 AND is_prompt_only = 0
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(guildId, channelId) as { user_id: string; author_username: string } | null;
  return {
    userId: latestHuman?.user_id ?? client.user?.id ?? "",
    username: latestHuman?.author_username ?? client.user?.username ?? "bot",
  };
}

function toolsForMaintenancePass(
  visibleTools: AgentTool[] | undefined,
  maintenanceTools: AgentTool[],
  allowedWriteNames: MaintenanceWriteToolName | ReadonlySet<MaintenanceWriteToolName>,
  passLabel: string,
): AgentTool[] {
  const byName = new Map<string, AgentTool>();
  for (const tool of visibleTools ?? []) {
    if (!maintenanceToolNames.has(tool.name)) byName.set(tool.name, tool);
  }
  for (const tool of applyRuntimeToolPrompts(maintenanceTools, promptBundle.runtime)) {
    byName.set(tool.name, tool);
  }
  const allowedWriteLabel = typeof allowedWriteNames === "string"
    ? allowedWriteNames
    : [...allowedWriteNames].join(", ");
  return [...byName.values()].map((tool) => isToolAllowedInMaintenance(tool, allowedWriteNames)
    ? tool
    : {
        ...tool,
        execute: (_toolCallId: string, _params: unknown): Promise<AgentToolResult<unknown>> => Promise.resolve({
          content: [{
            type: "text",
            text: `Blocked: ${passLabel} may use read-only tools and ${allowedWriteLabel}, but ${tool.name} may change state.`,
          }],
          details: { blocked: true, pass: passLabel, allowedWriteTools: allowedWriteLabel, tool: tool.name },
        }),
      });
}

function promptLabMemoryDryRunTool(tool: AgentTool, dryRuns: Array<{ tool: string; args: unknown }> | undefined): AgentTool {
  if (dryRuns === undefined || tool.name !== "record_memory") return tool;
  return {
    ...tool,
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal): Promise<AgentToolResult<unknown>> => {
      dryRuns.push({ tool: tool.name, args: params });
      return tool.execute(toolCallId, params, signal);
    },
  };
}

function promptLabMaintenanceDryRunTools(
  tools: AgentTool[],
  allowedToolName: MaintenanceWriteToolName,
  dryRuns: Array<{ tool: string; args: unknown }> | undefined,
): AgentTool[] {
  if (dryRuns === undefined) return tools;
  return tools.map((tool) => tool.name === allowedToolName
    ? {
        ...tool,
        execute: async (toolCallId: string, params: unknown, signal?: AbortSignal): Promise<AgentToolResult<unknown>> => {
          dryRuns.push({ tool: tool.name, args: params });
          return await tool.execute(toolCallId, params, signal);
        },
      }
    : tool);
}

function createPostReplyMaintenanceTools(input: {
  guild: Guild;
  guildConfig: GuildConfig;
  memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0];
  currentUserId: string;
  currentUsername?: string;
  sourceMessageId: string;
  dryRun?: boolean;
  dryRuns?: Array<{ tool: string; args: unknown }>;
  /** Null requires each relationship signal to name its own target user. */
  relationshipUserId?: string | null;
  onRelationshipResult?: (result: RelationshipMutationResult, candidates: unknown[]) => void;
  sourceRequestId?: string;
}): AgentTool[] {
  const recordMemoryTool = createRecordMemoryTool({
    db,
    guildId: input.guild.id,
    currentUserId: input.currentUserId,
    currentUsername: input.currentUsername,
    sourceMessageId: input.sourceMessageId,
    dryRun: input.dryRun,
    recordMemoryDescription: runtimeToolDescription("record_memory", {}),
    resolveUsername: async (username) => {
      const cached = resolveKnownUsername(input.guild, username);
      if (cached !== undefined) return cached;
      try {
        await input.guild.members.fetch();
      } catch {
        // Cache-only fallback below handles missing permissions.
      }
      return resolveKnownUsername(input.guild, username);
    },
  });
  const relationshipsConfig = getRelationshipConfig(input.guildConfig);
  const recordRelationshipTool = createRecordRelationshipTool({
    db,
    config: relationshipsConfig,
    dryRun: input.dryRun,
    description: runtimeToolDescription("record_relationship", {}),
    scope: {
      guildId: input.memoryRequest.incomingMessage.guildId,
      channelId: input.memoryRequest.incomingMessage.channelId,
      ...(input.relationshipUserId === null
        ? {}
        : { userId: input.relationshipUserId ?? input.memoryRequest.incomingMessage.authorId }),
      sourceMessageId: input.memoryRequest.sourceMessageId,
    },
    onResult: (result, candidates) => input.onRelationshipResult?.(result, candidates),
  });
  const innerThreadTools = innerThreadsEnabled(input.guildConfig)
    ? [createRecordInnerThreadsTool({
        db,
        guildId: input.guild.id,
        channelId: input.memoryRequest.incomingMessage.channelId ?? "",
        requestId: input.sourceRequestId,
        description: runtimeToolDescription("record_inner_threads", {}) ?? "Privately maintain durable inner threads.",
        dryRun: input.dryRun,
      })]
    : [];
  // Visible turns receive blocked versions of these tools before maintenance
  // reuses them. Prompt the shared schemas here so both requests remain cache-identical.
  return applyRuntimeToolPrompts([
    promptLabMemoryDryRunTool(recordMemoryTool, input.dryRuns),
    recordRelationshipTool,
    ...innerThreadTools,
  ], promptBundle.runtime);
}

async function runMemoryPostReplyExtraction(input: {
  guildConfig: GuildConfig;
  memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0];
  guild: Guild;
  channel: unknown;
  sourceRequestId: string;
  source?: string;
  passKind?: "post_reply" | "ambient";
  currentUserId: string;
  currentUsername?: string;
  dryRun?: boolean;
  dryRuns?: Array<{ tool: string; args: unknown }>;
  maintenanceTools?: AgentTool[];
}): Promise<{ requestId?: string; enabled: boolean; ran: boolean; error?: string }> {
  if (!input.guildConfig.memoryExtraction.postReply || !hasMaintenanceMaterial(input.memoryRequest)) {
    return { enabled: input.guildConfig.memoryExtraction.postReply, ran: false };
  }
  const guildId = input.memoryRequest.incomingMessage.guildId ?? input.guild.id;
  const channelId = input.memoryRequest.incomingMessage.channelId ?? "";
  const sourceMessageId = input.memoryRequest.sourceMessageId ?? promptLabSyntheticId();
  const memoryLog = new RequestLog(guildId, channelId, requestLogStore);
  memoryLog.setAuthor(input.memoryRequest.incomingMessage.authorUsername);
  memoryLog.setTriggerContext({
    ...dashboardTriggerLocation(input.guild, input.channel),
    messageId: sourceMessageId,
    authorUsername: input.memoryRequest.incomingMessage.authorUsername,
    content: input.memoryRequest.userMessage,
    translatedContent: input.memoryRequest.userMessage,
  });
  memoryLog.setTrigger({
    type: "background_memory_extraction",
    sourceRequestId: input.sourceRequestId,
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.dryRun === true ? { dryRun: true } : {}),
  });
  memoryLog.setAgentRan(true);
  requestLogStore.incrementActive();
  const maintenanceTools = input.maintenanceTools ?? createPostReplyMaintenanceTools({
    guild: input.guild,
    guildConfig: input.guildConfig,
    memoryRequest: input.memoryRequest,
    currentUserId: input.currentUserId,
    currentUsername: input.currentUsername,
    sourceMessageId,
    dryRun: input.dryRun,
    dryRuns: input.dryRuns,
  });
  const visibleUserMemoryContext = buildVisibleUserMemoryContext({
    db,
    guildId,
    currentUserId: input.currentUserId,
    visibleUserIds: input.memoryRequest.context.visibleUserIds ?? [],
    resolveUserId: (userId) => resolvePromptUsername(input.guild, userId),
    contextInstruction: promptBundle.runtime.memoryContextTemplates["other-visible-users"],
  });
  try {
    await runSilentMemoryAgentPass({
      globalConfig,
      guildConfig: input.guildConfig,
      context: input.memoryRequest.context,
      systemPrompt: promptBundle.systemPrompt,
      personaPrompt: promptBundle.corePrompt,
      runtimePrompts: promptBundle.runtime,
      incomingMessage: input.memoryRequest.incomingMessage,
      userContent: input.memoryRequest.userMessage,
      assistantReply: input.memoryRequest.assistantReply,
      visibleReplySent: input.memoryRequest.visibleReplySent,
      passKind: input.passKind,
      visibleUserMemoryContext,
      tools: toolsForMaintenancePass(
        input.memoryRequest.availableTools,
        maintenanceTools,
        "record_memory",
        "silent memory pass",
      ),
      transcript: input.memoryRequest.maintenanceTranscript,
      promptContext: input.memoryRequest.promptContext,
      requestLog: memoryLog,
      log: log.child({ guildId, channelId, requestId: memoryLog.requestId, component: "memory-pass" }),
    });
    if (input.dryRun !== true) {
      const checkpointMarked = markMemoryExtractionCheckpointAtMessage(db, {
        guildId,
        channelId,
        messageId: sourceMessageId,
      });
      if (!checkpointMarked) {
        markMemoryExtractionCheckpointFromContext({
          guildId,
          channelId,
          contextMessageIds: input.memoryRequest.context.contextMessageIds,
          fallbackMessageId: input.memoryRequest.sourceMessageId,
        });
      }
    }
    return { requestId: memoryLog.requestId, enabled: true, ran: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    memoryLog.setError(error);
    if (input.dryRun === true) return { requestId: memoryLog.requestId, enabled: true, ran: true, error };
    throw err;
  } finally {
    memoryLog.emit(log);
    requestLogStore.decrementActive();
  }
}

async function runRelationshipPostReplyExtraction(input: {
  guildConfig: GuildConfig;
  memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0];
  requestLog?: RequestLog;
  guild?: Guild;
  channel?: unknown;
  source?: string;
  sourceRequestId?: string;
  dryRun?: boolean;
  currentUserId: string;
  currentUsername?: string;
  dryRuns?: Array<{ tool: string; args: unknown }>;
  onResult?: (result: RelationshipMutationResult, candidates: unknown[]) => void;
  maintenanceTools?: AgentTool[];
  additionalDecisionInstruction?: string;
}): Promise<void> {
  const config = getRelationshipConfig(input.guildConfig);
  if (!config.enabled || !hasMaintenanceMaterial(input.memoryRequest)) return;
  const guildId = input.memoryRequest.incomingMessage.guildId ?? "";
  const channelId = input.memoryRequest.incomingMessage.channelId ?? "";
  const relationshipsLog = input.requestLog ?? new RequestLog(guildId, channelId, requestLogStore);
  if (input.requestLog === undefined) {
    relationshipsLog.setAuthor(input.memoryRequest.incomingMessage.authorUsername);
    relationshipsLog.setTrigger({
      type: "relationships_extraction",
      source: input.source ?? "post_reply",
      ...(input.sourceRequestId !== undefined ? { sourceRequestId: input.sourceRequestId } : {}),
      ...(input.dryRun === true ? { dryRun: true } : {}),
    });
    relationshipsLog.setTriggerContext({
      ...(input.guild !== undefined && input.channel !== undefined ? dashboardTriggerLocation(input.guild, input.channel) : {}),
      messageId: input.memoryRequest.sourceMessageId,
      authorUsername: input.memoryRequest.incomingMessage.authorUsername,
      content: input.memoryRequest.userMessage,
      translatedContent: input.memoryRequest.userMessage,
    });
    relationshipsLog.setAgentRan(true);
    requestLogStore.incrementActive();
  }
  const maintenanceTools = input.maintenanceTools ?? (input.guild === undefined
    ? [createRecordRelationshipTool({
        db,
        config,
        dryRun: input.dryRun,
        description: runtimeToolDescription("record_relationship", {}),
        scope: {
          guildId: input.memoryRequest.incomingMessage.guildId,
          channelId: input.memoryRequest.incomingMessage.channelId,
          userId: input.memoryRequest.incomingMessage.authorId,
          sourceMessageId: input.memoryRequest.sourceMessageId,
        },
        onResult: (result, candidates) => input.onResult?.(result, candidates),
      })]
    : createPostReplyMaintenanceTools({
        guild: input.guild,
        guildConfig: input.guildConfig,
        memoryRequest: input.memoryRequest,
        currentUserId: input.currentUserId,
        currentUsername: input.currentUsername,
        sourceMessageId: input.memoryRequest.sourceMessageId ?? promptLabSyntheticId(),
        dryRun: input.dryRun,
        dryRuns: input.dryRuns,
        onRelationshipResult: input.onResult,
      }));
  try {
    const executionMode = runtimeContextTemplate(
      "relationship-maintenance-execution-mode",
      { maxToolCalls: config.maxToolCalls },
      [
        "## Execution Mode: Relationship Maintenance",
        "Private relationship maintenance is active. Read-only tools are optionally available when they would materially reduce uncertainty; record_relationship is the only state-changing tool available, and relevant relationship state is already supplied.",
        "Submit every useful relationship signal as one complete record_relationship signal list. Retry only if the tool reports an error, and retry only rejected signals.",
      ].join("\n"),
    );
    await runSilentToolAgentPass({
      globalConfig,
      guildConfig: input.guildConfig,
      context: input.memoryRequest.context,
      systemPrompt: promptBundle.systemPrompt,
      personaPrompt: promptBundle.corePrompt,
      runtimePrompts: promptBundle.runtime,
      incomingMessage: input.memoryRequest.incomingMessage,
      userContent: input.memoryRequest.userMessage,
      assistantReply: input.memoryRequest.assistantReply,
      visibleReplySent: input.memoryRequest.visibleReplySent,
      tools: toolsForMaintenancePass(input.memoryRequest.availableTools, maintenanceTools, "record_relationship", "silent relationships pass"),
      runtimeInstruction: promptBundle.runtime.reply,
      controlMessage: [
        executionMode,
        "## Post-Reply Relationship Consideration",
        runtimeContextTemplate(
          "relationship-pass-decision",
          {},
          "Decide silently whether relationships should be updated. Use record_relationship only if an update is useful.",
        ),
        input.additionalDecisionInstruction ?? "",
      ].filter((part) => part !== "").join("\n\n"),
      modelProfile: config.modelProfile,
      maxToolCalls: config.maxToolCalls,
      terminateAfterSuccessfulToolRoundNames: ["record_relationship"],
      transcript: input.memoryRequest.maintenanceTranscript,
      promptContext: input.memoryRequest.promptContext,
      requestLog: relationshipsLog,
      log: log.child({ guildId, channelId, requestId: relationshipsLog.requestId, component: "relationships-pass" }),
    });
  } catch (err) {
    relationshipsLog.setError(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    if (input.requestLog === undefined) {
      relationshipsLog.emit(log);
      requestLogStore.decrementActive();
    }
  }
}

async function runInnerThreadPostReplyExtraction(input: {
  guildConfig: GuildConfig;
  memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0];
  guild: Guild;
  channel: unknown;
  sourceRequestId: string;
  dryRun?: boolean;
  maintenanceTools?: AgentTool[];
}): Promise<void> {
  if (!innerThreadsEnabled(input.guildConfig) || !hasMaintenanceMaterial(input.memoryRequest)) return;
  const guildId = input.memoryRequest.incomingMessage.guildId ?? input.guild.id;
  const channelId = input.memoryRequest.incomingMessage.channelId ?? "";
  const sourceMessageId = input.memoryRequest.sourceMessageId ?? promptLabSyntheticId();
  const requestLog = new RequestLog(guildId, channelId, requestLogStore);
  requestLog.setAuthor(input.memoryRequest.incomingMessage.authorUsername);
  requestLog.setTrigger({
    type: "inner_thread_maintenance",
    sourceRequestId: input.sourceRequestId,
    ...(input.dryRun === true ? { dryRun: true } : {}),
  });
  requestLog.setTriggerContext({
    ...dashboardTriggerLocation(input.guild, input.channel),
    messageId: sourceMessageId,
    authorUsername: input.memoryRequest.incomingMessage.authorUsername,
    content: input.memoryRequest.userMessage,
    translatedContent: input.memoryRequest.userMessage,
  });
  requestLog.setAgentRan(true);
  requestLogStore.incrementActive();
  const maintenanceTools = input.maintenanceTools ?? createPostReplyMaintenanceTools({
    guild: input.guild,
    guildConfig: input.guildConfig,
    memoryRequest: input.memoryRequest,
    currentUserId: input.memoryRequest.incomingMessage.authorId,
    currentUsername: input.memoryRequest.incomingMessage.authorUsername,
    sourceMessageId,
    sourceRequestId: input.sourceRequestId,
    dryRun: input.dryRun,
  });
  try {
    await runSilentToolAgentPass({
      globalConfig,
      guildConfig: input.guildConfig,
      context: input.memoryRequest.context,
      systemPrompt: promptBundle.systemPrompt,
      personaPrompt: promptBundle.corePrompt,
      runtimePrompts: promptBundle.runtime,
      incomingMessage: input.memoryRequest.incomingMessage,
      userContent: input.memoryRequest.userMessage,
      assistantReply: input.memoryRequest.assistantReply,
      visibleReplySent: input.memoryRequest.visibleReplySent,
      tools: toolsForMaintenancePass(
        input.memoryRequest.availableTools,
        maintenanceTools,
        "record_inner_threads",
        "silent inner-thread pass",
      ),
      runtimeInstruction: promptBundle.runtime.reply,
      controlMessage: [
        runtimeContextTemplate(
          "inner-thread-maintenance-execution-mode",
          {},
          "Private inner-thread maintenance is active. Read-only tools are available for material uncertainty; record_inner_threads is the only state-changing tool available.",
        ),
        runtimeContextTemplate(
          "inner-thread-pass-decision",
          {},
          "Decide silently whether durable inner threads should change.",
        ),
      ].filter((part) => part !== "").join("\n\n"),
      modelProfile: input.guildConfig.innerThreads?.modelProfile ?? input.guildConfig.modelProfile,
      maxToolCalls: 3,
      terminateAfterSuccessfulToolRoundNames: ["record_inner_threads"],
      transcript: input.memoryRequest.maintenanceTranscript,
      promptContext: input.memoryRequest.promptContext,
      requestLog,
      log: log.child({ guildId, channelId, requestId: requestLog.requestId, component: "inner-thread-pass" }),
    });
  } catch (error) {
    requestLog.setError(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    requestLog.emit(log);
    requestLogStore.decrementActive();
  }
}

async function runPrivateLifeMaintenance(input: {
  episodeId: string;
  guild: Guild;
  channel: SendableGuildChannel;
  guildConfig: GuildConfig;
  request: MemoryExtractionRequest;
  sourceRequestId: string;
  dryRun: boolean;
  dryRuns: Array<{ tool: string; args: unknown }>;
}): Promise<void> {
  const privateMaintenanceTools = (allowedToolName: MaintenanceWriteToolName): AgentTool[] =>
    promptLabMaintenanceDryRunTools(
      createPrivateLifeMaintenanceTools({
        episodeId: input.episodeId,
        guild: input.guild,
        guildConfig: input.guildConfig,
        memoryRequest: input.request,
        sourceRequestId: input.sourceRequestId,
        dryRun: input.dryRun,
      }),
      allowedToolName,
      input.dryRun ? input.dryRuns : undefined,
    );

  await runPrivateLifeEpisodeSummary({
    ...input,
    maintenanceTools: privateMaintenanceTools("record_private_life_episode"),
  });

  const latestHuman = latestHumanIdentity(input.guild.id, input.channel.id);
  await runMemoryPostReplyExtraction({
    guildConfig: input.guildConfig,
    memoryRequest: input.request,
    guild: input.guild,
    channel: input.channel,
    sourceRequestId: input.sourceRequestId,
    source: "private_life",
    currentUserId: latestHuman.userId,
    currentUsername: latestHuman.username,
    dryRun: input.dryRun,
    maintenanceTools: privateMaintenanceTools("record_memory"),
  });
  await runRelationshipPostReplyExtraction({
    guildConfig: input.guildConfig,
    memoryRequest: input.request,
    guild: input.guild,
    channel: input.channel,
    sourceRequestId: input.sourceRequestId,
    source: "private_life",
    currentUserId: latestHuman.userId,
    currentUsername: latestHuman.username,
    dryRun: input.dryRun,
    maintenanceTools: privateMaintenanceTools("record_relationship"),
    additionalDecisionInstruction: [
      "## Private-Life Relationship Scope",
      "No human speaker caused this private-life turn. Do not default to the synthetic author or latest active user. Every relationship signal must name a grounded known Discord user ID; otherwise do nothing.",
    ].join("\n"),
  });
  await runInnerThreadPostReplyExtraction({
    guildConfig: input.guildConfig,
    memoryRequest: input.request,
    guild: input.guild,
    channel: input.channel,
    sourceRequestId: input.sourceRequestId,
    dryRun: input.dryRun,
    maintenanceTools: privateMaintenanceTools("record_inner_threads"),
  });
}

async function runPrivateLifeEpisodeSummary(input: {
  episodeId: string;
  guild: Guild;
  channel: SendableGuildChannel;
  guildConfig: GuildConfig;
  request: MemoryExtractionRequest;
  sourceRequestId: string;
  dryRun: boolean;
  maintenanceTools: AgentTool[];
}): Promise<void> {
  const guildId = input.guild.id;
  const channelId = input.channel.id;
  const maintenanceLog = new RequestLog(guildId, channelId, requestLogStore);
  maintenanceLog.setAuthor("private-life-summary");
  maintenanceLog.setTrigger({
    type: "private_life_summary",
    sourceRequestId: input.sourceRequestId,
    episodeId: input.episodeId,
    ...(input.dryRun ? { dryRun: true } : {}),
  });
  maintenanceLog.setTriggerContext({
    ...dashboardTriggerLocation(input.guild, input.channel),
    messageId: input.episodeId,
    authorUsername: "private-life",
    content: input.request.userMessage,
    translatedContent: input.request.userMessage,
  });
  maintenanceLog.setAgentRan(true);
  requestLogStore.incrementActive();
  try {
    await runSilentToolAgentPass({
      globalConfig,
      guildConfig: input.guildConfig,
      context: input.request.context,
      systemPrompt: promptBundle.systemPrompt,
      personaPrompt: promptBundle.corePrompt,
      runtimePrompts: promptBundle.runtime,
      incomingMessage: input.request.incomingMessage,
      userContent: input.request.userMessage,
      assistantReply: input.request.assistantReply,
      visibleReplySent: input.request.visibleReplySent,
      tools: toolsForMaintenancePass(
        input.request.availableTools,
        input.maintenanceTools,
        "record_private_life_episode",
        "private-life episode summary pass",
      ),
      runtimeInstruction: [promptBundle.runtime.reply, promptBundle.runtime.privateLife ?? ""]
        .filter((part) => part.trim() !== "")
        .join("\n\n"),
      controlMessage: runtimeContextTemplate("private-life-maintenance"),
      modelProfile: globalConfig.privateLife?.maintenance.modelProfile ?? input.guildConfig.modelProfile,
      maxToolCalls: 3,
      terminateAfterSuccessfulToolRoundNames: ["record_private_life_episode"],
      transcript: input.request.maintenanceTranscript,
      promptContext: input.request.promptContext,
      requestLog: maintenanceLog,
      log: log.child({ component: "private-life-summary", episodeId: input.episodeId }),
    });
  } catch (error) {
    maintenanceLog.setError(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    maintenanceLog.emit(log);
    requestLogStore.decrementActive();
  }
}

function createPrivateLifeMaintenanceTools(input: {
  episodeId: string;
  guild: Guild;
  guildConfig: GuildConfig;
  memoryRequest: MemoryExtractionRequest;
  sourceRequestId: string;
  dryRun: boolean;
}): AgentTool[] {
  const latestHuman = latestHumanIdentity(
    input.guild.id,
    input.memoryRequest.incomingMessage.channelId ?? "",
  );
  return applyRuntimeToolPrompts([
    ...createPostReplyMaintenanceTools({
      guild: input.guild,
      guildConfig: input.guildConfig,
      memoryRequest: input.memoryRequest,
      currentUserId: latestHuman.userId,
      currentUsername: latestHuman.username,
      sourceMessageId: input.episodeId,
      sourceRequestId: input.sourceRequestId,
      dryRun: input.dryRun,
      relationshipUserId: null,
    }),
    createPrivateLifeSummaryTool({
      db,
      episodeId: input.episodeId,
      description: runtimeToolDescription("record_private_life_episode")
        ?? "Record one compact private-life episode label.",
      dryRun: input.dryRun,
    }),
  ], promptBundle.runtime);
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
      replyQuoteChars: guildConfig.trim.replyQuoteChars,
      triggerMessageIds: historyOptions.triggerMessageIds,
      displayNamesByUserId,
    },
    replyFallbackDeps,
  );
  const visibleUserIds = [...new Set([
    ...historyVisibleUserIds,
    ...(historyOptions.additionalVisibleUserIds ?? []),
  ])];

  const notable = relationshipsMode === "private-life"
    ? notableRelationshipProfiles().map((entry) => ({
        ...entry,
        label: (() => {
          const member = guild.members.cache.get(entry.profile.userId);
          const username = member?.user.username ?? entry.profile.userId;
          const displayName = member?.displayName;
          return displayName !== undefined && displayName !== username
            ? `@${username} (${displayName}) / ${entry.profile.userId}`
            : `@${username} / ${entry.profile.userId}`;
        })(),
      }))
    : [];
  const memories = relationshipsMode === "private-life"
    ? buildPrivateLifeMemoryContext({
        db,
        guildId,
        notableUserIds: notable.slice(0, 3).map((entry) => entry.profile.userId),
        limit: guildConfig.memoryContext?.maxRows ?? 80,
        resolveUserId: (userId) => resolvePromptUsername(guild, userId),
        contextInstruction: promptBundle.runtime.memoryContextTemplates.current,
      })
    : buildMemoryContext({
        db,
        guildId,
        currentUserId: latestUserMessage.authorId,
        visibleUserIds,
        limit: guildConfig.memoryContext?.maxRows ?? 80,
        resolveUserId: (userId) => resolvePromptUsername(guild, userId),
        contextInstruction: promptBundle.runtime.memoryContextTemplates.current,
      });

  const pendingSchedules = listUpcomingForContext(db, guildId, channelId);
  const oneOffCount = pendingSchedules.filter((s) => s.type === "one_off").length;
  const cronCount = pendingSchedules.length - oneOffCount;
  const upcomingSchedules = runtimeContextTemplate("upcoming-schedules", {
    total: pendingSchedules.length,
    oneOffCount,
    cronCount,
  }, `Pending schedules in this channel: ${pendingSchedules.length}.`);
  const liveChannel = await client.channels.fetch(channelId).catch(() => guild.channels.cache.get(channelId) ?? null);
  const currentChannelName = channelDisplayName(liveChannel);
  const discordContext = buildDiscordContext({
    client,
    currentGuildId: guildId,
    currentGuildName: guild.name,
    currentChannelId: channelId,
    currentChannelName,
    navigationTemplate: runtimeContextTemplate("discord-navigation", {}, "Guild shortlist for navigation context only."),
    popularChannels: client.user?.id === undefined ? [] : listBotChannelUsage(db, client.user.id, 25),
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
  const contactContext = client.user?.id !== undefined
    ? buildComputedContactContextForUser({
      db,
      botUserId: client.user.id,
      botAddressAliasesForGuild: (contactGuildId) => [
        client.user?.username ?? "",
        ...getGuildConfig(contactGuildId).triggers.keywords,
      ],
      userId: latestUserMessage.authorId,
      currentChannelId: channelId,
      beforeCreatedAt: (currentTurnBoundary ?? { timestamp: latestUserMessage.timestamp }).timestamp,
      beforeMessageId: (currentTurnBoundary ?? { messageId: latestUserMessage.id }).messageId,
    })?.rendered.replace(/^Known contact:\s*/u, "")
    : undefined;
  const relationshipsContext = buildRelationshipPromptContext({
    guildConfig,
    latestUserMessage,
    visibleUserIds,
    resolveUserLabel: (userId) => {
      const member = guild.members.cache.get(userId);
      const username = member?.user.username ?? userId;
      const displayName = member?.displayName;
      return displayName !== undefined && displayName !== username
        ? `@${username} (${displayName}) / ${userId}`
        : `@${username} / ${userId}`;
    },
    contactContext,
    mode: relationshipsMode,
    notable,
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
      archivedAt: liveChannel.archived === true ? Date.now() : null,
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
        archivedAt: cached.archived === true ? Date.now() : null,
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
        const trimmed = trimMessages(parentMessages, guildConfig.trim.messageCharLimit);

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
            lines.push(formatMessageLine({
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
  const voicePresenceContext = liveChannel !== null
    && liveChannel.type !== ChannelType.GuildVoice
    && liveChannel.type !== ChannelType.GuildStageVoice
    && liveChannel.isTextBased()
    ? voiceRuntime.presenceContext()
    : "";

  const assembled = assembleContext({
      toolInstructions: "",
      instructions: guildConfig.instructions,
      emojis: emojiContext,
      members: displayNameContext,
      memories,
      discordContext,
      upcomingSchedules,
      threadsInChat,
      threadMetadata,
      parentPreContext,
      olderHistory: olderText,
      newerHistory: newerText,
      currentContext: [
        currentContext,
        relationshipsContext,
        voicePresenceContext,
      ]
        .filter((part) => part !== "")
        .join("\n\n"),
      personaMode: personaModeRuntime.renderPromptContext(guildId),
      responseInstruction: "",
      userMessage,
  });
  assembled.visibleUserIds = visibleUserIds;
  const innerThreadsText = innerThreadsEnabled(guildConfig)
    ? buildInnerThreadsContext({
        db,
        guildId,
        visibleUserIds,
        resolveUserId: (userId) => guild.members.cache.get(userId)?.user.username
          ?? client.users.cache.get(userId)?.username,
      })
    : "";
  if (innerThreadsText !== "") {
    const memoryIndex = assembled.sections.findIndex((section) => section.label === "Memories");
    const insertAt = memoryIndex === -1 ? 0 : memoryIndex + 1;
    assembled.sections = [
      ...assembled.sections.slice(0, insertAt),
      { label: "Inner Threads", text: innerThreadsText, cached: false, role: "developer" as const },
      ...assembled.sections.slice(insertAt),
    ];
  }
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

const ambientMemoryPasses = new Set<string>();
const MEMORY_MAINTENANCE_BATCH_SIZE = 12;

function collectHumanUserIds(messages: HistoryMessage[]): string[] {
  const recency = new Map<string, true>();
  for (const message of messages) {
    if (message.isBot) continue;
    recency.delete(message.authorId);
    recency.set(message.authorId, true);
  }
  return [...recency.keys()].reverse();
}

function formatAmbientMemoryHistory(messages: HistoryMessage[], timezone: string): string {
  const dateEntries = insertDateStamps(messages, timezone);
  const lines: string[] = [OLDER_LEGEND];
  for (const entry of dateEntries) {
    if (entry.type === "date") {
      lines.push(entry.text);
      continue;
    }
    const item = messages[entry.index];
    if (item === undefined) continue;
    lines.push(formatMessageLine({
      message: item,
      reply: null,
      includeMessageIds: true,
      includeDisplayNames: true,
    }));
  }
  return `## Ambient Chat History\n${lines.join("\n")}`;
}

async function maybeRunAmbientMemoryExtraction(message: Message, guildConfig: GuildConfig): Promise<void> {
  if (!guildConfig.memoryExtraction.ambient.enabled) return;
  if (message.guild === null || message.guildId === null) return;
  if (client.user === null) return;

  const guildId = message.guildId;
  const channelId = message.channelId;
  const key = `${guildId}:${channelId}`;
  if (ambientMemoryPasses.has(key)) return;

  const checkpoint = getMemoryExtractionCheckpoint(db, guildId, channelId);
  const now = Date.now();
  const minIntervalMs = guildConfig.memoryExtraction.ambient.minIntervalSeconds * 1000;
  if (checkpoint !== null && now - checkpoint.lastRunAt < minIntervalMs) return;

  const pendingCount = countMessagesSinceMemoryExtraction(db, {
    guildId,
    channelId,
    checkpoint,
  });
  if (pendingCount < guildConfig.memoryExtraction.ambient.everyMessages) return;

  const batch = getMessagesSinceMemoryExtraction(db, {
    guildId,
    channelId,
    checkpoint,
    limit: guildConfig.memoryExtraction.ambient.maxBatchMessages,
  });
  const lastMessage = batch[batch.length - 1];
  if (lastMessage === undefined) return;

  ambientMemoryPasses.add(key);
  try {
    const guild = message.guild;
    const memoryLog = new RequestLog(guildId, channelId, requestLogStore);
    memoryLog.setAuthor("ambient");
    memoryLog.setTriggerContext({
      ...dashboardTriggerLocation(guild, message.channel),
      messageId: message.id,
      authorUsername: message.author.username,
      content: message.content,
    });
    memoryLog.setTrigger({ type: "background_memory_extraction", mode: "ambient" });
    memoryLog.setAgentRan(true);
    requestLogStore.incrementActive();

    const visibleUserIds = collectHumanUserIds(batch);
    const visibleUserMemoryContext = buildVisibleUserMemoryContext({
      db,
      guildId,
      currentUserId: lastMessage.authorId,
      visibleUserIds,
      resolveUserId: (userId) => resolvePromptUsername(guild, userId),
      contextInstruction: promptBundle.runtime.memoryContextTemplates["other-visible-users"],
    });
    const currentUserMemories = buildMemoryContext({
      db,
      guildId,
      currentUserId: lastMessage.authorId,
      limit: guildConfig.memoryContext?.maxRows ?? 80,
      resolveUserId: (userId) => resolvePromptUsername(guild, userId),
      contextInstruction: promptBundle.runtime.memoryContextTemplates.current,
    });
    const maintenance = buildMemoryMaintenanceContext({
      db,
      guildId,
      afterId: checkpoint?.maintenanceCursorId ?? 0,
      limit: MEMORY_MAINTENANCE_BATCH_SIZE,
      resolveUserId: (userId) => client.users.cache.get(userId)?.username,
    });
    const context: AssembledContext = {
      sections: [
        ...(currentUserMemories !== ""
          ? [{ label: "Memories", role: "developer" as const, cached: false, text: `## Memory\n${currentUserMemories}` }]
          : []),
        ...(maintenance.text !== ""
          ? [{ label: "Memory Maintenance Candidates", role: "developer" as const, cached: false, text: maintenance.text }]
          : []),
        {
          label: "Chat History — Newer",
          role: "developer",
          cached: false,
          text: formatAmbientMemoryHistory(batch, guildConfig.timezone),
        },
      ],
      userMessage: "",
      contextMessageIds: batch.map((item) => item.id),
      visibleUserIds,
    };
    const createAmbientRecordMemoryTool = (dryRun: boolean): AgentTool => {
      const unprompted = createRecordMemoryTool({
        db,
        guildId,
        currentUserId: lastMessage.authorId,
        currentUsername: lastMessage.author,
        sourceMessageId: lastMessage.id,
        dryRun,
        recordMemoryDescription: runtimeToolDescription("record_memory", {}),
        resolveUsername: async (username) => {
          const cached = resolveKnownUsername(guild, username);
          if (cached !== undefined) return cached;
          try {
            await guild.members.fetch();
          } catch {
            // Cache-only fallback below handles missing permissions.
          }
          return resolveKnownUsername(guild, username);
        },
      });
      return applyRuntimeToolPrompts([unprompted], promptBundle.runtime)[0] ?? unprompted;
    };
    const validationTool = createAmbientRecordMemoryTool(true);
    const commitTool = createAmbientRecordMemoryTool(false);
    const stagedCalls: StagedMaintenanceCall[] = [];
    const stagedTool = stageMaintenanceTools(
      [validationTool],
      stagedCalls,
      new Set(["record_memory"]),
    )[0];
    if (stagedTool === undefined) throw new Error("Ambient memory staging tool is unavailable.");
    const ticket = semanticMaintenanceCoordinator.reserve();
    const incoming: IncomingMessage = {
      content: "",
      guildId,
      guildName: guild.name,
      channelId,
      channelName: channelDisplayName(message.channel),
      authorId: lastMessage.authorId,
      authorUsername: lastMessage.author,
      authorDisplayName: guild.members.cache.get(lastMessage.authorId)?.displayName,
      authorIsBot: false,
      botUserId: client.user.id,
      mentionedUserIds: [],
      translatedContent: "",
      messageId: lastMessage.id,
    };

    try {
      await runSilentMemoryAgentPass({
        globalConfig,
        guildConfig,
        context,
        systemPrompt: promptBundle.systemPrompt,
        personaPrompt: promptBundle.corePrompt,
        runtimePrompts: promptBundle.runtime,
        incomingMessage: incoming,
        userContent: "",
        assistantReply: "",
        visibleReplySent: false,
        passKind: "ambient",
        visibleUserMemoryContext,
        tools: [stagedTool],
        requestLog: memoryLog,
        log: log.child({ guildId, channelId, requestId: memoryLog.requestId }),
      });
      await ticket.commit(async () => {
        await commitStagedMaintenanceCalls({ calls: stagedCalls, tools: [commitTool] });
        markMemoryExtractionCheckpoint(db, {
          guildId,
          channelId,
          lastMessageId: lastMessage.id,
          lastMessageCreatedAt: lastMessage.timestamp,
          maintenanceCursorId: maintenance.nextCursorId,
        });
      });
    } catch (err) {
      ticket.skip();
      memoryLog.setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      memoryLog.emit(log);
      requestLogStore.decrementActive();
    }
  } catch (err) {
    log.warn("ambient memory extraction failed", {
      guildId,
      channelId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    ambientMemoryPasses.delete(key);
  }
}

function markMemoryExtractionCheckpointFromContext(input: {
  guildId: string;
  channelId: string;
  contextMessageIds: readonly string[] | undefined;
  fallbackMessageId?: string;
  maintenanceCursorId?: number;
}): boolean {
  const ids = [
    ...(input.contextMessageIds ?? []),
    ...(input.fallbackMessageId !== undefined ? [input.fallbackMessageId] : []),
  ];
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const id = ids[i];
    if (id === undefined) continue;
    if (markMemoryExtractionCheckpointAtMessage(db, {
      guildId: input.guildId,
      channelId: input.channelId,
      messageId: id,
      maintenanceCursorId: input.maintenanceCursorId,
    })) {
      return true;
    }
  }
  return false;
}

// --- 20. Build agent tools for a message context ---
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
          channels.set(channel.id, channel as ThreadChannel);
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
              isVoiceConnected: voiceRuntime.snapshot().channelId === channel.id,
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
  });

  const discordTimeoutTools = createDiscordTimeoutTools({
    guildId,
    botUserId: client.user?.id ?? "",
    guildOwnerId: guild.ownerId,
    isRequesterAdmin: async () => {
      const requesterId = effectiveCurrentRequest?.requesterId;
      if (requesterId === undefined || requesterId === "scheduler") return false;
      if (guildConfig.adminUserIds.includes(requesterId)) return true;
      let requester = guild.members.cache.get(requesterId);
      if (requester === undefined) {
        try {
          requester = await guild.members.fetch(requesterId);
        } catch {
          return false;
        }
      }
      return requester.permissions.has(PermissionFlagsBits.Administrator);
    },
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
        description: runtimeToolDescription("list_inner_threads", {}) ?? "Privately inspect durable inner threads.",
        resolveUserId: (userId) => guild.members.cache.get(userId)?.user.username
          ?? client.users.cache.get(userId)?.username,
        resolveGuildId: (targetGuildId) => client.guilds.cache.get(targetGuildId)?.name,
      })]
    : [];

  const listChannelMessagesTool = createListChannelMessagesTool({
    guildId,
    timezone: guildConfig.timezone,
    fetchMessages: async (input) => {
      const channel = await fetchAccessibleGuildChannel(input.channelId);
      if (channel === null || !("messages" in channel)) return null;
      const messages = listChannelMessages(db, channel.guildId, channel.id, {
        limit: input.limit,
        ...(input.beforeMessageId !== undefined ? { beforeMessageId: input.beforeMessageId } : {}),
        ...(input.afterMessageId !== undefined ? { afterMessageId: input.afterMessageId } : {}),
        ...(input.aroundMessageId !== undefined ? { aroundMessageId: input.aroundMessageId } : {}),
      });
      return messages === null ? null : { messages };
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
  const assetToolDeps = {
    config: guildConfig.assetReading ?? { ...DEFAULT_ASSET_READING, videoPreviewTimesSeconds: [...DEFAULT_ASSET_READING.videoPreviewTimesSeconds] },
    elevenLabsApiKey: globalConfig.elevenLabsApiKey,
    getAsset: (id) => getAssetById(db, id),
    getStagedAsset: (ref) => {
      const staged = getStagedAsset(db, ref);
      return staged?.ownerGuildId === guildId ? staged : null;
    },
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
    extractVideoFrame: extractRemoteVideoFrame,
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
    ...(globalConfig.externalImages ?? DEFAULT_EXTERNAL_IMAGES),
  });

  const fetchUrlTool = createFetchUrlTool({
    maxPageImages: (globalConfig.externalImages ?? DEFAULT_EXTERNAL_IMAGES).maxPageImages,
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
        (name) => emojiCache.lookup(targetChannel.guildId, name),
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
    guildId,
    channelId,
    onDismiss: async (jobId) => {
      const staged = getStagedAssetForJob(db, jobId);
      if (staged === null) return;
      await unlink(staged.storagePath).catch(() => {});
      deleteStagedAsset(db, staged.ref);
    },
  });
  const tools = [searchTool, ...scheduleTools, chatUserListTool, channelListTool, emojiListTool, ...discordTimeoutTools, memorySearchTool, ...innerThreadTools, listChannelMessagesTool, ...ownMessageTools, readAssetTool, searchAssetTool, ...jobInspectionTools, readUserAvatarTool, fetchImagesTool, fetchUrlTool, summarizeVideoTool, reactToMessageTool];
  if (diceRollTool !== undefined) tools.push(diceRollTool);
  if (includeImageGenerationTools) {
    const imageProfile = resolveModelProfile(
      globalConfig,
      guildConfig.imageGeneration.modelProfile,
    );
    if (imageProfile.provider !== "openai-codex") {
      throw new Error(
        `Image generation model profile "${guildConfig.imageGeneration.modelProfile}" must use openai-codex`,
      );
    }
    const codexImageModel = imageProfile.model;
    const codexGenerateImageTool = createCodexGenerateImageTool({
      codexAuthPath: globalConfig.codexAuthPath,
      model: codexImageModel,
      sessionId: `2b2v-image:${guildId}:${channelId}:${codexImageModel}`,
      logger: log.child({ component: "codex-image", guildId, channelId }),
      imageReferenceMaxPerCall: guildConfig.imageReferenceMaxPerCall,
      imageGenerationQuality: guildConfig.imageGeneration.quality,
      asyncJobAlreadyActiveTemplate: promptBundle.runtime.contextTemplates["codex-image-job-existing"],
      asyncJobStartedTemplate: promptBundle.runtime.contextTemplates["codex-image-job-started"],
      resolveReferenceImage: async (id) => {
        if (typeof id === "string") {
          const staged = getStagedAsset(db, id);
          if (staged === null || staged.ownerGuildId !== guildId) return null;
          return await loadStagedAssetReferenceImage({
            asset: staged,
            maxBytes: guildConfig.assetReading?.maxDownloadBytes
              ?? DEFAULT_ASSET_READING.maxDownloadBytes,
          });
        }
        const asset = getAssetById(db, id);
        if (asset === null) return null;
        const source = await resolveAssetSource(asset);
        if (source === null) return null;
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
        });
        if (result.created) {
          void imageJobTasks.track(runImageGenerationJob(result.job.id)).catch((err: unknown) => {
            log.error("async image job failed outside worker", {
              jobId: result.job.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
        return result;
      } }),
    });

    const cancelJobTool = createCancelAgentJobTool({
      store: agentJobs,
      onCancelled: async (jobId) => {
        const staged = getStagedAssetForJob(db, jobId);
        if (staged === null) return;
        await unlink(staged.storagePath).catch(() => {});
        deleteStagedAsset(db, staged.ref);
      },
    });
    tools.push(codexGenerateImageTool, cancelJobTool);
  }

  // Brave search if API key configured
  if (globalConfig.braveApiKey !== undefined && globalConfig.braveApiKey !== "") {
    tools.push(createBraveSearchTool({ apiKey: globalConfig.braveApiKey }));
    tools.push(createBraveImageSearchTool({ apiKey: globalConfig.braveApiKey }));
  }
  if (effectiveCurrentRequest !== undefined && guildConfig.voice?.enabled === true) {
    tools.push(...createVoiceTools({
      runtime: voiceRuntime,
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

  const toolPromptVariables: ToolPromptVariables = {
    fetch_images: {
      maxImagesPerCall: (globalConfig.externalImages ?? DEFAULT_EXTERNAL_IMAGES).maxImagesPerCall,
      maxDimension: (globalConfig.externalImages ?? DEFAULT_EXTERNAL_IMAGES).maxDimension,
    },
    codex_generate_image: {
      imageReferenceMaxPerCall: guildConfig.imageReferenceMaxPerCall,
      imageGenerationQuality: guildConfig.imageGeneration.quality,
    },
    schedule_task: {
      timezone: guildConfig.timezone,
    },
    discord_set_user_timeout: {
      maxTimeoutDays: MAX_DISCORD_TIMEOUT_SECONDS / 86_400,
    },
  };

  return applyRuntimeToolPrompts(tools, promptBundle.runtime, toolPromptVariables);
}

const ambientRuntime = createAmbientRuntime({
  db,
  client,
  log,
  requestLogStore,
  agentJobs,
  getPromptBundle: () => promptBundle,
  getGlobalConfig: () => globalConfig,
  typingIntervalMs: TYPING_INTERVAL_MS,
  getGuildConfig,
  dashboardTriggerLocation,
  buildInboundResolvers,
  createSyntheticReplyFallbackDeps,
  buildContext,
  buildAgentTools,
  createVisibleMaintenanceTools: ({
    guild,
    guildConfig,
    memoryRequest,
    sourceRequestId,
  }) => {
    const latestHuman = latestHumanIdentity(
      guild.id,
      memoryRequest.incomingMessage.channelId ?? "",
    );
    return blockToolsExcept(createPostReplyMaintenanceTools({
      guild,
      guildConfig,
      memoryRequest,
      currentUserId: latestHuman.userId,
      currentUsername: latestHuman.username,
      sourceMessageId: memoryRequest.sourceMessageId ?? promptLabSyntheticId(),
      sourceRequestId,
    }), "", "visible reply mode");
  },
  promptLabDryRunTools,
  promptLabSyntheticId,
  promptLabSummary,
  resolveClientGuild,
  fetchAccessibleGuildChannel,
  createBotDiscordMessageSender,
  createHandlerDeps,
  processTriggeredMessage,
  trackBackgroundTask: (task) => {
    void backgroundTasks.track(task);
  },
  isAutonomousAttentionBusy: isScheduledAttentionBusy,
  waitForSemanticMaintenance: () => semanticMaintenanceCoordinator.barrier(),
  preparePersonaModeTurn: (guildId) => personaModeRuntime.prepareNaturalTurn(guildId),
  runMaintenance: async ({
    guildConfig,
    request,
    guild,
    channel,
    sourceRequestId,
    dryRun,
    dryRuns,
  }) => {
    const latestHuman = latestHumanIdentity(guild.id, channel.id);
    await runMemoryPostReplyExtraction({
      guildConfig,
      memoryRequest: request,
      guild,
      channel,
      sourceRequestId,
      source: "ambient_initiative",
      passKind: "ambient",
      currentUserId: latestHuman.userId,
      currentUsername: latestHuman.username,
      dryRun,
      dryRuns,
    });
    await runRelationshipPostReplyExtraction({
      guildConfig,
      memoryRequest: request,
      guild,
      channel,
      sourceRequestId,
      source: "ambient_initiative",
      currentUserId: latestHuman.userId,
      currentUsername: latestHuman.username,
      dryRun,
      dryRuns,
    });
    await runInnerThreadPostReplyExtraction({
      guildConfig,
      memoryRequest: request,
      guild,
      channel,
      sourceRequestId,
      dryRun,
    });
  },
});

const privateLifeRuntime = createPrivateLifeRuntime({
  db,
  client,
  log,
  requestLogStore,
  getPromptBundle: () => promptBundle,
  getGlobalConfig: () => globalConfig,
  getGuildConfig,
  resolveClientGuild,
  fetchAccessibleGuildChannel,
  createSyntheticReplyFallbackDeps,
  buildContext,
  buildAgentTools,
  createVisibleMaintenanceTools: ({
    episodeId,
    guild,
    guildConfig,
    memoryRequest,
    sourceRequestId,
  }) => blockToolsExcept(createPrivateLifeMaintenanceTools({
    episodeId,
    guild,
    guildConfig,
    memoryRequest,
    sourceRequestId,
    dryRun: true,
  }), "", "private-life actor mode"),
  createBotDiscordMessageSender,
  createHandlerDeps,
  promptLabDryRunTools,
  promptLabSyntheticId,
  promptLabSummary,
  runMaintenance: runPrivateLifeMaintenance,
  isBusy: (guildId, channelId) => isScheduledAttentionBusy(guildId, channelId)
    || requestLogStore.getActiveCount() > 0,
  activeRequestCount: () => requestLogStore.getActiveCount(),
  hasRecentVisibleOutput: (since) => {
    const botUserId = client.user?.id;
    if (botUserId === undefined) return true;
    return db.raw.prepare(`SELECT 1 FROM messages
      WHERE user_id = ? AND is_bot = 1 AND is_synthetic = 0
        AND is_prompt_only = 0 AND deleted_at IS NULL AND created_at >= ?
      LIMIT 1`).get(botUserId, since) !== null;
  },
});

// --- 21. Channel dispatcher ---
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
    handler: async (batch, trigger): Promise<DispatchOutcome> => {
      if (trigger === null) return { coveredMessageIds: [] };
      const selected = selectDispatchMessageForTrigger(batch, trigger);
      if (selected === undefined) return { coveredMessageIds: [] };
      const currentTurnMessages = selectDispatchMessagesForTrigger(batch, trigger)
        .map((pending) => pending.message as Message);
      return processTriggeredMessage(selected.message as Message, trigger.result, currentTurnMessages);
    },
  });
  dispatchers.set(guildId, dispatcher);
  return dispatcher;
}

function messageRepliesToOwnBot(message: Message): boolean {
  if (message.guildId === null || message.reference?.messageId === undefined) return false;
  const botUserId = client.user?.id ?? "";
  if (botUserId === "") return false;
  const row = db.raw
    .prepare("SELECT user_id, is_bot FROM messages WHERE id = ? AND guild_id = ? AND is_prompt_only = 0")
    .get(message.reference.messageId, message.guildId) as { user_id: string; is_bot: number } | null;
  return row !== null && row.user_id === botUserId && row.is_bot === 1;
}

function evaluateMessageTrigger(message: Message, guildConfig: GuildConfig, deliberateOnly = false): TriggerResult {
  const triggerInput = {
    content: message.content,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    botUserId: client.user?.id ?? "",
    mentionedUserIds: [...message.mentions.users.keys()],
    repliedToBot: messageRepliesToOwnBot(message),
  };
  return deliberateOnly
    ? shouldRespondDeliberately(triggerInput, guildConfig.triggers)
    : shouldRespond(triggerInput, guildConfig.triggers);
}

/** Process a triggered message through the full handler pipeline. */
function isMessageBackedTrigger(trigger: NonNullable<TriggerResult>): boolean {
  return trigger.reason === "mention"
    || trigger.reason === "keyword"
    || trigger.reason === "random"
    || trigger.reason === "ambient_pickup"
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
    };
    preSendCheck?: (draftText: string) => boolean | Promise<boolean>;
    onWriteToolStart?: (toolName: string) => void;
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
  requestLog.setTrigger(triggerOverride ?? null);
  let requestLogEmitted = false;
  let activeTyping: ReturnType<typeof createTypingController> | null = null;

  try {
    const guildConfig = getGuildConfig(guildId);
    const inboundResolvers = buildInboundResolvers(guild);
    const displayContent = messageDisplayContent(message.content, message.components, message.author.username);
    const translatedContent = appendStickerTags(
      translateInbound(displayContent, inboundResolvers),
      message.stickers.values(),
    );
    const currentTurnEventContent = options.currentTurnOverride?.content ?? currentTurnMessages
      .map((current) => appendStickerTags(
        translateInbound(messageDisplayContent(current.content, current.components, current.author.username), inboundResolvers),
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
    const resolveTargetChannel = createTargetChannelResolver(client, currentChannelObj);
    const typing = createTypingController({
      defaultChannel: currentChannelObj,
      resolveTargetChannel,
    });
    activeTyping = typing;
    const typingStartDelayMs = typingSimulationDelayMs(guildConfig.typingSimulation, "input", currentTurnEventContent);
    if (guildConfig.typingSimulation.enabled) {
      typing.scheduleStartLoop(typingStartDelayMs);
    } else {
      typing.startLoop();
    }
    const baseSender = createBotDiscordMessageSender({
      defaultChannel: currentChannelObj,
      resolveTargetChannel,
      botUserId: client.user?.id ?? "",
      botUsername: client.user?.username ?? "bot",
      logger: log,
      replySourceMessage: message,
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
        ambientRuntime.markAmbientPickupChannelCooldown(guildConfig.ambientAttention, guildId, destinationChannelId);
        ambientRuntime.clearPendingAmbientKindInChannel("ambient_pickup", guildId, destinationChannelId);
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
      timestamp: options.currentTurnOverride?.timestamp ?? message.createdTimestamp,
      replyToId: message.reference?.messageId ?? null,
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
      })),
      hasEmbeds: options.currentTurnOverride === undefined && message.embeds.length > 0,
      isSynthetic: false,
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
    personaModeRuntime.prepareNaturalTurn(guildId);
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
      "live",
      options.currentTurnOverride !== undefined ? currentTurnMessageIds : undefined,
      {
        appendLatestToHistory: options.currentTurnOverride !== undefined,
        ...(triggerOverride !== undefined && isMessageBackedTrigger(triggerOverride)
          ? { triggerMessageIds: currentTurnMessageIds }
          : {}),
      },
    );

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
    const agentTools = buildAgentTools(
      guildId,
      channelId,
      guildConfig,
      guild,
      context.contextMessageIds,
      generatedImages.onGeneratedImage,
      {
        requesterId: message.author.id,
        requesterUsername: message.author.username,
        sourceMessageId: message.id,
        sourceQuote: shortQuote(translatedContent),
      },
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
    const threadTools = applyRuntimeToolPrompts([startThreadTool, closeThreadTool], promptBundle.runtime);
    const baseExtraTools = [...agentTools, ...threadTools];
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
      mentionedUserIds: [...message.mentions.users.keys()],
      translatedContent: options.currentTurnOverride?.content ?? translatedContent,
      eventContent: currentTurnEventContent !== "" ? currentTurnEventContent : translatedContent,
      currentContentInHistory: options.currentTurnOverride === undefined,
      messageId: options.currentTurnOverride?.messageId ?? message.id,
      replyToMessageId: message.reference?.messageId,
      repliedToBot: messageRepliesToOwnBot(message),
      assets: latestUserMessage.assets,
      ...(repliedToBotRouteSource !== null
        ? {
            repliedToBotRouteSource: {
              sourceGuildId: repliedToBotRouteSource.routedFromGuildId,
              sourceChannelId: repliedToBotRouteSource.routedFromChannelId,
              sourceMessageId: repliedToBotRouteSource.routedFromMessageId,
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
        onTriggered: () => {
          if (!guildConfig.typingSimulation.enabled) typing.startLoop();
        },
        onStillWorking: (destinationChannelId) => { typing.startLoop(destinationChannelId); },
        getTypingStartedAt: typing.getTypingStartedAt,
        onVisibleOutput: typing.stopLoop,
        hasExternalVisibleOutput: () => externalVisibleOutputSent,
        onAgentEnd: typing.stopLoop,
        triggerOverride,
        disableLiveOutput: options.disableLiveOutput,
        preSendCheck: options.preSendCheck,
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
          ambientRuntime.clearAmbientLeaseForUser(guildId, destinationChannelId ?? channelId, message.author.id);
        },
        afterReply: async (memoryRequest) => {
          await runMemoryPostReplyExtraction({
            guildConfig,
            memoryRequest,
            guild,
            channel: message.channel,
            sourceRequestId: requestLog.requestId,
            currentUserId: message.author.id,
            currentUsername: message.author.username,
          });
          await runRelationshipPostReplyExtraction({
            guildConfig,
            memoryRequest,
            guild,
            channel: message.channel,
            sourceRequestId: requestLog.requestId,
            source: "post_reply",
            currentUserId: message.author.id,
            currentUsername: message.author.username,
          });
          await runInnerThreadPostReplyExtraction({
            guildConfig,
            memoryRequest,
            guild,
            channel: message.channel,
            sourceRequestId: requestLog.requestId,
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
        afterSuccess: () => {
          const botMessageId = sentBotMessageIds.at(-1);
          // Attachment-only and intermediate-only replies have no response text;
          // the delivered Discord message is the durable signal for lingering attention.
          if (botMessageId === undefined) return;
          ambientRuntime.noteAmbientBotReply({
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
        onFinally: (completed) => {
          typing.stopLoop();
          const completedTrigger = completed?.triggerResult ?? triggerOverride;
          if (
            completedTrigger?.reason === "mention" ||
            completedTrigger?.reason === "keyword" ||
            completedTrigger?.reason === "random"
          ) {
            ambientRuntime.clearAmbientNormalTriggerInFlight(guildId, channelId, message.author.id);
          }
        },
      });
    } finally {
      requestLogEmitted = true;
    }
    return {
      coveredMessageIds: currentTurnMessageIds,
    };
  } catch (err) {
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

// --- 22. typingStart handler ---
client.on("typingStart", (typing: Typing) => {
  if (!acceptingDiscordMessages) return;
  if (!typing.inGuild()) return;
  if (typing.user.bot) return;
  ambientRuntime.noteAmbientTyping(typing);

  const guildId = typing.guild.id;
  const guildConfig = getGuildConfig(guildId);
  if (!guildConfig.dispatcher.enabled) return;

  getOrCreateDispatcher(guildId).recordTyping(
    typing.channel.id,
    typing.user.id,
  );
});

registerReactionSyncRuntime({
  client,
  db,
  log,
  isAcceptingEvents: () => acceptingDiscordMessages,
  trackTask: (task) => {
    void backgroundTasks.track(task);
  },
});

/** Queue Discord messages that arrive before startup dependencies are ready. */
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
      `INSERT OR IGNORE INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      messageCreatedAt,
      message.reference?.messageId ?? null,
    );

  if (message.channel.isThread()) {
    const updated = updateThreadActivity(db, channelId, {
      lastActivityAt: messageCreatedAt,
      lastMessageId: message.id,
      archivedAt: message.channel.archived === true ? now : null,
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
        archivedAt: message.channel.archived === true ? now : null,
      });
    }
  }

  syncMessageAssets(db, { messageId: message.id, assets: assetsFromDiscordMessage(message) });
  return inserted.changes > 0;
}

// --- 23. messageCreate handler ---
async function processDiscordMessageCreate(message: Message): Promise<void> {
  try {
    // Never re-process this client's own Discord output. Other bots may use
    // the normal deliberate trigger paths.
    if (message.author.id === client.user?.id) return;
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
    const displayContent = messageDisplayContent(message.content, message.components, message.author.username);
    const translatedContent = appendStickerTags(
      translateInbound(displayContent, inboundResolvers),
      message.stickers.values(),
    );
    if (!persistInboundDiscordMessage(message, displayContent, translatedContent)) return;

    const triggerResult = evaluateMessageTrigger(message, guildConfig);
    ambientRuntime.maybeScheduleAmbientAttention(message, triggerResult);

    // Dispatch to handler: use channel dispatcher if enabled, otherwise call directly
    if (guildConfig.dispatcher.enabled) {
      getOrCreateDispatcher(guildId).enqueue(message, {
        authorId: message.author.id,
        triggerResult,
      });
      if (triggerResult === null) {
        void maybeRunAmbientMemoryExtraction(message, guildConfig);
      }
    } else {
      if (triggerResult === null) {
        void maybeRunAmbientMemoryExtraction(message, guildConfig);
      } else {
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

      const recovered: Array<{ message: Message; triggerResult: TriggerResult }> = [];
      for (const message of fetched.messages) {
        if (message.author.id === client.user?.id || message.guild === null || message.guildId === null) continue;
        const displayContent = messageDisplayContent(message.content, message.components, message.author.username);
        const translatedContent = appendStickerTags(
          translateInbound(displayContent, buildInboundResolvers(message.guild)),
          message.stickers.values(),
        );
        if (!persistInboundDiscordMessage(message, displayContent, translatedContent)) continue;
        claimedCount += 1;
        const guildConfig = getGuildConfig(message.guildId);
        const triggerResult = evaluateMessageTrigger(message, guildConfig, true);
        if (triggerResult !== null) triggerCount += 1;
        recovered.push({ message, triggerResult });
      }

      if (!recovered.some((entry) => entry.triggerResult !== null)) continue;
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
          });
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

// --- Hot-reload config watcher ---
const CONFIG_RELOAD_DEBOUNCE_MS = 500;
const CONFIG_RELOAD_POLL_MS = 5000;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let configReloadPollTimer: ReturnType<typeof setInterval> | null = null;
const configWatchers: FSWatcher[] = [];
let lastConfigFingerprint = configReloadFingerprint();

function scheduleConfigReload(): void {
  if (!acceptingDiscordMessages) return;
  if (reloadTimer !== null) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void backgroundTasks.track(reloadConfigs());
  }, CONFIG_RELOAD_DEBOUNCE_MS);
}

function configReloadFingerprint(): string {
  const parts: string[] = [];
  const pending = [profileDir];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined) continue;
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    parts.push(`${path}:${stat.mtimeMs}:${stat.size}`);
    if (!stat.isDirectory()) continue;
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (/\.(?:ya?ml|md|png|jpe?g|webp)$/i.test(entry.name)) pending.push(entryPath);
    }
  }
  return parts.sort().join("|");
}

async function reloadConfigs(): Promise<void> {
  try {
    requireProfileConfigPath(profilesDir, profile);
    const newGlobal = loadGlobalConfig(
      process.env as Record<string, string | undefined>,
      configPath,
    );
    validateTrimConfig(newGlobal.defaultTrim);

    // Reload guild configs — clear and rebuild
    const newGuilds = loadGuildConfigs(guildsDir, newGlobal);
    await modelImageSupport.refresh(newGlobal, newGuilds, "hot_reload");
    if (!acceptingDiscordMessages) return;

    globalConfig = newGlobal;
    promptBundle = loadInstructionBundle(profilesDir, profile, log);
    personaModeRuntime.update(newGlobal.personaModes, newGlobal.defaultTimezone);

    guildConfigs.clear();
    for (const [id, cfg] of newGuilds) {
      guildConfigs.set(id, cfg);
    }

    // Swap first so new events use the new config while previously accepted work drains intact.
    const previousDispatchers = [...dispatchers.values()];
    dispatchers.clear();
    ambientRuntime.clearAmbientAttentionState();
    ambientRuntime.clearAmbientInitiativeState();
    privateLifeRuntime.clear();
    ambientRuntime.startAmbientInitiativeLoops();
    privateLifeRuntime.start();
    await Promise.all(previousDispatchers.map(async (dispatcher) => {
      await dispatcher.drain();
      dispatcher.dispose();
    }));

    log.info("config hot-reloaded", {
      modelProfile: globalConfig.defaultModelProfile,
      model: resolveModelProfile(globalConfig, globalConfig.defaultModelProfile).model,
      guilds: guildConfigs.size,
    });
  } catch (err) {
    log.error("config hot-reload failed, keeping previous config", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

if (existsSync(profileDir)) {
  const watcher = watch(profileDir, { recursive: true }, (_event, _filename) => {
    lastConfigFingerprint = configReloadFingerprint();
    scheduleConfigReload();
  });

  // Prevent watcher from keeping the process alive during shutdown
  watcher.unref();
  configWatchers.push(watcher);
  log.info("profile hot-reload watcher started");

  configReloadPollTimer = setInterval(() => {
    const fingerprint = configReloadFingerprint();
    if (fingerprint === lastConfigFingerprint) return;
    lastConfigFingerprint = fingerprint;
    scheduleConfigReload();
  }, CONFIG_RELOAD_POLL_MS);
  configReloadPollTimer.unref();
  log.info("config hot-reload poller started", { intervalMs: CONFIG_RELOAD_POLL_MS });
}

const sharedInstructionsDir = join(profilesDir, "shared", "instructions");
if (existsSync(sharedInstructionsDir)) {
  const watcher = watch(sharedInstructionsDir, { recursive: true }, (_event, _filename) => {
    scheduleConfigReload();
  });

  watcher.unref();
  configWatchers.push(watcher);
  log.info("shared instructions hot-reload watcher started");
}

// --- Health check summary ---
await recoverMessagesAfterRestart();
log.info("health check passed — all systems ready", {
  uptimeMs: Date.now() - startTime,
  guilds: guildConfigs.size,
  schedulerJobs: scheduler.activeCount(),
});
startupMessageProcessingReady = true;
drainStartupMessageQueue();
void backgroundTasks.track(backfillMessageAssets({
  db,
  client,
  logger: log.child({ component: "asset-backfill" }),
  signal: assetBackfillController.signal,
})).catch((error: unknown) => {
  log.warn("asset history backfill stopped", { error: error instanceof Error ? error.message : String(error) });
});
ambientRuntime.startAmbientInitiativeLoops();
privateLifeRuntime.start();
for (const row of db.raw.prepare(
  "SELECT id FROM agent_jobs WHERE status = 'ready' ORDER BY completed_at ASC, created_at ASC",
).all() as Array<{ id: string }>) {
  void imageJobTasks.track(runImageGenerationJob(row.id)).catch((error: unknown) => {
    log.error("ready staged image recovery failed", {
      jobId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

// --- Start dashboard ---

function promptLabUserFromGuild(guild: Guild, userId: string): {
  id: string;
  username: string;
  displayName?: string;
  globalName?: string;
} {
  const member = guild.members.cache.get(userId);
  const cachedUser = client.users.cache.get(userId);
  return {
    id: userId,
    username: member?.user.username ?? cachedUser?.username ?? dashboardManagementRuntime.userName(userId),
    ...(member?.displayName !== undefined ? { displayName: member.displayName } : {}),
    ...(member?.user.globalName !== null && member?.user.globalName !== undefined
      ? { globalName: member.user.globalName }
      : cachedUser?.globalName !== null && cachedUser?.globalName !== undefined
        ? { globalName: cachedUser.globalName }
        : {}),
  };
}

const runPromptLab = createPromptLabRunner({
  client,
  db,
  getPromptBundle: () => promptBundle,
  requestLogStore,
  log,
  getGuildConfig,
  getRelationshipConfig,
  resolveClientGuild,
  fetchAccessibleGuildChannel,
  buildInboundResolvers,
  buildContext,
  buildAgentTools,
  blockToolsExcept,
  createPostReplyMaintenanceTools,
  createHandlerDeps,
  runMemoryPostReplyExtraction,
  runRelationshipPostReplyExtraction,
  runInnerThreadPostReplyExtraction,
  promptLabUserFromGuild,
});

const dashboardPassword = process.env.DASHBOARD_PASSWORD;
const bypassDashboardAuth = process.env.UNSAFELY_BYPASS_DASHBOARD_AUTH === "true";
const dashboardPasswordlessCidrs = parseDashboardPasswordlessCidrs(process.env.DASHBOARD_PASSWORDLESS_CIDRS);
const dashboardTrustedProxyCidrs = parseDashboardPasswordlessCidrs(process.env.DASHBOARD_TRUSTED_PROXY_CIDRS);
const dashboardManagementRuntime = createDashboardManagementRuntime({ client, db });
const dashboardManagement = {
  getPersonaModeStatus: () => {
    const status = personaModeRuntime.getStatus();
    return {
      profile,
      ...status,
      guilds: status.guilds.map((entry) => ({
        ...entry,
        guildName: client.guilds.cache.get(entry.guildId)?.name ?? entry.guildId,
      })),
    };
  },
  getDirectory: dashboardManagementRuntime.getDirectory,
  listMessages: dashboardManagementRuntime.listMessages,
  editMessage: dashboardManagementRuntime.editMessage,
  deleteMessages: dashboardManagementRuntime.deleteMessages,
  deleteLatestMessages: dashboardManagementRuntime.deleteLatestMessages,
  runPromptLab,
  runPromptLabAmbientInitiative: ambientRuntime.runPromptLabAmbientInitiative,
  runPromptLabPrivateLife: (input: {
    guildId: string;
    channelId: string;
    origin?: string;
    mode?: string;
    territory?: string;
    actionScope?: string;
  }) => {
    const origin = PRIVATE_LIFE_ATTENTION_ORIGINS.find((candidate) => candidate === input.origin);
    const mode = PRIVATE_LIFE_CURIOSITY_MODES.find((candidate) => candidate === input.mode);
    const territory = PRIVATE_LIFE_TERRITORIES.find((candidate) => candidate === input.territory);
    const actionScope = PRIVATE_LIFE_ACTION_SCOPES.find((candidate) => candidate === input.actionScope);
    if (input.origin !== undefined && origin === undefined) throw new Error(`Unknown private-life origin: ${input.origin}`);
    if (input.mode !== undefined && mode === undefined) throw new Error(`Unknown private-life mode: ${input.mode}`);
    if (input.territory !== undefined && territory === undefined) throw new Error(`Unknown private-life territory: ${input.territory}`);
    if (input.actionScope !== undefined && actionScope === undefined) throw new Error(`Unknown private-life action scope: ${input.actionScope}`);
    return privateLifeRuntime.runPromptLab({
      guildId: input.guildId,
      channelId: input.channelId,
      ...(origin !== undefined ? { origin } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(territory !== undefined ? { territory } : {}),
      ...(actionScope !== undefined ? { actionScope } : {}),
    });
  },
  listPrivateLifeEpisodes: (limit?: number) => ({ episodes: privateLifeRuntime.listEpisodes(limit) }),
  listInnerThreads: (filter: { guildId?: string; status?: "active" | "resolved"; limit?: number }) => ({
    threads: listInnerThreads(db, filter),
  }),
  listStagedAssets: (filter: { guildId?: string; channelId?: string; unresolvedOnly?: boolean; limit?: number }) => ({
    assets: listStagedAssets(db, filter),
  }),
  listMemories: dashboardManagementRuntime.listMemories,
  createMemory: dashboardManagementRuntime.createMemory,
  editMemory: dashboardManagementRuntime.editMemory,
  deleteMemory: dashboardManagementRuntime.deleteMemory,
  restoreMemory: dashboardManagementRuntime.restoreMemory,
  relationships: createRelationshipsManagementApi({
    db,
    getGlobalConfig: () => globalConfig,
    getGuildConfig: () => resolveGuildConfig(globalConfig, { guildId: "dashboard", slug: "dashboard" }),
  }),
  voice: {
      getSnapshot: () => voiceRuntime.snapshot(),
      subscribe: (listener: (snapshot: object) => void) => voiceRuntime.subscribe(listener),
      listChannels: () => ({
        channels: [...client.guilds.cache.values()].flatMap((guild) => [...guild.channels.cache.values()]
          .filter((channel) => channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice)
          .map((channel) => ({
            id: channel.id,
            name: channel.name,
            guildId: guild.id,
            guildName: guild.name,
            members: [...channel.members.values()]
              .filter((member) => !member.user.bot)
              .map((member) => member.user.username),
          }))),
      }),
      join: async (channelId: string) => await voiceRuntime.join(channelId),
      leave: async () => {
        await voiceRuntime.leave("Voice session ended from the dashboard.");
        return voiceRuntime.snapshot();
      },
      inject: async (text: string) => {
        const snapshot = voiceRuntime.snapshot();
        if (snapshot.guildId === undefined) throw new Error("2B is not connected to a voice channel.");
        return await voiceRuntime.inject({
          guildId: snapshot.guildId,
          userId: "dashboard",
          username: "dashboard",
          text,
          trusted: true,
        });
      },
    },
};
let dashboardServer: ReturnType<typeof startDashboard> | undefined;
if (bypassDashboardAuth) {
  dashboardServer = startDashboard({ port: 3000, password: "", bypassAuth: true, management: dashboardManagement, log });
  log.warn("dashboard started with auth bypass — do not use in production");
} else if (dashboardPassword !== undefined && dashboardPassword !== "") {
  dashboardServer = startDashboard({
    port: 3000,
    password: dashboardPassword,
    passwordlessCidrs: dashboardPasswordlessCidrs,
    trustedProxyCidrs: dashboardTrustedProxyCidrs,
    management: dashboardManagement,
    log,
  });
} else {
  log.info("dashboard disabled (DASHBOARD_PASSWORD not set)");
}

// --- Graceful shutdown ---
async function shutdown(signal: string): Promise<void> {
  log.info("shutting down", { signal });

  setRestartRecoveryCutoff(db);
  acceptingDiscordMessages = false;
  startupMessageProcessingReady = false;
  // The voice dashboard keeps an EventSource request open indefinitely, so a
  // graceful HTTP stop cannot finish during process shutdown.
  const dashboardStop = dashboardServer?.stop(true);

  clearInterval(memoryCleanupTimer);
  clearInterval(vpnSessionCleanupTimer);
  if (configReloadPollTimer !== null) clearInterval(configReloadPollTimer);
  if (reloadTimer !== null) clearTimeout(reloadTimer);
  for (const watcher of configWatchers) watcher.close();
  ambientRuntime.clearAmbientAttentionState();
  ambientRuntime.clearAmbientInitiativeState();
  privateLifeRuntime.clear();
  scheduler.stop();
  personaModeRuntime.stop();
  assetBackfillController.abort(new Error("Asset backfill stopped for shutdown."));

  await inboundMessageTasks.drain();
  await Promise.all([...dispatchers.values()].map((dispatcher) => dispatcher.drain()));
  await scheduler.drain();
  await voiceRuntime.shutdown();
  await dashboardStop;
  while (imageJobTasks.activeCount() > 0 || backgroundTasks.activeCount() > 0) {
    await Promise.all([imageJobTasks.drain(), backgroundTasks.drain()]);
  }

  ambientRuntime.clearAmbientAttentionState();
  ambientRuntime.clearAmbientInitiativeState();
  privateLifeRuntime.clear();
  for (const dispatcher of dispatchers.values()) dispatcher.dispose();
  dispatchers.clear();
  await client.destroy();
  db.close();

  log.info("shutdown complete");
  process.exit(0);
}

let shutdownPromise: Promise<void> | null = null;
function requestShutdown(signal: string): void {
  if (shutdownPromise !== null) {
    log.warn("forcing shutdown after repeated signal", { signal });
    process.exit(1);
  }
  shutdownPromise = shutdown(signal).catch((error: unknown) => {
    log.error("graceful shutdown failed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
  void shutdownPromise;
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

export { db, guildConfigs, globalConfig, promptBundle, scheduler, client };
