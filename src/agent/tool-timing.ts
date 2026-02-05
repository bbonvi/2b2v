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

export interface TimingState {
  /** Set externally when LLM turn ends, before tools execute. */
  setReferenceTime(): void;
}

/**
 * Wrap tools to append timing notes to results.
 *
 * Timing measures end-to-end time from reference point to tool completion.
 * The reference point is set externally via `state.setReferenceTime()` — call it
 * when the LLM response completes (message_end event) to include thinking time.
 *
 * This correctly handles:
 * - Sequential tools: reference set before each tool batch
 * - Parallel tools: all measure from same reference point
 * - LLM thinking time: included when reference is set at message_end
 */
export function wrapToolsWithTiming(tools: AgentTool[]): { tools: AgentTool[]; state: TimingState } {
  let referenceTime = Date.now();

  const state: TimingState = {
    setReferenceTime() {
      referenceTime = Date.now();
    },
  };

  const wrappedTools = tools.map((tool) => ({
    ...tool,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined
    ): Promise<AgentToolResult<unknown>> => {
      const result = await tool.execute(toolCallId, params, signal);
      const elapsed = Date.now() - referenceTime;

      const note = `\n*Note to agent: This \`${tool.name}\` tool took ${formatTiming(elapsed)} to run.*`;
      return {
        ...result,
        content: [...result.content, { type: "text", text: note }],
      };
    },
  }));

  return { tools: wrappedTools, state };
}
