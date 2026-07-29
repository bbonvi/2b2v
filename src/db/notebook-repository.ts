import type { Database } from "./database.ts";

export const DEFAULT_NOTEBOOK_SHELF_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type NotebookState = "active" | "shelved" | "archived" | "trashed";
export type NotebookRecallScope = "anywhere" | "guild";
export type NotebookRecallMode = "always" | "users";
export type NotebookSearchState =
  | "active"
  | "shelved"
  | "archived"
  | "active+shelved+archived"
  | "trashed";

export interface Notebook {
  id: number;
  title: string;
  content: string;
  recallScope: NotebookRecallScope;
  recallGuildId: string | null;
  recallMode: NotebookRecallMode;
  relatedUserIds: string[];
  recallUserIds: string[];
  shelfAfterMs: number;
  shelfAt: number | null;
  revision: number;
  createdAt: number;
  editedAt: number;
  shelvedAt: number | null;
  archivedAt: number | null;
  deletedAt: number | null;
  state: NotebookState;
}

export interface NotebookRevision {
  notebookId: number;
  revision: number;
  operation: string;
  changeText: string | null;
  snapshot: Notebook;
  createdAt: number;
}

export interface CreateNotebookInput {
  title: string;
  content?: string;
  recallScope?: NotebookRecallScope;
  recallGuildId?: string | null;
  recallMode?: NotebookRecallMode;
  relatedUserIds?: readonly string[];
  recallUserIds?: readonly string[];
  shelfAfterMs?: number;
  now?: number;
}

export interface RewriteNotebookInput {
  expectedRevision: number;
  title?: string;
  content?: string;
  recallScope?: NotebookRecallScope;
  recallGuildId?: string | null;
  recallMode?: NotebookRecallMode;
  relatedUserIds?: readonly string[];
  recallUserIds?: readonly string[];
  shelfAfterMs?: number;
  now?: number;
}

export interface NotebookRevisionConflict {
  error: "revision_conflict";
  expectedRevision: number;
  currentRevision: number;
  currentState: NotebookState;
}

export type NotebookMutationFailure =
  | NotebookRevisionConflict
  | { error: "not_found" }
  | { error: "invalid_state"; currentState: NotebookState; message: string }
  | { error: "invalid_revision"; message: string }
  | { error: "invalid_patch"; message: string };

export type NotebookMutationResult =
  | { notebook: Notebook }
  | NotebookMutationFailure;

interface NotebookRow {
  id: number;
  title: string;
  content: string;
  recall_scope: NotebookRecallScope;
  recall_guild_id: string | null;
  recall_mode: NotebookRecallMode;
  shelf_after_ms: number;
  shelf_at: number | null;
  revision: number;
  created_at: number;
  edited_at: number;
  shelved_at: number | null;
  archived_at: number | null;
  deleted_at: number | null;
}

interface NotebookRevisionRow {
  notebook_id: number;
  revision: number;
  operation: string;
  change_text: string | null;
  snapshot: string;
  created_at: number;
}

interface ParsedPatchHunk {
  context: string | null;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
  changed: boolean;
}

function normalizeUserIds(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value !== ""))].sort();
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
}

function normalizeShelfAfterMs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_NOTEBOOK_SHELF_AFTER_MS;
  assertPositiveInteger(resolved, "shelfAfterMs");
  return resolved;
}

function normalizeTitle(value: string): string {
  const title = value.trim();
  if (title === "") throw new Error("Notebook title cannot be empty.");
  return title;
}

function resolvedRecall(input: {
  recallScope?: NotebookRecallScope;
  recallGuildId?: string | null;
  recallMode?: NotebookRecallMode;
  recallUserIds?: readonly string[];
}, current?: Pick<Notebook, "recallScope" | "recallGuildId" | "recallMode" | "recallUserIds">): {
  recallScope: NotebookRecallScope;
  recallGuildId: string | null;
  recallMode: NotebookRecallMode;
  recallUserIds: string[];
} {
  const recallScope = input.recallScope ?? current?.recallScope ?? "anywhere";
  const rawGuildId = input.recallGuildId !== undefined ? input.recallGuildId : current?.recallGuildId;
  const recallGuildId = recallScope === "guild" ? rawGuildId?.trim() ?? "" : null;
  if (recallScope === "guild" && recallGuildId === "") {
    throw new Error("Guild-scoped recall requires recallGuildId.");
  }
  const recallMode = input.recallMode ?? current?.recallMode ?? "always";
  const recallUserIds = normalizeUserIds(input.recallUserIds ?? current?.recallUserIds);
  if (recallMode === "users" && recallUserIds.length === 0) {
    throw new Error("User-triggered recall requires at least one recall user.");
  }
  return {
    recallScope,
    recallGuildId,
    recallMode,
    recallUserIds: recallMode === "users" ? recallUserIds : [],
  };
}

export function notebookState(row: Pick<NotebookRow, "deleted_at" | "archived_at" | "shelved_at">): NotebookState {
  if (row.deleted_at !== null) return "trashed";
  if (row.archived_at !== null) return "archived";
  if (row.shelved_at !== null) return "shelved";
  return "active";
}

function userIds(db: Database, table: "notebook_related_users" | "notebook_recall_users", notebookId: number): string[] {
  const rows = db.raw.prepare(`SELECT user_id FROM ${table} WHERE notebook_id = ? ORDER BY user_id`)
    .all(notebookId) as Array<{ user_id: string }>;
  return rows.map((row) => row.user_id);
}

function fromRow(db: Database, row: NotebookRow): Notebook {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    recallScope: row.recall_scope,
    recallGuildId: row.recall_guild_id,
    recallMode: row.recall_mode,
    relatedUserIds: userIds(db, "notebook_related_users", row.id),
    recallUserIds: userIds(db, "notebook_recall_users", row.id),
    shelfAfterMs: row.shelf_after_ms,
    shelfAt: row.shelf_at,
    revision: row.revision,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    shelvedAt: row.shelved_at,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
    state: notebookState(row),
  };
}

function rawNotebook(db: Database, notebookId: number): Notebook | null {
  const row = db.raw.prepare("SELECT * FROM notebooks WHERE id = ?").get(notebookId) as NotebookRow | null;
  return row === null ? null : fromRow(db, row);
}

function replaceUsers(
  db: Database,
  table: "notebook_related_users" | "notebook_recall_users",
  notebookId: number,
  values: readonly string[],
): void {
  db.raw.prepare(`DELETE FROM ${table} WHERE notebook_id = ?`).run(notebookId);
  const insert = db.raw.prepare(`INSERT INTO ${table} (notebook_id, user_id) VALUES (?, ?)`);
  for (const value of normalizeUserIds(values)) insert.run(notebookId, value);
}

function saveRevision(
  db: Database,
  notebook: Notebook,
  operation: string,
  changeText: string | null,
  now: number,
): void {
  db.raw.prepare(`INSERT INTO notebook_revisions
    (notebook_id, revision, operation, change_text, snapshot, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(notebook.id, notebook.revision, operation, changeText, JSON.stringify(notebook), now);
}

function currentAfterDueShelf(db: Database, notebookId: number, now: number): Notebook | null {
  const current = rawNotebook(db, notebookId);
  if (current === null
    || current.state !== "active"
    || current.shelfAt === null
    || current.shelfAt > now) return current;
  const result = db.raw.prepare(`UPDATE notebooks
    SET shelf_at = NULL, shelved_at = ?, revision = revision + 1
    WHERE id = ? AND revision = ?
      AND deleted_at IS NULL AND archived_at IS NULL AND shelved_at IS NULL
      AND shelf_at IS NOT NULL AND shelf_at <= ?`)
    .run(now, notebookId, current.revision, now);
  if (result.changes !== 1) return rawNotebook(db, notebookId);
  const shelved = rawNotebook(db, notebookId);
  if (shelved === null) throw new Error(`Notebook ${notebookId} disappeared during shelving.`);
  saveRevision(db, shelved, "auto_shelve", null, now);
  return shelved;
}

function conflict(expectedRevision: number, current: Notebook): NotebookRevisionConflict {
  return {
    error: "revision_conflict",
    expectedRevision,
    currentRevision: current.revision,
    currentState: current.state,
  };
}

function stateTimestamps(
  state: Exclude<NotebookState, "trashed">,
  now: number,
  shelfAfterMs: number,
): {
  shelfAt: number | null;
  shelvedAt: number | null;
  archivedAt: number | null;
  deletedAt: null;
} {
  return {
    shelfAt: state === "active" ? now + shelfAfterMs : null,
    shelvedAt: state === "shelved" ? now : null,
    archivedAt: state === "archived" ? now : null,
    deletedAt: null,
  };
}

/** Create one active notebook and its first full revision snapshot. */
export function createNotebook(db: Database, input: CreateNotebookInput): Notebook {
  const now = input.now ?? Date.now();
  const title = normalizeTitle(input.title);
  const shelfAfterMs = normalizeShelfAfterMs(input.shelfAfterMs);
  const relatedUserIds = normalizeUserIds(input.relatedUserIds);
  const recall = resolvedRecall(input);
  let notebookId = 0;
  db.raw.transaction(() => {
    const result = db.raw.prepare(`INSERT INTO notebooks
      (title, content, recall_scope, recall_guild_id, recall_mode, shelf_after_ms,
       shelf_at, revision, created_at, edited_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(
        title,
        input.content ?? "",
        recall.recallScope,
        recall.recallGuildId,
        recall.recallMode,
        shelfAfterMs,
        now + shelfAfterMs,
        now,
        now,
      );
    notebookId = Number(result.lastInsertRowid);
    replaceUsers(db, "notebook_related_users", notebookId, relatedUserIds);
    replaceUsers(db, "notebook_recall_users", notebookId, recall.recallUserIds);
    const created = rawNotebook(db, notebookId);
    if (created === null) throw new Error("Notebook creation did not return a row.");
    saveRevision(db, created, "create", null, now);
  })();
  const created = rawNotebook(db, notebookId);
  if (created === null) throw new Error("Notebook creation failed.");
  return created;
}

/** Shelf every due active notebook with the same revision guard used by actor writes. */
export function shelfDueNotebooks(db: Database, now = Date.now()): number {
  const due = db.raw.prepare(`SELECT id, revision FROM notebooks
    WHERE deleted_at IS NULL AND archived_at IS NULL AND shelved_at IS NULL
      AND shelf_at IS NOT NULL AND shelf_at <= ?
    ORDER BY id`)
    .all(now) as Array<{ id: number; revision: number }>;
  let changed = 0;
  for (const candidate of due) {
    db.raw.transaction(() => {
      const current = rawNotebook(db, candidate.id);
      if (current === null
        || current.revision !== candidate.revision
        || current.state !== "active"
        || current.shelfAt === null
        || current.shelfAt > now) return;
      const shelved = currentAfterDueShelf(db, candidate.id, now);
      if (shelved?.state === "shelved" && shelved.revision === candidate.revision + 1) changed += 1;
    })();
  }
  return changed;
}

/** Get the current notebook after applying any due automatic shelf transition. */
export function getNotebook(db: Database, notebookId: number, now = Date.now()): Notebook | null {
  shelfDueNotebooks(db, now);
  return rawNotebook(db, notebookId);
}

/** Return one stored full revision snapshot. */
export function getNotebookRevision(
  db: Database,
  notebookId: number,
  revision: number,
): NotebookRevision | null {
  const row = db.raw.prepare(
    "SELECT * FROM notebook_revisions WHERE notebook_id = ? AND revision = ?",
  ).get(notebookId, revision) as NotebookRevisionRow | null;
  if (row === null) return null;
  return {
    notebookId: row.notebook_id,
    revision: row.revision,
    operation: row.operation,
    changeText: row.change_text,
    snapshot: JSON.parse(row.snapshot) as Notebook,
    createdAt: row.created_at,
  };
}

/** List immutable notebook revisions from newest to oldest. */
export function listNotebookRevisions(
  db: Database,
  notebookId: number,
  limit = 100,
  now = Date.now(),
): NotebookRevision[] {
  shelfDueNotebooks(db, now);
  const rows = db.raw.prepare(
    "SELECT * FROM notebook_revisions WHERE notebook_id = ? ORDER BY revision DESC LIMIT ?",
  ).all(notebookId, Math.max(1, Math.trunc(limit))) as NotebookRevisionRow[];
  return rows.map((row) => ({
    notebookId: row.notebook_id,
    revision: row.revision,
    operation: row.operation,
    changeText: row.change_text,
    snapshot: JSON.parse(row.snapshot) as Notebook,
    createdAt: row.created_at,
  }));
}

function parsePatch(changeText: string): ParsedPatchHunk[] {
  const lines = changeText.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: ParsedPatchHunk[] = [];
  let current: ParsedPatchHunk | undefined;
  for (const line of lines) {
    const header = line.trimEnd();
    if (header === "@@" || header.startsWith("@@ ")) {
      current = {
        context: header === "@@" ? null : header.slice(3),
        oldLines: [],
        newLines: [],
        endOfFile: false,
        changed: false,
      };
      hunks.push(current);
      continue;
    }
    if (line === "" && current === undefined && hunks.length === 0) continue;
    if (current === undefined) {
      if (!line.startsWith(" ") && !line.startsWith("-") && !line.startsWith("+")) {
        throw new Error("Every patch line must start with '@@', ' ', '-', or '+'.");
      }
      current = {
        context: null,
        oldLines: [],
        newLines: [],
        endOfFile: false,
        changed: false,
      };
      hunks.push(current);
    }
    if (line === "*** End of File") {
      current.endOfFile = true;
      continue;
    }
    if (current.endOfFile) {
      if (line === "") continue;
      throw new Error("Only a new hunk may follow '*** End of File'.");
    }
    if (line.startsWith("-")) {
      current.oldLines.push(line.slice(1));
      current.changed = true;
    } else if (line.startsWith("+")) {
      current.newLines.push(line.slice(1));
      current.changed = true;
    } else if (line.startsWith(" ")) {
      current.oldLines.push(line.slice(1));
      current.newLines.push(line.slice(1));
    } else if (line === "") {
      current.oldLines.push("");
      current.newLines.push("");
    } else {
      throw new Error(`Malformed patch line: ${line}`);
    }
  }
  if (hunks.length === 0) throw new Error("Patch has no hunks.");
  for (const hunk of hunks) {
    if (!hunk.changed) {
      throw new Error(`Patch hunk '${hunk.context ?? "@@"}' has no changes.`);
    }
  }
  return hunks;
}

function findPatchSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean,
): number | null {
  const contentEnd = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  const lastStart = contentEnd - pattern.length;
  if (lastStart < start) return null;
  if (endOfFile) {
    return lines.slice(lastStart, contentEnd).every((line, index) => line === pattern[index])
      ? lastStart
      : null;
  }
  for (let index = start; index <= lastStart; index += 1) {
    if (lines.slice(index, index + pattern.length).every((line, offset) => line === pattern[offset])) {
      return index;
    }
  }
  return null;
}

/** Apply apply_patch-compatible update hunks without changing unrelated physical lines. */
export function applyNotebookPatch(content: string, changeText: string): string {
  const hunks = parsePatch(changeText);
  const lines = content.split("\n");
  const contentEnd = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  const replacements: Array<{ start: number; end: number; lines: string[]; order: number }> = [];
  let cursor = 0;
  for (const [order, hunk] of hunks.entries()) {
    const contextIndex = hunk.context === null
      ? null
      : findPatchSequence(lines, [hunk.context], cursor, false);
    if (hunk.context !== null && contextIndex === null) {
      throw new Error(`Patch context not found: ${hunk.context}`);
    }

    let start: number | null;
    if (hunk.oldLines.length === 0) {
      start = hunk.endOfFile || contextIndex === null ? contentEnd : contextIndex + 1;
    } else {
      start = contextIndex !== null && hunk.oldLines[0] === hunk.context
        ? findPatchSequence(lines, hunk.oldLines, contextIndex, hunk.endOfFile)
        : null;
      start ??= findPatchSequence(
        lines,
        hunk.oldLines,
        contextIndex === null ? cursor : contextIndex + 1,
        hunk.endOfFile,
      );
    }
    if (start === null) {
      throw new Error(`Patch lines not found${hunk.context === null ? "" : ` after context: ${hunk.context}`}`);
    }
    replacements.push({
      start,
      end: start + hunk.oldLines.length,
      lines: hunk.newLines,
      order,
    });
    cursor = start + hunk.oldLines.length;
  }
  const ordered = replacements.sort((a, b) => {
    const positionOrder = b.start - a.start;
    return positionOrder !== 0 ? positionOrder : b.order - a.order;
  });
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous !== undefined && current !== undefined && current.end > previous.start) {
      throw new Error("Patch hunks overlap.");
    }
  }
  for (const replacement of ordered) {
    lines.splice(replacement.start, replacement.end - replacement.start, ...replacement.lines);
  }
  return lines.join("\n");
}

function activeMutation(
  db: Database,
  notebookId: number,
  expectedRevision: number,
  operation: "patch" | "rewrite",
  changeText: string | null,
  update: (current: Notebook) => {
    title: string;
    content: string;
    recallScope: NotebookRecallScope;
    recallGuildId: string | null;
    recallMode: NotebookRecallMode;
    relatedUserIds: string[];
    recallUserIds: string[];
    shelfAfterMs: number;
  },
  now: number,
): NotebookMutationResult {
  assertPositiveInteger(expectedRevision, "expectedRevision");
  let outcome: NotebookMutationResult = { error: "not_found" };
  db.raw.transaction(() => {
    const current = currentAfterDueShelf(db, notebookId, now);
    if (current === null) return;
    if (current.revision !== expectedRevision) {
      outcome = conflict(expectedRevision, current);
      return;
    }
    if (current.state !== "active") {
      outcome = {
        error: "invalid_state",
        currentState: current.state,
        message: `${current.state} notebooks are read-only. Activate the notebook before editing it.`,
      };
      return;
    }
    const next = update(current);
    const result = db.raw.prepare(`UPDATE notebooks SET
      title = ?, content = ?, recall_scope = ?, recall_guild_id = ?, recall_mode = ?,
      shelf_after_ms = ?, shelf_at = ?, edited_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ?
        AND deleted_at IS NULL AND archived_at IS NULL AND shelved_at IS NULL`)
      .run(
        next.title,
        next.content,
        next.recallScope,
        next.recallGuildId,
        next.recallMode,
        next.shelfAfterMs,
        now + next.shelfAfterMs,
        now,
        notebookId,
        expectedRevision,
      );
    if (result.changes !== 1) {
      const latest = rawNotebook(db, notebookId);
      outcome = latest === null ? { error: "not_found" } : conflict(expectedRevision, latest);
      return;
    }
    replaceUsers(db, "notebook_related_users", notebookId, next.relatedUserIds);
    replaceUsers(db, "notebook_recall_users", notebookId, next.recallUserIds);
    const saved = rawNotebook(db, notebookId);
    if (saved === null) throw new Error(`Notebook ${notebookId} disappeared during ${operation}.`);
    saveRevision(db, saved, operation, changeText, now);
    outcome = { notebook: saved };
  })();
  return outcome;
}

/** Apply all contextual hunks in one revision-checked transaction. */
export function patchNotebook(
  db: Database,
  notebookId: number,
  expectedRevision: number,
  changeText: string,
  now = Date.now(),
): NotebookMutationResult {
  let content: string | undefined;
  try {
    return activeMutation(
      db,
      notebookId,
      expectedRevision,
      "patch",
      changeText,
      (current) => {
        content = applyNotebookPatch(current.content, changeText);
        return {
          ...current,
          content,
        };
      },
      now,
    );
  } catch (cause) {
    return {
      error: "invalid_patch",
      message: cause instanceof Error ? cause.message : "Invalid notebook patch.",
    };
  }
}

/** Replace notebook content or metadata while it is active. */
export function rewriteNotebook(
  db: Database,
  notebookId: number,
  input: RewriteNotebookInput,
): NotebookMutationResult {
  const now = input.now ?? Date.now();
  try {
    return activeMutation(
      db,
      notebookId,
      input.expectedRevision,
      "rewrite",
      null,
      (current) => {
        const recall = resolvedRecall(input, current);
        return {
          title: input.title === undefined ? current.title : normalizeTitle(input.title),
          content: input.content ?? current.content,
          recallScope: recall.recallScope,
          recallGuildId: recall.recallGuildId,
          recallMode: recall.recallMode,
          relatedUserIds: input.relatedUserIds === undefined
            ? current.relatedUserIds
            : normalizeUserIds(input.relatedUserIds),
          recallUserIds: recall.recallUserIds,
          shelfAfterMs: input.shelfAfterMs === undefined
            ? current.shelfAfterMs
            : normalizeShelfAfterMs(input.shelfAfterMs),
        };
      },
      now,
    );
  } catch (cause) {
    return {
      error: "invalid_revision",
      message: cause instanceof Error ? cause.message : "Invalid notebook rewrite.",
    };
  }
}

function lifecycleMutation(
  db: Database,
  notebookId: number,
  expectedRevision: number,
  targetState: Exclude<NotebookState, "trashed">,
  operation: string,
  now: number,
  allowTrashed = false,
  requiredCurrentState?: NotebookState,
): NotebookMutationResult {
  assertPositiveInteger(expectedRevision, "expectedRevision");
  let outcome: NotebookMutationResult = { error: "not_found" };
  db.raw.transaction(() => {
    const current = currentAfterDueShelf(db, notebookId, now);
    if (current === null) return;
    if (current.revision !== expectedRevision) {
      outcome = conflict(expectedRevision, current);
      return;
    }
    if (requiredCurrentState !== undefined && current.state !== requiredCurrentState) {
      outcome = {
        error: "invalid_state",
        currentState: current.state,
        message: `${operation} requires a ${requiredCurrentState} notebook.`,
      };
      return;
    }
    if (current.state === "trashed" && !allowTrashed) {
      outcome = {
        error: "invalid_state",
        currentState: current.state,
        message: "Use trash restore with an explicit target state.",
      };
      return;
    }
    if (current.state === targetState) {
      outcome = {
        error: "invalid_state",
        currentState: current.state,
        message: `Notebook is already ${targetState}.`,
      };
      return;
    }
    const timestamps = stateTimestamps(targetState, now, current.shelfAfterMs);
    const result = db.raw.prepare(`UPDATE notebooks
      SET shelf_at = ?, shelved_at = ?, archived_at = ?, deleted_at = ?,
          revision = revision + 1
      WHERE id = ? AND revision = ?`)
      .run(
        timestamps.shelfAt,
        timestamps.shelvedAt,
        timestamps.archivedAt,
        timestamps.deletedAt,
        notebookId,
        expectedRevision,
      );
    if (result.changes !== 1) {
      const latest = rawNotebook(db, notebookId);
      outcome = latest === null ? { error: "not_found" } : conflict(expectedRevision, latest);
      return;
    }
    const saved = rawNotebook(db, notebookId);
    if (saved === null) throw new Error(`Notebook ${notebookId} disappeared during ${operation}.`);
    saveRevision(db, saved, operation, null, now);
    outcome = { notebook: saved };
  })();
  return outcome;
}

/** Move a non-trashed notebook to an explicit active, shelved, or archived state. */
export function setNotebookState(
  db: Database,
  notebookId: number,
  expectedRevision: number,
  targetState: Exclude<NotebookState, "trashed">,
  now = Date.now(),
): NotebookMutationResult {
  return lifecycleMutation(db, notebookId, expectedRevision, targetState, targetState, now);
}

/** Move a notebook to trash without changing its last-edit time. */
export function trashNotebook(
  db: Database,
  notebookId: number,
  expectedRevision: number,
  now = Date.now(),
): NotebookMutationResult {
  assertPositiveInteger(expectedRevision, "expectedRevision");
  let outcome: NotebookMutationResult = { error: "not_found" };
  db.raw.transaction(() => {
    const current = currentAfterDueShelf(db, notebookId, now);
    if (current === null) return;
    if (current.revision !== expectedRevision) {
      outcome = conflict(expectedRevision, current);
      return;
    }
    if (current.state === "trashed") {
      outcome = { error: "invalid_state", currentState: current.state, message: "Notebook is already trashed." };
      return;
    }
    const result = db.raw.prepare(`UPDATE notebooks
      SET shelf_at = NULL, deleted_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ?`)
      .run(now, notebookId, expectedRevision);
    if (result.changes !== 1) {
      const latest = rawNotebook(db, notebookId);
      outcome = latest === null ? { error: "not_found" } : conflict(expectedRevision, latest);
      return;
    }
    const saved = rawNotebook(db, notebookId);
    if (saved === null) throw new Error(`Notebook ${notebookId} disappeared during trash.`);
    saveRevision(db, saved, "trash", null, now);
    outcome = { notebook: saved };
  })();
  return outcome;
}

/** Restore a trashed notebook into an explicit non-trash state. */
export function restoreTrashedNotebook(
  db: Database,
  notebookId: number,
  expectedRevision: number,
  targetState: Exclude<NotebookState, "trashed">,
  now = Date.now(),
): NotebookMutationResult {
  return lifecycleMutation(db, notebookId, expectedRevision, targetState, "restore", now, true, "trashed");
}

/** Restore historical content and metadata as a new full revision. */
export function restoreNotebookRevision(
  db: Database,
  notebookId: number,
  expectedRevision: number,
  sourceRevision: number,
  targetState?: Exclude<NotebookState, "trashed">,
  now = Date.now(),
): NotebookMutationResult {
  assertPositiveInteger(expectedRevision, "expectedRevision");
  assertPositiveInteger(sourceRevision, "sourceRevision");
  let outcome: NotebookMutationResult = { error: "not_found" };
  db.raw.transaction(() => {
    const current = currentAfterDueShelf(db, notebookId, now);
    if (current === null) return;
    if (current.revision !== expectedRevision) {
      outcome = conflict(expectedRevision, current);
      return;
    }
    if ((current.state === "archived" || current.state === "trashed") && targetState === undefined) {
      outcome = {
        error: "invalid_state",
        currentState: current.state,
        message: "Restoring from archive or trash requires an explicit target state.",
      };
      return;
    }
    const revision = getNotebookRevision(db, notebookId, sourceRevision);
    if (revision === null) {
      outcome = { error: "invalid_revision", message: `Notebook revision ${sourceRevision} was not found.` };
      return;
    }
    const restoredState = targetState ?? revision.snapshot.state;
    if (restoredState === "trashed") {
      outcome = {
        error: "invalid_revision",
        message: "A trashed snapshot requires an explicit active, shelved, or archived target state.",
      };
      return;
    }
    const timestamps = stateTimestamps(restoredState, now, revision.snapshot.shelfAfterMs);
    const result = db.raw.prepare(`UPDATE notebooks SET
      title = ?, content = ?, recall_scope = ?, recall_guild_id = ?, recall_mode = ?,
      shelf_after_ms = ?, shelf_at = ?, shelved_at = ?, archived_at = ?, deleted_at = ?,
      edited_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ?`)
      .run(
        revision.snapshot.title,
        revision.snapshot.content,
        revision.snapshot.recallScope,
        revision.snapshot.recallGuildId,
        revision.snapshot.recallMode,
        revision.snapshot.shelfAfterMs,
        timestamps.shelfAt,
        timestamps.shelvedAt,
        timestamps.archivedAt,
        timestamps.deletedAt,
        now,
        notebookId,
        expectedRevision,
      );
    if (result.changes !== 1) {
      const latest = rawNotebook(db, notebookId);
      outcome = latest === null ? { error: "not_found" } : conflict(expectedRevision, latest);
      return;
    }
    replaceUsers(db, "notebook_related_users", notebookId, revision.snapshot.relatedUserIds);
    replaceUsers(db, "notebook_recall_users", notebookId, revision.snapshot.recallUserIds);
    const saved = rawNotebook(db, notebookId);
    if (saved === null) throw new Error(`Notebook ${notebookId} disappeared during revision restore.`);
    saveRevision(db, saved, "restore_revision", null, now);
    outcome = { notebook: saved };
  })();
  return outcome;
}

function stateSql(state: NotebookSearchState): string {
  switch (state) {
    case "active":
      return "deleted_at IS NULL AND archived_at IS NULL AND shelved_at IS NULL";
    case "shelved":
      return "deleted_at IS NULL AND archived_at IS NULL AND shelved_at IS NOT NULL";
    case "archived":
      return "deleted_at IS NULL AND archived_at IS NOT NULL";
    case "trashed":
      return "deleted_at IS NOT NULL";
    case "active+shelved+archived":
      return "deleted_at IS NULL";
  }
}

/** Select notebook search candidates before the caller performs one ripgrep pass. */
export function listNotebookCandidates(db: Database, input: {
  state?: NotebookSearchState;
  notebookId?: number;
  relatedUserIds?: readonly string[];
  now?: number;
} = {}): Notebook[] {
  shelfDueNotebooks(db, input.now ?? Date.now());
  const state = input.state ?? "active+shelved+archived";
  const conditions = [stateSql(state)];
  const params: Array<string | number> = [];
  if (input.notebookId !== undefined) {
    conditions.push("id = ?");
    params.push(input.notebookId);
  }
  const related = normalizeUserIds(input.relatedUserIds);
  if (related.length > 0) {
    conditions.push(`EXISTS (
      SELECT 1 FROM notebook_related_users related
      WHERE related.notebook_id = notebooks.id
        AND related.user_id IN (${related.map(() => "?").join(",")})
    )`);
    params.push(...related);
  }
  const rows = db.raw.prepare(`SELECT * FROM notebooks
    WHERE ${conditions.join(" AND ")}
    ORDER BY id`).all(...params) as NotebookRow[];
  return rows.map((row) => fromRow(db, row));
}

/** List active and shelved titles that can apply to the current guild and visible users. */
export function listApplicableNotebooks(db: Database, input: {
  guildId: string;
  visibleUserIds?: readonly string[];
  now?: number;
}): Notebook[] {
  shelfDueNotebooks(db, input.now ?? Date.now());
  const rows = db.raw.prepare(`SELECT * FROM notebooks
    WHERE deleted_at IS NULL AND archived_at IS NULL
      AND (recall_scope = 'anywhere' OR recall_guild_id = ?)
    ORDER BY id`)
    .all(input.guildId) as NotebookRow[];
  const visible = new Set(input.visibleUserIds ?? []);
  return rows
    .map((row) => fromRow(db, row))
    .filter((notebook) => notebook.recallMode === "always"
      || notebook.recallUserIds.some((userId) => visible.has(userId)));
}

/** Count archived and trashed notebooks in the private store. */
export function countColdNotebooks(db: Database, now = Date.now()): {
  archived: number;
  trashed: number;
} {
  shelfDueNotebooks(db, now);
  const row = db.raw.prepare(`SELECT
    SUM(CASE WHEN deleted_at IS NULL AND archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived,
    SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trashed
    FROM notebooks`).get() as { archived: number | null; trashed: number | null };
  return { archived: row.archived ?? 0, trashed: row.trashed ?? 0 };
}
