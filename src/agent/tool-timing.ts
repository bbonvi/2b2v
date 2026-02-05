import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

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
 * Timing measures end-to-end time from batch start to tool completion.
 * A "batch" is a group of tools executing concurrently — all tools in a batch
 * measure from the same reference point (when the first tool started).
 * When the last tool in a batch completes, the reference resets for the next batch.
 *
 * This correctly handles:
 * - Sequential tools: each is its own batch, measures its execution time
 * - Parallel tools: all measure from same start, no race conditions
 * - LLM thinking time: included in the first tool's timing of each batch
 */
export function wrapToolsWithTiming(tools: AgentTool[]): AgentTool[] {
  const state = {
    referenceTime: 0, // Set when first tool of batch starts
    activeTools: 0, // Tools currently executing
  };

  return tools.map((tool) => ({
    ...tool,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined
    ): Promise<AgentToolResult<unknown>> => {
      // First tool of a new batch — set reference time
      if (state.activeTools === 0) {
        state.referenceTime = Date.now();
      }
      state.activeTools++;

      try {
        const result = await tool.execute(toolCallId, params, signal);
        const elapsed = Date.now() - state.referenceTime;

        const note = `\n*Note to agent: This \`${tool.name}\` tool took ${formatTiming(elapsed)} to run.*`;
        return {
          ...result,
          content: [...result.content, { type: "text", text: note }],
        };
      } finally {
        state.activeTools--;
        if (state.activeTools === 0) {
          // Batch complete — set new reference for next batch
          state.referenceTime = Date.now();
        }
      }
    },
  }));
}
