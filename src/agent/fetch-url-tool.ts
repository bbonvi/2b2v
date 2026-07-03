import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { extractWithSummarizeCore, type AgentFetchLike } from "./summarize-content.ts";

/** Minimal fetch-like function signature for testability. */
type FetchLike = AgentFetchLike;

export interface FetchUrlToolDeps {
  /** Max content length in characters. Default: 16000 */
  maxContentLength?: number;
  /** Request timeout in ms. Default: 15000 */
  timeoutMs?: number;
  /** Disable Jina fallback (use manual only). Default: false */
  disableJina?: boolean;
  /** Disable summarize-core extraction before manual fallback. Default: false */
  disableSummarize?: boolean;
  /** Injected for testability. */
  fetchFn?: FetchLike;
}

const FetchUrlParams = Type.Object({
  url: Type.String({ description: "The URL to fetch and extract content from." }),
});

export function createFetchUrlTool(deps: FetchUrlToolDeps = {}): AgentTool {
  const maxContentLength = deps.maxContentLength ?? 16000;
  const timeoutMs = deps.timeoutMs ?? 15000;
  const disableJina = deps.disableJina ?? false;
  const disableSummarize = deps.disableSummarize ?? false;
  const fetchFn = deps.fetchFn ?? fetch;

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });

  return {
    name: "fetch_url",
    label: "fetch_url",
    description: "Fetch readable webpage content.",
    parameters: FetchUrlParams,

    async execute(
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<{ url: string; title: string; contentLength: number; method: string }>> {
      const { url } = params as { url: string };

      // Validate URL
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          throw new Error("Only HTTP/HTTPS URLs are supported");
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("Only HTTP/HTTPS")) {
          throw err;
        }
        throw new Error(`Invalid URL: ${url}`);
      }

      const request = createToolTimeout(signal, timeoutMs, `fetch_url timed out after ${timeoutMs}ms`);
      try {
        if (disableJina) {
          return await fetchSummarizeThenManual({
            url: parsedUrl.toString(),
            maxContentLength,
            timeoutMs,
            fetchFn,
            turndown,
            signal: request.signal,
            disableSummarize,
          });
        }

        return await fetchFirstSuccessful([
          {
            name: "Jina reader",
            run: (signal) => fetchWithJina(parsedUrl.toString(), maxContentLength, fetchFn, signal),
          },
          {
            name: disableSummarize ? "manual fetch" : "summarize-core/manual fetch",
            run: (signal) => fetchSummarizeThenManual({
              url: parsedUrl.toString(),
              maxContentLength,
              timeoutMs,
              fetchFn,
              turndown,
              signal,
              disableSummarize,
            }),
          },
        ], request.signal);
      } catch (error) {
        throw new Error(formatFetchUrlFailure(parsedUrl.toString(), error, timeoutMs));
      } finally {
        request.cleanup();
      }
    },
  };
}

interface FetchAttempt {
  name: string;
  run: (signal: AbortSignal) => Promise<AgentToolResult<{ url: string; title: string; contentLength: number; method: string }>>;
}

async function fetchFirstSuccessful(
  attempts: FetchAttempt[],
  parent: AbortSignal,
): Promise<AgentToolResult<{ url: string; title: string; contentLength: number; method: string }>> {
  if (attempts.length === 0) throw new Error("No fetch strategies configured");
  if (parent.aborted) throw abortReason(parent, "fetch_url aborted");

  const controllers = attempts.map(() => new AbortController());
  const onParentAbort = (): void => {
    for (const controller of controllers) {
      controller.abort(abortReason(parent, "fetch_url aborted"));
    }
  };
  parent.addEventListener("abort", onParentAbort, { once: true });

  const pending = new Set<number>(attempts.map((_attempt, index) => index));
  const errors: Array<{ name: string; error: unknown }> = [];

  try {
    const wrapped = attempts.map((attempt, index) => {
      const controller = controllers[index];
      if (controller === undefined) {
        return Promise.resolve({ index, result: undefined, error: new Error("Missing fetch controller") });
      }
      if (parent.aborted) {
        controller.abort(abortReason(parent, "fetch_url aborted"));
      }
      return attempt.run(controller.signal)
        .then((result) => ({ index, result, error: undefined }))
        .catch((error: unknown) => ({ index, result: undefined, error }));
    });

    while (pending.size > 0) {
      const result = await Promise.race([...pending].map((index) => {
        const promise = wrapped[index];
        if (promise === undefined) {
          return Promise.resolve({ index, result: undefined, error: new Error("Missing fetch attempt") });
        }
        return promise;
      }));
      pending.delete(result.index);

      if (result.result !== undefined) {
        for (const index of pending) {
          controllers[index]?.abort(new Error("fetch_url cancelled after another strategy succeeded"));
        }
        void Promise.allSettled(wrapped);
        return result.result;
      }

      const attempt = attempts[result.index];
      errors.push({
        name: attempt?.name ?? `attempt ${result.index + 1}`,
        error: result.error ?? new Error("Fetch strategy failed without an error"),
      });
    }
  } finally {
    parent.removeEventListener("abort", onParentAbort);
  }

  throw new Error(errors.map(({ name, error }) => `${name} failed: ${errorMessage(error)}`).join("; "));
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal, "fetch_url aborted");
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(abortReason(signal, "fetch_url aborted"));
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

function abortReason(signal: AbortSignal, fallback: string): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason !== "") return new Error(reason);
  return new Error(fallback);
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
      controller.abort(abortReason(parent, "fetch_url aborted"));
      return;
    }
    controller.abort(new Error("fetch_url aborted"));
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function assertNotBotChallenge(text: string, source: string): void {
  const sample = text.slice(0, 120_000);
  const compact = sample.replace(/\s+/g, " ").trim();
  const signatures = [
    /\bjust a moment\b/i,
    /\bchecking (?:if )?your browser\b/i,
    /\bverify you are human\b/i,
    /\bcloudflare ray id\b/i,
    /\bcf-browser-verification\b/i,
    /\bcf-chl-/i,
    /\bchallenge-platform\b/i,
    /\bcdn-cgi\/challenge-platform\b/i,
    /\bg-recaptcha\b/i,
    /\bh-captcha\b/i,
    /\bhcaptcha\b/i,
    /\bpx-captcha\b/i,
    /\bdatadome\b/i,
    /\bddos-guard\b/i,
    /\bperimeterx\b/i,
    /\bakamai bot manager\b/i,
    /\bcurrently, only residents from\b/i,
    /\bprivacy center\b.{0,500}\b(consent|cookies?|preferences)\b/i,
    /\b(consent|cookies?)\b.{0,300}\b(accept all|reject all|manage preferences)\b/i,
  ];
  if (signatures.some((signature) => signature.test(compact))) {
    throw new Error(`${source} returned an anti-bot challenge instead of page content`);
  }
}

function formatFetchUrlFailure(url: string, error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.message.startsWith("fetch_url failed")) return error.message;
  if (error instanceof Error && error.name === "AbortError") {
    return `fetch_url failed for ${url}: request timed out after ${timeoutMs}ms`;
  }
  return `fetch_url failed for ${url}: ${errorMessage(error)}`;
}

async function fetchSummarizeThenManual(input: {
  url: string;
  maxContentLength: number;
  timeoutMs: number;
  fetchFn: FetchLike;
  turndown: TurndownService;
  signal: AbortSignal;
  disableSummarize: boolean;
}): Promise<AgentToolResult<{ url: string; title: string; contentLength: number; method: string }>> {
  if (!input.disableSummarize) {
    try {
      const extracted = await extractWithSummarizeCore({
        url: input.url,
        maxContentLength: input.maxContentLength,
        timeoutMs: input.timeoutMs,
        fetchFn: input.fetchFn,
        signal: input.signal,
        mode: "page",
      });
      assertNotBotChallenge(extracted.content, "summarize-core");
      return {
        content: [{ type: "text", text: `# ${extracted.title}\n\nSource: ${input.url}\n\n${extracted.content}` }],
        details: {
          url: input.url,
          title: extracted.title,
          contentLength: extracted.contentLength,
          method: "summarize-core",
        },
      };
    } catch (summarizeError) {
      if (input.signal.aborted) throw summarizeError;
      try {
        return await fetchManual(input.url, input.maxContentLength, input.fetchFn, input.turndown, input.signal);
      } catch (manualError) {
        throw new Error(`summarize-core failed: ${errorMessage(summarizeError)}; manual fetch failed: ${errorMessage(manualError)}`);
      }
    }
  }

  return await fetchManual(input.url, input.maxContentLength, input.fetchFn, input.turndown, input.signal);
}

/** Fetch using Jina Reader API (r.jina.ai) */
async function fetchWithJina(
  url: string,
  maxContentLength: number,
  fetchFn: FetchLike,
  signal: AbortSignal,
): Promise<AgentToolResult<{ url: string; title: string; contentLength: number; method: string }>> {
  const jinaUrl = `https://r.jina.ai/${url}`;

  const response = await abortable(fetchFn(jinaUrl, {
    signal,
    headers: {
      Accept: "text/markdown",
    },
  }), signal);

  if (!response.ok) {
    throw new Error(`Jina returned HTTP ${response.status}: ${response.statusText}`);
  }

  let markdown = await abortable(response.text(), signal);
  assertNotBotChallenge(markdown, "Jina reader");

  // Extract title from first heading if present
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1] ?? new URL(url).hostname;

  // Truncate if needed
  if (markdown.length > maxContentLength) {
    markdown = markdown.slice(0, maxContentLength) + "\n\n[Content truncated...]";
  }

  const text = markdown.startsWith("Source:")
    ? markdown
    : `Source: ${url}\n\n${markdown}`;

  return {
    content: [{ type: "text", text }],
    details: { url, title, contentLength: markdown.length, method: "jina" },
  };
}

/** Fallback: Manual fetch with Readability extraction */
async function fetchManual(
  url: string,
  maxContentLength: number,
  fetchFn: FetchLike,
  turndown: TurndownService,
  signal: AbortSignal,
): Promise<AgentToolResult<{ url: string; title: string; contentLength: number; method: string }>> {
  const response = await abortable(fetchFn(url, {
    signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  }), signal);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }

  const html = await abortable(response.text(), signal);
  assertNotBotChallenge(html, "Manual fetch");

  // Parse and extract
  const { document } = parseHTML(html);
  // Readability expects DOM Document; linkedom's document is runtime-compatible but differently typed.
  const reader = new Readability(document as unknown as Document);
  const article = reader.parse();

  if (article === null) {
    throw new Error("Could not extract readable content from page");
  }

  let markdown = turndown.turndown(article.content ?? "");
  assertNotBotChallenge(`${article.title ?? ""}\n${markdown}`, "Manual fetch");

  if (markdown.length > maxContentLength) {
    markdown = markdown.slice(0, maxContentLength) + "\n\n[Content truncated...]";
  }

  const title = article.title !== null && article.title !== undefined && article.title !== ""
    ? article.title
    : new URL(url).hostname;

  return {
    content: [{ type: "text", text: `# ${title}\n\nSource: ${url}\n\n${markdown}` }],
    details: { url, title, contentLength: markdown.length, method: "manual" },
  };
}
