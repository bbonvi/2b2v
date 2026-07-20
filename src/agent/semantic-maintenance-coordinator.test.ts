import { describe, expect, test } from "bun:test";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  commitStagedMaintenanceCalls,
  SemanticMaintenanceCoordinator,
  stageMaintenanceTools,
} from "./semantic-maintenance-coordinator.ts";

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

function tool(name: string, execute: AgentTool["execute"]): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute,
  };
}

describe("SemanticMaintenanceCoordinator", () => {
  test("commits in reservation order while inference completes out of order", async () => {
    const coordinator = new SemanticMaintenanceCoordinator();
    const first = coordinator.reserve();
    const second = coordinator.reserve();
    const firstReady = deferred();
    const committed: number[] = [];

    const firstCommit = (async () => {
      await firstReady.promise;
      await first.commit(() => {
        committed.push(first.sequence);
        return Promise.resolve();
      });
    })();
    const secondCommit = second.commit(() => {
      committed.push(second.sequence);
      return Promise.resolve();
    });

    await Promise.resolve();
    expect(committed).toEqual([]);
    firstReady.resolve();
    await Promise.all([firstCommit, secondCommit]);
    expect(committed).toEqual([first.sequence, second.sequence]);
  });

  test("skip releases later commits and barriers", async () => {
    const coordinator = new SemanticMaintenanceCoordinator();
    const first = coordinator.reserve();
    const second = coordinator.reserve();
    const committed: number[] = [];
    const secondCommit = second.commit(() => {
      committed.push(second.sequence);
      return Promise.resolve();
    });
    const barrier = coordinator.barrier();

    first.skip();
    await Promise.all([secondCommit, barrier]);
    expect(committed).toEqual([second.sequence]);
  });
});

describe("staged maintenance tools", () => {
  test("validate without mutating and replay calls through real tools", async () => {
    const staged: Array<{ toolCallId: string; toolName: string; params: unknown }> = [];
    const mutations: unknown[] = [];
    const validationTool = tool("record_memory", (_id, _params) => Promise.resolve({
      content: [{ type: "text", text: "validated" }],
      details: { applied: 1 },
    }));
    const realTool = tool("record_memory", (_id, params) => {
      mutations.push(params);
      return Promise.resolve({
        content: [{ type: "text", text: "applied" }],
        details: { applied: 1 },
      } satisfies AgentToolResult<{ applied: number }>);
    });
    const stagedTool = stageMaintenanceTools(
      [validationTool],
      staged,
      new Set(["record_memory"]),
    )[0];
    if (stagedTool === undefined) throw new Error("Expected staged tool.");

    await stagedTool.execute("call-1", { actions: [{ action: "create" }] });
    expect(mutations).toEqual([]);
    expect(staged).toEqual([{
      toolCallId: "call-1",
      toolName: "record_memory",
      params: { actions: [{ action: "create" }] },
    }]);

    await commitStagedMaintenanceCalls({ calls: staged, tools: [realTool] });
    expect(mutations).toEqual([{ actions: [{ action: "create" }] }]);
  });
});
