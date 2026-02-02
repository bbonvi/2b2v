import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Database } from "../db/database";
import {
  createMemory,
  updateMemory,
  deleteMemory,
  getMemory,
  listMemories,
  type MemoryScope,
  type MemoryRow,
} from "../db/memory-repository";

export interface MemoryToolsDeps {
  db: Database;
  /** Current guild ID — scoped tools auto-inject this. */
  guildId: string;
  /** Bot's own user ID — auto-injected as userId for journal scope. */
  botUserId: string;
  /** Called after a memory is created or updated, for embedding. */
  onMemoryChanged?: (memoryId: string, content: string) => void;
  /** Called after a memory is deleted, for Qdrant cleanup. */
  onMemoryDeleted?: (memoryId: string) => void;
}

interface SaveMemoryParams {
  scope: MemoryScope;
  content: string;
  userId?: string;
  id?: string;
  shortDescription?: string;
  longDescription?: string;
  ttlDays?: number | null;
  sourceMessageId?: string;
}

interface DeleteMemoryParams {
  id: string;
}

interface ListMemoriesParams {
  scope: MemoryScope;
  userId?: string;
  limit?: number;
}

const SaveMemorySchema = Type.Object({
  scope: Type.Union(
    [Type.Literal("user"), Type.Literal("journal")],
    { description: "Memory scope. 'user' = per-user facts (requires userId), 'journal' = bot's own notes (no userId needed)." }
  ),
  content: Type.String({ description: "Memory content. For journal entries, leave empty and use shortDescription/longDescription instead." }),
  userId: Type.Optional(Type.String({ description: "Target user ID. Required for scope 'user'." })),
  id: Type.Optional(Type.String({ description: "Existing memory ID to update. Omit to create new." })),
  shortDescription: Type.Optional(Type.String({ description: "Short description. Always visible in context." })),
  longDescription: Type.Optional(Type.String({ description: "Long description. Pulled on demand." })),
  ttlDays: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Days until expiry. Default 180. Pass null for no expiry." })),
  sourceMessageId: Type.Optional(Type.String({ description: "Discord message ID that triggered this memory." })),
});

const DeleteMemorySchema = Type.Object({
  id: Type.String({ description: "Memory ID to delete." }),
});

const ListMemoriesSchema = Type.Object({
  scope: Type.Union(
    [Type.Literal("user"), Type.Literal("journal")],
    { description: "Memory scope to list." }
  ),
  userId: Type.Optional(Type.String({ description: "Filter by user ID (for scope 'user')." })),
  limit: Type.Optional(Type.Number({ description: "Max entries to return. Default 50." })),
});

/**
 * Create memory agent tools bound to a guild context.
 * Returns [save_memory, delete_memory, list_memories].
 */
export function createMemoryTools(deps: MemoryToolsDeps): AgentTool[] {
  const { db, guildId, botUserId, onMemoryChanged, onMemoryDeleted } = deps;

  const saveMemory: AgentTool = {
    name: "save_memory",
    label: "Save Memory",
    description:
      "Create or update a memory entry. Use scope 'user' for per-user facts (requires userId), 'journal' for bot's own notes. Provide 'id' to update an existing entry.",
    parameters: SaveMemorySchema,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ memoryId: string; action: string; success: boolean }>> => {
      const p = params as SaveMemoryParams;

      if (p.id !== undefined) {
        // Verify the memory belongs to this guild before allowing mutation
        const existing = getMemory(db, p.id);
        if (existing === null) {
          return Promise.resolve({
            content: [{ type: "text", text: `Memory ${p.id} not found.` }],
            details: { memoryId: p.id, action: "update", success: false },
          });
        }
        if (existing.guildId !== null && existing.guildId !== guildId) {
          return Promise.resolve({
            content: [{ type: "text", text: `Memory ${p.id} not found.` }],
            details: { memoryId: p.id, action: "update", success: false },
          });
        }
        const updated = updateMemory(db, p.id, {
          content: p.content,
          shortDescription: p.shortDescription,
          longDescription: p.longDescription,
          ttlDays: p.ttlDays,
        });
        if (updated) {
          onMemoryChanged?.(p.id, p.content);
        }
        return Promise.resolve({
          content: [{ type: "text", text: updated ? `Saved (updated) memory ${p.id}.` : `Memory ${p.id} not found.` }],
          details: { memoryId: p.id, action: "update", success: updated },
        });
      }

      const scope = p.scope;
      const userId = scope === "journal" ? botUserId : p.userId ?? "";
      const id = createMemory(db, {
        scope,
        guildId,
        userId,
        content: p.content,
        shortDescription: p.shortDescription,
        longDescription: p.longDescription,
        sourceMessageId: p.sourceMessageId,
        ttlDays: p.ttlDays,
      });
      onMemoryChanged?.(id, p.content);

      return Promise.resolve({
        content: [{ type: "text", text: `Saved new ${scope} memory ${id}.` }],
        details: { memoryId: id, action: "create", success: true },
      });
    },
  };

  const deleteMemoryTool: AgentTool = {
    name: "delete_memory",
    label: "Delete Memory",
    description: "Delete a memory entry by its ID.",
    parameters: DeleteMemorySchema,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ memoryId: string; success: boolean }>> => {
      const p = params as DeleteMemoryParams;
      // Verify the memory belongs to this guild before allowing deletion
      const existing = getMemory(db, p.id);
      if (existing === null || existing.guildId !== guildId) {
        return Promise.resolve({
          content: [{ type: "text", text: `Memory ${p.id} not found.` }],
          details: { memoryId: p.id, success: false },
        });
      }
      const deleted = deleteMemory(db, p.id);
      if (deleted) {
        onMemoryDeleted?.(p.id);
      }
      return Promise.resolve({
        content: [{ type: "text", text: deleted ? `Deleted memory ${p.id}.` : `Memory ${p.id} not found.` }],
        details: { memoryId: p.id, success: deleted },
      });
    },
  };

  const listMemoriesTool: AgentTool = {
    name: "list_memories",
    label: "List Memories",
    description:
      "List memory entries by scope. For 'user' scope, provide userId. Journal entries show short descriptions only.",
    parameters: ListMemoriesSchema,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ count: number } | undefined>> => {
      const p = params as ListMemoriesParams;
      const scope = p.scope;
      const userId = scope === "journal" ? botUserId : p.userId;

      const rows = listMemories(db, {
        scope,
        guildId,
        userId,
        limit: p.limit ?? 50,
      });

      if (rows.length === 0) {
        return Promise.resolve({ content: [{ type: "text", text: `No memories found for scope '${scope}'.` }], details: undefined });
      }

      const lines = rows.map((r) => formatMemoryLine(r));
      return Promise.resolve({
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: rows.length },
      });
    },
  };

  return [saveMemory, deleteMemoryTool, listMemoriesTool];
}

function formatMemoryLine(row: MemoryRow): string {
  const parts = [`[${row.id}]`];
  if (row.scope === "user" && row.userId !== null) parts.push(`user:${row.userId}`);
  if (row.shortDescription !== null && row.shortDescription !== "") {
    parts.push(row.shortDescription);
  } else {
    parts.push(row.content);
  }
  return parts.join(" ");
}
