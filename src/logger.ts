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
