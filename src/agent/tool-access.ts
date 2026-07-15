import type { AgentTool } from "@earendil-works/pi-agent-core";

const WRITE_TOOL_NAMES = new Set([
  "cancel_agent_job",
  "close_thread",
  "codex_generate_image",
  "delete_own_message",
  "delete_scheduled_task",
  "discord_remove_user_timeout",
  "discord_set_user_timeout",
  "edit_own_message",
  "react_to_message",
  "roll_dice",
  "schedule_task",
  "update_current_scheduled_task",
  "start_thread",
]);

export function isWriteToolName(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

/** Mark a stale-droppable turn as committed as soon as a state-changing tool starts. */
export function trackWriteToolStarts(tools: AgentTool[], onWriteToolStart: (toolName: string) => void): AgentTool[] {
  return tools.map((tool) => !isWriteToolName(tool.name)
    ? tool
    : {
        ...tool,
        execute: (toolCallId, params, signal) => {
          onWriteToolStart(tool.name);
          return tool.execute(toolCallId, params, signal);
        },
      });
}
