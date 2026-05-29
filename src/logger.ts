import { randomUUID } from "crypto";
import { requestLogStore, type RequestLogEntry } from "./dashboard/store";

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
  tool: string;
  args: Record<string, unknown>;
  isError?: boolean;
  durationMs?: number;
  result?: string;
}

export interface RequestLLMCall {
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
  requestPayload?: unknown;
  responsePayload?: unknown;
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
  private agentRan = false;
  private errorMsg: string | null = null;
  private tools: RequestToolCall[] = [];
  private llmCalls: RequestLLMCall[] = [];
  private pendingTools = new Map<string, { tool: string; args: Record<string, unknown>; startTime: number }>();
  private pendingPayload: unknown = null;

  constructor(guildId: string, channelId: string) {
    this.requestId = randomUUID();
    this.startTime = Date.now();
    this.guildId = guildId;
    this.channelId = channelId;
  }

  setAuthor(username: string): void {
    this.authorUsername = username;
  }

  setTrigger(trigger: unknown): void {
    this.trigger = trigger;
  }

  setAgentRan(ran: boolean): void {
    this.agentRan = ran;
  }

  setError(msg: string): void {
    this.errorMsg = msg;
  }

  recordToolStart(toolCallId: string, toolName: string, args: unknown): void {
    this.pendingTools.set(toolCallId, {
      tool: toolName,
      args: (args ?? {}) as Record<string, unknown>,
      startTime: Date.now(),
    });
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

    this.tools.push({
      tool: pending.tool,
      args: pending.args,
      isError: isError || undefined,
      durationMs: Date.now() - pending.startTime,
      result: resultText,
    });
  }

  recordLLMRequest(payload: unknown): void {
    this.pendingPayload = payload;
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
    this.llmCalls.push({
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
    });
    this.pendingPayload = null;
  }

  toEntry(): RequestLogEntry {
    const entry: RequestLogEntry = {
      requestId: this.requestId,
      guildId: this.guildId,
      channelId: this.channelId,
      authorUsername: this.authorUsername,
      trigger: this.trigger,
      agentRan: this.agentRan,
      tools: this.tools,
      llmCalls: this.llmCalls,
      totalDurationMs: Date.now() - this.startTime,
      timestamp: new Date().toISOString(),
    };
    if (this.errorMsg !== null) {
      entry.error = this.errorMsg;
    }
    return entry;
  }

  emit(logger: Logger): void {
    const entry = this.toEntry();
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
}
