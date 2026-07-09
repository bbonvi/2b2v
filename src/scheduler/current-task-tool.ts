import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database";
import { updateSchedule } from "../db/schedule-repository";

const UpdateCurrentScheduledTaskParams = Type.Object({
  handoffNote: Type.String({
    description: "Complete concise handoff note for the next run, not just what changed.",
  }),
  complete: Type.Optional(Type.Boolean({
    description: "Disable this recurring task after the current run.",
  })),
});

export function createUpdateCurrentScheduledTaskTool(input: {
  db: Database;
  scheduleId: string;
  onCompleted?: (scheduleId: string) => void;
}): AgentTool {
  return {
    name: "update_current_scheduled_task",
    label: "update_current_scheduled_task",
    description: "Update the current scheduled task handoff note or complete it.",
    parameters: UpdateCurrentScheduledTaskParams,
    execute(
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<AgentToolResult<{ updated: boolean; complete: boolean }>> {
      const params = rawParams as { handoffNote?: string; complete?: boolean };
      const handoffNote = params.handoffNote?.trim() ?? "";
      if (handoffNote === "") {
        return Promise.resolve({
          content: [{ type: "text", text: "handoffNote is required." }],
          details: { updated: false, complete: false },
        });
      }

      const complete = params.complete === true;
      const updated = updateSchedule(input.db, input.scheduleId, {
        handoffNote,
        ...(complete ? { enabled: false } : {}),
      });
      if (complete) input.onCompleted?.(input.scheduleId);

      return Promise.resolve({
        content: [{ type: "text", text: complete ? "Updated handoff and completed current scheduled task." : "Updated handoff." }],
        details: { updated, complete },
      });
    },
  };
}
