import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Database } from "../db/database";
import {
  createMemory,
  updateMemory,
  deleteMemory,
  getMemory,
  listMemories,
  type MemoryRow,
} from "../db/memory-repository";

export interface MemoryToolsDeps {
  db: Database;
  /** Current guild ID — scoped tools auto-inject this. */
  guildId: string;
  /** Bot's own user ID — auto-injected as userId for journal scope. */
  botUserId: string;
  /** Called after a memory is created or updated, for embedding. */
  onMemoryChanged?: (memoryId: number, text: string) => void;
  /** Called after a memory is deleted, for Qdrant cleanup. */
  onMemoryDeleted?: (memoryId: number) => void;
}

// ---------------------------------------------------------------------------
// Journal Schemas
// ---------------------------------------------------------------------------

interface SaveJournalParams {
  shortDescription: string;
  id?: number;
  longDescription?: string;
  ttlDays?: number | null;
  sourceMessageId?: string;
}

interface DeleteJournalParams {
  id: number;
}

const SaveJournalSchema = Type.Object({
  shortDescription: Type.String({ description: "Primary journal text. Visible in context under '## Journal'." }),
  id: Type.Optional(Type.Integer({ description: "Existing journal ID to update. Omit to create new." })),
  longDescription: Type.Optional(Type.String({ description: "Extended details (optional)." })),
  ttlDays: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Days until expiry. Default 180. Pass null for no expiry." })),
  sourceMessageId: Type.Optional(Type.String({ description: "Discord message ID that triggered this journal entry." })),
});

const DeleteJournalSchema = Type.Object({
  id: Type.Integer({ description: "Journal entry ID to delete." }),
});

// ---------------------------------------------------------------------------
// User Memory Schemas
// ---------------------------------------------------------------------------

interface SaveUserMemoryParams {
  userId: string;
  shortDescription: string;
  id?: number;
  longDescription?: string;
  ttlDays?: number | null;
  sourceMessageId?: string;
}

interface DeleteUserMemoryParams {
  id: number;
}

interface RecallUserMemoriesParams {
  userId?: string;
  limit?: number;
}

const SaveUserMemorySchema = Type.Object({
  userId: Type.String({ description: "Target user ID (required)." }),
  shortDescription: Type.String({ description: "Primary memory text." }),
  id: Type.Optional(Type.Integer({ description: "Existing memory ID to update. Omit to create new." })),
  longDescription: Type.Optional(Type.String({ description: "Extended details (optional)." })),
  ttlDays: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Days until expiry. Default 180. Pass null for no expiry." })),
  sourceMessageId: Type.Optional(Type.String({ description: "Discord message ID that triggered this memory." })),
});

const DeleteUserMemorySchema = Type.Object({
  id: Type.Integer({ description: "User memory ID to delete." }),
});

const RecallUserMemoriesSchema = Type.Object({
  userId: Type.Optional(Type.String({ description: "Filter by user ID. Omit to list all user memories in this guild." })),
  limit: Type.Optional(Type.Number({ description: "Max entries to return. Default 50." })),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function embeddingText(shortDescription: string, longDescription?: string): string {
  return longDescription !== undefined && longDescription !== ""
    ? `${shortDescription}\n\n${longDescription}`
    : shortDescription;
}

function formatMemoryLine(row: MemoryRow): string {
  const parts = [`[${row.id}]`];
  if (row.scope === "user" && row.userId !== null) parts.push(`user:${row.userId}`);
  parts.push(row.shortDescription);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create memory agent tools bound to a guild context.
 * Returns 5 tools: save_journal, delete_journal, save_user_memory, delete_user_memory, recall_user_memories.
 */
export function createMemoryTools(deps: MemoryToolsDeps): AgentTool[] {
  const { db, guildId, botUserId, onMemoryChanged, onMemoryDeleted } = deps;

  // -------------------------------------------------------------------------
  // save_journal
  // -------------------------------------------------------------------------
  const saveJournal: AgentTool = {
    name: "save_journal",
    label: "Save Journal",
    description:
      "Create or update a bot journal entry. Journal entries are visible in your context under '## Journal'. Provide 'id' to update an existing entry.",
    parameters: SaveJournalSchema,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ memoryId: number; action: string; success: boolean }>> => {
      const p = params as SaveJournalParams;

      if (p.id !== undefined) {
        // Verify the memory belongs to this guild AND is a journal entry
        const existing = getMemory(db, p.id);
        if (existing === null) {
          return Promise.resolve({
            content: [{ type: "text", text: `Journal entry ${p.id} not found.` }],
            details: { memoryId: p.id, action: "update", success: false },
          });
        }
        if (existing.guildId !== null && existing.guildId !== guildId) {
          return Promise.resolve({
            content: [{ type: "text", text: `Journal entry ${p.id} not found.` }],
            details: { memoryId: p.id, action: "update", success: false },
          });
        }
        if (existing.scope !== "journal") {
          return Promise.resolve({
            content: [{ type: "text", text: `ID ${p.id} is not a journal entry. Use save_user_memory to update user memories.` }],
            details: { memoryId: p.id, action: "update", success: false },
          });
        }
        const updated = updateMemory(db, p.id, {
          shortDescription: p.shortDescription,
          longDescription: p.longDescription,
          ttlDays: p.ttlDays,
        });
        if (updated) {
          onMemoryChanged?.(p.id, embeddingText(p.shortDescription, p.longDescription));
        }
        return Promise.resolve({
          content: [{ type: "text", text: updated ? `Saved (updated) journal entry ${p.id}.` : `Journal entry ${p.id} not found.` }],
          details: { memoryId: p.id, action: "update", success: updated },
        });
      }

      // Create new journal entry
      const id = createMemory(db, {
        scope: "journal",
        guildId,
        userId: botUserId,
        shortDescription: p.shortDescription,
        longDescription: p.longDescription,
        sourceMessageId: p.sourceMessageId,
        ttlDays: p.ttlDays,
      });
      onMemoryChanged?.(id, embeddingText(p.shortDescription, p.longDescription));

      return Promise.resolve({
        content: [{ type: "text", text: `Saved new journal entry ${id}.` }],
        details: { memoryId: id, action: "create", success: true },
      });
    },
  };

  // -------------------------------------------------------------------------
  // delete_journal
  // -------------------------------------------------------------------------
  const deleteJournal: AgentTool = {
    name: "delete_journal",
    label: "Delete Journal",
    description: "Delete a journal entry by its ID.",
    parameters: DeleteJournalSchema,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ memoryId: number; success: boolean }>> => {
      const p = params as DeleteJournalParams;
      const existing = getMemory(db, p.id);
      if (existing === null || existing.guildId !== guildId) {
        return Promise.resolve({
          content: [{ type: "text", text: `Journal entry ${p.id} not found.` }],
          details: { memoryId: p.id, success: false },
        });
      }
      if (existing.scope !== "journal") {
        return Promise.resolve({
          content: [{ type: "text", text: `ID ${p.id} is not a journal entry. Use delete_user_memory for user memories.` }],
          details: { memoryId: p.id, success: false },
        });
      }
      const deleted = deleteMemory(db, p.id);
      if (deleted) {
        onMemoryDeleted?.(p.id);
      }
      return Promise.resolve({
        content: [{ type: "text", text: deleted ? `Deleted journal entry ${p.id}.` : `Journal entry ${p.id} not found.` }],
        details: { memoryId: p.id, success: deleted },
      });
    },
  };

  // -------------------------------------------------------------------------
  // save_user_memory
  // -------------------------------------------------------------------------
  const saveUserMemory: AgentTool = {
    name: "save_user_memory",
    label: "Save User Memory",
    description:
      "Create or update a memory about a user. User memories are NOT in context — use 'recall_user_memories' to retrieve them. Provide 'id' to update an existing entry.",
    parameters: SaveUserMemorySchema,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ memoryId: number; action: string; success: boolean }>> => {
      const p = params as SaveUserMemoryParams;

      if (p.id !== undefined) {
        // Verify the memory belongs to this guild AND is a user memory
        const existing = getMemory(db, p.id);
        if (existing === null) {
          return Promise.resolve({
            content: [{ type: "text", text: `User memory ${p.id} not found.` }],
            details: { memoryId: p.id, action: "update", success: false },
          });
        }
        if (existing.guildId !== null && existing.guildId !== guildId) {
          return Promise.resolve({
            content: [{ type: "text", text: `User memory ${p.id} not found.` }],
            details: { memoryId: p.id, action: "update", success: false },
          });
        }
        if (existing.scope !== "user") {
          return Promise.resolve({
            content: [{ type: "text", text: `ID ${p.id} is not a user memory. Use save_journal to update journal entries.` }],
            details: { memoryId: p.id, action: "update", success: false },
          });
        }
        const updated = updateMemory(db, p.id, {
          shortDescription: p.shortDescription,
          longDescription: p.longDescription,
          ttlDays: p.ttlDays,
        });
        if (updated) {
          onMemoryChanged?.(p.id, embeddingText(p.shortDescription, p.longDescription));
        }
        return Promise.resolve({
          content: [{ type: "text", text: updated ? `Saved (updated) user memory ${p.id}.` : `User memory ${p.id} not found.` }],
          details: { memoryId: p.id, action: "update", success: updated },
        });
      }

      // Create new user memory
      const id = createMemory(db, {
        scope: "user",
        guildId,
        userId: p.userId,
        shortDescription: p.shortDescription,
        longDescription: p.longDescription,
        sourceMessageId: p.sourceMessageId,
        ttlDays: p.ttlDays,
      });
      onMemoryChanged?.(id, embeddingText(p.shortDescription, p.longDescription));

      return Promise.resolve({
        content: [{ type: "text", text: `Saved new user memory ${id}.` }],
        details: { memoryId: id, action: "create", success: true },
      });
    },
  };

  // -------------------------------------------------------------------------
  // delete_user_memory
  // -------------------------------------------------------------------------
  const deleteUserMemory: AgentTool = {
    name: "delete_user_memory",
    label: "Delete User Memory",
    description: "Delete a user memory by its ID.",
    parameters: DeleteUserMemorySchema,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ memoryId: number; success: boolean }>> => {
      const p = params as DeleteUserMemoryParams;
      const existing = getMemory(db, p.id);
      if (existing === null || existing.guildId !== guildId) {
        return Promise.resolve({
          content: [{ type: "text", text: `User memory ${p.id} not found.` }],
          details: { memoryId: p.id, success: false },
        });
      }
      if (existing.scope !== "user") {
        return Promise.resolve({
          content: [{ type: "text", text: `ID ${p.id} is not a user memory. Use delete_journal for journal entries.` }],
          details: { memoryId: p.id, success: false },
        });
      }
      const deleted = deleteMemory(db, p.id);
      if (deleted) {
        onMemoryDeleted?.(p.id);
      }
      return Promise.resolve({
        content: [{ type: "text", text: deleted ? `Deleted user memory ${p.id}.` : `User memory ${p.id} not found.` }],
        details: { memoryId: p.id, success: deleted },
      });
    },
  };

  // -------------------------------------------------------------------------
  // recall_user_memories
  // -------------------------------------------------------------------------
  const recallUserMemories: AgentTool = {
    name: "recall_user_memories",
    label: "Recall User Memories",
    description:
      "Retrieve stored user memories. User memories are NOT in context by default — call this to discover them. Optionally filter by userId.",
    parameters: RecallUserMemoriesSchema,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ count: number } | undefined>> => {
      const p = params as RecallUserMemoriesParams;

      const rows = listMemories(db, {
        scope: "user",
        guildId,
        userId: p.userId,
        limit: p.limit ?? 50,
      });

      if (rows.length === 0) {
        const msg = p.userId !== undefined
          ? `No user memories found for user ${p.userId}.`
          : "No user memories found.";
        return Promise.resolve({ content: [{ type: "text", text: msg }], details: undefined });
      }

      const lines = rows.map((r) => formatMemoryLine(r));
      return Promise.resolve({
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: rows.length },
      });
    },
  };

  return [saveJournal, deleteJournal, saveUserMemory, deleteUserMemory, recallUserMemories];
}
