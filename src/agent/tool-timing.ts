import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

/** Timing threshold in milliseconds — notes only shown if elapsed >= this value. */
const TIMING_THRESHOLD_MS = 100;

/**
 * Format elapsed milliseconds for display.
 * - < 1000ms: "Xms"
 * - 1000-9999ms: "X.Xs"
 * - >= 10000ms: "Xs" (rounded integer)
 */
export function formatTiming(ms: number): string {
  if (ms >= 1000) {
    const secs = ms / 1000;
    return secs >= 10 ? `${Math.round(secs)}s` : `${secs.toFixed(1)}s`;
  }
  return `${ms}ms`;
}

/**
 * Wrap tools to append timing notes to results.
 *
 * Timing measures elapsed time since the previous tool completed (or since
 * wrapper creation for the first call). This tells the agent how long the
 * user has been waiting, accounting for LLM thinking time between tool calls.
 *
 * Notes are only appended if elapsed time >= 100ms.
 */
export function wrapToolsWithTiming(tools: AgentTool[]): AgentTool[] {
  // Shared mutable state: tracks when last tool execution finished
  const state = { lastToolEndTime: Date.now() };

  return tools.map((tool) => ({
    ...tool,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined
    ): Promise<AgentToolResult<unknown>> => {
      const elapsed = Date.now() - state.lastToolEndTime;

      try {
        const result = await tool.execute(toolCallId, params, signal);

        // Append timing note if elapsed >= threshold
        if (elapsed >= TIMING_THRESHOLD_MS) {
          const note = `\n*Note for agent: This \`${tool.name}\` took ${formatTiming(elapsed)} to run.*`;
          return {
            ...result,
            content: [...result.content, { type: "text", text: note }],
          };
        }

        return result;
      } finally {
        // Always update end time, even on error
        state.lastToolEndTime = Date.now();
      }
    },
  }));
}
