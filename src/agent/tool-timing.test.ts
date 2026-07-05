import { test, expect, describe } from "bun:test";
import { wrapToolsWithTiming, formatTiming, type TimingState } from "./tool-timing.ts";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

let nowMs = 0;

function createMockTool(name: string, delayMs = 0): AgentTool {
  return {
    name,
    label: name,
    description: `Mock tool ${name}`,
    parameters: Type.Object({}),
    execute: (): Promise<AgentToolResult<Record<string, never>>> => {
      nowMs += delayMs;
      return Promise.resolve({
        content: [{ type: "text", text: `${name} executed` }],
        details: {},
      });
    },
  };
}

/** Helper to get wrapped tools and state. */
function getWrapped(tools: AgentTool[]): { tools: AgentTool[]; state: TimingState } {
  nowMs = 0;
  return wrapToolsWithTiming(tools, () => nowMs);
}

/** Get tool at index with assertion. */
function getTool(tools: AgentTool[], index: number): AgentTool {
  const tool = tools[index];
  if (tool === undefined) throw new Error(`No tool at index ${index}`);
  return tool;
}

/** Extract a timing field from a tool result's timing note. */
function extractTimingMs(result: AgentToolResult<unknown>, label: string): number {
  const note = result.content[1];
  if (note?.type !== "text") throw new Error("No timing note");
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = (note as { type: "text"; text: string }).text.match(new RegExp(`${escapedLabel} (\\d+(?:\\.\\d+)?)(ms|s)`));
  if (match === null || match[1] === undefined || match[2] === undefined) throw new Error(`No ${label} match in timing note`);
  const value = Number(match[1]);
  return match[2] === "s" ? value * 1000 : value;
}

describe("formatTiming", () => {
  test("formats milliseconds for values < 1000", () => {
    expect(formatTiming(100)).toBe("100ms");
    expect(formatTiming(500)).toBe("500ms");
    expect(formatTiming(999)).toBe("999ms");
  });

  test("formats seconds with one decimal for 1-10s", () => {
    expect(formatTiming(1000)).toBe("1.0s");
    expect(formatTiming(1500)).toBe("1.5s");
    expect(formatTiming(2345)).toBe("2.3s");
    expect(formatTiming(9999)).toBe("10.0s");
  });

  test("formats seconds as integers for >= 10s", () => {
    expect(formatTiming(10000)).toBe("10s");
    expect(formatTiming(12000)).toBe("12s");
    expect(formatTiming(59999)).toBe("60s");
  });
});

describe("wrapToolsWithTiming", () => {
  test("timing note always appended", async () => {
    const tool = createMockTool("fast_tool");
    const { tools, state } = getWrapped([tool]);
    const wrapped = getTool(tools, 0);
    state.setReferenceTime();

    const result = await wrapped.execute("call-1", {}, undefined);

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "text", text: "fast_tool executed" });
    const note = result.content[1];
    expect(note).toBeDefined();
    expect(note?.type).toBe("text");
    expect((note as { type: "text"; text: string }).text).toMatch(
      /^\n\*Note to agent: Timing for `fast_tool`: tool-call generation \d+ms, tool execution \d+ms, current tool turn \d+ms, agent loop elapsed \d+ms\.\*$/
    );
  });

  test("measures actual tool execution time", async () => {
    const tool = createMockTool("slow_tool", 100);
    const { tools, state } = getWrapped([tool]);
    const wrapped = getTool(tools, 0);
    state.setReferenceTime();

    const result = await wrapped.execute("call-1", {}, undefined);

    const elapsed = extractTimingMs(result, "tool execution");
    expect(elapsed).toBe(100);
  });

  test("parallel tools measure from same reference point", async () => {
    const toolA = createMockTool("tool_a", 200);
    const toolB = createMockTool("tool_b", 50);
    const { tools, state } = getWrapped([toolA, toolB]);
    const wA = getTool(tools, 0);
    const wB = getTool(tools, 1);
    state.setReferenceTime();

    // Execute in parallel
    const [resultA, resultB] = await Promise.all([
      wA.execute("call-a", {}, undefined),
      wB.execute("call-b", {}, undefined),
    ]);

    const elapsedA = extractTimingMs(resultA, "tool execution");
    const elapsedB = extractTimingMs(resultB, "tool execution");

    expect(elapsedA).toBeGreaterThanOrEqual(200);
    expect(elapsedB).toBe(50);
    expect(elapsedA).toBeGreaterThan(elapsedB);
  });

  test("includes LLM tool-call generation time separately from tool execution", async () => {
    const tool = createMockTool("tool", 50);
    const { tools, state } = getWrapped([tool]);
    const wrapped = getTool(tools, 0);

    // Simulate: LLM starts, spends 100ms generating a tool call, then tool runs.
    state.markModelTurnStart();
    nowMs += 100;
    state.markToolCallsReady();

    const result = await wrapped.execute("call-1", {}, undefined);
    const generation = extractTimingMs(result, "tool-call generation");
    const execution = extractTimingMs(result, "tool execution");
    const turnElapsed = extractTimingMs(result, "current tool turn");

    expect(generation).toBe(100);
    expect(execution).toBe(50);
    expect(turnElapsed).toBe(150);
  });

  test("markModelTurnStart resets timing for new tool turn", async () => {
    const tool = createMockTool("tool", 50);
    const { tools, state } = getWrapped([tool]);
    const wrapped = getTool(tools, 0);

    // First batch
    state.markModelTurnStart();
    state.markToolCallsReady();
    await wrapped.execute("call-1", {}, undefined);

    // Wait 100ms (simulating LLM response time)
    nowMs += 100;

    // Second batch — markModelTurnStart called, should NOT include prior idle wait.
    state.markModelTurnStart();
    state.markToolCallsReady();
    const result = await wrapped.execute("call-2", {}, undefined);
    const elapsed = extractTimingMs(result, "current tool turn");

    // Should be ~50ms (tool execution), not ~150ms
    expect(elapsed).toBe(50);
  });

  test("preserves original tool properties", () => {
    const tool = createMockTool("test_tool");
    const { tools } = getWrapped([tool]);
    const wrapped = getTool(tools, 0);

    expect(wrapped.name).toBe("test_tool");
    expect(wrapped.label).toBe("test_tool");
    expect(wrapped.description).toBe("Mock tool test_tool");
    expect(wrapped.parameters).toBe(tool.parameters);
  });

  test("handles tools that throw errors", async () => {
    const errorTool: AgentTool = {
      name: "error_tool",
      label: "Error Tool",
      description: "Throws error",
      parameters: Type.Object({}),
      execute: () => {
        return Promise.reject(new Error("Tool failed"));
      },
    };

    const { tools, state } = getWrapped([errorTool]);
    const wrapped = getTool(tools, 0);
    state.setReferenceTime();

    let caught = false;
    try {
      await wrapped.execute("call-1", {}, undefined);
    } catch (e) {
      caught = true;
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("Tool failed");
    }
    expect(caught).toBe(true);
  });

  test("format switches from ms to seconds appropriately", async () => {
    // Tool that takes just over 1 second to execute
    const tool = createMockTool("one_second_tool", 1050);
    const { tools, state } = getWrapped([tool]);
    const wrapped = getTool(tools, 0);
    state.setReferenceTime();

    const result = await wrapped.execute("call-1", {}, undefined);

    expect(result.content).toHaveLength(2);
    // Should be formatted as "1.Xs" (seconds with decimal)
    expect((result.content[1] as { type: "text"; text: string }).text).toMatch(
      /^\n\*Note to agent: Timing for `one_second_tool`: tool-call generation \d+ms, tool execution 1\.\ds, current tool turn 1\.\ds, agent loop elapsed 1\.\ds\.\*$/
    );
  });
});
