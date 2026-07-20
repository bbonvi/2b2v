import type { AgentTool } from "@earendil-works/pi-agent-core";

const runtimeToolEffect = Symbol("runtimeToolEffect");

export type RuntimeToolEffect = "read" | "write" | "agent_state";
export type MaintenanceWriteToolName = "record_memory" | "record_relationship" | "record_inner_threads";

type ClassifiedAgentTool = AgentTool & {
  [runtimeToolEffect]?: RuntimeToolEffect;
};

/**
 * Classify a tool for runtime authorization without changing its provider schema.
 * Unclassified tools are treated as state-changing.
 */
export function withRuntimeToolEffect<T extends AgentTool>(
  tool: T,
  effect: RuntimeToolEffect,
): T {
  Object.defineProperty(tool, runtimeToolEffect, {
    value: effect,
    enumerable: true,
  });
  return tool;
}

/** Mark a tool as observational and safe to expose in maintenance passes. */
export function markReadOnlyTool<T extends AgentTool>(tool: T): T {
  return withRuntimeToolEffect(tool, "read");
}

/** Return the conservative runtime effect classification for a tool. */
export function getRuntimeToolEffect(tool: AgentTool): RuntimeToolEffect {
  return (tool as ClassifiedAgentTool)[runtimeToolEffect] ?? "write";
}

/** Whether a tool is explicitly classified as observational. */
export function isReadOnlyTool(tool: AgentTool): boolean {
  return getRuntimeToolEffect(tool) === "read";
}

/** Whether a tool may execute during one semantic maintenance mode. */
export function isToolAllowedInMaintenance(
  tool: AgentTool,
  allowedWriteName: MaintenanceWriteToolName,
): boolean {
  return tool.name === allowedWriteName || isReadOnlyTool(tool);
}
