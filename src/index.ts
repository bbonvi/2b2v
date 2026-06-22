import { createLogger, RequestLog, type LogLevel, type Logger } from "./logger";
import { requestLogStore } from "./dashboard/store";
import { parseDashboardPasswordlessCidrs, startDashboard } from "./dashboard/server";
import { loadGlobalConfig, loadGuildConfigs, resolveGuildConfig, validateTrimConfig, validateVpnConfig } from "./config/loader";
import type { GuildConfig } from "./config/types";
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
import { handleMessage, runSilentMemoryAgentPass, type ImageAttachmentResolver, type IncomingMessage, type HandlerDeps, type MessageSender, type OutboundAttachment } from "./agent/handler";
import { shouldRespond, type TriggerResult } from "./agent/triggers";
import { buildPublicErrorNoticeForError } from "./agent/public-error-notice";
import { createChannelDispatcher, selectDispatchMessageForTrigger, type ChannelDispatcher, type DispatchOutcome } from "./discord/channel-dispatcher";
import { assembleContext, type AssembledContext, type ThreadMetadata } from "./agent/context-assembly";
import type { HistoryMessage } from "./agent/history-types";
import { getContextHistoryMessages, insertSyntheticEvent, insertPromptOnlyBotMessage, getParentPreContext, getChatHistory, deleteRecentMessages, upsertMessageReaction, deleteMessageReactions, deleteMessageEmojiReaction, upsertBotMessageContent, deleteBotMessageState, getRoutedMessageSource, type RoutedMessageSource } from "./db/message-repository";
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
import { currentLocalContext } from "./time/agent-time";
import type { ReplyFallbackDeps } from "./agent/reply-target-fallback";

import { createElevenLabsClient, type ElevenLabsClient } from "./tts/client";
import type { TtsResult } from "./tts/types";
import { buildMemoryContext, buildVisibleUserMemoryContext, createRecordMemoryTool } from "./agent/memory-service";
import { createSearchTool } from "./agent/search-tool";
import { createScheduleTools } from "./agent/schedule-tool";
import { createChatUserListTool, type MemberInfo } from "./agent/member-list-tool";
import { createChannelListTool, type ChannelInfo } from "./agent/channel-list-tool";
import { createEmojiListTool } from "./agent/emoji-list-tool";
import { createTimeoutUserTool, type TimeoutMember, type TimeoutMemberResolution } from "./agent/timeout-user-tool";
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
import { getImageById, getImagesByMessageId } from "./db/image-repository";
import { upsertThread, updateThreadActivity, markBotParticipating, markThreadArchived, listThreadsForContext, getThreadMetadata, getThread } from "./db/thread-repository";
import { imageExtensionForMime, prepareImageBufferForContext, processAndStoreImage, storeImageBufferUnmodified, type ImageIngestDeps } from "./db/image-ingest";
import { deleteExpiredMemories, countUserMemoriesByUser } from "./db/memory-repository";
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
import { loadPromptProfile } from "./config/prompt-profile";
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
    "Image generation is asynchronous. Active jobs keep typing while the worker runs. When ready, the runtime starts a normal 2b reply loop with the generated image attached to the current turn and sends that reply to the original message. Do not start a duplicate job for the same concrete request while a matching active job is visible here.",
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
    const contextAttachment = attachment !== undefined
      ? await prepareImageBufferForContext(attachment.buffer, attachment.contentType, CONTEXT_IMAGE_MAX_DIMENSION)
      : undefined;
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
      ...(attachment !== undefined && contextAttachment !== undefined ? { imageInputs: [{
        buffer: contextAttachment.data,
        contentType: contextAttachment.mime,
        metadataText: [
          `Generated by async image job ${job.id}.`,
          `4K: ${attachment.is4k === true ? "yes" : "no"}.`,
          attachment.transport !== undefined ? `Transport: ${attachment.transport}.` : "",
          attachment.requestedSize !== undefined ? `Requested size: ${attachment.requestedSize}.` : "",
          attachment.actualSize !== undefined ? `Actual size: ${attachment.actualSize}.` : "",
          `Filename: ${attachment.filename}.`,
          `Context copy: ${contextAttachment.width}x${contextAttachment.height} ${contextAttachment.mime}.`,
          `Original request: "${job.sourceQuote}"`,
        ].join(" "),
      }] } : {}),
    };
    const completionResult = await handleMessage(completionIncoming, {
      globalConfig,
      guildConfig: deliveryGuildConfig,
      context,
      currentChannelId: job.deliveryChannelId,
      personaPrompt: persona,
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

    const completionInstruction = [
      `[Async Image Job Ready] Job ${job.id} generated an image for @${job.requesterUsername}.`,
      `4K: ${job.input.is4k ? "yes" : "no"}`,
      details?.transport !== undefined ? `Transport: ${details.transport}` : "",
      details?.requestedSize !== undefined ? `Requested size: ${details.requestedSize}` : "",
      details?.actualSize !== undefined ? `Actual size: ${details.actualSize}` : "",
      `Original request MsgID ${job.sourceMessageId}: "${job.sourceQuote}"`,
      `Generation prompt: ${job.input.prompt}`,
      typeof details?.revisedPrompt === "string" ? `Revised prompt: ${details.revisedPrompt}` : "",
      "The generated image is attached to this current turn as image input and is already queued as an outgoing attachment on your first visible Discord reply.",
      `Use the normal persona, current channel history, and the visible image itself. Prefer replying to the original request: <message reply="true" reply_to="${job.sourceMessageId}">your response text</message>. If the current channel context makes another message the clearly better target, you may reply to that message instead, but do not use reply="false" for the first response.`,
      "Do not call codex_generate_image, cancel_agent_job, or start another image job for this completion.",
    ].filter((part) => part !== "").join("\n");
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
        const failureInstruction = [
          `[Async Image Job Failed] Job ${job.id} ${latest.status === "timed_out" ? "timed out" : "failed"} for @${job.requesterUsername}.`,
          `Original request MsgID ${job.sourceMessageId}: "${job.sourceQuote}"`,
          `Generation prompt: ${job.input.prompt}`,
          `Failure detail for context: ${message}`,
          "The image was not generated and there is no outgoing image attachment.",
          `Use the normal persona and current channel history. Prefer replying to the original request: <message reply="true" reply_to="${job.sourceMessageId}">your response text</message>. If the current channel context makes another message the clearly better target, you may reply to that message instead.`,
          "You may retry with codex_generate_image from this failure turn, but prefer not to unless the user asked for a retry or you are certain a revised prompt will work this time. If you retry, first tell the user the image failed and that you are trying again, then call codex_generate_image. Do not retry the same request more than 3 times unless the current channel or user explicitly overrides that limit.",
          "Explain the failure naturally in the channel. Do not paste raw JSON, stack traces, or long internal errors unless the user explicitly asks for technical details.",
        ].join("\n");
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
}): (sentId: string, targetGuildId: string, targetChannelId: string, rawContent: string, plainContent: string) => void {
  return (sentId, targetGuildId, targetChannelId, rawContent, plainContent) => {
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
        null,
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
    "This list is navigation context only. Do not copy private details, drama, or local assumptions across guilds unless the user asks or it is necessary.",
    "Prompt chat history is only for the current channel/thread. Use list_channels, chat_history, search_messages, or list_memories when another channel/guild needs context. Preserve cross-channel continuity with tiny user/guild memories or scratchpad only when it will matter later.",
    "Guild shortlist: one Discord system channel per guild. Use list_channels with guild_id for the full visible channel list before assuming other channels.",
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
  sendNow: (channelId?: string) => Promise<void>;
  startLoop: (channelId?: string) => void;
  stopLoop: () => void;
} {
  let lastTypingAt = 0;
  let typingTimer: ReturnType<typeof setInterval> | null = null;
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

  const startLoop = (channelId?: string): void => {
    typingChannelId = channelId;
    void sendNow(typingChannelId).catch(() => {});
    if (typingTimer !== null) return;
    typingTimer = setInterval(() => { void sendNow(typingChannelId).catch(() => {}); }, TYPING_INTERVAL_MS);
  };

  const stopLoop = (): void => {
    if (typingTimer !== null) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
  };

  return {
    getLastTypingAt: () => lastTypingAt,
    sendNow,
    startLoop,
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

    const replyToSpecific = async (content: string | AttachmentSendPayload): Promise<Message> => {
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
          return await sendToTargetChannel(content);
        }

        return await sendWithUnknownMessageReferenceFallback(
          () => replyWithMessage(targetMsg, content),
          () => sendToTargetChannel(content),
          (err) => {
            input.logger.warn("reply_to_message_id target disappeared, falling back to send", {
              replyToMessageId,
              channelId: targetChannel.id,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        );
      }
      return await sendToTargetChannel(content);
    };

    const replyToSource = async (content: string | AttachmentSendPayload): Promise<Message> => {
      const sourceMessage = input.replySourceMessage;
      if (sourceMessage === undefined) return await sendToTargetChannel(content);
      if (sourceMessage.channelId !== targetChannel.id) return await sendToTargetChannel(content);

      return await sendWithUnknownMessageReferenceFallback(
        () => replyWithMessage(sourceMessage, content),
        () => sendToTargetChannel(content),
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
      if (replyToMessageId !== undefined) {
        sent = await replyToSpecific(payload);
      } else if (reply) {
        sent = await replyToSource(payload);
      } else {
        sent = await sendToTargetChannel(payload);
      }
      storeBotMessage(sent.id, targetGuildId, targetChannelId, voiceRawContent(firstChunk), voice.historyText ?? text);
      await storeBotImageAttachments(sent.id, targetGuildId, targetChannelId, attachments);
      for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i] as string;
        const followup = await sendToTargetChannel(buildAttachmentPayload(
          chunk,
          [],
          discordMessageNonce(dedupeKey, `voice-${i}`),
        ));
        storeBotMessage(followup.id, targetGuildId, targetChannelId, chunk, chunk);
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
      if (replyToMessageId !== undefined && i === 0) {
        sent = await replyToSpecific(payload);
      } else if (reply && i === 0) {
        sent = await replyToSource(payload);
      } else {
        sent = await sendToTargetChannel(payload);
      }
      if (i === 0) firstId = sent.id;
      storeBotMessage(sent.id, targetGuildId, targetChannelId, chunk, i === 0 ? text : chunk);
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

// --- 8. Load prompt profile. Persona/style are stable prompt sections for the direct reply model.
let { persona, toolInstructions } = loadPromptProfile(globalConfig.promptProfile, log);

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
        personaPrompt: persona,
        sender,
        extraTools,
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
          if (!guildConfig.memoryExtraction.postReply) return;
          const memoryLog = new RequestLog(guildId, channelId, requestLogStore);
          memoryLog.setAuthor("scheduler");
          memoryLog.setTriggerContext({
            ...dashboardTriggerLocation(guild, textChannel),
            messageId: memoryRequest.sourceMessageId ?? syntheticLatestMessage.id,
            authorUsername: "scheduler",
            content: memoryRequest.userMessage,
            translatedContent: memoryRequest.userMessage,
          });
          memoryLog.setTrigger({ type: "background_memory_extraction", sourceRequestId: requestLog.requestId, source: "scheduled" });
          memoryLog.setAgentRan(true);
          requestLogStore.incrementActive();
          const recordMemoryTool = createRecordMemoryTool({
            db,
            guildId,
            currentUserId: "scheduler",
            sourceMessageId: memoryRequest.sourceMessageId ?? syntheticLatestMessage.id,
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
          const visibleUserMemoryContext = buildVisibleUserMemoryContext({
            db,
            guildId,
            currentUserId: "scheduler",
            visibleUserIds: memoryRequest.context.visibleUserIds ?? [],
            resolveUserId: (userId) => guild.members.cache.get(userId)?.user.username,
          });
          try {
            await runSilentMemoryAgentPass({
              globalConfig,
              guildConfig,
              context: memoryRequest.context,
              personaPrompt: persona,
              incomingMessage: memoryRequest.incomingMessage,
              userContent: memoryRequest.userMessage,
              assistantReply: memoryRequest.assistantReply,
              visibleReplySent: memoryRequest.visibleReplySent,
              visibleUserMemoryContext,
              tools: [recordMemoryTool],
              requestLog: memoryLog,
              log: scheduleLog.child({ guildId, channelId, requestId: memoryLog.requestId }),
            });
            markMemoryExtractionCheckpointFromContext({
              guildId,
              channelId,
              contextMessageIds: memoryRequest.context.contextMessageIds,
              fallbackMessageId: memoryRequest.sourceMessageId,
            });
          } catch (err) {
            memoryLog.setError(err instanceof Error ? err.message : String(err));
            throw err;
          } finally {
            memoryLog.emit(log);
            requestLogStore.decrementActive();
          }
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
async function buildContext(
  guildId: string,
  channelId: string,
  guild: Guild,
  guildConfig: GuildConfig,
  userMessage: string,
  latestUserMessage: HistoryMessage,
  replyFallbackDeps: ReplyFallbackDeps,
  isThread: boolean,
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
  });

  const pendingSchedules = listUpcomingForContext(db, guildId, channelId);
  const oneOffCount = pendingSchedules.filter((s) => s.type === "one_off").length;
  const cronCount = pendingSchedules.length - oneOffCount;
  const upcomingSchedules = `Pending schedules in this channel: ${pendingSchedules.length} (${oneOffCount} one-off, ${cronCount} cron). Use list_scheduled_messages if you need schedule details or IDs.`;
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

  // Current context metadata — local wall-clock time, no ISO Z strings
  const currentContext = currentLocalContext(guildConfig.timezone);

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
      toolInstructions,
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
      currentContext,
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
    });
    const currentUserMemories = buildMemoryContext({
      db,
      guildId,
      currentUserId: lastMessage.authorId,
      resolveUserId: (userId) => guild.members.cache.get(userId)?.user.username,
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
        personaPrompt: persona,
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
          message: `Multiple guild members match '${target}'. Use a mention or raw user ID.`,
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

  return tools;
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
      return processTriggeredMessage(selected.message as Message, trigger.result);
    },
  });
  dispatchers.set(guildId, dispatcher);
  return dispatcher;
}

function evaluateMessageTrigger(message: Message, guildConfig: GuildConfig): TriggerResult {
  return shouldRespond(
    {
      content: message.content,
      authorId: message.author.id,
      botUserId: client.user?.id ?? "",
      mentionedUserIds: [...message.mentions.users.keys()],
    },
    guildConfig.triggers,
  );
}

function sendTypingForMessage(message: Message): void {
  const channel = message.channel;
  if ("sendTyping" in channel && typeof channel.sendTyping === "function") {
    void channel.sendTyping().catch(() => {});
  }
}

/** Process a triggered message through the full handler pipeline. */
async function processTriggeredMessage(
  message: Message,
  triggerOverride?: NonNullable<TriggerResult>,
): Promise<DispatchOutcome> {
  if (message.guild === null || message.guildId === null) return { coveredMessageIds: [] };
  const guild = message.guild;

  const guildId = message.guildId;
  const channelId = message.channelId;
  requestLogStore.incrementActive();
  const guildConfig = getGuildConfig(guildId);

  try {
    const inboundResolvers = buildInboundResolvers(guild);
    const translatedContent = appendStickerTags(
      translateInbound(message.content, inboundResolvers),
      message.stickers.values(),
    );
    const currentChannelObj = message.channel as SendableGuildChannel;
    const resolveTargetChannel = createTargetChannelResolver(client, currentChannelObj);
    const typing = createTypingController({
      defaultChannel: currentChannelObj,
      resolveTargetChannel,
    });
    const sender = createDiscordMessageSender({
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

    const ingestedImages = getImagesByMessageId(db, message.id);
    const now = Date.now();
    const repliedToBotRouteSource = message.reference?.messageId !== undefined
      ? getRoutedMessageSource(db, {
          messageId: message.reference.messageId,
          guildId,
          channelId,
        })
      : null;
    const latestUserMessage: HistoryMessage = {
      id: message.id,
      author: message.author.username,
      authorDisplayName: authorDisplayName(message),
      authorId: message.author.id,
      content: translatedContent,
      isBot: false,
      timestamp: now,
      replyToId: message.reference?.messageId ?? null,
      imageIds: ingestedImages.map((img) => img.id),
      captions: ingestedImages.map((img) => img.caption ?? ""),
      imageSourceKinds: ingestedImages.map((img) => img.sourceKind),
      hasEmbeds: message.embeds.length > 0,
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
    const context = await buildContext(guildId, channelId, guild, guildConfig, translatedContent, latestUserMessage, replyFallbackDeps, isThread);

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
    const extraTools = [
      ...buildAgentTools(
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
      ),
      startThreadTool,
      closeThreadTool,
    ];

    const incoming: IncomingMessage = {
      content: message.content,
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
      translatedContent,
      messageId: message.id,
      replyToMessageId: message.reference?.messageId,
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

    const requestLog = new RequestLog(guildId, channelId, requestLogStore);
    requestLog.setAuthor(message.author.username);
    requestLog.setTriggerContext({
      ...dashboardTriggerLocation(guild, message.channel),
      messageId: message.id,
      authorUsername: message.author.username,
      content: message.content,
      translatedContent,
    });

    const { ttsEnabled, generateSpeech } = createTtsGenerator(guildConfig);

    const deps: HandlerDeps = {
      globalConfig,
      guildConfig,
      context,
      currentChannelId: channelId,
      personaPrompt: persona,
      sender,
      extraTools,
      log: log.child({ guildId, channelId, requestId: requestLog.requestId }),
      onTriggered: () => { typing.startLoop(); },
      onStillWorking: (destinationChannelId) => { typing.startLoop(destinationChannelId); },
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
      triggerInstructions: guildConfig.triggerInstructions,
      modelImageInputSupport: getModelImageInputSupport(guildConfig),
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
      },
      afterReply: async (memoryRequest) => {
        if (!guildConfig.memoryExtraction.postReply) return;
        const memoryLog = new RequestLog(guildId, channelId, requestLogStore);
        memoryLog.setAuthor(message.author.username);
        memoryLog.setTriggerContext({
          ...dashboardTriggerLocation(guild, message.channel),
          messageId: memoryRequest.sourceMessageId ?? message.id,
          authorUsername: message.author.username,
          content: memoryRequest.userMessage,
          translatedContent: memoryRequest.userMessage,
        });
        memoryLog.setTrigger({ type: "background_memory_extraction", sourceRequestId: requestLog.requestId });
        memoryLog.setAgentRan(true);
        requestLogStore.incrementActive();
        const recordMemoryTool = createRecordMemoryTool({
          db,
          guildId,
          currentUserId: message.author.id,
          currentUsername: message.author.username,
          sourceMessageId: memoryRequest.sourceMessageId ?? message.id,
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
        const visibleUserMemoryContext = buildVisibleUserMemoryContext({
          db,
          guildId,
          currentUserId: message.author.id,
          visibleUserIds: memoryRequest.context.visibleUserIds ?? [],
          resolveUserId: (userId) => guild.members.cache.get(userId)?.user.username,
        });
        try {
          await runSilentMemoryAgentPass({
            globalConfig,
            guildConfig,
            context: memoryRequest.context,
            personaPrompt: persona,
            incomingMessage: memoryRequest.incomingMessage,
            userContent: memoryRequest.userMessage,
            assistantReply: memoryRequest.assistantReply,
            visibleReplySent: memoryRequest.visibleReplySent,
            visibleUserMemoryContext,
            tools: [recordMemoryTool],
            requestLog: memoryLog,
            log: log.child({ guildId, channelId, requestId: memoryLog.requestId }),
          });
          const checkpointMarked = markMemoryExtractionCheckpointAtMessage(db, {
            guildId,
            channelId,
            messageId: memoryRequest.sourceMessageId ?? message.id,
          });
          if (!checkpointMarked) {
            markMemoryExtractionCheckpointFromContext({
              guildId,
              channelId,
              contextMessageIds: memoryRequest.context.contextMessageIds,
            });
          }
        } catch (err) {
          memoryLog.setError(err instanceof Error ? err.message : String(err));
          throw err;
        } finally {
          memoryLog.emit(log);
          requestLogStore.decrementActive();
        }
      },
    };

    let result;
    try {
      result = await handleMessage(incoming, deps);
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
    if (!message.author.bot) {
      requestLogStore.decrementActive();
    }
  }
}

// --- 22. typingStart handler ---
client.on("typingStart", (typing: Typing) => {
  if (!typing.inGuild()) return;
  if (typing.user.bot) return;

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

    // Store message in SQLite
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT OR IGNORE INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(message.id, guildId, channelId, message.author.id, message.author.username, message.content, translatedContent, 0, now, message.reference?.messageId ?? null);

    // Enqueue for embedding
    void embeddingQueue.enqueue({
      id: message.id,
      text: translatedContent,
      target: "message",
      metadata: {
        guild_id: guildId,
        channel_id: channelId,
        user_id: message.author.id,
        created_at: now,
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
        lastActivityAt: now,
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
          lastActivityAt: now,
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

    // Dispatch to handler: use channel dispatcher if enabled, otherwise call directly
    if (guildConfig.dispatcher.enabled) {
      if (triggerResult?.reason === "keyword" || triggerResult?.reason === "mention") sendTypingForMessage(message);
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
    ({ persona, toolInstructions } = loadPromptProfile(globalConfig.promptProfile, log));

    guildConfigs.clear();
    for (const [id, cfg] of newGuilds) {
      guildConfigs.set(id, cfg);
    }

    // Invalidate dispatchers so they pick up new config on next enqueue
    for (const d of dispatchers.values()) d.dispose();
    dispatchers.clear();

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

// --- Start dashboard ---
const dashboardPassword = process.env.DASHBOARD_PASSWORD;
const bypassDashboardAuth = process.env.UNSAFELY_BYPASS_DASHBOARD_AUTH === "true";
const dashboardPasswordlessCidrs = parseDashboardPasswordlessCidrs(process.env.DASHBOARD_PASSWORDLESS_CIDRS);
const dashboardTrustedProxyCidrs = parseDashboardPasswordlessCidrs(process.env.DASHBOARD_TRUSTED_PROXY_CIDRS);
if (bypassDashboardAuth) {
  startDashboard({ port: 3000, password: "", bypassAuth: true, log });
  log.warn("dashboard started with auth bypass — do not use in production");
} else if (dashboardPassword !== undefined && dashboardPassword !== "") {
  startDashboard({
    port: 3000,
    password: dashboardPassword,
    passwordlessCidrs: dashboardPasswordlessCidrs,
    trustedProxyCidrs: dashboardTrustedProxyCidrs,
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

export { db, qdrant, embeddingQueue, guildConfigs, globalConfig, persona, scheduler, client };
