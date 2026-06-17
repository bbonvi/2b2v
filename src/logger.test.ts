import { test, expect, describe, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { createLogger, LOG_LEVELS, RequestLog, truncateArgs } from "./logger";
import { requestLogStore } from "./dashboard/store";

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

describe("truncateArgs", () => {
  test("truncates long strings with ellipsis", () => {
    const long = "a".repeat(300);
    const result = truncateArgs(long, 200);
    expect(result).toBe("a".repeat(200) + "…");
  });

  test("leaves short strings unchanged", () => {
    expect(truncateArgs("hello", 200)).toBe("hello");
  });

  test("recursively truncates object values", () => {
    const obj = { query: "a".repeat(300), limit: 10 };
    const result = truncateArgs(obj, 200) as Record<string, unknown>;
    expect((result.query as string).length).toBe(201); // 200 + "…"
    expect(result.limit).toBe(10);
  });

  test("truncates strings in arrays", () => {
    const arr = ["a".repeat(300), "short"];
    const result = truncateArgs(arr, 200) as string[];
    expect(result[0]?.length).toBe(201);
    expect(result[1]).toBe("short");
  });

  test("passes through null and numbers", () => {
    expect(truncateArgs(null)).toBeNull();
    expect(truncateArgs(42)).toBe(42);
  });
});

describe("RequestLog", () => {
  test("constructor generates UUID and records start time", () => {
    const rl = new RequestLog("g1", "c1");
    expect(rl.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rl.guildId).toBe("g1");
    expect(rl.channelId).toBe("c1");
    expect(rl.startTime).toBeLessThanOrEqual(Date.now());
  });

  test("emit produces request_completed with correct structure", () => {
    const logger = createLogger({ level: "info" });
    const rl = new RequestLog("g1", "c1");
    rl.setTrigger({ reason: "mention" });
    rl.setAgentRan(true);
    rl.emit(logger);

    const entry = lastLog();
    expect(entry.msg).toBe("request_completed");
    expect(entry.requestId).toBe(rl.requestId);
    expect(entry.guildId).toBe("g1");
    expect(entry.channelId).toBe("c1");
    expect(entry.trigger).toEqual({ reason: "mention" });
    expect(entry.agentRan).toBe(true);
    expect(entry.tools).toEqual([]);
    expect(entry.llmCalls).toEqual([]);
    expect(typeof entry.totalDurationMs).toBe("number");
  });

  test("recordToolStart + recordToolEnd tracks tool with duration", () => {
    const logger = createLogger({ level: "info" });
    const rl = new RequestLog("g1", "c1");
    rl.recordToolStart("tc1", "search_messages", { query: "test", limit: 10 });
    rl.recordToolEnd("tc1", false);
    rl.emit(logger);

    const entry = lastLog();
    const tools = entry.tools as Array<Record<string, unknown>>;
    expect(tools.length).toBe(1);
    expect(tools[0]?.tool).toBe("search_messages");
    expect(tools[0]?.args).toEqual({ query: "test", limit: 10 });
    expect(typeof tools[0]?.durationMs).toBe("number");
  });

  test("recordLLMCompletion extracts metadata and strips body", () => {
    const logger = createLogger({ level: "info" });
    const rl = new RequestLog("g1", "c1");
    rl.recordLLMCompletion({
      role: "assistant",
      model: "moonshotai/kimi-k2.5",
      content: [
        { type: "thinking", text: "long thinking content..." },
        { type: "text", text: "response" },
      ],
      usage: {
        input: 2842,
        output: 407,
        totalTokens: 3249,
        cachedTokens: 2048,
        cacheWriteTokens: 512,
        cacheDiscount: 0.0011,
        cost: { total: 0.0026 },
      },
      stopReason: "stop",
    });
    rl.emit(logger);

    const entry = lastLog();
    const llm = entry.llmCalls as Array<Record<string, unknown>>;
    expect(llm.length).toBe(1);
    expect(llm[0]?.model).toBe("moonshotai/kimi-k2.5");
    expect(llm[0]?.promptTokens).toBe(2842);
    expect(llm[0]?.completionTokens).toBe(407);
    expect(llm[0]?.totalTokens).toBe(3249);
    expect(llm[0]?.cachedTokens).toBe(2048);
    expect(llm[0]?.cacheWriteTokens).toBe(512);
    expect(llm[0]?.cacheDiscountUsd).toBe(0.0011);
    expect(llm[0]?.estimatedCostUsd).toBe(0.0026);
    expect(llm[0]?.stopReason).toBe("stop");
    expect(llm[0]?.contentTypes).toEqual(["thinking", "text"]);
    // Body should NOT be present
    expect(llm[0]?.content).toBeUndefined();
  });

  test("ignores non-assistant messages in recordLLMCompletion", () => {
    const logger = createLogger({ level: "info" });
    const rl = new RequestLog("g1", "c1");
    rl.recordLLMCompletion({ role: "user", content: "hello" });
    rl.emit(logger);

    const entry = lastLog();
    expect((entry.llmCalls as unknown[]).length).toBe(0);
  });

  test("multiple tools and LLM calls accumulate", () => {
    const logger = createLogger({ level: "info" });
    const rl = new RequestLog("g1", "c1");
    rl.recordToolStart("tc1", "search", { q: "a" });
    rl.recordToolEnd("tc1", false);
    rl.recordToolStart("tc2", "send_message", { text: "hi" });
    rl.recordToolEnd("tc2", false);
    rl.recordLLMCompletion({
      role: "assistant", model: "m1", content: [{ type: "text" }],
      usage: { input: 100, output: 50, totalTokens: 150 }, stopReason: "stop",
    });
    rl.recordLLMCompletion({
      role: "assistant", model: "m1", content: [{ type: "text" }, { type: "toolCall" }],
      usage: { input: 200, output: 80, totalTokens: 280 }, stopReason: "toolUse",
    });
    rl.emit(logger);

    const entry = lastLog();
    expect((entry.tools as unknown[]).length).toBe(2);
    expect((entry.llmCalls as unknown[]).length).toBe(2);
  });

  test("error captured when set", () => {
    const logger = createLogger({ level: "info" });
    const rl = new RequestLog("g1", "c1");
    rl.setError("something broke");
    rl.emit(logger);

    const entry = lastLog();
    expect(entry.error).toBe("something broke");
  });

  test("recordLLMRequest attaches payload to next LLM completion", () => {
    const rl = new RequestLog("g1", "c1");
    const payload = { model: "test", messages: [{ role: "user", content: "hi" }], tools: [] };
    rl.recordLLMRequest(payload);
    rl.recordLLMCompletion({
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text: "hello" }],
      usage: { input: 10, output: 5, totalTokens: 15 },
      stopReason: "stop",
    });

    const entry = rl.toEntry();
    expect(entry.llmCalls[0]?.requestPayload).toEqual(payload);
  });

  test("recordLLMError preserves pending payload for dashboard detail", () => {
    const rl = new RequestLog("g1", "c1");
    const payload = { model: "test-model", messages: [{ role: "user", content: "hi" }] };
    rl.recordLLMRequest(payload);
    rl.recordLLMError(new Error("OpenAI Codex request failed: Not Found"));

    const entry = rl.toEntry();
    expect(entry.llmCalls).toHaveLength(1);
    expect(entry.llmCalls[0]?.model).toBe("test-model");
    expect(entry.llmCalls[0]?.isError).toBe(true);
    expect(entry.llmCalls[0]?.stopReason).toBe("error");
    expect(entry.llmCalls[0]?.error).toBe("OpenAI Codex request failed: Not Found");
    expect(entry.llmCalls[0]?.requestPayload).toEqual(payload);
  });

  test("requestPayload resets after consumption", () => {
    const rl = new RequestLog("g1", "c1");
    rl.recordLLMRequest({ msg: "first" });
    rl.recordLLMCompletion({
      role: "assistant", model: "m", content: [],
      usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "stop",
    });
    rl.recordLLMCompletion({
      role: "assistant", model: "m", content: [],
      usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "stop",
    });

    const entry = rl.toEntry();
    expect(entry.llmCalls[0]?.requestPayload).toEqual({ msg: "first" });
    expect(entry.llmCalls[1]?.requestPayload).toBeUndefined();
  });

  test("emit excludes requestPayload from console log", () => {
    const logger = createLogger({ level: "info" });
    const rl = new RequestLog("g1", "c1");
    rl.recordLLMRequest({ huge: "payload data" });
    rl.recordLLMCompletion({
      role: "assistant", model: "m", content: [{ type: "text", text: "hi" }],
      usage: { input: 10, output: 5, totalTokens: 15 }, stopReason: "stop",
    });
    rl.emit(logger);

    const logOutput = lastLog();
    const llmCalls = logOutput.llmCalls as Array<Record<string, unknown>>;
    expect(llmCalls[0]?.requestPayload).toBeUndefined();
  });

  test("recordLLMCompletion captures responsePayload", () => {
    const rl = new RequestLog("g1", "c1");
    const message = {
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text: "hello" }],
      usage: { input: 10, output: 5, totalTokens: 15 },
      stopReason: "stop",
    };
    rl.recordLLMCompletion(message);

    const entry = rl.toEntry();
    expect(entry.llmCalls[0]?.responsePayload).toEqual(message);
  });

  test("emit excludes responsePayload from console log", () => {
    const logger = createLogger({ level: "info" });
    const rl = new RequestLog("g1", "c1");
    rl.recordLLMCompletion({
      role: "assistant", model: "m", content: [{ type: "text", text: "hi" }],
      usage: { input: 10, output: 5, totalTokens: 15 }, stopReason: "stop",
    });
    rl.emit(logger);

    const logOutput = lastLog();
    const llmCalls = logOutput.llmCalls as Array<Record<string, unknown>>;
    expect(llmCalls[0]?.responsePayload).toBeUndefined();
  });

  test("tool error marked with isError", () => {
    const logger = createLogger({ level: "info" });
    const rl = new RequestLog("g1", "c1");
    rl.recordToolStart("tc1", "bad_tool", {});
    rl.recordToolEnd("tc1", true);
    rl.emit(logger);

    const entry = lastLog();
    const tools = entry.tools as Array<Record<string, unknown>>;
    expect(tools[0]?.isError).toBe(true);
  });

  test("emit does NOT push to requestLogStore when agentRan=false and no error", () => {
    const logger = createLogger({ level: "info" });
    const before = requestLogStore.query({}).length;
    const rl = new RequestLog("g1", "c1");
    rl.setAgentRan(false);
    rl.emit(logger);

    expect(requestLogStore.query({}).length).toBe(before);
  });

  test("emit DOES push to requestLogStore when agentRan=false but error is set", () => {
    const logger = createLogger({ level: "info" });
    const before = requestLogStore.query({}).length;
    const rl = new RequestLog("g1", "c1");
    rl.setAgentRan(false);
    rl.setError("handler crashed");
    rl.emit(logger);

    expect(requestLogStore.query({}).length).toBe(before + 1);
  });

  test("dashboard store receives full tool result while console is truncated", () => {
    const logger = createLogger({ level: "info" });
    const before = requestLogStore.query({}).length;
    const rl = new RequestLog("g1", "c1");
    rl.setAgentRan(true);

    // Generate a result longer than 500 chars (console truncation threshold)
    const longResult = "x".repeat(1000);
    rl.recordToolStart("tc1", "bash", { command: "echo test" });
    rl.recordToolEnd("tc1", false, {
      content: [{ type: "text", text: longResult }],
    });
    rl.emit(logger);

    // Dashboard store should have full result
    const storeEntries = requestLogStore.query({});
    expect(storeEntries.length).toBe(before + 1);
    const dashboardTools = storeEntries[0]?.tools;
    expect(dashboardTools?.[0]?.result).toBe(longResult);
    expect(dashboardTools?.[0]?.result?.length).toBe(1000);

    // Console log should be truncated to 500 chars + ellipsis
    const consoleEntry = lastLog();
    const consoleTools = consoleEntry.tools as Array<Record<string, unknown>>;
    expect((consoleTools[0]?.result as string).length).toBe(501); // 500 + "…"
    expect((consoleTools[0]?.result as string).endsWith("…")).toBe(true);
  });
});
