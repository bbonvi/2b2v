import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Client, Guild } from "discord.js";
import { RequestLog, type Logger } from "../logger.ts";
import { type requestLogStore } from "../dashboard/store.ts";
import type { Database } from "../db/database.ts";
import { createStagedAsset } from "../db/staged-asset-repository.ts";
import { createSyntheticReplyFallbackDeps } from "../discord/reply-fallback-runtime.ts";
import { channelDisplayName, createTargetChannelResolver, type SendableGuildChannel } from "../discord/message-sender.ts";
import type { loadGlobalConfig } from "../config/loader.ts";
import type { GuildConfig } from "../config/types.ts";
import type { PromptBundle } from "../config/instruction-bundle.ts";
import { applyRuntimeToolPrompts } from "./runtime-tool-prompts.ts";
import { createLoadSkillTool } from "./load-skill-tool.ts";
import { createSearchToolsTool } from "./tool-catalog.ts";
import { runSilentToolAgentPass } from "./maintenance-pass.ts";
import { buildRuntimeInstruction } from "./turn-prompt.ts";
import { createGeneratedImageRuntime } from "./generated-image-runtime.ts";
import { parseResponseDirectives } from "./response-directives.ts";
import { sendResponseSegments } from "./response-delivery.ts";
import type { HistoryMessage } from "./history-types.ts";
import type { IncomingMessage, MessageSender, OutboundAttachment } from "./turn-types.ts";
import type { AgentJobStore, AgentTaskJob } from "./job-runtime.ts";
import { AssetRefSchema, type AssetRef } from "./asset-id.ts";
import type { OpenRouterMessage } from "../llm/types.ts";
import type { createContextRuntime } from "./context-runtime.ts";
import type { createToolRuntime } from "./tool-runtime.ts";
import type { createTurnRuntime } from "./turn-runtime.ts";
import { ensureStagedDirectory } from "./staged-path.ts";

const WORKSPACE_AGENT_TOOL_NAMES = new Set([
  "export_asset_to_workspace",
  "fetch_images",
  "fetch_url",
  "read_asset",
  "search_images",
  "stage_workspace_file",
  "web_search",
  "workspace_exec",
]);

const SendDiscordMessageParams = Type.Object({
  content: Type.Optional(Type.String()),
  channel_id: Type.Optional(Type.String()),
  asset_ids: Type.Optional(Type.Array(AssetRefSchema, { maxItems: 10 })),
});

export function createAgentTaskRuntime(input: {
  db: Database;
  client: Client;
  log: Logger;
  requestLogStore: typeof requestLogStore;
  agentJobs: AgentJobStore;
  getGlobalConfig: () => ReturnType<typeof loadGlobalConfig>;
  getPromptBundle: () => PromptBundle;
  getGuildConfig: (guildId: string) => GuildConfig;
  buildContext: ReturnType<typeof createContextRuntime>["buildContext"];
  buildAgentTools: ReturnType<typeof createToolRuntime>["buildAgentTools"];
  createBotDiscordMessageSender: ReturnType<typeof createTurnRuntime>["createBotDiscordMessageSender"];
  createAssetAttachmentResolver: ReturnType<typeof createTurnRuntime>["createAssetAttachmentResolver"];
  fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
  enqueueChannelTask: (guildId: string, channelId: string, task: () => Promise<void>) => Promise<void>;
}) {
  const {
    db, client, log, requestLogStore, agentJobs, getGlobalConfig, getPromptBundle,
    getGuildConfig, buildContext, buildAgentTools, createBotDiscordMessageSender,
    createAssetAttachmentResolver, fetchAccessibleGuildChannel, enqueueChannelTask,
  } = input;
  let workspaceQueue = Promise.resolve();

  function runAgentJob(jobId: string): Promise<void> {
    const job = agentJobs.get(jobId);
    if (job?.kind !== "workspace_agent") return executeAgentJob(jobId);
    const task = workspaceQueue.then(async () => await executeAgentJob(jobId));
    workspaceQueue = task.catch(() => {});
    return task;
  }

  async function executeAgentJob(jobId: string): Promise<void> {
    const job = agentJobs.get(jobId);
    if (job === undefined || job.kind === "image_generation" || job.status !== "queued") return;
    const controller = new AbortController();
    const started = agentJobs.start(job.id, () => controller.abort(new Error(`Agent ${jobId} was cancelled.`)));
    if (started?.status !== "running" || started.kind === "image_generation") return;
    const taskJob = started;
    const requestLog = new RequestLog(taskJob.guildId, taskJob.channelId, requestLogStore);
    const trigger = {
      type: "async_agent_task",
      jobId: taskJob.id,
      kind: taskJob.kind,
      taskName: taskJob.input.taskName,
      status: "running",
      standalone: true,
    };
    requestLog.setAuthor(taskJob.requesterUsername);
    requestLog.setTriggerContext({
      authorUsername: taskJob.requesterUsername,
      content: taskJob.input.message,
      sourceMessageId: taskJob.sourceMessageId,
      sourceQuote: taskJob.sourceQuote,
    });
    requestLog.setTrigger(trigger);
    requestLog.setAgentRan(true);
    requestLogStore.incrementActive();
    try {
      const runtime = await prepareRun(taskJob, taskJob.kind === "persona_task", controller.signal);
      requestLog.setTriggerContext({
        guildName: runtime.incoming.guildName,
        channelName: runtime.incoming.channelName,
        authorUsername: taskJob.requesterUsername,
        content: taskJob.input.message,
        sourceMessageId: taskJob.sourceMessageId,
        sourceQuote: taskJob.sourceQuote,
      });
      const pendingAttachments: OutboundAttachment[] = [];
      const previousTranscript = taskJob.result?.transcript as OpenRouterMessage[] | undefined;
      const result = await runSilentToolAgentPass({
        globalConfig: getGlobalConfig(),
        guildConfig: longRunningConfig(runtime.guildConfig),
        context: runtime.context,
        systemPrompt: taskJob.kind === "persona_task" ? getPromptBundle().systemPrompt : workspaceSystemPrompt(),
        personaPrompt: taskJob.kind === "persona_task" ? getPromptBundle().corePrompt : "",
        runtimePrompts: getPromptBundle().runtime,
        incomingMessage: runtime.incoming,
        userContent: taskJob.input.message,
        assistantReply: taskJob.result?.handoff ?? "",
        visibleReplySent: false,
        tools: runtime.tools,
        runtimeInstruction: buildRuntimeInstruction(getPromptBundle().runtime),
        controlMessage: agentControlMessage(taskJob),
        modelProfile: taskJob.input.modelProfile,
        maxToolCalls: 64,
        transcript: previousTranscript,
        requestLog,
        log: log.child({ component: "agent-task", jobId: taskJob.id, kind: taskJob.kind }),
        signal: controller.signal,
        takePendingMessages: () => agentJobs.takePendingAgentMessages(jobId),
        consumeGeneratedAttachments: runtime.generatedImages.consumeGeneratedAttachments,
        pendingAttachments,
      });
      const stagedRefs = await stageGeneratedAttachments(taskJob, pendingAttachments);
      const joinedHandoff = [
        result.text.trim(),
        stagedRefs.length > 0 ? `Staged outputs: ${stagedRefs.join(", ")}` : "",
      ].filter((part) => part !== "").join("\n\n");
      const handoff = joinedHandoff !== "" ? joinedHandoff : "Task finished without a handoff note.";
      agentJobs.markYielded(taskJob.id, { handoff, transcript: result.transcript });
      requestLog.setTrigger({ ...trigger, status: "yielded" });
      if (agentJobs.requeueYieldedAgentWithPendingMessages(taskJob.id)) {
        await executeAgentJob(taskJob.id);
        return;
      }
      await notifyPrimary(taskJob.id).catch((error: unknown) => {
        log.warn("agent handoff notification failed", {
          jobId: taskJob.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const dismissed = agentJobs.get(taskJob.id)?.status === "dismissed";
      requestLog.setError(message);
      requestLog.setTrigger({ ...trigger, status: dismissed ? "dismissed" : "failed" });
      if (!dismissed) {
        agentJobs.markAgentFailed(taskJob.id, message);
        await notifyPrimary(taskJob.id).catch((notifyError: unknown) => {
          log.warn("agent failure notification failed", {
            jobId: taskJob.id,
            error: notifyError instanceof Error ? notifyError.message : String(notifyError),
          });
        });
      }
    } finally {
      requestLog.emit(log);
      requestLogStore.decrementActive();
    }
  }

  async function prepareRun(job: AgentTaskJob, personaRun: boolean, signal: AbortSignal) {
    const guild = client.guilds.cache.get(job.guildId);
    if (guild === undefined) throw new Error(`Guild ${job.guildId} is unavailable.`);
    const channel = await fetchAccessibleGuildChannel(job.channelId);
    if (channel === null) throw new Error(`Channel ${job.channelId} is unavailable.`);
    const guildConfig = getGuildConfig(job.guildId);
    const sender = createBotDiscordMessageSender({
      defaultChannel: channel,
      resolveTargetChannel: createTargetChannelResolver(client, channel),
      botUserId: client.user?.id ?? "",
      botUsername: client.user?.username ?? "bot",
      logger: log,
    });
    const latest = syntheticHistory(job, client.user?.id ?? "", client.user?.username ?? "bot");
    const context = personaRun
      ? await buildContext(
          job.guildId,
          job.channelId,
          guild,
          guildConfig,
          job.input.message,
          latest,
          createSyntheticReplyFallbackDeps({ db, guildId: job.guildId, channelId: job.channelId }),
          channel.isThread(),
          undefined,
          "live",
          undefined,
          { appendLatestToHistory: false },
        )
      : {
          sections: [{
            label: "Workspace Agent",
            text: "Private technical task. Work only through the private workspace and return a concise factual handoff.",
            cached: false,
            role: "developer" as const,
          }],
          userMessage: job.input.message,
        };
    const incoming = syntheticIncoming(job, guild, channel, client.user?.id ?? "", client.user?.username ?? "bot");
    const generatedImages = createGeneratedImageRuntime();
    const operational = buildAgentTools(
      job.guildId,
      job.channelId,
      guildConfig,
      guild,
      context.contextMessageIds,
      generatedImages.onGeneratedImage,
      {
        requesterId: job.requesterId,
        requesterUsername: job.requesterUsername,
        sourceMessageId: job.sourceMessageId,
        sourceQuote: job.sourceQuote,
      },
      { forceSynchronousImageGeneration: true, onVisibleOutput: () => {} },
    );
    const resolveAssets = createAssetAttachmentResolver(job.guildId, guildConfig, log);
    const visibleTool = personaRun
      ? [createSendDiscordMessageTool({ sender, resolveAssets, signal })]
      : [];
    const selected = personaRun
      ? [...operational, ...visibleTool]
      : operational.filter((tool) => WORKSPACE_AGENT_TOOL_NAMES.has(tool.name));
    const loaders = applyRuntimeToolPrompts([
      createSearchToolsTool({ tools: selected, skills: getPromptBundle().runtime.skills }),
      createLoadSkillTool({ skills: getPromptBundle().runtime.skills }),
    ], getPromptBundle().runtime);
    return { guildConfig, context, incoming, tools: [...loaders, ...selected], generatedImages, sender, resolveAssets };
  }

  async function notifyPrimary(jobId: string): Promise<void> {
    const job = agentJobs.get(jobId);
    if (job === undefined || job.kind === "image_generation" || (job.status !== "yielded" && job.status !== "failed") || job.result?.notificationPending !== true) return;
    await enqueueChannelTask(job.guildId, job.channelId, async () => {
      const current = agentJobs.get(jobId);
      if (current === undefined || current.kind === "image_generation" || current.result?.notificationPending !== true) return;
      const completionTime = current.completedAt;
      if (completionTime === undefined) return;
      const requestLog = new RequestLog(current.guildId, current.channelId, requestLogStore);
      const trigger = {
        type: "async_agent_handoff",
        jobId: current.id,
        kind: current.kind,
        taskName: current.input.taskName,
        status: "running",
        standalone: true,
      };
      requestLog.setAuthor(current.requesterUsername);
      requestLog.setTriggerContext({
        authorUsername: current.requesterUsername,
        content: current.result.handoff ?? current.input.message,
        sourceMessageId: current.sourceMessageId,
        sourceQuote: current.sourceQuote,
      });
      requestLog.setTrigger(trigger);
      requestLog.setAgentRan(true);
      requestLogStore.incrementActive();
      try {
        const controller = new AbortController();
        const runtime = await prepareRun(current, true, controller.signal);
        requestLog.setTriggerContext({
          guildName: runtime.incoming.guildName,
          channelName: runtime.incoming.channelName,
          authorUsername: current.requesterUsername,
          content: current.result.handoff ?? current.input.message,
          sourceMessageId: current.sourceMessageId,
          sourceQuote: current.sourceQuote,
        });
        const pendingAttachments: OutboundAttachment[] = [];
        const completion = await runSilentToolAgentPass({
          globalConfig: getGlobalConfig(),
          guildConfig: runtime.guildConfig,
          context: runtime.context,
          systemPrompt: getPromptBundle().systemPrompt,
          personaPrompt: getPromptBundle().corePrompt,
          runtimePrompts: getPromptBundle().runtime,
          incomingMessage: runtime.incoming,
          userContent: current.result.handoff ?? "",
          assistantReply: "",
          visibleReplySent: false,
          tools: runtime.tools,
          runtimeInstruction: buildRuntimeInstruction(getPromptBundle().runtime),
          controlMessage: primaryHandoffControlMessage(current),
          maxToolCalls: runtime.guildConfig.replyLoop.maxToolCalls,
          requestLog,
          log: log.child({ component: "agent-handoff", jobId }),
          consumeGeneratedAttachments: runtime.generatedImages.consumeGeneratedAttachments,
          pendingAttachments,
        });
        const parsed = parseResponseDirectives(completion.text);
        if (!parsed.ignored && parsed.malformedPrivateOutput !== true && parsed.segments.length > 0) {
          await sendResponseSegments({
            sender: runtime.sender,
            ttsEnabled: false,
            segments: parsed.segments,
            replyFirst: false,
            currentChannelId: current.channelId,
            requestLog,
            log,
            pendingAttachments,
            resolveAssetAttachments: runtime.resolveAssets,
          });
        }
        agentJobs.markNotificationDelivered(jobId, completionTime);
        requestLog.setTrigger({ ...trigger, status: "delivered" });
      } catch (error) {
        requestLog.setError(error instanceof Error ? error.message : String(error));
        requestLog.setTrigger({ ...trigger, status: "failed" });
        throw error;
      } finally {
        requestLog.emit(log);
        requestLogStore.decrementActive();
      }
    });
  }

  async function recover(): Promise<void> {
    const rows = db.raw.prepare(
      "SELECT id, status FROM agent_jobs WHERE kind IN ('workspace_agent', 'persona_task') AND status IN ('queued', 'yielded', 'failed') ORDER BY created_at ASC",
    ).all() as Array<{ id: string; status: string }>;
    await Promise.all(rows.map(async (row) => {
      if (row.status === "queued") await runAgentJob(row.id);
      else await notifyPrimary(row.id);
    }));
  }

  async function stageGeneratedAttachments(job: AgentTaskJob, attachments: readonly OutboundAttachment[]): Promise<string[]> {
    const stagingRoot = process.env.WORKSPACE_STAGING_DIR ?? join(getGlobalConfig().dataDir, "staged-assets");
    const refs: string[] = [];
    for (const attachment of attachments) {
      const ref = `agent-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const directory = await ensureStagedDirectory(stagingRoot, ref);
      const filename = basename(attachment.filename);
      const storagePath = join(directory, filename);
      await Bun.write(storagePath, attachment.buffer);
      const now = Date.now();
      createStagedAsset(db, {
        ref,
        ownerGuildId: job.guildId,
        ownerChannelId: job.channelId,
        filename,
        contentType: attachment.contentType,
        storagePath,
        createdAt: now,
        expiresAt: now + 7 * 24 * 60 * 60 * 1000,
      });
      refs.push(ref);
    }
    return refs;
  }

  return { runAgentJob, notifyPrimary, recover };
}

function longRunningConfig(config: GuildConfig): GuildConfig {
  return {
    ...config,
    replyLoop: {
      ...config.replyLoop,
      wallClockTimeoutMs: Math.max(config.replyLoop.wallClockTimeoutMs, 30 * 60 * 1000),
      maxToolCalls: Math.max(config.replyLoop.maxToolCalls, 64),
    },
  };
}

function workspaceSystemPrompt(): string {
  return "You are a private technical worker. You have no persona and no social role. Complete the task in the workspace, verify the result, and return a concise factual handoff. Never address Discord users.";
}

function agentControlMessage(job: AgentTaskJob): string {
  return [
    `## Asynchronous ${job.kind === "persona_task" ? "Persona" : "Workspace"} Task`,
    `Task name: ${job.input.taskName}`,
    job.input.message,
    job.kind === "persona_task"
      ? "Ordinary output is a private handoff to your primary instance. Use send_discord_message only when this task explicitly requires a visible Discord action."
      : "Work independently. Return the completed result, verification, important paths, and any blocker.",
  ].join("\n\n");
}

function primaryHandoffControlMessage(job: AgentTaskJob): string {
  return [
    "## Background Agent Handoff",
    `Agent ${job.id} (${job.input.taskName}) yielded:`,
    job.result?.handoff ?? "No handoff note.",
    "This is private runtime state. Inspect or continue the work when needed. If no concrete follow-up remains, call dismiss_agent_job before ending this handoff turn; leave it yielded only for an expected continuation. Do not mechanically repeat the handoff.",
  ].join("\n\n");
}

function syntheticHistory(job: AgentTaskJob, botUserId: string, botUsername: string): HistoryMessage {
  return {
    id: `agent-task-${job.id}-${Date.now()}`,
    author: botUsername,
    authorId: botUserId,
    content: job.input.message,
    isBot: true,
    timestamp: Date.now(),
    replyToId: null,
    hasEmbeds: false,
    isSynthetic: true,
    relatedThreadId: null,
  };
}

function syntheticIncoming(
  job: AgentTaskJob,
  guild: Guild,
  channel: SendableGuildChannel,
  botUserId: string,
  botUsername: string,
): IncomingMessage {
  return {
    content: job.input.message,
    guildId: guild.id,
    guildName: guild.name,
    channelId: channel.id,
    channelName: channelDisplayName(channel) ?? channel.id,
    authorId: botUserId,
    authorUsername: botUsername,
    authorIsBot: true,
    botUserId,
    mentionedUserIds: [],
    mentionedRoleIds: [],
    botRoleIds: [],
    mentionedEveryone: false,
    translatedContent: job.input.message,
    messageId: `agent-task-${job.id}`,
    eventPrompt: {
      metadataHeading: "Background Agent Task",
      contentHeading: "Task",
      metadataText: `Job ${job.id}; private asynchronous work.`,
    },
  };
}

function createSendDiscordMessageTool(input: {
  sender: MessageSender;
  resolveAssets: (assetIds: AssetRef[]) => Promise<OutboundAttachment[]>;
  signal: AbortSignal;
}): AgentTool {
  return {
    name: "send_discord_message",
    label: "send_discord_message",
    description: "Explicitly send a visible Discord message from this private persona task.",
    parameters: SendDiscordMessageParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      const request = params as { content?: string; channel_id?: string; asset_ids?: AssetRef[] };
      const content = request.content?.trim() ?? "";
      const assetIds = request.asset_ids ?? [];
      if (content === "" && assetIds.length === 0) throw new Error("content or asset_ids is required.");
      const attachments = await input.resolveAssets(assetIds);
      const sent = await input.sender(
        content,
        false,
        request.channel_id,
        undefined,
        input.signal,
        undefined,
        attachments,
        `agent-visible-${randomUUID()}`,
      );
      return {
        content: [{ type: "text", text: `Sent visible Discord message ${sent.sentMessageId}.` }],
        details: { sentMessageId: sent.sentMessageId, channelId: sent.sentChannelId },
      };
    },
  };
}
