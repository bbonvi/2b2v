import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Client, Guild } from "discord.js";
import { RequestLog, type Logger } from "../logger.ts";
import { type requestLogStore } from "../dashboard/store.ts";
import type { Database } from "../db/database.ts";
import { getStagedAsset } from "../db/staged-asset-repository.ts";
import { channelDisplayName, createTargetChannelResolver, type SendableGuildChannel } from "../discord/message-sender.ts";
import type { loadGlobalConfig } from "../config/loader.ts";
import type { GuildConfig } from "../config/types.ts";
import type { PromptBundle } from "../config/instruction-bundle.ts";
import { applyRuntimeToolPrompts } from "./runtime-tool-prompts.ts";
import { createLoadSkillTool } from "./load-skill-tool.ts";
import { createSearchToolsTool, initialActorToolNames } from "./tool-catalog.ts";
import { runSilentToolAgentPass } from "./maintenance-pass.ts";
import { buildRuntimeInstruction } from "./turn-prompt.ts";
import { parseResponseDirectives } from "./response-directives.ts";
import { sendResponseSegments } from "./response-delivery.ts";
import type { AssembledContext } from "./context-assembly.ts";
import type { IncomingMessage, MessageSender, OutboundAttachment } from "./turn-types.ts";
import { isActiveJobStatus, type AgentJobStore, type AgentPendingMessage, type AgentTaskJob } from "./job-runtime.ts";
import { AssetRefSchema, type AssetRef } from "./asset-id.ts";
import type { OpenRouterMessage } from "../llm/types.ts";
import type { createToolRuntime } from "./tool-runtime.ts";
import type { createTurnRuntime } from "./turn-runtime.ts";

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
  buildAgentTools: ReturnType<typeof createToolRuntime>["buildAgentTools"];
  createBotDiscordMessageSender: ReturnType<typeof createTurnRuntime>["createBotDiscordMessageSender"];
  createAssetAttachmentResolver: ReturnType<typeof createTurnRuntime>["createAssetAttachmentResolver"];
  fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
  enqueueChannelTask: (guildId: string, channelId: string, task: () => Promise<void>) => Promise<void>;
}) {
  const {
    db, client, log, requestLogStore, agentJobs, getGlobalConfig, getPromptBundle,
    getGuildConfig, buildAgentTools, createBotDiscordMessageSender,
    createAssetAttachmentResolver, fetchAccessibleGuildChannel, enqueueChannelTask,
  } = input;
  function runAgentJob(jobId: string): Promise<void> {
    return executeAgentJob(jobId);
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
      const runtime = await prepareRun(taskJob, controller.signal, taskJob.id);
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
        guildConfig: runtime.guildConfig,
        context: runtime.context,
        systemPrompt: runtime.promptBundle.systemPrompt,
        personaPrompt: runtime.promptBundle.corePrompt,
        runtimePrompts: runtime.promptBundle.runtime,
        skillsInstruction: runtime.promptBundle.runtime.skills.indexPrompt,
        incomingMessage: runtime.incoming,
        userContent: taskJob.input.message,
        assistantReply: taskJob.result?.handoff ?? "",
        visibleReplySent: false,
        tools: runtime.tools,
        runtimeInstruction: buildRuntimeInstruction(runtime.promptBundle.runtime),
        controlMessage: previousTranscript === undefined ? runtime.promptBundle.runtime.backgroundAgent : "",
        modelProfile: taskJob.input.modelProfile,
        maxToolCalls: runtime.guildConfig.agentJobs.agentMaxToolCalls,
        wallClockTimeoutMs: runtime.guildConfig.agentJobs.agentTimeoutMs,
        transcript: previousTranscript,
        continueTranscript: true,
        initialToolNames: taskJob.result?.activeToolNames
          ?? [...initialActorToolNames(runtime.tools)],
        promptCacheSurface: "discord-actor",
        requestLog,
        log: log.child({ component: "agent-task", jobId: taskJob.id, kind: taskJob.kind }),
        signal: controller.signal,
        takePendingMessages: async () => await materializePendingMessages(agentJobs.takePendingAgentMessages(jobId)),
        imageInputSupported: true,
        stopAfterAsyncImageJobCreated: false,
        compactTranscript: {
          reserveTokens: runtime.guildConfig.agentJobs.agentCompactionReserveTokens,
          keepRecentTokens: runtime.guildConfig.agentJobs.agentCompactionKeepRecentTokens,
        },
        pendingAttachments,
      });
      const ownedImages = agentJobs.listOwnedImageJobs(taskJob.id);
      const activeImages = ownedImages.filter((child) => isActiveJobStatus(child.status));
      if (activeImages.length > 0) {
        agentJobs.markWaitingOnJobs(taskJob.id, {
          handoff: result.text.trim(),
          transcript: result.transcript,
          activeToolNames: result.activeToolNames,
        });
        requestLog.setTrigger({ ...trigger, status: "waiting_on_jobs" });
        return;
      }
      const outputManifest = [...ownedImages.map((child) => ({
        jobId: child.id,
        stagedAssetRef: child.result?.stagedAssetRef,
        workspacePath: child.result?.workspacePath,
      }))]
        .filter((output): output is { jobId: string; stagedAssetRef: string; workspacePath: string } =>
          output.stagedAssetRef !== undefined && output.workspacePath !== undefined
        );
      const joinedHandoff = [
        result.text.trim(),
        outputManifest.length > 0
          ? `Agent outputs:\n${outputManifest.map((output) => `- ${output.jobId}: ${output.stagedAssetRef} — ${output.workspacePath}`).join("\n")}`
          : "",
      ].filter((part) => part !== "").join("\n\n");
      const handoff = joinedHandoff !== "" ? joinedHandoff : "Task finished without a handoff note.";
      agentJobs.markYielded(taskJob.id, {
        handoff,
        transcript: result.transcript,
        activeToolNames: result.activeToolNames,
      });
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

  async function prepareRun(job: AgentTaskJob, signal: AbortSignal, ownerAgentJobId?: string) {
    const guild = client.guilds.cache.get(job.guildId);
    if (guild === undefined) throw new Error(`Guild ${job.guildId} is unavailable.`);
    const channel = await fetchAccessibleGuildChannel(job.channelId);
    if (channel === null) throw new Error(`Channel ${job.channelId} is unavailable.`);
    const guildConfig = getGuildConfig(job.guildId);
    const promptBundle = getPromptBundle();
    const sender = createBotDiscordMessageSender({
      defaultChannel: channel,
      resolveTargetChannel: createTargetChannelResolver(client, channel),
      botUserId: client.user?.id ?? "",
      botUsername: client.user?.username ?? "bot",
      logger: log,
    });
    const context: AssembledContext = { sections: [], userMessage: job.input.message };
    const incoming = syntheticIncoming(job, guild, channel, client.user?.id ?? "", client.user?.username ?? "bot");
    const operational = buildAgentTools(
      job.guildId,
      job.channelId,
      guildConfig,
      guild,
      context.contextMessageIds,
      undefined,
      {
        requesterId: job.requesterId,
        requesterUsername: job.requesterUsername,
        sourceMessageId: job.sourceMessageId,
        sourceQuote: job.sourceQuote,
      },
      {
        ...(ownerAgentJobId !== undefined ? { ownerAgentJobId } : {}),
        onVisibleOutput: () => {},
      },
    );
    const resolveAssets = createAssetAttachmentResolver(job.guildId, guildConfig, log);
    const selected = [
      ...operational,
      createSendDiscordMessageTool({ sender, resolveAssets, signal }),
    ];
    const loaders = applyRuntimeToolPrompts([
      createSearchToolsTool({ tools: selected, skills: promptBundle.runtime.skills }),
      createLoadSkillTool({ skills: promptBundle.runtime.skills }),
    ], promptBundle.runtime);
    return { guildConfig, context, incoming, tools: [...loaders, ...selected], sender, resolveAssets, promptBundle };
  }

  async function notifyPrimary(jobId: string): Promise<void> {
    const job = agentJobs.get(jobId);
    if (job === undefined || job.kind === "image_generation" || (job.status !== "yielded" && job.status !== "failed") || job.result?.notificationPending !== true) return;
    await enqueueChannelTask(job.guildId, job.channelId, async () => {
      const current = agentJobs.get(jobId);
      if (
        current === undefined
        || current.kind === "image_generation"
        || (current.status !== "yielded" && current.status !== "failed")
        || current.result?.notificationPending !== true
      ) return;
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
        const runtime = await prepareRun(current, controller.signal);
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
      "SELECT id, status FROM agent_jobs WHERE kind = 'persona_task' AND status IN ('queued', 'waiting_on_jobs', 'yielded', 'failed') ORDER BY created_at ASC",
    ).all() as Array<{ id: string; status: string }>;
    await Promise.all(rows.map(async (row) => {
      if (row.status === "queued") await runAgentJob(row.id);
      else if (row.status === "waiting_on_jobs") {
        const activeChildren = agentJobs.listOwnedImageJobs(row.id).filter((child) => isActiveJobStatus(child.status));
        if (activeChildren.length === 0) {
          const resumed = agentJobs.sendAgentMessage(row.id, "Background image jobs ended while the process was restarting. Inspect their terminal states and continue the task.");
          if (resumed.shouldRun) await runAgentJob(row.id);
        }
      }
      else await notifyPrimary(row.id);
    }));
  }

  async function materializePendingMessages(events: AgentPendingMessage[]): Promise<OpenRouterMessage[]> {
    return await Promise.all(events.map(async (event): Promise<OpenRouterMessage> => {
      if (event.kind === "text") return { role: "user", content: event.text };
      const staged = getStagedAsset(db, event.stagedAssetRef);
      if (staged === null) return { role: "user", content: `${event.text}\nThe staged image is unavailable for direct inspection.` };
      const file = Bun.file(staged.storagePath);
      if (!await file.exists()) return { role: "user", content: `${event.text}\nThe staged image file is unavailable for direct inspection.` };
      const bytes = await file.arrayBuffer();
      return {
        role: "user",
        content: [
          { type: "text", text: event.text },
          { type: "image_url", image_url: { url: `data:${event.contentType};base64,${Buffer.from(bytes).toString("base64")}` } },
        ],
      };
    }));
  }

  return { runAgentJob, notifyPrimary, recover };
}

function primaryHandoffControlMessage(job: AgentTaskJob): string {
  return [
    "## Background Agent Handoff",
    `Agent ${job.id} (${job.input.taskName}) yielded:`,
    job.result?.handoff ?? "No handoff note.",
    "This is private runtime state. Inspect or continue the work when needed. If no concrete follow-up remains, call dismiss_agent_job before ending this handoff turn; leave it yielded only for an expected continuation. Do not mechanically repeat the handoff.",
  ].join("\n\n");
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
      metadataText: `Job ${job.id}; task ${JSON.stringify(job.input.taskName)}; private asynchronous work.`,
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
