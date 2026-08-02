import { type RequestLog, type Logger } from "../logger";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type loadGlobalConfig } from "../config/loader";
import type { GuildConfig } from "../config/types";
import { type OutboundResolvers } from "../discord/translation";
import { createDiscordMessageSender, fetchAccessibleGuildChannel as fetchAccessibleDiscordGuildChannel, type SendableGuildChannel } from "../discord/message-sender";
import { handleMessage } from "../agent/handler";
import { type HandleResult, type AssetAttachmentResolver, type IncomingMessage, type HandlerDeps, type MessageSender } from "../agent/turn-types";
import { DispatchSupersededError } from "../discord/channel-dispatcher";
import { type AssembledContext } from "../agent/context-assembly";
import { PRIVATE_THOUGHT_MESSAGE_ID_PREFIX } from "../agent/history-types";
import { insertPromptOnlyBotMessage } from "../db/message-state-repository";
import { normalizeWhitespace } from "../agent/history-trimming";
import { type ElevenLabsClient } from "../tts/client";
import type { TtsResult } from "../tts/types";
import { type AgentJobStore } from "../agent/job-runtime";
import { type GeneratedImageRuntime } from "../agent/generated-image-runtime";
import { createStoredAssetAttachmentResolver } from "../agent/stored-asset-attachments";
import { type LinkContentCache, resolveLinkContent } from "../agent/link-content.ts";
import { type createModelImageSupportStore } from "../llm/model-image-support";
import { getAssetsByMessageId } from "../db/asset-repository";
import { getStagedAsset, reconcileStagedAsset } from "../db/staged-asset-repository";
import { type PromptBundle } from "../config/instruction-bundle";
import { createDiscordAssetSourceResolver } from "../discord/asset-resolver";
import { type AsyncTaskTracker } from "../runtime/async-task-tracker";
import { DEFAULT_ASSET_READING, DEFAULT_EXTERNAL_IMAGES } from "../config/defaults";
import { unlinkStagedPath } from "./staged-path.ts";
import type { Database } from "../db/database";
import { type Client, type Guild, type TextChannel, type ThreadChannel } from "discord.js";

export function createTurnRuntime(input: {
  db: Database;
  client: Client;
  log: Logger;
  agentJobs: AgentJobStore;
  linkContentCache: LinkContentCache;
  backgroundTasks: AsyncTaskTracker;
  modelImageSupport: ReturnType<typeof createModelImageSupportStore>;
  ttsClient?: ElevenLabsClient;
  getGlobalConfig: () => ReturnType<typeof loadGlobalConfig>;
  getPromptBundle: () => PromptBundle;
  buildOutboundResolvers: (guild: Guild) => OutboundResolvers;
  noteVisiblePersonaTurn: (guildId: string) => void;
}) {
  const { db, client, log, agentJobs, linkContentCache, backgroundTasks, modelImageSupport, ttsClient, getGlobalConfig, getPromptBundle, buildOutboundResolvers, noteVisiblePersonaTurn } = input;
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

function persistPrivateThoughts(input: {
  guildId: string;
  channelId: string;
  botUserId: string;
  botUsername: string;
  sourceMessageId: string;
  requestId: string;
  thoughts: string[];
  maxChars: number;
}): void {
  const text = input.thoughts
    .map(normalizeWhitespace)
    .filter((thought) => thought !== "")
    .join("\n\n");
  if (text === "") return;
  const content = text.length > input.maxChars
    ? `${text.slice(0, input.maxChars)}…`
    : text;
  insertPromptOnlyBotMessage(db, {
    id: `${PRIVATE_THOUGHT_MESSAGE_ID_PREFIX}${input.requestId}`,
    guildId: input.guildId,
    channelId: input.channelId,
    botUserId: input.botUserId,
    botUsername: input.botUsername,
    content: `<thoughts>${content}</thoughts>`,
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
        if (permanent !== undefined && staged.jobId !== undefined) agentJobs.linkAsset(staged.jobId, permanent.id);
        const job = staged.jobId === undefined ? undefined : agentJobs.get(staged.jobId);
        if (job?.status === "ready" && staged.jobId !== undefined) {
          agentJobs.markDelivered(staged.jobId, delivery.messageId, {
            ...(job.result ?? {}),
            stagedAssetRef: ref,
          });
        }
        const stagingRoot = process.env.WORKSPACE_STAGING_DIR ?? `${getGlobalConfig().dataDir}/staged-assets`;
        await unlinkStagedPath(stagingRoot, staged.storagePath).catch((error: unknown) => {
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
  if (ttsClient === undefined || guildConfig.tts?.enabled !== true) {
    return { ttsEnabled: false };
  }
  const ttsEnabled = true;
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
    globalConfig: getGlobalConfig(),
    guildConfig: input.guildConfig,
    context: input.context,
    currentChannelId: input.currentChannelId,
    systemPrompt: getPromptBundle().systemPrompt,
    personaPrompt: getPromptBundle().corePrompt,
    runtimePrompts: getPromptBundle().runtime,
    sender: input.sender,
    extraTools: input.extraTools,
    log: input.log,
    requestLog: input.requestLog,
    modelImageInputSupport: modelImageSupport.get(
      getGlobalConfig(),
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
      noteVisiblePersonaTurn(input.guildId);
    },
  };
}

function createAssetAttachmentResolver(guildId: string, guildConfig: GuildConfig, logger: Logger): AssetAttachmentResolver {
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
    stagedGuildId: guildId,
    stagedRoot: process.env.WORKSPACE_STAGING_DIR ?? `${getGlobalConfig().dataDir}/staged-assets`,
    maxDownloadBytes: guildConfig.assetReading?.maxDownloadBytes ?? DEFAULT_ASSET_READING.maxDownloadBytes,
    resolveSource,
    resolveLink: async (input, signal) => await resolveLinkContent({
      cache: linkContentCache,
      externalImages: getGlobalConfig().externalImages ?? DEFAULT_EXTERNAL_IMAGES,
    }, input, signal),
    canSendSticker: async (stickerId) => {
      const guild = client.guilds.cache.get(guildId);
      if (guild === undefined) return false;
      const sticker = await guild.stickers.fetch(stickerId).catch(() => null);
      return sticker !== null && sticker.available !== false;
    },
    logger,
  });
}

async function runLoggedAgentTurn(input: {
  incoming: IncomingMessage;
  deps: HandlerDeps;
  requestLog: RequestLog;
  logger: Logger;
  afterSuccess?: (result: HandleResult) => void | Promise<void>;
  onFinally?: (result: HandleResult | undefined, error: unknown) => void;
  dashboardTrigger?: unknown;
}): Promise<HandleResult> {
  let result: HandleResult | undefined;
  let error: unknown;
  try {
    result = await handleMessage(input.incoming, input.deps);
    await input.afterSuccess?.(result);
    return result;
  } catch (err) {
    error = err;
    if (!(err instanceof DispatchSupersededError)) {
      input.requestLog.setError(err instanceof Error ? err.message : String(err));
    }
    throw err;
  } finally {
    input.onFinally?.(result, error);
    if (result !== undefined) {
      input.requestLog.setTrigger(input.dashboardTrigger ?? result.triggerResult);
      input.requestLog.setAgentRan(result.agentRan);
    }
    input.requestLog.emit(input.logger);
  }
}

  return { persistIgnoredBotReply, persistPrivateThoughts, createBotDiscordMessageSender, resolveClientGuild, fetchAccessibleGuildChannel, createTtsGenerator, createHandlerDeps, createAssetAttachmentResolver, runLoggedAgentTurn };
}
