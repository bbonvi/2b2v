import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

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
  /** Reset total elapsed time for a new agentic loop. */
  resetAgentLoopStart(): void;
  /** Mark the start of an LLM turn that may produce tool calls. */
  markModelTurnStart(): void;
  /** Mark when the LLM has produced tool calls and tool execution is about to begin. */
  markToolCallsReady(): void;
  /** Backward-compatible alias for resetting the current tool batch baseline. */
  setReferenceTime(): void;
}

/**
 * Wrap tools to append timing notes to results.
 *
 * Timing distinguishes LLM tool-call generation, the actual tool execution,
 * elapsed time for the current tool turn, and total elapsed agent-loop time.
 *
 * This correctly handles:
 * - Sequential tools: each gets its own execution duration
 * - Parallel tools: all share the same tool-call generation duration
 * - LLM generation time: measured from model-turn start to tool-call readiness
 */
export function wrapToolsWithTiming(tools: AgentTool[], now: () => number = () => Date.now()): { tools: AgentTool[]; state: TimingState } {
  let agentLoopStartedAt = now();
  let modelTurnStartedAt = agentLoopStartedAt;
  let toolCallsReadyAt = agentLoopStartedAt;

  const state: TimingState = {
    resetAgentLoopStart() {
      const current = now();
      agentLoopStartedAt = current;
      modelTurnStartedAt = current;
      toolCallsReadyAt = current;
    },
    markModelTurnStart() {
      const current = now();
      modelTurnStartedAt = current;
      toolCallsReadyAt = current;
    },
    markToolCallsReady() {
      toolCallsReadyAt = now();
    },
    setReferenceTime() {
      const current = now();
      modelTurnStartedAt = current;
      toolCallsReadyAt = current;
    },
  };

  const wrappedTools = tools.map((tool) => ({
    ...tool,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined
    ): Promise<AgentToolResult<unknown>> => {
      const toolStartedAt = now();
      const result = await tool.execute(toolCallId, params, signal);
      if (tool.name === "load_skill") return result;
      const completedAt = now();
      const toolCallGenerationMs = Math.max(0, toolCallsReadyAt - modelTurnStartedAt);
      const toolExecutionMs = completedAt - toolStartedAt;
      const toolTurnElapsedMs = completedAt - modelTurnStartedAt;
      const agentLoopElapsedMs = completedAt - agentLoopStartedAt;

      const note = [
        `\n*Note to agent: Timing for \`${tool.name}\`:`,
        `tool-call generation ${formatTiming(toolCallGenerationMs)},`,
        `tool execution ${formatTiming(toolExecutionMs)},`,
        `current tool turn ${formatTiming(toolTurnElapsedMs)},`,
        `agent loop elapsed ${formatTiming(agentLoopElapsedMs)}.*`,
      ].join(" ");
      return {
        ...result,
        content: [...result.content, { type: "text", text: note }],
      };
    },
  }));

  return { tools: wrappedTools, state };
}
