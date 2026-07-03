import { createLogger, RequestLog, type LogLevel, type Logger } from "./logger";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { requestLogStore } from "./dashboard/store";
import { parseDashboardPasswordlessCidrs, startDashboard } from "./dashboard/server";
import { loadGlobalConfig, loadGuildConfigs, resolveGuildConfig, validateTrimConfig, validateVpnConfig } from "./config/loader";
import type { AmbientAttentionConfig, AmbientAttentionKind, AmbientAttentionModeConfig, AmbientInitiativeConfig, AmbientInitiativeKind, AmbientInitiativeKindConfig, GuildConfig } from "./config/types";
import { createDatabase } from "./db/database";
import { createQdrantClient, ensureCollection, healthCheck } from "./qdrant/client";
import { deleteMessagePointsByMessageId } from "./qdrant/adapter";
import { getEmbeddingPipeline, disposePipeline } from "./embeddings/pipeline";
import { createEmbeddingQueue, type EmbeddingQueue } from "./embeddings/queue";
import { createDiscordClient, loginDiscordClient } from "./discord/client";
import { sendWithUnknownMessageReferenceFallback } from "./discord/message-reference-retry";
import { translateInbound, translateOutbound, buildDisplayNameContext, type InboundResolvers, type OutboundResolvers } from "./discord/translation";
import { splitMessage } from "./discord/split-message";
import { EmojiCache, buildEmojiContext, type EmojiEntry } from "./discord/emoji-cache";
import { appendStickerTags, guessImageMimeFromUrl, imageKindForAttachment, imageKindForEmbed, stickerImagePreview } from "./discord/message-media";
import { createSchedulerEngine, type SchedulerEngine } from "./scheduler/engine";
import { handleMessage, runSilentMemoryAgentPass, runSilentToolAgentPass, type ImageAttachmentResolver, type IncomingMessage, type HandlerDeps, type MessageSender, type OutboundAttachment } from "./agent/handler";
import { buildComputedContactContextForUser } from "./agent/contact-context";
import { shouldRespond, type TriggerResult } from "./agent/triggers";
import { buildPublicErrorNoticeForError } from "./agent/public-error-notice";
import { typingSimulationDelayMs } from "./agent/typing-simulation";
import { createChannelDispatcher, selectDispatchMessageForTrigger, selectDispatchMessagesForTrigger, type ChannelDispatcher, type DispatchOutcome } from "./discord/channel-dispatcher";
import { assembleContext, type AssembledContext, type ThreadMetadata } from "./agent/context-assembly";
import type { HistoryMessage } from "./agent/history-types";
import { getContextHistoryMessages, insertSyntheticEvent, insertPromptOnlyBotMessage, getParentPreContext, getChatHistory, deleteRecentMessages, upsertMessageReaction, deleteMessageReactions, deleteMessageEmojiReaction, upsertBotMessageContent, deleteBotMessageState, getRoutedMessageSource, getLatestMessageActivityBefore, getHistoryMessages, getMessageById, type MessageActivity, type RoutedMessageSource } from "./db/message-repository";
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
import { createSearchTool } from "./agent/search-tool";
import { createScheduleTools } from "./agent/schedule-tool";
import { createChatUserListTool, type MemberInfo } from "./agent/member-list-tool";
import { createChannelListTool, type ChannelInfo } from "./agent/channel-list-tool";
import { createEmojiListTool } from "./agent/emoji-list-tool";
import { createTimeoutUserTool, MAX_TIMEOUT_SECONDS, type TimeoutMember, type TimeoutMemberResolution } from "./agent/timeout-user-tool";
import { createMemoryListTool } from "./agent/user-memory-tool";
import { createChatHistoryTool } from "./agent/chat-history-tool";
import { createOwnMessageTools } from "./agent/own-message-tool";
import { createBraveSearchTool } from "./agent/brave-search-tool";
import { createReadChatImagesTool } from "./agent/read-chat-images-tool";
import { createReadUserAvatarTool, type AvatarSize } from "./agent/read-user-avatar-tool";
import { createFetchImagesTool } from "./agent/fetch-images-tool";
import { createCodexGenerateImageTool, type GeneratedImageAttachment } from "./agent/codex-image-tool";
import { AgentJobStore, createCancelAgentJobTool, isActiveJobStatus, type AgentJob, type ImageGenerationJobResult } from "./agent/job-runtime";
import { createFetchUrlTool } from "./agent/fetch-url-tool";
import { createSummarizeVideoTool } from "./agent/summarize-video-tool";
import { createCloseThreadTool, createStartThreadTool } from "./agent/start-thread-tool";
import { createReactToMessageTool } from "./agent/react-to-message-tool";
import { applyRuntimeToolPrompts, type ToolPromptVariables } from "./agent/runtime-tool-prompts";
import { completeLlmChat, type OpenRouterMessage } from "./llm/openrouter-chat";
import { buildAmbientAttentionStreamOptions, buildAmbientInitiativeStreamOptions, resolveGuildLlmProvider } from "./llm/client";
import { getImageById, getImagesByMessageId } from "./db/image-repository";
import { upsertThread, updateThreadActivity, markBotParticipating, markThreadArchived, listThreadsForContext, getThreadMetadata, getThread } from "./db/thread-repository";
import { imageExtensionForMime, prepareImageBufferForContext, processAndStoreImage, storeImageBufferUnmodified, type ImageIngestDeps } from "./db/image-ingest";
import { deleteExpiredMemories, countUserMemoriesByUser, deleteMemory, updateMemory, isMemoryKind, listMemories } from "./db/memory-repository";
import { deleteStoredManagementMessages, getManagementMemory, listManagementMemories, listManagementMessages, storedManagementDirectoryIds, updateStoredManagementMessageContent, type ManagementChannelLabel, type ManagementDirectory, type ManagementLabel, type ManagementMessageRow, type ManagementMemoryRow } from "./dashboard/management";
import { createRelationshipsManagementApi } from "./dashboard/relationships-management";
import {
  createRecordRelationshipTool,
  getRelationshipProfile,
  listRelationshipProfiles,
  renderRelationshipPromptContext,
  type RelationshipContextProfile,
  type RelationshipConfig,
  type RelationshipMutationResult,
} from "./relationships";
import { listUpcomingForContext, createSchedule, deleteScheduleForGuild, listSchedules } from "./db/schedule-repository";
import { registerSlashCommands } from "./commands/registry";
import { createStatusHandler, statusCommandDefinition } from "./commands/status";
import { createScheduleHandler, scheduleCommandDefinition } from "./commands/schedule";
import { createMemoryWipeHandler, memoryWipeCommandDefinition } from "./commands/memory-wipe";
import { vpnCommandDefinition } from "./commands/vpn";
import { createVpnClient, type VpnClient } from "./vpn/api-client";
import { createSessionStore, type SessionStore } from "./vpn/session";
import { handleVpnCommand, handleVpnComponent, type VpnHandlerDeps } from "./vpn/handler";
import { getVpnLocale } from "./vpn/i18n";
import { loadPromptBundle, type PromptBundle } from "./config/prompt-bundle";
import { renderPromptTemplate } from "./config/prompt-template";
import { fetchOpenRouterModelMetadata, imageInputSupportFromMetadata, resolveModel, resolveGuildModelKey, type ModelImageInputSupport } from "./llm/client";
import { resolveReactionEmojiInput } from "./discord/reaction-emoji";
import { createHash } from "node:crypto";
import { join } from "path";
import { mkdirSync, existsSync, readFileSync, watch, unlinkSync } from "fs";
import type { Database } from "./db/database";
import { AttachmentBuilder, ChannelType, MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction, type Client, type Guild, type GuildBasedChannel, type GuildMember, type GuildTextBasedChannel, type Message, type MessageReaction, type PartialMessage, type PartialMessageReaction, type TextChannel, type ThreadChannel, type Typing } from "discord.js";

const pkg = await Bun.file(new URL("../package.json", import.meta.url).pathname).json() as { version?: string };
const CONTEXT_IMAGE_MAX_DIMENSION = 1024;
const version: string = pkg.version ?? "0.0.0";

const startTime = Date.now();
const logLevel = (process.env.LOG_LEVEL ?? "info") as LogLevel;
const log = createLogger({ level: logLevel });

type AttachmentSendPayload = {
  content?: string;
  files?: AttachmentBuilder[];
  nonce?: string;
  enforceNonce?: boolean;
};
type SendableGuildChannel = GuildTextBasedChannel & { sendTyping: () => Promise<void> };
type ResolveTargetChannel = (channelId: string | undefined) => Promise<SendableGuildChannel>;

const TYPING_INTERVAL_MS = 8_000;
const DEFAULT_CODEX_IMAGE_ROUTER_MODEL = "gpt-5.2";

/** Build a Discord create-message nonce short enough for the API from one logical send key. */
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

function createGeneratedImageRuntime(): {
  onGeneratedImage: (attachment: GeneratedImageAttachment) => void;
  consumeGeneratedAttachments: (ids: string[]) => OutboundAttachment[];
} {
  const images = new Map<string, GeneratedImageAttachment>();
  return {
    onGeneratedImage: (attachment) => {
      images.set(attachment.id, attachment);
    },
    consumeGeneratedAttachments: (ids) => {
      const attachments: OutboundAttachment[] = [];
      for (const id of ids) {
        const image = images.get(id);
        if (image === undefined) continue;
        images.delete(id);
        attachments.push({
          id: image.id,
          buffer: image.buffer,
          filename: image.filename,
          contentType: image.contentType,
          historyText: image.revisedPrompt ?? image.prompt,
          requestedSize: image.requestedSize,
          actualSize: image.actualSize,
          transport: image.transport,
          is4k: image.is4k,
        });
      }
      return attachments;
    },
  };
}

function shortQuote(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatJobErrorForContext(error: string): string {
  const responseTextMarker = "Response text:";
  const responseTextIndex = error.indexOf(responseTextMarker);
  if (responseTextIndex >= 0) {
    const responseText = error.slice(responseTextIndex + responseTextMarker.length).trim();
    if (responseText !== "") return ` error response: "${shortQuote(responseText, 400)}"`;
  }
  return ` error: ${shortQuote(error, 200)}`;
}

function formatJobAge(job: AgentJob, now: number): string {
  const started = job.startedAt ?? job.createdAt;
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  return `${seconds}s ago`;
}

function renderAgentJobsContext(jobs: AgentJob[], now = Date.now()): string {
  if (jobs.length === 0) return "";
  const lines = [
    "## Active Image Jobs",
    runtimeContextTemplate("active-image-jobs", {}, "Image generation is asynchronous."),
  ];
  for (const job of jobs) {
    const state = isActiveJobStatus(job.status) ? "active" : "recent terminal";
    const replacement = job.replacesJobId !== undefined ? ` replaces ${job.replacesJobId}` : "";
    const sent = job.sentMessageId !== undefined ? ` sent MsgID ${job.sentMessageId}` : "";
    const error = job.error !== undefined ? formatJobErrorForContext(job.error) : "";
    const highRes = job.input.is4k ? " 4K" : "";
    const delivery = job.deliveryGuildId !== job.guildId || job.deliveryChannelId !== job.channelId
      ? ` delivery channel ${job.deliveryChannelId}`
      : "";
    lines.push(
      `- ${job.id} ${job.status}${highRes} (${state}) for @${job.requesterUsername} from MsgID ${job.sourceMessageId}${delivery}${replacement}; requested ${formatJobAge(job, now)}; quote: "${job.sourceQuote}"${sent}${error}`,
    );
  }
  return lines.join("\n");
}

function annotateHistoryJobs(
  messages: HistoryMessage[],
  guildId: string,
  channelId: string,
): HistoryMessage[] {
  return messages.map((message) => {
    const annotations = agentJobs.annotationForMessage(message.id, guildId, channelId);
    if (annotations.length === 0) return message;
    return { ...message, jobAnnotations: [...(message.jobAnnotations ?? []), ...annotations] };
  });
}

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
    const sender = createDiscordMessageSender({
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

    const replyFallbackDeps: ReplyFallbackDeps = {
      db,
      guildId: job.deliveryGuildId,
      channelId: job.deliveryChannelId,
      fetchDiscordMessage: async (chId, msgId) => {
        const ch = await client.channels.fetch(chId).catch(() => guild.channels.cache.get(chId) ?? null);
        if (ch === null || !("messages" in ch)) return null;
        try {
          const fetched = await (ch as TextChannel).messages.fetch(msgId);
          return {
            id: fetched.id,
            authorId: fetched.author.id,
            authorUsername: fetched.author.username,
            authorDisplayName: authorDisplayName(fetched),
            content: fetched.content,
            timestamp: fetched.createdTimestamp,
            isBot: fetched.author.bot,
            replyToId: fetched.reference?.messageId ?? null,
            attachments: [...fetched.attachments.values()].map((a) => ({
              url: a.url,
              contentType: a.contentType,
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
        } catch { return null; }
      },
      enqueueEmbedding: async (id, text, metadata) => {
        await embeddingQueue.enqueue({ id, text, target: "message", metadata });
      },
      processImage: async (url, contentType, messageId, sourceKind) => {
        const ingestDeps: ImageIngestDeps = {
          db,
          attachmentsDir: deliveryGuildConfig.attachmentsDir,
          maxDimension: deliveryGuildConfig.imageMaxDimension,
          fetchFn: fetch,
        };
        await processAndStoreImage(ingestDeps, { url, mimeType: contentType, messageId, guildId: job.deliveryGuildId, channelId: job.deliveryChannelId, sourceKind });
      },
    };
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
    const { ttsEnabled, generateSpeech } = createTtsGenerator(deliveryGuildConfig);
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
    const completionResult = await handleMessage(completionIncoming, {
      globalConfig,
      guildConfig: deliveryGuildConfig,
      context,
      currentChannelId: job.deliveryChannelId,
      systemPrompt: promptBundle.systemPrompt,
      personaPrompt: promptBundle.corePrompt,
      runtimePrompts: promptBundle.runtime,
      sender: completionSender,
      extraTools,
      log: log.child({ component: `async-image-${input.event}`, guildId: job.deliveryGuildId, channelId: job.deliveryChannelId, sourceGuildId: job.guildId, sourceChannelId: job.channelId, jobId: job.id, requestId: requestLog.requestId }),
      requestLog,
      ttsEnabled,
      generateSpeech,
      ...(attachment !== undefined ? { initialPendingAttachments: [attachment] } : {}),
      resolveImageAttachments: createStoredImageAttachmentResolver({
        guildId: job.deliveryGuildId,
        logger: log.child({ component: "stored-image-attachments", guildId: job.deliveryGuildId, channelId: job.deliveryChannelId, jobId: job.id }),
      }),
      forceTrigger: true,
      triggerInstructions: deliveryGuildConfig.triggerInstructions,
      modelImageInputSupport: getModelImageInputSupport(deliveryGuildConfig),
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
    });
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

function createBotMessageStore(input: {
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
    db.raw
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

    void embeddingQueue.enqueue({
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

function isSendableGuildChannel(channel: unknown): channel is SendableGuildChannel {
  return channel !== null
    && typeof channel === "object"
    && "send" in channel
    && "sendTyping" in channel
    && "guild" in channel
    && "guildId" in channel;
}

function channelTypeLabel(channel: GuildBasedChannel | ThreadChannel): string {
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

function dashboardTriggerLocation(guild: Guild, channel: unknown): { guildName: string; channelName?: string } {
  const channelName = channel !== null
    && typeof channel === "object"
    && "name" in channel
    && typeof channel.name === "string"
    && channel.name !== ""
    ? channel.name
    : undefined;
  return {
    guildName: guild.name,
    ...(channelName !== undefined ? { channelName } : {}),
  };
}

function sortLabels<T extends ManagementLabel>(labels: T[]): T[] {
  return labels.sort((a, b) => {
    const nameOrder = a.name.localeCompare(b.name);
    return nameOrder !== 0 ? nameOrder : a.id.localeCompare(b.id);
  });
}

function managementGuildName(guildId: string): string {
  return client.guilds.cache.get(guildId)?.name ?? guildId;
}

function managementChannelName(channelId: string): { name: string; type: string } {
  const channel = client.channels.cache.get(channelId);
  if (channel !== undefined && "name" in channel && typeof channel.name === "string" && channel.name !== "") {
    return {
      name: channel.name,
      type: "type" in channel && typeof channel.type === "number" ? channelTypeLabel(channel as GuildBasedChannel | ThreadChannel) : "channel",
    };
  }
  return { name: channelId, type: "stored" };
}

function managementUserName(userId: string): string {
  return client.users.cache.get(userId)?.username
    ?? client.guilds.cache.find((guild) => guild.members.cache.has(userId))?.members.cache.get(userId)?.user.username
    ?? userId;
}

function buildManagementDirectory(): ManagementDirectory {
  const stored = storedManagementDirectoryIds(db);
  const guilds = new Map<string, ManagementLabel>();
  for (const guild of client.guilds.cache.values()) {
    guilds.set(guild.id, { id: guild.id, name: guild.name });
  }
  for (const guildId of stored.guildIds) {
    if (!guilds.has(guildId)) guilds.set(guildId, { id: guildId, name: managementGuildName(guildId) });
  }

  const channels = new Map<string, ManagementChannelLabel>();
  for (const channel of client.channels.cache.values()) {
    if (!isSendableGuildChannel(channel)) continue;
    const label = managementChannelName(channel.id);
    channels.set(`${channel.guildId}:${channel.id}`, {
      id: channel.id,
      guildId: channel.guildId,
      name: label.name,
      type: label.type,
    });
  }
  for (const pair of stored.channelPairs) {
    const key = `${pair.guildId}:${pair.id}`;
    if (channels.has(key)) continue;
    const label = managementChannelName(pair.id);
    channels.set(key, {
      id: pair.id,
      guildId: pair.guildId,
      name: label.name,
      type: label.type,
    });
  }

  const users = new Map<string, ManagementLabel>();
  for (const user of client.users.cache.values()) {
    users.set(user.id, { id: user.id, name: user.username });
  }
  for (const userId of stored.userIds) {
    if (!users.has(userId)) users.set(userId, { id: userId, name: managementUserName(userId) });
  }

  return {
    guilds: sortLabels([...guilds.values()]),
    channels: sortLabels([...channels.values()]),
    users: sortLabels([...users.values()]),
  };
}

function decorateManagementMessage(row: ManagementMessageRow): ManagementMessageRow & {
  guildName: string;
  channelName: string;
  channelType: string;
  authorDisplayName: string;
} {
  const channel = managementChannelName(row.channelId);
  return {
    ...row,
    guildName: managementGuildName(row.guildId),
    channelName: channel.name,
    channelType: channel.type,
    authorDisplayName: managementUserName(row.userId),
  };
}

function decorateManagementMemory(row: ManagementMemoryRow): ManagementMemoryRow & {
  guildName?: string;
  subjectUsername?: string;
} {
  return {
    ...row,
    ...(row.guildId !== null ? { guildName: managementGuildName(row.guildId) } : {}),
    ...(row.subjectUserId !== null ? { subjectUsername: managementUserName(row.subjectUserId) } : {}),
  };
}

interface DiscordManagementDeleteResult {
  attempted: boolean;
  deletedMessageIds: string[];
  failures: Array<{ messageId: string; error: string }>;
}

function isDiscordMessageDeleteChannel(channel: unknown): channel is {
  messages: { delete: (messageId: string) => Promise<unknown> };
} {
  if (channel === null || typeof channel !== "object" || !("messages" in channel)) return false;
  const messages = (channel as { messages?: unknown }).messages;
  return messages !== undefined
    && messages !== null
    && typeof messages === "object"
    && "delete" in messages
    && typeof (messages as { delete?: unknown }).delete === "function";
}

async function tryDeleteDiscordManagementMessages(input: {
  guildId: string;
  channelId: string;
  messageIds: readonly string[];
  enabled: boolean;
}): Promise<DiscordManagementDeleteResult> {
  if (!input.enabled) return { attempted: false, deletedMessageIds: [], failures: [] };
  const channel = await client.channels.fetch(input.channelId).catch(() => null);
  if (!isDiscordMessageDeleteChannel(channel)) {
    return {
      attempted: true,
      deletedMessageIds: [],
      failures: input.messageIds.map((messageId) => ({
        messageId,
        error: "Channel is unavailable or does not expose message deletion.",
      })),
    };
  }

  const deletedMessageIds: string[] = [];
  const failures: Array<{ messageId: string; error: string }> = [];
  for (const messageId of input.messageIds) {
    try {
      await channel.messages.delete(messageId);
      deletedMessageIds.push(messageId);
    } catch (err) {
      failures.push({
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { attempted: true, deletedMessageIds, failures };
}

const DISCORD_CONTEXT_MAX_GUILDS = 12;

function botChannelPermissions(channel: GuildBasedChannel | ThreadChannel): {
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

function channelDisplayName(channel: unknown): string | undefined {
  return channel !== null
    && typeof channel === "object"
    && "name" in channel
    && typeof channel.name === "string"
    && channel.name !== ""
    ? channel.name
    : undefined;
}

async function resolveClientGuild(guildId: string): Promise<Guild | null> {
  const cached = client.guilds.cache.get(guildId);
  if (cached !== undefined) return cached;
  return await client.guilds.fetch(guildId).catch(() => null);
}

function isMainDiscordContextChannel(channel: GuildBasedChannel): boolean {
  return channel.type === ChannelType.GuildText
    || channel.type === ChannelType.GuildAnnouncement
    || channel.type === ChannelType.GuildForum
    || channel.type === ChannelType.GuildMedia;
}

function systemDiscordContextChannel(guild: Guild, currentChannelId: string): ChannelInfo | null {
  if (guild.systemChannelId === null) return null;
  const channel = guild.channels.cache.get(guild.systemChannelId);
  if (channel === undefined || !isMainDiscordContextChannel(channel)) return null;

  const permissions = botChannelPermissions(channel);
  if (!permissions.canView) return null;
  const categoryName = channel.parent?.name;
  return {
    guildId: guild.id,
    guildName: guild.name,
    id: channel.id,
    name: channel.name,
    type: channelTypeLabel(channel),
    canView: permissions.canView,
    canSend: permissions.canSend,
    isCurrent: channel.id === currentChannelId,
    ...(categoryName !== undefined ? { categoryName } : {}),
  };
}

function buildDiscordContext(input: {
  currentGuildId: string;
  currentGuildName: string;
  currentChannelId: string;
  currentChannelName?: string;
}): string {
  const guilds = [...client.guilds.cache.values()]
    .sort((a, b) => {
      if (a.id === input.currentGuildId) return -1;
      if (b.id === input.currentGuildId) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, DISCORD_CONTEXT_MAX_GUILDS);
  const currentChannel = input.currentChannelName !== undefined
    ? `#${input.currentChannelName} (${input.currentChannelId})`
    : input.currentChannelId;
  const lines = [
    `Current guild: ${input.currentGuildName} (${input.currentGuildId})`,
    `Current channel/thread: ${currentChannel}`,
    ...runtimeContextTemplate("discord-navigation", {}, "Guild shortlist for navigation context only.").split(/\r?\n/),
  ];

  for (const guild of guilds) {
    const current = guild.id === input.currentGuildId ? " current" : "";
    lines.push(`- ${guild.name} | guild_id=${guild.id}${current}`);
    const channel = systemDiscordContextChannel(guild, input.currentChannelId);
    if (channel === null) {
      lines.push("  system_channel: (none cached/visible; use list_channels with guild_id if needed)");
      continue;
    }
    const marker = channel.isCurrent ? " *" : "";
    lines.push(`  system_channel: #${channel.name} | channel_id=${channel.id} | type=${channel.type} | send=${channel.canSend ? "yes" : "no"}${marker}`);
  }

  return lines.join("\n");
}

async function fetchAccessibleGuildChannel(channelId: string): Promise<SendableGuildChannel | null> {
  const cached = client.channels.cache.get(channelId);
  const resolved = cached ?? await client.channels.fetch(channelId).catch(() => null);
  if (!isSendableGuildChannel(resolved)) return null;
  return botChannelPermissions(resolved).canView ? resolved : null;
}

function createTargetChannelResolver(discordClient: Client, defaultChannel: SendableGuildChannel): ResolveTargetChannel {
  return async (channelId) => {
    if (channelId === undefined) return defaultChannel;
    const cached = discordClient.channels.cache.get(channelId);
    const resolved = cached ?? await discordClient.channels.fetch(channelId).catch(() => null);
    if (resolved === null) throw new Error(`Invalid channel_id: channel "${channelId}" not found`);
    // PM/DM sends are intentionally disabled for now; guild channel/thread delivery may expand later.
    if (!isSendableGuildChannel(resolved)) {
      throw new Error(`Invalid channel_id: channel "${channelId}" is not a supported guild text channel or thread`);
    }
    return resolved;
  };
}

function createTypingController(input: {
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

function createDiscordMessageSender(input: {
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
        db,
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
    const outboundResolvers = buildOutboundResolvers(targetChannel.guild);
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
      if (targetChannel.isThread()) {
        const activityAt = Date.now();
        const updated = updateThreadActivity(db, targetChannelId, {
          lastActivityAt: activityAt,
          lastMessageId: sent.id,
          archivedAt: targetChannel.archived === true ? activityAt : null,
        });
        if (!updated) {
          upsertThread(db, {
            threadId: targetChannelId,
            guildId: targetGuildId,
            parentChatId: targetChannel.parentId ?? targetChannelId,
            starterMessageId: targetChannelId,
            threadName: targetChannel.name,
            createdAt: targetChannel.createdTimestamp ?? activityAt,
            lastActivityAt: activityAt,
            lastMessageId: sent.id,
            messageCount: targetChannel.messageCount ?? 1,
            createdByBot: targetChannel.ownerId === input.botUserId,
            archivedAt: targetChannel.archived === true ? activityAt : null,
          });
        }
        markBotParticipating(db, targetChannelId);
      }
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
    if (targetChannel.isThread()) {
      const activityAt = Date.now();
      const updated = updateThreadActivity(db, targetChannelId, {
        lastActivityAt: activityAt,
        lastMessageId: firstId,
        archivedAt: targetChannel.archived === true ? activityAt : null,
      });
      if (!updated) {
        upsertThread(db, {
          threadId: targetChannelId,
          guildId: targetGuildId,
          parentChatId: targetChannel.parentId ?? targetChannelId,
          starterMessageId: targetChannelId,
          threadName: targetChannel.name,
          createdAt: targetChannel.createdTimestamp ?? activityAt,
          lastActivityAt: activityAt,
          lastMessageId: firstId,
          messageCount: targetChannel.messageCount ?? 1,
          createdByBot: targetChannel.ownerId === input.botUserId,
          archivedAt: targetChannel.archived === true ? activityAt : null,
        });
      }
      markBotParticipating(db, targetChannelId);
    }
    return { sentMessageId: firstId, warnings: unresolvedEmojiWarnings(warnings) };
  };
}

function createStoredImageAttachmentResolver(input: {
  guildId: string;
  logger: Logger;
}): ImageAttachmentResolver {
  return (imageIds) => {
    const attachments: OutboundAttachment[] = [];
    for (const imageId of imageIds) {
      const record = getImageById(db, imageId);
      if (record === null || record.guildId !== input.guildId) {
        input.logger.warn("stored image attachment not found", { imageId, guildId: input.guildId });
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = Buffer.from(readFileSync(record.path));
      } catch (error) {
        input.logger.warn("stored image attachment read failed", {
          imageId,
          path: record.path,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      attachments.push({
        id: `chat-image-${record.id}`,
        buffer,
        filename: `chat-image-${record.id}.${imageExtensionForMime(record.mime)}`,
        contentType: record.mime,
        historyText: record.caption ?? `Reposted stored ImageID ${record.id}.`,
      });
    }
    return Promise.resolve(attachments);
  };
}

async function syncEditedOwnBotMessage(input: {
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
  const row = upsertBotMessageContent(db, {
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
  await deleteMessagePointsByMessageId(qdrant, { guildId: row.guildId, messageId: row.id });
  await embeddingQueue.enqueue({
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

async function syncDeletedOwnBotMessage(input: {
  messageId: string;
  guildId: string;
  channelId: string;
  botUserId: string;
}): Promise<void> {
  const deleted = deleteBotMessageState(db, {
    id: input.messageId,
    guildId: input.guildId,
    channelId: input.channelId,
    botUserId: input.botUserId,
  });
  await deleteMessagePointsByMessageId(qdrant, { guildId: input.guildId, messageId: input.messageId });
  for (const path of deleted.imagePaths) {
    try { unlinkSync(path); } catch { /* ignore missing */ }
  }
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

const modelImageInputSupport = new Map<string, ModelImageInputSupport>();
const MODEL_METADATA_TIMEOUT_MS = 10_000;

function collectEffectiveModelIds(global: typeof globalConfig, guilds: ReadonlyMap<string, GuildConfig>): string[] {
  const ids = new Set<string>();
  for (const guildConfig of guilds.values()) {
    ids.add(resolveGuildModelKey(global, guildConfig));
  }
  if (ids.size === 0) ids.add(`${global.defaultLlmProvider}:${global.defaultModel}`);
  return [...ids].sort((a, b) => a.localeCompare(b));
}

async function refreshModelImageInputSupport(
  global: typeof globalConfig,
  guilds: ReadonlyMap<string, GuildConfig>,
  reason: "startup" | "hot_reload",
): Promise<void> {
  const modelIds = collectEffectiveModelIds(global, guilds);
  const next = new Map<string, ModelImageInputSupport>();

  await Promise.all(modelIds.map(async (modelKey) => {
    const splitAt = modelKey.indexOf(":");
    const provider = splitAt === -1 ? "openrouter" : modelKey.slice(0, splitAt);
    const modelId = splitAt === -1 ? modelKey : modelKey.slice(splitAt + 1);
    if (provider === "openai-codex") {
      const model = resolveModel(modelId, "openai-codex");
      const support: ModelImageInputSupport = model.input.includes("image") ? "supported" : "unsupported";
      next.set(modelKey, support);
      log.info("codex model metadata loaded from registry", {
        model: modelId,
        reason,
        imageInputSupport: support,
        inputModalities: model.input,
      });
      return;
    }
    if (global.openrouterApiKey === undefined || global.openrouterApiKey === "") {
      next.set(modelKey, "unknown");
      log.error("openrouter model metadata fetch skipped", {
        model: modelId,
        reason,
        error: "OPENROUTER_API_KEY is not configured",
      });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`OpenRouter model metadata request timed out after ${MODEL_METADATA_TIMEOUT_MS}ms`));
    }, MODEL_METADATA_TIMEOUT_MS);
    try {
      const metadata = await fetchOpenRouterModelMetadata({
        modelId,
        apiKey: global.openrouterApiKey,
        signal: controller.signal,
      });
      const support = imageInputSupportFromMetadata(metadata);
      next.set(modelKey, support);
      log.info("openrouter model metadata loaded", {
        model: modelId,
        reason,
        imageInputSupport: support,
        inputModalities: metadata?.inputModalities ?? [],
      });
    } catch (err) {
      next.set(modelKey, "unknown");
      log.error("openrouter model metadata fetch failed", {
        model: modelId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timeout);
    }
  }));

  modelImageInputSupport.clear();
  for (const [modelId, support] of next) {
    modelImageInputSupport.set(modelId, support);
  }
}

function getModelImageInputSupport(guildConfig: GuildConfig): ModelImageInputSupport {
  return modelImageInputSupport.get(resolveGuildModelKey(globalConfig, guildConfig)) ?? "unknown";
}

await refreshModelImageInputSupport(globalConfig, guildConfigs, "startup");

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

type AmbientCandidate = {
  id: string;
  kind: AmbientAttentionKind;
  message: Message;
  createdAt: number;
  triggerCreatedAt: number;
  triggerMessageId: string;
  userId: string;
  channelId: string;
  guildId: string;
  defaultReply: boolean;
  syntheticContent?: string;
  syntheticTimestamp?: number;
  burstStartedAt?: number;
  burstMessageCount?: number;
};

type AmbientLease = {
  guildId: string;
  channelId: string;
  userId: string;
  exchangeId: string;
  sourceMessageId: string;
  botMessageId: string;
  botRepliedAt: number;
  strongUntil: number;
  expiresAt: number;
  typingExtensions: number;
  followUpsSent: number;
};

type AmbientDecision = {
  should_reply: boolean;
  reply_probability: number;
  confidence: number;
  intent?: string;
  default_reply?: boolean;
  reason: string;
};

type AmbientDecisionVerdict = {
  passed: boolean;
  probabilityThreshold: number;
  confidenceThreshold: number;
  adjustedProbability: number;
  jitter: number;
  weakLingering: boolean;
  decidingParameter: "should_reply" | "reply_probability" | "confidence" | "passed";
  explanation: string;
};

type AmbientPendingCandidate = {
  candidate: AmbientCandidate;
  timer: ReturnType<typeof setTimeout>;
};

const ambientCandidateTimers = new Map<string, ReturnType<typeof setTimeout>>();
const ambientLeases = new Map<string, AmbientLease>();
const ambientPendingCandidates = new Map<string, AmbientPendingCandidate>();
const ambientTypingByChannelUser = new Map<string, number>();
const ambientReplyTimesByUser = new Map<string, number[]>();
const ambientReplyTimesByChannel = new Map<string, number[]>();
const ambientCooldowns = new Map<string, number>();
const ambientPickupChannelCooldowns = new Map<string, number>();
const ambientNormalTriggerUsers = new Set<string>();

function ambientLeaseKey(guildId: string, channelId: string, userId: string): string {
  return `${guildId}:${channelId}:${userId}`;
}

function ambientChannelUserKey(guildId: string, channelId: string, userId: string): string {
  return `${guildId}:${channelId}:${userId}`;
}

function ambientNormalTriggerUserKey(guildId: string, channelId: string, userId: string): string {
  return `${guildId}:${channelId}:${userId}`;
}

function ambientCooldownKey(kind: AmbientAttentionKind, guildId: string, channelId: string, userId: string): string {
  return `${kind}:${guildId}:${channelId}:${userId}`;
}

function ambientPickupChannelCooldownKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

function ambientModeConfig(config: AmbientAttentionConfig, kind: AmbientAttentionKind): AmbientAttentionModeConfig {
  if (kind === "ambient_pickup") return config.ambientPickup;
  if (kind === "lingering_attention") return config.lingering;
  return config.followUp;
}

function randomBetween(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pruneRecentTimes(times: number[], now: number): number[] {
  return times.filter((time) => now - time < 60 * 60 * 1000);
}

function ambientBudgetAvailable(
  config: AmbientAttentionConfig,
  candidate: AmbientCandidate,
  now = Date.now(),
): boolean {
  const userKey = `${candidate.guildId}:${candidate.userId}`;
  const channelKey = `${candidate.guildId}:${candidate.channelId}`;
  const userTimes = pruneRecentTimes(ambientReplyTimesByUser.get(userKey) ?? [], now);
  const channelTimes = pruneRecentTimes(ambientReplyTimesByChannel.get(channelKey) ?? [], now);
  ambientReplyTimesByUser.set(userKey, userTimes);
  ambientReplyTimesByChannel.set(channelKey, channelTimes);
  const mode = ambientModeConfig(config, candidate.kind);
  return userTimes.length < mode.maxRepliesPerUserPerHour && channelTimes.length < mode.maxRepliesPerChannelPerHour;
}

function recordAmbientReply(candidate: AmbientCandidate, now = Date.now()): void {
  const userKey = `${candidate.guildId}:${candidate.userId}`;
  const channelKey = `${candidate.guildId}:${candidate.channelId}`;
  ambientReplyTimesByUser.set(userKey, [...pruneRecentTimes(ambientReplyTimesByUser.get(userKey) ?? [], now), now]);
  ambientReplyTimesByChannel.set(channelKey, [...pruneRecentTimes(ambientReplyTimesByChannel.get(channelKey) ?? [], now), now]);
}

function markAmbientCooldown(config: AmbientAttentionConfig, candidate: AmbientCandidate, now = Date.now()): void {
  const mode = ambientModeConfig(config, candidate.kind);
  if (mode.cooldownMs <= 0) return;
  ambientCooldowns.set(ambientCooldownKey(candidate.kind, candidate.guildId, candidate.channelId, candidate.userId), now + mode.cooldownMs);
}

function ambientCooldownReady(candidate: AmbientCandidate, now = Date.now()): boolean {
  return (ambientCooldowns.get(ambientCooldownKey(candidate.kind, candidate.guildId, candidate.channelId, candidate.userId)) ?? 0) <= now;
}

function markAmbientPickupChannelCooldown(config: AmbientAttentionConfig | undefined, guildId: string, channelId: string, now = Date.now()): void {
  if (config === undefined || !config.enabled || !config.ambientPickup.enabled || config.ambientPickup.cooldownMs <= 0) return;
  ambientPickupChannelCooldowns.set(ambientPickupChannelCooldownKey(guildId, channelId), now + config.ambientPickup.cooldownMs);
}

function ambientPickupChannelCooldownReady(candidate: AmbientCandidate, now = Date.now()): boolean {
  if (candidate.kind !== "ambient_pickup") return true;
  return (ambientPickupChannelCooldowns.get(ambientPickupChannelCooldownKey(candidate.guildId, candidate.channelId)) ?? 0) <= now;
}

function ambientPickupChannelReady(guildId: string, channelId: string, now = Date.now()): boolean {
  return (ambientPickupChannelCooldowns.get(ambientPickupChannelCooldownKey(guildId, channelId)) ?? 0) <= now;
}

function activeTypingInChannel(guildId: string, channelId: string, activeMs: number, now = Date.now()): boolean {
  if (activeMs <= 0) return false;
  const prefix = `${guildId}:${channelId}:`;
  for (const [key, lastTypingAt] of ambientTypingByChannelUser) {
    if (!key.startsWith(prefix)) continue;
    if (now - lastTypingAt <= activeMs) return true;
  }
  return false;
}

function ambientTypingActiveMs(config: AmbientAttentionConfig, kind: AmbientAttentionKind): number {
  return ambientModeConfig(config, kind).typingActiveMs;
}

function renderAmbientHistory(history: HistoryMessage[], triggerMessageId: string): string {
  return history.map((message) => {
    const who = message.isBot ? "2B" : message.author;
    const marker = message.id === triggerMessageId ? " <trigger>" : "";
    const reply = message.replyToId !== null ? ` reply_to=${message.replyToId}` : "";
    return `[${new Date(message.timestamp).toISOString()}] ${who} (${message.authorId})${reply}${marker}: ${message.content}`;
  }).join("\n");
}

function rawStoredMessageContent(messageId: string, guildId: string): string | null {
  const row = db.raw
    .prepare("SELECT raw_content FROM messages WHERE id = ? AND guild_id = ? AND is_prompt_only = 0")
    .get(messageId, guildId) as { raw_content: string } | null;
  return row?.raw_content ?? null;
}

function contentMentionsBot(content: string, botUserId: string): boolean {
  if (botUserId === "") return false;
  return new RegExp(`<@!?${botUserId}>`).test(content);
}

function storedMessageRepliesToOwnBot(message: HistoryMessage, guildId: string): boolean {
  if (message.replyToId === null) return false;
  const botUserId = client.user?.id ?? "";
  if (botUserId === "") return false;
  const row = db.raw
    .prepare("SELECT user_id, is_bot FROM messages WHERE id = ? AND guild_id = ? AND is_prompt_only = 0")
    .get(message.replyToId, guildId) as { user_id: string; is_bot: number } | null;
  return row !== null && row.user_id === botUserId && row.is_bot === 1;
}

function deterministicHistoryTrigger(message: HistoryMessage, guildConfig: GuildConfig): TriggerResult {
  const botUserId = client.user?.id ?? "";
  const rawContent = rawStoredMessageContent(message.id, guildConfig.guildId) ?? message.content;
  if (contentMentionsBot(rawContent, botUserId)) return { reason: "mention" };
  if (storedMessageRepliesToOwnBot(message, guildConfig.guildId)) return { reason: "mention" };
  return shouldRespond(
    {
      content: message.content,
      authorId: message.authorId,
      botUserId,
      mentionedUserIds: [],
    },
    { ...guildConfig.triggers, randomChance: 0 },
  );
}

function memoryCountBucket(memoryCount: number): string {
  if (memoryCount <= 0) return "none";
  if (memoryCount <= 2) return "few";
  if (memoryCount <= 8) return "some";
  return "many";
}

function familiarityBucket(input: {
  familiarityScore: number;
  directContactEvents: number;
  activeContactDays: number;
}): string {
  if (input.directContactEvents <= 0) return "no_prior_direct_contact";
  if (input.familiarityScore >= 70) return "very_familiar";
  if (input.familiarityScore >= 45) return "familiar";
  if (input.directContactEvents >= 3 || input.activeContactDays >= 2) return "occasional";
  return "new_or_light_contact";
}

function recencyBucket(timestamp: number | null, now: number): string {
  if (timestamp === null) return "none";
  const ageMs = Math.max(0, now - timestamp);
  if (ageMs <= 24 * 60 * 60 * 1000) return "today";
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) return "this_week";
  if (ageMs <= 30 * 24 * 60 * 60 * 1000) return "this_month";
  return "old";
}

function localChannelShape(history: readonly HistoryMessage[], userId: string): string {
  const recent = history.slice(-30).filter((message) => !message.isSynthetic);
  const humanMessages = recent.filter((message) => !message.isBot);
  const uniqueHumans = new Set(humanMessages.map((message) => message.authorId));
  const userMessages = humanMessages.filter((message) => message.authorId === userId).length;
  const botMessages = recent.filter((message) => message.isBot && message.isPromptOnly !== true).length;
  if (humanMessages.length === 0) return "no_recent_human_chatter";
  if (uniqueHumans.size <= 1 && userMessages > 0 && botMessages > 0) return "mostly_user_and_2b";
  if (uniqueHumans.size <= 1) return "mostly_one_user";
  if (uniqueHumans.size <= 3 && humanMessages.length <= 8) return "small_mixed_chat";
  return "busy_group_chat";
}

function isPromptOnlyIgnore(message: HistoryMessage): boolean {
  return message.isBot && message.isPromptOnly === true && message.content.trim().toLowerCase().startsWith("<ignore");
}

function recentBotInvolvement(history: readonly HistoryMessage[], userId: string, now: number): string {
  const recent = history.filter((message) => now - message.timestamp <= 10 * 60 * 1000);
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const message = recent[i];
    if (message === undefined || !message.isBot) continue;
    if (isPromptOnlyIgnore(message)) {
      if (message.replyToId !== null) {
        const target = history.find((item) => item.id === message.replyToId);
        if (target !== undefined && target.authorId === userId) return "2b_recently_chose_silence_for_same_user";
        if (target !== undefined && !target.isBot) return "2b_recently_chose_silence_for_other_user";
      }
      return "2b_recently_chose_silence";
    }
    if (message.isPromptOnly === true) continue;
    if (message.replyToId !== null) {
      const target = history.find((item) => item.id === message.replyToId);
      if (target !== undefined && target.authorId === userId) return "2b_replied_to_same_user_recently";
      if (target !== undefined && !target.isBot) return "2b_replied_to_other_user_recently";
    }
    const previousHuman = history
      .filter((item) => !item.isBot && item.timestamp <= message.timestamp)
      .at(-1);
    if (previousHuman?.authorId === userId) return "2b_spoke_after_same_user_recently";
    if (previousHuman !== undefined) return "2b_spoke_after_other_user_recently";
    return "2b_spoke_recently";
  }
  return "none_recent";
}

function renderAmbientRelationshipSignals(candidate: AmbientCandidate, history: HistoryMessage[]): string {
  const now = Date.now();
  const contact = buildComputedContactContextForUser({
    db,
    botUserId: client.user?.id ?? "",
    userId: candidate.userId,
    currentChannelId: candidate.channelId,
    beforeCreatedAt: candidate.triggerCreatedAt,
    beforeMessageId: candidate.triggerMessageId,
    now,
  });
  const familiarity = contact === null
    ? "no_prior_direct_contact"
    : familiarityBucket(contact);
  const memoryBucket = memoryCountBucket(contact?.memoryCount ?? 0);
  return [
    `familiarity: ${familiarity}`,
    `direct_contact_events: ${contact?.directContactEvents ?? 0}`,
    `active_contact_days: ${contact?.activeContactDays ?? 0}`,
    `direct_contact_recency: ${recencyBucket(contact?.lastContactAt ?? null, now)}`,
    `last_user_to_2b: ${recencyBucket(contact?.lastUserToBotAt ?? null, now)}`,
    `last_2b_to_user: ${recencyBucket(contact?.lastBotToUserAt ?? null, now)}`,
    `memory_count_bucket: ${memoryBucket}`,
    `local_channel_shape: ${localChannelShape(history, candidate.userId)}`,
    `recent_2b_involvement: ${recentBotInvolvement(history, candidate.userId, now)}`,
  ].join("\n");
}

function ambientCandidateTriggerContext(candidate: AmbientCandidate): {
  guildName?: string;
  channelName?: string;
  authorUsername?: string;
  messageId: string;
  content: string;
  translatedContent: string;
} {
  const guild = candidate.message.guild;
  const translatedContent = candidate.syntheticContent ?? (guild !== null
    ? translateInbound(candidate.message.content, buildInboundResolvers(guild))
    : candidate.message.content);
  return {
    ...(guild !== null ? { guildName: guild.name } : {}),
    channelName: channelDisplayName(candidate.message.channel),
    authorUsername: candidate.message.author.username,
    messageId: candidate.triggerMessageId,
    content: candidate.message.content,
    translatedContent,
  };
}

function createAmbientRequestLog(candidate: AmbientCandidate, status: string): RequestLog {
  const requestLog = new RequestLog(candidate.guildId, candidate.channelId, requestLogStore);
  requestLog.setAuthor(candidate.message.author.username);
  requestLog.setTrigger({
    type: "ambient_attention_evaluator",
    kind: candidate.kind,
    status,
    triggerMessageId: candidate.triggerMessageId,
    userId: candidate.userId,
  });
  requestLog.setTriggerContext(ambientCandidateTriggerContext(candidate));
  requestLog.setAgentRan(true);
  return requestLog;
}

function emitAmbientRequestLog(requestLog: RequestLog): void {
  requestLog.emit(log);
  requestLogStore.decrementActive();
}

function recordAmbientRuntimeAction(
  requestLog: RequestLog,
  id: string,
  tool: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  isError = false,
): void {
  requestLog.recordToolStart(id, tool, args);
  requestLog.recordToolEnd(id, isError, {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  });
}

function logAmbientScheduled(candidate: AmbientCandidate, delayMs: number): void {
  const requestLog = createAmbientRequestLog(candidate, "scheduled");
  requestLogStore.incrementActive();
  recordAmbientRuntimeAction(
    requestLog,
    `ambient-scheduled:${candidate.id}`,
    "ambient_attention_scheduled",
    {
      kind: candidate.kind,
      delayMs,
      defaultReply: candidate.defaultReply,
      triggerMessageId: candidate.triggerMessageId,
      ...(candidate.burstMessageCount !== undefined ? { burstMessageCount: candidate.burstMessageCount } : {}),
      ...(candidate.burstStartedAt !== undefined ? { burstDurationMs: Date.now() - candidate.burstStartedAt } : {}),
    },
    {
      status: "scheduled",
      summary: candidate.burstMessageCount !== undefined && candidate.burstMessageCount > 1
        ? `${candidate.kind} burst of ${candidate.burstMessageCount} messages queued for evaluation in ${delayMs}ms.`
        : `${candidate.kind} queued for evaluation in ${delayMs}ms.`,
    },
  );
  emitAmbientRequestLog(requestLog);
}

function ambientPendingKey(kind: AmbientAttentionKind, guildId: string, channelId: string, userId: string): string {
  return `${kind}:${guildId}:${channelId}:${userId}`;
}

function clearPendingCandidate(key: string): void {
  const pending = ambientPendingCandidates.get(key);
  if (pending === undefined) return;
  clearTimeout(pending.timer);
  ambientCandidateTimers.delete(pending.candidate.id);
  ambientPendingCandidates.delete(key);
}

function clearPendingAmbientKindInChannel(kind: "ambient_pickup" | "lingering_attention", guildId: string, channelId: string): void {
  for (const [key, pending] of ambientPendingCandidates) {
    if (pending.candidate.kind === kind && pending.candidate.guildId === guildId && pending.candidate.channelId === channelId) {
      clearPendingCandidate(key);
    }
  }
}

function markAmbientNormalTriggerInFlight(guildId: string, channelId: string, userId: string): void {
  ambientNormalTriggerUsers.add(ambientNormalTriggerUserKey(guildId, channelId, userId));
}

function clearAmbientNormalTriggerInFlight(guildId: string, channelId: string, userId: string): void {
  ambientNormalTriggerUsers.delete(ambientNormalTriggerUserKey(guildId, channelId, userId));
}

function ambientNormalTriggerInFlight(guildId: string, channelId: string, userId: string): boolean {
  return ambientNormalTriggerUsers.has(ambientNormalTriggerUserKey(guildId, channelId, userId));
}

function clearPendingForCandidate(candidate: AmbientCandidate): void {
  if (candidate.kind === "follow_up") return;
  const key = ambientPendingKey(candidate.kind, candidate.guildId, candidate.channelId, candidate.userId);
  const pending = ambientPendingCandidates.get(key);
  if (pending?.candidate.id === candidate.id) clearPendingCandidate(key);
}

function armPendingCandidate(key: string, candidate: AmbientCandidate, delayMs: number): void {
  clearPendingCandidate(key);
  logAmbientScheduled(candidate, delayMs);
  const timer = setTimeout(() => {
    void runAmbientCandidate(candidate);
  }, delayMs);
  ambientPendingCandidates.set(key, { candidate, timer });
  ambientCandidateTimers.set(candidate.id, timer);
}

function schedulePendingBurstFromMessage(
  message: Message,
  base: Omit<AmbientCandidate, "id" | "kind" | "defaultReply">,
  config: AmbientAttentionConfig,
  kind: "ambient_pickup" | "lingering_attention",
): void {
  const key = ambientPendingKey(kind, base.guildId, base.channelId, base.userId);
  const mode = ambientModeConfig(config, kind);
  const existing = ambientPendingCandidates.get(key);
  const burstStartedAt = existing?.candidate.burstStartedAt ?? message.createdTimestamp;
  const burstMessageCount = (existing?.candidate.burstMessageCount ?? 0) + 1;
  const candidate: AmbientCandidate = {
    ...base,
    id: crypto.randomUUID(),
    kind,
    defaultReply: mode.defaultReply,
    burstStartedAt,
    burstMessageCount,
  };
  armPendingCandidate(key, candidate, randomBetween(mode.minDelayMs, mode.maxDelayMs));
}

function reschedulePendingBurstForTyping(
  kind: "ambient_pickup" | "lingering_attention",
  guildId: string,
  channelId: string,
  userId: string,
  config: AmbientAttentionConfig,
): void {
  const key = ambientPendingKey(kind, guildId, channelId, userId);
  const pending = ambientPendingCandidates.get(key);
  if (pending === undefined) return;
  const mode = ambientModeConfig(config, kind);
  const delayMs = ambientTypingActiveMs(config, kind) + randomBetween(mode.minDelayMs, mode.maxDelayMs);
  armPendingCandidate(key, pending.candidate, delayMs);
}

function ambientHardGate(
  config: AmbientAttentionConfig,
  candidate: AmbientCandidate,
  phase: "evaluate" | "pre_send",
): { ok: true; history: HistoryMessage[] } | { ok: false; reason: string } {
  if (!config.enabled) return { ok: false, reason: "ambient attention disabled" };
  const mode = ambientModeConfig(config, candidate.kind);
  if (!mode.enabled) return { ok: false, reason: `${candidate.kind} disabled` };
  const now = Date.now();
  if (now - candidate.createdAt > config.staleAfterMs) return { ok: false, reason: "candidate stale" };
  if (!ambientBudgetAvailable(config, candidate, now)) return { ok: false, reason: "ambient budget exhausted" };
  if (phase === "evaluate" && !ambientCooldownReady(candidate, now)) return { ok: false, reason: "ambient cooldown active" };
  if (!ambientPickupChannelCooldownReady(candidate, now)) return { ok: false, reason: "ambient pickup channel cooldown active" };
  if (activeTypingInChannel(candidate.guildId, candidate.channelId, ambientTypingActiveMs(config, candidate.kind), now)) {
    return { ok: false, reason: "user typing active" };
  }

  const trigger = getMessageById(db, candidate.triggerMessageId, candidate.guildId);
  if (trigger === null || trigger.channelId !== candidate.channelId) return { ok: false, reason: "trigger message missing" };
  if (trigger.translatedContent.trim() === "") return { ok: false, reason: "empty trigger message" };

  const history = getHistoryMessages(db, candidate.channelId, config.historyLimit);
  const afterTrigger = history.filter((message) =>
    message.timestamp > candidate.triggerCreatedAt ||
    (message.timestamp === candidate.triggerCreatedAt && message.id > candidate.triggerMessageId)
  );
  const newHumanMessages = afterTrigger.filter((message) => !message.isBot);
  if (candidate.kind === "ambient_pickup") {
    const guildConfig = getGuildConfig(candidate.guildId);
    if (newHumanMessages.some((message) => deterministicHistoryTrigger(message, guildConfig) !== null)) {
      return { ok: false, reason: "newer normal trigger exists" };
    }
    if (afterTrigger.some((message) => message.isBot && message.isPromptOnly !== true)) {
      return { ok: false, reason: "2b spoke after trigger" };
    }
  }
  if (newHumanMessages.length > config.maxNewMessagesBeforeDrop) return { ok: false, reason: "too many newer human messages" };
  if (afterTrigger.some((message) => !message.isBot && message.replyToId === candidate.triggerMessageId && message.authorId !== candidate.userId)) {
    return { ok: false, reason: "another human replied to trigger" };
  }

  if (candidate.kind === "lingering_attention") {
    const lease = ambientLeases.get(ambientLeaseKey(candidate.guildId, candidate.channelId, candidate.userId));
    if (lease === undefined) return { ok: false, reason: "lingering lease missing" };
    if (lease.expiresAt <= now) return { ok: false, reason: "lingering lease expired" };
  }

  if (candidate.kind === "follow_up") {
    const lease = ambientLeases.get(ambientLeaseKey(candidate.guildId, candidate.channelId, candidate.userId));
    if (lease === undefined || lease.botMessageId !== candidate.triggerMessageId) return { ok: false, reason: "follow-up lease missing" };
    if (lease.followUpsSent >= config.followUp.maxPerExchange) return { ok: false, reason: "follow-up exchange budget used" };
    const newer = history.filter((message) =>
      message.timestamp > candidate.triggerCreatedAt ||
      (message.timestamp === candidate.triggerCreatedAt && message.id > candidate.triggerMessageId)
    );
    if (newer.length > 0) return { ok: false, reason: "follow-up silence broken" };
    if (now - candidate.triggerCreatedAt < config.followUp.silenceMs) return { ok: false, reason: "follow-up silence too short" };
  } else {
    const recentHumans = history.filter((message) =>
      !message.isBot && now - message.timestamp <= config.busyWindowMs
    );
    if (recentHumans.length > config.busyMessageLimit) return { ok: false, reason: "channel busy" };
    if (
      candidate.kind === "ambient_pickup" &&
      phase === "evaluate" &&
      newHumanMessages.length === 0 &&
      now - candidate.triggerCreatedAt < config.ambientPickup.minQuietMs
    ) {
      return { ok: false, reason: "quiet window too short" };
    }
  }

  return { ok: true, history };
}

async function evaluateAmbientCandidate(
  config: AmbientAttentionConfig,
  candidate: AmbientCandidate,
  history: HistoryMessage[],
  requestLog?: RequestLog,
): Promise<AmbientDecision | null> {
  const streamOptions = buildAmbientAttentionStreamOptions(globalConfig, getGuildConfig(candidate.guildId));
  const providerParams: Record<string, unknown> = { ...streamOptions };
  delete providerParams.apiKey;
  const provider = config.evaluator.provider ?? resolveGuildLlmProvider(globalConfig, getGuildConfig(candidate.guildId));
  const mode = ambientModeConfig(config, candidate.kind);
  const system = [
    ambientEvaluatorPolicyForKind(candidate.kind),
    "You decide whether 2B should naturally speak in Discord ambient attention.",
    "Usually choose silence. Do not write the reply text.",
    "Return only compact JSON with should_reply, reply_probability, confidence, intent, default_reply, reason.",
    "reply_probability and confidence must be 0..1. reason should be one short sentence.",
  ].filter((part) => part.trim() !== "").join("\n\n");
  const user = [
    `kind: ${candidate.kind}`,
    `default_reply: ${mode.defaultReply}`,
    `trigger_message_id: ${candidate.triggerMessageId}`,
    `trigger_user_id: ${candidate.userId}`,
    ...(candidate.burstMessageCount !== undefined
      ? [
          `burst_message_count: ${candidate.burstMessageCount}`,
          `burst_duration_ms: ${Date.now() - (candidate.burstStartedAt ?? candidate.triggerCreatedAt)}`,
        ]
      : []),
    `now: ${new Date().toISOString()}`,
    "",
    "Compact relationship signals:",
    renderAmbientRelationshipSignals(candidate, history),
    "",
    "Recent channel history:",
    renderAmbientHistory(history, candidate.triggerMessageId),
  ].join("\n");
  const messages: OpenRouterMessage[] = [{ role: "user", content: user }];
  let llmCompleted = false;
  try {
    const result = await completeLlmChat({
      provider,
      apiKey: streamOptions.apiKey,
      model: config.evaluator.model,
      systemPrompt: system,
      messages,
      providerParams,
      onPayload: (payload) => {
        requestLog?.recordLLMRequest(payload);
      },
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: "ambient_attention_decision",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["should_reply", "reply_probability", "confidence", "intent", "default_reply", "reason"],
            properties: {
              should_reply: { type: "boolean" },
              reply_probability: { type: "number", minimum: 0, maximum: 1 },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              intent: { type: "string" },
              default_reply: { type: "boolean" },
              reason: { type: "string" },
            },
          },
        },
      },
      toolChoice: "none",
      parallelToolCalls: false,
      signal: AbortSignal.timeout(config.evaluator.llmOutputTimeoutMs),
    });
    requestLog?.recordLLMCompletion(result.messageForLogs);
    llmCompleted = true;
    const parsed = JSON.parse(result.text) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return {
      should_reply: record.should_reply === true,
      reply_probability: typeof record.reply_probability === "number" ? Math.max(0, Math.min(1, record.reply_probability)) : 0,
      confidence: typeof record.confidence === "number" ? Math.max(0, Math.min(1, record.confidence)) : 0,
      intent: typeof record.intent === "string" ? record.intent : undefined,
      default_reply: typeof record.default_reply === "boolean" ? record.default_reply : candidate.defaultReply,
      reason: typeof record.reason === "string" ? record.reason : "",
    };
  } catch (error) {
    if (!llmCompleted) requestLog?.recordLLMError(error);
    log.warn("ambient attention evaluation failed", {
      kind: candidate.kind,
      messageId: candidate.triggerMessageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function ambientDecisionVerdict(
  config: AmbientAttentionConfig,
  candidate: AmbientCandidate,
  decision: AmbientDecision,
): AmbientDecisionVerdict {
  const mode = ambientModeConfig(config, candidate.kind);
  const lease = candidate.kind === "lingering_attention"
    ? ambientLeases.get(ambientLeaseKey(candidate.guildId, candidate.channelId, candidate.userId))
    : undefined;
  const weakLingering = lease !== undefined && Date.now() > lease.strongUntil;
  const probabilityThreshold = weakLingering
    ? Math.min(1, Math.max(mode.probabilityThreshold + 0.17, config.ambientPickup.probabilityThreshold))
    : mode.probabilityThreshold;
  const confidenceThreshold = weakLingering
    ? Math.min(1, Math.max(mode.confidenceThreshold + 0.1, config.ambientPickup.confidenceThreshold))
    : mode.confidenceThreshold;
  const jitter = mode.randomJitter > 0 ? (Math.random() * 2 - 1) * mode.randomJitter : 0;
  const adjustedProbability = Math.max(0, Math.min(1, decision.reply_probability + jitter));
  if (!decision.should_reply) {
    return {
      passed: false,
      probabilityThreshold,
      confidenceThreshold,
      adjustedProbability,
      jitter,
      weakLingering,
      decidingParameter: "should_reply",
      explanation: "Evaluator explicitly chose silence.",
    };
  }
  if (adjustedProbability < probabilityThreshold) {
    return {
      passed: false,
      probabilityThreshold,
      confidenceThreshold,
      adjustedProbability,
      jitter,
      weakLingering,
      decidingParameter: "reply_probability",
      explanation: `Adjusted reply probability ${adjustedProbability.toFixed(2)} was below threshold ${probabilityThreshold.toFixed(2)}.`,
    };
  }
  if (decision.confidence < confidenceThreshold) {
    return {
      passed: false,
      probabilityThreshold,
      confidenceThreshold,
      adjustedProbability,
      jitter,
      weakLingering,
      decidingParameter: "confidence",
      explanation: `Confidence ${decision.confidence.toFixed(2)} was below threshold ${confidenceThreshold.toFixed(2)}.`,
    };
  }
  return {
    passed: true,
    probabilityThreshold,
    confidenceThreshold,
    adjustedProbability,
    jitter,
    weakLingering,
    decidingParameter: "passed",
    explanation: "Evaluator decision cleared probability and confidence thresholds.",
  };
}

function ambientTriggerInstruction(kind: AmbientAttentionKind, decision: AmbientDecision): string {
  const anchoring = decision.default_reply === true
    ? "The first visible message may reply to the triggering message when anchoring helps."
    : "The first visible message defaults to a normal channel message; set reply=\"true\" or reply_to only when anchoring is clearly better.";
  const followUp = kind === "follow_up"
    ? "Default to <ignore> unless there is a concrete natural follow-up intent."
    : "Silence remains allowed if current context changed or the beat no longer fits.";
  return [
    `Ambient attention selected this turn as ${kind}.`,
    `Evaluator intent: ${decision.intent ?? "unspecified"}.`,
    `Evaluator reason: ${decision.reason}`,
    anchoring,
    followUp,
  ].join(" ");
}

function ambientEvaluatorPolicyForKind(kind: AmbientAttentionKind): string {
  const policies = promptBundle.runtime.ambientAttentionEvaluator;
  const kindPolicy = kind === "ambient_pickup"
    ? policies.ambientPickup
    : kind === "lingering_attention"
      ? policies.lingeringAttention
      : policies.followUp;
  return [policies.shared, kindPolicy].filter((part) => part.trim() !== "").join("\n\n");
}

function scheduleAmbientCandidate(candidate: AmbientCandidate): void {
  const guildConfig = getGuildConfig(candidate.guildId);
  const config = guildConfig.ambientAttention;
  if (config === undefined || !config.enabled) return;
  const mode = ambientModeConfig(config, candidate.kind);
  if (!mode.enabled) return;
  const delayMs = randomBetween(mode.minDelayMs, mode.maxDelayMs);
  logAmbientScheduled(candidate, delayMs);
  const timer = setTimeout(() => {
    ambientCandidateTimers.delete(candidate.id);
    void runAmbientCandidate(candidate);
  }, delayMs);
  ambientCandidateTimers.set(candidate.id, timer);
}

function clearAmbientAttentionState(): void {
  for (const timer of ambientCandidateTimers.values()) clearTimeout(timer);
  ambientCandidateTimers.clear();
  ambientLeases.clear();
  ambientPendingCandidates.clear();
  ambientTypingByChannelUser.clear();
  ambientReplyTimesByUser.clear();
  ambientReplyTimesByChannel.clear();
  ambientCooldowns.clear();
  ambientPickupChannelCooldowns.clear();
  ambientNormalTriggerUsers.clear();
}

type AmbientInitiativeDecision = {
  should_initiate: boolean;
  initiate_probability: number;
  kind: AmbientInitiativeKind;
  target_user_id: string | null;
  source: string;
  anchor: string;
  required_shape: string;
  avoid: string[];
  confidence: number;
  reason: string;
};

type AmbientInitiativeRunMode = "automatic" | "draft" | "shadow";

type AmbientInitiativeCandidate = {
  id: string;
  guildId: string;
  channelId: string;
  kind: AmbientInitiativeKind;
  createdAt: number;
  mode: AmbientInitiativeRunMode;
  forced: boolean;
  forceDecision: boolean;
  runToken?: string;
};

type AmbientInitiativeSignals = {
  now: number;
  inActiveHours: boolean;
  quietMs: number | null;
  lastHumanAt: number | null;
  lastBotAt: number | null;
  recentHumanCount: number;
  recentBotCount: number;
  activeTyping: boolean;
  pendingAmbientCandidates: number;
  activeImageJobs: number;
  familiarOnlineCount: number;
  openLoops: AmbientInitiativeOpenLoop[];
  recentInitiatives: AmbientInitiativeRecord[];
};

type AmbientInitiativeOpenLoop = {
  memoryId: number;
  userId: string | null;
  kind: string;
  content: string;
  ageMs: number;
};

type AmbientInitiativeRecord = {
  id: string;
  guildId: string;
  channelId: string;
  kind: AmbientInitiativeKind;
  targetUserId: string | null;
  summary: string;
  text: string;
  sent: boolean;
  ignored: boolean;
  createdAt: number;
};

type AmbientInitiativePressure = {
  kind: AmbientInitiativeKind;
  pressure: number;
  threshold: number;
  roll: number;
  passed: boolean;
  inputs: Record<string, number | boolean | string | null>;
};

const ambientInitiativeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const ambientInitiativeRunning = new Set<string>();
const ambientInitiativeLastByKind = new Map<string, number>();
const ambientInitiativeRecords: AmbientInitiativeRecord[] = [];
const AMBIENT_INITIATIVE_RECORD_LIMIT = 300;

function ambientInitiativeLockKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

function ambientInitiativeKindKey(kind: AmbientInitiativeKind, guildId: string, channelId: string): string {
  return `${kind}:${guildId}:${channelId}`;
}

function ambientInitiativeKindConfig(config: AmbientInitiativeConfig, kind: AmbientInitiativeKind): AmbientInitiativeKindConfig {
  if (kind === "self_expression") return config.selfExpression;
  return config.targetedCheckin;
}

function clearAmbientInitiativeState(): void {
  for (const timer of ambientInitiativeTimers.values()) clearTimeout(timer);
  ambientInitiativeTimers.clear();
  ambientInitiativeRunning.clear();
  ambientInitiativeLastByKind.clear();
}

function recordAmbientInitiativeEvent(record: AmbientInitiativeRecord): void {
  ambientInitiativeRecords.push(record);
  while (ambientInitiativeRecords.length > AMBIENT_INITIATIVE_RECORD_LIMIT) ambientInitiativeRecords.shift();
}

function recentAmbientInitiatives(guildId: string, channelId: string, now = Date.now()): AmbientInitiativeRecord[] {
  return ambientInitiativeRecords
    .filter((record) => record.guildId === guildId && record.channelId === channelId && now - record.createdAt <= 24 * 60 * 60 * 1000)
    .slice(-20);
}

function parseClockMinutes(value: string): number {
  const [hhRaw = "0", mmRaw = "0"] = value.split(":");
  return Number(hhRaw) * 60 + Number(mmRaw);
}

function localClockMinutes(timezone: string, now: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(now));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function ambientInitiativeInActiveHours(config: AmbientInitiativeConfig, guildConfig: GuildConfig, now = Date.now()): boolean {
  const timezone = config.activeHours.timezone ?? guildConfig.timezone;
  const current = localClockMinutes(timezone, now);
  const start = parseClockMinutes(config.activeHours.start);
  const end = parseClockMinutes(config.activeHours.end);
  if (start === end) return true;
  if (start < end) return current >= start && current <= end;
  return current >= start || current <= end;
}

function ambientInitiativeDailyCount(input: {
  guildId: string;
  channelId: string;
  kind?: AmbientInitiativeKind;
  targetUserId?: string | null;
  now?: number;
}): number {
  const now = input.now ?? Date.now();
  return ambientInitiativeRecords.filter((record) =>
    record.guildId === input.guildId &&
    record.channelId === input.channelId &&
    now - record.createdAt <= 24 * 60 * 60 * 1000 &&
    (input.kind === undefined || record.kind === input.kind) &&
    (input.targetUserId === undefined || record.targetUserId === input.targetUserId) &&
    record.sent
  ).length;
}

function resolveAmbientInitiativeMainChannel(guild: Guild, config: AmbientInitiativeConfig): SendableGuildChannel | null {
  if (config.mainChannelId !== undefined && config.mainChannelId !== "") {
    const configured = client.channels.cache.get(config.mainChannelId);
    return configured !== undefined && isSendableGuildChannel(configured) && configured.guildId === guild.id
      ? configured
      : null;
  }

  const after = Date.now() - config.mainChannelLookbackDays * 24 * 60 * 60 * 1000;
  const rows = db.raw
    .prepare(
      `SELECT channel_id, COUNT(*) AS count
       FROM messages
       WHERE guild_id = ? AND is_bot = 0 AND is_synthetic = 0 AND is_prompt_only = 0 AND created_at >= ?
       GROUP BY channel_id
       ORDER BY count DESC`
    )
    .all(guild.id, after) as Array<{ channel_id: string; count: number }>;

  for (const row of rows) {
    if (row.count < config.minMainChannelHumanMessages) continue;
    const channel = client.channels.cache.get(row.channel_id);
    if (channel === undefined || !isSendableGuildChannel(channel) || channel.guildId !== guild.id) continue;
    if (!botChannelPermissions(channel).canSend) continue;
    return channel;
  }

  return null;
}

function activeImageJobsInChannel(guildId: string, channelId: string): number {
  return agentJobs.listVisible(guildId, channelId).filter((job) => isActiveJobStatus(job.status)).length;
}

function pendingAmbientCandidatesInChannel(guildId: string, channelId: string): number {
  let count = 0;
  for (const pending of ambientPendingCandidates.values()) {
    if (pending.candidate.guildId === guildId && pending.candidate.channelId === channelId) count += 1;
  }
  return count;
}

function ambientInitiativeOpenLoops(guild: Guild, channelId: string, config: AmbientInitiativeConfig, now = Date.now()): AmbientInitiativeOpenLoop[] {
  const maxAgeMs = config.targetedCheckin.openLoopMaxAgeMs;
  const rows = db.raw
    .prepare(
      `SELECT memories.id, memories.scope, memories.subject_user_id, memories.kind, memories.content, memories.updated_at,
              messages.guild_id AS source_guild_id, messages.channel_id AS source_channel_id
       FROM memories
       LEFT JOIN messages ON messages.id = memories.source_message_id
       WHERE memories.deleted_at IS NULL
         AND (memories.expires_at IS NULL OR memories.expires_at > ?)
         AND memories.updated_at >= ?
         AND (
           (scope = 'user' AND subject_user_id IS NOT NULL)
           OR (scope = 'guild' AND memories.guild_id = ?)
         )
       ORDER BY memories.updated_at DESC, memories.id DESC
       LIMIT 20`
    )
    .all(now, now - maxAgeMs, guild.id) as Array<{
      id: number;
      scope: string;
      subject_user_id: string | null;
      kind: string;
      content: string;
      updated_at: number;
      source_guild_id: string | null;
      source_channel_id: string | null;
    }>;

  return rows
    .filter((row) => {
      if (row.scope === "user") {
        if (row.subject_user_id === null || !guild.members.cache.has(row.subject_user_id)) return false;
        if (row.source_guild_id !== null && row.source_guild_id !== guild.id) return false;
      }
      if (row.scope === "guild" && row.source_channel_id !== null && row.source_channel_id !== channelId) return false;
      const content = row.content.toLowerCase();
      return row.kind === "scratchpad" || content.includes("check") || content.includes("later") || content.includes("собира");
    })
    .map((row) => ({
      memoryId: row.id,
      userId: row.subject_user_id,
      kind: row.kind,
      content: row.content,
      ageMs: now - row.updated_at,
    }));
}

function familiarOnlineCount(guild: Guild, guildId: string): number {
  const memoryCounts = countUserMemoriesByUser(db, guildId);
  let count = 0;
  for (const [userId, memoryCount] of memoryCounts) {
    if (memoryCount <= 0) continue;
    const member = guild.members.cache.get(userId);
    const status = member?.presence?.status;
    if (status === "online" || status === "idle" || status === "dnd") count += 1;
  }
  return count;
}

function latestMessageStats(guildId: string, channelId: string, config: AmbientInitiativeConfig, now: number): {
  lastHumanAt: number | null;
  lastBotAt: number | null;
  recentHumanCount: number;
  recentBotCount: number;
} {
  const after = now - config.recentActivityMaxMs;
  const rows = db.raw
    .prepare(
      `SELECT is_bot, created_at
       FROM messages
       WHERE guild_id = ? AND channel_id = ? AND is_synthetic = 0 AND is_prompt_only = 0 AND created_at >= ?
       ORDER BY created_at DESC, id DESC
       LIMIT 200`
    )
    .all(guildId, channelId, after) as Array<{ is_bot: number; created_at: number }>;
  let lastHumanAt: number | null = null;
  let lastBotAt: number | null = null;
  let recentHumanCount = 0;
  let recentBotCount = 0;
  for (const row of rows) {
    if (row.is_bot === 1) {
      recentBotCount += 1;
      lastBotAt ??= row.created_at;
    } else {
      recentHumanCount += 1;
      lastHumanAt ??= row.created_at;
    }
  }
  return { lastHumanAt, lastBotAt, recentHumanCount, recentBotCount };
}

function buildAmbientInitiativeSignals(guild: Guild, channelId: string, guildConfig: GuildConfig, config: AmbientInitiativeConfig): AmbientInitiativeSignals {
  const now = Date.now();
  const stats = latestMessageStats(guild.id, channelId, config, now);
  return {
    now,
    inActiveHours: ambientInitiativeInActiveHours(config, guildConfig, now),
    quietMs: stats.lastHumanAt !== null ? now - stats.lastHumanAt : null,
    ...stats,
    activeTyping: activeTypingInChannel(guild.id, channelId, config.typingActiveMs, now),
    pendingAmbientCandidates: pendingAmbientCandidatesInChannel(guild.id, channelId),
    activeImageJobs: activeImageJobsInChannel(guild.id, channelId),
    familiarOnlineCount: familiarOnlineCount(guild, guild.id),
    openLoops: ambientInitiativeOpenLoops(guild, channelId, config, now),
    recentInitiatives: recentAmbientInitiatives(guild.id, channelId, now),
  };
}

function ambientInitiativeHardGate(input: {
  guildId: string;
  channelId: string;
  kind?: AmbientInitiativeKind;
  config: AmbientInitiativeConfig;
  signals: AmbientInitiativeSignals;
  forced: boolean;
  phase: "opportunity" | "pre_send";
}): { ok: true } | { ok: false; reason: string } {
  if (!input.config.enabled && !input.forced) return { ok: false, reason: "ambient initiative disabled" };
  if (input.phase === "pre_send" && input.signals.activeTyping) return { ok: false, reason: "user typing active" };
  if (input.signals.activeImageJobs > 0) return { ok: false, reason: "active image job visible" };
  if (input.signals.pendingAmbientCandidates > 0) return { ok: false, reason: "ambient attention pending" };
  if (!input.forced && !input.signals.inActiveHours) return { ok: false, reason: "outside active hours" };
  if (!input.forced && input.signals.activeTyping) return { ok: false, reason: "user typing active" };
  if (!input.forced && input.signals.lastBotAt !== null && input.signals.now - input.signals.lastBotAt < input.config.botCooldownMs) {
    return { ok: false, reason: "recent 2b output" };
  }
  if (!input.forced && input.signals.quietMs !== null && input.signals.quietMs < input.config.quietWindowMs) {
    return { ok: false, reason: "quiet window too short" };
  }
  if (!input.forced && input.signals.lastHumanAt === null) return { ok: false, reason: "no recent human activity" };
  if (!input.forced && input.signals.lastHumanAt !== null && input.signals.now - input.signals.lastHumanAt < input.config.recentActivityMinMs) {
    return { ok: false, reason: "human activity too fresh" };
  }
  if (!input.forced && input.signals.lastHumanAt !== null && input.signals.now - input.signals.lastHumanAt > input.config.recentActivityMaxMs) {
    return { ok: false, reason: "room too dead" };
  }
  if (!input.forced && ambientInitiativeDailyCount({ guildId: input.guildId, channelId: input.channelId, now: input.signals.now }) >= input.config.maxPerDay) {
    return { ok: false, reason: "daily initiative budget exhausted" };
  }
  if (input.kind !== undefined) {
    const kindConfig = ambientInitiativeKindConfig(input.config, input.kind);
    if (!kindConfig.enabled && !input.forced) return { ok: false, reason: `${input.kind} disabled` };
    if (!input.forced && ambientInitiativeDailyCount({ guildId: input.guildId, channelId: input.channelId, kind: input.kind, now: input.signals.now }) >= kindConfig.maxPerDay) {
      return { ok: false, reason: `${input.kind} daily budget exhausted` };
    }
    const lastKind = ambientInitiativeLastByKind.get(ambientInitiativeKindKey(input.kind, input.guildId, input.channelId)) ?? 0;
    if (!input.forced && input.signals.now - lastKind < kindConfig.cooldownMs) return { ok: false, reason: `${input.kind} cooldown active` };
  }
  return { ok: true };
}

function ambientInitiativePressureForKind(
  config: AmbientInitiativeConfig,
  kind: AmbientInitiativeKind,
  signals: AmbientInitiativeSignals,
): AmbientInitiativePressure {
  const kindConfig = ambientInitiativeKindConfig(config, kind);
  let pressure = kindConfig.basePressure;
  const quietMs = signals.quietMs ?? 0;
  if (signals.inActiveHours) pressure += 0.12;
  if (signals.lastHumanAt !== null && quietMs >= config.quietWindowMs) pressure += 0.18;
  if (signals.lastHumanAt !== null && quietMs <= config.recentActivityMaxMs) pressure += 0.08;
  if (signals.familiarOnlineCount > 0) pressure += Math.min(0.16, signals.familiarOnlineCount * 0.04);
  if (signals.openLoops.length > 0 && kind === "targeted_checkin") pressure += 0.24;
  if (signals.lastBotAt !== null) pressure -= Math.max(0, 0.25 - Math.min(0.25, (signals.now - signals.lastBotAt) / Math.max(1, config.fatigueAfterAnyMs) * 0.25));
  if (signals.recentInitiatives.length > 0) pressure -= 0.12;
  if (!signals.inActiveHours) pressure -= 0.35;
  if (signals.lastHumanAt === null) pressure -= 0.25;
  const finalPressure = Math.max(0, Math.min(1, pressure));
  const roll = Math.random();
  return {
    kind,
    pressure: finalPressure,
    threshold: kindConfig.pressureThreshold,
    roll,
    passed: finalPressure >= kindConfig.pressureThreshold && roll <= finalPressure,
    inputs: {
      inActiveHours: signals.inActiveHours,
      quietMs,
      familiarOnlineCount: signals.familiarOnlineCount,
      openLoops: signals.openLoops.length,
      recentInitiatives: signals.recentInitiatives.length,
      lastBotAgeMs: signals.lastBotAt !== null ? signals.now - signals.lastBotAt : null,
    },
  };
}

function initiativeEvaluatorPolicyForKind(kind: AmbientInitiativeKind): string {
  const policies = promptBundle.runtime.ambientInitiative.evaluator;
  const kindPolicy = kind === "self_expression"
    ? policies.selfExpression
    : policies.targetedCheckin;
  return [policies.shared, kindPolicy].filter((part) => part.trim() !== "").join("\n\n");
}

function initiativeGenerationPolicyForKind(kind: AmbientInitiativeKind): string {
  const policies = promptBundle.runtime.ambientInitiative.generation;
  const kindPolicy = kind === "self_expression"
    ? policies.selfExpression
    : policies.targetedCheckin;
  return [policies.shared, kindPolicy].filter((part) => part.trim() !== "").join("\n\n");
}

function renderAmbientInitiativeSignals(signals: AmbientInitiativeSignals): string {
  return [
    `active_hours: ${signals.inActiveHours}`,
    `quiet_ms: ${signals.quietMs ?? "none"}`,
    `recent_human_count: ${signals.recentHumanCount}`,
    `recent_bot_count: ${signals.recentBotCount}`,
    `active_typing: ${signals.activeTyping}`,
    `pending_ambient_candidates: ${signals.pendingAmbientCandidates}`,
    `active_image_jobs: ${signals.activeImageJobs}`,
    `familiar_online_count: ${signals.familiarOnlineCount}`,
  ].join("\n");
}

function renderAmbientInitiativeOpenLoops(openLoops: AmbientInitiativeOpenLoop[]): string {
  if (openLoops.length === 0) return "none";
  return openLoops.slice(0, 8).map((loop) =>
    `- memory_id=${loop.memoryId} user_id=${loop.userId ?? "none"} kind=${loop.kind} age_ms=${loop.ageMs}: ${loop.content}`
  ).join("\n");
}

function renderAmbientInitiativeRecent(records: AmbientInitiativeRecord[]): string {
  if (records.length === 0) return "none";
  return records.slice(-8).map((record) =>
    `- ${new Date(record.createdAt).toISOString()} kind=${record.kind} target=${record.targetUserId ?? "none"} sent=${record.sent} ignored=${record.ignored}: ${record.summary}`
  ).join("\n");
}

function forcedAmbientInitiativeDecision(kind: AmbientInitiativeKind, signals: AmbientInitiativeSignals, history: HistoryMessage[]): AmbientInitiativeDecision | null {
  const loop = signals.openLoops.find((item) => item.userId !== null);
  const latestHuman = [...history].reverse().find((message) => !message.isBot);
  const targetUserId = kind === "targeted_checkin" ? loop?.userId ?? latestHuman?.authorId ?? null : null;
  if (kind === "targeted_checkin" && targetUserId === null) return null;
  return {
    should_initiate: true,
    initiate_probability: 1,
    kind,
    target_user_id: targetUserId,
    source: "prompt_lab_force",
    anchor: loop?.content ?? latestHuman?.content ?? "Prompt Lab forced initiative draft.",
    required_shape: kind === "self_expression" ? "concrete_incomplete_disposable" : "brief_anchored_followup",
    avoid: ["forced", "performative", "creepy", "polished"],
    confidence: 1,
    reason: "Prompt Lab force bypassed evaluator.",
  };
}

function createAmbientInitiativeRequestLog(input: {
  guild: Guild;
  channel: SendableGuildChannel;
  candidate: AmbientInitiativeCandidate;
  status: string;
}): RequestLog {
  const requestLog = new RequestLog(input.candidate.guildId, input.candidate.channelId, requestLogStore);
  requestLog.setAuthor(input.candidate.mode === "draft" ? "prompt-lab:ambient-initiative" : "ambient-initiative");
  requestLog.setTrigger({
    type: "ambient_initiative_evaluator",
    kind: input.candidate.kind,
    status: input.status,
    mode: input.candidate.mode,
    ...(input.candidate.runToken !== undefined ? { runToken: input.candidate.runToken } : {}),
  });
  requestLog.setTriggerContext({
    ...dashboardTriggerLocation(input.guild, input.channel),
    messageId: input.candidate.id,
    authorUsername: "ambient-initiative",
    content: `${input.candidate.kind} opportunity`,
    translatedContent: `${input.candidate.kind} opportunity`,
  });
  requestLog.setAgentRan(true);
  return requestLog;
}

async function evaluateAmbientInitiativeCandidate(input: {
  config: AmbientInitiativeConfig;
  guildConfig: GuildConfig;
  candidate: AmbientInitiativeCandidate;
  signals: AmbientInitiativeSignals;
  pressure: AmbientInitiativePressure;
  history: HistoryMessage[];
  requestLog: RequestLog;
}): Promise<AmbientInitiativeDecision | null> {
  const streamOptions = buildAmbientInitiativeStreamOptions(globalConfig, input.guildConfig);
  const providerParams: Record<string, unknown> = { ...streamOptions };
  delete providerParams.apiKey;
  const provider = input.config.evaluator.provider ?? resolveGuildLlmProvider(globalConfig, input.guildConfig);
  const system = [
    initiativeEvaluatorPolicyForKind(input.candidate.kind),
    "Return only compact JSON with should_initiate, initiate_probability, kind, target_user_id, source, anchor, required_shape, avoid, confidence, reason.",
    "initiate_probability and confidence must be 0..1. avoid must be a short string array.",
  ].filter((part) => part.trim() !== "").join("\n\n");
  const user = [
    `forced_draft: ${input.candidate.forced}`,
    `candidate_kind: ${input.candidate.kind}`,
    `now: ${new Date(input.signals.now).toISOString()}`,
    "",
    "Signals:",
    renderAmbientInitiativeSignals(input.signals),
    "",
    "Pressure:",
    JSON.stringify(input.pressure, null, 2),
    "",
    "Open loops / memory anchors:",
    renderAmbientInitiativeOpenLoops(input.signals.openLoops),
    "",
    "Recent initiatives to avoid repeating:",
    renderAmbientInitiativeRecent(input.signals.recentInitiatives),
    "",
    "Recent channel history:",
    renderAmbientHistory(input.history, ""),
  ].join("\n");
  try {
    const result = await completeLlmChat({
      provider,
      apiKey: streamOptions.apiKey,
      model: input.config.evaluator.model,
      systemPrompt: system,
      messages: [{ role: "user", content: user }],
      providerParams,
      onPayload: (payload) => input.requestLog.recordLLMRequest(payload),
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: "ambient_initiative_decision",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["should_initiate", "initiate_probability", "kind", "target_user_id", "source", "anchor", "required_shape", "avoid", "confidence", "reason"],
            properties: {
              should_initiate: { type: "boolean" },
              initiate_probability: { type: "number", minimum: 0, maximum: 1 },
              kind: { type: "string", enum: ["self_expression", "targeted_checkin"] },
              target_user_id: { type: ["string", "null"] },
              source: { type: "string" },
              anchor: { type: "string" },
              required_shape: { type: "string" },
              avoid: { type: "array", items: { type: "string" } },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reason: { type: "string" },
            },
          },
        },
      },
      toolChoice: "none",
      parallelToolCalls: false,
      signal: AbortSignal.timeout(input.config.evaluator.llmOutputTimeoutMs),
    });
    input.requestLog.recordLLMCompletion(result.messageForLogs);
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    const kind = parsed.kind === "targeted_checkin" ? "targeted_checkin" : "self_expression";
    return {
      should_initiate: parsed.should_initiate === true,
      initiate_probability: typeof parsed.initiate_probability === "number" ? Math.max(0, Math.min(1, parsed.initiate_probability)) : 0,
      kind,
      target_user_id: typeof parsed.target_user_id === "string" && parsed.target_user_id !== "" ? parsed.target_user_id : null,
      source: typeof parsed.source === "string" ? parsed.source : "",
      anchor: typeof parsed.anchor === "string" ? parsed.anchor : "",
      required_shape: typeof parsed.required_shape === "string" ? parsed.required_shape : "",
      avoid: Array.isArray(parsed.avoid) ? parsed.avoid.filter((item): item is string => typeof item === "string") : [],
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch (error) {
    input.requestLog.recordLLMError(error);
    log.warn("ambient initiative evaluation failed", {
      kind: input.candidate.kind,
      guildId: input.candidate.guildId,
      channelId: input.candidate.channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function ambientInitiativeDecisionPassed(input: {
  config: AmbientInitiativeConfig;
  candidate: AmbientInitiativeCandidate;
  decision: AmbientInitiativeDecision;
}): { passed: boolean; explanation: string; probabilityThreshold: number; confidenceThreshold: number } {
  const kindConfig = ambientInitiativeKindConfig(input.config, input.candidate.kind);
  if (!input.decision.should_initiate) {
    return {
      passed: false,
      explanation: "Evaluator explicitly chose silence.",
      probabilityThreshold: kindConfig.probabilityThreshold,
      confidenceThreshold: kindConfig.confidenceThreshold,
    };
  }
  if (input.decision.kind !== input.candidate.kind) {
    return {
      passed: false,
      explanation: `Evaluator returned ${input.decision.kind} for a ${input.candidate.kind} candidate.`,
      probabilityThreshold: kindConfig.probabilityThreshold,
      confidenceThreshold: kindConfig.confidenceThreshold,
    };
  }
  if (input.decision.initiate_probability < kindConfig.probabilityThreshold) {
    return {
      passed: false,
      explanation: `Initiate probability ${input.decision.initiate_probability.toFixed(2)} was below threshold ${kindConfig.probabilityThreshold.toFixed(2)}.`,
      probabilityThreshold: kindConfig.probabilityThreshold,
      confidenceThreshold: kindConfig.confidenceThreshold,
    };
  }
  if (input.candidate.kind === "self_expression" && input.decision.target_user_id !== null) {
    return {
      passed: false,
      explanation: "Self-expression must not target a specific user.",
      probabilityThreshold: kindConfig.probabilityThreshold,
      confidenceThreshold: kindConfig.confidenceThreshold,
    };
  }
  if (input.candidate.kind === "targeted_checkin") {
    if (input.decision.target_user_id === null) {
      return {
        passed: false,
        explanation: "Targeted follow-up must name a target user.",
        probabilityThreshold: kindConfig.probabilityThreshold,
        confidenceThreshold: kindConfig.confidenceThreshold,
      };
    }
    if (!input.candidate.forced && ambientInitiativeDailyCount({
      guildId: input.candidate.guildId,
      channelId: input.candidate.channelId,
      kind: input.candidate.kind,
      targetUserId: input.decision.target_user_id,
    }) >= input.config.targetedCheckin.maxPerUserPerDay) {
      return {
        passed: false,
        explanation: `Target user already reached daily cap ${input.config.targetedCheckin.maxPerUserPerDay}.`,
        probabilityThreshold: kindConfig.probabilityThreshold,
        confidenceThreshold: kindConfig.confidenceThreshold,
      };
    }
  }
  if (input.decision.confidence < kindConfig.confidenceThreshold) {
    return {
      passed: false,
      explanation: `Confidence ${input.decision.confidence.toFixed(2)} was below threshold ${kindConfig.confidenceThreshold.toFixed(2)}.`,
      probabilityThreshold: kindConfig.probabilityThreshold,
      confidenceThreshold: kindConfig.confidenceThreshold,
    };
  }
  return {
    passed: true,
    explanation: "Evaluator decision cleared kind and confidence thresholds.",
    probabilityThreshold: kindConfig.probabilityThreshold,
    confidenceThreshold: kindConfig.confidenceThreshold,
  };
}

function ambientInitiativeGenerationInstruction(decision: AmbientInitiativeDecision): string {
  const target = decision.target_user_id !== null ? `target_user_id: ${decision.target_user_id}` : "target_user_id: none";
  return [
    "Ambient Initiative selected this proactive turn.",
    initiativeGenerationPolicyForKind(decision.kind),
    "",
    "Evaluator handoff:",
    `kind: ${decision.kind}`,
    target,
    `source: ${decision.source}`,
    `anchor: ${decision.anchor}`,
    `required_shape: ${decision.required_shape}`,
    `avoid: ${decision.avoid.length > 0 ? decision.avoid.join(", ") : "none"}`,
    `reason: ${decision.reason}`,
    "",
    "You may still output <ignore> if the initiative no longer fits. Default visible message delivery is reply=false.",
  ].join("\n");
}

function selfMemoryConstraintText(guildId: string): string {
  const self = listMemories(db, {
    guildId,
    scope: "self",
    limit: 12,
  });
  if (self.length === 0) return "Self memory constraints: none.";
  return [
    "Self memory constraints, for contradiction avoidance only:",
    ...self.map((memory) => `- [${memory.kind}] ${memory.content}`),
  ].join("\n");
}

function initiativeTargetUser(guild: Guild, decision: AmbientInitiativeDecision): {
  id: string;
  username: string;
  displayName?: string;
  globalName?: string;
} {
  if (decision.target_user_id !== null) return promptLabUserFromGuild(guild, decision.target_user_id);
  return {
    id: "ambient-initiative",
    username: "ambient-initiative",
  };
}

async function runAmbientInitiativeGeneration(input: {
  guild: Guild;
  channel: SendableGuildChannel;
  guildConfig: GuildConfig;
  config: AmbientInitiativeConfig;
  candidate: AmbientInitiativeCandidate;
  decision: AmbientInitiativeDecision;
  requestLog: RequestLog;
  draft?: {
    drafts: PromptLabDraftMessage[];
    dryRuns: PromptLabDryRun[];
  };
}): Promise<{ responseText?: string; sent: boolean; ignored: boolean }> {
  const botUserId = client.user?.id ?? "";
  const botUsername = client.user?.username ?? "bot";
  const now = Date.now();
  const syntheticContent = [
    ambientInitiativeGenerationInstruction(input.decision),
    "",
    selfMemoryConstraintText(input.candidate.guildId),
  ].filter((part) => part !== "").join("\n");
  const actor = initiativeTargetUser(input.guild, input.decision);
  const syntheticLatestMessage: HistoryMessage = {
    id: input.candidate.id,
    author: actor.username,
    authorDisplayName: actor.displayName,
    authorId: actor.id,
    content: syntheticContent,
    isBot: false,
    timestamp: now,
    replyToId: null,
    imageIds: [],
    captions: [],
    hasEmbeds: false,
    isSynthetic: true,
    relatedThreadId: null,
  };

  const replyFallbackDeps: ReplyFallbackDeps = {
    db,
    guildId: input.candidate.guildId,
    channelId: input.candidate.channelId,
    fetchDiscordMessage: () => Promise.resolve(null),
    enqueueEmbedding: async () => {},
    processImage: async () => {},
  };
  const context = await buildContext(
    input.candidate.guildId,
    input.candidate.channelId,
    input.guild,
    input.guildConfig,
    syntheticContent,
    syntheticLatestMessage,
    replyFallbackDeps,
    input.channel.isThread(),
    { timestamp: now, messageId: input.candidate.id },
    "virtual",
  );

  const generatedImages = createGeneratedImageRuntime();
  const baseTools = buildAgentTools(
    input.candidate.guildId,
    input.candidate.channelId,
    input.guildConfig,
    input.guild,
    context.contextMessageIds,
    generatedImages.onGeneratedImage,
    {
      requesterId: actor.id,
      requesterUsername: actor.username,
      sourceMessageId: input.candidate.id,
      sourceQuote: shortQuote(syntheticContent),
    },
  );
  const tools = input.draft !== undefined ? promptLabDryRunTools(baseTools, input.draft.dryRuns) : baseTools;

  const resolveTargetChannel = createTargetChannelResolver(client, input.channel);
  const baseSender = createDiscordMessageSender({
    defaultChannel: input.channel,
    resolveTargetChannel,
    botUserId,
    botUsername,
    logger: log.child({ component: "ambient-initiative-send", guildId: input.candidate.guildId, channelId: input.candidate.channelId }),
    getAttachmentsDir: (targetGuildId) => getGuildConfig(targetGuildId).attachmentsDir,
  });
  const draftSender: MessageSender = (text, reply, destinationChannelId, voice, _signal, replyToMessageId, attachments) => {
    if (input.draft === undefined) return baseSender(text, reply, destinationChannelId, voice, _signal, replyToMessageId, attachments);
    const id = promptLabSyntheticId(input.draft.drafts.length + 1);
    input.draft.drafts.push({
      id,
      text,
      reply,
      ...(destinationChannelId !== undefined ? { channelId: destinationChannelId } : {}),
      ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
      attachments: attachments?.map((attachment) => attachment.filename) ?? [],
      voice: voice !== undefined,
    });
    return Promise.resolve({ sentMessageId: id });
  };

  const preSendCheck = (): boolean => {
    const signals = buildAmbientInitiativeSignals(input.guild, input.candidate.channelId, input.guildConfig, input.config);
    const gate = ambientInitiativeHardGate({
      guildId: input.candidate.guildId,
      channelId: input.candidate.channelId,
      kind: input.candidate.kind,
      config: input.config,
      signals,
      forced: input.candidate.forced,
      phase: "pre_send",
    });
    recordAmbientRuntimeAction(
      input.requestLog,
      `ambient-initiative-pre-send:${input.candidate.id}`,
      "ambient_initiative_pre_send_gate",
      { kind: input.candidate.kind, mode: input.candidate.mode },
      gate.ok
        ? { status: "passed", summary: "Pre-send gates passed." }
        : { status: "dropped", reason: gate.reason, decidingParameter: `hard_gate.${gate.reason.replaceAll(" ", "_")}` },
    );
    return gate.ok;
  };

  const result = await handleMessage(
    {
      content: syntheticContent,
      guildId: input.candidate.guildId,
      guildName: input.guild.name,
      channelId: input.candidate.channelId,
      channelName: channelDisplayName(input.channel),
      authorId: actor.id,
      authorUsername: actor.username,
      authorDisplayName: actor.displayName,
      authorGlobalName: actor.globalName,
      authorIsBot: false,
      botUserId,
      mentionedUserIds: [],
      translatedContent: syntheticContent,
      messageId: input.candidate.id,
    },
    {
      globalConfig,
      guildConfig: input.guildConfig,
      context,
      currentChannelId: input.candidate.channelId,
      systemPrompt: promptBundle.systemPrompt,
      personaPrompt: promptBundle.corePrompt,
      runtimePrompts: promptBundle.runtime,
      sender: draftSender,
      extraTools: tools,
      log: log.child({ guildId: input.candidate.guildId, channelId: input.candidate.channelId, requestId: input.requestLog.requestId, component: "ambient-initiative" }),
      requestLog: input.requestLog,
      triggerOverride: { reason: "ambient_initiative" },
      triggerInstructions: {
        ...input.guildConfig.triggerInstructions,
        ambient_initiative: ambientInitiativeGenerationInstruction(input.decision),
      },
      liveMessageTypingHoldMs: 0,
      modelImageInputSupport: getModelImageInputSupport(input.guildConfig),
      disableLiveOutput: true,
      replyFirstOverride: false,
      preSendCheck,
      consumeGeneratedAttachments: generatedImages.consumeGeneratedAttachments,
      resolveImageAttachments: createStoredImageAttachmentResolver({
        guildId: input.candidate.guildId,
        logger: log.child({ component: "stored-image-attachments", guildId: input.candidate.guildId, channelId: input.candidate.channelId, requestId: input.requestLog.requestId }),
      }),
    },
  );

  return {
    ...(result.responseText !== undefined ? { responseText: result.responseText } : {}),
    sent: result.responseText !== undefined && result.responseText !== "",
    ignored: result.responseText === undefined || result.responseText === "",
  };
}

async function runAmbientInitiativeCandidate(input: {
  guild: Guild;
  channel: SendableGuildChannel;
  candidate: AmbientInitiativeCandidate;
  draft?: {
    drafts: PromptLabDraftMessage[];
    dryRuns: PromptLabDryRun[];
  };
}): Promise<{ requestId: string; drafts?: PromptLabDraftMessage[]; responseText?: string; sent: boolean; ignored: boolean; error?: string }> {
  const guildConfig = getGuildConfig(input.candidate.guildId);
  const config = guildConfig.ambientInitiative;
  if (config === undefined) throw new Error("Ambient initiative is not configured for this guild.");
  const lockKey = ambientInitiativeLockKey(input.candidate.guildId, input.candidate.channelId);
  const requestLog = createAmbientInitiativeRequestLog({
    guild: input.guild,
    channel: input.channel,
    candidate: input.candidate,
    status: "evaluating",
  });
  requestLogStore.incrementActive();
  if (ambientInitiativeRunning.has(lockKey)) {
    recordAmbientRuntimeAction(
      requestLog,
      `ambient-initiative-lock:${input.candidate.id}`,
      "ambient_initiative_lock",
      { kind: input.candidate.kind, mode: input.candidate.mode },
      { status: "dropped", reason: "initiative already running", decidingParameter: "lock.initiative_already_running" },
    );
    requestLog.emit(log);
    requestLogStore.decrementActive();
    return { requestId: requestLog.requestId, drafts: input.draft?.drafts, sent: false, ignored: true };
  }
  ambientInitiativeRunning.add(lockKey);
  let sent = false;
  let ignored = false;
  let responseText: string | undefined;

  try {
    const signals = buildAmbientInitiativeSignals(input.guild, input.candidate.channelId, guildConfig, config);
    const gate = ambientInitiativeHardGate({
      guildId: input.candidate.guildId,
      channelId: input.candidate.channelId,
      kind: input.candidate.kind,
      config,
      signals,
      forced: input.candidate.forced,
      phase: "opportunity",
    });
    recordAmbientRuntimeAction(
      requestLog,
      `ambient-initiative-hard-gate:${input.candidate.id}`,
      "ambient_initiative_hard_gate",
      { kind: input.candidate.kind, mode: input.candidate.mode, forced: input.candidate.forced },
      gate.ok
        ? { status: "passed", signals, summary: "Hard gates passed." }
        : { status: "dropped", reason: gate.reason, signals, decidingParameter: `hard_gate.${gate.reason.replaceAll(" ", "_")}` },
    );
    if (!gate.ok) {
      ignored = true;
      return { requestId: requestLog.requestId, drafts: input.draft?.drafts, sent, ignored };
    }

    const pressure = input.candidate.forced
      ? {
          kind: input.candidate.kind,
          pressure: 1,
          threshold: 0,
          roll: 0,
          passed: true,
          inputs: { forced: true },
        } satisfies AmbientInitiativePressure
      : ambientInitiativePressureForKind(config, input.candidate.kind, signals);
    recordAmbientRuntimeAction(
      requestLog,
      `ambient-initiative-pressure:${input.candidate.id}`,
      "ambient_initiative_pressure",
      { kind: input.candidate.kind },
      {
        status: pressure.passed ? "passed" : "dropped",
        ...pressure,
        decidingParameter: pressure.passed ? "pressure.passed" : "pressure.roll_or_threshold",
      },
    );
    if (!pressure.passed) {
      ignored = true;
      return { requestId: requestLog.requestId, drafts: input.draft?.drafts, sent, ignored };
    }

    const history = getHistoryMessages(db, input.candidate.channelId, config.historyLimit);
    const decision = input.candidate.forceDecision
      ? forcedAmbientInitiativeDecision(input.candidate.kind, signals, history)
      : await evaluateAmbientInitiativeCandidate({
          config,
          guildConfig,
          candidate: input.candidate,
          signals,
          pressure,
          history,
          requestLog,
        });
    if (decision === null) {
      recordAmbientRuntimeAction(
        requestLog,
        `ambient-initiative-decision:${input.candidate.id}`,
        "ambient_initiative_decision",
        { kind: input.candidate.kind },
        input.candidate.forceDecision
          ? { status: "dropped", decidingParameter: "force.no_target", summary: "Forced targeted draft had no target user." }
          : { status: "dropped", decidingParameter: "evaluator_error", summary: "Evaluator did not return a usable decision." },
        true,
      );
      ignored = true;
      return { requestId: requestLog.requestId, drafts: input.draft?.drafts, sent, ignored };
    }

    const verdict = ambientInitiativeDecisionPassed({ config, candidate: input.candidate, decision });
    recordAmbientRuntimeAction(
      requestLog,
      `ambient-initiative-decision:${input.candidate.id}`,
      "ambient_initiative_decision",
      {
        kind: input.candidate.kind,
        decision,
        thresholds: {
          confidence: verdict.confidenceThreshold,
          probability: verdict.probabilityThreshold,
        },
      },
      {
        status: verdict.passed ? "selected" : "dropped",
        explanation: verdict.explanation,
        shouldInitiate: decision.should_initiate,
        confidence: decision.confidence,
        initiateProbability: decision.initiate_probability,
        probabilityThreshold: verdict.probabilityThreshold,
        confidenceThreshold: verdict.confidenceThreshold,
        reason: decision.reason,
        source: decision.source,
        anchor: decision.anchor,
        requiredShape: decision.required_shape,
        avoid: decision.avoid,
      },
    );
    if (!verdict.passed) {
      ignored = true;
      return { requestId: requestLog.requestId, drafts: input.draft?.drafts, sent, ignored };
    }

    const generation = await runAmbientInitiativeGeneration({
      guild: input.guild,
      channel: input.channel,
      guildConfig,
      config,
      candidate: input.candidate,
      decision,
      requestLog,
      draft: input.draft,
    });
    const producedVisibleDraftOrMessage = generation.sent && (input.draft === undefined || input.draft.drafts.length > 0);
    sent = producedVisibleDraftOrMessage && input.candidate.mode === "automatic";
    ignored = generation.ignored || !producedVisibleDraftOrMessage;
    responseText = generation.responseText;
    if (producedVisibleDraftOrMessage) {
      if (sent) {
        ambientInitiativeLastByKind.set(ambientInitiativeKindKey(input.candidate.kind, input.candidate.guildId, input.candidate.channelId), Date.now());
      }
      recordAmbientInitiativeEvent({
        id: input.candidate.id,
        guildId: input.candidate.guildId,
        channelId: input.candidate.channelId,
        kind: input.candidate.kind,
        targetUserId: decision.target_user_id,
        summary: decision.reason,
        text: responseText ?? "",
        sent,
        ignored,
        createdAt: Date.now(),
      });
    } else {
      recordAmbientInitiativeEvent({
        id: input.candidate.id,
        guildId: input.candidate.guildId,
        channelId: input.candidate.channelId,
        kind: input.candidate.kind,
        targetUserId: decision.target_user_id,
        summary: decision.reason,
        text: responseText ?? "",
        sent: false,
        ignored: true,
        createdAt: Date.now(),
      });
    }
    return { requestId: requestLog.requestId, drafts: input.draft?.drafts, responseText, sent, ignored };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    requestLog.setError(message);
    return { requestId: requestLog.requestId, drafts: input.draft?.drafts, sent, ignored: true, error: message };
  } finally {
    ambientInitiativeRunning.delete(lockKey);
    requestLog.emit(log);
    requestLogStore.decrementActive();
  }
}

async function runAmbientInitiativeOpportunity(guildId: string, forcedKind?: AmbientInitiativeKind, mode: AmbientInitiativeRunMode = "automatic", runToken?: string): Promise<{ requestId?: string; error?: string }> {
  const guild = await resolveClientGuild(guildId);
  if (guild === null) return { error: "Guild is unavailable." };
  const guildConfig = getGuildConfig(guildId);
  const config = guildConfig.ambientInitiative;
  if (config === undefined || (!config.enabled && mode !== "draft")) return { error: "Ambient initiative is disabled." };
  const channel = resolveAmbientInitiativeMainChannel(guild, config);
  if (channel === null) return { error: "No ambient initiative main channel is available." };
  const eligibleKinds = (["self_expression", "targeted_checkin"] as AmbientInitiativeKind[])
    .filter((candidateKind) => ambientInitiativeKindConfig(config, candidateKind).enabled);
  const kind = forcedKind ?? eligibleKinds
    .map((candidateKind) => ambientInitiativePressureForKind(config, candidateKind, buildAmbientInitiativeSignals(guild, channel.id, guildConfig, config)))
    .sort((a, b) => b.pressure - a.pressure)[0]?.kind ?? "self_expression";
  const runMode: AmbientInitiativeRunMode = mode === "automatic" && config.shadowMode ? "shadow" : mode;
  const draft = runMode === "shadow" ? { drafts: [] as PromptLabDraftMessage[], dryRuns: [] as PromptLabDryRun[] } : undefined;
  const candidate: AmbientInitiativeCandidate = {
    id: `ambient-initiative:${crypto.randomUUID()}`,
    guildId,
    channelId: channel.id,
    kind,
    createdAt: Date.now(),
    mode: runMode,
    forced: runMode === "draft",
    forceDecision: false,
    ...(runToken !== undefined ? { runToken } : {}),
  };
  const result = await runAmbientInitiativeCandidate({ guild, channel, candidate, ...(draft !== undefined ? { draft } : {}) });
  return { requestId: result.requestId, ...(result.error !== undefined ? { error: result.error } : {}) };
}

function scheduleAmbientInitiativeGuild(guildId: string): void {
  const guildConfig = getGuildConfig(guildId);
  const config = guildConfig.ambientInitiative;
  if (config === undefined || !config.enabled) return;
  const existing = ambientInitiativeTimers.get(guildId);
  if (existing !== undefined) clearTimeout(existing);
  const delayMs = randomBetween(config.checkIntervalMinMs, config.checkIntervalMaxMs);
  const timer = setTimeout(() => {
    ambientInitiativeTimers.delete(guildId);
    void runAmbientInitiativeOpportunity(guildId).finally(() => scheduleAmbientInitiativeGuild(guildId));
  }, delayMs);
  timer.unref();
  ambientInitiativeTimers.set(guildId, timer);
}

function startAmbientInitiativeLoops(): void {
  for (const guild of client.guilds.cache.values()) {
    scheduleAmbientInitiativeGuild(guild.id);
  }
}

async function runPromptLabAmbientInitiative(input: {
  guildId: string;
  channelId: string;
  kind: AmbientInitiativeKind;
  force?: boolean;
  runToken?: string;
}): Promise<PromptLabRunResult> {
  const guild = await resolveClientGuild(input.guildId);
  if (guild === null) throw new Error("Guild is unavailable.");
  const channel = await fetchAccessibleGuildChannel(input.channelId);
  if (channel === null || channel.guildId !== input.guildId) {
    throw new Error("Channel is unavailable or does not belong to the selected guild.");
  }
  const guildConfig = getGuildConfig(input.guildId);
  if (guildConfig.ambientInitiative === undefined) throw new Error("Ambient initiative is not configured for this guild.");
  const drafts: PromptLabDraftMessage[] = [];
  const dryRuns: PromptLabDryRun[] = [];
  const candidate: AmbientInitiativeCandidate = {
    id: `prompt-lab:ambient-initiative:${crypto.randomUUID()}`,
    guildId: input.guildId,
    channelId: input.channelId,
    kind: input.kind,
    createdAt: Date.now(),
    mode: "draft",
    forced: true,
    forceDecision: input.force === true,
    ...(input.runToken !== undefined ? { runToken: input.runToken } : {}),
  };
  const result = await runAmbientInitiativeCandidate({
    guild,
    channel,
    candidate,
    draft: { drafts, dryRuns },
  });
  const entry = requestLogStore.getByRequestId(result.requestId);
  const summary = entry !== null
    ? promptLabSummary(entry)
    : { toolCount: 0, llmCallCount: 0, estimatedCostUsd: null, totalDurationMs: 0 };
  return {
    requestId: result.requestId,
    triggered: true,
    ...(result.responseText !== undefined ? { responseText: result.responseText } : {}),
    drafts,
    dryRuns,
    ...summary,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

async function runAmbientCandidate(candidate: AmbientCandidate): Promise<void> {
  const guildConfig = getGuildConfig(candidate.guildId);
  const config = guildConfig.ambientAttention;
  if (config === undefined) return;
  const requestLog = createAmbientRequestLog(candidate, "evaluating");
  requestLogStore.incrementActive();
  const gate = ambientHardGate(config, candidate, "evaluate");
  recordAmbientRuntimeAction(
    requestLog,
    `ambient-hard-gate:${candidate.id}:evaluate`,
    "ambient_hard_gate",
    {
      phase: "evaluate",
      kind: candidate.kind,
      triggerMessageId: candidate.triggerMessageId,
    },
    gate.ok
      ? {
          status: "passed",
          historyCount: gate.history.length,
          summary: "Hard gates passed; evaluator LLM will run.",
        }
      : {
          status: "dropped",
          reason: gate.reason,
          decidingParameter: `hard_gate.${gate.reason.replaceAll(" ", "_")}`,
          summary: `Dropped before evaluator: ${gate.reason}.`,
        },
  );
  if (!gate.ok) {
    log.debug("ambient candidate dropped", { kind: candidate.kind, messageId: candidate.triggerMessageId, reason: gate.reason });
    if ((candidate.kind === "ambient_pickup" || candidate.kind === "lingering_attention") && gate.reason === "user typing active") {
      reschedulePendingBurstForTyping(candidate.kind, candidate.guildId, candidate.channelId, candidate.userId, config);
    } else {
      clearPendingForCandidate(candidate);
    }
    emitAmbientRequestLog(requestLog);
    return;
  }

  const decision = await evaluateAmbientCandidate(config, candidate, gate.history, requestLog);
  if (decision === null) {
    recordAmbientRuntimeAction(
      requestLog,
      `ambient-decision:${candidate.id}`,
      "ambient_decision",
      { kind: candidate.kind },
      {
        status: "dropped",
        decidingParameter: "evaluator_error",
        summary: "Evaluator did not return a usable decision.",
      },
      true,
    );
    clearPendingForCandidate(candidate);
    emitAmbientRequestLog(requestLog);
    return;
  }

  const verdict = ambientDecisionVerdict(config, candidate, decision);
  recordAmbientRuntimeAction(
    requestLog,
    `ambient-decision:${candidate.id}`,
    "ambient_decision",
    {
      kind: candidate.kind,
      decision,
      thresholds: {
        replyProbability: verdict.probabilityThreshold,
        confidence: verdict.confidenceThreshold,
      },
      adjustedProbability: verdict.adjustedProbability,
      randomJitter: verdict.jitter,
      weakLingering: verdict.weakLingering,
    },
    {
      status: verdict.passed ? "selected" : "dropped",
      decidingParameter: verdict.decidingParameter,
      explanation: verdict.explanation,
      shouldReply: decision.should_reply,
      replyProbability: decision.reply_probability,
      adjustedProbability: verdict.adjustedProbability,
      probabilityThreshold: verdict.probabilityThreshold,
      confidence: decision.confidence,
      confidenceThreshold: verdict.confidenceThreshold,
      reason: decision.reason,
      intent: decision.intent ?? "",
      defaultReply: decision.default_reply ?? candidate.defaultReply,
    },
  );
  emitAmbientRequestLog(requestLog);
  if (!verdict.passed) {
    clearPendingForCandidate(candidate);
    return;
  }

  candidate.defaultReply = decision.default_reply ?? candidate.defaultReply;
  markAmbientCooldown(config, candidate);
  clearPendingForCandidate(candidate);
  await processTriggeredMessage(
    candidate.message,
    { reason: candidate.kind },
    [candidate.message],
    {
      disableLiveOutput: true,
      defaultReply: candidate.defaultReply,
      triggerInstruction: ambientTriggerInstruction(candidate.kind, decision),
      currentTurnOverride: candidate.syntheticContent !== undefined && candidate.syntheticTimestamp !== undefined
        ? {
            messageId: candidate.triggerMessageId,
            timestamp: candidate.syntheticTimestamp,
            content: candidate.syntheticContent,
          }
        : undefined,
      preSendCheck: () => {
        const preSendGate = ambientHardGate(config, candidate, "pre_send");
        if (!preSendGate.ok) {
          const preSendLog = createAmbientRequestLog(candidate, "pre_send_dropped");
          requestLogStore.incrementActive();
          recordAmbientRuntimeAction(
            preSendLog,
            `ambient-hard-gate:${candidate.id}:pre-send`,
            "ambient_hard_gate",
            {
              phase: "pre_send",
              kind: candidate.kind,
              triggerMessageId: candidate.triggerMessageId,
            },
            {
              status: "dropped",
              reason: preSendGate.reason,
              decidingParameter: `hard_gate.${preSendGate.reason.replaceAll(" ", "_")}`,
              summary: `Dropped before Discord send: ${preSendGate.reason}.`,
            },
          );
          emitAmbientRequestLog(preSendLog);
          log.debug("ambient reply dropped before send", { kind: candidate.kind, messageId: candidate.triggerMessageId, reason: preSendGate.reason });
          return false;
        }
        if (candidate.kind === "follow_up") {
          const lease = ambientLeases.get(ambientLeaseKey(candidate.guildId, candidate.channelId, candidate.userId));
          if (lease !== undefined && lease.botMessageId === candidate.triggerMessageId) lease.followUpsSent += 1;
        }
        recordAmbientReply(candidate);
        return true;
      },
    },
  );
}

function maybeScheduleAmbientAttention(message: Message, triggerResult: TriggerResult): void {
  if (message.guildId === null || message.guild === null) return;
  const guildConfig = getGuildConfig(message.guildId);
  const config = guildConfig.ambientAttention;
  if (config === undefined || !config.enabled) return;
  if (triggerResult !== null) {
    markAmbientNormalTriggerInFlight(message.guildId, message.channelId, message.author.id);
    markAmbientPickupChannelCooldown(config, message.guildId, message.channelId);
    clearPendingAmbientKindInChannel("ambient_pickup", message.guildId, message.channelId);
    clearPendingCandidate(ambientPendingKey("lingering_attention", message.guildId, message.channelId, message.author.id));
    return;
  }
  if (ambientNormalTriggerInFlight(message.guildId, message.channelId, message.author.id)) return;
  const translatedContent = translateInbound(message.content, buildInboundResolvers(message.guild));
  if (translatedContent.trim() === "" && message.stickers.size === 0) return;
  const base = {
    message,
    createdAt: Date.now(),
    triggerCreatedAt: message.createdTimestamp,
    triggerMessageId: message.id,
    userId: message.author.id,
    channelId: message.channelId,
    guildId: message.guildId,
  };

  let lease = ambientLeases.get(ambientLeaseKey(message.guildId, message.channelId, message.author.id));
  if (lease === undefined && config.lingering.enabled) {
    lease = recoverAmbientLeaseForMessage(message, config);
  }
  if (lease !== undefined && lease.expiresAt > Date.now() && config.lingering.enabled) {
    schedulePendingBurstFromMessage(message, base, config, "lingering_attention");
    return;
  }

  if (config.ambientPickup.enabled && ambientPickupChannelReady(message.guildId, message.channelId)) {
    schedulePendingBurstFromMessage(message, base, config, "ambient_pickup");
  }
}

function noteAmbientTyping(typing: Typing): void {
  if (!typing.inGuild() || typing.user.bot) return;
  const config = getGuildConfig(typing.guild.id).ambientAttention;
  if (config === undefined || !config.enabled) return;
  const now = Date.now();
  ambientTypingByChannelUser.set(ambientChannelUserKey(typing.guild.id, typing.channel.id, typing.user.id), now);
  reschedulePendingBurstForTyping("ambient_pickup", typing.guild.id, typing.channel.id, typing.user.id, config);
  const lease = ambientLeases.get(ambientLeaseKey(typing.guild.id, typing.channel.id, typing.user.id));
  if (lease === undefined || lease.expiresAt <= now) return;
  reschedulePendingBurstForTyping("lingering_attention", typing.guild.id, typing.channel.id, typing.user.id, config);
  if (lease.typingExtensions >= config.lingering.maxTypingExtensions) return;
  lease.typingExtensions += 1;
  lease.expiresAt = Math.max(lease.expiresAt, now + config.lingering.typingExtensionMs);
}

function clearAmbientLeaseForUser(guildId: string, channelId: string, userId: string): void {
  ambientLeases.delete(ambientLeaseKey(guildId, channelId, userId));
  clearPendingCandidate(ambientPendingKey("lingering_attention", guildId, channelId, userId));
}

function recoverAmbientLeaseForMessage(message: Message, config: AmbientAttentionConfig): AmbientLease | undefined {
  if (message.guildId === null || client.user?.id === undefined) return undefined;
  const now = Date.now();
  const key = ambientLeaseKey(message.guildId, message.channelId, message.author.id);
  const existing = ambientLeases.get(key);
  if (existing !== undefined && existing.expiresAt > now) return existing;

  const history = getHistoryMessages(db, message.channelId, Math.max(config.historyLimit, 20));
  const beforeCurrent = history.filter((item) =>
    item.timestamp < message.createdTimestamp ||
    (item.timestamp === message.createdTimestamp && item.id < message.id)
  );
  const botMessage = [...beforeCurrent].reverse().find((item) =>
    item.isBot &&
    item.authorId === client.user?.id &&
    item.isPromptOnly !== true &&
    !item.isSynthetic
  );
  if (botMessage === undefined) return undefined;
  if (message.createdTimestamp - botMessage.timestamp > config.lingering.weakWindowMs) return undefined;

  let sourceMessage = botMessage.replyToId !== null
    ? beforeCurrent.find((item) => item.id === botMessage.replyToId && item.authorId === message.author.id && !item.isBot)
    : undefined;
  if (sourceMessage === undefined) {
    sourceMessage = [...beforeCurrent]
      .filter((item) => item.timestamp <= botMessage.timestamp && !item.isBot && !item.isSynthetic)
      .at(-1);
    if (sourceMessage?.authorId !== message.author.id) return undefined;
    if (botMessage.timestamp - sourceMessage.timestamp > 10 * 60 * 1000) return undefined;
  }

  const lease: AmbientLease = {
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    exchangeId: crypto.randomUUID(),
    sourceMessageId: sourceMessage.id,
    botMessageId: botMessage.id,
    botRepliedAt: botMessage.timestamp,
    strongUntil: botMessage.timestamp + config.lingering.strongWindowMs,
    expiresAt: botMessage.timestamp + config.lingering.weakWindowMs,
    typingExtensions: 0,
    followUpsSent: 0,
  };
  if (lease.expiresAt <= now) return undefined;
  ambientLeases.set(key, lease);
  log.debug("ambient lingering lease recovered", {
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    botMessageId: botMessage.id,
    sourceMessageId: sourceMessage.id,
  });
  return lease;
}

function noteAmbientBotReply(input: {
  guildId: string;
  channelId: string;
  userId: string;
  sourceMessageId: string;
  botMessageId: string;
  message: Message;
  allowLease: boolean;
  allowFollowUp: boolean;
}): void {
  const config = getGuildConfig(input.guildId).ambientAttention;
  if (config === undefined || !config.enabled || !config.lingering.enabled) return;
  if (!input.allowLease) return;
  const now = Date.now();
  const botMessage = getMessageById(db, input.botMessageId, input.guildId);
  const botMessageCreatedAt = botMessage?.createdAt ?? now;
  const key = ambientLeaseKey(input.guildId, input.channelId, input.userId);
  clearPendingCandidate(ambientPendingKey("lingering_attention", input.guildId, input.channelId, input.userId));
  const lease: AmbientLease = {
    guildId: input.guildId,
    channelId: input.channelId,
    userId: input.userId,
    exchangeId: crypto.randomUUID(),
    sourceMessageId: input.sourceMessageId,
    botMessageId: input.botMessageId,
    botRepliedAt: botMessageCreatedAt,
    strongUntil: botMessageCreatedAt + config.lingering.strongWindowMs,
    expiresAt: botMessageCreatedAt + config.lingering.weakWindowMs,
    typingExtensions: 0,
    followUpsSent: 0,
  };
  ambientLeases.set(key, lease);
  if (!input.allowFollowUp || !config.followUp.enabled || config.followUp.maxPerExchange <= 0) return;
  scheduleAmbientCandidate({
    id: crypto.randomUUID(),
    kind: "follow_up",
    message: input.message,
    createdAt: now,
    triggerCreatedAt: botMessageCreatedAt,
    triggerMessageId: input.botMessageId,
    userId: input.userId,
    channelId: input.channelId,
    guildId: input.guildId,
    defaultReply: config.followUp.defaultReply,
    syntheticContent: "Conversation is quiet after 2B's previous reply. Decide whether one small follow-up is natural now.",
    syntheticTimestamp: botMessageCreatedAt,
  });
}

// --- 12. Init scheduler ---
const scheduler: SchedulerEngine = createSchedulerEngine({
  db,
  onFire: (event) => {
    const { schedule } = event;
    const scheduleLog = log.child({ component: "scheduler", scheduleId: schedule.id });
    scheduleLog.info("schedule fired", { guildId: schedule.guildId, channelId: schedule.channelId });

    void (async () => {
      // Resolve guild and channel
      const guild = client.guilds.cache.get(schedule.guildId);
      if (guild === undefined) {
        scheduleLog.warn("guild not found, skipping scheduled task");
        return;
      }

      const channel = guild.channels.cache.get(schedule.channelId);
      if (channel === undefined || !("send" in channel)) {
        scheduleLog.warn("channel not found or not sendable, skipping scheduled task");
        return;
      }

      const textChannel = channel as TextChannel;
      const guildId = schedule.guildId;
      const channelId = schedule.channelId;
      const guildConfig = getGuildConfig(guildId);
      const botUserId = client.user?.id ?? "";
      const botUsername = client.user?.username ?? "bot";

      const resolveTargetChannel = createTargetChannelResolver(client, textChannel);
      const typing = createTypingController({
        defaultChannel: textChannel,
        resolveTargetChannel,
      });
      const sender = createDiscordMessageSender({
        defaultChannel: textChannel,
        resolveTargetChannel,
        botUserId,
        botUsername,
        logger: scheduleLog,
        getLastTypingAt: typing.getLastTypingAt,
        getAttachmentsDir: (targetGuildId) => getGuildConfig(targetGuildId).attachmentsDir,
      });

      // Build simplified context for scheduled task
      // No real latestUserMessage - use a synthetic one for the pipeline
      const now = Date.now();
      const syntheticLatestMessage: HistoryMessage = {
        id: `scheduled-${schedule.id}-${now}`,
        author: "scheduler",
        authorId: "scheduler",
        content: schedule.messageContent,
        isBot: false,
        timestamp: now,
        replyToId: null,
        imageIds: [],
        captions: [],
        hasEmbeds: false,
        isSynthetic: true,
        relatedThreadId: null,
      };

      // Simplified replyFallbackDeps (no Discord message fetching for scheduled tasks)
      const replyFallbackDeps: ReplyFallbackDeps = {
        db,
        guildId,
        channelId,
        fetchDiscordMessage: () => Promise.resolve(null),
        enqueueEmbedding: async (id, text, metadata) => {
          await embeddingQueue.enqueue({ id, text, target: "message", metadata });
        },
        processImage: async () => {},
      };

      const isThread = textChannel.isThread();
      const context = await buildContext(
        guildId,
        channelId,
        guild,
        guildConfig,
        `[Scheduled Task Instructions] ${schedule.messageContent}`,
        syntheticLatestMessage,
        replyFallbackDeps,
        isThread,
      );

      const generatedImages = createGeneratedImageRuntime();
      const extraTools = buildAgentTools(
        guildId,
        channelId,
        guildConfig,
        guild,
        context.contextMessageIds,
        generatedImages.onGeneratedImage,
        {
          requesterId: "scheduler",
          requesterUsername: "scheduler",
          sourceMessageId: syntheticLatestMessage.id,
          sourceQuote: shortQuote(schedule.messageContent),
        },
      );

      // Build synthetic incoming message
      const incoming: IncomingMessage = {
        content: schedule.messageContent,
        guildId,
        guildName: guild.name,
        channelId,
        channelName: channelDisplayName(textChannel),
        authorId: "scheduler",
        authorUsername: "scheduler",
        botUserId,
        mentionedUserIds: [],
        translatedContent: schedule.messageContent,
        messageId: syntheticLatestMessage.id,
        replyToMessageId: syntheticLatestMessage.replyToId ?? undefined,
      };
      const visibleMaintenanceTools = blockToolsExcept(createPostReplyMaintenanceTools({
        guild,
        guildConfig,
        memoryRequest: {
          sourceMessageId: syntheticLatestMessage.id,
          userMessage: schedule.messageContent,
          assistantReply: "",
          recentContext: "",
          context,
          incomingMessage: incoming,
          visibleReplySent: false,
        },
        currentUserId: "scheduler",
        currentUsername: "scheduler",
        sourceMessageId: syntheticLatestMessage.id,
      }), "", "visible reply mode");

      // Build request log
      const requestLog = new RequestLog(guildId, channelId, requestLogStore);
      requestLog.setAuthor("scheduler");
      requestLog.setTriggerContext({
        ...dashboardTriggerLocation(guild, textChannel),
        messageId: syntheticLatestMessage.id,
        authorUsername: "scheduler",
        content: schedule.messageContent,
        translatedContent: schedule.messageContent,
      });

      const { ttsEnabled, generateSpeech } = createTtsGenerator(guildConfig);

      // Build handler deps with forceTrigger
      const deps: HandlerDeps = {
        globalConfig,
        guildConfig,
        context,
        currentChannelId: channelId,
        systemPrompt: promptBundle.systemPrompt,
        personaPrompt: promptBundle.corePrompt,
        runtimePrompts: promptBundle.runtime,
        sender,
        extraTools: [...extraTools, ...visibleMaintenanceTools],
        log: scheduleLog,
        requestLog,
        ttsEnabled,
        generateSpeech,
        consumeGeneratedAttachments: generatedImages.consumeGeneratedAttachments,
        resolveImageAttachments: createStoredImageAttachmentResolver({
          guildId,
          logger: scheduleLog.child({ component: "stored-image-attachments", guildId, channelId }),
        }),
        onTriggered: () => { typing.startLoop(); },
        onStillWorking: (destinationChannelId) => { typing.startLoop(destinationChannelId); },
        getTypingStartedAt: typing.getTypingStartedAt,
        onVisibleOutput: typing.stopLoop,
        onAgentEnd: typing.stopLoop,
        onIgnoredReply: ({ channelId: destinationChannelId, historyText }) => {
          persistIgnoredBotReply({
            guildId,
            channelId,
            destinationChannelId,
            botUserId,
            botUsername,
            sourceMessageId: syntheticLatestMessage.id,
            historyText,
          });
        },
        forceTrigger: true,
        triggerInstructions: guildConfig.triggerInstructions,
        afterReply: async (memoryRequest) => {
          await runMemoryPostReplyExtraction({
            guildConfig,
            memoryRequest,
            guild,
            channel: textChannel,
            sourceRequestId: requestLog.requestId,
            source: "scheduled",
            currentUserId: "scheduler",
            currentUsername: "scheduler",
          });
          await runRelationshipPostReplyExtraction({
            guildConfig,
            memoryRequest,
            guild,
            channel: textChannel,
            sourceRequestId: requestLog.requestId,
            source: "scheduled",
            currentUserId: "scheduler",
            currentUsername: "scheduler",
          });
        },
      };

      // Run the agent
      let result;
      try {
        result = await handleMessage(incoming, deps);
        scheduleLog.info("scheduled task completed", { agentRan: result.agentRan });
      } catch (err) {
        requestLog.setError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        typing.stopLoop();
        if (result !== undefined) {
          requestLog.setTrigger(result.triggerResult);
          requestLog.setAgentRan(result.agentRan);
        }
        requestLog.emit(log);
      }
    })().catch((err: unknown) => {
      log.error("scheduled task failed", {
        scheduleId: schedule.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  },
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

// --- 15. Command handlers ---
const commandHandlers = new Map<string, (interaction: ChatInputCommandInteraction) => Promise<void>>();

function setupCommandHandlers(guildId: string): void {
  const config = getGuildConfig(guildId);

  commandHandlers.set("status", createStatusHandler({
    getStats: () => ({
      uptimeMs: Date.now() - startTime,
      guildCount: client.guilds.cache.size,
      messageCount: (db.raw.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c,
      memoryCount: (db.raw.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c,
      scheduleCount: (db.raw.prepare("SELECT COUNT(*) as c FROM schedules WHERE enabled = 1").get() as { c: number }).c,
    }),
    adminUserIds: config.adminUserIds,
  }));

  commandHandlers.set("schedule", createScheduleHandler({
    listSchedules: (filter) => listSchedules(db, filter),
    createSchedule: (input) => createSchedule(db, input),
    deleteSchedule: (id, targetGuildId) => deleteScheduleForGuild(db, id, targetGuildId),
    onScheduleCreated: (id) => scheduler.addSchedule(id),
    onScheduleRemoved: (id) => scheduler.removeSchedule(id),
    adminUserIds: config.adminUserIds,
    getGuildTimezone: (gId) => getGuildConfig(gId).timezone,
  }));

  commandHandlers.set("memory-wipe", createMemoryWipeHandler({
    wipeGuild: (gId) => {
      const memoriesDeleted = (db.raw.prepare("DELETE FROM memories WHERE guild_id = ?").run(gId) as { changes: number }).changes;
      const messagesDeleted = (db.raw.prepare("DELETE FROM messages WHERE guild_id = ?").run(gId) as { changes: number }).changes;

      return Promise.resolve({ memoriesDeleted, messagesDeleted });
    },
    wipeRecent: async (_gId, chId, count) => {
      const { messageIds, imagePaths } = deleteRecentMessages(db, chId, count);

      // Qdrant cleanup, including any merged reindex/backfill blocks.
      await Promise.all(messageIds.map((messageId) => deleteMessagePointsByMessageId(qdrant, { guildId: _gId, messageId })));

      // Image file cleanup (best effort)
      for (const p of imagePaths) {
        try { unlinkSync(p); } catch { /* ignore missing */ }
      }

      return { messagesDeleted: messageIds.length, imagesDeleted: imagePaths.length };
    },
    adminUserIds: config.adminUserIds,
  }));
}

// --- 16. interactionCreate handler ---
client.on("interactionCreate", (interaction) => void (async () => {
  // Handle button/select interactions (VPN UI)
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    const vpnDeps: VpnHandlerDeps = {
      client: vpnClient,
      sessionStore: vpnSessionStore,
      vpnPeer: vpnConfig?.vpnPeer ?? "",
      log: log.child({ component: "vpn" }),
      locale: getVpnLocale(globalConfig.uiLang),
      enabled: vpnEnabled,
    };
    try {
      const handled = await handleVpnComponent(interaction, vpnDeps);
      if (!handled) {
        // Unknown component interaction
        log.warn("unknown component interaction", { customId: interaction.customId });
      }
    } catch (err) {
      log.error("component interaction error", {
        customId: interaction.customId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Handle slash commands
  if (!interaction.isChatInputCommand()) return;

  // Special handling for /vpn (open to all users, no guild config needed)
  if (interaction.commandName === "vpn") {
    const vpnDeps: VpnHandlerDeps = {
      client: vpnClient,
      sessionStore: vpnSessionStore,
      vpnPeer: vpnConfig?.vpnPeer ?? "",
      log: log.child({ component: "vpn" }),
      locale: getVpnLocale(globalConfig.uiLang),
      enabled: vpnEnabled,
    };
    try {
      await handleVpnCommand(interaction, vpnDeps);
    } catch (err) {
      log.error("vpn command error", {
        guildId: interaction.guildId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Произошла ошибка.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
    return;
  }

  // Admin commands require guild
  if (interaction.guildId === null) return;

  // Rebuild handlers with fresh guild config each time
  setupCommandHandlers(interaction.guildId);

  const handler = commandHandlers.get(interaction.commandName);
  if (handler !== undefined) {
    try {
      await handler(interaction);
    } catch (err) {
      log.error("command handler error", {
        command: interaction.commandName,
        guildId: interaction.guildId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  }
})());

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
    execute: (_toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> => {
      dryRuns.push({ tool: tool.name, args: params });
      return Promise.resolve({
        content: [{
          type: "text",
          text: "Prompt Lab dry-run: would execute `record_memory`, but dashboard test runs do not mutate memories.",
        }],
        details: { dryRun: true, tool: tool.name, args: params },
      });
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
  if (!input.guildConfig.memoryExtraction.postReply || input.memoryRequest.assistantReply.trim() === "") {
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
  if (!config.enabled || input.memoryRequest.assistantReply.trim() === "") return;
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
): Promise<AssembledContext> {
  // Chat history via the full processing pipeline
  const visibleJobs = agentJobs.listVisible(guildId, channelId);
  const displayNamesByUserId = buildCurrentDisplayNameMap(guild);
  const historyWithoutLatest = annotateHistoryJobs(
    getContextHistoryMessages(db, channelId, guildConfig.trim, latestUserMessage.id),
    guildId,
    channelId,
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
    annotatedLatestUserMessage,
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
    currentGuildId: guildId,
    currentGuildName: guild.name,
    currentChannelId: channelId,
    currentChannelName,
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
    annotatedLatestUserMessage.id,
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
  const activeJobsText = renderAgentJobsContext(visibleJobs);
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

  const searchTool = createSearchTool({
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
        const permissions = botChannelPermissions(channel);
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

  const timeoutUserTool = createTimeoutUserTool({
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

  const chatHistoryTool = createChatHistoryTool({
    guildId,
    timezone: guildConfig.timezone,
    fetchMessages: async (historyChannelId, limit) => {
      const channel = await fetchAccessibleGuildChannel(historyChannelId);
      if (channel === null || !("messages" in channel)) return [];
      return getChatHistory(db, channel.guildId, channel.id, limit);
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
    afterEdit: (input) => syncEditedOwnBotMessage(input),
    afterDelete: (input) => syncDeletedOwnBotMessage({
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

  const tools = [searchTool, ...scheduleTools, chatUserListTool, channelListTool, emojiListTool, timeoutUserTool, memoryListTool, chatHistoryTool, ...ownMessageTools, readChatImagesTool, readUserAvatarTool, fetchImagesTool, fetchUrlTool, summarizeVideoTool, reactToMessageTool];
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
    timeout_user: {
      maxTimeoutMinutes: MAX_TIMEOUT_SECONDS / 60,
    },
  };

  return applyRuntimeToolPrompts(tools, promptBundle.runtime, toolPromptVariables);
}

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
    const baseSender = createDiscordMessageSender({
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
        markAmbientPickupChannelCooldown(guildConfig.ambientAttention, guildId, destinationChannelId);
        clearPendingAmbientKindInChannel("ambient_pickup", guildId, destinationChannelId);
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

    const replyFallbackDeps: ReplyFallbackDeps = {
      db,
      guildId,
      channelId,
      fetchDiscordMessage: async (chId, msgId) => {
        const ch = guild.channels.cache.get(chId);
        if (ch === undefined || !("messages" in ch)) return null;
        try {
          const fetched = await (ch as TextChannel).messages.fetch(msgId);
          return {
            id: fetched.id,
            authorId: fetched.author.id,
            authorUsername: fetched.author.username,
            authorDisplayName: authorDisplayName(fetched),
            content: fetched.content,
            timestamp: fetched.createdTimestamp,
            isBot: fetched.author.bot,
            replyToId: fetched.reference?.messageId ?? null,
            attachments: [...fetched.attachments.values()].map((a) => ({
              url: a.url,
              contentType: a.contentType,
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
        } catch { return null; }
      },
      enqueueEmbedding: async (id, text, metadata) => {
        await embeddingQueue.enqueue({ id, text, target: "message", metadata });
      },
      processImage: async (url, contentType, messageId, sourceKind) => {
        const ingestDeps: ImageIngestDeps = {
          db,
          attachmentsDir: guildConfig.attachmentsDir,
          maxDimension: guildConfig.imageMaxDimension,
          fetchFn: fetch,
        };
        await processAndStoreImage(ingestDeps, { url, mimeType: contentType, messageId, guildId, channelId, sourceKind });
      },
    };

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
    const extraTools = [...agentTools, ...threadTools];

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

    const { ttsEnabled, generateSpeech } = createTtsGenerator(guildConfig);

    const deps: HandlerDeps = {
      globalConfig,
      guildConfig,
      context,
      currentChannelId: channelId,
      systemPrompt: promptBundle.systemPrompt,
      personaPrompt: promptBundle.corePrompt,
      runtimePrompts: promptBundle.runtime,
      sender,
      extraTools: [...extraTools, ...visibleMaintenanceTools],
      log: log.child({ guildId, channelId, requestId: requestLog.requestId }),
      onTriggered: () => {
        if (!guildConfig.typingSimulation.enabled) typing.startLoop();
      },
      onStillWorking: (destinationChannelId) => { typing.startLoop(destinationChannelId); },
      getTypingStartedAt: typing.getTypingStartedAt,
      onVisibleOutput: typing.stopLoop,
      onAgentEnd: typing.stopLoop,
      requestLog,
      ttsEnabled,
      generateSpeech,
      consumeGeneratedAttachments: generatedImages.consumeGeneratedAttachments,
      resolveImageAttachments: createStoredImageAttachmentResolver({
        guildId,
        logger: log.child({ component: "stored-image-attachments", guildId, channelId, requestId: requestLog.requestId }),
      }),
      triggerOverride,
      triggerInstructions: options.triggerInstruction !== undefined && triggerOverride !== undefined
        ? { ...guildConfig.triggerInstructions, [triggerOverride.reason]: options.triggerInstruction }
        : guildConfig.triggerInstructions,
      modelImageInputSupport: getModelImageInputSupport(guildConfig),
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
        clearAmbientLeaseForUser(guildId, destinationChannelId ?? channelId, message.author.id);
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
    };

    let result;
    try {
      result = await handleMessage(incoming, deps);
      if (result.responseText !== undefined && result.responseText !== "" && sentBotMessageIds[0] !== undefined) {
        noteAmbientBotReply({
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
      }
    } catch (err) {
      requestLog.setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      typing.stopLoop();
      if (result !== undefined) {
        requestLog.setTrigger(result.triggerResult);
        requestLog.setAgentRan(result.agentRan);
      }
      requestLog.emit(log);
      const completedTrigger = result?.triggerResult ?? triggerOverride;
      if (
        completedTrigger?.reason === "mention" ||
        completedTrigger?.reason === "keyword" ||
        completedTrigger?.reason === "random"
      ) {
        clearAmbientNormalTriggerInFlight(guildId, channelId, message.author.id);
      }
    }
    return {
      coveredMessageIds: [message.id],
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
  noteAmbientTyping(typing);

  const guildId = typing.guild.id;
  const guildConfig = getGuildConfig(guildId);
  if (!guildConfig.dispatcher.enabled) return;

  getOrCreateDispatcher(guildId).recordTyping(
    typing.channel.id,
    typing.user.id,
  );
});

function reactionEmojiIdentity(reaction: MessageReaction | PartialMessageReaction): { key: string; label: string } {
  const id = reaction.emoji.id;
  const name = reaction.emoji.name ?? id ?? "unknown";
  if (id !== null) return { key: `custom:${id}`, label: `:${name}:` };
  return { key: `unicode:${name}`, label: name };
}

async function fetchCompleteReaction(reaction: MessageReaction | PartialMessageReaction): Promise<MessageReaction | null> {
  if (!reaction.partial) return reaction;
  try {
    return await reaction.fetch();
  } catch {
    return null;
  }
}

async function processMessageReactionCount(
  reactionInput: MessageReaction | PartialMessageReaction,
  deleteOnFetchFailure = false,
): Promise<void> {
  const reaction = await fetchCompleteReaction(reactionInput);
  if (reaction === null && deleteOnFetchFailure) {
    processMessageReactionRemoveEmoji(reactionInput);
    return;
  }
  if (reaction === null) return;
  if (reaction.message.guildId === null) return;

  const { key, label } = reactionEmojiIdentity(reaction);
  upsertMessageReaction(db, {
    messageId: reaction.message.id,
    guildId: reaction.message.guildId,
    channelId: reaction.message.channelId,
    emojiKey: key,
    emojiLabel: label,
    count: reaction.count,
  });
}

function processMessageReactionRemoveEmoji(reaction: MessageReaction | PartialMessageReaction): void {
  if (reaction.message.guildId === null) return;
  const { key } = reactionEmojiIdentity(reaction);
  deleteMessageEmojiReaction(db, reaction.message.id, key, reaction.message.guildId);
}

function processMessageReactionRemoveAll(message: Message | PartialMessage): void {
  if (message.guildId === null) return;
  deleteMessageReactions(db, message.id, message.guildId);
}

client.on("messageReactionAdd", (reaction) => void (async () => {
  try {
    await processMessageReactionCount(reaction);
  } catch (err) {
    log.error("messageReactionAdd handler error", {
      messageId: reaction.message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
})());

client.on("messageReactionRemove", (reaction) => void (async () => {
  try {
    await processMessageReactionCount(reaction, true);
  } catch (err) {
    log.error("messageReactionRemove handler error", {
      messageId: reaction.message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
})());

client.on("messageReactionRemoveEmoji", (reaction) => {
  try {
    processMessageReactionRemoveEmoji(reaction);
  } catch (err) {
    log.error("messageReactionRemoveEmoji handler error", {
      messageId: reaction.message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

client.on("messageReactionRemoveAll", (message) => {
  try {
    processMessageReactionRemoveAll(message);
  } catch (err) {
    log.error("messageReactionRemoveAll handler error", {
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

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
    maybeScheduleAmbientAttention(message, triggerResult);

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
    // Skip partials and DMs
    if (message.partial || message.guild === null || message.guildId === null) return;

    const messageId = message.id;
    const guildId = message.guildId;

    // Get images before deletion
    const images = getImagesByMessageId(db, messageId);

    // Delete images from DB
    if (images.length > 0) {
      db.raw
        .prepare(`DELETE FROM images WHERE message_id = ?`)
        .run(messageId);
    }
    deleteMessageReactions(db, messageId, guildId);

    // Delete message from DB
    const result = db.raw
      .prepare("DELETE FROM messages WHERE id = ? AND guild_id = ?")
      .run(messageId, guildId) as { changes: number };

    if (result.changes === 0) return; // Not in DB

    // Delete Qdrant points, including any merged reindex/backfill blocks.
    await deleteMessagePointsByMessageId(qdrant, { guildId, messageId });

    // Delete image files (best effort)
    for (const img of images) {
      try { unlinkSync(img.path); } catch { /* ignore missing */ }
    }

    log.debug("message deleted from Discord", { messageId, guildId, images: images.length });
  } catch (err) {
    log.error("messageDelete handler error", {
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
})());

// --- Hot-reload config watcher ---
const CONFIG_RELOAD_DEBOUNCE_MS = 500;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

async function reloadConfigs(): Promise<void> {
  try {
    const newGlobal = loadGlobalConfig(
      process.env as Record<string, string | undefined>,
    );
    validateTrimConfig(newGlobal.defaultTrim);

    // Reload guild configs — clear and rebuild
    const newGuilds = loadGuildConfigs(guildsDir, newGlobal);
    await refreshModelImageInputSupport(newGlobal, newGuilds, "hot_reload");

    globalConfig = newGlobal;
    promptBundle = loadPromptBundle("prompts", log);

    guildConfigs.clear();
    for (const [id, cfg] of newGuilds) {
      guildConfigs.set(id, cfg);
    }

    // Invalidate dispatchers so they pick up new config on next enqueue
    for (const d of dispatchers.values()) d.dispose();
    dispatchers.clear();
    clearAmbientAttentionState();
    clearAmbientInitiativeState();
    startAmbientInitiativeLoops();

    log.info("config hot-reloaded", { model: globalConfig.defaultModel, guilds: guildConfigs.size });
  } catch (err) {
    log.error("config hot-reload failed, keeping previous config", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

if (existsSync("config")) {
  const watcher = watch("config", { recursive: true }, (_event, _filename) => {
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void reloadConfigs(), CONFIG_RELOAD_DEBOUNCE_MS);
  });

  // Prevent watcher from keeping the process alive during shutdown
  watcher.unref();
  log.info("config hot-reload watcher started");
}

if (existsSync("prompts")) {
  const watcher = watch("prompts", { recursive: true }, (_event, _filename) => {
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void reloadConfigs(), CONFIG_RELOAD_DEBOUNCE_MS);
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
startAmbientInitiativeLoops();

// --- Start dashboard ---
async function deleteManagementMessageState(input: {
  messageIds: string[];
  guildId: string;
  channelId: string;
  deleteDiscord?: boolean;
}): Promise<{ deletedMessageIds: string[]; deletedImages: number; discordDeletion: DiscordManagementDeleteResult }> {
  const requestedIds = new Set(input.messageIds);
  const validRows = listManagementMessages(db, {
    guildId: input.guildId,
    channelId: input.channelId,
    limit: 200,
  }).filter((row) => requestedIds.has(row.id));
  const validMessageIds = validRows.map((row) => row.id);
  const discordDeletion = await tryDeleteDiscordManagementMessages({
    guildId: input.guildId,
    channelId: input.channelId,
    messageIds: validMessageIds,
    enabled: input.deleteDiscord === true,
  });
  const deleted = deleteStoredManagementMessages(db, {
    ids: validMessageIds,
    guildId: input.guildId,
    channelId: input.channelId,
  });
  await Promise.all(deleted.messageIds.map((messageId) => deleteMessagePointsByMessageId(qdrant, {
    guildId: input.guildId,
    messageId,
  })));
  return {
    deletedMessageIds: deleted.messageIds,
    deletedImages: deleted.imagePaths.length,
    discordDeletion,
  };
}

async function editManagementMessageState(input: {
  messageId: string;
  guildId: string;
  channelId: string;
  content: string;
}): Promise<{ message: ReturnType<typeof decorateManagementMessage> }> {
  const row = updateStoredManagementMessageContent(db, {
    id: input.messageId,
    guildId: input.guildId,
    channelId: input.channelId,
    content: input.content,
  });
  if (row === null) {
    throw new Error("Stored message was not found for that exact guild/channel, or content was empty.");
  }
  await deleteMessagePointsByMessageId(qdrant, { guildId: row.guildId, messageId: row.id });
  await embeddingQueue.enqueue({
    id: row.id,
    text: row.translatedContent,
    target: "message",
    metadata: {
      guild_id: row.guildId,
      channel_id: row.channelId,
      user_id: row.userId,
      created_at: row.createdAt,
      is_bot: row.isBot,
      source: "live",
      embedding_kind: "single",
    },
  });
  return { message: decorateManagementMessage(row) };
}

async function deleteLatestManagementMessages(input: {
  guildId: string;
  channelId: string;
  count: number;
  deleteDiscord?: boolean;
}): Promise<{
  deletedMessageIds: string[];
  deletedImages: number;
  discordDeletion: DiscordManagementDeleteResult;
  scopedTo: { guildId: string; channelId: string };
}> {
  const count = Math.max(1, Math.min(20, Math.trunc(input.count)));
  const rows = listManagementMessages(db, {
    guildId: input.guildId,
    channelId: input.channelId,
    limit: count,
  });
  const deleted = await deleteManagementMessageState({
    messageIds: rows.map((row) => row.id),
    guildId: input.guildId,
    channelId: input.channelId,
    deleteDiscord: input.deleteDiscord,
  });
  return {
    ...deleted,
    scopedTo: { guildId: input.guildId, channelId: input.channelId },
  };
}

function editManagementMemoryState(input: {
  memoryId: number;
  content?: string;
  kind?: string;
  confidence?: number;
  expiresAt?: number | null;
}): { memory: ReturnType<typeof decorateManagementMemory> } {
  const existing = getManagementMemory(db, input.memoryId);
  if (existing === null) throw new Error("Memory not found.");
  if (existing.deletedAt !== null) throw new Error("Deleted memories cannot be edited.");
  if (input.kind !== undefined && !isMemoryKind(input.kind)) {
    throw new Error(`Invalid memory kind: ${input.kind}`);
  }
  const updated = updateMemory(db, input.memoryId, {
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.kind !== undefined && isMemoryKind(input.kind) ? { kind: input.kind } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...("expiresAt" in input ? { expiresAt: input.expiresAt ?? null } : {}),
  });
  if (!updated) throw new Error("Memory update did not change a row.");
  const row = getManagementMemory(db, input.memoryId);
  if (row === null) throw new Error("Memory disappeared after update.");
  return { memory: decorateManagementMemory(row) };
}

function deleteManagementMemoryState(memoryId: number): { deleted: boolean; memoryId: number } {
  return { deleted: deleteMemory(db, memoryId), memoryId };
}

const PROMPT_LAB_READ_TOOL_NAMES = new Set([
  "search_messages",
  "list_scheduled_messages",
  "list_chat_users",
  "list_channels",
  "list_emojis",
  "list_memories",
  "chat_history",
  "read_chat_images",
  "read_user_avatar",
  "fetch_images",
  "fetch_url",
  "summarize_video",
  "web_search",
  "load_skill",
]);

interface PromptLabDraftMessage {
  id: string;
  text: string;
  reply: boolean;
  channelId?: string;
  replyToMessageId?: string;
  attachments: string[];
  voice: boolean;
}

interface PromptLabDryRun {
  tool: string;
  args: unknown;
}

interface PromptLabRelationshipDryRun {
  requestId: string;
  signals: unknown[];
  accepted: unknown[];
  rejected: unknown[];
}

interface PromptLabMemoryDryRun {
  requestId?: string;
  enabled: boolean;
  ran: boolean;
  error?: string;
}

interface PromptLabRunResult {
  requestId: string;
  triggered: boolean;
  responseText?: string;
  drafts: PromptLabDraftMessage[];
  dryRuns: PromptLabDryRun[];
  relationshipsContext?: string;
  relationshipsExtraction?: PromptLabRelationshipDryRun;
  memoryExtraction?: PromptLabMemoryDryRun;
  toolCount: number;
  llmCallCount: number;
  estimatedCostUsd: number | null;
  totalDurationMs: number;
  error?: string;
}

function promptLabSyntheticId(offset = 0): string {
  const base = 15_000_000_000_000_000n;
  const span = 899_999_999_999_999n;
  const randomPart = BigInt(Math.floor(Math.random() * Number(span)));
  return (base + randomPart + BigInt(offset)).toString();
}

function promptLabDryRunTools(tools: AgentTool[], dryRuns: PromptLabDryRun[]): AgentTool[] {
  return tools.map((tool) => {
    if (PROMPT_LAB_READ_TOOL_NAMES.has(tool.name)) return tool;
    return {
      ...tool,
      execute: (_toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> => {
        dryRuns.push({ tool: tool.name, args: params });
        return Promise.resolve({
          content: [{
            type: "text",
            text: `Prompt Lab dry-run: would execute \`${tool.name}\`, but dashboard test runs do not mutate Discord, SQLite, schedules, memories, jobs, or files.`,
          }],
          details: {
            dryRun: true,
            tool: tool.name,
            args: params,
          },
        });
      },
    };
  });
}

function promptLabRelationshipContext(guildConfig: GuildConfig, userId: string): string | undefined {
  const config = getRelationshipConfig(guildConfig);
  if (!config.enabled || !config.promptInjection) return undefined;
  return renderRelationshipPromptContext({
    current: getRelationshipProfile(db, userId),
    currentLabel: userId,
    template: promptBundle.runtime.relationships.context,
  });
}

async function runPromptLabRelationshipExtractionDryRun(input: {
  sourceRequestId: string;
  guild: Guild;
  channel: unknown;
  guildConfig: GuildConfig;
  context: AssembledContext;
  incomingMessage: IncomingMessage;
  userMessage: string;
  assistantReply: string;
  maintenanceTranscript?: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0]["maintenanceTranscript"];
  availableTools?: AgentTool[];
  promptContext?: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0]["promptContext"];
}): Promise<PromptLabRelationshipDryRun | undefined> {
  const config = getRelationshipConfig(input.guildConfig);
  if (!config.enabled || input.assistantReply.trim() === "") return undefined;
  const channelId = input.incomingMessage.channelId ?? "";
  const extractionLog = new RequestLog(input.incomingMessage.guildId ?? "", channelId, requestLogStore);
  extractionLog.setAuthor(`prompt-lab:${input.incomingMessage.authorUsername}`);
  extractionLog.setTrigger({ type: "relationships_extraction", sourceRequestId: input.sourceRequestId, source: "prompt_lab", dryRun: true });
  extractionLog.setTriggerContext({
    ...dashboardTriggerLocation(input.guild, input.channel),
    messageId: input.incomingMessage.messageId,
    authorUsername: input.incomingMessage.authorUsername,
    content: input.userMessage,
    translatedContent: input.userMessage,
  });
  extractionLog.setAgentRan(true);
  requestLogStore.incrementActive();
  let signals: unknown[] = [];
  let accepted: unknown[] = [];
  let rejected: unknown[] = [];
  try {
    await runRelationshipPostReplyExtraction({
      guildConfig: input.guildConfig,
      guild: input.guild,
      channel: input.channel,
      sourceRequestId: input.sourceRequestId,
      source: "prompt_lab",
      dryRun: true,
      requestLog: extractionLog,
      currentUserId: input.incomingMessage.authorId,
      currentUsername: input.incomingMessage.authorUsername,
      memoryRequest: {
        sourceMessageId: input.incomingMessage.messageId,
        userMessage: input.userMessage,
        assistantReply: input.assistantReply,
        recentContext: input.context.sections.map((section) => section.text).join("\n\n"),
        context: input.context,
        incomingMessage: input.incomingMessage,
        visibleReplySent: true,
        maintenanceTranscript: input.maintenanceTranscript,
        availableTools: input.availableTools,
        promptContext: input.promptContext,
      },
      onResult: (result, toolSignals) => {
        signals = toolSignals;
        accepted = result.accepted;
        rejected = result.rejected;
      },
    });
    return { requestId: extractionLog.requestId, signals, accepted, rejected };
  } finally {
    extractionLog.emit(log);
    requestLogStore.decrementActive();
  }
}

async function runPromptLabMemoryExtractionDryRun(input: {
  sourceRequestId: string;
  guild: Guild;
  channel: unknown;
  guildConfig: GuildConfig;
  context: AssembledContext;
  incomingMessage: IncomingMessage;
  userMessage: string;
  assistantReply: string;
  dryRuns: PromptLabDryRun[];
  maintenanceTranscript?: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0]["maintenanceTranscript"];
  availableTools?: AgentTool[];
  promptContext?: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0]["promptContext"];
}): Promise<PromptLabMemoryDryRun> {
  return await runMemoryPostReplyExtraction({
    guildConfig: input.guildConfig,
    guild: input.guild,
    channel: input.channel,
    sourceRequestId: input.sourceRequestId,
    source: "prompt_lab",
    currentUserId: input.incomingMessage.authorId,
    currentUsername: input.incomingMessage.authorUsername,
    dryRun: true,
    dryRuns: input.dryRuns,
    memoryRequest: {
      sourceMessageId: input.incomingMessage.messageId,
      userMessage: input.userMessage,
      assistantReply: input.assistantReply,
      recentContext: input.context.sections.map((section) => section.text).join("\n\n"),
      context: input.context,
      incomingMessage: input.incomingMessage,
      visibleReplySent: true,
      maintenanceTranscript: input.maintenanceTranscript,
      availableTools: input.availableTools,
      promptContext: input.promptContext,
    },
  });
}

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
    username: member?.user.username ?? cachedUser?.username ?? managementUserName(userId),
    ...(member?.displayName !== undefined ? { displayName: member.displayName } : {}),
    ...(member?.user.globalName !== null && member?.user.globalName !== undefined
      ? { globalName: member.user.globalName }
      : cachedUser?.globalName !== null && cachedUser?.globalName !== undefined
        ? { globalName: cachedUser.globalName }
        : {}),
  };
}

function promptLabSummary(entry: ReturnType<RequestLog["toEntry"]>): {
  toolCount: number;
  runtimeActionCount: number;
  llmCallCount: number;
  estimatedCostUsd: number | null;
  totalDurationMs: number;
} {
  const estimatedCostUsd = entry.llmCalls.reduce((sum, call) => sum + (call.estimatedCostUsd ?? 0), 0);
  return {
    toolCount: entry.tools.length,
    runtimeActionCount: entry.tools.filter((tool) => tool.modelRequestId === undefined).length,
    llmCallCount: entry.llmCalls.length,
    estimatedCostUsd: estimatedCostUsd > 0 ? estimatedCostUsd : null,
    totalDurationMs: entry.totalDurationMs,
  };
}

async function runPromptLab(input: {
  guildId: string;
  channelId: string;
  userId: string;
  content: string;
  runToken?: string;
}): Promise<PromptLabRunResult> {
  const guild = await resolveClientGuild(input.guildId);
  if (guild === null) throw new Error("Guild is unavailable.");
  const channel = await fetchAccessibleGuildChannel(input.channelId);
  if (channel === null || channel.guildId !== input.guildId) {
    throw new Error("Channel is unavailable or does not belong to the selected guild.");
  }
  const botUserId = client.user?.id ?? "";
  if (botUserId === "") throw new Error("Bot user is not ready.");

  const guildConfig = getGuildConfig(input.guildId);
  const labUser = promptLabUserFromGuild(guild, input.userId);
  const content = input.content.trim();
  const translatedContent = translateInbound(content, buildInboundResolvers(guild));
  const now = Date.now();
  const messageId = promptLabSyntheticId();
  const latestUserMessage: HistoryMessage = {
    id: messageId,
    author: labUser.username,
    authorDisplayName: labUser.displayName,
    authorId: labUser.id,
    content: translatedContent,
    isBot: false,
    timestamp: now,
    replyToId: null,
    imageIds: [],
    captions: [],
    hasEmbeds: false,
    isSynthetic: false,
    relatedThreadId: null,
  };

  const replyFallbackDeps: ReplyFallbackDeps = {
    db,
    guildId: input.guildId,
    channelId: input.channelId,
    fetchDiscordMessage: async (chId, msgId) => {
      const target = await fetchAccessibleGuildChannel(chId);
      if (target === null || !("messages" in target)) return null;
      try {
        const fetched = await target.messages.fetch(msgId);
        return {
          id: fetched.id,
          authorId: fetched.author.id,
          authorUsername: fetched.author.username,
          authorDisplayName: authorDisplayName(fetched),
          content: fetched.content,
          timestamp: fetched.createdTimestamp,
          isBot: fetched.author.bot,
          replyToId: fetched.reference?.messageId ?? null,
          attachments: [...fetched.attachments.values()].map((a) => ({
            url: a.url,
            contentType: a.contentType,
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
      } catch {
        return null;
      }
    },
    enqueueEmbedding: async () => {},
    processImage: async () => {},
  };

  const context = await buildContext(
    input.guildId,
    input.channelId,
    guild,
    guildConfig,
    translatedContent,
    latestUserMessage,
    replyFallbackDeps,
    channel.isThread(),
    { timestamp: now, messageId },
    "virtual",
  );

  const baseTools = buildAgentTools(
    input.guildId,
    input.channelId,
    guildConfig,
    guild,
    context.contextMessageIds,
    undefined,
    {
      requesterId: labUser.id,
      requesterUsername: labUser.username,
      sourceMessageId: messageId,
      sourceQuote: shortQuote(translatedContent),
    },
    {},
  );
  const threadTools = applyRuntimeToolPrompts([
    createStartThreadTool({
      guildId: input.guildId,
      createThread: (name: string) => Promise.resolve({
        threadId: promptLabSyntheticId(1000),
        threadName: name,
        parentChannelId: input.channelId,
        starterMessageId: messageId,
      }),
      persistThread: () => {},
    }),
    createCloseThreadTool({
      currentGuildId: input.guildId,
      currentChannelId: input.channelId,
      currentIsThread: channel.isThread(),
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
      closeThread: (threadId) => Promise.resolve({
        threadId,
        threadName: threadId,
        parentChannelId: input.channelId,
      }),
      persistArchived: () => {},
    }),
  ], promptBundle.runtime);
  const dryRuns: PromptLabDryRun[] = [];
  const drafts: PromptLabDraftMessage[] = [];
  const requestLog = new RequestLog(input.guildId, input.channelId, requestLogStore);
  requestLog.setAuthor(`prompt-lab:${labUser.username}`);
  requestLog.setTrigger({
    type: "prompt_lab",
    mode: "mention",
    ...(input.runToken !== undefined ? { runToken: input.runToken } : {}),
  });
  requestLog.setTriggerContext({
    ...dashboardTriggerLocation(guild, channel),
    messageId,
    authorUsername: labUser.username,
    content,
  });
  requestLog.setAgentRan(true);
  requestLogStore.incrementActive();

  const sender: MessageSender = (text, reply, destinationChannelId, voice, _signal, replyToMessageId, attachments) => {
    const id = promptLabSyntheticId(drafts.length + 1);
    drafts.push({
      id,
      text,
      reply,
      ...(destinationChannelId !== undefined ? { channelId: destinationChannelId } : {}),
      ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
      attachments: attachments?.map((attachment) => attachment.filename) ?? [],
      voice: voice !== undefined,
    });
    return Promise.resolve({ sentMessageId: id });
  };
  const incomingMessage: IncomingMessage = {
    content,
    guildId: input.guildId,
    guildName: guild.name,
    channelId: input.channelId,
    channelName: channelDisplayName(channel),
    authorId: labUser.id,
    authorUsername: labUser.username,
    authorDisplayName: labUser.displayName,
    authorGlobalName: labUser.globalName,
    authorIsBot: false,
    botUserId,
    mentionedUserIds: [botUserId],
    translatedContent,
    messageId,
  };
  const visibleMaintenanceTools = blockToolsExcept(createPostReplyMaintenanceTools({
    guild,
    guildConfig,
    memoryRequest: {
      sourceMessageId: messageId,
      userMessage: translatedContent,
      assistantReply: "",
      recentContext: "",
      context,
      incomingMessage,
      visibleReplySent: false,
    },
    currentUserId: labUser.id,
    currentUsername: labUser.username,
    sourceMessageId: messageId,
    dryRun: true,
  }), "", "visible reply mode");
  const visibleTools = [...promptLabDryRunTools([...baseTools, ...threadTools], dryRuns), ...visibleMaintenanceTools];

  try {
    const result = await handleMessage(
      incomingMessage,
      {
        globalConfig,
        guildConfig,
        context,
        currentChannelId: input.channelId,
        systemPrompt: promptBundle.systemPrompt,
        personaPrompt: promptBundle.corePrompt,
        runtimePrompts: promptBundle.runtime,
        sender,
        extraTools: visibleTools,
        log: log.child({ guildId: input.guildId, channelId: input.channelId, requestId: requestLog.requestId, component: "prompt-lab" }),
        requestLog,
        triggerOverride: { reason: "mention" },
        triggerInstructions: guildConfig.triggerInstructions,
        liveMessageTypingHoldMs: 0,
        modelImageInputSupport: getModelImageInputSupport(guildConfig),
        consumeGeneratedAttachments: () => [],
        resolveImageAttachments: () => Promise.resolve([]),
      },
    );
    const assistantReply = (result.responseText ?? drafts.map((draft) => draft.text).join("\n\n")).trim();
    const maintenanceVisibleTools = result.availableTools ?? visibleTools;
    const memoryExtraction = await runPromptLabMemoryExtractionDryRun({
      sourceRequestId: requestLog.requestId,
      guild,
      channel,
      guildConfig,
      context,
      incomingMessage,
      userMessage: translatedContent,
      assistantReply,
      dryRuns,
      maintenanceTranscript: result.maintenanceTranscript,
      availableTools: maintenanceVisibleTools,
      promptContext: result.promptContext,
    });
    const relationshipsExtraction = await runPromptLabRelationshipExtractionDryRun({
      sourceRequestId: requestLog.requestId,
      guild,
      channel,
      guildConfig,
      context,
      incomingMessage,
      userMessage: translatedContent,
      assistantReply,
      maintenanceTranscript: result.maintenanceTranscript,
      availableTools: maintenanceVisibleTools,
      promptContext: result.promptContext,
    });
    const relationshipsContext = promptLabRelationshipContext(guildConfig, labUser.id);
    const entry = requestLog.toEntry();
    const summary = promptLabSummary(entry);
    return {
      requestId: requestLog.requestId,
      triggered: result.triggered,
      ...(result.responseText !== undefined ? { responseText: result.responseText } : {}),
      drafts,
      dryRuns,
      ...(relationshipsContext !== undefined ? { relationshipsContext } : {}),
      ...(relationshipsExtraction !== undefined ? { relationshipsExtraction } : {}),
      memoryExtraction,
      ...summary,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    requestLog.setError(error);
    const entry = requestLog.toEntry();
    const summary = promptLabSummary(entry);
    return {
      requestId: requestLog.requestId,
      triggered: true,
      drafts,
      dryRuns,
      ...summary,
      error,
    };
  } finally {
    requestLog.emit(log);
    requestLogStore.decrementActive();
  }
}

const dashboardPassword = process.env.DASHBOARD_PASSWORD;
const bypassDashboardAuth = process.env.UNSAFELY_BYPASS_DASHBOARD_AUTH === "true";
const dashboardPasswordlessCidrs = parseDashboardPasswordlessCidrs(process.env.DASHBOARD_PASSWORDLESS_CIDRS);
const dashboardTrustedProxyCidrs = parseDashboardPasswordlessCidrs(process.env.DASHBOARD_TRUSTED_PROXY_CIDRS);
const dashboardManagement = {
  getDirectory: buildManagementDirectory,
  listMessages: (filter: { guildId?: string; channelId?: string; limit?: number }) => ({
    messages: listManagementMessages(db, filter).map(decorateManagementMessage),
  }),
  editMessage: editManagementMessageState,
  deleteMessages: deleteManagementMessageState,
  deleteLatestMessages: deleteLatestManagementMessages,
  runPromptLab,
  runPromptLabAmbientInitiative,
  listMemories: (filter: { guildId?: string; scope?: "guild" | "user" | "self"; includeDeleted?: boolean; limit?: number }) => ({
    memories: listManagementMemories(db, filter).map(decorateManagementMemory),
  }),
  editMemory: editManagementMemoryState,
  deleteMemory: deleteManagementMemoryState,
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
  for (const d of dispatchers.values()) d.dispose();
  dispatchers.clear();
  clearAmbientAttentionState();
  clearAmbientInitiativeState();
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
