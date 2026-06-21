import { randomUUID } from "crypto";
import { requestLogStore, type RequestLogEntry, type RequestTriggerContext } from "./dashboard/store";

export const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

export interface TokenUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  logTokenUsage(usage: TokenUsage): void;
  child(context: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  context?: Record<string, unknown>;
}

function emit(stream: NodeJS.WritableStream, entry: Record<string, unknown>): void {
  stream.write(JSON.stringify(entry) + "\n");
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LOG_LEVELS[options.level];
  const baseContext = options.context ?? {};

  function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < threshold) return;
    const entry: Record<string, unknown> = {
      level,
      msg,
      timestamp: new Date().toISOString(),
      ...baseContext,
      ...fields,
    };
    const stream = level === "debug" || level === "info" ? process.stdout : process.stderr;
    emit(stream, entry);
  }

  return {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),

    logTokenUsage(usage: TokenUsage): void {
      log("info", "llm_token_usage", {
        model: usage.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        ...(usage.estimatedCostUsd !== undefined ? { estimatedCostUsd: usage.estimatedCostUsd } : {}),
      });
    },

    child(context: Record<string, unknown>): Logger {
      return createLogger({
        level: options.level,
        context: { ...baseContext, ...context },
      });
    },
  };
}

// --- Request-scoped log accumulation ---

export interface RequestToolCall {
  id?: string;
  modelRequestId?: string;
  batchId?: string;
  batchKind?: "parallel" | "sequential" | "skipped";
  sequenceIndex?: number;
  status?: "queued" | "running" | "completed" | "error" | "skipped";
  tool: string;
  args: Record<string, unknown>;
  isError?: boolean;
  skippedReason?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  result?: string;
}

export interface RequestEmittedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "queued" | "running" | "completed" | "error" | "skipped";
  batchId?: string;
  batchKind?: "parallel" | "sequential" | "skipped";
  sequenceIndex: number;
  skippedReason?: string;
}

export interface RequestLLMCall {
  id?: string;
  status?: "running" | "completed" | "error";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  cacheDiscountUsd?: number;
  estimatedCostUsd?: number;
  stopReason: string;
  contentTypes: string[];
  outputText?: string;
  isError?: boolean;
  error?: string;
  emittedToolCalls?: RequestEmittedToolCall[];
  requestPayload?: unknown;
  responsePayload?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Recursively truncate string values in an object to `maxLen` characters. */
export function truncateArgs(obj: unknown, maxLen = 200): unknown {
  if (typeof obj === "string") {
    return obj.length > maxLen ? obj.slice(0, maxLen) + "…" : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => truncateArgs(item, maxLen));
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = truncateArgs(value, maxLen);
    }
    return result;
  }
  return obj;
}

interface RequestLogActiveStore {
  upsertActive(entry: RequestLogEntry): void;
  removeActive(requestId: string): void;
}

function isoNow(): string {
  return new Date().toISOString();
}

function durationBetween(startedAt: string | undefined, completedAt: string): number | undefined {
  if (startedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

function parseToolArgsJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function messageToolCalls(message: Record<string, unknown>): RequestEmittedToolCall[] {
  const rawToolCalls = message.toolCalls;
  if (!Array.isArray(rawToolCalls)) return [];
  const calls: RequestEmittedToolCall[] = [];
  for (const item of rawToolCalls) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item.function) ? item.function : null;
    const id = typeof item.id === "string" ? item.id : "";
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (id === "" || name === "") continue;
    calls.push({
      id,
      name,
      args: parseToolArgsJson(fn?.arguments),
      status: "queued",
      sequenceIndex: calls.length,
    });
  }
  return calls;
}

/**
 * Accumulates all events during a single handleMessage cycle,
 * then emits one structured log entry via `emit()`.
 */
export class RequestLog {
  readonly requestId: string;
  readonly startTime: number;
  readonly guildId: string;
  readonly channelId: string;

  private authorUsername = "";
  private trigger: unknown = null;
  private triggerContext: RequestTriggerContext | undefined;
  private agentRan = false;
  private errorMsg: string | null = null;
  private tools: RequestToolCall[] = [];
  private llmCalls: RequestLLMCall[] = [];
  private pendingTools = new Map<string, { tool: string; args: Record<string, unknown>; startTime: number; startedAt: string }>();
  private pendingPayload: unknown = null;
  private pendingModelRequestId: string | null = null;
  private modelRequestSeq = 0;
  private toolBatchSeq = 0;
  private toolSeq = 0;
  private toolCallModelRequests = new Map<string, string>();
  private toolCallBatches = new Map<string, { batchId: string; batchKind: "parallel" | "sequential" | "skipped" }>();
  private readonly activeStore?: RequestLogActiveStore;

  constructor(guildId: string, channelId: string, activeStore?: RequestLogActiveStore) {
    this.requestId = randomUUID();
    this.startTime = Date.now();
    this.guildId = guildId;
    this.channelId = channelId;
    this.activeStore = activeStore;
  }

  setAuthor(username: string): void {
    this.authorUsername = username;
    this.touchActive();
  }

  setTrigger(trigger: unknown): void {
    this.trigger = trigger;
    this.touchActive();
  }

  setTriggerContext(context: RequestTriggerContext): void {
    this.triggerContext = context;
    this.touchActive();
  }

  setAgentRan(ran: boolean): void {
    this.agentRan = ran;
    this.touchActive();
  }

  setError(msg: string): void {
    this.errorMsg = msg;
    this.touchActive();
  }

  beginToolBatch(toolCallIds: readonly string[], kind: "parallel" | "sequential" | "skipped"): string {
    const batchId = `tool-batch-${++this.toolBatchSeq}`;
    for (const toolCallId of toolCallIds) {
      this.toolCallBatches.set(toolCallId, { batchId, batchKind: kind });
      this.updateEmittedToolCall(toolCallId, { batchId, batchKind: kind });
    }
    this.touchActive();
    return batchId;
  }

  recordToolStart(toolCallId: string, toolName: string, args: unknown): void {
    const startedAt = isoNow();
    this.pendingTools.set(toolCallId, {
      tool: toolName,
      args: (args ?? {}) as Record<string, unknown>,
      startTime: Date.now(),
      startedAt,
    });
    this.updateEmittedToolCall(toolCallId, { status: "running" });
    this.touchActive();
  }

  recordToolEnd(toolCallId: string, isError: boolean, rawResult?: unknown): void {
    const pending = this.pendingTools.get(toolCallId);
    if (pending === undefined) return;
    this.pendingTools.delete(toolCallId);

    let resultText: string | undefined;
    if (rawResult !== null && rawResult !== undefined && typeof rawResult === "object" && "content" in rawResult) {
      const content = (rawResult as { content: unknown[] }).content;
      if (Array.isArray(content)) {
        const text = content
          .filter((c): c is { type: string; text: string } => typeof c === "object" && c !== null && "text" in c)
          .map((c) => c.text)
          .join("\n");
        if (text.length > 0) {
          // Store full result for dashboard; truncation happens in emit() for console
          resultText = text;
        }
      }
    }

    const completedAt = isoNow();
    const batch = this.toolCallBatches.get(toolCallId);
    const modelRequestId = this.toolCallModelRequests.get(toolCallId);
    const status = isError ? "error" : "completed";
    const toolEntry: RequestToolCall = {
      id: toolCallId,
      modelRequestId,
      batchId: batch?.batchId,
      batchKind: batch?.batchKind,
      sequenceIndex: this.toolSeq++,
      status,
      tool: pending.tool,
      args: pending.args,
      isError: isError || undefined,
      startedAt: pending.startedAt,
      completedAt,
      durationMs: Date.now() - pending.startTime,
      result: resultText,
    };
    this.tools.push(toolEntry);
    this.updateEmittedToolCall(toolCallId, {
      status,
      batchId: toolEntry.batchId,
      batchKind: toolEntry.batchKind,
    });
    this.touchActive();
  }

  recordToolSkipped(toolCallId: string, toolName: string, args: unknown, reason: string): void {
    const batch = this.toolCallBatches.get(toolCallId);
    const modelRequestId = this.toolCallModelRequests.get(toolCallId);
    const now = isoNow();
    const toolEntry: RequestToolCall = {
      id: toolCallId,
      modelRequestId,
      batchId: batch?.batchId,
      batchKind: batch?.batchKind ?? "skipped",
      sequenceIndex: this.toolSeq++,
      status: "skipped",
      tool: toolName,
      args: (args ?? {}) as Record<string, unknown>,
      skippedReason: reason,
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      result: reason,
    };
    this.tools.push(toolEntry);
    this.updateEmittedToolCall(toolCallId, {
      status: "skipped",
      batchId: toolEntry.batchId,
      batchKind: toolEntry.batchKind,
      skippedReason: reason,
    });
    this.touchActive();
  }

  recordLLMRequest(payload: unknown): void {
    const startedAt = isoNow();
    const payloadRecord = isRecord(payload) ? payload : null;
    const model = typeof payloadRecord?.model === "string" && payloadRecord.model !== ""
      ? payloadRecord.model
      : "unknown";
    const id = `model-request-${++this.modelRequestSeq}`;
    this.pendingPayload = payload;
    this.pendingModelRequestId = id;
    this.llmCalls.push({
      id,
      status: "running",
      startedAt,
      model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      stopReason: "running",
      contentTypes: [],
      requestPayload: payload ?? undefined,
      emittedToolCalls: [],
    });
    this.touchActive();
  }

  recordLLMError(error: unknown): void {
    const payload = this.pendingPayload;
    const payloadRecord = isRecord(payload) ? payload : null;
    const model = typeof payloadRecord?.model === "string" && payloadRecord.model !== ""
      ? payloadRecord.model
      : "unknown";
    const message = error instanceof Error ? error.message : String(error);
    const completedAt = isoNow();
    const target = this.pendingModelRequestId !== null
      ? this.llmCalls.find((call) => call.id === this.pendingModelRequestId)
      : undefined;
    const errorCall: RequestLLMCall = {
      id: target?.id ?? `model-request-${++this.modelRequestSeq}`,
      status: "error",
      startedAt: target?.startedAt,
      completedAt,
      durationMs: durationBetween(target?.startedAt, completedAt),
      model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      stopReason: "error",
      contentTypes: [],
      outputText: message,
      isError: true,
      error: message,
      requestPayload: payload ?? undefined,
      emittedToolCalls: target?.emittedToolCalls ?? [],
    };
    if (target !== undefined) {
      Object.assign(target, errorCall);
    } else {
      this.llmCalls.push(errorCall);
    }
    this.pendingPayload = null;
    this.pendingModelRequestId = null;
    this.touchActive();
  }

  recordLLMCompletion(message: Record<string, unknown>): void {
    if (message.role !== "assistant" || message.usage === undefined) return;
    const usage = message.usage as Record<string, unknown>;
    const cost = usage.cost as Record<string, unknown> | undefined;
    const content = message.content;
    const contentTypes: string[] = [];
    const textParts: string[] = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown>;
        const t = b.type;
        if (typeof t === "string" && !contentTypes.includes(t)) {
          contentTypes.push(t);
        }
        if (t === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        }
      }
    }
    const outputText = textParts.join("\n");
    const completedAt = isoNow();
    const emittedToolCalls = messageToolCalls(message);
    const target = this.pendingModelRequestId !== null
      ? this.llmCalls.find((call) => call.id === this.pendingModelRequestId)
      : undefined;
    const id = target?.id ?? `model-request-${++this.modelRequestSeq}`;
    for (const call of emittedToolCalls) {
      this.toolCallModelRequests.set(call.id, id);
    }
    const completedCall: RequestLLMCall = {
      id,
      status: "completed",
      startedAt: target?.startedAt,
      completedAt,
      durationMs: durationBetween(target?.startedAt, completedAt),
      model: typeof message.model === "string" ? message.model : "unknown",
      promptTokens: typeof usage.input === "number" ? usage.input : 0,
      completionTokens: typeof usage.output === "number" ? usage.output : 0,
      totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : 0,
      cachedTokens: typeof usage.cachedTokens === "number" ? usage.cachedTokens : undefined,
      cacheWriteTokens: typeof usage.cacheWriteTokens === "number" ? usage.cacheWriteTokens : undefined,
      cacheDiscountUsd: typeof usage.cacheDiscount === "number" ? usage.cacheDiscount : undefined,
      estimatedCostUsd: typeof cost?.total === "number" ? cost.total : undefined,
      stopReason: typeof message.stopReason === "string" ? message.stopReason : "unknown",
      contentTypes,
      outputText: outputText.length > 0 ? outputText : undefined,
      requestPayload: this.pendingPayload ?? undefined,
      responsePayload: message,
      emittedToolCalls,
    };
    if (target !== undefined) {
      Object.assign(target, completedCall);
    } else {
      this.llmCalls.push(completedCall);
    }
    this.pendingPayload = null;
    this.pendingModelRequestId = null;
    this.touchActive();
  }

  toEntry(status?: "active"): RequestLogEntry {
    const entry: RequestLogEntry = {
      requestId: this.requestId,
      guildId: this.guildId,
      channelId: this.channelId,
      authorUsername: this.authorUsername,
      trigger: this.trigger,
      ...(this.triggerContext !== undefined ? { triggerContext: this.triggerContext } : {}),
      agentRan: this.agentRan,
      tools: this.tools,
      llmCalls: this.llmCalls,
      totalDurationMs: Date.now() - this.startTime,
      startedAt: new Date(this.startTime).toISOString(),
      timestamp: new Date().toISOString(),
    };
    if (status !== undefined) {
      entry.status = status;
    }
    if (this.errorMsg !== null) {
      entry.error = this.errorMsg;
    }
    return entry;
  }

  emit(logger: Logger): void {
    const entry = this.toEntry();
    this.activeStore?.removeActive(this.requestId);
    if (entry.agentRan || entry.error !== undefined) {
      requestLogStore.push(entry);
    }

    // Truncate args/results/outputText for the console log line only
    const truncStr = (s: string | undefined, max: number): string | undefined =>
      s !== undefined && s.length > max ? s.slice(0, max) + "…" : s;
    const logEntry = {
      ...entry,
      tools: entry.tools.map((t) => ({
        ...t,
        args: truncateArgs(t.args) as Record<string, unknown>,
        result: truncStr(t.result, 500),
      })),
      llmCalls: entry.llmCalls.map((l) => ({
        ...l,
        outputText: truncStr(l.outputText, 300),
        requestPayload: undefined,
        responsePayload: undefined,
      })),
    };
    logger.info("request_completed", logEntry as unknown as Record<string, unknown>);
  }

  private touchActive(): void {
    this.activeStore?.upsertActive(this.toEntry("active"));
  }

  private updateEmittedToolCall(
    toolCallId: string,
    patch: Partial<Omit<RequestEmittedToolCall, "id" | "name" | "args" | "sequenceIndex">>,
  ): void {
    for (const call of this.llmCalls) {
      const emitted = call.emittedToolCalls?.find((toolCall) => toolCall.id === toolCallId);
      if (emitted !== undefined) {
        Object.assign(emitted, patch);
        return;
      }
    }
  }
}
