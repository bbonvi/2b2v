import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

import type { Database } from "../db/database";
import {
  createMemory,
  deleteMemory,
  getMemory,
  listMemories,
  type MemoryScope,
  type MemoryRow,
  updateMemory,
} from "../db/memory-repository";
import { formatRelativeAgo } from "./history-dates";

export interface MemoryToolsDeps {
  db: Database;
  /** Current guild ID — scoped tools auto-inject this. */
  guildId: string;
  /** Bot's own user ID — used for global journal entries. */
  botUserId: string;
  /** Resolve username to userId. Returns undefined if not found. */
  resolveUsername: (username: string) => string | undefined;
  /** Optional reverse resolver for richer scope labels in tool output. */
  resolveUserId?: (userId: string) => string | undefined;
  /** Called after a memory is created or updated, for embedding. */
  onMemoryChanged?: (memoryId: number, text: string) => void;
  /** Called after a memory is deleted, for Qdrant cleanup. */
  onMemoryDeleted?: (memoryId: number) => void;
}

interface SaveJournalEntryParams {
  content: string;
  username?: string;
  id?: number;
  ttlDays?: number | null;
  sourceMessageId?: string;
}

interface GetJournalEntriesParams {
  username?: string;
}

interface DeleteJournalEntriesParams {
  ids: number[];
  username?: string;
}

interface ResolvedScopedUser {
  username: string;
  userId: string;
}

const SaveJournalEntrySchema = Type.Object({
  content: Type.String({ description: "Journal content to store. Visible in context under '## Journal'." }),
  username: Type.Optional(Type.String({ description: "Optional @username scope for user-specific entries." })),
  id: Type.Optional(Type.Integer({ description: "Existing journal entry ID to update. Omit to create new." })),
  ttlDays: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Days until expiry. Default 180. Pass null for no expiry." })),
  sourceMessageId: Type.Optional(Type.String({ description: "Discord message ID that triggered this journal entry." })),
});

const GetJournalEntriesSchema = Type.Object({
  username: Type.Optional(Type.String({ description: "Optional @username scope to list user-specific entries only." })),
});

const DeleteJournalEntriesSchema = Type.Object({
  ids: Type.Array(Type.Integer({ description: "Journal entry ID to delete." }), {
    minItems: 1,
    description: "One or more journal entry IDs to delete.",
  }),
  username: Type.Optional(Type.String({ description: "Optional @username scope check for user-specific entries." })),
});

/** Strip a single leading @ and trim whitespace from a username-like input. */
export function normalizeUsername(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("@")) return trimmed;
  return trimmed.slice(1).trim();
}

function resolveScopedUser(
  rawUsername: string,
  resolveUsername: (username: string) => string | undefined,
): ResolvedScopedUser | null {
  const trimmed = rawUsername.trim();
  if (trimmed === "") return null;

  const direct = resolveUsername(trimmed);
  if (direct !== undefined) {
    return {
      username: normalizeUsername(trimmed),
      userId: direct,
    };
  }

  if (trimmed.startsWith("@")) {
    const stripped = normalizeUsername(trimmed);
    if (stripped !== "") {
      const fallback = resolveUsername(stripped);
      if (fallback !== undefined) {
        return {
          username: stripped,
          userId: fallback,
        };
      }
    }
  }

  return null;
}

function scopeLabel(
  row: Pick<MemoryRow, "scope" | "userId">,
  resolveUserId?: (userId: string) => string | undefined,
): string {
  if (row.scope === "journal") return "global";
  if (row.userId === null || row.userId === "") return "user:unknown";
  const username = resolveUserId?.(row.userId);
  if (username !== undefined && username !== "") return `@${username}`;
  return `user:${row.userId}`;
}

function targetScopeLabel(
  scope: MemoryScope,
  userId: string,
  username: string | undefined,
): string {
  if (scope === "journal") return "global";
  return username !== undefined && username !== "" ? `@${username}` : `user:${userId}`;
}

/**
 * Create memory agent tools bound to a guild context.
 * Returns 3 tools: save_journal_entry, get_journal_entries, delete_journal_entries.
 */
export function createMemoryTools(deps: MemoryToolsDeps): AgentTool[] {
  const {
    db,
    guildId,
    botUserId,
    resolveUsername,
    resolveUserId,
    onMemoryChanged,
    onMemoryDeleted,
  } = deps;

  const saveJournalEntry: AgentTool = {
    name: "save_journal_entry",
    label: "Save Journal Entry",
    description:
      "Create or update a journal entry. Omit `username` for global entries, or set `username` to scope an entry to a specific user.",
    parameters: SaveJournalEntrySchema,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ memoryId: number; action: "create" | "update"; success: boolean }>> => {
      const p = params as SaveJournalEntryParams;

      const scopedUser = p.username !== undefined
        ? resolveScopedUser(p.username, resolveUsername)
        : null;
      if (p.username !== undefined && scopedUser === null) {
        return Promise.resolve({
          content: [{ type: "text", text: `User '${p.username}' does not exist.` }],
          details: { memoryId: -1, action: "create", success: false },
        });
      }

      const targetScope: MemoryScope = scopedUser !== null ? "user" : "journal";
      const targetUserId = scopedUser?.userId ?? botUserId;
      const targetLabel = targetScopeLabel(targetScope, targetUserId, scopedUser?.username);

      if (p.id !== undefined) {
        const existing = getMemory(db, p.id);
        if (existing === null || existing.guildId !== guildId) {
          return Promise.resolve({
            content: [{ type: "text", text: `Journal entry ${p.id} not found.` }],
            details: { memoryId: p.id, action: "update", success: false },
          });
        }

        if (targetScope === "journal" && existing.scope !== "journal") {
          return Promise.resolve({
            content: [{ type: "text", text: `Journal entry ${p.id} is user-scoped. Provide username to update it.` }],
            details: { memoryId: p.id, action: "update", success: false },
          });
        }
        if (targetScope === "user" && existing.scope !== "user") {
          return Promise.resolve({
            content: [{ type: "text", text: `Journal entry ${p.id} is global. Omit username to update it.` }],
            details: { memoryId: p.id, action: "update", success: false },
          });
        }
        if (targetScope === "user" && existing.userId !== targetUserId) {
          return Promise.resolve({
            content: [{ type: "text", text: `Journal entry ${p.id} belongs to a different user.` }],
            details: { memoryId: p.id, action: "update", success: false },
          });
        }

        const updated = updateMemory(db, p.id, {
          content: p.content,
          ttlDays: p.ttlDays,
        });
        if (updated) {
          onMemoryChanged?.(p.id, p.content);
        }

        return Promise.resolve({
          content: [{
            type: "text",
            text: updated
              ? `Saved (updated) journal entry ${p.id} (${targetLabel}).`
              : `Journal entry ${p.id} not found.`,
          }],
          details: { memoryId: p.id, action: "update", success: updated },
        });
      }

      const id = createMemory(db, {
        scope: targetScope,
        guildId,
        userId: targetUserId,
        content: p.content,
        sourceMessageId: p.sourceMessageId,
        ttlDays: p.ttlDays,
      });
      onMemoryChanged?.(id, p.content);

      return Promise.resolve({
        content: [{ type: "text", text: `Saved new journal entry ${id} (${targetLabel}).` }],
        details: { memoryId: id, action: "create", success: true },
      });
    },
  };

  const getJournalEntries: AgentTool = {
    name: "get_journal_entries",
    label: "Get Journal Entries",
    description: "List journal entries. Omit `username` for global+user entries, or set `username` for one user's scoped entries.",
    parameters: GetJournalEntriesSchema,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ count: number; scope: string; ids: number[]; found: boolean }>> => {
      const p = params as GetJournalEntriesParams;
      const scopedUser = p.username !== undefined
        ? resolveScopedUser(p.username, resolveUsername)
        : null;

      if (p.username !== undefined && scopedUser === null) {
        return Promise.resolve({
          content: [{ type: "text", text: `User '${p.username}' does not exist.` }],
          details: {
            count: 0,
            scope: normalizeUsername(p.username),
            ids: [],
            found: false,
          },
        });
      }

      const scope = scopedUser !== null ? `@${scopedUser.username}` : "all";
      const rows = scopedUser !== null
        ? listMemories(db, { scope: "user", guildId, userId: scopedUser.userId })
        : [
          ...listMemories(db, { scope: "journal", guildId }),
          ...listMemories(db, { scope: "user", guildId }),
        ];
      const orderedRows = rows
        .slice()
        .sort((a, b) => {
          const updatedDiff = a.updatedAt - b.updatedAt;
          return updatedDiff !== 0 ? updatedDiff : a.id - b.id;
        });

      if (orderedRows.length === 0) {
        return Promise.resolve({
          content: [{ type: "text", text: scopedUser !== null ? `No journal entries found for @${scopedUser.username}.` : "No journal entries found." }],
          details: {
            count: 0,
            scope,
            ids: [],
            found: false,
          },
        });
      }

      const entryBlocks = orderedRows.map((row) => {
        const label = scopeLabel(row, resolveUserId);
        return [
          `ID: ${row.id}`,
          `Scope: ${label}`,
          `Content: ${row.content}`,
          `Created: ${formatRelativeAgo(row.createdAt)}`,
          `Updated: ${formatRelativeAgo(row.updatedAt)}`,
        ].join("\n");
      });

      return Promise.resolve({
        content: [{ type: "text", text: entryBlocks.join("\n\n") }],
        details: {
          count: orderedRows.length,
          scope,
          ids: orderedRows.map((row) => row.id),
          found: true,
        },
      });
    },
  };

  const deleteJournalEntries: AgentTool = {
    name: "delete_journal_entries",
    label: "Delete Journal Entries",
    description: "Delete one or more journal entries by ID. Optional `username` enforces user-scoped match.",
    parameters: DeleteJournalEntriesSchema,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ results: Array<{ id: number; deleted: boolean; error?: string }> }>> => {
      const p = params as DeleteJournalEntriesParams;
      const scopedUser = p.username !== undefined
        ? resolveScopedUser(p.username, resolveUsername)
        : null;
      if (p.username !== undefined && scopedUser === null) {
        return Promise.resolve({
          content: [{ type: "text", text: `User '${p.username}' does not exist.` }],
          details: { results: p.ids.map((id) => ({ id, deleted: false, error: "user does not exist" })) },
        });
      }

      const results: Array<{ id: number; deleted: boolean; error?: string; label?: string }> = [];

      for (const id of p.ids) {
        const existing = getMemory(db, id);
        if (existing === null || existing.guildId !== guildId) {
          results.push({ id, deleted: false, error: "not found" });
          continue;
        }

        if (scopedUser !== null) {
          if (existing.scope !== "user") {
            results.push({ id, deleted: false, error: "entry is global; omit username to delete global entries" });
            continue;
          }
          if (existing.userId !== scopedUser.userId) {
            results.push({ id, deleted: false, error: "entry belongs to a different user" });
            continue;
          }
        }

        const label = scopeLabel(existing, resolveUserId);
        const deleted = deleteMemory(db, id);
        if (deleted) {
          onMemoryDeleted?.(id);
        }
        results.push({ id, deleted, label });
      }

      const succeeded = results.filter((entry) => entry.deleted).length;
      const failed = results.filter((entry) => !entry.deleted);

      let text: string;
      if (p.ids.length === 1 && results[0] !== undefined) {
        const row = results[0];
        text = row.deleted
          ? `Deleted journal entry ${row.id}${row.label !== undefined ? ` (${row.label})` : ""}.`
          : `Journal entry ${row.id}: ${row.error ?? "not found"}.`;
      } else {
        text = `Deleted ${succeeded} of ${p.ids.length} journal entries.`;
        if (failed.length > 0) {
          text += " Failed: " + failed.map((entry) => `${entry.id} (${entry.error})`).join(", ") + ".";
        }
      }

      return Promise.resolve({
        content: [{ type: "text", text }],
        details: { results: results.map(({ id, deleted, error }) => ({ id, deleted, error })) },
      });
    },
  };

  return [saveJournalEntry, getJournalEntries, deleteJournalEntries];
}
