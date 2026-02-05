import { test, expect, describe } from "bun:test";
import { wrapToolsWithTiming, formatTiming } from "./tool-timing.ts";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

function createMockTool(name: string, delayMs = 0): AgentTool {
  return {
    name,
    label: name,
    description: `Mock tool ${name}`,
    parameters: Type.Object({}),
    execute: async (): Promise<AgentToolResult<Record<string, never>>> => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return {
        content: [{ type: "text", text: `${name} executed` }],
        details: {},
      };
    },
  };
}

/** Helper to get a wrapped tool with assertion. */
function getWrapped(tools: AgentTool[], index: number): AgentTool {
  const wrapped = wrapToolsWithTiming(tools);
  const tool = wrapped[index];
  if (tool === undefined) throw new Error(`No tool at index ${index}`);
  return tool;
}

/** Extract elapsed time in ms from a tool result's timing note. */
function extractElapsedMs(result: AgentToolResult<unknown>): number {
  const note = result.content[1];
  if (note?.type !== "text") throw new Error("No timing note");
  const match = (note as { type: "text"; text: string }).text.match(/took (\d+)ms/);
  if (match === null || match[1] === undefined) throw new Error("No ms match in timing note");
  return parseInt(match[1], 10);
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
    const wrapped = getWrapped([tool], 0);

    const result = await wrapped.execute("call-1", {}, undefined);

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "text", text: "fast_tool executed" });
    const note = result.content[1];
    expect(note).toBeDefined();
    expect(note?.type).toBe("text");
    expect((note as { type: "text"; text: string }).text).toMatch(
      /^\n\*Note to agent: This `fast_tool` tool took \d+ms to run\.\*$/
    );
  });

  test("measures time from batch start to tool completion", async () => {
    const tool = createMockTool("slow_tool", 100);
    const wrapped = getWrapped([tool], 0);

    const result = await wrapped.execute("call-1", {}, undefined);

    // Should include ~100ms execution time
    const elapsed = extractElapsedMs(result);
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(200); // reasonable upper bound
  });

  test("parallel tools measure from same reference point", async () => {
    const toolA = createMockTool("tool_a", 200);
    const toolB = createMockTool("tool_b", 50);
    const wrapped = wrapToolsWithTiming([toolA, toolB]);
    const wA = wrapped[0];
    const wB = wrapped[1];
    if (wA === undefined || wB === undefined) throw new Error("Missing tools");

    // Execute in parallel
    const [resultA, resultB] = await Promise.all([
      wA.execute("call-a", {}, undefined),
      wB.execute("call-b", {}, undefined),
    ]);

    const elapsedA = extractElapsedMs(resultA);
    const elapsedB = extractElapsedMs(resultB);

    // Both should be >= their execution time
    expect(elapsedA).toBeGreaterThanOrEqual(200);
    expect(elapsedB).toBeGreaterThanOrEqual(50);
    // A should be longer than B (200ms vs 50ms)
    expect(elapsedA).toBeGreaterThan(elapsedB);
  });

  test("sequential tools reset reference between batches", async () => {
    const tool = createMockTool("tool", 50);
    const wrapped = getWrapped([tool], 0);

    // First call
    await wrapped.execute("call-1", {}, undefined);

    // Wait 100ms
    await new Promise((r) => setTimeout(r, 100));

    // Second call — should NOT include the 100ms wait
    const result = await wrapped.execute("call-2", {}, undefined);
    const elapsed = extractElapsedMs(result);

    // Should be ~50ms (tool execution), not ~150ms (wait + execution)
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(100);
  });

  test("preserves original tool properties", () => {
    const tool = createMockTool("test_tool");
    const wrapped = getWrapped([tool], 0);

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

    const wrapped = getWrapped([errorTool], 0);

    // Error should propagate, but lastToolEndTime should still update
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

  test("resets reference after error in batch", async () => {
    const errorTool: AgentTool = {
      name: "error_tool",
      label: "Error Tool",
      description: "Throws error",
      parameters: Type.Object({}),
      execute: () => {
        return Promise.reject(new Error("Tool failed"));
      },
    };
    const normalTool = createMockTool("normal_tool", 50);
    const wrapped = wrapToolsWithTiming([errorTool, normalTool]);
    const w0 = wrapped[0];
    const w1 = wrapped[1];
    if (w0 === undefined || w1 === undefined) throw new Error("Missing tools");

    // First call throws — should still reset reference in finally
    try {
      await w0.execute("call-1", {}, undefined);
    } catch {
      // expected
    }

    // Wait 100ms
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Second call — should measure ~50ms (its execution), not 150ms
    const result = await w1.execute("call-2", {}, undefined);
    expect(result.content).toHaveLength(2);
    const elapsed = extractElapsedMs(result);
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(100);
  });

  test("format switches from ms to seconds appropriately", async () => {
    // Tool that takes just over 1 second to execute
    const tool = createMockTool("one_second_tool", 1050);
    const wrapped = getWrapped([tool], 0);

    const result = await wrapped.execute("call-1", {}, undefined);

    expect(result.content).toHaveLength(2);
    // Should be formatted as "1.Xs" (seconds with decimal)
    expect((result.content[1] as { type: "text"; text: string }).text).toMatch(
      /^\n\*Note to agent: This `one_second_tool` tool took 1\.\ds to run\.\*$/
    );
  });
});
