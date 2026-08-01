import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.ts";
import { parseAssetId, type AssetRef } from "./asset-id.ts";
import {
  createAgentJobRecord,
  deleteExpiredUnlinkedAgentJobs,
  dismissStaleYieldedAgentJobs,
  failInterruptedAgentJobs,
  getAgentJobForAsset,
  getAgentJobRecord,
  linkAgentJobAsset,
  listAgentJobAssets,
  listAgentJobRecords,
  listOwnedImageJobRecords,
  updateAgentJobRecord,
  type AgentJobRecord,
  type PersistedAgentJobState,
} from "../db/agent-job-repository.ts";

export type AgentJobKind = "image_generation" | "persona_task";
export type AgentJobStatus =
  | "queued"
  | "running"
  | "waiting_on_jobs"
  | "ready"
  | "yielded"
  | "completed"
  | "delivered"
  | "dismissed"
  | "expired"
  | "interrupted"
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
  ownerAgentJobId?: string;
}

export interface ImageGenerationJobResult {
  stagedAssetRef?: string;
  workspacePath?: string;
  attachmentId?: string;
  filename?: string;
  contentType?: string;
  byteSize?: number;
  revisedPrompt?: string;
  requestedSize?: string;
  actualSize?: string;
  transport?: string;
  is4k?: boolean;
}

export interface AgentTaskJobInput {
  taskName: string;
  message: string;
  modelProfile?: string;
  pendingMessages: AgentPendingMessage[];
}

export type AgentPendingMessage =
  | { kind: "text"; text: string }
  | {
    kind: "image_result";
    childJobId: string;
    text: string;
    stagedAssetRef: string;
    workspacePath: string;
    contentType: string;
  };

export interface AgentTaskJobResult {
  handoff?: string;
  transcript?: unknown[];
  activeToolNames?: string[];
  yieldedAt?: number;
  notificationPending?: boolean;
  notificationDeliveredAt?: number;
}

export type AgentJobInput = ImageGenerationJobInput | AgentTaskJobInput;
export type AgentJobResult = ImageGenerationJobResult | AgentTaskJobResult;

interface AgentJobBase {
  id: string;
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
  replacementRootJobId?: string;
  replacesJobId?: string;
  replacementCount: number;
  cancelReason?: string;
}

export type ImageGenerationAgentJob = AgentJobBase & {
  kind: "image_generation";
  input: ImageGenerationJobInput;
  result?: ImageGenerationJobResult;
};
export type AgentTaskJob = AgentJobBase & {
  kind: "persona_task";
  input: AgentTaskJobInput;
  result?: AgentTaskJobResult;
};
export type AgentJob = ImageGenerationAgentJob | AgentTaskJob;

export interface AgentJobConfig {
  imageTimeoutMs: number;
  imageCancelGraceMs: number;
  terminalVisibleMs: number;
  yieldedAutoDismissMs: number;
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
  ownerAgentJobId?: string;
  now?: number;
}

export interface EnqueueAgentTaskInput {
  guildId: string;
  channelId: string;
  requesterId: string;
  requesterUsername: string;
  sourceMessageId: string;
  sourceQuote: string;
  taskName: string;
  message: string;
  modelProfile?: string;
  now?: number;
}

export type EnqueueImageJobResult =
  | {
    job: ImageGenerationAgentJob;
    created: true;
    reason: "created";
  }
  | {
    job: ImageGenerationAgentJob;
    created: false;
    reason: "replacement_limit";
    assetHistory: number[];
  };

const ACTIVE_STATUSES = new Set<AgentJobStatus>(["queued", "running", "waiting_on_jobs", "ready", "yielded"]);
const TERMINAL_STATUSES = new Set<AgentJobStatus>(["completed", "delivered", "dismissed", "expired", "interrupted", "failed"]);
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
    const candidate = input.replacesJobId !== undefined ? this.get(input.replacesJobId) : undefined;
    const replacement = candidate?.kind === "image_generation" ? candidate : undefined;
    if (replacement !== undefined && replacement.replacementCount >= this.config.maxImageReplacements) {
      return {
        job: replacement,
        created: false,
        reason: "replacement_limit",
        assetHistory: this.replacementAssetHistory(replacement),
      };
    }

    const id = this.createShortId("img");
    const replacementRootJobId = replacement?.replacementRootJobId ?? replacement?.id;
    const job: ImageGenerationAgentJob = {
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
        ...(input.ownerAgentJobId !== undefined ? { ownerAgentJobId: input.ownerAgentJobId } : {}),
      },
      ...(replacementRootJobId !== undefined ? { replacementRootJobId } : {}),
      ...(input.replacesJobId !== undefined ? { replacesJobId: input.replacesJobId } : {}),
      replacementCount: (replacement?.replacementCount ?? -1) + 1,
    };
    createAgentJobRecord(this.db, toRecord(job));
    return { job, created: true, reason: "created" };
  }

  enqueueAgentTask(input: EnqueueAgentTaskInput): AgentTaskJob {
    const job: AgentTaskJob = {
      id: this.createShortId("agent"),
      kind: "persona_task",
      guildId: input.guildId,
      channelId: input.channelId,
      deliveryGuildId: input.guildId,
      deliveryChannelId: input.channelId,
      requesterId: input.requesterId,
      requesterUsername: input.requesterUsername,
      sourceMessageId: input.sourceMessageId,
      sourceQuote: input.sourceQuote,
      status: "queued",
      createdAt: input.now ?? Date.now(),
      input: {
        taskName: input.taskName,
        message: input.message,
        pendingMessages: [],
        ...(input.modelProfile !== undefined ? { modelProfile: input.modelProfile } : {}),
      },
      replacementCount: 0,
    };
    createAgentJobRecord(this.db, toRecord(job));
    return job;
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

  listGlobalVisible(now = Date.now()): AgentJob[] {
    const active = listAgentJobRecords(this.db, { state: "active" });
    const terminal = listAgentJobRecords(this.db, {
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

  listGlobal(state: PersistedAgentJobState = "all", limit = 10): AgentJob[] {
    return listAgentJobRecords(this.db, { state, limit, newestFirst: true }).map(fromRecord);
  }

  listGlobalRecent(limit = 10, now = Date.now()): AgentJob[] {
    return listAgentJobRecords(this.db, {
      state: "terminal",
      completedAfter: now - this.config.terminalVisibleMs,
      limit,
      newestFirst: true,
    }).map(fromRecord);
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

  markYielded(id: string, result: AgentTaskJobResult, now = Date.now()): AgentJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.status !== "running" || job.kind === "image_generation") return job;
    updateAgentJobRecord(this.db, id, {
      status: "yielded",
      completedAt: now,
      resultJson: JSON.stringify({ ...result, yieldedAt: now, notificationPending: true }),
    });
    this.aborts.delete(id);
    return this.get(id);
  }

  markWaitingOnJobs(id: string, result: AgentTaskJobResult): AgentJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.status !== "running" || job.kind === "image_generation") return job;
    updateAgentJobRecord(this.db, id, {
      status: "waiting_on_jobs",
      completedAt: null,
      resultJson: JSON.stringify({ ...result, notificationPending: false }),
    });
    this.aborts.delete(id);
    return this.get(id);
  }

  markOwnedImageCompleted(id: string): AgentJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.kind !== "image_generation" || job.status !== "ready") return job;
    updateAgentJobRecord(this.db, id, { status: "completed" });
    return this.get(id);
  }

  sendAgentMessage(id: string, message: string): { job: AgentJob; shouldRun: boolean } {
    const job = this.get(id);
    if (job === undefined) throw new Error(`No job ${id} exists.`);
    if (job.kind === "image_generation") throw new Error(`Job ${id} is not an agent.`);
    if (job.status !== "running" && job.status !== "waiting_on_jobs" && job.status !== "yielded" && job.status !== "queued") {
      throw new Error(`Job ${id} is ${job.status} and cannot receive a message.`);
    }
    const pendingMessages = [...job.input.pendingMessages, { kind: "text" as const, text: message }];
    updateAgentJobRecord(this.db, id, {
      inputJson: JSON.stringify({ ...job.input, pendingMessages }),
      ...(job.status === "yielded" || job.status === "waiting_on_jobs" ? { status: "queued", completedAt: null } : {}),
    });
    const updated = this.get(id);
    if (updated === undefined) throw new Error(`Job ${id} disappeared after update.`);
    return { job: updated, shouldRun: job.status === "yielded" || job.status === "waiting_on_jobs" };
  }

  takePendingAgentMessages(id: string): AgentPendingMessage[] {
    const job = this.get(id);
    if (job === undefined || job.kind === "image_generation" || job.input.pendingMessages.length === 0) return [];
    const messages = [...job.input.pendingMessages];
    updateAgentJobRecord(this.db, id, {
      inputJson: JSON.stringify({ ...job.input, pendingMessages: [] }),
    });
    return messages;
  }

  listOwnedImageJobs(ownerAgentJobId: string): ImageGenerationAgentJob[] {
    return listOwnedImageJobRecords(this.db, ownerAgentJobId)
      .map(fromRecord)
      .filter((job): job is ImageGenerationAgentJob => job.kind === "image_generation");
  }

  queueOwnedImageResult(childJobId: string): { ownerAgentJobId?: string; shouldRun: boolean } {
    const child = this.get(childJobId);
    if (child === undefined || child.kind !== "image_generation" || child.input.ownerAgentJobId === undefined) {
      return { shouldRun: false };
    }
    const parent = this.get(child.input.ownerAgentJobId);
    if (parent === undefined || parent.kind === "image_generation") return { shouldRun: false };
    if (!ACTIVE_STATUSES.has(parent.status)) return { ownerAgentJobId: parent.id, shouldRun: false };
    const outstanding = this.listOwnedImageJobs(parent.id)
      .filter((job) => ACTIVE_STATUSES.has(job.status) && job.id !== child.id)
      .map((job) => job.id);
    const result = child.result;
    let event: AgentPendingMessage;
    if (result?.stagedAssetRef !== undefined && result.workspacePath !== undefined && result.contentType !== undefined) {
      const text = [
        `Background image job ${child.id} completed.`,
        `Staged asset ref: ${result.stagedAssetRef}.`,
        `Workspace path: ${result.workspacePath}.`,
        outstanding.length > 0 ? `Other image jobs still running: ${outstanding.join(", ")}.` : "No other image jobs remain.",
        "The staged output is already suitable for the parent handoff. Do not move it only to preserve it; include both the staged ref and workspace path in the final handoff.",
      ].join("\n");
      event = {
        kind: "image_result",
        childJobId: child.id,
        text,
        stagedAssetRef: result.stagedAssetRef,
        workspacePath: result.workspacePath,
        contentType: result.contentType,
      };
    } else {
      event = {
        kind: "text",
        text: [
          `Background image job ${child.id} ${child.status}.`,
          `Failure: ${child.error ?? child.cancelReason ?? "No image output was produced."}`,
          outstanding.length > 0 ? `Other image jobs still running: ${outstanding.join(", ")}.` : "No other image jobs remain.",
        ].join("\n"),
      };
    }
    updateAgentJobRecord(this.db, parent.id, {
      inputJson: JSON.stringify({ ...parent.input, pendingMessages: [...parent.input.pendingMessages, event] }),
      ...(parent.status === "waiting_on_jobs" || parent.status === "yielded"
        ? { status: "queued", completedAt: null }
        : {}),
    });
    return {
      ownerAgentJobId: parent.id,
      shouldRun: parent.status === "waiting_on_jobs" || parent.status === "yielded",
    };
  }

  requeueYieldedAgentWithPendingMessages(id: string): boolean {
    const job = this.get(id);
    if (job === undefined || job.kind === "image_generation" || job.status !== "yielded" || job.input.pendingMessages.length === 0) {
      return false;
    }
    updateAgentJobRecord(this.db, id, { status: "queued", completedAt: null });
    return true;
  }

  markNotificationDelivered(id: string, expectedCompletedAt?: number, now = Date.now()): void {
    const job = this.get(id);
    if (job === undefined || job.kind === "image_generation" || job.result === undefined) return;
    if (expectedCompletedAt !== undefined && job.completedAt !== expectedCompletedAt) return;
    updateAgentJobRecord(this.db, id, {
      resultJson: JSON.stringify({ ...job.result, notificationPending: false, notificationDeliveredAt: now }),
    });
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

  markAgentFailed(id: string, error: string, now = Date.now()): AgentJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.kind === "image_generation" || TERMINAL_STATUSES.has(job.status)) return job;
    updateAgentJobRecord(this.db, id, {
      status: "failed",
      completedAt: now,
      error,
      resultJson: JSON.stringify({ handoff: `Agent failed: ${error}`, notificationPending: true } satisfies AgentTaskJobResult),
    });
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
    if (job.kind !== "image_generation") {
      for (const child of this.listOwnedImageJobs(job.id)) {
        if (this.isActive(child)) this.cancel(child.id, { reason: `Parent agent ${job.id} was cancelled.`, mode: "explicit_cancel", now });
      }
    }
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

  dismissStaleYielded(now = Date.now()): number {
    return dismissStaleYieldedAgentJobs(this.db, now - this.config.yieldedAutoDismissMs, now);
  }

  annotationForMessage(messageId: string, guildId: string, channelId: string, now = Date.now()): string[] {
    const jobs = this.listVisible(guildId, channelId, now)
      .filter((job) => job.sourceMessageId === messageId);
    return jobs.map((job) => {
      const delivery = job.deliveryGuildId !== job.guildId || job.deliveryChannelId !== job.channelId
        ? ` -> channel_id ${job.deliveryChannelId}`
        : "";
      return job.kind === "image_generation"
        ? `ImageJob: ${job.id} ${job.status}${job.input.is4k ? " 4K" : ""}${job.input.ownerAgentJobId !== undefined ? ` owned by ${job.input.ownerAgentJobId}` : ""}${delivery}`
        : `AgentJob: ${job.id} ${job.kind} ${job.status}${delivery}`;
    });
  }

  private isActive(job: AgentJob): boolean {
    return ACTIVE_STATUSES.has(job.status);
  }

  private replacementAssetHistory(job: AgentJob): number[] {
    if (job.kind !== "image_generation") return [];
    const lineage: AgentJob[] = [];
    const visitedJobs = new Set<string>();
    let current: AgentJob | undefined = job;
    while (current !== undefined && !visitedJobs.has(current.id)) {
      lineage.push(current);
      visitedJobs.add(current.id);
      current = current.replacesJobId === undefined ? undefined : this.get(current.replacesJobId);
    }

    const assetHistory: number[] = [];
    const visitedAssets = new Set<number>();
    const append = (assetId: number): void => {
      if (visitedAssets.has(assetId)) return;
      visitedAssets.add(assetId);
      assetHistory.push(assetId);
    };
    for (const item of lineage.reverse()) {
      if (item.kind !== "image_generation") continue;
      for (const reference of item.input.references) {
        if (reference.type !== "asset") continue;
        const assetId = parseAssetId(reference.assetId);
        if (assetId !== null) append(assetId);
      }
      for (const asset of this.listAssets(item.id)) {
        if (asset.role === "output") append(asset.assetId);
      }
    }
    return assetHistory;
  }

  private createShortId(prefix: "img" | "agent"): string {
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
  const base: AgentJobBase = {
    id: record.id,
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
    replacementCount: record.replacementCount,
    ...(record.startedAt !== null ? { startedAt: record.startedAt } : {}),
    ...(record.completedAt !== null ? { completedAt: record.completedAt } : {}),
    ...(record.sentMessageId !== null ? { sentMessageId: record.sentMessageId } : {}),
    ...(record.error !== null ? { error: record.error } : {}),
    ...(record.replacementRootJobId !== null ? { replacementRootJobId: record.replacementRootJobId } : {}),
    ...(record.replacesJobId !== null ? { replacesJobId: record.replacesJobId } : {}),
    ...(record.cancelReason !== null ? { cancelReason: record.cancelReason } : {}),
  };
  if (record.kind === "image_generation") {
    const input = JSON.parse(record.inputJson) as ImageGenerationJobInput;
    const result = record.resultJson === null ? undefined : JSON.parse(record.resultJson) as ImageGenerationJobResult;
    return { ...base, kind: "image_generation", input, ...(result !== undefined ? { result } : {}) };
  }
  if (record.kind !== "persona_task") {
    throw new Error(`Unknown agent job kind: ${record.kind}`);
  }
  const input = JSON.parse(record.inputJson) as AgentTaskJobInput;
  const result = record.resultJson === null ? undefined : JSON.parse(record.resultJson) as AgentTaskJobResult;
  return { ...base, kind: "persona_task", input, ...(result !== undefined ? { result } : {}) };
}

const CancelAgentJobParams = Type.Object({
  job_id: Type.String(),
  reason: Type.String(),
  mode: Type.Union([Type.Literal("replacement"), Type.Literal("explicit_cancel")]),
});

/** Create the narrow cancellation tool for cancellable async jobs. */
export function createCancelAgentJobTool(deps: {
  store: AgentJobStore;
  onCancelled?: (jobId: string) => void | Promise<void>;
}): AgentTool {
  return {
    name: "cancel_agent_job",
    label: "Cancel Job",
    description: "",
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
