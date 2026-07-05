import type { HistoryMessage } from "./history-types";
import { isActiveJobStatus, type AgentJob } from "./job-runtime";
import type { GeneratedImageAttachment } from "./codex-image-tool";
import type { OutboundAttachment } from "./handler";

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
          historyText: image.revisedPrompt ?? image.prompt,
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

function formatJobErrorForContext(error: string): string {
  const responseTextMarker = "Response text:";
  const responseTextIndex = error.indexOf(responseTextMarker);
  if (responseTextIndex >= 0) {
    const responseText = error.slice(responseTextIndex + responseTextMarker.length).trim();
    if (responseText !== "") return ` error response: "${shortQuote(responseText, 400)}"`;
  }
  return ` error: ${shortQuote(error, 200)}`;
}

function formatJobAge(job: AgentJob, now: number): string {
  const started = job.startedAt ?? job.createdAt;
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  return `${seconds}s ago`;
}

export function renderAgentJobsContext(jobs: AgentJob[], template: string, now = Date.now()): string {
  if (jobs.length === 0) return "";
  const lines = [
    "## Active Image Jobs",
    template,
  ];
  for (const job of jobs) {
    const state = isActiveJobStatus(job.status) ? "active" : "recent terminal";
    const replacement = job.replacesJobId !== undefined ? ` replaces ${job.replacesJobId}` : "";
    const sent = job.sentMessageId !== undefined ? ` sent MsgID ${job.sentMessageId}` : "";
    const error = job.error !== undefined ? formatJobErrorForContext(job.error) : "";
    const highRes = job.input.is4k ? " 4K" : "";
    const delivery = job.deliveryGuildId !== job.guildId || job.deliveryChannelId !== job.channelId
      ? ` delivery channel ${job.deliveryChannelId}`
      : "";
    lines.push(
      `- ${job.id} ${job.status}${highRes} (${state}) for @${job.requesterUsername} from MsgID ${job.sourceMessageId}${delivery}${replacement}; requested ${formatJobAge(job, now)}; quote: "${job.sourceQuote}"${sent}${error}`,
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
