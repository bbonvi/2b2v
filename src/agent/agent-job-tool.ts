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
  ])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});

const ReadAgentJobParams = Type.Object({
  job_id: Type.String(),
});

const DismissAgentJobParams = Type.Object({
  job_id: Type.String(),
  reason: Type.String(),
});

/** Render complete job provenance for private inspection and asset reads. */
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
    job.kind === "image_generation" && job.input.ownerAgentJobId !== undefined
      ? `Owner agent: ${job.input.ownerAgentJobId}`
      : "",
    `Replacement count: ${job.replacementCount}`,
    assets.length > 0
      ? `Assets: ${assets.map((asset) => `${asset.role} #${asset.assetId}`).join(", ")}`
      : "",
    `Source request quote: ${JSON.stringify(job.sourceQuote)}`,
    `Original effective input: ${job.kind === "image_generation" ? renderImageGenerationInput(job.input) : JSON.stringify(job.input)}`,
    job.kind === "image_generation" && job.result?.revisedPrompt !== undefined
      ? `Provider-revised prompt: ${job.result.revisedPrompt}`
      : "",
    job.result !== undefined ? `Result: ${JSON.stringify(job.result)}` : "",
    job.cancelReason !== undefined ? `Cancel reason: ${job.cancelReason}` : "",
    job.error !== undefined ? `Error: ${job.error}` : "",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/** Create global private tools for listing and inspecting durable agent jobs. */
export function createAgentJobInspectionTools(input: {
  store: AgentJobStore;
  onDismiss?: (jobId: string) => void | Promise<void>;
}): AgentTool[] {
  const listTool: AgentTool = markReadOnlyTool({
    name: "list_agent_jobs",
    label: "List Jobs",
    description: "",
    parameters: ListAgentJobsParams,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ jobIds: string[] }>> => {
      const parsed = params as { state?: "active" | "recent" | "all"; limit?: number };
      const jobs = parsed.state === "recent"
        ? input.store.listGlobalRecent(parsed.limit ?? 10)
        : input.store.listGlobal(parsed.state ?? "all", parsed.limit ?? 10);
      const lines = jobs.map((job) => {
        const assets = input.store.listAssets(job.id);
        const assetText = assets.length === 0
          ? ""
          : `; assets ${assets.map((asset) => `#${asset.assetId}`).join(", ")}`;
        const source = job.sentMessageId === undefined ? "" : `; sent MsgID ${job.sentMessageId}`;
        const summary = job.kind === "image_generation" ? job.input.prompt : job.input.message;
        const owner = job.kind === "image_generation" && job.input.ownerAgentJobId !== undefined
          ? `; owner ${job.input.ownerAgentJobId}`
          : "";
        return `- ${job.id} ${job.kind} ${job.status} for @${job.requesterUsername}; origin guild ${job.guildId} channel ${job.channelId}${owner}; task: ${JSON.stringify(shortQuote(summary, 180))}${source}${assetText}`;
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
    description: "",
    parameters: ReadAgentJobParams,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ jobId: string }>> => {
      const parsed = params as { job_id: string };
      const job = input.store.get(parsed.job_id);
      if (job === undefined) throw new Error(`Job ${parsed.job_id} was not found.`);
      return Promise.resolve({
        content: [{ type: "text", text: renderAgentJobDetails(job, input.store.listAssets(job.id)) }],
        details: { jobId: job.id },
      });
    },
  });

  const dismissTool: AgentTool = {
    name: "dismiss_agent_job",
    label: "Dismiss Job",
    description: "",
    parameters: DismissAgentJobParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<{ jobId: string; dismissed: boolean }>> {
      const parsed = params as { job_id: string; reason: string };
      const job = input.store.get(parsed.job_id);
      if (job === undefined) {
        throw new Error(`Job ${parsed.job_id} was not found.`);
      }
      if (job.status !== "ready" && job.status !== "yielded") {
        throw new Error(`Job ${job.id} is ${job.status}; only ready or yielded jobs can be dismissed.`);
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
