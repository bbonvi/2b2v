import type { AgentTool } from "@earendil-works/pi-agent-core";

const DISCARDABLE_TURN_WRITE_TOOLS = new Set([
  "cancel_agent_job",
  "close_thread",
  "codex_generate_image",
  "delete_own_message",
  "delete_scheduled_message",
  "edit_own_message",
  "react_to_message",
  "record_memory",
  "record_relationship",
  "schedule_message",
  "start_thread",
  "timeout_user",
]);

/** Remove state-changing tools from turns that may be abandoned before send. */
export function readOnlyToolsForDiscardableTurn(tools: AgentTool[]): AgentTool[] {
  return tools.filter((tool) => !DISCARDABLE_TURN_WRITE_TOOLS.has(tool.name));
}
