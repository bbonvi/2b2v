import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Database } from "../db/database";
import {
  createMemory,
  updateMemory,
  deleteMemory,
  getMemory,
  listMemories,
} from "../db/memory-repository";
import { formatJournalTimestamp, formatRelativeAgo } from "./history-dates";

export interface MemoryToolsDeps {
  db: Database;
  /** Current guild ID — scoped tools auto-inject this. */
  guildId: string;
  /** Bot's own user ID — auto-injected as userId for journal scope. */
  botUserId: string;
  /** Resolve username to userId. Returns undefined if not found. */
  resolveUsername: (username: string) => string | undefined;
  /** Called after a memory is created or updated, for embedding. */
  onMemoryChanged?: (memoryId: number, text: string) => void;
  /** Called after a memory is deleted, for Qdrant cleanup. */
  onMemoryDeleted?: (memoryId: number) => void;
}

// ---------------------------------------------------------------------------
// Journal Schemas
// ---------------------------------------------------------------------------

interface SaveJournalEntryParams {
  title: string;
  content: string;
  id?: number;
  ttlDays?: number | null;
  sourceMessageId?: string;
}

interface DeleteJournalEntryParams {
  id: number;
}

interface RecallJournalEntryParams {
  id: number;
}

const SaveJournalEntrySchema = Type.Object({
  title: Type.String({ description: "Journal entry title. Visible in context under '## Journal'." }),
  content: Type.String({ description: "Extended details (required)." }),
  id: Type.Optional(Type.Integer({ description: "Existing journal ID to update. Omit to create new." })),
  ttlDays: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Days until expiry. Default 180. Pass null for no expiry." })),
  sourceMessageId: Type.Optional(Type.String({ description: "Discord message ID that triggered this journal entry." })),
});

const DeleteJournalEntrySchema = Type.Object({
  id: Type.Integer({ description: "Journal entry ID to delete." }),
});

const RecallJournalEntrySchema = Type.Object({
  id: Type.Integer({ description: "Journal entry ID to retrieve." }),
});

// ---------------------------------------------------------------------------
// User Memory Schemas
// ---------------------------------------------------------------------------

interface SaveUserMemoryParams {
  username: string;
  title: string;
  id?: number;
  content?: string;
  ttlDays?: number | null;
  sourceMessageId?: string;
}

interface DeleteUserMemoryParams {
  id: number;
}

interface RecallUserMemoriesParams {
  username?: string;
  limit?: number;
}

const SaveUserMemorySchema = Type.Object({
  username: Type.String({ description: "Target username (required). Use the @username from chat history." }),
  title: Type.String({ description: "Primary memory text." }),
  id: Type.Optional(Type.Integer({ description: "Existing memory ID to update. Omit to create new." })),
  content: Type.Optional(Type.String({ description: "Extended details (optional)." })),
  ttlDays: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Days until expiry. Default 180. Pass null for no expiry." })),
  sourceMessageId: Type.Optional(Type.String({ description: "Discord message ID that triggered this memory." })),
});

const DeleteUserMemorySchema = Type.Object({
  id: Type.Integer({ description: "User memory ID to delete." }),
});

const RecallUserMemoriesSchema = Type.Object({
  username: Type.Optional(Type.String({ description: "Filter by username. Omit to list all user memories in this guild." })),
  limit: Type.Optional(Type.Number({ description: "Max entries to return. Default 50." })),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function embeddingText(title: string, content?: string | null): string {
  return content !== undefined && content !== null && content !== ""
    ? `${title}\n\n${content}`
    : title;
}


// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create memory agent tools bound to a guild context.
 * Returns 6 tools: save_journal_entry, recall_journal_entry, delete_journal_entry,
 * save_user_memory, delete_user_memory, recall_user_memories.
 */
export function createMemoryTools(deps: MemoryToolsDeps): AgentTool[] {
  const { db, guildId, botUserId, resolveUsername, onMemoryChanged, onMemoryDeleted } = deps;

  // -------------------------------------------------------------------------
  // save_journal_entry
  // -------------------------------------------------------------------------
  const saveJournalEntry: AgentTool = {
    name: "save_journal_entry",
    label: "Save Journal Entry",
    description:
      "Create or update a bot journal entry. Journal entries are visible in your context under '## Journal'. Provide 'id' to update an existing entry.",
    parameters: SaveJournalEntrySchema,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ memoryId: number; action: string; success: boolean }>> => {
      const p = params as SaveJournalEntryParams;

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
          title: p.title,
          content: p.content,
          ttlDays: p.ttlDays,
        });
        if (updated) {
          onMemoryChanged?.(p.id, embeddingText(p.title, p.content));
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
        title: p.title,
        content: p.content,
        sourceMessageId: p.sourceMessageId,
        ttlDays: p.ttlDays,
      });
      onMemoryChanged?.(id, embeddingText(p.title, p.content));

      return Promise.resolve({
        content: [{ type: "text", text: `Saved new journal entry ${id}.` }],
        details: { memoryId: id, action: "create", success: true },
      });
    },
  };

  // -------------------------------------------------------------------------
  // recall_journal_entry
  // -------------------------------------------------------------------------
  const recallJournalEntry: AgentTool = {
    name: "recall_journal_entry",
    label: "Recall Journal Entry",
    description: "Retrieve a journal entry's full details by its ID. Use this to view the full content of entries shown in '## Journal'.",
    parameters: RecallJournalEntrySchema,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ memoryId: number; found: boolean }>> => {
      const p = params as RecallJournalEntryParams;
      const existing = getMemory(db, p.id);
      if (existing === null || existing.guildId !== guildId) {
        return Promise.resolve({
          content: [{ type: "text", text: `Journal entry ${p.id} not found.` }],
          details: { memoryId: p.id, found: false },
        });
      }
      if (existing.scope !== "journal") {
        return Promise.resolve({
          content: [{ type: "text", text: `ID ${p.id} is not a journal entry. Use recall_user_memories for user memories.` }],
          details: { memoryId: p.id, found: false },
        });
      }
      const lines = [
        `ID: ${existing.id}`,
        `Title: ${existing.title}`,
        `Content: ${existing.content ?? "(none)"}`,
        `Created: ${formatRelativeAgo(existing.createdAt)}`,
        `Updated: ${formatRelativeAgo(existing.updatedAt)}`,
      ];
      return Promise.resolve({
        content: [{ type: "text", text: lines.join("\n") }],
        details: { memoryId: p.id, found: true },
      });
    },
  };

  // -------------------------------------------------------------------------
  // delete_journal_entry
  // -------------------------------------------------------------------------
  const deleteJournalEntry: AgentTool = {
    name: "delete_journal_entry",
    label: "Delete Journal Entry",
    description: "Delete a journal entry by its ID.",
    parameters: DeleteJournalEntrySchema,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ memoryId: number; success: boolean }>> => {
      const p = params as DeleteJournalEntryParams;
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

      // Resolve username to userId
      const userId = resolveUsername(p.username);
      if (userId === undefined) {
        return Promise.resolve({
          content: [{ type: "text", text: `User '${p.username}' not found.` }],
          details: { memoryId: -1, action: "create", success: false },
        });
      }

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
            content: [{ type: "text", text: `ID ${p.id} is not a user memory. Use save_journal_entry to update journal entries.` }],
            details: { memoryId: p.id, action: "update", success: false },
          });
        }
        const updated = updateMemory(db, p.id, {
          title: p.title,
          content: p.content,
          ttlDays: p.ttlDays,
        });
        if (updated) {
          onMemoryChanged?.(p.id, embeddingText(p.title, p.content));
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
        userId,
        title: p.title,
        content: p.content,
        sourceMessageId: p.sourceMessageId,
        ttlDays: p.ttlDays,
      });
      onMemoryChanged?.(id, embeddingText(p.title, p.content));

      return Promise.resolve({
        content: [{ type: "text", text: `Saved new user memory ${id} for @${p.username}.` }],
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
          content: [{ type: "text", text: `ID ${p.id} is not a user memory. Use delete_journal_entry for journal entries.` }],
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
      "Retrieve stored user memories. User memories are NOT in context by default — call this to discover them. Optionally filter by username.",
    parameters: RecallUserMemoriesSchema,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ count: number } | undefined>> => {
      const p = params as RecallUserMemoriesParams;

      // Resolve username to userId if provided
      let userId: string | undefined;
      if (p.username !== undefined) {
        userId = resolveUsername(p.username);
        if (userId === undefined) {
          return Promise.resolve({
            content: [{ type: "text", text: `User '${p.username}' not found.` }],
            details: undefined,
          });
        }
      }

      const rows = listMemories(db, {
        scope: "user",
        guildId,
        userId,
        limit: p.limit ?? 50,
      });

      if (rows.length === 0) {
        const msg = p.username !== undefined
          ? `No user memories found for @${p.username}.`
          : "No user memories found.";
        return Promise.resolve({ content: [{ type: "text", text: msg }], details: undefined });
      }

      const legend = "*[ID] ([Updated]) [Title]: [Content]; use `save_user_memory(id=N, ...)` to update, `delete_user_memory(id)` to remove*";
      const lines = rows.map((r) => {
        const contentPart = r.content !== null && r.content !== "" ? `: ${r.content}` : "";
        return `- ${r.id} ${formatJournalTimestamp(r.updatedAt)} ${r.title}${contentPart}`;
      });
      return Promise.resolve({
        content: [{ type: "text", text: `${legend}\n${lines.join("\n")}` }],
        details: { count: rows.length },
      });
    },
  };

  return [saveJournalEntry, recallJournalEntry, deleteJournalEntry, saveUserMemory, deleteUserMemory, recallUserMemories];
}
