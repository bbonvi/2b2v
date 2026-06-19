import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { randomUUID } from "node:crypto";

export type AgentJobKind = "image_generation";
export type AgentJobStatus = "queued" | "running" | "cancelling" | "cancelled" | "sent" | "failed" | "timed_out";
export type CancelMode = "replacement" | "explicit_cancel";

export interface ImageGenerationJobInput {
  prompt: string;
  promptHash: string;
  imageIds: number[];
  outputFormat: "png" | "jpeg" | "webp";
  is4k: boolean;
  separateJob: boolean;
  allowsGroupCorrections: boolean;
  replacesJobId?: string;
}

export interface ImageGenerationJobResult {
  attachmentId?: string;
  filename?: string;
  contentType?: string;
  revisedPrompt?: string;
  requestedSize?: string;
  actualSize?: string;
  transport?: string;
  is4k?: boolean;
}

export interface AgentJob {
  id: string;
  kind: AgentJobKind;
  guildId: string;
  channelId: string;
  requesterId: string;
  requesterUsername: string;
  sourceMessageId: string;
  sourceQuote: string;
  status: AgentJobStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  sentMessageId?: string;
  error?: string;
  input: ImageGenerationJobInput;
  result?: ImageGenerationJobResult;
  replacementRootJobId?: string;
  replacesJobId?: string;
  replacementCount: number;
  cancelReason?: string;
  abort?: () => void;
}

export interface AgentJobConfig {
  imageTimeoutMs: number;
  imageCancelGraceMs: number;
  terminalVisibleMs: number;
  maxImageReplacements: number;
}

export interface EnqueueImageJobInput {
  guildId: string;
  channelId: string;
  requesterId: string;
  requesterUsername: string;
  sourceMessageId: string;
  sourceQuote: string;
  prompt: string;
  promptHash: string;
  imageIds: number[];
  outputFormat: "png" | "jpeg" | "webp";
  is4k: boolean;
  separateJob: boolean;
  allowsGroupCorrections: boolean;
  replacesJobId?: string;
  now?: number;
}

export interface EnqueueImageJobResult {
  job: AgentJob;
  created: boolean;
  reason: "created" | "already_running" | "replacement_limit";
}

const ACTIVE_STATUSES = new Set<AgentJobStatus>(["queued", "running", "cancelling"]);
const TERMINAL_STATUSES = new Set<AgentJobStatus>(["cancelled", "sent", "failed", "timed_out"]);

/** In-memory generic job store. Durable persistence can replace this without changing tools. */
export class AgentJobStore {
  private readonly jobs = new Map<string, AgentJob>();
  private readonly config: AgentJobConfig;

  constructor(config: AgentJobConfig) {
    this.config = config;
  }

  enqueueImageJob(input: EnqueueImageJobInput): EnqueueImageJobResult {
    const now = input.now ?? Date.now();
    const replacement = input.replacesJobId !== undefined ? this.get(input.replacesJobId) : undefined;
    if (replacement !== undefined && replacement.replacementCount >= this.config.maxImageReplacements) {
      return { job: replacement, created: false, reason: "replacement_limit" };
    }

    /*
     * Temporarily disabled: this hard dedupe guard has been producing false positives
     * by blocking legitimate new image requests while an unrelated image job is active.
     * Keep duplicate prevention in prompt/runtime context until a safer request matcher
     * exists.
     *
     * if (!input.separateJob && input.replacesJobId === undefined) {
     *   const existing = this.findMatchingActiveImageJob(input);
     *   if (existing !== undefined) {
     *     return { job: existing, created: false, reason: "already_running" };
     *   }
     * }
     */

    const id = this.createShortId("img");
    const replacementRootJobId = replacement?.replacementRootJobId ?? replacement?.id;
    const job: AgentJob = {
      id,
      kind: "image_generation",
      guildId: input.guildId,
      channelId: input.channelId,
      requesterId: input.requesterId,
      requesterUsername: input.requesterUsername,
      sourceMessageId: input.sourceMessageId,
      sourceQuote: input.sourceQuote,
      status: "queued",
      createdAt: now,
      input: {
        prompt: input.prompt,
        promptHash: input.promptHash,
        imageIds: input.imageIds,
        outputFormat: input.outputFormat,
        is4k: input.is4k,
        separateJob: input.separateJob,
        allowsGroupCorrections: input.allowsGroupCorrections,
        ...(input.replacesJobId !== undefined ? { replacesJobId: input.replacesJobId } : {}),
      },
      ...(replacementRootJobId !== undefined ? { replacementRootJobId } : {}),
      ...(input.replacesJobId !== undefined ? { replacesJobId: input.replacesJobId } : {}),
      replacementCount: (replacement?.replacementCount ?? -1) + 1,
    };
    this.jobs.set(job.id, job);
    return { job, created: true, reason: "created" };
  }

  get(id: string): AgentJob | undefined {
    return this.jobs.get(id);
  }

  listVisible(guildId: string, channelId: string, now = Date.now()): AgentJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.guildId === guildId && job.channelId === channelId)
      .filter((job) => this.isActive(job) || (job.completedAt !== undefined && now - job.completedAt <= this.config.terminalVisibleMs))
      .sort((a, b) => {
        const timeDiff = a.createdAt - b.createdAt;
        return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id);
      });
  }

  listActive(guildId: string, channelId: string): AgentJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.guildId === guildId && job.channelId === channelId && this.isActive(job))
      .sort((a, b) => {
        const timeDiff = a.createdAt - b.createdAt;
        return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id);
      });
  }

  start(id: string, abort?: () => void, now = Date.now()): AgentJob | undefined {
    const job = this.jobs.get(id);
    if (job === undefined || job.status !== "queued") return job;
    job.status = "running";
    job.startedAt = now;
    job.abort = abort;
    return job;
  }

  markSent(id: string, sentMessageId: string, result: ImageGenerationJobResult, now = Date.now()): AgentJob | undefined {
    const job = this.jobs.get(id);
    if (job === undefined || !this.isActive(job)) return job;
    job.status = "sent";
    job.completedAt = now;
    job.sentMessageId = sentMessageId;
    job.result = result;
    job.abort = undefined;
    return job;
  }

  markFailed(id: string, error: string, now = Date.now()): AgentJob | undefined {
    const job = this.jobs.get(id);
    if (job === undefined || TERMINAL_STATUSES.has(job.status)) return job;
    job.status = "failed";
    job.completedAt = now;
    job.error = error;
    job.abort = undefined;
    return job;
  }

  markTimedOut(id: string, error: string, now = Date.now()): AgentJob | undefined {
    const job = this.jobs.get(id);
    if (job === undefined || TERMINAL_STATUSES.has(job.status)) return job;
    job.status = "timed_out";
    job.completedAt = now;
    job.error = error;
    job.abort = undefined;
    return job;
  }

  cancel(id: string, input: { requesterId: string; reason: string; mode: CancelMode; now?: number }): { ok: boolean; message: string; job?: AgentJob } {
    const job = this.jobs.get(id);
    if (job === undefined) return { ok: false, message: `No job ${id} exists.` };
    if (!this.isActive(job)) return { ok: false, message: `Job ${id} is ${job.status} and cannot be cancelled.` };
    /*
     * Temporarily disabled: requester/group-correction authorization is too coarse
     * for replacement corrections and can block legitimate follow-up fixes. Rely on
     * the model's cancel_agent_job selection until cancellation policy is redesigned.
     *
     * if (job.requesterId !== input.requesterId && !job.input.allowsGroupCorrections) {
     *   return { ok: false, message: `Job ${id} belongs to @${job.requesterUsername}; only that requester can cancel it.` };
     * }
     */
    const now = input.now ?? Date.now();
    const ageMs = now - (job.startedAt ?? job.createdAt);
    if (input.mode === "replacement" && ageMs > this.config.imageCancelGraceMs) {
      return { ok: false, message: `Job ${id} is already ${Math.round(ageMs / 1000)}s old; do not cancel it for revisions. Start a separate variant only if explicitly requested.` };
    }
    if (input.mode === "replacement" && job.replacementCount >= this.config.maxImageReplacements) {
      return { ok: false, message: `Job ${id} has already reached the replacement limit.` };
    }

    job.status = "cancelled";
    job.completedAt = now;
    job.cancelReason = input.reason;
    job.abort?.();
    job.abort = undefined;
    return { ok: true, message: `Cancelled ${id}.`, job };
  }

  cleanup(now = Date.now()): number {
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (job.completedAt === undefined) continue;
      if (now - job.completedAt <= this.config.terminalVisibleMs) continue;
      this.jobs.delete(id);
      removed += 1;
    }
    return removed;
  }

  annotationForMessage(messageId: string, guildId: string, channelId: string, now = Date.now()): string[] {
    const jobs = this.listVisible(guildId, channelId, now)
      .filter((job) => job.sourceMessageId === messageId);
    return jobs.map((job) => `ImageJob: ${job.id} ${job.status}${job.input.is4k ? " 4K" : ""}`);
  }

  private isActive(job: AgentJob): boolean {
    return ACTIVE_STATUSES.has(job.status);
  }

  /*
   * Hard image-job dedupe is disabled above. This matcher is intentionally retained
   * as commented reference for the old behavior while we observe prompt-only handling.
   *
   * private findMatchingActiveImageJob(input: EnqueueImageJobInput): AgentJob | undefined {
   *   return this.listActive(input.guildId, input.channelId)
   *     .find((job) =>
   *       job.sourceMessageId === input.sourceMessageId
   *       || job.input.promptHash === input.promptHash
   *       || job.requesterId === input.requesterId
   *       || job.input.allowsGroupCorrections
   *     );
   * }
   */

  private createShortId(prefix: "img"): string {
    for (let i = 0; i < 10; i += 1) {
      const id = `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 6)}`;
      if (!this.jobs.has(id)) return id;
    }
    return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  }
}

const CancelAgentJobParams = Type.Object({
  job_id: Type.String({
    description: "Visible async job id, such as img-k7p2q. Must be visible in Active Image Jobs or recent history annotations.",
  }),
  reason: Type.String({
    description: "Short concrete reason from the user's message. Do not invent a cancellation reason.",
  }),
  mode: Type.Union([Type.Literal("replacement"), Type.Literal("explicit_cancel")], {
    description: "Use replacement only when the user clearly corrects/replaces an active image request. Use explicit_cancel only when the user asks to stop/cancel/never mind.",
  }),
});

/** Create the narrow cancellation tool for cancellable async jobs. */
export function createCancelAgentJobTool(deps: {
  store: AgentJobStore;
  requesterId: string;
}): AgentTool {
  return {
    name: "cancel_agent_job",
    label: "Cancel Job",
    description: [
      "Cancel a visible async job. Use this only for active image generation jobs.",
      "For replacements, cancel only when the user's new message clearly corrects or invalidates the still-young active image job.",
      "Do not cancel for status checks, jokes, unrelated chat, or late minor preferences.",
      "After a successful replacement cancellation, call codex_generate_image once with the complete revised prompt and replaces_job_id.",
    ].join(" "),
    parameters: CancelAgentJobParams,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ jobId: string; cancelled: boolean }>> => {
      const p = params as { job_id: string; reason: string; mode: CancelMode };
      const result = deps.store.cancel(p.job_id, {
        requesterId: deps.requesterId,
        reason: p.reason,
        mode: p.mode,
      });
      return Promise.resolve({
        content: [{ type: "text", text: result.message }],
        details: { jobId: p.job_id, cancelled: result.ok },
      });
    },
  };
}

export function isActiveJobStatus(status: AgentJobStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}
