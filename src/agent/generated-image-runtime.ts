import type { HistoryMessage } from "./history-types";
import { isActiveJobStatus, type AgentJob, type ImageGenerationAgentJob, type ImageGenerationJobInput, type ImageReference } from "./job-runtime";
import type { GeneratedImageAttachment } from "./codex-image-tool";
import type { OutboundAttachment } from "./turn-types";
import { formatFileSize } from "./format-file-size.ts";
import { formatRelativeAgo } from "./history-dates.ts";

export const DEFAULT_CODEX_IMAGE_ROUTER_MODEL = "gpt-5.2";

export type GeneratedImageRuntime = {
  onGeneratedImage: (attachment: GeneratedImageAttachment) => void;
  consumeGeneratedAttachments: (ids: string[]) => OutboundAttachment[];
};

export function createGeneratedImageRuntime(): GeneratedImageRuntime {
  const images = new Map<string, GeneratedImageAttachment>();
  return {
    onGeneratedImage: (attachment) => {
      images.set(attachment.id, attachment);
    },
    consumeGeneratedAttachments: (ids) => {
      const attachments: OutboundAttachment[] = [];
      for (const id of ids) {
        const image = images.get(id);
        if (image === undefined) continue;
        images.delete(id);
        attachments.push({
          id: image.id,
          buffer: image.buffer,
          filename: image.filename,
          contentType: image.contentType,
          requestedSize: image.requestedSize,
          actualSize: image.actualSize,
          transport: image.transport,
          is4k: image.is4k,
        });
      }
      return attachments;
    },
  };
}

export function shortQuote(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Renders the effective user-facing image tool input for async handoffs and history. */
export function renderImageGenerationInput(input: ImageGenerationJobInput): string {
  return JSON.stringify({
    prompt: input.prompt,
    reference_images: imageReferencesForToolInput(input.references),
    output_format: input.outputFormat,
    "4k": input.is4k,
    ...(input.replacesJobId !== undefined ? { replaces_job_id: input.replacesJobId } : {}),
  });
}

export interface AsyncImageReadyMetadataInput {
  requestedSize?: string;
  requestedFormat: ImageGenerationJobInput["outputFormat"];
  actualSize?: string;
  actualContentType: string;
  byteSize: number;
  transport?: string;
  is4k: boolean;
}

export interface AsyncImageReadyMetadata {
  requestedMetadata: string;
  resultMetadata: string;
  transportLine: string;
  is4k: string;
  fourKNote: string;
}

function imageFormatLabel(contentType: string): string {
  const normalized = contentType.toLowerCase();
  if (normalized === "image/png") return "PNG";
  if (normalized === "image/jpeg") return "JPEG";
  if (normalized === "image/webp") return "WebP";
  return contentType;
}

/** Format byte-derived output facts for the async image completion context. */
export function buildAsyncImageReadyMetadata(input: AsyncImageReadyMetadataInput): AsyncImageReadyMetadata {
  const requestedContentType = input.requestedFormat === "jpeg"
    ? "image/jpeg"
    : `image/${input.requestedFormat}`;
  return {
    requestedMetadata: [
      input.requestedSize,
      imageFormatLabel(requestedContentType),
    ].filter((value) => value !== undefined).join(", "),
    resultMetadata: [
      input.actualSize,
      imageFormatLabel(input.actualContentType),
      formatFileSize(input.byteSize),
    ].filter((value) => value !== undefined).join(", "),
    transportLine: input.transport !== undefined ? `Transport: ${input.transport}\n` : "",
    is4k: input.is4k ? "yes" : "no",
    fourKNote: input.is4k
      ? " (best-effort; the provider may return a smaller image)"
      : "",
  };
}

function imageGenerationRunState(job: ImageGenerationAgentJob): string {
  if (job.status === "ready") {
    const stagedAsset = job.result?.stagedAssetRef;
    return stagedAsset === undefined
      ? "ready and not delivered"
      : `ready and not delivered; staged asset ${stagedAsset}`;
  }
  if (job.status === "delivered") {
    return job.sentMessageId === undefined
      ? "delivered"
      : `delivered in MsgID ${job.sentMessageId}`;
  }
  return job.status;
}

/** Show live sibling state without treating completion order as request order. */
export function renderImageGenerationRunContext(
  current: ImageGenerationAgentJob,
  jobs: readonly ImageGenerationAgentJob[],
): string {
  const runId = current.input.generationRunId;
  if (runId === undefined) return "";
  const ordered = jobs
    .filter((job) => job.input.generationRunId === runId)
    .slice()
    .sort((a, b) => {
      const index = (a.input.generationIndex ?? Number.MAX_SAFE_INTEGER)
        - (b.input.generationIndex ?? Number.MAX_SAFE_INTEGER);
      if (index !== 0) return index;
      const createdAtOrder = a.createdAt - b.createdAt;
      return createdAtOrder !== 0 ? createdAtOrder : a.id.localeCompare(b.id);
    });
  if (ordered.length === 0) return "";
  const currentFallbackIndex = ordered.findIndex((job) => job.id === current.id) + 1;
  const currentIndex = current.input.generationIndex ?? currentFallbackIndex;
  const lines = [
    `Current image job: ${currentIndex}/${ordered.length} ${current.id}.`,
    "Image jobs requested in the same agent loop:",
  ];
  for (const [offset, job] of ordered.entries()) {
    const index = job.input.generationIndex ?? offset + 1;
    const currentMarker = job.id === current.id ? " (current)" : "";
    lines.push(`- ${index}/${ordered.length} ${job.id}: ${imageGenerationRunState(job)}${currentMarker}`);
  }
  return lines.join("\n");
}

/** Convert normalized references back to the public image-tool input shape. */
export function imageReferencesForToolInput(references: readonly ImageReference[]): Array<Record<string, unknown>> {
  return references.map((reference) => {
    if (reference.type === "asset") return { type: reference.type, asset_id: reference.assetId };
    if (reference.type === "url") return { type: reference.type, url: reference.url };
    return { type: reference.type, user_id: reference.userId };
  });
}

function formatJobErrorForContext(error: string): string {
  const responseTextMarker = "Response text:";
  const responseTextIndex = error.indexOf(responseTextMarker);
  if (responseTextIndex >= 0) {
    const responseText = error.slice(responseTextIndex + responseTextMarker.length).trim();
    if (responseText !== "") return ` error response: "${shortQuote(responseText, 400)}"`;
  }
  return ` error: ${shortQuote(error, 200)}`;
}

function contextJobStatus(job: AgentJob): string {
  if (job.status === "yielded") return "yielded (paused)";
  if (job.status === "waiting_on_jobs") return "waiting on child jobs";
  if (job.status === "dismissed") return "dismissed (stopped)";
  return job.status;
}

function jobTime(label: string, timestamp: number | undefined, now: number): string {
  return timestamp === undefined
    ? ""
    : `; ${label} ${new Date(timestamp).toISOString()} (${formatRelativeAgo(timestamp, now)})`;
}

export function renderAgentJobsContext(
  jobs: AgentJob[],
  currentGuildId: string,
  currentChannelId: string,
  now = Date.now(),
  assetsForJob: (jobId: string) => readonly { assetId: number }[] = () => [],
): string {
  if (jobs.length === 0) return "";
  const lines = ["## Agent Jobs"];
  for (const job of jobs) {
    const state = job.status === "yielded"
      ? "resumable"
      : isActiveJobStatus(job.status) ? "active" : "recent terminal";
    const here = (job.guildId === currentGuildId && job.channelId === currentChannelId)
      || (job.deliveryGuildId === currentGuildId && job.deliveryChannelId === currentChannelId);
    const replacement = job.replacesJobId !== undefined ? ` replaces ${job.replacesJobId}` : "";
    const owner = job.parentJobId !== undefined
      ? `; parent ${job.parentJobId}`
      : "";
    const sent = job.sentMessageId !== undefined ? ` sent MsgID ${job.sentMessageId}` : "";
    const error = job.error !== undefined ? formatJobErrorForContext(job.error) : "";
    const delivery = job.deliveryGuildId !== job.guildId || job.deliveryChannelId !== job.channelId
      ? `; delivery guild ${job.deliveryGuildId} channel ${job.deliveryChannelId}`
      : "";
    const assets = assetsForJob(job.id);
    const assetText = assets.length === 0
      ? ""
      : `; assets ${assets.map((asset) => `#${asset.assetId}`).join(", ")}`;
    const yieldedAt = job.kind === "background_agent" && job.status === "yielded"
      ? job.statusChangedAt
      : undefined;
    const terminalAt = isActiveJobStatus(job.status) ? undefined : job.completedAt;
    const terminalLabel = job.status === "dismissed" ? "stopped" : "finished";
    const timing = `${jobTime("created", job.createdAt, now)}${jobTime("yielded", yieldedAt, now)}${jobTime(terminalLabel, terminalAt, now)}`;
    const work = job.kind === "image_generation"
      ? `prompt: ${JSON.stringify(shortQuote(job.input.prompt, 180))}${job.input.is4k ? "; 4K" : ""}`
      : `task ${JSON.stringify(job.input.taskName)}: ${JSON.stringify(shortQuote(job.input.message, 180))}`;
    const handoff = job.kind !== "image_generation" && job.result?.handoff !== undefined
      ? `; handoff: ${JSON.stringify(shortQuote(job.result.handoff, 180))}`
      : "";
    lines.push(
      `- ${job.id} ${job.kind} ${contextJobStatus(job)} (${state}, ${here ? "here" : "elsewhere"}) for @${job.requesterUsername}; origin guild ${job.guildId} channel ${job.channelId} MsgID ${job.sourceMessageId}${delivery}${owner}${timing}; ${work}${handoff}${replacement}${sent}${assetText}${error}`,
    );
  }
  return lines.join("\n");
}

export function annotateHistoryJobs(
  messages: HistoryMessage[],
  guildId: string,
  channelId: string,
  annotationForMessage: (messageId: string, guildId: string, channelId: string) => readonly string[],
): HistoryMessage[] {
  return messages.map((message) => {
    const annotations = annotationForMessage(message.id, guildId, channelId);
    if (annotations.length === 0) return message;
    return { ...message, jobAnnotations: [...(message.jobAnnotations ?? []), ...annotations] };
  });
}
