import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.ts";
import { parseAssetId, type AssetRef } from "./asset-id.ts";
import {
  consumeAgentJobEvents,
  createAgentJobEvent,
  createAgentJobRecord,
  deleteExpiredUnlinkedAgentJobs,
  dismissStaleYieldedAgentJobs,
  requeueInterruptedAgentJobs,
  getAgentJobForAsset,
  getAgentJobRecord,
  linkAgentJobAsset,
  listAgentJobAssets,
  listAgentJobRecords,
  listChildAgentJobRecords,
  listPendingAgentJobEvents,
  updateAgentJobRecord,
  type AgentJobRecord,
  type PersistedAgentJobState,
} from "../db/agent-job-repository.ts";

export type AgentJobKind = "image_generation" | "background_agent";
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
  | "failed";

export type BackgroundHandoffTarget =
  | { kind: "channel"; guildId: string; channelId: string }
  | { kind: "private_life"; guildId: string; channelId: string; episodeId: string };

export type ImageReference =
  | { type: "asset"; assetId: AssetRef }
  | { type: "url"; url: string }
  | { type: "avatar"; userId: string };

export interface ImageGenerationJobInput {
  prompt: string;
  references: ImageReference[];
  outputFormat: "png" | "jpeg" | "webp";
  is4k: boolean;
  generationRunId?: string;
  generationIndex?: number;
  replacesJobId?: string;
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

export interface BackgroundAgentJobInput {
  taskName: string;
  message: string;
  handoffTarget: BackgroundHandoffTarget;
  modelProfile?: string;
}

export interface BackgroundAgentCheckpoint {
  transcript: unknown[];
  activeToolNames: string[];
  loadedSkillIds: string[];
}

export interface BackgroundAgentJobResult {
  handoff: string;
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

interface AgentJobBase {
  id: string;
  parentJobId?: string;
  guildId: string;
  channelId: string;
  deliveryGuildId: string;
  deliveryChannelId: string;
  requesterId: string;
  requesterUsername: string;
  sourceMessageId: string;
  sourceQuote: string;
  status: AgentJobStatus;
  createdAt: number;
  statusChangedAt: number;
  startedAt?: number;
  completedAt?: number;
  handoffNotifiedAt?: number;
  sentMessageId?: string;
  error?: string;
  replacementRootJobId?: string;
  replacesJobId?: string;
  replacementCount: number;
  cancelReason?: string;
}

export type ImageGenerationAgentJob = AgentJobBase & {
  kind: "image_generation";
  readyNotificationPending: boolean;
  input: ImageGenerationJobInput;
  result?: ImageGenerationJobResult;
};

export type BackgroundAgentJob = AgentJobBase & {
  kind: "background_agent";
  input: BackgroundAgentJobInput;
  checkpoint?: BackgroundAgentCheckpoint;
  result?: BackgroundAgentJobResult;
};

export type AgentJob = ImageGenerationAgentJob | BackgroundAgentJob;

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
  generationRunId?: string;
  generationIndex?: number;
  replacesJobId?: string;
  parentJobId?: string;
  now?: number;
}

export interface EnqueueBackgroundAgentInput {
  guildId: string;
  channelId: string;
  requesterId: string;
  requesterUsername: string;
  sourceMessageId: string;
  sourceQuote: string;
  taskName: string;
  message: string;
  handoffTarget: BackgroundHandoffTarget;
  parentJobId?: string;
  modelProfile?: string;
  now?: number;
}

export type EnqueueImageJobResult =
  | { job: ImageGenerationAgentJob; created: true; reason: "created" }
  | {
    job: ImageGenerationAgentJob;
    created: false;
    reason: "replacement_limit" | "replacement_too_old";
    assetHistory: number[];
  };

export interface PendingAgentEvent {
  id: number;
  message: AgentPendingMessage;
}

const ACTIVE_STATUSES = new Set<AgentJobStatus>(["queued", "running", "waiting_on_jobs", "ready", "yielded"]);
const CANCELLABLE_STATUSES = new Set<AgentJobStatus>(["queued", "running", "waiting_on_jobs"]);
const TERMINAL_STATUSES = new Set<AgentJobStatus>(["completed", "delivered", "dismissed", "expired", "failed"]);
const IN_FLIGHT_CHILD_STATUSES = new Set<AgentJobStatus>(["queued", "running", "waiting_on_jobs", "ready"]);
const UNLINKED_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Durable job store. Each lifecycle change has one owner here. */
export class AgentJobStore {
  private readonly aborts = new Map<string, () => void>();

  constructor(private readonly db: Database, private readonly config: AgentJobConfig) {
    requeueInterruptedAgentJobs(db);
  }

  enqueueImageJob(input: EnqueueImageJobInput): EnqueueImageJobResult {
    const now = input.now ?? Date.now();
    const candidate = input.replacesJobId === undefined ? undefined : this.get(input.replacesJobId);
    const replacement = candidate?.kind === "image_generation" ? candidate : undefined;
    if (replacement !== undefined && replacement.replacementCount >= this.config.maxImageReplacements) {
      return { job: replacement, created: false, reason: "replacement_limit", assetHistory: this.replacementAssetHistory(replacement) };
    }
    if (replacement !== undefined && CANCELLABLE_STATUSES.has(replacement.status)) {
      const ageMs = now - (replacement.startedAt ?? replacement.createdAt);
      if (ageMs > this.config.imageCancelGraceMs) {
        return { job: replacement, created: false, reason: "replacement_too_old", assetHistory: this.replacementAssetHistory(replacement) };
      }
    }

    const replacementRootJobId = replacement?.replacementRootJobId ?? replacement?.id;
    const job: ImageGenerationAgentJob = {
      id: this.createShortId("img"),
      kind: "image_generation",
      ...(input.parentJobId !== undefined ? { parentJobId: input.parentJobId } : {}),
      guildId: input.guildId,
      channelId: input.channelId,
      deliveryGuildId: input.deliveryGuildId ?? input.guildId,
      deliveryChannelId: input.deliveryChannelId ?? input.channelId,
      requesterId: input.requesterId,
      requesterUsername: input.requesterUsername,
      sourceMessageId: input.sourceMessageId,
      sourceQuote: input.sourceQuote,
      status: "queued",
      readyNotificationPending: false,
      createdAt: now,
      statusChangedAt: now,
      input: {
        prompt: input.prompt,
        references: input.references,
        outputFormat: input.outputFormat,
        is4k: input.is4k,
        ...(input.generationRunId !== undefined ? { generationRunId: input.generationRunId } : {}),
        ...(input.generationIndex !== undefined ? { generationIndex: input.generationIndex } : {}),
        ...(input.replacesJobId !== undefined ? { replacesJobId: input.replacesJobId } : {}),
      },
      ...(replacementRootJobId !== undefined ? { replacementRootJobId } : {}),
      ...(input.replacesJobId !== undefined ? { replacesJobId: input.replacesJobId } : {}),
      replacementCount: (replacement?.replacementCount ?? -1) + 1,
    };

    const insert = this.db.raw.transaction(() => {
      createAgentJobRecord(this.db, toRecord(job));
      if (replacement !== undefined && CANCELLABLE_STATUSES.has(replacement.status)) {
        updateAgentJobRecord(this.db, replacement.id, {
          status: "dismissed",
          completedAt: now,
          statusChangedAt: now,
          cancelReason: `Replaced by ${job.id}.`,
        });
      }
    });
    insert();
    if (replacement !== undefined && CANCELLABLE_STATUSES.has(replacement.status)) {
      this.aborts.get(replacement.id)?.();
      this.aborts.delete(replacement.id);
    }
    return { job, created: true, reason: "created" };
  }

  enqueueBackgroundAgent(input: EnqueueBackgroundAgentInput): BackgroundAgentJob {
    const now = input.now ?? Date.now();
    const job: BackgroundAgentJob = {
      id: this.createShortId("agent"),
      kind: "background_agent",
      ...(input.parentJobId !== undefined ? { parentJobId: input.parentJobId } : {}),
      guildId: input.guildId,
      channelId: input.channelId,
      deliveryGuildId: input.guildId,
      deliveryChannelId: input.channelId,
      requesterId: input.requesterId,
      requesterUsername: input.requesterUsername,
      sourceMessageId: input.sourceMessageId,
      sourceQuote: input.sourceQuote,
      status: "queued",
      createdAt: now,
      statusChangedAt: now,
      input: {
        taskName: input.taskName,
        message: input.message,
        handoffTarget: input.handoffTarget,
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
      guildId, channelId, state: "terminal", completedAfter: now - this.config.terminalVisibleMs,
    });
    return [...active, ...terminal].map(fromRecord).sort(compareJobsOldestFirst);
  }

  listGlobalVisible(now = Date.now()): AgentJob[] {
    const active = listAgentJobRecords(this.db, { state: "active" });
    const terminal = listAgentJobRecords(this.db, {
      state: "terminal", completedAfter: now - this.config.terminalVisibleMs,
    });
    return [...active, ...terminal].map(fromRecord).sort(compareJobsOldestFirst);
  }

  list(guildId: string, channelId: string, state: PersistedAgentJobState = "all", limit = 10): AgentJob[] {
    return listAgentJobRecords(this.db, { guildId, channelId, state, limit, newestFirst: true }).map(fromRecord);
  }

  listGlobal(state: PersistedAgentJobState = "all", limit = 10): AgentJob[] {
    return listAgentJobRecords(this.db, { state, limit, newestFirst: true }).map(fromRecord);
  }

  listGlobalRecent(limit = 10, now = Date.now()): AgentJob[] {
    return listAgentJobRecords(this.db, {
      state: "terminal", completedAfter: now - this.config.terminalVisibleMs, limit, newestFirst: true,
    }).map(fromRecord);
  }

  listChildren(parentJobId: string): AgentJob[] {
    return listChildAgentJobRecords(this.db, parentJobId).map(fromRecord);
  }

  /** List image jobs requested by one model loop in stable request order. */
  listImageGenerationRun(generationRunId: string): ImageGenerationAgentJob[] {
    return listAgentJobRecords(this.db, { imageGenerationRunId: generationRunId })
      .map(fromRecord)
      .filter((job): job is ImageGenerationAgentJob => job.kind === "image_generation")
      .sort((a, b) => {
        const index = (a.input.generationIndex ?? Number.MAX_SAFE_INTEGER)
          - (b.input.generationIndex ?? Number.MAX_SAFE_INTEGER);
        return index === 0 ? compareJobsOldestFirst(a, b) : index;
      });
  }

  /** List workers and ready notifications that still need restart recovery. */
  listRecoverableImageJobIds(): string[] {
    return (this.db.raw.prepare(`SELECT id FROM agent_jobs
      WHERE kind = 'image_generation'
        AND (status = 'queued' OR (status = 'ready' AND ready_notification_pending = 1))
      ORDER BY completed_at ASC, created_at ASC`).all() as Array<{ id: string }>).map((row) => row.id);
  }

  start(id: string, abort?: () => void, now = Date.now()): AgentJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.status !== "queued") return job;
    updateAgentJobRecord(this.db, id, {
      status: "running",
      startedAt: job.startedAt ?? now,
      completedAt: null,
      statusChangedAt: now,
    });
    if (abort !== undefined) this.aborts.set(id, abort);
    return this.get(id);
  }

  markReady(id: string, result: ImageGenerationJobResult, now = Date.now()): AgentJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.kind !== "image_generation" || job.status !== "running") return job;
    updateAgentJobRecord(this.db, id, {
      status: "ready",
      completedAt: null,
      statusChangedAt: now,
      resultJson: JSON.stringify(result),
      readyNotificationPending: 1,
    });
    this.aborts.delete(id);
    return this.get(id);
  }

  markReadyNotificationHandled(id: string, expectedStatusChangedAt: number): boolean {
    const job = this.get(id);
    if (job === undefined
        || job.kind !== "image_generation"
        || job.status !== "ready"
        || !job.readyNotificationPending
        || job.statusChangedAt !== expectedStatusChangedAt) {
      return false;
    }
    return updateAgentJobRecord(this.db, id, { readyNotificationPending: 0 });
  }

  pendingEvents(id: string): PendingAgentEvent[] {
    return listPendingAgentJobEvents(this.db, id).map((event) => ({
      id: event.id,
      message: JSON.parse(event.payloadJson) as AgentPendingMessage,
    }));
  }

  sendAgentMessage(id: string, message: string, now = Date.now()): { job: AgentJob; shouldRun: boolean } {
    const job = this.get(id);
    if (job === undefined) throw new Error(`No job ${id} exists.`);
    if (job.kind !== "background_agent") throw new Error(`Job ${id} is not a background agent.`);
    if (!["running", "waiting_on_jobs", "yielded", "queued"].includes(job.status)) {
      throw new Error(`Job ${id} is ${job.status} and cannot receive a message.`);
    }
    const shouldRun = job.status === "waiting_on_jobs" || job.status === "yielded";
    const write = this.db.raw.transaction(() => {
      createAgentJobEvent(this.db, {
        jobId: id, kind: "message", payloadJson: JSON.stringify({ kind: "text", text: message } satisfies AgentPendingMessage), createdAt: now,
      });
      if (shouldRun) {
        updateAgentJobRecord(this.db, id, {
          status: "queued", completedAt: null, statusChangedAt: now, handoffNotifiedAt: null,
        });
      }
    });
    write();
    const updated = this.get(id);
    if (updated === undefined) throw new Error(`Job ${id} disappeared after update.`);
    return { job: updated, shouldRun };
  }

  finishBackgroundRun(id: string, input: {
    checkpoint: BackgroundAgentCheckpoint;
    handoff: string;
    consumedEventIds: readonly number[];
    now?: number;
  }): { job?: BackgroundAgentJob; shouldRun: boolean; parentJobId?: string } {
    const now = input.now ?? Date.now();
    const current = this.get(id);
    if (current === undefined || current.kind !== "background_agent" || current.status !== "running") {
      return { shouldRun: false };
    }
    const finish = this.db.raw.transaction(() => {
      consumeAgentJobEvents(this.db, id, input.consumedEventIds, now);
      const hasPending = listPendingAgentJobEvents(this.db, id).length > 0;
      const hasInflightChildren = listChildAgentJobRecords(this.db, id)
        .some((record) => IN_FLIGHT_CHILD_STATUSES.has(record.status as AgentJobStatus));
      const nextStatus: "queued" | "waiting_on_jobs" | "yielded" = hasPending
        ? "queued"
        : hasInflightChildren
          ? "waiting_on_jobs"
          : "yielded";
      updateAgentJobRecord(this.db, id, {
        status: nextStatus,
        checkpointJson: JSON.stringify(input.checkpoint),
        resultJson: JSON.stringify({ handoff: input.handoff } satisfies BackgroundAgentJobResult),
        completedAt: null,
        statusChangedAt: now,
        handoffNotifiedAt: nextStatus === "yielded" ? null : current.handoffNotifiedAt ?? null,
      });
      return nextStatus;
    });
    const nextStatus = finish();
    this.aborts.delete(id);
    if (nextStatus === "yielded" && current.parentJobId !== undefined) this.publishChildResult(id, now);
    const job = this.get(id);
    return {
      ...(job?.kind === "background_agent" ? { job } : {}),
      shouldRun: nextStatus === "queued",
      ...(current.parentJobId !== undefined ? { parentJobId: current.parentJobId } : {}),
    };
  }

  publishChildResult(childJobId: string, now = Date.now()): { parentJobId?: string; shouldRun: boolean } {
    const child = this.get(childJobId);
    if (child?.parentJobId === undefined) return { shouldRun: false };
    const parent = this.get(child.parentJobId);
    if (parent === undefined || parent.kind !== "background_agent" || !ACTIVE_STATUSES.has(parent.status)) {
      return { parentJobId: child.parentJobId, shouldRun: false };
    }
    const otherInflight = this.listChildren(parent.id)
      .filter((job) => job.id !== child.id && IN_FLIGHT_CHILD_STATUSES.has(job.status))
      .map((job) => job.id);
    const message = childResultMessage(child, otherInflight);
    const shouldRun = parent.status === "waiting_on_jobs" || parent.status === "yielded";
    const publish = this.db.raw.transaction(() => {
      if (child.kind === "image_generation" && child.status === "ready") {
        updateAgentJobRecord(this.db, child.id, {
          status: "completed", completedAt: now, statusChangedAt: now,
        });
      }
      if (child.kind === "background_agent" && child.handoffNotifiedAt === undefined) {
        updateAgentJobRecord(this.db, child.id, { handoffNotifiedAt: now });
      }
      createAgentJobEvent(this.db, {
        jobId: parent.id,
        sourceJobId: child.id,
        kind: "child_result",
        payloadJson: JSON.stringify(message),
        createdAt: now,
      });
      if (shouldRun) {
        updateAgentJobRecord(this.db, parent.id, {
          status: "queued", completedAt: null, statusChangedAt: now, handoffNotifiedAt: null,
        });
      }
    });
    publish();
    return { parentJobId: parent.id, shouldRun };
  }

  markNotificationDelivered(id: string, expectedStatusChangedAt?: number, now = Date.now()): void {
    const job = this.get(id);
    if (job === undefined || job.kind !== "background_agent") return;
    if (expectedStatusChangedAt !== undefined && job.statusChangedAt !== expectedStatusChangedAt) return;
    updateAgentJobRecord(this.db, id, { handoffNotifiedAt: now });
  }

  markDelivered(id: string, sentMessageId: string, result: ImageGenerationJobResult, now = Date.now()): AgentJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.kind !== "image_generation" || job.status !== "ready") return job;
    updateAgentJobRecord(this.db, id, {
      status: "delivered", completedAt: now, statusChangedAt: now, sentMessageId, resultJson: JSON.stringify(result),
    });
    return this.get(id);
  }

  markFailed(id: string, error: string, now = Date.now()): AgentJob | undefined {
    const job = this.get(id);
    if (job === undefined || TERMINAL_STATUSES.has(job.status)) return job;
    updateAgentJobRecord(this.db, id, {
      status: "failed", completedAt: now, statusChangedAt: now, error,
    });
    this.aborts.delete(id);
    return this.get(id);
  }

  markBackgroundFailed(id: string, error: string, now = Date.now()): BackgroundAgentJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.kind !== "background_agent" || TERMINAL_STATUSES.has(job.status)) return undefined;
    updateAgentJobRecord(this.db, id, {
      status: "failed",
      completedAt: now,
      statusChangedAt: now,
      error,
      resultJson: JSON.stringify({ handoff: `Agent failed: ${error}` } satisfies BackgroundAgentJobResult),
      handoffNotifiedAt: null,
    });
    this.aborts.delete(id);
    if (job.parentJobId !== undefined) this.publishChildResult(id, now);
    const updated = this.get(id);
    return updated?.kind === "background_agent" ? updated : undefined;
  }

  markExpired(id: string, now = Date.now()): AgentJob | undefined {
    const job = this.get(id);
    if (job === undefined || job.status !== "ready") return job;
    updateAgentJobRecord(this.db, id, {
      status: "expired", completedAt: now, statusChangedAt: now, error: "Staged output expired before delivery.",
    });
    return this.get(id);
  }

  cancel(id: string, reason: string, now = Date.now()): { ok: boolean; message: string; job?: AgentJob } {
    const job = this.get(id);
    if (job === undefined) return { ok: false, message: `No job ${id} exists.` };
    if (!CANCELLABLE_STATUSES.has(job.status)) {
      return { ok: false, message: `Job ${id} is ${job.status} and cannot be cancelled.` };
    }
    updateAgentJobRecord(this.db, id, {
      status: "dismissed", completedAt: now, statusChangedAt: now, cancelReason: reason,
    });
    this.aborts.get(id)?.();
    this.aborts.delete(id);
    for (const child of this.listChildren(id)) {
      if (CANCELLABLE_STATUSES.has(child.status)) this.cancel(child.id, `Parent agent ${id} was cancelled.`, now);
      else if (child.status === "ready" || child.status === "yielded") this.dismiss(child.id, `Parent agent ${id} was cancelled.`, now);
    }
    return { ok: true, message: `Cancelled ${id}.`, job: this.get(id) };
  }

  dismiss(id: string, reason: string, now = Date.now()): { ok: boolean; message: string; job?: AgentJob } {
    const job = this.get(id);
    if (job === undefined) return { ok: false, message: `No job ${id} exists.` };
    if (job.status !== "ready" && job.status !== "yielded") {
      return { ok: false, message: `Job ${id} is ${job.status}; only ready or yielded jobs can be dismissed.` };
    }
    updateAgentJobRecord(this.db, id, {
      status: "dismissed", completedAt: now, statusChangedAt: now, cancelReason: reason,
    });
    return { ok: true, message: `Dismissed ${id}.`, job: this.get(id) };
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
    return this.listVisible(guildId, channelId, now)
      .filter((job) => job.sourceMessageId === messageId)
      .map((job) => {
        const delivery = job.deliveryGuildId !== job.guildId || job.deliveryChannelId !== job.channelId
          ? ` -> channel_id ${job.deliveryChannelId}`
          : "";
        const parent = job.parentJobId === undefined ? "" : ` child of ${job.parentJobId}`;
        return job.kind === "image_generation"
          ? `ImageJob: ${job.id} ${job.status}${job.input.is4k ? " 4K" : ""}${parent}${delivery}`
          : `AgentJob: ${job.id} ${job.status}${parent}${delivery}`;
      });
  }

  private replacementAssetHistory(job: ImageGenerationAgentJob): number[] {
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
      for (const asset of this.listAssets(item.id)) if (asset.role === "output") append(asset.assetId);
    }
    return assetHistory;
  }

  private createShortId(prefix: "img" | "agent"): string {
    for (let i = 0; i < 10; i += 1) {
      const id = `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 6)}`;
      if (this.get(id) === undefined) return id;
    }
    return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  }
}

function childResultMessage(child: AgentJob, outstanding: readonly string[]): AgentPendingMessage {
  const remaining = outstanding.length > 0
    ? `Other child jobs still running: ${outstanding.join(", ")}.`
    : "No other child jobs remain.";
  if (
    child.kind === "image_generation"
    && child.result?.stagedAssetRef !== undefined
    && child.result.workspacePath !== undefined
    && child.result.contentType !== undefined
  ) {
    return {
      kind: "image_result",
      childJobId: child.id,
      text: [
        `Background image job ${child.id} completed.`,
        `Staged asset ref: ${child.result.stagedAssetRef}.`,
        `Workspace path: ${child.result.workspacePath}.`,
        remaining,
        "The staged output is ready for handoff. Include its staged ref and workspace path; do not move it only to preserve it.",
      ].join("\n"),
      stagedAssetRef: child.result.stagedAssetRef,
      workspacePath: child.result.workspacePath,
      contentType: child.result.contentType,
    };
  }
  const handoff = child.kind === "background_agent" ? child.result?.handoff : undefined;
  return {
    kind: "text",
    text: [
      `Child job ${child.id} (${child.kind}) ${child.status}.`,
      handoff !== undefined ? `Handoff:\n${handoff}` : `Result: ${child.error ?? child.cancelReason ?? "No output was produced."}`,
      remaining,
    ].join("\n"),
  };
}

function compareJobsOldestFirst(a: AgentJob, b: AgentJob): number {
  const time = a.createdAt - b.createdAt;
  return time === 0 ? a.id.localeCompare(b.id) : time;
}

function toRecord(job: AgentJob): AgentJobRecord {
  return {
    id: job.id,
    kind: job.kind,
    parentJobId: job.parentJobId ?? null,
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
    checkpointJson: job.kind === "background_agent" && job.checkpoint !== undefined ? JSON.stringify(job.checkpoint) : null,
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
    statusChangedAt: job.statusChangedAt,
    handoffNotifiedAt: job.handoffNotifiedAt ?? null,
    readyNotificationPending: job.kind === "image_generation" && job.readyNotificationPending ? 1 : 0,
  };
}

function fromRecord(record: AgentJobRecord): AgentJob {
  const base: AgentJobBase = {
    id: record.id,
    ...(record.parentJobId !== null ? { parentJobId: record.parentJobId } : {}),
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
    statusChangedAt: record.statusChangedAt,
    replacementCount: record.replacementCount,
    ...(record.startedAt !== null ? { startedAt: record.startedAt } : {}),
    ...(record.completedAt !== null ? { completedAt: record.completedAt } : {}),
    ...(record.handoffNotifiedAt !== null ? { handoffNotifiedAt: record.handoffNotifiedAt } : {}),
    ...(record.sentMessageId !== null ? { sentMessageId: record.sentMessageId } : {}),
    ...(record.error !== null ? { error: record.error } : {}),
    ...(record.replacementRootJobId !== null ? { replacementRootJobId: record.replacementRootJobId } : {}),
    ...(record.replacesJobId !== null ? { replacesJobId: record.replacesJobId } : {}),
    ...(record.cancelReason !== null ? { cancelReason: record.cancelReason } : {}),
  };
  if (record.kind === "image_generation") {
    const input = JSON.parse(record.inputJson) as ImageGenerationJobInput;
    const result = record.resultJson === null ? undefined : JSON.parse(record.resultJson) as ImageGenerationJobResult;
    return {
      ...base,
      kind: "image_generation",
      readyNotificationPending: record.readyNotificationPending === 1,
      input,
      ...(result !== undefined ? { result } : {}),
    };
  }
  if (record.kind !== "background_agent") throw new Error(`Unknown agent job kind: ${record.kind}`);
  const input = JSON.parse(record.inputJson) as BackgroundAgentJobInput;
  const checkpoint = record.checkpointJson === null ? undefined : JSON.parse(record.checkpointJson) as BackgroundAgentCheckpoint;
  const result = record.resultJson === null ? undefined : JSON.parse(record.resultJson) as BackgroundAgentJobResult;
  return {
    ...base,
    kind: "background_agent",
    input,
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(result !== undefined ? { result } : {}),
  };
}

const CancelAgentJobParams = Type.Object({
  job_id: Type.String(),
  reason: Type.String(),
});

/** Create the narrow cancellation tool for active async jobs. */
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
      const request = params as { job_id: string; reason: string };
      const result = deps.store.cancel(request.job_id, request.reason);
      if (result.ok) await deps.onCancelled?.(request.job_id);
      return {
        content: [{ type: "text", text: result.message }],
        details: { jobId: request.job_id, cancelled: result.ok },
      };
    },
  };
}

export function isActiveJobStatus(status: AgentJobStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}
