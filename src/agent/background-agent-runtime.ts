import type { Client, Guild } from "discord.js";
import { RequestLog, type Logger } from "../logger.ts";
import { type requestLogStore } from "../dashboard/store.ts";
import type { Database } from "../db/database.ts";
import { getStagedAsset } from "../db/staged-asset-repository.ts";
import { channelDisplayName, type SendableGuildChannel } from "../discord/message-sender.ts";
import type { loadGlobalConfig } from "../config/loader.ts";
import type { GuildConfig } from "../config/types.ts";
import type { PromptBundle } from "../config/instruction-bundle.ts";
import type { OpenRouterMessage } from "../llm/types.ts";
import type { AssembledContext } from "./context-assembly.ts";
import { handleMessage } from "./handler.ts";
import type { createToolRuntime } from "./tool-runtime.ts";
import type { createTurnRuntime } from "./turn-runtime.ts";
import type { AgentJobStore, BackgroundAgentJob, PendingAgentEvent } from "./job-runtime.ts";
import type { IncomingMessage, MessageSender } from "./turn-types.ts";

/** Run durable background jobs through the normal persona actor loop. */
export function createBackgroundAgentRuntime(input: {
  db: Database;
  client: Client;
  log: Logger;
  requestLogStore: typeof requestLogStore;
  agentJobs: AgentJobStore;
  getGlobalConfig: () => ReturnType<typeof loadGlobalConfig>;
  getPromptBundle: () => PromptBundle;
  getGuildConfig: (guildId: string) => GuildConfig;
  buildAgentTools: ReturnType<typeof createToolRuntime>["buildAgentTools"];
  createHandlerDeps: ReturnType<typeof createTurnRuntime>["createHandlerDeps"];
  fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
  dispatchRootHandoff: (jobId: string) => Promise<void>;
}) {
  const {
    db, client, log, requestLogStore, agentJobs, getGlobalConfig, getPromptBundle,
    getGuildConfig, buildAgentTools, createHandlerDeps, fetchAccessibleGuildChannel,
    dispatchRootHandoff,
  } = input;

  async function runAgentJob(jobId: string): Promise<void> {
    while (await runPass(jobId)) {
      // A follow-up arrived at the persistence boundary. Continue in a new logged pass.
    }
  }

  async function runPass(jobId: string): Promise<boolean> {
    const queued = agentJobs.get(jobId);
    if (queued?.kind !== "background_agent" || queued.status !== "queued") return false;
    const controller = new AbortController();
    const started = agentJobs.start(jobId, () => controller.abort(new Error(`Agent ${jobId} was cancelled.`)));
    if (started?.kind !== "background_agent" || started.status !== "running") return false;

    const requestLog = new RequestLog(started.guildId, started.channelId, requestLogStore);
    const trigger = {
      type: "background_agent_run",
      jobId: started.id,
      taskName: started.input.taskName,
      status: "running",
      ...(started.parentJobId !== undefined ? { parentJobId: started.parentJobId } : {}),
    };
    requestLog.setAuthor(started.requesterUsername);
    requestLog.setTriggerContext({
      authorUsername: started.requesterUsername,
      content: started.input.message,
      sourceMessageId: started.sourceMessageId,
      sourceQuote: started.sourceQuote,
    });
    requestLog.setTrigger(trigger);
    requestLog.setAgentRan(true);
    requestLogStore.incrementActive();
    try {
      const runtime = await prepareRun(started);
      requestLog.setTriggerContext({
        guildName: runtime.incoming.guildName,
        channelName: runtime.incoming.channelName,
        authorUsername: started.requesterUsername,
        content: started.input.message,
        sourceMessageId: started.sourceMessageId,
        sourceQuote: started.sourceQuote,
      });
      const consumedEventIds = new Set<number>();
      const result = await handleMessage(runtime.incoming, createHandlerDeps({
        guildId: started.guildId,
        guildConfig: runtime.guildConfig,
        context: runtime.context,
        currentChannelId: started.channelId,
        sender: privateSender,
        extraTools: runtime.tools,
        log: log.child({ component: "background-agent", jobId, requestId: requestLog.requestId }),
        requestLog,
        overrides: {
          forceTrigger: true,
          modelProfile: started.input.modelProfile,
          initialToolNames: started.checkpoint?.activeToolNames,
          abortSignal: controller.signal,
          externalResponseSink: {
            startModelTurn: () => {},
            push: () => Promise.resolve(false),
            finish: (text) => Promise.resolve({ visible: false, memoryText: text, malformed: false }),
            abort: () => {},
          },
          actorContinuation: {
            transcript: transcriptFromCheckpoint(started),
            controlMessage: backgroundControlMessage(started, getPromptBundle()),
            loadedSkillIds: started.checkpoint?.loadedSkillIds,
            takePendingMessages: async () => {
              const events = agentJobs.pendingEvents(jobId).filter((event) => !consumedEventIds.has(event.id));
              for (const event of events) consumedEventIds.add(event.id);
              return await materializeEvents(events);
            },
            maxToolCalls: getGlobalConfig().agentJobs.agentMaxToolCalls,
            wallClockTimeoutMs: getGlobalConfig().agentJobs.agentTimeoutMs,
            compaction: {
              reserveTokens: getGlobalConfig().agentJobs.agentCompactionReserveTokens,
              keepRecentTokens: getGlobalConfig().agentJobs.agentCompactionKeepRecentTokens,
            },
          },
        },
      }));
      const responseText = result.responseText?.trim();
      const handoff = responseText === undefined || responseText === ""
        ? "Task finished without a handoff note."
        : responseText;
      const finish = agentJobs.finishBackgroundRun(jobId, {
        checkpoint: {
          transcript: result.maintenanceTranscript ?? [],
          activeToolNames: result.promptContext?.activeToolNames ?? [],
          loadedSkillIds: result.promptContext?.loadedSkillIds ?? [],
        },
        handoff,
        consumedEventIds: [...consumedEventIds],
      });
      requestLog.setTrigger({ ...trigger, status: finish.job?.status ?? "dismissed" });
      if (finish.job?.status === "yielded") await routeResult(finish.job);
      return finish.shouldRun;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = agentJobs.get(jobId);
      const dismissed = current?.status === "dismissed";
      const settled = current?.kind === "background_agent" && current.status !== "running";
      requestLog.setError(message);
      requestLog.setTrigger({ ...trigger, status: current?.status ?? "failed" });
      if (!dismissed && !settled) {
        const failed = agentJobs.markBackgroundFailed(jobId, message);
        if (failed !== undefined) await routeResult(failed);
      }
      return false;
    } finally {
      requestLog.emit(log);
      requestLogStore.decrementActive();
    }
  }

  async function routeResult(job: BackgroundAgentJob): Promise<void> {
    if (job.parentJobId === undefined) {
      await dispatchRootHandoff(job.id);
      return;
    }
    if (agentJobs.get(job.parentJobId)?.status === "queued") await runAgentJob(job.parentJobId);
  }

  async function prepareRun(job: BackgroundAgentJob) {
    const guild = client.guilds.cache.get(job.guildId);
    if (guild === undefined) throw new Error(`Guild ${job.guildId} is unavailable.`);
    const channel = await fetchAccessibleGuildChannel(job.channelId);
    if (channel === null) throw new Error(`Channel ${job.channelId} is unavailable.`);
    const guildConfig = getGuildConfig(job.guildId);
    const context: AssembledContext = { sections: [], userMessage: job.input.message };
    const incoming = syntheticIncoming(job, guild, channel, client.user?.id ?? "", client.user?.username ?? "bot");
    const tools = buildAgentTools(
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
        parentJobId: job.id,
        handoffTarget: job.input.handoffTarget,
        onVisibleOutput: () => {},
      },
    );
    return { guildConfig, context, incoming, tools };
  }

  async function materializeEvents(events: readonly PendingAgentEvent[]): Promise<OpenRouterMessage[]> {
    return await Promise.all(events.map(async ({ message }): Promise<OpenRouterMessage> => {
      if (message.kind === "text") return { role: "user", content: message.text };
      const staged = getStagedAsset(db, message.stagedAssetRef);
      if (staged === null) return { role: "user", content: `${message.text}\nThe staged image is unavailable for direct inspection.` };
      const file = Bun.file(staged.storagePath);
      if (!await file.exists()) return { role: "user", content: `${message.text}\nThe staged image file is unavailable for direct inspection.` };
      return {
        role: "user",
        content: [
          { type: "text", text: message.text },
          { type: "image_url", image_url: { url: `data:${message.contentType};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}` } },
        ],
      };
    }));
  }

  async function recover(): Promise<void> {
    const rows = db.raw.prepare(`SELECT id, status FROM agent_jobs
      WHERE kind = 'background_agent' AND status IN ('queued', 'waiting_on_jobs', 'yielded', 'failed')
      ORDER BY created_at ASC`).all() as Array<{ id: string; status: string }>;
    for (const row of rows) {
      if (row.status === "queued") await runAgentJob(row.id);
      else if (row.status === "waiting_on_jobs") {
        const hasActiveChildren = agentJobs.listChildren(row.id).some((child) => ["queued", "running", "waiting_on_jobs", "ready"].includes(child.status));
        if (!hasActiveChildren) {
          const resumed = agentJobs.sendAgentMessage(row.id, "The process restarted after all child jobs stopped. Inspect their terminal states and continue.");
          if (resumed.shouldRun) await runAgentJob(row.id);
        }
      } else {
        const job = agentJobs.get(row.id);
        if (job?.kind === "background_agent" && job.parentJobId === undefined && job.handoffNotifiedAt === undefined) {
          await dispatchRootHandoff(job.id);
        }
      }
    }
  }

  return { runAgentJob, recover };
}

const privateSender: MessageSender = () => Promise.reject(new Error("Background agents do not have an implicit Discord sender."));

function transcriptFromCheckpoint(job: BackgroundAgentJob): OpenRouterMessage[] | undefined {
  return job.checkpoint?.transcript as OpenRouterMessage[] | undefined;
}

function backgroundControlMessage(job: BackgroundAgentJob, promptBundle: PromptBundle): string {
  return [
    promptBundle.runtime.backgroundAgent,
    "## Current Background Job",
    `Job ID: ${job.id}`,
    `Task: ${job.input.taskName}`,
  ].filter((part) => part.trim() !== "").join("\n\n");
}

function syntheticIncoming(
  job: BackgroundAgentJob,
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
    messageId: `background-agent-${job.id}`,
    eventPrompt: {
      metadataHeading: "Background Job",
      contentHeading: "Assignment",
      metadataText: `Job ${job.id}; task ${JSON.stringify(job.input.taskName)}; private asynchronous work.`,
    },
  };
}
