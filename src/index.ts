import { createLogger, RequestLog, type LogLevel, type Logger } from "./logger";
import { requestLogStore } from "./dashboard/store";
import { parseDashboardPasswordlessCidrs, startDashboard } from "./dashboard/server";
import { loadGlobalConfig, loadGuildConfigs, resolveGuildConfig, validateTrimConfig, validateVpnConfig } from "./config/loader";
import type { GuildConfig } from "./config/types";
import { createDatabase } from "./db/database";
import { createQdrantClient, ensureCollection, healthCheck } from "./qdrant/client";
import { deletePoint, deletePoints } from "./qdrant/adapter";
import { getEmbeddingPipeline, disposePipeline } from "./embeddings/pipeline";
import { createEmbeddingQueue, type EmbeddingQueue } from "./embeddings/queue";
import { createDiscordClient, loginDiscordClient } from "./discord/client";
import { sendWithUnknownMessageReferenceFallback } from "./discord/message-reference-retry";
import { translateInbound, translateOutbound, buildDisplayNameContext, type InboundResolvers, type OutboundResolvers } from "./discord/translation";
import { splitMessage } from "./discord/split-message";
import { EmojiCache, buildEmojiContext, type EmojiEntry } from "./discord/emoji-cache";
import { createSchedulerEngine, type SchedulerEngine } from "./scheduler/engine";
import { handleMessage, runSilentMemoryAgentPass, type IncomingMessage, type HandlerDeps, type MessageSender, type OutboundAttachment } from "./agent/handler";
import { shouldRespond, type TriggerResult } from "./agent/triggers";
import { buildPublicErrorNoticeForError } from "./agent/public-error-notice";
import { createChannelDispatcher, selectDispatchMessageForTrigger, type ChannelDispatcher, type DispatchOutcome } from "./discord/channel-dispatcher";
import { assembleContext, type AssembledContext, type ThreadMetadata } from "./agent/context-assembly";
import type { HistoryMessage } from "./agent/history-types";
import { getContextHistoryMessages, insertSyntheticEvent, getParentPreContext, getChatHistory, deleteRecentMessages } from "./db/message-repository";
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
import { createMemberListTool, type MemberInfo } from "./agent/member-list-tool";
import { createUserMemoryTool } from "./agent/user-memory-tool";
import { createChatHistoryTool } from "./agent/chat-history-tool";
import { createBraveSearchTool } from "./agent/brave-search-tool";
import { createReadChatImagesTool } from "./agent/read-chat-images-tool";
import { createFetchImagesTool } from "./agent/fetch-images-tool";
import { createCodexGenerateImageTool, type GeneratedImageAttachment } from "./agent/codex-image-tool";
import { AgentJobStore, createCancelAgentJobTool, isActiveJobStatus, type AgentJob, type ImageGenerationJobResult } from "./agent/job-runtime";
import { createFetchUrlTool } from "./agent/fetch-url-tool";
import { createSummarizeVideoTool } from "./agent/summarize-video-tool";
import { createStartThreadTool } from "./agent/start-thread-tool";
import { getImageById, getImagesByMessageId } from "./db/image-repository";
import { insertThread, updateThreadActivity, markBotParticipating, listThreadsForContext, getThreadMetadata } from "./db/thread-repository";
import { prepareImageBufferForContext, processAndStoreImage, storeImageBufferUnmodified, type ImageIngestDeps } from "./db/image-ingest";
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
import { createHash } from "node:crypto";
import { join } from "path";
import { mkdirSync, existsSync, readFileSync, watch, unlinkSync } from "fs";
import type { Database } from "./db/database";
import { AttachmentBuilder, MessageFlags, type ChatInputCommandInteraction, type Client, type Guild, type Message, type TextChannel, type Typing } from "discord.js";

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
type ResolveTargetChannel = (chatId: string | undefined) => TextChannel;

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
    const error = job.error !== undefined ? ` error: ${shortQuote(job.error, 100)}` : "";
    const highRes = job.input.is4k ? " 4K" : "";
    lines.push(
      `- ${job.id} ${job.status}${highRes} (${state}) for @${job.requesterUsername} from MsgID ${job.sourceMessageId}${replacement}; requested ${formatJobAge(job, now)}; quote: "${job.sourceQuote}"${sent}${error}`,
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
  const guildConfig = getGuildConfig(job.guildId);
  const guild = client.guilds.cache.get(job.guildId);
  if (guild === undefined) {
    agentJobs.markFailed(job.id, "Guild is unavailable.");
    return;
  }
  const channel = guild.channels.cache.get(job.channelId);
  if (channel === undefined || !("send" in channel) || !("sendTyping" in channel)) {
    agentJobs.markFailed(job.id, "Target channel is unavailable.");
    return;
  }
  const textChannel = channel as TextChannel;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Image job ${job.id} timed out after ${guildConfig.agentJobs.imageTimeoutMs}ms`));
  }, guildConfig.agentJobs.imageTimeoutMs);
  const typingTimer = setInterval(() => {
    void textChannel.sendTyping().catch(() => {});
  }, TYPING_INTERVAL_MS);
  void textChannel.sendTyping().catch(() => {});
  agentJobs.start(job.id, () => controller.abort(new Error(`Image job ${job.id} cancelled.`)));

  const requestLog = new RequestLog(job.guildId, job.channelId);
  requestLog.setAuthor(job.requesterUsername);
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
    const outboundResolvers = buildOutboundResolvers(guild);
    let sourceMessage: Message | undefined;
    try {
      sourceMessage = await textChannel.messages.fetch(job.sourceMessageId);
    } catch {
      sourceMessage = undefined;
    }
    const completionTyping = createTypingController({
      defaultChannel: textChannel,
      resolveTargetChannel: createTargetChannelResolver(guild, textChannel),
    });
    const sender = createDiscordMessageSender({
      guildId: job.guildId,
      guild,
      defaultChannel: textChannel,
      outboundResolvers,
      botUserId: client.user?.id ?? "",
      botUsername: client.user?.username ?? "bot",
      logger: log,
      ...(sourceMessage !== undefined ? { replySourceMessage: sourceMessage } : {}),
      getLastTypingAt: completionTyping.getLastTypingAt,
      imageStore: {
        attachmentsDir: guildConfig.attachmentsDir,
      },
    });

    const replyFallbackDeps: ReplyFallbackDeps = {
      db,
      guildId: job.guildId,
      channelId: job.channelId,
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
          };
        } catch { return null; }
      },
      enqueueEmbedding: async (id, text, metadata) => {
        await embeddingQueue.enqueue({ id, text, target: "message", metadata });
      },
      processImage: async (url, contentType, messageId) => {
        const ingestDeps: ImageIngestDeps = {
          db,
          attachmentsDir: guildConfig.attachmentsDir,
          maxDimension: guildConfig.imageMaxDimension,
          fetchFn: fetch,
        };
        await processAndStoreImage(ingestDeps, { url, mimeType: contentType, messageId, guildId: job.guildId, channelId: job.channelId });
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
      job.guildId,
      job.channelId,
      guild,
      guildConfig,
      input.instruction,
      syntheticLatestMessage,
      replyFallbackDeps,
      textChannel.isThread(),
    );
    const extraTools = buildAgentTools(
      job.guildId,
      job.channelId,
      guildConfig,
      guild,
      context.contextMessageIds,
      undefined,
      undefined,
      { includeImageGenerationTools: false },
    );
    let sentMessageId: string | undefined;
    const completionSender: MessageSender = async (...args) => {
      const sent = await sender(...args);
      sentMessageId ??= sent.sentMessageId;
      return sent;
    };
    const { ttsEnabled, generateSpeech } = createTtsGenerator(guildConfig);
    const attachment = input.attachment;
    const contextAttachment = attachment !== undefined
      ? await prepareImageBufferForContext(attachment.buffer, attachment.contentType, CONTEXT_IMAGE_MAX_DIMENSION)
      : undefined;
    const completionIncoming: IncomingMessage = {
      content: input.instruction,
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
      guildConfig,
      context,
      personaPrompt: persona,
      sender: completionSender,
      extraTools,
      log: log.child({ component: `async-image-${input.event}`, guildId: job.guildId, channelId: job.channelId, jobId: job.id, requestId: requestLog.requestId }),
      requestLog,
      ttsEnabled,
      generateSpeech,
      ...(attachment !== undefined ? { initialPendingAttachments: [attachment] } : {}),
      forceTrigger: true,
      triggerInstructions: guildConfig.triggerInstructions,
      modelImageInputSupport: getModelImageInputSupport(guildConfig),
      onTriggered: () => { completionTyping.startLoop(); },
      onStillWorking: (targetChatId) => { completionTyping.startLoop(targetChatId); },
      onVisibleOutput: completionTyping.stopLoop,
      onAgentEnd: completionTyping.stopLoop,
    });
    return completionResult.agentRan ? sentMessageId : undefined;
  };

  try {
    const generated = createGeneratedImageRuntime();
    const tool = createCodexGenerateImageTool({
      codexAuthPath: globalConfig.codexAuthPath,
      model: guildConfig.llmProvider === "openai-codex"
        ? guildConfig.model ?? globalConfig.defaultModel
        : DEFAULT_CODEX_IMAGE_ROUTER_MODEL,
      sessionId: `2b2v-image-job:${job.guildId}:${job.channelId}:${job.id}`,
      logger: log.child({ component: "async-image-job", guildId: job.guildId, channelId: job.channelId, jobId: job.id }),
      imageReadMaxPerCall: guildConfig.imageReadMaxPerCall,
      imageGenerationQuality: guildConfig.imageGeneration.quality,
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
      `Use the normal persona, current chat history, and the visible image itself. Prefer replying to the original request: <message reply="true" reply_to="${job.sourceMessageId}">your response text</message>. If the current chat context makes another message the clearly better target, you may reply to that message instead, but do not use reply="false" for the first response.`,
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
          `Use the normal persona and current chat history. Prefer replying to the original request: <message reply="true" reply_to="${job.sourceMessageId}">your response text</message>. If the current chat context makes another message the clearly better target, you may reply to that message instead.`,
          "Explain the failure naturally in chat. Do not paste raw JSON, stack traces, or long internal errors unless the user explicitly asks for technical details.",
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
  guildId: string;
  botUserId: string;
  botUsername: string;
  logger: Logger;
}): (sentId: string, targetChannelId: string, rawContent: string, plainContent: string) => void {
  return (sentId, targetChannelId, rawContent, plainContent) => {
    const ts = Date.now();
    db.raw
      .prepare(
        `INSERT OR IGNORE INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(sentId, input.guildId, targetChannelId, input.botUserId, input.botUsername, rawContent, plainContent, 1, ts, null);

    void embeddingQueue.enqueue({
      id: sentId,
      text: plainContent,
      target: "message",
      metadata: {
        guild_id: input.guildId,
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

function createTargetChannelResolver(guild: Guild, defaultChannel: TextChannel): ResolveTargetChannel {
  return (chatId) => {
    if (chatId === undefined) return defaultChannel;
    const resolved = guild.channels.cache.get(chatId);
    if (resolved === undefined) throw new Error(`Invalid chat_id: channel "${chatId}" not found`);
    if (!("send" in resolved)) throw new Error(`Invalid chat_id: channel "${chatId}" is not a text channel`);
    return resolved as TextChannel;
  };
}

function createTypingController(input: {
  defaultChannel: TextChannel;
  resolveTargetChannel: ResolveTargetChannel;
}): {
  getLastTypingAt: () => number;
  sendNow: (chatId?: string) => Promise<void>;
  startLoop: (chatId?: string) => void;
  stopLoop: () => void;
} {
  let lastTypingAt = 0;
  let typingTimer: ReturnType<typeof setInterval> | null = null;
  let typingChatId: string | undefined;

  const sendNow = async (chatId?: string): Promise<void> => {
    const targetChannel = (() => {
      if (chatId === undefined) return input.defaultChannel;
      try {
        return input.resolveTargetChannel(chatId);
      } catch {
        return input.defaultChannel;
      }
    })();
    lastTypingAt = Date.now();
    await targetChannel.sendTyping().catch(() => {});
  };

  const startLoop = (chatId?: string): void => {
    typingChatId = chatId;
    void sendNow(typingChatId).catch(() => {});
    if (typingTimer !== null) return;
    typingTimer = setInterval(() => { void sendNow(typingChatId).catch(() => {}); }, TYPING_INTERVAL_MS);
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
  guildId: string;
  guild: Guild;
  defaultChannel: TextChannel;
  outboundResolvers: OutboundResolvers;
  botUserId: string;
  botUsername: string;
  logger: Logger;
  replySourceMessage?: Message;
  getLastTypingAt?: () => number;
  imageStore?: {
    attachmentsDir: string;
  };
}): MessageSender {
  const storeBotMessage = createBotMessageStore({
    guildId: input.guildId,
    botUserId: input.botUserId,
    botUsername: input.botUsername,
    logger: input.logger,
  });
  const resolveTargetChannel = createTargetChannelResolver(input.guild, input.defaultChannel);

  async function waitAfterRecentTyping(): Promise<void> {
    const lastTypingAt = input.getLastTypingAt?.() ?? 0;
    const sinceTypingMs = Date.now() - lastTypingAt;
    if (sinceTypingMs >= 0 && sinceTypingMs < 200) {
      await new Promise((resolve) => setTimeout(resolve, 200 - sinceTypingMs));
    }
  }

  async function storeBotImageAttachments(
    messageId: string,
    targetChannelId: string,
    attachments: OutboundAttachment[] | undefined,
  ): Promise<void> {
    if (attachments === undefined || attachments.length === 0 || input.imageStore === undefined) return;
    const imageStore = input.imageStore;
    const results = await Promise.allSettled(attachments.map((attachment) =>
      storeImageBufferUnmodified({
        db,
        attachmentsDir: imageStore.attachmentsDir,
      }, {
        buffer: attachment.buffer,
        mimeType: attachment.contentType,
        messageId,
        guildId: input.guildId,
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

  return async (text, reply, chatId, voice, _signal, replyToMessageId, attachments, dedupeKey) => {
    const targetChannel = resolveTargetChannel(chatId);
    const targetChannelId = targetChannel.id;

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
      const translated = translateOutbound(text, input.outboundResolvers, warnings);
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
      storeBotMessage(sent.id, targetChannelId, voiceRawContent(firstChunk), voice.historyText ?? text);
      await storeBotImageAttachments(sent.id, targetChannelId, attachments);
      for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i] as string;
        const followup = await sendToTargetChannel(buildAttachmentPayload(
          chunk,
          [],
          discordMessageNonce(dedupeKey, `voice-${i}`),
        ));
        storeBotMessage(followup.id, targetChannelId, chunk, chunk);
      }
      if (targetChannel.isThread()) {
        updateThreadActivity(db, targetChannelId, { lastActivityAt: Date.now(), lastMessageId: sent.id });
        markBotParticipating(db, targetChannelId);
      }
      return { sentMessageId: sent.id, warnings: unresolvedEmojiWarnings(warnings) };
    }

    const warnings: string[] = [];
    const translated = translateOutbound(text, input.outboundResolvers, warnings);
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
      storeBotMessage(sent.id, targetChannelId, chunk, i === 0 ? text : chunk);
      if (i === 0) await storeBotImageAttachments(sent.id, targetChannelId, attachments);
    }
    if (targetChannel.isThread()) {
      updateThreadActivity(db, targetChannelId, { lastActivityAt: Date.now(), lastMessageId: firstId });
      markBotParticipating(db, targetChannelId);
    }
    return { sentMessageId: firstId, warnings: unresolvedEmojiWarnings(warnings) };
  };
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

      const outboundResolvers = buildOutboundResolvers(guild);
      const resolveTargetChannel = createTargetChannelResolver(guild, textChannel);
      const typing = createTypingController({
        defaultChannel: textChannel,
        resolveTargetChannel,
      });
      const sender = createDiscordMessageSender({
        guildId,
        guild,
        defaultChannel: textChannel,
        outboundResolvers,
        botUserId,
        botUsername,
        logger: scheduleLog,
        getLastTypingAt: typing.getLastTypingAt,
        imageStore: {
          attachmentsDir: guildConfig.attachmentsDir,
        },
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
        authorId: "scheduler",
        authorUsername: "scheduler",
        botUserId,
        mentionedUserIds: [],
        translatedContent: schedule.messageContent,
        messageId: syntheticLatestMessage.id,
        replyToMessageId: syntheticLatestMessage.replyToId ?? undefined,
      };

      // Build request log
      const requestLog = new RequestLog(guildId, channelId);
      requestLog.setAuthor("scheduler");

      const { ttsEnabled, generateSpeech } = createTtsGenerator(guildConfig);

      // Build handler deps with forceTrigger
      const deps: HandlerDeps = {
        globalConfig,
        guildConfig,
        context,
        personaPrompt: persona,
        sender,
        extraTools,
        log: scheduleLog,
        requestLog,
        ttsEnabled,
        generateSpeech,
        consumeGeneratedAttachments: generatedImages.consumeGeneratedAttachments,
        onTriggered: () => { typing.startLoop(); },
        onStillWorking: (targetChatId) => { typing.startLoop(targetChatId); },
        onVisibleOutput: typing.stopLoop,
        onAgentEnd: typing.stopLoop,
        forceTrigger: true,
        triggerInstructions: guildConfig.triggerInstructions,
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

      // Qdrant cleanup
      if (messageIds.length > 0) {
        await deletePoints(qdrant, messageIds);
      }

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

// --- 18. Refresh emoji cache for a guild ---
function refreshEmojiCache(guild: Guild): void {
  if (!emojiCache.isStale(guild.id, EMOJI_TTL_MS)) return;
  const emojis: EmojiEntry[] = guild.emojis.cache.map((e) => ({
    name: e.name,
    id: e.id,
    animated: e.animated,
  }));
  emojiCache.set(guild.id, emojis);
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
  const currentContext = `Guild: ${guildId} | Channel: ${channelId}\n${currentLocalContext(guildConfig.timezone)}`;

  // Thread list for parent channels (bot-participating threads only)
  // Only shown when NOT in a thread
  let threadsInChat = "";
  if (!isThread) {
    const threads = listThreadsForContext(db, channelId);
    threadsInChat = threads
      .map((t) => `- "${t.threadName}" (thread_id: ${t.threadId}) — ${t.messageCount} msgs, ${formatRelativeAgo(t.lastActivityAt)}`)
      .join("\n");
  }

  // Thread metadata and parent pre-context (only when in a thread)
  let threadMetadata: ThreadMetadata | undefined;
  let parentPreContext = "";
  if (isThread) {
    const meta = getThreadMetadata(db, channelId);
    if (meta !== null) {
      threadMetadata = {
        parentChatId: meta.parentChatId,
        threadId: channelId,
        starterMessageId: meta.starterMessageId,
        threadName: meta.threadName,
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
  options: { includeImageGenerationTools?: boolean } = {},
) {
  const includeImageGenerationTools = options.includeImageGenerationTools ?? true;
  const resolveUsername = (username: string): string | undefined => resolveGuildUsername(guild, username);

  const searchTool = createSearchTool({
    db,
    qdrant,
    guildId,
    currentChannelId: channelId,
    timezone: guildConfig.timezone,
    embed: embeddingPipeline,
    resolveUsername,
    excludedMessageIds,
    fetchMessage: async (chId, msgId) => {
      const channel = guild.channels.cache.get(chId);
      if (channel === undefined || !("messages" in channel)) return null;
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

  const memberListTool = createMemberListTool({
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
        });
      }
      return members;
    },
    getMemoryCounts: (gId) => countUserMemoriesByUser(db, gId),
  });

  const userMemoryTool = createUserMemoryTool({
    db,
    guildId,
    resolveUsername: async (username) => {
      const cached = resolveUsername(username);
      if (cached !== undefined) return cached;
      try {
        await guild.members.fetch();
      } catch {
        // Cache-only fallback below handles missing permissions.
      }
      return resolveUsername(username);
    },
  });

  const chatHistoryTool = createChatHistoryTool({
    guildId,
    timezone: guildConfig.timezone,
    fetchMessages: (chatId, limit) => {
      // Validate channel is accessible in guild before querying DB
      const channel = guild.channels.cache.get(chatId);
      if (channel === undefined || !("messages" in channel)) return Promise.resolve([]);
      // Fetch from DB — includes synthetic events (thread creation, etc.)
      return Promise.resolve(getChatHistory(db, guildId, chatId, limit));
    },
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

  const fetchImagesTool = createFetchImagesTool({
    maxImagesPerCall: 5,
    maxDimension: CONTEXT_IMAGE_MAX_DIMENSION,
  });

  const fetchUrlTool = createFetchUrlTool();
  const summarizeVideoTool = createSummarizeVideoTool();

  const tools = [searchTool, ...scheduleTools, memberListTool, userMemoryTool, chatHistoryTool, readChatImagesTool, fetchImagesTool, fetchUrlTool, summarizeVideoTool];
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
      ...(currentRequest === undefined ? {} : { enqueueImageJob: (input) => {
        const result = agentJobs.enqueueImageJob({
          guildId,
          channelId,
          requesterId: currentRequest.requesterId,
          requesterUsername: currentRequest.requesterUsername,
          sourceMessageId: currentRequest.sourceMessageId,
          sourceQuote: currentRequest.sourceQuote,
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
      requesterId: currentRequest?.requesterId ?? "unknown",
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
    const translatedContent = translateInbound(message.content, inboundResolvers);
    const outboundResolvers = buildOutboundResolvers(guild);
    const currentChannelObj = message.channel as TextChannel;
    const resolveTargetChannel = createTargetChannelResolver(guild, currentChannelObj);
    const typing = createTypingController({
      defaultChannel: currentChannelObj,
      resolveTargetChannel,
    });
    const sender = createDiscordMessageSender({
      guildId,
      guild,
      defaultChannel: currentChannelObj,
      outboundResolvers,
      botUserId: client.user?.id ?? "",
      botUsername: client.user?.username ?? "bot",
      logger: log,
      replySourceMessage: message,
      getLastTypingAt: typing.getLastTypingAt,
      imageStore: {
        attachmentsDir: guildConfig.attachmentsDir,
      },
    });

    const ingestedImages = getImagesByMessageId(db, message.id);
    const now = Date.now();
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
      captions: ingestedImages.map((img) => img.caption).filter((c): c is string => c !== null),
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
          };
        } catch { return null; }
      },
      enqueueEmbedding: async (id, text, metadata) => {
        await embeddingQueue.enqueue({ id, text, target: "message", metadata });
      },
      processImage: async (url, contentType, messageId) => {
        const ingestDeps: ImageIngestDeps = {
          db,
          attachmentsDir: guildConfig.attachmentsDir,
          maxDimension: guildConfig.imageMaxDimension,
          fetchFn: fetch,
        };
        await processAndStoreImage(ingestDeps, { url, mimeType: contentType, messageId, guildId, channelId });
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
          parentChatId: channelId,
          starterMessageId: message.id,
        };
      },
      persistThread: (input) => insertThread(db, input),
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
            channelId: payload.parentChatId,
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
      ),
      startThreadTool,
    ];

    const incoming: IncomingMessage = {
      content: message.content,
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
    };

    const requestLog = new RequestLog(guildId, channelId);
    requestLog.setAuthor(message.author.username);

    const { ttsEnabled, generateSpeech } = createTtsGenerator(guildConfig);

    const deps: HandlerDeps = {
      globalConfig,
      guildConfig,
      context,
      personaPrompt: persona,
      sender,
      extraTools,
      log: log.child({ guildId, channelId, requestId: requestLog.requestId }),
      onTriggered: () => { typing.startLoop(); },
      onStillWorking: (targetChatId) => { typing.startLoop(targetChatId); },
      onVisibleOutput: typing.stopLoop,
      onAgentEnd: typing.stopLoop,
      requestLog,
      ttsEnabled,
      generateSpeech,
      consumeGeneratedAttachments: generatedImages.consumeGeneratedAttachments,
      triggerOverride,
      triggerInstructions: guildConfig.triggerInstructions,
      modelImageInputSupport: getModelImageInputSupport(guildConfig),
      afterReply: async (memoryRequest) => {
        const memoryLog = new RequestLog(guildId, channelId);
        memoryLog.setAuthor(message.author.username);
        memoryLog.setTrigger({ type: "background_memory_extraction", sourceRequestId: requestLog.requestId });
        memoryLog.setAgentRan(true);
        requestLogStore.incrementActive();
        const recordMemoryTool = createRecordMemoryTool({
          db,
          guildId,
          currentUserId: message.author.id,
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
    const translatedContent = translateInbound(message.content, inboundResolvers);

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
      updateThreadActivity(db, channelId, {
        lastActivityAt: now,
        lastMessageId: message.id,
      });
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
          { url: attachment.url, mimeType: contentType, messageId: message.id, guildId, channelId },
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

      // Infer MIME type from URL; default to image/png
      const mimeGuess = embedUrl.includes(".gif") ? "image/gif"
                      : embedUrl.includes(".webp") ? "image/webp"
                      : "image/png";

      imageIngestPromises.push(
        processAndStoreImage(ingestDeps, {
          url: embedUrl,
          mimeType: mimeGuess,
          messageId: message.id,
          guildId,
          channelId,
        }).then(() => undefined).catch((err: unknown) => {
          log.warn("embed image ingest failed", {
            embedUrl,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
    }

    await Promise.allSettled(imageIngestPromises);

    // Dispatch to handler: use channel dispatcher if enabled, otherwise call directly
    if (guildConfig.dispatcher.enabled) {
      const triggerResult = evaluateMessageTrigger(message, guildConfig);
      if (triggerResult?.reason === "keyword" || triggerResult?.reason === "mention") sendTypingForMessage(message);
      getOrCreateDispatcher(guildId).enqueue(message, {
        authorId: message.author.id,
        triggerResult,
      });
    } else {
      await processTriggeredMessage(message);
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

    // Delete message from DB
    const result = db.raw
      .prepare("DELETE FROM messages WHERE id = ? AND guild_id = ?")
      .run(messageId, guildId) as { changes: number };

    if (result.changes === 0) return; // Not in DB

    // Delete Qdrant point
    await deletePoint(qdrant, messageId);

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
