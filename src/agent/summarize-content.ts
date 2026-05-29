import { createLinkPreviewClient } from "@steipete/summarize-core/content";

export type AgentFetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface SummarizeExtractOptions {
  url: string;
  maxContentLength: number;
  timeoutMs: number;
  fetchFn: AgentFetchLike;
  signal: AbortSignal;
  mode: "page" | "video";
}

export interface SummarizeExtractResult {
  url: string;
  title: string;
  content: string;
  contentLength: number;
  truncated: boolean;
  transcriptSource: string | null;
  transcriptionProvider: string | null;
  mediaDurationSeconds: number | null;
  isVideoOnly: boolean;
  method: "summarize-core";
}

export async function extractWithSummarizeCore(options: SummarizeExtractOptions): Promise<SummarizeExtractResult> {
  const client = createLinkPreviewClient({
    fetch: createLinkedFetch(options.fetchFn, options.signal),
  });
  const extracted = await abortable(client.fetchLinkContent(options.url, {
    timeoutMs: options.timeoutMs,
    maxCharacters: options.maxContentLength,
    format: "markdown",
    markdownMode: "readability",
    firecrawl: "off",
    youtubeTranscript: "auto",
    mediaTranscript: options.mode === "video" ? "prefer" : "auto",
    transcriptTimestamps: options.mode === "video",
  }), options.signal);
  const content = extracted.content.trim();
  if (content === "") {
    throw new Error("summarize-core returned empty content");
  }

  return {
    url: extracted.url,
    title: extracted.title ?? new URL(options.url).hostname,
    content,
    contentLength: content.length,
    truncated: extracted.truncated,
    transcriptSource: extracted.transcriptSource,
    transcriptionProvider: extracted.transcriptionProvider,
    mediaDurationSeconds: extracted.mediaDurationSeconds,
    isVideoOnly: extracted.isVideoOnly,
    method: "summarize-core",
  };
}

function createLinkedFetch(fetchFn: AgentFetchLike, parentSignal: AbortSignal): typeof fetch {
  const linkedFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> => {
    const linked = createLinkedSignal(parentSignal, init?.signal);
    try {
      const nextInit: RequestInit = { ...init, signal: linked.signal };
      if (input instanceof Request) {
        return await fetch(input, nextInit);
      }
      return await fetchFn(input, nextInit);
    } finally {
      linked.cleanup();
    }
  };
  return Object.assign(linkedFetch, { preconnect: fetch.preconnect });
}

function createLinkedSignal(parent: AbortSignal, child: AbortSignal | null | undefined): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal): void => {
    const reason: unknown = signal.reason;
    controller.abort(reason instanceof Error ? reason : new Error("summarize-core fetch aborted"));
  };
  const onParentAbort = (): void => abortFrom(parent);
  const onChildAbort = (): void => {
    if (child !== null && child !== undefined) abortFrom(child);
  };

  if (parent.aborted) {
    abortFrom(parent);
  } else if (child?.aborted === true) {
    abortFrom(child);
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
    child?.addEventListener("abort", onChildAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      parent.removeEventListener("abort", onParentAbort);
      child?.removeEventListener("abort", onChildAbort);
    },
  };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason !== "") return new Error(reason);
  return new Error("summarize-core fetch aborted");
}
