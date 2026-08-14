import { RequestLog, type Logger } from "../logger";
import { type requestLogStore } from "../dashboard/store";
import { type loadGlobalConfig } from "../config/loader";
import type { GuildConfig } from "../config/types";
import { channelDisplayName, createTargetChannelResolver, createTypingController, isSendableGuildChannel, type SendableGuildChannel } from "../discord/message-sender";
import { handleMessage } from "../agent/handler";
import { type IncomingMessage, type MessageSender } from "../agent/turn-types";
import { type HistoryMessage } from "../agent/history-types";
import { loadExternalImage } from "../agent/external-image";
import { createCodexGenerateImageTool, type ReferenceImageInput } from "../agent/codex-image-tool";
import { type AgentJobStore, isActiveJobStatus, type ImageGenerationJobResult } from "../agent/job-runtime";
import { buildAsyncImageReadyMetadata, createGeneratedImageRuntime, imageReferencesForToolInput, renderImageGenerationInput, renderImageGenerationRunContext } from "../agent/generated-image-runtime";
import { loadAssetReferenceImage, loadStagedAssetReferenceImage, resolvedLinkReferenceImage } from "../agent/asset-reference-image";
import { type LinkContentCache, resolveLinkContent } from "../agent/link-content.ts";
import { resolveModelProfile } from "../llm/client";
import { getAssetById } from "../db/asset-repository";
import { getStagedAsset, getStagedAssetForJob } from "../db/staged-asset-repository";
import { dashboardTriggerLocation } from "../dashboard/management-runtime";
import { type PromptBundle } from "../config/instruction-bundle";
import { createDiscordReplyFallbackDeps } from "../discord/reply-fallback-runtime";
import { createDiscordAssetSourceResolver } from "../discord/asset-resolver";
import { DEFAULT_ASSET_READING, DEFAULT_EXTERNAL_IMAGES } from "../config/defaults";
import { join } from "path";
import type { Database } from "../db/database";
import { type Client, type Guild, type GuildMember, type Message, type TextChannel, type ThreadChannel } from "discord.js";
import type { createContextRuntime } from "./context-runtime";
import type { createMaintenanceRuntime } from "./maintenance-runtime";
import type { createToolRuntime } from "./tool-runtime";
import type { createTurnRuntime } from "./turn-runtime";
import { stageGeneratedImage } from "./generated-image-staging.ts";

export function createImageJobRuntime(input: {
  db: Database;
  client: Client;
  log: Logger;
  requestLogStore: typeof requestLogStore;
  agentJobs: AgentJobStore;
  linkContentCache: LinkContentCache;
  getGlobalConfig: () => ReturnType<typeof loadGlobalConfig>;
  getPromptBundle: () => PromptBundle;
  getGuildConfig: (guildId: string) => GuildConfig;
  runtimeContextTemplate: (name: string, variables?: Record<string, string | number | boolean | undefined>, fallback?: string) => string;
  buildContext: ReturnType<typeof createContextRuntime>["buildContext"];
  getBuildAgentTools: () => ReturnType<typeof createToolRuntime>["buildAgentTools"];
  blockToolsExcept: ReturnType<typeof createMaintenanceRuntime>["blockToolsExcept"];
  createPostReplyMaintenanceTools: ReturnType<typeof createMaintenanceRuntime>["createPostReplyMaintenanceTools"];
  runMemoryPostReplyExtraction: ReturnType<typeof createMaintenanceRuntime>["runMemoryPostReplyExtraction"];
  runRelationshipPostReplyExtraction: ReturnType<typeof createMaintenanceRuntime>["runRelationshipPostReplyExtraction"];
  runInnerThreadPostReplyExtraction: ReturnType<typeof createMaintenanceRuntime>["runInnerThreadPostReplyExtraction"];
  runPostReplyMaintenanceBurst: ReturnType<typeof createMaintenanceRuntime>["runPostReplyMaintenanceBurst"];
  createBotDiscordMessageSender: ReturnType<typeof createTurnRuntime>["createBotDiscordMessageSender"];
  createTtsGenerator: ReturnType<typeof createTurnRuntime>["createTtsGenerator"];
  createHandlerDeps: ReturnType<typeof createTurnRuntime>["createHandlerDeps"];
  createAssetAttachmentResolver: ReturnType<typeof createTurnRuntime>["createAssetAttachmentResolver"];
  persistIgnoredBotReply: ReturnType<typeof createTurnRuntime>["persistIgnoredBotReply"];
  fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
  resolveGuildMemberReference: (guild: Guild, reference: string) => Promise<GuildMember | undefined>;
  noteAmbientBotReply: (input: { guildId: string; channelId: string; userId: string; sourceMessageId: string; botMessageId: string; allowLease: boolean; allowFollowUp: boolean }) => void;
  enqueueChannelTask: (guildId: string, channelId: string, task: () => Promise<void>) => Promise<void>;
  resumeAgentJob: (jobId: string) => void;
}) {
  const { db, client, log, requestLogStore, agentJobs, linkContentCache, getGlobalConfig, getPromptBundle, getGuildConfig, runtimeContextTemplate, buildContext, getBuildAgentTools, blockToolsExcept, createPostReplyMaintenanceTools, runPostReplyMaintenanceBurst, createBotDiscordMessageSender, createTtsGenerator, createHandlerDeps, createAssetAttachmentResolver, persistIgnoredBotReply, fetchAccessibleGuildChannel, resolveGuildMemberReference, noteAmbientBotReply, enqueueChannelTask, resumeAgentJob } = input;
function resumeOwner(childJobId: string): void {
  const queued = agentJobs.publishChildResult(childJobId);
  if (queued.shouldRun && queued.parentJobId !== undefined) resumeAgentJob(queued.parentJobId);
}
async function runImageGenerationJob(jobId: string): Promise<void> {
  const job = agentJobs.get(jobId);
  if (job === undefined || job.kind !== "image_generation") return;
  const stagingRoot = process.env.WORKSPACE_STAGING_DIR ?? join(getGlobalConfig().dataDir, "staged-assets");
  const sourceGuildConfig = getGuildConfig(job.guildId);
  const deliveryGuildConfig = getGuildConfig(job.deliveryGuildId);
  const sourceGuild = client.guilds.cache.get(job.guildId);
  const guild = client.guilds.cache.get(job.deliveryGuildId);
  if (guild === undefined) {
    agentJobs.markFailed(job.id, "Delivery guild is unavailable.");
    resumeOwner(job.id);
    return;
  }
  const channel = await client.channels.fetch(job.deliveryChannelId).catch(() => guild.channels.cache.get(job.deliveryChannelId) ?? null);
  if (channel === null || !("send" in channel) || !("sendTyping" in channel)) {
    agentJobs.markFailed(job.id, "Delivery channel is unavailable.");
    resumeOwner(job.id);
    return;
  }
  if (!isSendableGuildChannel(channel)) {
    agentJobs.markFailed(job.id, "Delivery channel is not a supported guild text channel.");
    resumeOwner(job.id);
    return;
  }
  const textChannel = channel;
  const typing = createTypingController({
    defaultChannel: textChannel,
    resolveTargetChannel: createTargetChannelResolver(client, textChannel),
  });
  if (job.parentJobId === undefined) typing.startLoop();
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Image job ${job.id} timed out after ${getGlobalConfig().agentJobs.imageTimeoutMs}ms`));
  }, getGlobalConfig().agentJobs.imageTimeoutMs);
  const requestLog = new RequestLog(job.deliveryGuildId, job.deliveryChannelId, requestLogStore);
  requestLog.setAuthor(job.requesterUsername);
  requestLog.setTriggerContext({
    ...dashboardTriggerLocation(guild, textChannel),
    authorUsername: job.requesterUsername,
    sourceMessageId: job.sourceMessageId,
    sourceQuote: job.sourceQuote,
  });
  const dashboardTrigger = {
    type: "image_generation_job",
    jobId: job.id,
    ...(job.parentJobId !== undefined ? { parentJobId: job.parentJobId } : {}),
    sourceMessageId: job.sourceMessageId,
  };
  requestLog.setTrigger(dashboardTrigger);
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
      {
        appendLatestToHistory: false,
        additionalVisibleUserIds: [job.requesterId],
        memoryFocusUserId: job.requesterId,
      },
    );
    const extraTools = getBuildAgentTools()(
      job.deliveryGuildId,
      job.deliveryChannelId,
      deliveryGuildConfig,
      guild,
      context.contextMessageIds,
      undefined,
      undefined,
      {
        includeImageGenerationTools: true,
        currentRequest: {
          requesterId: job.requesterId,
          requesterUsername: job.requesterUsername,
          sourceMessageId: job.sourceMessageId,
          sourceQuote: job.sourceQuote,
        },
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
      mentionedRoleIds: [],
      botRoleIds: [],
      mentionedEveryone: false,
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
          await runPostReplyMaintenanceBurst({
            guildConfig: deliveryGuildConfig,
            memoryRequest,
            guild,
            channel: textChannel,
            sourceRequestId: requestLog.requestId,
            source: `async_image_${input.event}`,
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

  const runReadyImageStatusTurn = async (): Promise<string | undefined> => {
    let sentMessageId: string | undefined;
    await enqueueChannelTask(job.deliveryGuildId, job.deliveryChannelId, async () => {
      // A prior serialized turn can deliver this staged output while its own
      // completion turn is still queued. Do not give the model a stale event.
      const current = agentJobs.get(job.id);
      if (current?.kind !== "image_generation" || current.status !== "ready") return;
      const staged = getStagedAssetForJob(db, current.id);
      if (staged === null) {
        agentJobs.markFailed(current.id, "Ready job has no durable staged asset.");
        return;
      }
      const result = current.result;
      const readyMetadata = buildAsyncImageReadyMetadata({
        requestedSize: result?.requestedSize,
        requestedFormat: current.input.outputFormat,
        actualSize: result?.actualSize,
        actualContentType: result?.contentType ?? staged.contentType,
        byteSize: result?.byteSize ?? Bun.file(staged.storagePath).size,
        transport: result?.transport,
        is4k: result?.is4k ?? current.input.is4k,
      });
      const imageRunContext = renderImageGenerationRunContext(
        current,
        current.input.generationRunId === undefined
          ? [current]
          : agentJobs.listImageGenerationRun(current.input.generationRunId),
      );
      const completionInstruction = runtimeContextTemplate("async-image-ready", {
        jobId: current.id,
        stagedAssetRef: staged.ref,
        workspacePath: result?.workspacePath ?? staged.storagePath,
        requesterUsername: current.requesterUsername,
        requesterId: current.requesterId,
        ...readyMetadata,
        sourceMessageId: current.sourceMessageId,
        sourceQuote: current.sourceQuote,
        generationInput: renderImageGenerationInput(current.input),
        revisedPromptLine: result?.revisedPrompt !== undefined ? `Revised prompt: ${result.revisedPrompt}\n` : "",
        imageRunContextLine: imageRunContext === "" ? "" : `${imageRunContext}\n\n`,
        deliveryGuildId: current.deliveryGuildId,
        deliveryChannelId: current.deliveryChannelId,
      }, [
        `[Async Image Job Ready] Job ${current.id} generated an image.`,
        `Staged asset ref: ${staged.ref}.`,
        `Workspace path: ${result?.workspacePath ?? staged.storagePath}.`,
        imageRunContext,
        `Original requester: @${current.requesterUsername} (${current.requesterId}).`,
        `Source: guild ${current.guildId}, channel ${current.channelId}, MsgID ${current.sourceMessageId}; quote: ${JSON.stringify(current.sourceQuote)}.`,
        `Intended delivery room: guild ${current.deliveryGuildId}, channel ${current.deliveryChannelId}.`,
        "You may inspect, use, deliver, or postpone the current image. Related jobs have separate completion turns unless they are delivered first.",
      ].filter((line) => line !== "").join("\n"));
      sentMessageId = await runAsyncImageStatusTurn({
        event: "ready",
        instruction: completionInstruction,
      });
      agentJobs.markReadyNotificationHandled(current.id, current.statusChangedAt);
    });
    return sentMessageId;
  };

  try {
    if (job.status === "ready") {
      if (job.parentJobId !== undefined) {
        resumeOwner(job.id);
        return;
      }
      await runReadyImageStatusTurn();
      return;
    }
    const started = agentJobs.start(job.id, () => controller.abort(new Error(`Image job ${job.id} cancelled.`)));
    if (started?.status !== "running") return;
    const generated = createGeneratedImageRuntime();
    const imageProfile = resolveModelProfile(
      getGlobalConfig(),
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
      codexAuthPath: getGlobalConfig().codexAuthPath,
      model: imageProfile.model,
      sessionId: `2b2v-image-job:${job.guildId}:${job.channelId}:${job.deliveryGuildId}:${job.deliveryChannelId}:${job.id}`,
      logger: log.child({ component: "async-image-job", guildId: job.deliveryGuildId, channelId: job.deliveryChannelId, sourceGuildId: job.guildId, sourceChannelId: job.channelId, jobId: job.id }),
      imageReferenceMaxPerCall: sourceGuildConfig.imageReferenceMaxPerCall,
      imageGenerationQuality: sourceGuildConfig.imageGeneration.quality,
      asyncJobAlreadyActiveTemplate: getPromptBundle().runtime.contextTemplates["codex-image-job-existing"],
      asyncJobStartedTemplate: getPromptBundle().runtime.contextTemplates["codex-image-job-started"],
      resolveReferenceImage: async (id) => {
        if (typeof id === "string") {
          const staged = getStagedAsset(db, id);
          return staged === null
            ? null
            : await loadStagedAssetReferenceImage({
                asset: staged,
                maxBytes: sourceGuildConfig.assetReading?.maxDownloadBytes
                  ?? DEFAULT_ASSET_READING.maxDownloadBytes,
                stagingRoot,
              });
        }
        const asset = getAssetById(db, id);
        if (asset === null) return null;
        const source = await jobAssetSource(asset);
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
    const outboundAttachment = attachment;
    const stagedRef = `job_${job.id.replace(/[^A-Za-z0-9]/g, "")}`;
    const staged = await stageGeneratedImage({
      db,
      stagingRoot,
      ref: stagedRef,
      jobId: job.id,
      ownerGuildId: job.deliveryGuildId,
      ownerChannelId: job.deliveryChannelId,
      attachment: outboundAttachment,
    });
    agentJobs.markReady(job.id, {
      stagedAssetRef: stagedRef,
      workspacePath: staged.workspacePath,
      attachmentId: outboundAttachment.id,
      filename: staged.filename,
      contentType: outboundAttachment.contentType,
      byteSize: outboundAttachment.buffer.length,
      is4k: job.input.is4k,
      ...(details?.transport !== undefined ? { transport: details.transport } : {}),
      ...(details?.requestedSize !== undefined ? { requestedSize: details.requestedSize } : {}),
      ...(details?.actualSize !== undefined ? { actualSize: details.actualSize } : {}),
      ...(typeof details?.revisedPrompt === "string" ? { revisedPrompt: details.revisedPrompt } : {}),
    } satisfies ImageGenerationJobResult);
    if (job.parentJobId !== undefined) {
      resumeOwner(job.id);
      return;
    }

    const sentMessageId = await runReadyImageStatusTurn();
    if (sentMessageId !== undefined && agentJobs.get(job.id)?.status === "delivered") {
      noteAmbientBotReply({
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
    if (job.parentJobId !== undefined) {
      resumeOwner(job.id);
      return;
    }
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
        await enqueueChannelTask(job.deliveryGuildId, job.deliveryChannelId, async () => {
          await runAsyncImageStatusTurn({
            event: "failed",
            instruction: failureInstruction,
          });
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
    requestLog.setTrigger({ ...dashboardTrigger, status: agentJobs.get(job.id)?.status ?? "missing" });
    requestLog.emit(log);
    requestLogStore.decrementActive();
  }
}


async function loadExternalReference(url: string, signal?: AbortSignal): Promise<ReferenceImageInput> {
  const image = await loadExternalImage(url, getGlobalConfig().externalImages ?? DEFAULT_EXTERNAL_IMAGES, {}, signal);
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


  return { runImageGenerationJob, loadExternalReference, loadGuildAvatarReference };
}
