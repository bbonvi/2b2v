import { ModelProviderError } from "../llm/codex-chat.ts";
import type { OpenRouterChatRequest, OpenRouterChatResult } from "../llm/types.ts";
import type { Logger, RequestLog } from "../logger.ts";
import { OutboundXmlTagError } from "../discord/outbound-xml-guard.ts";
import type { ChatCompleteFn } from "./turn-types.ts";

class ModelOutputTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM output timed out after ${timeoutMs}ms`);
    this.name = "ModelOutputTimeoutError";
  }
}

export class AgentTimeBudgetExceededError extends Error {
  constructor(timeoutMs: number) {
    super(`Native reply loop agent time budget exhausted after ${timeoutMs}ms`);
    this.name = "AgentTimeBudgetExceededError";
  }
}

class EmptyModelResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyModelResponseError";
  }
}

export const MODEL_TURN_MAX_ATTEMPTS = 5;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function makeToolErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function modelProviderName(request: OpenRouterChatRequest): string {
  return request.provider === "openai-codex" ? "OpenAI Codex" : "OpenRouter";
}

function isProviderTransientErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized === "not found"
    || normalized.includes("not found")
    || normalized.includes("bad gateway")
    || normalized.includes("cloudflare")
    || normalized.includes("service unavailable")
    || normalized.includes("server_error")
    || normalized.includes("gateway timeout")
    || normalized.includes("rate limit")
    || normalized.includes("overloaded")
    || normalized.includes("temporarily unavailable")
    || normalized.includes("you can retry your request")
    || /\b(408|409|425|429|500|502|503|504)\b/.test(normalized);
}

function normalizeModelTurnError(error: unknown, request: OpenRouterChatRequest): Error {
  const message = makeToolErrorText(error);
  if (error instanceof ModelProviderError) return error;
  if (error instanceof EmptyModelResponseError || error instanceof ModelOutputTimeoutError) return error;
  if (isAgentTimeBudgetExceededError(error)) return error instanceof Error ? error : new Error(message);
  const provider = modelProviderName(request);
  if (message.startsWith(`${provider} request failed:`) || message.startsWith("LLM provider request failed:")) {
    return error instanceof Error ? error : new Error(message);
  }
  if (isProviderTransientErrorMessage(message)) {
    return new Error(`${provider} request failed: ${message}`);
  }
  return error instanceof Error ? error : new Error(message);
}

export function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

export function isAgentTimeBudgetExceededError(error: unknown): boolean {
  return error instanceof Error && error.name === "AgentTimeBudgetExceededError";
}

export function isAgentTimeBudgetExceededSignal(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && isAgentTimeBudgetExceededError(signal.reason);
}

export function assertActionCanCommit(signal: AbortSignal | undefined, fallback: string): void {
  if (signal?.aborted === true && !isAgentTimeBudgetExceededSignal(signal)) {
    throw abortReason(signal, fallback);
  }
}

export async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await promise;
  if (signal.aborted) {
    throw abortReason(signal, "Operation aborted");
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal, "Operation aborted"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
async function completeWithTimeout(
  complete: ChatCompleteFn,
  request: OpenRouterChatRequest,
  timeoutMs: number,
): Promise<OpenRouterChatResult> {
  const controller = new AbortController();
  const parent = request.signal;
  let onParentAbort: (() => void) | undefined;
  if (parent !== undefined) {
    if (parent.aborted) {
      throw parent.reason instanceof Error ? parent.reason : new Error("LLM request aborted");
    }
    onParentAbort = () => controller.abort(parent.reason);
    parent.addEventListener("abort", onParentAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    controller.abort(new ModelOutputTimeoutError(timeoutMs));
  }, timeoutMs);

  try {
    return await complete({ ...request, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (parent !== undefined && onParentAbort !== undefined) {
      parent.removeEventListener("abort", onParentAbort);
    }
  }
}

export async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
    };
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetriableModelTurnError(error: unknown): boolean {
  if (error instanceof ModelProviderError) return error.retryable;
  if (error instanceof OutboundXmlTagError) return true;
  if (error instanceof EmptyModelResponseError) return true;
  if (error instanceof Error && error.name === "ModelOutputTimeoutError") return true;
  return isProviderTransientErrorMessage(makeToolErrorText(error));
}

function emptyModelResponse(message: string): EmptyModelResponseError {
  return new EmptyModelResponseError(message);
}

export function requireTextResult(message: string): (result: OpenRouterChatResult) => Error | undefined {
  return (result) => result.text.trim() === "" ? emptyModelResponse(message) : undefined;
}

export function requireTextUnlessToolCalls(message: string): (result: OpenRouterChatResult) => Error | undefined {
  return (result) => result.toolCalls.length === 0 && result.text.trim() === ""
    ? emptyModelResponse(message)
    : undefined;
}

export async function completeModelTurnWithRetries(input: {
  complete: ChatCompleteFn;
  request: OpenRouterChatRequest;
  timeoutMs: number;
  maxAttempts?: number;
  retryDelayMs?: (attempt: number) => number;
  validateResult?: (result: OpenRouterChatResult) => Error | undefined;
  onAttemptStart?: () => void;
  hasCompletedVisibleMessage?: () => boolean;
  requestLog?: RequestLog;
  log?: Logger;
}): Promise<OpenRouterChatResult> {
  const maxAttempts = input.maxAttempts ?? MODEL_TURN_MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      input.onAttemptStart?.();
      const result = await completeWithTimeout(input.complete, input.request, input.timeoutMs);
      const validationError = input.validateResult?.(result);
      if (validationError !== undefined) {
        const normalizedError = normalizeModelTurnError(validationError, input.request);
        const shouldRetry = attempt < maxAttempts
          && input.hasCompletedVisibleMessage?.() !== true
          && isRetriableModelTurnError(normalizedError);
        input.requestLog?.recordLLMError(normalizedError, result.messageForLogs);
        if (!shouldRetry) throw normalizedError;
        input.log?.warn("retrying LLM turn", {
          attempt,
          maxAttempts,
          error: makeToolErrorText(normalizedError),
        });
        await sleepMs(input.retryDelayMs?.(attempt) ?? retryBackoffMs(attempt, normalizedError), input.request.signal);
        continue;
      }
      return result;
    } catch (error) {
      const normalizedError = normalizeModelTurnError(error, input.request);
      const outboundXmlRejected = normalizedError instanceof OutboundXmlTagError;
      const shouldRetry = attempt < maxAttempts
        && (outboundXmlRejected || input.hasCompletedVisibleMessage?.() !== true)
        && isRetriableModelTurnError(normalizedError);
      if (shouldRetry && outboundXmlRejected) {
        input.request.messages.push({
          role: "system",
          content: normalizedError.message,
        });
      }
      if (!isAgentTimeBudgetExceededError(normalizedError)) {
        input.requestLog?.recordLLMError(normalizedError);
      }
      if (!shouldRetry) {
        throw normalizedError;
      }
      input.log?.warn("retrying LLM turn", {
        attempt,
        maxAttempts,
        error: makeToolErrorText(normalizedError),
      });
      await sleepMs(input.retryDelayMs?.(attempt) ?? retryBackoffMs(attempt, normalizedError), input.request.signal);
    }
  }

  throw new Error("LLM retry loop ended without a result.");
}

function retryBackoffMs(attempt: number, error: Error): number {
  if (error instanceof ModelProviderError && error.kind === "provider_transient") {
    return [2_000, 3_000, 5_000, 5_000][attempt - 1] ?? 5_000;
  }
  const baseMs = 250 * (2 ** Math.max(0, attempt - 1));
  return Math.round(baseMs * (0.8 + Math.random() * 0.4));
}
