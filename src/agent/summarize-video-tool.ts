import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { extractWithSummarizeCore, type AgentFetchLike } from "./summarize-content.ts";

type FetchLike = AgentFetchLike;

export interface SummarizeVideoToolDeps {
  /** Max transcript/content length in characters. Default: 24000 */
  maxContentLength?: number;
  /** Extraction timeout in ms. Default: 30000 */
  timeoutMs?: number;
  /** Injected for testability. */
  fetchFn?: FetchLike;
}

const SummarizeVideoParams = Type.Object({
  url: Type.String({ description: "The YouTube, direct video/audio, podcast, or page URL to extract transcript/video content from." }),
});

export function createSummarizeVideoTool(deps: SummarizeVideoToolDeps = {}): AgentTool {
  const maxContentLength = deps.maxContentLength ?? 24000;
  const timeoutMs = deps.timeoutMs ?? 30000;
  const fetchFn = deps.fetchFn ?? fetch;

  return {
    name: "summarize_video",
    label: "summarize_video",
    description: "Extract video or audio content for summarization.",
    parameters: SummarizeVideoParams,

    async execute(
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<{
      url: string;
      title: string;
      contentLength: number;
      transcriptSource: string | null;
      transcriptionProvider: string | null;
      mediaDurationSeconds: number | null;
      isVideoOnly: boolean;
      method: string;
    }>> {
      const { url } = params as { url: string };
      const parsedUrl = parseHttpUrl(url);
      const request = createToolTimeout(signal, timeoutMs, `summarize_video timed out after ${timeoutMs}ms`);
      try {
        const extracted = await extractWithSummarizeCore({
          url: parsedUrl.toString(),
          maxContentLength,
          timeoutMs,
          fetchFn,
          signal: request.signal,
          mode: "video",
        });
        const metadata = [
          `Source: ${parsedUrl.toString()}`,
          extracted.transcriptSource !== null ? `Transcript source: ${extracted.transcriptSource}` : "",
          extracted.transcriptionProvider !== null ? `Transcription provider: ${extracted.transcriptionProvider}` : "",
          extracted.mediaDurationSeconds !== null ? `Duration: ${Math.round(extracted.mediaDurationSeconds)}s` : "",
        ].filter((line) => line !== "").join("\n");

        return {
          content: [{ type: "text", text: `# ${extracted.title}\n\n${metadata}\n\n${extracted.content}` }],
          details: {
            url: parsedUrl.toString(),
            title: extracted.title,
            contentLength: extracted.contentLength,
            transcriptSource: extracted.transcriptSource,
            transcriptionProvider: extracted.transcriptionProvider,
            mediaDurationSeconds: extracted.mediaDurationSeconds,
            isVideoOnly: extracted.isVideoOnly,
            method: extracted.method,
          },
        };
      } catch (error) {
        throw new Error(formatSummarizeVideoFailure(parsedUrl.toString(), error, timeoutMs));
      } finally {
        request.cleanup();
      }
    },
  };
}

function parseHttpUrl(url: string): URL {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Only HTTP/HTTPS URLs are supported");
    }
    return parsedUrl;
  } catch (err) {
    if (err instanceof Error && err.message.includes("Only HTTP/HTTPS")) {
      throw err;
    }
    throw new Error(`Invalid URL: ${url}`);
  }
}

function createToolTimeout(parent: AbortSignal | undefined, timeoutMs: number, timeoutMessage: string): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(timeoutMessage));
  }, timeoutMs);
  const onParentAbort = (): void => {
    if (parent !== undefined) {
      controller.abort(abortReason(parent, "summarize_video aborted"));
      return;
    }
    controller.abort(new Error("summarize_video aborted"));
  };

  if (parent?.aborted === true) {
    onParentAbort();
  } else {
    parent?.addEventListener("abort", onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason !== "") return new Error(reason);
  return new Error(fallback);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatSummarizeVideoFailure(url: string, error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.message.startsWith("summarize_video failed")) return error.message;
  if (error instanceof Error && error.name === "AbortError") {
    return `summarize_video failed for ${url}: request timed out after ${timeoutMs}ms`;
  }
  return `summarize_video failed for ${url}: ${errorMessage(error)}`;
}
