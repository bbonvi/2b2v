import type { Message } from "discord.js";
import type { PromptBundle } from "../config/instruction-bundle.ts";
import type { AgentJobStore, BackgroundAgentJob } from "../agent/job-runtime.ts";
import type { SendableGuildChannel } from "./message-sender.ts";
import type { DispatchOutcome } from "./channel-dispatcher.ts";

interface HandoffTurnOptions {
  currentTurnOverride: { messageId: string; timestamp: number; content: string };
  dashboardTrigger: { type: string; jobId: string; taskName: string; status: string };
  initialToolNames: string[];
  preloadedSkillIds: string[];
  focusUserId: string;
  currentRequest: {
    requesterId: string;
    requesterUsername: string;
    sourceMessageId: string;
    sourceQuote: string;
  };
  actorSurface: "channel" | "private-life";
}

/** Deliver a root background result through a fresh normal actor turn. */
export function createBackgroundHandoffRunner(input: {
  agentJobs: AgentJobStore;
  getPromptBundle: () => PromptBundle;
  fetchAccessibleGuildChannel: (channelId: string) => Promise<SendableGuildChannel | null>;
  enqueueChannelTask: (guildId: string, channelId: string, task: () => Promise<void>) => Promise<void>;
  createCarrier: (channel: SendableGuildChannel, id: string, createdTimestamp: number) => Message;
  runActorTurn: (carrier: Message, options: HandoffTurnOptions) => Promise<DispatchOutcome>;
}): (jobId: string) => Promise<void> {
  return async (jobId) => {
    const job = input.agentJobs.get(jobId);
    if (job?.kind !== "background_agent" || job.parentJobId !== undefined) return;
    if ((job.status !== "yielded" && job.status !== "failed") || job.handoffNotifiedAt !== undefined) return;
    const target = job.input.handoffTarget;
    await input.enqueueChannelTask(target.guildId, target.channelId, async () => {
      const current = input.agentJobs.get(jobId);
      if (current?.kind !== "background_agent" || current.parentJobId !== undefined) return;
      if ((current.status !== "yielded" && current.status !== "failed") || current.handoffNotifiedAt !== undefined) return;
      const channel = await input.fetchAccessibleGuildChannel(target.channelId);
      if (channel === null || channel.guildId !== target.guildId) {
        throw new Error(`Handoff channel ${target.channelId} is unavailable.`);
      }
      const statusChangedAt = current.statusChangedAt;
      const carrier = input.createCarrier(channel, `background-handoff-carrier:${current.id}`, statusChangedAt);
      const skillIds = current.checkpoint?.loadedSkillIds ?? [];
      const initialToolNames = [
        "read_agent_job",
        "send_agent_message",
        "dismiss_agent_job",
        ...skillIds.flatMap((skillId) => input.getPromptBundle().runtime.skills.byId[skillId]?.requiredForTools ?? []),
      ];
      const handoffMessageId = `background-handoff:${current.id}:${statusChangedAt}`;
      const outcome = await input.runActorTurn(carrier, {
        currentTurnOverride: {
          messageId: handoffMessageId,
          timestamp: statusChangedAt,
          content: backgroundHandoffMessage(current),
        },
        dashboardTrigger: {
          type: "background_agent_handoff",
          jobId: current.id,
          taskName: current.input.taskName,
          status: current.status,
        },
        initialToolNames,
        preloadedSkillIds: skillIds,
        focusUserId: current.requesterId,
        currentRequest: {
          requesterId: current.requesterId,
          requesterUsername: current.requesterUsername,
          sourceMessageId: current.sourceMessageId,
          sourceQuote: current.sourceQuote,
        },
        actorSurface: target.kind === "private_life" ? "private-life" : "channel",
      });
      if (outcome.coveredMessageIds?.includes(handoffMessageId) !== true) {
        throw new Error(`Background handoff ${current.id} did not complete.`);
      }
      input.agentJobs.markNotificationDelivered(current.id, statusChangedAt);
    });
  };
}

function backgroundHandoffMessage(job: BackgroundAgentJob): string {
  return [
    "## Background Agent Handoff",
    `Job ${job.id} (${job.input.taskName}) ${job.status}.`,
    job.result?.handoff ?? job.error ?? "No handoff note was produced.",
    "This is private runtime state from your background job, not a Discord user's message. Continue or inspect the job if needed. Dismiss it when no concrete follow-up remains. Respond through the normal turn output; do not search for a Discord send tool.",
  ].join("\n\n");
}
