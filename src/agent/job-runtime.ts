import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.ts";
import type { AssetRef } from "./asset-id.ts";
import {
  createAgentJobRecord,
  deleteExpiredUnlinkedAgentJobs,
  failInterruptedAgentJobs,
  getAgentJobForAsset,
  getAgentJobRecord,
  linkAgentJobAsset,
  listAgentJobAssets,
  listAgentJobRecords,
  updateAgentJobRecord,
  type AgentJobRecord,
  type PersistedAgentJobState,
} from "../db/agent-job-repository.ts";

export type AgentJobKind = "image_generation";
export type AgentJobStatus =
  | "queued"
  | "running"
  | "ready"
  | "delivered"
  | "dismissed"
  | "expired"
  | "failed";
export type CancelMode = "replacement" | "explicit_cancel";

export type ImageReference =
  | { type: "asset"; assetId: AssetRef }
  | { type: "url"; url: string }
  | { type: "avatar"; userId: string };

export interface ImageGenerationJobInput {
  prompt: string;
  references: ImageReference[];
  outputFormat: "png" | "jpeg" | "webp";
  is4k: boolean;
  replacesJobId?: string;
}

export interface ImageGenerationJobResult {
  stagedAssetRef?: string;
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
  /** Guild/channel where the request originated and where source metadata belongs. */
  guildId: string;
  channelId: string;
  /** Guild/channel where async job progress and completion should be delivered. */
  deliveryGuildId: string;
  deliveryChannelId: string;
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
  deliveryGuildId?: string;
  deliveryChannelId?: string;
  requesterId: string;
  requesterUsername: string;
  sourceMessageId: string;
  sourceQuote: string;
  prompt: string;
  references: ImageReference[];
  outputFormat: "png" | "jpeg" | "webp";
  is4k: boolean;
  replacesJobId?: string;
  now?: number;
}

export interface EnqueueImageJobResult {
  job: AgentJob;
  created: boolean;
  reason: "created" | "replacement_limit";
}

const ACTIVE_STATUSES = new Set<AgentJobStatus>(["queued", "running", "ready"]);
const TERMINAL_STATUSES = new Set<AgentJobStatus>(["delivered", "dismissed", "expired", "failed"]);
const UNLINKED_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Durable agent-job store with process-local cancellation handles for active workers. */
export class AgentJobStore {
  private readonly db: Database;
  private readonly config: AgentJobConfig;
  private readonly aborts = new Map<string, () => void>();

  constructor(db: Database, config: AgentJobConfig) {
    this.db = db;
    this.config = config;
    failInterruptedAgentJobs(db);
  }

  enqueueImageJob(input: EnqueueImageJobInput): EnqueueImageJobResult {
    const now = input.now ?? Date.now();
    const replacement = input.replacesJobId !== undefined ? this.get(input.replacesJobId) : undefined;
    if (replacement !== undefined && replacement.replacementCount >= this.config.maxImageReplacements) {
      return { job: replacement, created: false, reason: "replacement_limit" };
    }

    const id = this.createShortId("img");
    const replacementRootJobId = replacement?.replacementRootJobId ?? replacement?.id;
    const job: AgentJob = {
      id,
      kind: "image_generation",
      guildId: input.guildId,
      channelId: input.channelId,
      deliveryGuildId: input.deliveryGuildId ?? input.guildId,
      deliveryChannelId: input.deliveryChannelId ?? input.channelId,
      requesterId: input.requesterId,
      requesterUsername: input.requesterUsername,
      sourceMessageId: input.sourceMessageId,
      sourceQuote: input.sourceQuote,
      status: "queued",
      createdAt: now,
      input: {
        prompt: input.prompt,
        references: input.references,
        outputFormat: input.outputFormat,
        is4k: input.is4k,
        ...(input.replacesJobId !== undefined ? { replacesJobId: input.replacesJobId } : {}),
      },
      ...(replacementRootJobId !== undefined ? { replacementRootJobId } : {}),
      ...(input.replacesJobId !== undefined ? { replacesJobId: input.replacesJobId } : {}),
      replacementCount: (replacement?.replacementCount ?? -1) + 1,
    };
    createAgentJobRecord(this.db, toRecord(job));
    return { job, created: true, reason: "created" };
  }

  get(id: string): AgentJob | undefined {
    const record = getAgentJobRecord(this.db, id);
    return record === null ? undefined : fromRecord(record);
  }

  listVisible(guildId: string, channelId: string, now = Date.now()): AgentJob[] {
    const active = listAgentJobRecords(this.db, { guildId, channelId, state: "active" });
    const terminal = listAgentJobRecords(this.db, {
      guildId,
      channelId,
      state: "terminal",
      completedAfter: now - this.config.terminalVisibleMs,
    });
    return [...active, ...terminal].map(fromRecord).sort(compareJobsOldestFirst);
  }

  listActive(guildId: string, channelId: string): AgentJob[] {
    return this.list(guildId, channelId, "active");
  }

  list(
    guildId: string,
    channelId: string,
    state: PersistedAgentJobState = "all",
    limit = 10,
  ): AgentJob[] {
    return listAgentJobRecords(this.db, {
      guildId,
      channelId,
      state,
      limit,
      newestFirst: true,
    }).map(fromRecord);
  }

  getVisible(id: string, guildId: string, channelId: string): AgentJob | undefined {
    const job = this.get(id);
    if (job === undefined) return undefined;
    return jobIsInScope(job, guildId, channelId) ? job : undefined;
  }

  start(id: string, abort?: () => void, now = Date.now()): AgentJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.status !== "queued") return job;
    updateAgentJobRecord(this.db, id, { status: "running", startedAt: now });
    if (abort !== undefined) this.aborts.set(id, abort);
    return this.get(id);
  }

  markReady(id: string, result: ImageGenerationJobResult, now = Date.now()): AgentJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.status !== "running") return job;
    updateAgentJobRecord(this.db, id, {
      status: "ready",
      completedAt: now,
      resultJson: JSON.stringify(result),
    });
    this.aborts.delete(id);
    return this.get(id);
  }

  markDelivered(id: string, sentMessageId: string, result: ImageGenerationJobResult, now = Date.now()): AgentJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.status !== "ready") return job;
    updateAgentJobRecord(this.db, id, {
      status: "delivered",
      completedAt: now,
      sentMessageId,
      resultJson: JSON.stringify(result),
    });
    return this.get(id);
  }

  markFailed(id: string, error: string, now = Date.now()): AgentJob | undefined {
    const job = this.get(id);
    if (job === undefined || TERMINAL_STATUSES.has(job.status)) return job;
    updateAgentJobRecord(this.db, id, { status: "failed", completedAt: now, error });
    this.aborts.delete(id);
    return this.get(id);
  }

  markExpired(id: string, now = Date.now()): AgentJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.status !== "ready") return job;
    updateAgentJobRecord(this.db, id, {
      status: "expired",
      completedAt: now,
      error: "Staged output expired before delivery.",
    });
    return this.get(id);
  }

  cancel(id: string, input: { reason: string; mode: CancelMode; now?: number }): { ok: boolean; message: string; job?: AgentJob } {
    const job = this.get(id);
    if (job === undefined) return { ok: false, message: `No job ${id} exists.` };
    if (!this.isActive(job)) return { ok: false, message: `Job ${id} is ${job.status} and cannot be cancelled.` };
    const now = input.now ?? Date.now();
    const ageMs = now - (job.startedAt ?? job.createdAt);
    if (input.mode === "replacement" && ageMs > this.config.imageCancelGraceMs) {
      return { ok: false, message: `Job ${id} is already ${Math.round(ageMs / 1000)}s old; do not cancel it for revisions, and start a separate variant only if explicitly requested.` };
    }
    if (input.mode === "replacement" && job.replacementCount >= this.config.maxImageReplacements) {
      return { ok: false, message: `Job ${id} has already reached the replacement limit.` };
    }

    updateAgentJobRecord(this.db, id, {
      status: "dismissed",
      completedAt: now,
      cancelReason: input.reason,
    });
    this.aborts.get(id)?.();
    this.aborts.delete(id);
    return { ok: true, message: `Cancelled ${id}.`, job: this.get(id) };
  }

  linkAsset(jobId: string, assetId: number, role = "output"): void {
    linkAgentJobAsset(this.db, jobId, assetId, role);
  }

  listAssets(jobId: string): Array<{ assetId: number; role: string }> {
    return listAgentJobAssets(this.db, jobId);
  }

  getForAsset(assetId: number): { job: AgentJob; role: string } | undefined {
    const linked = getAgentJobForAsset(this.db, assetId);
    return linked === null ? undefined : { job: fromRecord(linked.record), role: linked.role };
  }

  cleanup(now = Date.now()): number {
    return deleteExpiredUnlinkedAgentJobs(this.db, now - UNLINKED_TERMINAL_RETENTION_MS);
  }

  annotationForMessage(messageId: string, guildId: string, channelId: string, now = Date.now()): string[] {
    const jobs = this.listVisible(guildId, channelId, now)
      .filter((job) => job.sourceMessageId === messageId);
    return jobs.map((job) => {
      const delivery = job.deliveryGuildId !== job.guildId || job.deliveryChannelId !== job.channelId
        ? ` -> channel_id ${job.deliveryChannelId}`
        : "";
      return `ImageJob: ${job.id} ${job.status}${job.input.is4k ? " 4K" : ""}${delivery}`;
    });
  }

  private isActive(job: AgentJob): boolean {
    return ACTIVE_STATUSES.has(job.status);
  }

  private createShortId(prefix: "img"): string {
    for (let i = 0; i < 10; i += 1) {
      const id = `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 6)}`;
      if (this.get(id) === undefined) return id;
    }
    return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  }
}

function compareJobsOldestFirst(a: AgentJob, b: AgentJob): number {
  const timeDiff = a.createdAt - b.createdAt;
  return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id);
}

function jobIsInScope(job: AgentJob, guildId: string, channelId: string): boolean {
  return (job.guildId === guildId && job.channelId === channelId)
    || (job.deliveryGuildId === guildId && job.deliveryChannelId === channelId);
}

function toRecord(job: AgentJob): AgentJobRecord {
  return {
    id: job.id,
    kind: job.kind,
    guildId: job.guildId,
    channelId: job.channelId,
    deliveryGuildId: job.deliveryGuildId,
    deliveryChannelId: job.deliveryChannelId,
    requesterId: job.requesterId,
    requesterUsername: job.requesterUsername,
    sourceMessageId: job.sourceMessageId,
    sourceQuote: job.sourceQuote,
    status: job.status,
    inputJson: JSON.stringify(job.input),
    resultJson: job.result === undefined ? null : JSON.stringify(job.result),
    error: job.error ?? null,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    sentMessageId: job.sentMessageId ?? null,
    replacementRootJobId: job.replacementRootJobId ?? null,
    replacesJobId: job.replacesJobId ?? null,
    replacementCount: job.replacementCount,
    cancelReason: job.cancelReason ?? null,
  };
}

function fromRecord(record: AgentJobRecord): AgentJob {
  const input = JSON.parse(record.inputJson) as ImageGenerationJobInput;
  const result = record.resultJson === null
    ? undefined
    : JSON.parse(record.resultJson) as ImageGenerationJobResult;
  return {
    id: record.id,
    kind: record.kind as AgentJobKind,
    guildId: record.guildId,
    channelId: record.channelId,
    deliveryGuildId: record.deliveryGuildId,
    deliveryChannelId: record.deliveryChannelId,
    requesterId: record.requesterId,
    requesterUsername: record.requesterUsername,
    sourceMessageId: record.sourceMessageId,
    sourceQuote: record.sourceQuote,
    status: record.status as AgentJobStatus,
    createdAt: record.createdAt,
    input,
    replacementCount: record.replacementCount,
    ...(record.startedAt !== null ? { startedAt: record.startedAt } : {}),
    ...(record.completedAt !== null ? { completedAt: record.completedAt } : {}),
    ...(record.sentMessageId !== null ? { sentMessageId: record.sentMessageId } : {}),
    ...(record.error !== null ? { error: record.error } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(record.replacementRootJobId !== null ? { replacementRootJobId: record.replacementRootJobId } : {}),
    ...(record.replacesJobId !== null ? { replacesJobId: record.replacesJobId } : {}),
    ...(record.cancelReason !== null ? { cancelReason: record.cancelReason } : {}),
  };
}

const CancelAgentJobParams = Type.Object({
  job_id: Type.String({
    description: "Visible async job id.",
  }),
  reason: Type.String({
    description: "Short concrete cancellation reason.",
  }),
  mode: Type.Union([Type.Literal("replacement"), Type.Literal("explicit_cancel")], {
    description: "Cancellation mode.",
  }),
});

/** Create the narrow cancellation tool for cancellable async jobs. */
export function createCancelAgentJobTool(deps: {
  store: AgentJobStore;
  onCancelled?: (jobId: string) => void | Promise<void>;
}): AgentTool {
  return {
    name: "cancel_agent_job",
    label: "Cancel Job",
    description: "Cancel a visible async job.",
    parameters: CancelAgentJobParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<{ jobId: string; cancelled: boolean }>> {
      const p = params as { job_id: string; reason: string; mode: CancelMode };
      const result = deps.store.cancel(p.job_id, {
        reason: p.reason,
        mode: p.mode,
      });
      if (result.ok) await deps.onCancelled?.(p.job_id);
      return {
        content: [{ type: "text", text: result.message }],
        details: { jobId: p.job_id, cancelled: result.ok },
      };
    },
  };
}

export function isActiveJobStatus(status: AgentJobStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}
