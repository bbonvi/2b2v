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
  test("timing note omitted when elapsed < 100ms", async () => {
    const tool = createMockTool("fast_tool");
    const wrapped = getWrapped([tool], 0);

    const result = await wrapped.execute("call-1", {}, undefined);

    // Should only have original content, no timing note
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "fast_tool executed" });
  });

  test("timing note appended when elapsed >= 100ms", async () => {
    const tool = createMockTool("slow_tool");
    const wrapped = getWrapped([tool], 0);

    // Wait 150ms before calling — this is the "elapsed since last tool end" gap
    await new Promise((resolve) => setTimeout(resolve, 150));

    const result = await wrapped.execute("call-1", {}, undefined);

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "text", text: "slow_tool executed" });
    const note = result.content[1];
    expect(note).toBeDefined();
    expect(note?.type).toBe("text");
    expect((note as { type: "text"; text: string }).text).toMatch(
      /^\*Note for agent: This `slow_tool` took \d+ms to run\.\*$/
    );
  });

  test("elapsed time measured from previous tool end", async () => {
    const tool1 = createMockTool("tool_1", 50);
    const tool2 = createMockTool("tool_2", 50);
    const wrapped = wrapToolsWithTiming([tool1, tool2]);
    const w0 = wrapped[0];
    const w1 = wrapped[1];
    if (w0 === undefined || w1 === undefined) throw new Error("Missing tools");

    // First call — elapsed from wrapper creation (should be < 100ms)
    const result1 = await w0.execute("call-1", {}, undefined);
    expect(result1.content).toHaveLength(1); // no timing note

    // Wait 150ms after first tool completes
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Second call — elapsed from first tool end (should be >= 150ms)
    const result2 = await w1.execute("call-2", {}, undefined);
    expect(result2.content).toHaveLength(2); // has timing note
    expect((result2.content[1] as { type: "text"; text: string }).text).toMatch(
      /^\*Note for agent: This `tool_2` took \d+ms to run\.\*$/
    );
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

  test("updates lastToolEndTime even on error", async () => {
    const errorTool: AgentTool = {
      name: "error_tool",
      label: "Error Tool",
      description: "Throws error",
      parameters: Type.Object({}),
      execute: () => {
        return Promise.reject(new Error("Tool failed"));
      },
    };
    const normalTool = createMockTool("normal_tool");
    const wrapped = wrapToolsWithTiming([errorTool, normalTool]);
    const w0 = wrapped[0];
    const w1 = wrapped[1];
    if (w0 === undefined || w1 === undefined) throw new Error("Missing tools");

    // First call throws
    try {
      await w0.execute("call-1", {}, undefined);
    } catch {
      // expected
    }

    // Wait 150ms
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Second call should measure from error tool's end time
    const result = await w1.execute("call-2", {}, undefined);
    expect(result.content).toHaveLength(2); // has timing note
  });

  test("format switches from ms to seconds appropriately", async () => {
    const tool = createMockTool("one_second_tool");
    const wrapped = getWrapped([tool], 0);

    // Wait just over 1 second before calling — tests second formatting
    await new Promise((resolve) => setTimeout(resolve, 1050));

    const result = await wrapped.execute("call-1", {}, undefined);

    expect(result.content).toHaveLength(2);
    // Should be formatted as "1.Xs" (seconds with decimal)
    expect((result.content[1] as { type: "text"; text: string }).text).toMatch(
      /^\*Note for agent: This `one_second_tool` took 1\.\ds to run\.\*$/
    );
  });
});
