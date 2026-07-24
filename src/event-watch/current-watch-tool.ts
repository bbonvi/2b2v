import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database.ts";
import { updateEventWatch } from "../db/event-watch-repository.ts";

const UpdateCurrentEventWatchParams = Type.Object({
  watchId: Type.String(),
  handoffNote: Type.String(),
  complete: Type.Optional(Type.Boolean()),
});

export function createUpdateCurrentEventWatchTool(input: {
  db: Database;
  watchIds: readonly string[];
  onCompleted?: (watchId: string) => void;
}): AgentTool {
  const allowed = new Set(input.watchIds);
  return {
    name: "update_current_event_watch",
    label: "update_current_event_watch",
    description: "Replace one current watch handoff or complete that watch.",
    parameters: UpdateCurrentEventWatchParams,
    execute(_toolCallId, rawParams): Promise<AgentToolResult<{ updated: boolean; complete: boolean }>> {
      const params = rawParams as { watchId?: string; handoffNote?: string; complete?: boolean };
      const watchId = params.watchId?.trim() ?? "";
      const handoffNote = params.handoffNote?.trim() ?? "";
      if (!allowed.has(watchId)) {
        return Promise.resolve({
          content: [{ type: "text", text: "watchId is not attached to this turn." }],
          details: { updated: false, complete: false },
        });
      }
      if (handoffNote === "") {
        return Promise.resolve({
          content: [{ type: "text", text: "handoffNote is required." }],
          details: { updated: false, complete: false },
        });
      }
      const complete = params.complete === true;
      const updated = updateEventWatch(input.db, watchId, {
        handoffNote,
        ...(complete ? { enabled: false } : {}),
      });
      if (complete) input.onCompleted?.(watchId);
      return Promise.resolve({
        content: [{ type: "text", text: complete ? "Updated the handoff and completed the watch." : "Updated the watch handoff." }],
        details: { updated, complete },
      });
    },
  };
}
