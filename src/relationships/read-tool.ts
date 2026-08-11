import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database.ts";
import { markReadOnlyTool } from "../agent/tool-effects.ts";
import { renderRelationshipMaintenanceContext } from "./context.ts";
import { getRelationshipProfile, listRelationshipEvents } from "./repository.ts";

/** Create private on-demand retrieval for complete relationship profiles. */
export function createReadRelationshipsTool(input: {
  db: Database;
  resolveUserLabel: (userId: string) => string;
  description?: string;
}): AgentTool {
  return markReadOnlyTool({
    name: "read_relationships",
    label: "read_relationships",
    description: input.description ?? "Read complete current relationship state for selected Discord user IDs.",
    parameters: Type.Object({
      user_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 10 }),
    }),
    execute: (_toolCallId, params) => {
      const userIds = [...new Set((params as { user_ids: string[] }).user_ids.map((id) => id.trim()))]
        .filter((id) => id !== "");
      const text = userIds.map((userId) => renderRelationshipMaintenanceContext({
        current: {
          profile: getRelationshipProfile(input.db, userId),
          label: input.resolveUserLabel(userId),
          events: listRelationshipEvents(input.db, { userId, limit: 30 }),
        },
      })).join("\n\n");
      return Promise.resolve({
        content: [{ type: "text", text }],
        details: { userIds, count: userIds.length },
      });
    },
  });
}
