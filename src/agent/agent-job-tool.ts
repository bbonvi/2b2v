import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { renderImageGenerationInput, shortQuote } from "./generated-image-runtime.ts";
import type { AgentJob, AgentJobStore } from "./job-runtime.ts";
import { markReadOnlyTool } from "./tool-effects.ts";

const ListAgentJobsParams = Type.Object({
  state: Type.Optional(Type.Union([
    Type.Literal("active"),
    Type.Literal("recent"),
    Type.Literal("all"),
  ], { description: "Which lifecycle group to list." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum jobs to return." })),
});

const ReadAgentJobParams = Type.Object({
  job_id: Type.String({ description: "Visible async job id." }),
});

const DismissAgentJobParams = Type.Object({
  job_id: Type.String({ description: "Visible ready job id." }),
  reason: Type.String({ description: "Private reason for deliberately abandoning the result." }),
});

/** Render complete image-job provenance for private inspection and asset reads. */
export function renderAgentJobDetails(
  job: AgentJob,
  assets: readonly { assetId: number; role: string }[] = [],
): string {
  const lines = [
    `Job: ${job.id}`,
    `Kind: ${job.kind}`,
    `Status: ${job.status}`,
    `Requester: @${job.requesterUsername} (${job.requesterId})`,
    `Source: guild ${job.guildId}, channel ${job.channelId}, MsgID ${job.sourceMessageId}`,
    `Delivery: guild ${job.deliveryGuildId}, channel ${job.deliveryChannelId}`,
    `Created: ${new Date(job.createdAt).toISOString()}`,
    job.startedAt !== undefined ? `Started: ${new Date(job.startedAt).toISOString()}` : "",
    job.completedAt !== undefined ? `Completed: ${new Date(job.completedAt).toISOString()}` : "",
    job.sentMessageId !== undefined ? `Sent MsgID: ${job.sentMessageId}` : "",
    job.replacementRootJobId !== undefined ? `Replacement root: ${job.replacementRootJobId}` : "",
    job.replacesJobId !== undefined ? `Replaces: ${job.replacesJobId}` : "",
    `Replacement count: ${job.replacementCount}`,
    assets.length > 0
      ? `Assets: ${assets.map((asset) => `${asset.role} #${asset.assetId}`).join(", ")}`
      : "",
    `Source request quote: ${JSON.stringify(job.sourceQuote)}`,
    `Original effective input: ${renderImageGenerationInput(job.input)}`,
    job.result?.revisedPrompt !== undefined
      ? `Provider-revised prompt: ${job.result.revisedPrompt}`
      : "",
    job.result !== undefined ? `Result: ${JSON.stringify(job.result)}` : "",
    job.cancelReason !== undefined ? `Cancel reason: ${job.cancelReason}` : "",
    job.error !== undefined ? `Error: ${job.error}` : "",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/** Create scoped private tools for listing and inspecting durable agent jobs. */
export function createAgentJobInspectionTools(input: {
  store: AgentJobStore;
  guildId: string;
  channelId: string;
  onDismiss?: (jobId: string) => void | Promise<void>;
}): AgentTool[] {
  const listTool: AgentTool = markReadOnlyTool({
    name: "list_agent_jobs",
    label: "List Jobs",
    description: "List active or recent async jobs visible in this channel.",
    parameters: ListAgentJobsParams,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ jobIds: string[] }>> => {
      const parsed = params as { state?: "active" | "recent" | "all"; limit?: number };
      const jobs = input.store.list(
        input.guildId,
        input.channelId,
        parsed.state === "recent" ? "terminal" : parsed.state ?? "all",
        parsed.limit ?? 10,
      );
      const lines = jobs.map((job) => {
        const assets = input.store.listAssets(job.id);
        const assetText = assets.length === 0
          ? ""
          : `; assets ${assets.map((asset) => `#${asset.assetId}`).join(", ")}`;
        const source = job.sentMessageId === undefined ? "" : `; sent MsgID ${job.sentMessageId}`;
        return `- ${job.id} ${job.kind} ${job.status} for @${job.requesterUsername}; prompt: ${JSON.stringify(shortQuote(job.input.prompt, 180))}${source}${assetText}`;
      });
      return Promise.resolve({
        content: [{ type: "text", text: lines.length === 0 ? "No matching jobs." : lines.join("\n") }],
        details: { jobIds: jobs.map((job) => job.id) },
      });
    },
  });

  const readTool: AgentTool = markReadOnlyTool({
    name: "read_agent_job",
    label: "Read Job",
    description: "Read the complete input, lifecycle, result, and asset provenance for one visible async job.",
    parameters: ReadAgentJobParams,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ jobId: string }>> => {
      const parsed = params as { job_id: string };
      const job = input.store.getVisible(parsed.job_id, input.guildId, input.channelId);
      if (job === undefined) throw new Error(`Job ${parsed.job_id} was not found or is not visible in this channel.`);
      return Promise.resolve({
        content: [{ type: "text", text: renderAgentJobDetails(job, input.store.listAssets(job.id)) }],
        details: { jobId: job.id },
      });
    },
  });

  const dismissTool: AgentTool = {
    name: "dismiss_agent_job",
    label: "Dismiss Job",
    description: "Deliberately abandon a visible ready job without Discord delivery.",
    parameters: DismissAgentJobParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<{ jobId: string; dismissed: boolean }>> {
      const parsed = params as { job_id: string; reason: string };
      const job = input.store.getVisible(parsed.job_id, input.guildId, input.channelId);
      if (job === undefined) {
        throw new Error(`Job ${parsed.job_id} was not found or is not visible in this channel.`);
      }
      if (job.status !== "ready") {
        throw new Error(`Job ${job.id} is ${job.status}; only ready jobs can be dismissed here.`);
      }
      const result = input.store.cancel(job.id, {
        reason: parsed.reason,
        mode: "explicit_cancel",
      });
      if (result.ok) await input.onDismiss?.(job.id);
      return {
        content: [{ type: "text", text: result.message }],
        details: { jobId: job.id, dismissed: result.ok },
      };
    },
  };

  return [listTool, readTool, dismissTool];
}
