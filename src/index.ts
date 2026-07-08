import { createLogger, RequestLog, type LogLevel, type Logger } from "./logger";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { requestLogStore } from "./dashboard/store";
import { parseDashboardPasswordlessCidrs, startDashboard } from "./dashboard/server";
import { loadGlobalConfig, loadGuildConfigs, resolveGuildConfig, validateTrimConfig, validateVpnConfig } from "./config/loader";
import type { GuildConfig } from "./config/types";
import { createDatabase } from "./db/database";
import { createQdrantClient, ensureCollection, healthCheck } from "./qdrant/client";
import { getEmbeddingPipeline, disposePipeline } from "./embeddings/pipeline";
import { createEmbeddingQueue, type EmbeddingQueue } from "./embeddings/queue";
import { createDiscordClient, loginDiscordClient } from "./discord/client";
import { buildDiscordContext } from "./discord/context-renderer";
import { registerInteractionRuntime } from "./discord/interaction-runtime";
import { translateInbound, translateOutbound, buildDisplayNameContext, type InboundResolvers, type OutboundResolvers } from "./discord/translation";
import { splitMessage } from "./discord/split-message";
import { EmojiCache, buildEmojiContext, type EmojiEntry } from "./discord/emoji-cache";
import { appendStickerTags, guessImageMimeFromUrl, imageKindForAttachment, imageKindForEmbed, stickerImagePreview } from "./discord/message-media";
import { botChannelPermissions, channelDisplayName, channelTypeLabel, createDiscordMessageSender, createTargetChannelResolver, createTypingController, fetchAccessibleGuildChannel as fetchAccessibleDiscordGuildChannel, isSendableGuildChannel, type SendableGuildChannel } from "./discord/message-sender";
import { registerReactionSyncRuntime } from "./discord/reaction-sync-runtime";
import { createSchedulerEngine, type SchedulerEngine } from "./scheduler/engine";
import { createScheduledTaskRunner } from "./scheduler/scheduled-task-runtime";
import { handleMessage, hasMaintenanceMaterial, runSilentMemoryAgentPass, runSilentToolAgentPass, type HandleResult, type ImageAttachmentResolver, type IncomingMessage, type HandlerDeps, type MessageSender, type OutboundAttachment } from "./agent/handler";
import { trackWriteToolStarts } from "./agent/tool-access";
import { buildComputedContactContextForUser } from "./agent/contact-context";
import { shouldRespond, type TriggerResult } from "./agent/triggers";
import { buildPublicErrorNoticeForError } from "./agent/public-error-notice";
import { typingSimulationDelayMs } from "./agent/typing-simulation";
import { createChannelDispatcher, selectDispatchMessageForTrigger, selectDispatchMessagesForTrigger, type ChannelDispatcher, type DispatchOutcome } from "./discord/channel-dispatcher";
import { assembleContext, type AssembledContext, type ThreadMetadata } from "./agent/context-assembly";
import type { HistoryMessage } from "./agent/history-types";
import { getContextHistoryMessages, insertSyntheticEvent, insertPromptOnlyBotMessage, getParentPreContext, listChannelMessages, getRoutedMessageSource, getLatestMessageActivityBefore, type MessageActivity } from "./db/message-repository";
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
import { buildMemoryContext, buildVisibleUserMemoryContext, createRecordMemoryTool } from "./agent/memory-service";
import { createSearchChannelMessagesTool } from "./agent/search-channel-messages-tool";
import { createScheduleTools } from "./agent/schedule-tool";
import { createChatUserListTool, type MemberInfo } from "./agent/member-list-tool";
import { createChannelListTool, type ChannelInfo } from "./agent/channel-list-tool";
import { createEmojiListTool } from "./agent/emoji-list-tool";
import { createDiscordTimeoutTools, MAX_DISCORD_TIMEOUT_SECONDS, type TimeoutMember, type TimeoutMemberResolution } from "./agent/timeout-user-tool";
import { createMemoryListTool } from "./agent/user-memory-tool";
import { createListChannelMessagesTool } from "./agent/list-channel-messages-tool";
import { createOwnMessageTools } from "./agent/own-message-tool";
import { createBraveSearchTool } from "./agent/brave-search-tool";
import { createReadChatImagesTool } from "./agent/read-chat-images-tool";
import { createReadUserAvatarTool, type AvatarSize } from "./agent/read-user-avatar-tool";
import { createFetchImagesTool } from "./agent/fetch-images-tool";
import { createCodexGenerateImageTool, type GeneratedImageAttachment } from "./agent/codex-image-tool";
import { AgentJobStore, createCancelAgentJobTool, isActiveJobStatus, type ImageGenerationJobResult } from "./agent/job-runtime";
import { annotateHistoryJobs, createGeneratedImageRuntime, DEFAULT_CODEX_IMAGE_ROUTER_MODEL, renderAgentJobsContext, shortQuote, type GeneratedImageRuntime } from "./agent/generated-image-runtime";
import { createStoredImageAttachmentResolver } from "./agent/stored-image-attachments";
import { createFetchUrlTool } from "./agent/fetch-url-tool";
import { createSummarizeVideoTool } from "./agent/summarize-video-tool";
import { createCloseThreadTool, createStartThreadTool } from "./agent/start-thread-tool";
import { createReactToMessageTool } from "./agent/react-to-message-tool";
import { applyRuntimeToolPrompts, type ToolPromptVariables } from "./agent/runtime-tool-prompts";
import { createModelImageSupportStore } from "./llm/model-image-support";
import { createAmbientRuntime } from "./ambient/runtime";
import { getImageById, getImagesByMessageId } from "./db/image-repository";
import { upsertThread, updateThreadActivity, markThreadArchived, listThreadsForContext, getThreadMetadata, getThread } from "./db/thread-repository";
import { prepareImageBufferForContext, processAndStoreImage, type ImageIngestDeps } from "./db/image-ingest";
import { deleteExpiredMemories, countUserMemoriesByUser } from "./db/memory-repository";
import { deleteExpiredCodexReasoningContinuations, getCodexReasoningContinuation, upsertCodexReasoningContinuation } from "./db/codex-reasoning-continuation-repository";
import { createRelationshipsManagementApi } from "./dashboard/relationships-management";
import { createDashboardManagementRuntime, dashboardTriggerLocation } from "./dashboard/management-runtime";
import { createPromptLabRunner, promptLabDryRunTools, promptLabSummary, promptLabSyntheticId } from "./dashboard/prompt-lab-runtime";
import {
  createRecordRelationshipTool,
  getRelationshipProfile,
  listRelationshipProfiles,
  renderRelationshipPromptContext,
  type RelationshipContextProfile,
  type RelationshipConfig,
  type RelationshipMutationResult,
} from "./relationships";
import { listUpcomingForContext } from "./db/schedule-repository";
import { registerSlashCommands } from "./commands/registry";
import { statusCommandDefinition } from "./commands/status";
import { scheduleCommandDefinition } from "./commands/schedule";
import { memoryWipeCommandDefinition } from "./commands/memory-wipe";
import { vpnCommandDefinition } from "./commands/vpn";
import { createVpnClient, type VpnClient } from "./vpn/api-client";
import { createSessionStore, type SessionStore } from "./vpn/session";
import { loadPromptBundle, type PromptBundle } from "./config/prompt-bundle";
import { renderPromptTemplate } from "./config/prompt-template";
import { resolveReactionEmojiInput } from "./discord/reaction-emoji";
import { createDiscordReplyFallbackDeps, createSyntheticReplyFallbackDeps, syncDeletedOwnBotMessage, syncEditedOwnBotMessage } from "./discord/reply-fallback-runtime";
import { join } from "path";
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, watch } from "fs";
import type { Database } from "./db/database";
import { ChannelType, PermissionFlagsBits, type Client, type Guild, type GuildBasedChannel, type GuildMember, type Message, type TextChannel, type ThreadChannel, type Typing } from "discord.js";

const pkg = await Bun.file(new URL("../package.json", import.meta.url).pathname).json() as { version?: string };
const CONTEXT_IMAGE_MAX_DIMENSION = 1024;
const version: string = pkg.version ?? "0.0.0";

const startTime = Date.now();
const logLevel = (process.env.LOG_LEVEL ?? "info") as LogLevel;
const log = createLogger({ level: logLevel });

const TYPING_INTERVAL_MS = 8_000;

async function runImageGenerationJob(jobId: string): Promise<void> {
  const job = agentJobs.get(jobId);
  if (job === undefined) return;
  const sourceGuildConfig = getGuildConfig(job.guildId);
  const deliveryGuildConfig = getGuildConfig(job.deliveryGuildId);
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
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Image job ${job.id} timed out after ${deliveryGuildConfig.agentJobs.imageTimeoutMs}ms`));
  }, deliveryGuildConfig.agentJobs.imageTimeoutMs);
  const typingTimer = setInterval(() => {
    void textChannel.sendTyping().catch(() => {});
  }, TYPING_INTERVAL_MS);
  void textChannel.sendTyping().catch(() => {});
  agentJobs.start(job.id, () => controller.abort(new Error(`Image job ${job.id} cancelled.`)));

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
    attachment?: OutboundAttachment;
  }): Promise<string | undefined> => {
    let sourceMessage: Message | undefined;
    try {
      sourceMessage = await textChannel.messages.fetch(job.sourceMessageId);
    } catch {
      sourceMessage = undefined;
    }
    const completionTyping = createTypingController({
      defaultChannel: textChannel,
      resolveTargetChannel: createTargetChannelResolver(client, textChannel),
    });
    const sender = createBotDiscordMessageSender({
      defaultChannel: textChannel,
      resolveTargetChannel: createTargetChannelResolver(client, textChannel),
      botUserId: client.user?.id ?? "",
      botUsername: client.user?.username ?? "bot",
      logger: log,
      ...(sourceMessage !== undefined ? { replySourceMessage: sourceMessage } : {}),
      getLastTypingAt: completionTyping.getLastTypingAt,
      getAttachmentsDir: (targetGuildId) => getGuildConfig(targetGuildId).attachmentsDir,
      routedFrom: {
        routedFromGuildId: job.guildId,
        routedFromChannelId: job.channelId,
        routedFromMessageId: job.sourceMessageId,
      },
    });

    const replyFallbackDeps = createDiscordReplyFallbackDeps({
      db,
      embeddingQueue,
      clientChannelsFetch: (chId) => client.channels.fetch(chId),
      guild,
      guildId: job.deliveryGuildId,
      channelId: job.deliveryChannelId,
      guildConfig: deliveryGuildConfig,
      fetchUncached: true,
    });
    const syntheticLatestMessage: HistoryMessage = {
      id: `async-image-${input.event}-${job.id}`,
      author: "async_image_generation",
      authorId: "async_image_generation",
      content: input.instruction,
      isBot: false,
      timestamp: Date.now(),
      replyToId: job.sourceMessageId,
      imageIds: [],
      captions: [],
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
        ...(input.event === "failed" ? {
          currentRequest: {
            requesterId: job.requesterId,
            requesterUsername: job.requesterUsername,
            sourceMessageId: job.sourceMessageId,
            sourceQuote: job.sourceQuote,
          },
        } : {}),
      },
    );
    let sentMessageId: string | undefined;
    const completionSender: MessageSender = async (...args) => {
      const sent = await sender(...args);
      sentMessageId ??= sent.sentMessageId;
      return sent;
    };
    const tts = createTtsGenerator(deliveryGuildConfig);
    const attachment = input.attachment;
    const completionIncoming: IncomingMessage = {
      content: input.instruction,
      guildId: job.deliveryGuildId,
      guildName: guild.name,
      channelId: job.deliveryChannelId,
      channelName: channelDisplayName(textChannel),
      authorId: "async_image_generation",
      authorUsername: "async_image_generation",
      botUserId: client.user?.id ?? "",
      mentionedUserIds: [],
      translatedContent: input.instruction,
      messageId: syntheticLatestMessage.id,
      replyToMessageId: job.sourceMessageId,
      // Do not feed finished generated images back into the chat model by default.
      // The Codex subscription Responses backend accepts some `input_image` URLs but
      // is unreliable with base64 data URLs, while this turn only needs to send the
      // already-generated Discord attachment and short delivery text.
    };
    const completionResult = await handleMessage(completionIncoming, createHandlerDeps({
      guildConfig: deliveryGuildConfig,
      context,
      currentChannelId: job.deliveryChannelId,
      sender: completionSender,
      extraTools,
      log: log.child({ component: `async-image-${input.event}`, guildId: job.deliveryGuildId, channelId: job.deliveryChannelId, sourceGuildId: job.guildId, sourceChannelId: job.channelId, jobId: job.id, requestId: requestLog.requestId }),
      requestLog,
      tts,
      resolveImageAttachments: createStoredImageAttachmentResolver({
        db,
        guildId: job.deliveryGuildId,
        logger: log.child({ component: "stored-image-attachments", guildId: job.deliveryGuildId, channelId: job.deliveryChannelId, jobId: job.id }),
      }),
      overrides: {
        ...(attachment !== undefined ? { initialPendingAttachments: [attachment] } : {}),
        forceTrigger: true,
        triggerInstructions: deliveryGuildConfig.triggerInstructions,
        onTriggered: () => { completionTyping.startLoop(); },
        onStillWorking: (destinationChannelId) => { completionTyping.startLoop(destinationChannelId); },
        getTypingStartedAt: completionTyping.getTypingStartedAt,
        onVisibleOutput: completionTyping.stopLoop,
        onAgentEnd: completionTyping.stopLoop,
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
  };

  try {
    const generated = createGeneratedImageRuntime();
    const tool = createCodexGenerateImageTool({
      codexAuthPath: globalConfig.codexAuthPath,
      model: sourceGuildConfig.llmProvider === "openai-codex"
        ? sourceGuildConfig.model ?? globalConfig.defaultModel
        : DEFAULT_CODEX_IMAGE_ROUTER_MODEL,
      sessionId: `2b2v-image-job:${job.guildId}:${job.channelId}:${job.deliveryGuildId}:${job.deliveryChannelId}:${job.id}`,
      logger: log.child({ component: "async-image-job", guildId: job.deliveryGuildId, channelId: job.deliveryChannelId, sourceGuildId: job.guildId, sourceChannelId: job.channelId, jobId: job.id }),
      imageReadMaxPerCall: sourceGuildConfig.imageReadMaxPerCall,
      imageGenerationQuality: sourceGuildConfig.imageGeneration.quality,
      asyncJobAlreadyActiveTemplate: promptBundle.runtime.contextTemplates["codex-image-job-existing"],
      asyncJobStartedTemplate: promptBundle.runtime.contextTemplates["codex-image-job-started"],
      getImageById: (id: number) => {
        const record = getImageById(db, id);
        return record !== null && record.guildId === job.guildId ? record : null;
      },
      readFile: (path: string) => {
        try {
          return Buffer.from(readFileSync(path));
        } catch {
          return null;
        }
      },
      onGeneratedImage: generated.onGeneratedImage,
    });
    const imageToolArgs = {
      jobId: job.id,
      prompt: job.input.prompt,
      image_ids: job.input.imageIds,
      output_format: job.input.outputFormat,
      "4k": job.input.is4k,
    };
    requestLog.recordToolStart(imageToolCallId, "codex_generate_image", imageToolArgs);
    imageToolStarted = true;
    const result = await tool.execute(job.id, {
      prompt: job.input.prompt,
      image_ids: job.input.imageIds,
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
    const outboundAttachment: OutboundAttachment = {
      ...attachment,
      historyText: [
        `Async image job ${job.id}.`,
        `4K: ${job.input.is4k ? "yes" : "no"}`,
        details?.transport !== undefined ? `Transport: ${details.transport}` : "",
        details?.requestedSize !== undefined ? `Requested size: ${details.requestedSize}` : "",
        details?.actualSize !== undefined ? `Actual size: ${details.actualSize}` : "",
        `Original request from @${job.requesterUsername}, MsgID ${job.sourceMessageId}: "${job.sourceQuote}"`,
        `Generation prompt: ${job.input.prompt}`,
        typeof details?.revisedPrompt === "string" ? `Revised prompt: ${details.revisedPrompt}` : "",
      ].filter((part) => part !== "").join("\n"),
    };

    const completionInstruction = runtimeContextTemplate("async-image-ready", {
      jobId: job.id,
      requesterUsername: job.requesterUsername,
      is4k: job.input.is4k ? "yes" : "no",
      transportLine: details?.transport !== undefined ? `Transport: ${details.transport}\n` : "",
      requestedSizeLine: details?.requestedSize !== undefined ? `Requested size: ${details.requestedSize}\n` : "",
      actualSizeLine: details?.actualSize !== undefined ? `Actual size: ${details.actualSize}\n` : "",
      sourceMessageId: job.sourceMessageId,
      sourceQuote: job.sourceQuote,
      generationPrompt: job.input.prompt,
      revisedPromptLine: typeof details?.revisedPrompt === "string" ? `Revised prompt: ${details.revisedPrompt}\n` : "",
    }, `[Async Image Job Ready] Job ${job.id} generated an image.`);
    const sentMessageId = await runAsyncImageStatusTurn({
      event: "ready",
      instruction: completionInstruction,
      attachment: outboundAttachment,
    });
    if (sentMessageId === undefined) {
      throw new Error("Async image completion did not send a Discord message.");
    }
    ambientRuntime.noteAmbientBotReply({
      guildId: job.deliveryGuildId,
      channelId: job.deliveryChannelId,
      userId: job.requesterId,
      sourceMessageId: job.sourceMessageId,
      botMessageId: sentMessageId,
      allowLease: true,
      allowFollowUp: false,
    });
    agentJobs.markSent(job.id, sentMessageId, {
      attachmentId: outboundAttachment.id,
      filename: outboundAttachment.filename,
      contentType: outboundAttachment.contentType,
      is4k: job.input.is4k,
      ...(details?.transport !== undefined ? { transport: details.transport } : {}),
      ...(details?.requestedSize !== undefined ? { requestedSize: details.requestedSize } : {}),
      ...(details?.actualSize !== undefined ? { actualSize: details.actualSize } : {}),
      ...(typeof details?.revisedPrompt === "string" ? { revisedPrompt: details.revisedPrompt } : {}),
    } satisfies ImageGenerationJobResult);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    requestLog.setError(message);
    if (imageToolStarted && !imageToolEnded) {
      requestLog.recordToolEnd(imageToolCallId, true, {
        content: [{ type: "text", text: message }],
      });
      imageToolEnded = true;
    }
    if (controller.signal.aborted && agentJobs.get(job.id)?.status === "cancelled") return;
    const timedOut = controller.signal.aborted && message.includes("timed out");
    if (timedOut) {
      agentJobs.markTimedOut(job.id, message);
    } else {
      agentJobs.markFailed(job.id, message);
    }
    const latest = agentJobs.get(job.id);
    if (latest?.status === "failed" || latest?.status === "timed_out") {
      try {
        const failureInstruction = runtimeContextTemplate("async-image-failed", {
          jobId: job.id,
          statusText: latest.status === "timed_out" ? "timed out" : "failed",
          requesterUsername: job.requesterUsername,
          sourceMessageId: job.sourceMessageId,
          sourceQuote: job.sourceQuote,
          generationPrompt: job.input.prompt,
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
    clearInterval(typingTimer);
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
  input: Omit<Parameters<typeof createDiscordMessageSender>[0], "db" | "embeddingQueue" | "buildOutboundResolvers">,
): MessageSender {
  return createDiscordMessageSender({
    db,
    embeddingQueue,
    buildOutboundResolvers,
    ...input,
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
  resolveImageAttachments?: ImageAttachmentResolver;
  overrides?: Partial<HandlerDeps>;
}): HandlerDeps {
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
    modelImageInputSupport: modelImageSupport.get(globalConfig, input.guildConfig),
    ...(input.tts ?? {}),
    ...(input.generatedImages !== undefined
      ? { consumeGeneratedAttachments: input.generatedImages.consumeGeneratedAttachments }
      : {}),
    ...(input.resolveImageAttachments !== undefined ? { resolveImageAttachments: input.resolveImageAttachments } : {}),
    nativeReasoningContinuation: {
      load: (continuationInput) => {
        try {
          return getCodexReasoningContinuation(db, continuationInput)?.providerNativeContent;
        } catch (error) {
          input.log.warn("codex reasoning continuation load failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      },
      save: (continuationInput) => {
        try {
          upsertCodexReasoningContinuation(db, continuationInput);
        } catch (error) {
          input.log.warn("codex reasoning continuation save failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    ...input.overrides,
  };
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
let globalConfig = loadGlobalConfig();
validateTrimConfig(globalConfig.defaultTrim);
validateVpnConfig(globalConfig.vpn);
log.info("config loaded", { model: globalConfig.defaultModel, qdrant: globalConfig.qdrantUrl });

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

// --- 4. Init Qdrant ---
const qdrant = createQdrantClient({ url: globalConfig.qdrantUrl });
const qdrantHealthy = await healthCheck(qdrant);
if (!qdrantHealthy) {
  log.error("qdrant health check failed", { url: globalConfig.qdrantUrl });
  process.exit(1);
}
await ensureCollection(qdrant);
log.info("qdrant ready");

// --- 5. Init embedding pipeline ---
const embeddingPipeline = await getEmbeddingPipeline({ cacheDir: globalConfig.modelCacheDir });
log.info("embedding pipeline ready");

// --- 6. Init embedding queue ---
const embeddingQueue: EmbeddingQueue = createEmbeddingQueue(embeddingPipeline, qdrant);

// --- 7. Load guild configs ---
const guildsDir = join("config", "guilds");
const guildConfigs = loadGuildConfigs(guildsDir, globalConfig);
log.info("guild configs loaded", { count: guildConfigs.size });

const agentJobs = new AgentJobStore(globalConfig.defaultAgentJobs);
const agentJobCleanupTimer = setInterval(() => {
  const removed = agentJobs.cleanup();
  if (removed > 0) log.debug("agent jobs cleaned up", { removed });
}, 60_000);

const modelImageSupport = createModelImageSupportStore({ log });
await modelImageSupport.refresh(globalConfig, guildConfigs, "startup");

// --- 8. Load prompt bundle. prompts/system/** and prompts/core/** are stable instructions; runtime prompts are scoped.
let promptBundle: PromptBundle = loadPromptBundle("prompts", log);

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

// --- 12. Init scheduler ---
const scheduler: SchedulerEngine = createSchedulerEngine({
  db,
  onFire: createScheduledTaskRunner({
    client,
    db,
    embeddingQueue,
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
    persistIgnoredBotReply,
    runLoggedAgentTurn,
    runMemoryPostReplyExtraction,
    runRelationshipPostReplyExtraction,
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
  const continuationTtl = Math.max(
    globalConfig.defaultReasoningContinuation.maxAgeMs,
    ...[...guildConfigs.values()].map((guildConfig) => guildConfig.reasoningContinuation.maxAgeMs),
  );
  const deletedContinuations = deleteExpiredCodexReasoningContinuations(db, continuationTtl);
  if (deletedContinuations > 0) {
    log.info("expired codex reasoning continuations cleaned", { deleted: deletedContinuations });
  }
}, MEMORY_CLEANUP_INTERVAL_MS);

// --- 13. Wait for Discord client login ---
await discordLoginPromise;

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
  } catch (err) {
    log.error("failed to register slash commands", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

registerInteractionRuntime({
  client,
  db,
  qdrant,
  scheduler,
  getGlobalConfig: () => globalConfig,
  getGuildConfig,
  vpnClient,
  vpnSessionStore,
  vpnEnabled,
  startTime,
  log,
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
    isBot: false,
  });
  const previousUserAnyMessage = getLatestMessageActivityBefore(db, {
    ...before,
    userId: input.latestUserMessage.authorId,
    isBot: false,
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

type RelationshipContextRunMode = "live" | "virtual";

function buildRelationshipPromptContext(input: {
  guildConfig: GuildConfig;
  latestUserMessage: HistoryMessage;
  visibleUserIds: string[];
  resolveUserLabel: (userId: string) => string;
  contactContext?: string;
  mode: RelationshipContextRunMode;
}): string {
  const config = getRelationshipConfig(input.guildConfig);
  if (!config.enabled || !config.promptInjection) return "";
  void input.mode;
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
  });
}

function blockToolsExcept(tools: AgentTool[], allowedName: string, passLabel: string): AgentTool[] {
  return tools.map((tool) => tool.name === allowedName
    ? tool
    : {
        ...tool,
        execute: (_toolCallId: string, _params: unknown): Promise<AgentToolResult<unknown>> => Promise.resolve({
          content: [{
            type: "text",
            text: allowedName === ""
              ? `Blocked: ${passLabel} cannot use ${tool.name}. record_memory and record_relationship are not available in this mode.`
              : `Blocked: ${passLabel} may only use ${allowedName}. Do not call ${tool.name} in this pass.`,
          }],
          details: { blocked: true, pass: passLabel, allowedTool: allowedName, tool: tool.name },
        }),
	      });
}

const maintenanceToolNames = new Set(["record_memory", "record_relationship"]);

function toolsForMaintenancePass(
  visibleTools: AgentTool[] | undefined,
  maintenanceTools: AgentTool[],
  allowedName: "record_memory" | "record_relationship",
  passLabel: string,
): AgentTool[] {
  const byName = new Map<string, AgentTool>();
  for (const tool of visibleTools ?? []) {
    if (!maintenanceToolNames.has(tool.name)) byName.set(tool.name, tool);
  }
  for (const tool of maintenanceTools) byName.set(tool.name, tool);
  return blockToolsExcept([...byName.values()], allowedName, passLabel);
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

function createPostReplyMaintenanceTools(input: {
  guild: Guild;
  guildConfig: GuildConfig;
  memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0];
  currentUserId: string;
  currentUsername?: string;
  sourceMessageId: string;
  dryRun?: boolean;
  dryRuns?: Array<{ tool: string; args: unknown }>;
  onRelationshipResult?: (result: RelationshipMutationResult, candidates: unknown[]) => void;
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
      const cached = resolveGuildUsername(input.guild, username);
      if (cached !== undefined) return cached;
      try {
        await input.guild.members.fetch();
      } catch {
        // Cache-only fallback below handles missing permissions.
      }
      return resolveGuildUsername(input.guild, username);
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
      userId: input.memoryRequest.incomingMessage.authorId,
      sourceMessageId: input.memoryRequest.sourceMessageId,
    },
    onResult: (result, candidates) => input.onRelationshipResult?.(result, candidates),
  });
  return [
    promptLabMemoryDryRunTool(recordMemoryTool, input.dryRuns),
    recordRelationshipTool,
  ];
}

async function runMemoryPostReplyExtraction(input: {
  guildConfig: GuildConfig;
  memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0];
  guild: Guild;
  channel: unknown;
  sourceRequestId: string;
  source?: string;
  currentUserId: string;
  currentUsername?: string;
  dryRun?: boolean;
  dryRuns?: Array<{ tool: string; args: unknown }>;
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
  const maintenanceTools = createPostReplyMaintenanceTools({
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
    resolveUserId: (userId) => input.guild.members.cache.get(userId)?.user.username,
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
      visibleUserMemoryContext,
      tools: toolsForMaintenancePass(input.memoryRequest.availableTools, maintenanceTools, "record_memory", "silent memory pass"),
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
  const maintenanceTools = input.guild === undefined
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
      tools: toolsForMaintenancePass(input.memoryRequest.availableTools, maintenanceTools, "record_relationship", "silent relationships pass"),
      runtimeInstruction: promptBundle.runtime.reply,
      controlMessage: [
        "## Execution Mode: Relationship Maintenance",
        "Private relationships maintenance is active. Other tool calls are not available in this mode.",
        `You may call record_relationship up to ${config.maxToolCalls} times; make one focused relationship update per call and stop when no useful relationship work remains.`,
        "",
        "## Post-Reply Relationship Consideration",
        "Current time:",
        currentLocalContext(input.guildConfig.timezone),
        "",
        runtimeContextTemplate(
          "relationship-pass-decision",
          {},
          "Decide silently whether relationships should be updated. Use record_relationship only if an update is useful.",
        ),
      ].join("\n"),
      modelMode: "main",
      maxToolCalls: config.maxToolCalls,
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
  } = {},
): Promise<AssembledContext> {
  // Chat history via the full processing pipeline
  const visibleJobs = agentJobs.listVisible(guildId, channelId);
  const displayNamesByUserId = buildCurrentDisplayNameMap(guild);
  const appendLatestToHistory = historyOptions.appendLatestToHistory ?? true;
  const triggerMessageIds = new Set(historyOptions.triggerMessageIds ?? []);
  const historyMessages = getContextHistoryMessages(
    db,
    channelId,
    guildConfig.trim,
    appendLatestToHistory ? (excludeMessageIds ?? latestUserMessage.id) : excludeMessageIds,
  ).map((message) => triggerMessageIds.has(message.id)
    ? { ...message, historyAnnotations: [...(message.historyAnnotations ?? []), "<trigger>"] }
    : message
  );
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
  const { olderText, newerText, visibleUserIds } = await processHistory(
    historyWithoutLatest,
    appendLatestToHistory ? annotatedLatestUserMessage : null,
    {
      trim: guildConfig.trim,
      mergeMessageGapSeconds: guildConfig.mergeMessageGapSeconds,
      timezone: guildConfig.timezone,
      imageCaptioningEnabled: guildConfig.imageCaptioningEnabled,
      replyQuoteChars: guildConfig.trim.replyQuoteChars,
      displayNamesByUserId,
    },
    replyFallbackDeps,
  );

  const memories = buildMemoryContext({
    db,
    guildId,
    currentUserId: latestUserMessage.authorId,
    resolveUserId: (userId) => guild.members.cache.get(userId)?.user.username,
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
              captioningEnabled: guildConfig.imageCaptioningEnabled,
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
      currentContext: [currentContext, relationshipsContext].filter((part) => part !== "").join("\n\n"),
      responseInstruction: "",
      userMessage,
    });
  assembled.visibleUserIds = visibleUserIds;
  const activeJobsText = renderAgentJobsContext(
    visibleJobs,
    runtimeContextTemplate("active-image-jobs", {}, "Image generation is asynchronous."),
  );
  const activeJobsIndex = assembled.sections.findIndex((s) => s.label === "Chat History — Newer");
  const activeJobsInsertAt = activeJobsIndex === -1 ? assembled.sections.length : activeJobsIndex;
  const sections = activeJobsText === ""
    ? assembled.sections
    : [
      ...assembled.sections.slice(0, activeJobsInsertAt),
      { label: "Active Image Jobs", text: activeJobsText, cached: false, role: "developer" as const },
      ...assembled.sections.slice(activeJobsInsertAt),
    ];

  return {
    ...assembled,
    sections,
    contextMessageIds,
  };
}

const ambientMemoryPasses = new Set<string>();

function collectHumanUserIds(messages: HistoryMessage[]): string[] {
  const recency = new Map<string, true>();
  for (const message of messages) {
    if (message.isBot) continue;
    recency.delete(message.authorId);
    recency.set(message.authorId, true);
  }
  return [...recency.keys()].reverse();
}

function formatAmbientMemoryHistory(messages: HistoryMessage[], timezone: string, captioningEnabled: boolean): string {
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
      captioningEnabled,
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
      resolveUserId: (userId) => guild.members.cache.get(userId)?.user.username,
      contextInstruction: promptBundle.runtime.memoryContextTemplates["other-visible-users"],
    });
    const currentUserMemories = buildMemoryContext({
      db,
      guildId,
      currentUserId: lastMessage.authorId,
      resolveUserId: (userId) => guild.members.cache.get(userId)?.user.username,
      contextInstruction: promptBundle.runtime.memoryContextTemplates.current,
    });
    const context: AssembledContext = {
      sections: [
        ...(currentUserMemories !== ""
          ? [{ label: "Memories", role: "developer" as const, cached: false, text: `## Memory\n${currentUserMemories}` }]
          : []),
        {
          label: "Chat History — Newer",
          role: "developer",
          cached: false,
          text: formatAmbientMemoryHistory(batch, guildConfig.timezone, guildConfig.imageCaptioningEnabled),
        },
      ],
      userMessage: "",
      contextMessageIds: batch.map((item) => item.id),
      visibleUserIds,
    };
    const recordMemoryTool = createRecordMemoryTool({
      db,
      guildId,
      currentUserId: lastMessage.authorId,
      currentUsername: lastMessage.author,
      sourceMessageId: lastMessage.id,
      recordMemoryDescription: runtimeToolDescription("record_memory", {}),
      resolveUsername: async (username) => {
        const cached = resolveGuildUsername(guild, username);
        if (cached !== undefined) return cached;
        try {
          await guild.members.fetch();
        } catch {
          // Cache-only fallback below handles missing permissions.
        }
        return resolveGuildUsername(guild, username);
      },
    });
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
        tools: [recordMemoryTool],
        requestLog: memoryLog,
        log: log.child({ guildId, channelId, requestId: memoryLog.requestId }),
      });
      markMemoryExtractionCheckpoint(db, {
        guildId,
        channelId,
        lastMessageId: lastMessage.id,
        lastMessageCreatedAt: lastMessage.timestamp,
      });
    } catch (err) {
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
    currentRequest?: {
      requesterId: string;
      requesterUsername: string;
      sourceMessageId: string;
      sourceQuote: string;
    };
  } = {},
) {
  const includeImageGenerationTools = options.includeImageGenerationTools ?? true;
  const effectiveCurrentRequest = options.currentRequest ?? currentRequest;
  const resolveUsername = (username: string): string | undefined => resolveGuildUsername(guild, username);
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
    qdrant,
    guildId,
    currentChannelId: channelId,
    timezone: guildConfig.timezone,
    embed: embeddingPipeline,
    resolveUsername,
    resolveUsernameInGuild,
    resolveChannel: async (targetChannelId) => {
      const channel = await fetchAccessibleGuildChannel(targetChannelId);
      return channel === null ? null : { guildId: channel.guildId, channelId: channel.id };
    },
    canAccessGuild: async (targetGuildId) => await resolveClientGuild(targetGuildId) !== null,
    excludedMessageIds,
    fetchMessage: async (chId, msgId) => {
      const channel = await fetchAccessibleGuildChannel(chId);
      if (channel === null || !("messages" in channel)) return null;
      try {
        const msg = await (channel as TextChannel).messages.fetch(msgId);
        return {
          attachments: [...msg.attachments.values()].map((a) => ({
            name: a.name,
            contentType: a.contentType,
            size: a.size,
          })),
        };
      } catch {
        return null;
      }
    },
  });

  const scheduleTools = createScheduleTools({
    db,
    guildId,
    channelId,
    timezone: guildConfig.timezone,
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

  const memoryListTool = createMemoryListTool({
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
      qdrant,
      embeddingQueue,
      ...input,
    }),
    afterDelete: (input) => syncDeletedOwnBotMessage({
      db,
      qdrant,
      ...input,
      botUserId: client.user?.id ?? "",
    }),
  });

  const readChatImagesTool = createReadChatImagesTool({
    imageReadMaxPerCall: guildConfig.imageReadMaxPerCall,
    getImageById: (id: number) => {
      const record = getImageById(db, id);
      return record !== null && record.guildId === guildId ? record : null;
    },
    readFile: (path: string) => {
      try {
        return Buffer.from(readFileSync(path));
      } catch {
        return null;
      }
    },
    prepareImageForContext: (buffer, mimeType) =>
      prepareImageBufferForContext(buffer, mimeType, CONTEXT_IMAGE_MAX_DIMENSION),
  });

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
    maxImagesPerCall: 5,
    maxDimension: CONTEXT_IMAGE_MAX_DIMENSION,
  });

  const fetchUrlTool = createFetchUrlTool();
  const summarizeVideoTool = createSummarizeVideoTool();
  const reactToMessageTool = createReactToMessageTool({
    currentChannelId: channelId,
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

  const tools = [searchTool, ...scheduleTools, chatUserListTool, channelListTool, emojiListTool, ...discordTimeoutTools, memoryListTool, listChannelMessagesTool, ...ownMessageTools, readChatImagesTool, readUserAvatarTool, fetchImagesTool, fetchUrlTool, summarizeVideoTool, reactToMessageTool];
  if (includeImageGenerationTools) {
    const codexImageModel = guildConfig.llmProvider === "openai-codex"
      ? guildConfig.model ?? globalConfig.defaultModel
      : DEFAULT_CODEX_IMAGE_ROUTER_MODEL;
    const codexGenerateImageTool = createCodexGenerateImageTool({
      codexAuthPath: globalConfig.codexAuthPath,
      model: codexImageModel,
      sessionId: `2b2v-image:${guildId}:${channelId}:${codexImageModel}`,
      logger: log.child({ component: "codex-image", guildId, channelId }),
      imageReadMaxPerCall: guildConfig.imageReadMaxPerCall,
      imageGenerationQuality: guildConfig.imageGeneration.quality,
      asyncJobAlreadyActiveTemplate: promptBundle.runtime.contextTemplates["codex-image-job-existing"],
      asyncJobStartedTemplate: promptBundle.runtime.contextTemplates["codex-image-job-started"],
      getImageById: (id: number) => {
        const record = getImageById(db, id);
        return record !== null && record.guildId === guildId ? record : null;
      },
      readFile: (path: string) => {
        try {
          return Buffer.from(readFileSync(path));
        } catch {
          return null;
        }
      },
      onGeneratedImage: onGeneratedImage ?? (() => {}),
      ...(effectiveCurrentRequest === undefined ? {} : { enqueueImageJob: (input) => {
        const deliveryChannelId = channelId;
        const deliveryGuildId = client.channels.cache.get(deliveryChannelId) !== undefined && isSendableGuildChannel(client.channels.cache.get(deliveryChannelId))
          ? (client.channels.cache.get(deliveryChannelId) as SendableGuildChannel).guildId
          : guildId;
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
          promptHash: input.promptHash,
          imageIds: input.imageIds,
          outputFormat: input.outputFormat,
          is4k: input.is4k,
          separateJob: input.separateJob,
          allowsGroupCorrections: input.allowsGroupCorrections,
          ...(input.replacesJobId !== undefined ? { replacesJobId: input.replacesJobId } : {}),
        });
        if (result.created) {
          void runImageGenerationJob(result.job.id).catch((err: unknown) => {
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
      requesterId: effectiveCurrentRequest?.requesterId ?? "unknown",
    });
    tools.push(codexGenerateImageTool, cancelJobTool);
  }

  // Brave search if API key configured
  if (globalConfig.braveApiKey !== undefined && globalConfig.braveApiKey !== "") {
    tools.push(createBraveSearchTool({ apiKey: globalConfig.braveApiKey }));
  }

  const toolPromptVariables: ToolPromptVariables = {
    fetch_images: {
      maxImagesPerCall: 5,
      maxDimension: CONTEXT_IMAGE_MAX_DIMENSION,
    },
    read_chat_images: {
      imageReadMaxPerCall: guildConfig.imageReadMaxPerCall,
    },
    codex_generate_image: {
      imageReadMaxPerCall: guildConfig.imageReadMaxPerCall,
      imageGenerationQuality: guildConfig.imageGeneration.quality,
    },
    schedule_message: {
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
  embeddingQueue,
  getPromptBundle: () => promptBundle,
  getGlobalConfig: () => globalConfig,
  typingIntervalMs: TYPING_INTERVAL_MS,
  getGuildConfig,
  dashboardTriggerLocation,
  buildInboundResolvers,
  createSyntheticReplyFallbackDeps,
  buildContext,
  buildAgentTools,
  promptLabDryRunTools,
  promptLabSyntheticId,
  promptLabSummary,
  resolveClientGuild,
  fetchAccessibleGuildChannel,
  promptLabUserFromGuild,
  createBotDiscordMessageSender,
  createHandlerDeps,
  processTriggeredMessage,
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

function evaluateMessageTrigger(message: Message, guildConfig: GuildConfig): TriggerResult {
  return shouldRespond(
    {
      content: message.content,
      authorId: message.author.id,
      botUserId: client.user?.id ?? "",
      mentionedUserIds: [...message.mentions.users.keys()],
      repliedToBot: messageRepliesToOwnBot(message),
    },
    guildConfig.triggers,
  );
}

/** Process a triggered message through the full handler pipeline. */
async function processTriggeredMessage(
  message: Message,
  triggerOverride?: NonNullable<TriggerResult>,
  currentTurnMessages: readonly Message[] = [message],
  options: {
    disableLiveOutput?: boolean;
    defaultReply?: boolean;
    triggerInstruction?: string;
    currentTurnOverride?: {
      messageId: string;
      timestamp: number;
      content: string;
    };
    preSendCheck?: () => boolean | Promise<boolean>;
    onWriteToolStart?: (toolName: string) => void;
  } = {},
): Promise<DispatchOutcome> {
  if (message.guild === null || message.guildId === null) return { coveredMessageIds: [] };
  const guild = message.guild;

  const guildId = message.guildId;
  const channelId = message.channelId;
  requestLogStore.incrementActive();
  const guildConfig = getGuildConfig(guildId);
  let activeTyping: ReturnType<typeof createTypingController> | null = null;

  try {
    const inboundResolvers = buildInboundResolvers(guild);
    const translatedContent = appendStickerTags(
      translateInbound(message.content, inboundResolvers),
      message.stickers.values(),
    );
    const currentTurnEventContent = options.currentTurnOverride?.content ?? currentTurnMessages
      .map((current) => appendStickerTags(
        translateInbound(current.content, inboundResolvers),
        current.stickers.values(),
      ))
      .filter((content) => content !== "")
      .join(" [msg-break] ");
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
      getAttachmentsDir: (targetGuildId) => getGuildConfig(targetGuildId).attachmentsDir,
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

    const ingestedImages = getImagesByMessageId(db, message.id);
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
      isBot: false,
      timestamp: options.currentTurnOverride?.timestamp ?? message.createdTimestamp,
      replyToId: message.reference?.messageId ?? null,
      imageIds: options.currentTurnOverride === undefined ? ingestedImages.map((img) => img.id) : [],
      captions: options.currentTurnOverride === undefined ? ingestedImages.map((img) => img.caption ?? "") : [],
      imageSourceKinds: options.currentTurnOverride === undefined ? ingestedImages.map((img) => img.sourceKind) : [],
      hasEmbeds: options.currentTurnOverride === undefined && message.embeds.length > 0,
      isSynthetic: false,
      relatedThreadId: null,
    };

    const replyFallbackDeps = createDiscordReplyFallbackDeps({
      db,
      embeddingQueue,
      clientChannelsFetch: (chId) => client.channels.fetch(chId),
      guild,
      guildId,
      channelId,
      guildConfig,
    });

    const isThread = message.channel.isThread();
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
        triggerMessageIds: currentTurnMessageIds,
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
      {},
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
      messageId: options.currentTurnOverride?.messageId ?? message.id,
      replyToMessageId: message.reference?.messageId,
      repliedToBot: messageRepliesToOwnBot(message),
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
    }), "", "visible reply mode");

    const requestLog = new RequestLog(guildId, channelId, requestLogStore);
    requestLog.setAuthor(message.author.username);
    requestLog.setTriggerContext({
      ...dashboardTriggerLocation(guild, message.channel),
      messageId: options.currentTurnOverride?.messageId ?? message.id,
      authorUsername: message.author.username,
      content: options.currentTurnOverride?.content ?? message.content,
      translatedContent: options.currentTurnOverride?.content ?? translatedContent,
    });

    const tts = createTtsGenerator(guildConfig);

    const deps = createHandlerDeps({
      guildConfig,
      context,
      currentChannelId: channelId,
      sender,
      extraTools: [...extraTools, ...visibleMaintenanceTools],
      log: log.child({ guildId, channelId, requestId: requestLog.requestId }),
      requestLog,
      tts,
      generatedImages,
      resolveImageAttachments: createStoredImageAttachmentResolver({
        db,
        guildId,
        logger: log.child({ component: "stored-image-attachments", guildId, channelId, requestId: requestLog.requestId }),
      }),
      overrides: {
        onTriggered: () => {
          if (!guildConfig.typingSimulation.enabled) typing.startLoop();
        },
        onStillWorking: (destinationChannelId) => { typing.startLoop(destinationChannelId); },
        getTypingStartedAt: typing.getTypingStartedAt,
        onVisibleOutput: typing.stopLoop,
        onAgentEnd: typing.stopLoop,
        triggerOverride,
        triggerInstructions: options.triggerInstruction !== undefined && triggerOverride !== undefined
          ? { ...guildConfig.triggerInstructions, [triggerOverride.reason]: options.triggerInstruction }
          : guildConfig.triggerInstructions,
        disableLiveOutput: options.disableLiveOutput,
        replyFirstOverride: options.defaultReply,
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
        },
      },
    });

    await runLoggedAgentTurn({
      incoming,
      deps,
      requestLog,
      logger: log,
      afterSuccess: (completed) => {
        if (completed.responseText === undefined || completed.responseText === "" || sentBotMessageIds[0] === undefined) return;
        ambientRuntime.noteAmbientBotReply({
          guildId,
          channelId,
          userId: message.author.id,
          sourceMessageId: message.id,
          botMessageId: sentBotMessageIds[0],
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
    return {
      coveredMessageIds: currentTurnMessageIds,
    };
  } catch (err) {
    log.error("messageCreate handler error", {
      messageId: message.id,
      guildId: message.guildId,
      error: err instanceof Error ? err.message : String(err),
    });
    const notice = buildPublicErrorNoticeForError(err, globalConfig.uiLang);
    const channel = message.channel;
    if ("send" in channel && typeof channel.send === "function") {
      try {
        await channel.send(notice);
      } catch (sendErr) {
        log.warn("failed to send system error notice", {
          messageId: message.id,
          guildId: message.guildId,
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
      }
    }
    return { coveredMessageIds: [] };
  } finally {
    activeTyping?.stopLoop();
    if (!message.author.bot) {
      requestLogStore.decrementActive();
    }
  }
}

// --- 22. typingStart handler ---
client.on("typingStart", (typing: Typing) => {
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

registerReactionSyncRuntime({ client, db, log });

/** Queue Discord messages that arrive before startup dependencies are ready. */
function handleMessageCreateEvent(message: Message): void {
  if (!startupMessageProcessingReady || startupMessageQueueDraining) {
    startupMessageQueue.push(message);
    return;
  }

  void processDiscordMessageCreate(message);
}

function drainStartupMessageQueue(): void {
  if (startupMessageQueueDraining) return;
  startupMessageQueueDraining = true;
  const queued = startupMessageQueue.length;
  if (queued > 0) log.info("draining startup Discord message queue", { queued });
  try {
    while (startupMessageQueue.length > 0) {
      const message = startupMessageQueue.shift();
      if (message !== undefined) void processDiscordMessageCreate(message);
    }
  } finally {
    startupMessageQueueDraining = false;
  }
}

// --- 23. messageCreate handler ---
async function processDiscordMessageCreate(message: Message): Promise<void> {
  try {
    // Ignore bots (including self)
    if (message.author.bot) return;
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
    const translatedContent = appendStickerTags(
      translateInbound(message.content, inboundResolvers),
      message.stickers.values(),
    );

    // Store message in SQLite using Discord time so prompt-history lookups can
    // exclude the current turn precisely.
    const messageCreatedAt = message.createdTimestamp;
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT OR IGNORE INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(message.id, guildId, channelId, message.author.id, message.author.username, message.content, translatedContent, 0, messageCreatedAt, message.reference?.messageId ?? null);

    // Enqueue for embedding
    void embeddingQueue.enqueue({
      id: message.id,
      text: translatedContent,
      target: "message",
      metadata: {
        guild_id: guildId,
        channel_id: channelId,
        user_id: message.author.id,
        created_at: messageCreatedAt,
        is_bot: false,
        source: "live",
        embedding_kind: "single",
      },
    }).catch((err: unknown) => {
      log.error("embedding enqueue failed", {
        messageId: message.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Update thread activity if message is in a thread
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

    // Process and persist images (no inline payloads — LLM uses read_images tool)
    const ingestDeps: ImageIngestDeps = {
      db,
      attachmentsDir: guildConfig.attachmentsDir,
      maxDimension: guildConfig.imageMaxDimension,
      fetchFn: fetch,
    };
    const imageIngestPromises: Promise<void>[] = [];
    for (const attachment of message.attachments.values()) {
      const contentType = attachment.contentType ?? "";
      if (!contentType.startsWith("image/")) continue;
      imageIngestPromises.push(
        processAndStoreImage(
          ingestDeps,
          {
            url: attachment.url,
            mimeType: contentType,
            messageId: message.id,
            guildId,
            channelId,
            sourceKind: imageKindForAttachment(contentType, attachment.name),
          },
        ).then(() => undefined).catch((err: unknown) => {
          log.warn("image ingest failed", {
            attachmentId: attachment.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
    }

    // Extract images from embeds (Tenor/Giphy GIFs appear here, not in attachments)
    for (const embed of message.embeds) {
      const embedUrl = embed.image?.url ?? embed.thumbnail?.url;
      if (embedUrl === undefined) continue;

      imageIngestPromises.push(
        processAndStoreImage(ingestDeps, {
          url: embedUrl,
          mimeType: guessImageMimeFromUrl(embedUrl),
          messageId: message.id,
          guildId,
          channelId,
          sourceKind: imageKindForEmbed({ type: embed.data.type, url: embed.url, provider: embed.provider }, embedUrl),
        }).then(() => undefined).catch((err: unknown) => {
          log.warn("embed image ingest failed", {
            embedUrl,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
    }

    for (const sticker of message.stickers.values()) {
      const preview = stickerImagePreview({
        name: sticker.name,
        url: sticker.url,
        format: sticker.format,
      });
      if (preview === null) continue;
      imageIngestPromises.push(
        processAndStoreImage(ingestDeps, {
          url: preview.url,
          mimeType: preview.mimeType,
          messageId: message.id,
          guildId,
          channelId,
          sourceKind: preview.sourceKind,
        }).then(() => undefined).catch((err: unknown) => {
          log.warn("sticker image ingest failed", {
            stickerName: sticker.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
    }

    await Promise.allSettled(imageIngestPromises);

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

// --- 24. messageDelete handler ---
client.on("messageDelete", (message) => void (async () => {
  try {
    if (message.guildId === null) return;

    const messageId = message.id;
    const guildId = message.guildId;
    const result = await cleanupDeletedDiscordMessage({ db, qdrant, guildId, messageId });
    if (result.messagesDeleted === 0) return;

    log.debug("message deleted from Discord", { messageId, guildId, images: result.imagesDeleted });
  } catch (err) {
    log.error("messageDelete handler error", {
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
})());

// --- Hot-reload config watcher ---
const CONFIG_RELOAD_DEBOUNCE_MS = 500;
const CONFIG_RELOAD_POLL_MS = 5000;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let configReloadPollTimer: ReturnType<typeof setInterval> | null = null;
let lastConfigFingerprint = configReloadFingerprint();

function scheduleConfigReload(): void {
  if (reloadTimer !== null) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void reloadConfigs(), CONFIG_RELOAD_DEBOUNCE_MS);
}

function configReloadFingerprint(): string {
  const paths = ["config/config.yaml", "config/guilds"];
  const parts: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    parts.push(`${path}:${stat.mtimeMs}:${stat.size}`);
    if (!stat.isDirectory()) continue;
    for (const entry of readdirSync(path).filter((name) => name.endsWith(".yaml") || name.endsWith(".yml")).sort()) {
      const filePath = `${path}/${entry}`;
      const fileStat = statSync(filePath);
      if (fileStat.isFile()) parts.push(`${filePath}:${fileStat.mtimeMs}:${fileStat.size}`);
    }
  }
  return parts.join("|");
}

async function reloadConfigs(): Promise<void> {
  try {
    const newGlobal = loadGlobalConfig(
      process.env as Record<string, string | undefined>,
    );
    validateTrimConfig(newGlobal.defaultTrim);

    // Reload guild configs — clear and rebuild
    const newGuilds = loadGuildConfigs(guildsDir, newGlobal);
    await modelImageSupport.refresh(newGlobal, newGuilds, "hot_reload");

    globalConfig = newGlobal;
    promptBundle = loadPromptBundle("prompts", log);

    guildConfigs.clear();
    for (const [id, cfg] of newGuilds) {
      guildConfigs.set(id, cfg);
    }

    // Invalidate dispatchers so they pick up new config on next enqueue
    for (const d of dispatchers.values()) d.dispose();
    dispatchers.clear();
    ambientRuntime.clearAmbientAttentionState();
    ambientRuntime.clearAmbientInitiativeState();
    ambientRuntime.startAmbientInitiativeLoops();

    log.info("config hot-reloaded", { model: globalConfig.defaultModel, guilds: guildConfigs.size });
  } catch (err) {
    log.error("config hot-reload failed, keeping previous config", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

if (existsSync("config")) {
  const watcher = watch("config", { recursive: true }, (_event, _filename) => {
    lastConfigFingerprint = configReloadFingerprint();
    scheduleConfigReload();
  });

  // Prevent watcher from keeping the process alive during shutdown
  watcher.unref();
  log.info("config hot-reload watcher started");

  configReloadPollTimer = setInterval(() => {
    const fingerprint = configReloadFingerprint();
    if (fingerprint === lastConfigFingerprint) return;
    lastConfigFingerprint = fingerprint;
    scheduleConfigReload();
  }, CONFIG_RELOAD_POLL_MS);
  configReloadPollTimer.unref();
  log.info("config hot-reload poller started", { intervalMs: CONFIG_RELOAD_POLL_MS });
}

if (existsSync("prompts")) {
  const watcher = watch("prompts", { recursive: true }, (_event, _filename) => {
    scheduleConfigReload();
  });

  watcher.unref();
  log.info("prompt hot-reload watcher started");
}

// --- Health check summary ---
log.info("health check passed — all systems ready", {
  uptimeMs: Date.now() - startTime,
  guilds: guildConfigs.size,
  schedulerJobs: scheduler.activeCount(),
});
startupMessageProcessingReady = true;
drainStartupMessageQueue();
ambientRuntime.startAmbientInitiativeLoops();

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
  promptLabUserFromGuild,
});

const dashboardPassword = process.env.DASHBOARD_PASSWORD;
const bypassDashboardAuth = process.env.UNSAFELY_BYPASS_DASHBOARD_AUTH === "true";
const dashboardPasswordlessCidrs = parseDashboardPasswordlessCidrs(process.env.DASHBOARD_PASSWORDLESS_CIDRS);
const dashboardTrustedProxyCidrs = parseDashboardPasswordlessCidrs(process.env.DASHBOARD_TRUSTED_PROXY_CIDRS);
const dashboardManagementRuntime = createDashboardManagementRuntime({ client, db, qdrant, embeddingQueue });
const dashboardManagement = {
  getDirectory: dashboardManagementRuntime.getDirectory,
  listMessages: dashboardManagementRuntime.listMessages,
  editMessage: dashboardManagementRuntime.editMessage,
  deleteMessages: dashboardManagementRuntime.deleteMessages,
  deleteLatestMessages: dashboardManagementRuntime.deleteLatestMessages,
  runPromptLab,
  runPromptLabAmbientInitiative: ambientRuntime.runPromptLabAmbientInitiative,
  listMemories: dashboardManagementRuntime.listMemories,
  editMemory: dashboardManagementRuntime.editMemory,
  deleteMemory: dashboardManagementRuntime.deleteMemory,
  relationships: createRelationshipsManagementApi({
    db,
    getGlobalConfig: () => globalConfig,
    getGuildConfig: () => resolveGuildConfig(globalConfig, { guildId: "dashboard", slug: "dashboard" }),
  }),
};
if (bypassDashboardAuth) {
  startDashboard({ port: 3000, password: "", bypassAuth: true, management: dashboardManagement, log });
  log.warn("dashboard started with auth bypass — do not use in production");
} else if (dashboardPassword !== undefined && dashboardPassword !== "") {
  startDashboard({
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

  clearInterval(memoryCleanupTimer);
  clearInterval(vpnSessionCleanupTimer);
  clearInterval(agentJobCleanupTimer);
  if (configReloadPollTimer !== null) clearInterval(configReloadPollTimer);
  for (const d of dispatchers.values()) d.dispose();
  dispatchers.clear();
  ambientRuntime.clearAmbientAttentionState();
  ambientRuntime.clearAmbientInitiativeState();
  scheduler.stop();
  await client.destroy();
  await embeddingQueue.shutdown();
  await disposePipeline();
  db.close();

  log.info("shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

export { db, qdrant, embeddingQueue, guildConfigs, globalConfig, promptBundle, scheduler, client };
