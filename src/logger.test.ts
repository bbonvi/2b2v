import { test, expect, describe, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { createLogger, LOG_LEVELS } from "./logger";

let stdoutSpy: Mock<typeof process.stdout.write>;
let stderrSpy: Mock<typeof process.stderr.write>;
let captured: string[];
let capturedErr: string[];

beforeEach(() => {
  captured = [];
  capturedErr = [];
  stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  });
  stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    capturedErr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

function lastLog(): Record<string, unknown> {
  const last = captured[captured.length - 1];
  return JSON.parse(last ?? "{}") as Record<string, unknown>;
}

function lastErr(): Record<string, unknown> {
  const last = capturedErr[capturedErr.length - 1];
  return JSON.parse(last ?? "{}") as Record<string, unknown>;
}

describe("createLogger", () => {
  test("emits structured JSON with required fields", () => {
    const log = createLogger({ level: "debug" });
    log.info("hello");
    const entry = lastLog();
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("hello");
    expect(typeof entry.timestamp).toBe("string");
  });

  test("includes extra fields in output", () => {
    const log = createLogger({ level: "debug" });
    log.info("start", { version: "1.0", pid: 42 });
    const entry = lastLog();
    expect(entry.version).toBe("1.0");
    expect(entry.pid).toBe(42);
  });

  test("outputs newline-delimited JSON", () => {
    const log = createLogger({ level: "debug" });
    log.info("a");
    log.info("b");
    expect(captured.length).toBe(2);
    expect(captured[0]?.endsWith("\n")).toBe(true);
    expect(captured[1]?.endsWith("\n")).toBe(true);
  });
});

describe("level gating", () => {
  test("suppresses messages below configured level", () => {
    const log = createLogger({ level: "warn" });
    log.debug("hidden");
    log.info("hidden");
    log.warn("shown");
    expect(captured.length).toBe(0);
    expect(capturedErr.length).toBe(1);
    expect(lastErr().msg).toBe("shown");
  });

  test("debug level emits everything", () => {
    const log = createLogger({ level: "debug" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    // debug and info go to stdout, warn and error to stderr
    expect(captured.length).toBe(2);
    expect(capturedErr.length).toBe(2);
  });

  test("error level emits only errors", () => {
    const log = createLogger({ level: "error" });
    log.debug("no");
    log.info("no");
    log.warn("no");
    log.error("yes");
    expect(captured.length).toBe(0);
    expect(capturedErr.length).toBe(1);
  });
});

describe("log routing", () => {
  test("debug and info go to stdout", () => {
    const log = createLogger({ level: "debug" });
    log.debug("d");
    log.info("i");
    expect(captured.length).toBe(2);
    expect(capturedErr.length).toBe(0);
  });

  test("warn and error go to stderr", () => {
    const log = createLogger({ level: "debug" });
    log.warn("w");
    log.error("e");
    expect(captured.length).toBe(0);
    expect(capturedErr.length).toBe(2);
  });
});

describe("child logger", () => {
  test("inherits parent context and level", () => {
    const log = createLogger({ level: "info" });
    const child = log.child({ component: "scheduler" });
    child.info("tick");
    const entry = lastLog();
    expect(entry.component).toBe("scheduler");
    expect(entry.msg).toBe("tick");
  });

  test("merges child context with call-site fields", () => {
    const log = createLogger({ level: "debug" });
    const child = log.child({ component: "db" });
    child.info("query", { durationMs: 5 });
    const entry = lastLog();
    expect(entry.component).toBe("db");
    expect(entry.durationMs).toBe(5);
  });

  test("respects parent level gating", () => {
    const log = createLogger({ level: "error" });
    const child = log.child({ component: "test" });
    child.info("suppressed");
    expect(captured.length).toBe(0);
    expect(capturedErr.length).toBe(0);
  });
});

describe("token usage logging", () => {
  test("logTokenUsage emits structured token data at info level", () => {
    const log = createLogger({ level: "info" });
    log.logTokenUsage({
      model: "kimi-k2.5",
      promptTokens: 1000,
      completionTokens: 200,
      totalTokens: 1200,
    });
    const entry = lastLog();
    expect(entry.msg).toBe("llm_token_usage");
    expect(entry.model).toBe("kimi-k2.5");
    expect(entry.promptTokens).toBe(1000);
    expect(entry.completionTokens).toBe(200);
    expect(entry.totalTokens).toBe(1200);
  });

  test("logTokenUsage includes optional cost estimate", () => {
    const log = createLogger({ level: "info" });
    log.logTokenUsage({
      model: "kimi-k2.5",
      promptTokens: 1000,
      completionTokens: 200,
      totalTokens: 1200,
      estimatedCostUsd: 0.0042,
    });
    const entry = lastLog();
    expect(entry.estimatedCostUsd).toBe(0.0042);
  });

  test("logTokenUsage suppressed when level is warn", () => {
    const log = createLogger({ level: "warn" });
    log.logTokenUsage({
      model: "kimi-k2.5",
      promptTokens: 1000,
      completionTokens: 200,
      totalTokens: 1200,
    });
    expect(captured.length).toBe(0);
  });
});

describe("LOG_LEVELS ordering", () => {
  test("debug < info < warn < error", () => {
    expect(LOG_LEVELS.debug).toBeLessThan(LOG_LEVELS.info);
    expect(LOG_LEVELS.info).toBeLessThan(LOG_LEVELS.warn);
    expect(LOG_LEVELS.warn).toBeLessThan(LOG_LEVELS.error);
  });
});
