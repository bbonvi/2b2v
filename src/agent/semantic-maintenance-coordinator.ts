import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export interface StagedMaintenanceCall {
  toolCallId: string;
  toolName: string;
  params: unknown;
}

export interface MaintenanceCommitTicket {
  sequence: number;
  commit(apply: () => Promise<void>): Promise<void>;
  skip(): void;
}

/**
 * Order semantic mutation batches by source event while allowing their model
 * inference and validation work to run concurrently.
 */
export class SemanticMaintenanceCoordinator {
  private nextSequence = 1;
  private tail = Promise.resolve();

  reserve(): MaintenanceCommitTicket {
    const sequence = this.nextSequence++;
    const predecessor = this.tail;
    let release: (() => void) | undefined;
    let settled = false;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    const settle = (): void => {
      if (settled) return;
      settled = true;
      release?.();
    };

    return {
      sequence,
      commit: async (apply): Promise<void> => {
        if (settled) throw new Error(`Semantic maintenance ticket ${sequence} is already settled.`);
        await predecessor;
        try {
          await apply();
        } finally {
          settle();
        }
      },
      skip: settle,
    };
  }

  /** Wait for every job reserved before this call to finish or be skipped. */
  async barrier(): Promise<void> {
    await this.tail;
  }
}

/**
 * Validate maintenance mutations during inference and retain their arguments
 * for a later ordered commit without changing the provider-visible schema.
 */
export function stageMaintenanceTools(
  tools: readonly AgentTool[],
  stagedCalls: StagedMaintenanceCall[],
  stagedToolNames: ReadonlySet<string>,
): AgentTool[] {
  return tools.map((tool) => {
    if (!stagedToolNames.has(tool.name)) return tool;
    return {
      ...tool,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<unknown>> => {
        const result = await tool.execute(toolCallId, params, signal);
        stagedCalls.push({ toolCallId, toolName: tool.name, params });
        return result;
      },
    };
  });
}

/** Replay one validated maintenance job against its real mutation tools. */
export async function commitStagedMaintenanceCalls(input: {
  calls: readonly StagedMaintenanceCall[];
  tools: readonly AgentTool[];
  onResult?: (call: StagedMaintenanceCall, result: AgentToolResult<unknown>) => void;
}): Promise<void> {
  const toolsByName = new Map(input.tools.map((tool) => [tool.name, tool]));
  for (const call of input.calls) {
    const tool = toolsByName.get(call.toolName);
    if (tool === undefined) {
      throw new Error(`Missing commit tool ${call.toolName}.`);
    }
    const result = await tool.execute(call.toolCallId, call.params);
    input.onResult?.(call, result);
  }
}
