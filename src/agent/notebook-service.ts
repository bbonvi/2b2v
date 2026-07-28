import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database.ts";
import {
  countColdNotebooks,
  createNotebook,
  getNotebook,
  getNotebookRevision,
  listApplicableNotebooks,
  listNotebookCandidates,
  listNotebookRevisions,
  patchNotebook,
  restoreNotebookRevision,
  restoreTrashedNotebook,
  rewriteNotebook,
  setNotebookState,
  trashNotebook,
  type Notebook,
  type NotebookMutationFailure,
  type NotebookMutationResult,
  type NotebookSearchState,
  type NotebookState,
} from "../db/notebook-repository.ts";
import { formatMemoryAge } from "./memory-service.ts";
import { runRipgrep } from "./ripgrep.ts";
import { renderPhysicalTextRange } from "./text-view.ts";
import { markReadOnlyTool } from "./tool-effects.ts";
import {
  RelativeDurationSchema,
  relativeDurationToMilliseconds,
  type RelativeDuration,
} from "../time/relative-duration.ts";

const NOTEBOOK_READ_MAX_CHARS = 30_000;
const NOTEBOOK_READ_DEFAULT_LINES = 200;
const NOTEBOOK_SEARCH_DEFAULT_LIMIT = 20;

type NotebookToolResult = AgentToolResult<Record<string, unknown>>;

export interface NotebookToolDeps {
  db: Database;
  currentGuildId: string;
  defaultShelfAfterMs: number;
}

function exactTime(value: number): string {
  return `${new Date(value).toISOString()} (${value})`;
}

function notebookMetadata(notebook: Notebook): string[] {
  return [
    `Notebook: ${notebook.id} | ${notebook.title}`,
    `Current revision: ${notebook.revision}`,
    `Created: ${exactTime(notebook.createdAt)}`,
    `Last edit: ${exactTime(notebook.editedAt)}`,
    `State: ${notebook.state}`,
    ...(notebook.state === "active" && notebook.shelfAt !== null
      ? [`Auto-shelf: ${exactTime(notebook.shelfAt)}`]
      : []),
    `Related users: ${notebook.relatedUserIds.length === 0 ? "none" : notebook.relatedUserIds.join(", ")}`,
    `Recall scope: ${notebook.recallScope === "anywhere" ? "anywhere" : `guild:${notebook.recallGuildId ?? ""}`}`,
    `Recall mode: ${notebook.recallMode === "always" ? "always" : `users:${notebook.recallUserIds.join(",")}`}`,
  ];
}

function toolError(text: string, details: Record<string, unknown> = {}): NotebookToolResult {
  return { content: [{ type: "text", text }], details: { error: true, ...details } };
}

function mutationResult(result: NotebookMutationResult): NotebookToolResult {
  if ("notebook" in result) {
    return {
      content: [{ type: "text", text: notebookMetadata(result.notebook).join("\n") }],
      details: { notebookId: result.notebook.id, revision: result.notebook.revision, state: result.notebook.state },
    };
  }
  return toolError(JSON.stringify(result), { ...result });
}

function normalizeState(value: unknown): Exclude<NotebookState, "trashed"> | undefined {
  return value === "active" || value === "shelved" || value === "archived" ? value : undefined;
}

const FindNotebooksParams = Type.Object({
  pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  related_user_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
  state: Type.Optional(Type.Union([
    Type.Literal("active"),
    Type.Literal("shelved"),
    Type.Literal("archived"),
    Type.Literal("active+shelved+archived"),
    Type.Literal("trashed"),
  ])),
  after_id: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

interface NotebookSearchMatch {
  notebookId: number;
  lineNumber: number | null;
  text: string;
}

async function regexNotebookMatches(
  notebooks: readonly Notebook[],
  pattern: string,
  signal: AbortSignal,
): Promise<Map<number, NotebookSearchMatch[]>> {
  const rowMatches: NotebookSearchMatch[] = [];
  const rows: string[] = [];
  for (const notebook of notebooks) {
    rows.push(notebook.title);
    rowMatches.push({ notebookId: notebook.id, lineNumber: null, text: notebook.title });
    for (const [index, line] of notebook.content.split("\n").entries()) {
      rows.push(line);
      rowMatches.push({ notebookId: notebook.id, lineNumber: index + 1, text: line });
    }
  }
  const stdout = await runRipgrep([
    "--json",
    "--text",
    "--color=never",
    "--regexp",
    pattern,
  ], rows.join("\n"), signal);
  const result = new Map<number, NotebookSearchMatch[]>();
  if (stdout === null) return result;
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const event = JSON.parse(line) as { type?: unknown; data?: { line_number?: unknown } };
    if (event.type !== "match" || typeof event.data?.line_number !== "number") continue;
    const match = rowMatches[event.data.line_number - 1];
    if (match === undefined) continue;
    const existing = result.get(match.notebookId);
    if (existing === undefined) result.set(match.notebookId, [match]);
    else existing.push(match);
  }
  return result;
}

function previewSearchLine(text: string): string {
  return text.length <= 4_000 ? text : `${text.slice(0, 4_000)}…`;
}

/** Create read and write notebook tools. Write tools remain skill-gated by the manifest. */
export function createNotebookTools(deps: NotebookToolDeps): AgentTool[] {
  const findNotebooks = markReadOnlyTool({
    name: "find_notebooks",
    label: "find_notebooks",
    description: "",
    parameters: FindNotebooksParams,
    async execute(_toolCallId: string, params: unknown, signal): Promise<NotebookToolResult> {
      const input = params as {
        pattern?: string;
        related_user_ids?: string[];
        state?: NotebookSearchState;
        after_id?: number;
        limit?: number;
      };
      let notebooks = listNotebookCandidates(deps.db, {
        state: input.state,
        relatedUserIds: input.related_user_ids,
      });
      let matches = new Map<number, NotebookSearchMatch[]>();
      if (input.pattern !== undefined) {
        try {
          matches = await regexNotebookMatches(
            notebooks,
            input.pattern,
            signal ?? AbortSignal.timeout(30_000),
          );
          notebooks = notebooks.filter((notebook) => matches.has(notebook.id));
        } catch (cause) {
          return toolError(cause instanceof Error ? cause.message : "Notebook regex search failed.");
        }
      }
      const total = notebooks.length;
      const afterId = input.after_id;
      if (afterId !== undefined) notebooks = notebooks.filter((notebook) => notebook.id > afterId);
      const limit = Math.max(1, Math.min(input.limit ?? NOTEBOOK_SEARCH_DEFAULT_LIMIT, 50));
      const page = notebooks.slice(0, limit + 1);
      const hasMore = page.length > limit;
      const shown = hasMore ? page.slice(0, limit) : page;
      if (shown.length === 0) {
        return {
          content: [{ type: "text", text: input.after_id === undefined
            ? "No notebooks found matching those filters."
            : "No more notebooks found matching those filters." }],
          details: { count: 0, total, hasMore: false, state: input.state ?? "active+shelved+archived" },
        };
      }
      const nextAfterId = hasMore ? shown.at(-1)?.id : undefined;
      return {
        content: [{
          type: "text",
          text: [
            ...shown.map((notebook) => [
              ...notebookMetadata(notebook),
              ...(input.pattern === undefined
                ? []
                : [
                    "Matches:",
                    ...(matches.get(notebook.id) ?? []).slice(0, 3).map((match) =>
                      match.lineNumber === null
                        ? `title | ${previewSearchLine(match.text)}`
                        : `${match.lineNumber} | ${previewSearchLine(match.text)}`),
                  ]),
            ].join("\n")),
            ...(nextAfterId === undefined
              ? []
              : [`More notebooks are available.\nnext_after_id=${nextAfterId}`]),
          ].join("\n\n"),
        }],
        details: {
          count: shown.length,
          total,
          hasMore,
          ...(nextAfterId !== undefined ? { nextAfterId } : {}),
          state: input.state ?? "active+shelved+archived",
        },
      };
    },
  });

  const searchNotebook = markReadOnlyTool({
    name: "search_notebook",
    label: "search_notebook",
    description: "",
    parameters: Type.Object({
      notebook_id: Type.Integer({ minimum: 1 }),
      pattern: Type.String({ minLength: 1, maxLength: 1000 }),
      start_line: Type.Optional(Type.Integer({ minimum: 1 })),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      context_lines: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
    }),
    async execute(_toolCallId: string, params: unknown, signal): Promise<NotebookToolResult> {
      const input = params as {
        notebook_id: number;
        pattern: string;
        start_line?: number;
        max_results?: number;
        context_lines?: number;
      };
      const notebook = getNotebook(deps.db, input.notebook_id);
      if (notebook === null) return toolError(`Notebook ${input.notebook_id} was not found.`);
      const lines = notebook.content.split("\n");
      const startLine = input.start_line ?? 1;
      if (startLine > lines.length) {
        return toolError(`start_line ${startLine} exceeds the ${lines.length} available lines.`);
      }
      let stdout: string | null;
      try {
        stdout = await runRipgrep([
          "--json",
          "--text",
          "--color=never",
          "--regexp",
          input.pattern,
        ], lines.slice(startLine - 1).join("\n"), signal ?? AbortSignal.timeout(30_000));
      } catch (cause) {
        return toolError(cause instanceof Error ? cause.message : "Notebook regex search failed.");
      }
      const lineNumbers: number[] = [];
      if (stdout !== null) {
        for (const line of stdout.split("\n")) {
          if (line === "") continue;
          const event = JSON.parse(line) as { type?: unknown; data?: { line_number?: unknown } };
          if (event.type !== "match" || typeof event.data?.line_number !== "number") continue;
          lineNumbers.push(startLine + event.data.line_number - 1);
        }
      }
      const maxResults = input.max_results ?? 10;
      const contextLines = input.context_lines ?? 2;
      const page = lineNumbers.slice(0, maxResults + 1);
      const hasMore = page.length > maxResults;
      const shown = hasMore ? page.slice(0, maxResults) : page;
      if (shown.length === 0) {
        return {
          content: [{
            type: "text",
            text: `${notebookMetadata(notebook).join("\n")}\nRegex: ${JSON.stringify(input.pattern)}\nNo matches from line ${startLine}.`,
          }],
          details: { notebookId: notebook.id, matched: false, hasMore: false, startLine },
        };
      }
      const nextStartLine = hasMore ? (shown.at(-1) ?? startLine) + 1 : undefined;
      const blocks = shown.map((lineNumber) => {
        const first = Math.max(startLine, lineNumber - contextLines);
        const last = Math.min(lines.length, lineNumber + contextLines);
        const block: string[] = [];
        for (let current = first; current <= last; current += 1) {
          block.push(`${current === lineNumber ? ">" : " "} ${current} | ${previewSearchLine(lines[current - 1] ?? "")}`);
        }
        return block.join("\n");
      });
      return {
        content: [{
          type: "text",
          text: [
            ...notebookMetadata(notebook),
            `Regex: ${JSON.stringify(input.pattern)}`,
            `Matches from line ${startLine}:`,
            blocks.join("\n--\n"),
            ...(nextStartLine === undefined
              ? []
              : [`More matches are available.\nnext_start_line=${nextStartLine}`]),
          ].join("\n"),
        }],
        details: {
          notebookId: notebook.id,
          matched: true,
          count: shown.length,
          hasMore,
          startLine,
          ...(nextStartLine !== undefined ? { nextStartLine } : {}),
        },
      };
    },
  });

  const readNotebook = markReadOnlyTool({
    name: "read_notebook",
    label: "read_notebook",
    description: "",
    parameters: Type.Object({
      notebook_id: Type.Integer({ minimum: 1 }),
      revision: Type.Optional(Type.Integer({ minimum: 1 })),
      view: Type.Optional(Type.Union([Type.Literal("content"), Type.Literal("change")])),
      start_line: Type.Optional(Type.Integer({ minimum: 1 })),
      line_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    }),
    execute(_toolCallId: string, params: unknown): Promise<NotebookToolResult> {
      const input = params as {
        notebook_id: number;
        revision?: number;
        view?: "content" | "change";
        start_line?: number;
        line_count?: number;
      };
      const current = getNotebook(deps.db, input.notebook_id);
      if (current === null) return Promise.resolve(toolError(`Notebook ${input.notebook_id} was not found.`));
      const requestedRevision = input.revision ?? current.revision;
      const revision = getNotebookRevision(deps.db, input.notebook_id, requestedRevision);
      if (revision === null) {
        return Promise.resolve(toolError(`Notebook revision ${requestedRevision} was not found.`));
      }
      const view = input.view ?? "content";
      const source = view === "content"
        ? revision.snapshot.content
        : revision.operation === "patch" && revision.changeText !== null
          ? revision.changeText
          : revision.operation;
      try {
        const range = renderPhysicalTextRange(
          source,
          input.start_line ?? 1,
          input.line_count ?? NOTEBOOK_READ_DEFAULT_LINES,
          NOTEBOOK_READ_MAX_CHARS,
        );
        return Promise.resolve({
          content: [{
            type: "text",
            text: [
              ...notebookMetadata(current),
              `Viewing revision: ${requestedRevision}`,
              `View: ${view}`,
              `Lines: ${range.startLine}-${range.endLine} of ${range.totalLines}${range.hasMore ? " (more available)" : ""}`,
              "",
              range.text,
            ].join("\n"),
          }],
          details: {
            notebookId: current.id,
            currentRevision: current.revision,
            viewedRevision: requestedRevision,
            state: current.state,
            startLine: range.startLine,
            endLine: range.endLine,
            totalLines: range.totalLines,
            hasMore: range.hasMore,
          },
        });
      } catch (cause) {
        return Promise.resolve(toolError(cause instanceof Error ? cause.message : "Notebook read failed."));
      }
    },
  });

  const listRevisions = markReadOnlyTool({
    name: "list_notebook_revisions",
    label: "list_notebook_revisions",
    description: "",
    parameters: Type.Object({
      notebook_id: Type.Integer({ minimum: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    execute(_toolCallId: string, params: unknown): Promise<NotebookToolResult> {
      const input = params as { notebook_id: number; limit?: number };
      const current = getNotebook(deps.db, input.notebook_id);
      if (current === null) return Promise.resolve(toolError(`Notebook ${input.notebook_id} was not found.`));
      const revisions = listNotebookRevisions(deps.db, input.notebook_id, input.limit ?? 100);
      return Promise.resolve({
        content: [{
          type: "text",
          text: [
            ...notebookMetadata(current),
            "",
            ...revisions.map((revision) =>
              `r${revision.revision} | ${revision.operation} | ${exactTime(revision.createdAt)}`),
          ].join("\n"),
        }],
        details: { notebookId: current.id, currentRevision: current.revision, count: revisions.length },
      });
    },
  });

  const patch = {
    name: "patch_notebook",
    label: "patch_notebook",
    description: "",
    parameters: Type.Object({
      notebook_id: Type.Integer({ minimum: 1 }),
      expected_revision: Type.Integer({ minimum: 1 }),
      patch: Type.String({ minLength: 1 }),
    }),
    execute(_toolCallId: string, params: unknown): Promise<NotebookToolResult> {
      const input = params as { notebook_id: number; expected_revision: number; patch: string };
      return Promise.resolve(mutationResult(
        patchNotebook(deps.db, input.notebook_id, input.expected_revision, input.patch),
      ));
    },
  } satisfies AgentTool;

  const manage = {
    name: "manage_notebook",
    label: "manage_notebook",
    description: "",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("rewrite"),
        Type.Literal("state"),
        Type.Literal("trash"),
        Type.Literal("restore"),
        Type.Literal("restore_revision"),
      ]),
      notebook_id: Type.Optional(Type.Integer({ minimum: 1 })),
      expected_revision: Type.Optional(Type.Integer({ minimum: 1 })),
      title: Type.Optional(Type.String({ minLength: 1 })),
      content: Type.Optional(Type.String()),
      recall_scope: Type.Optional(Type.Union([Type.Literal("anywhere"), Type.Literal("guild")])),
      recall_guild_id: Type.Optional(Type.String({ minLength: 1 })),
      recall_mode: Type.Optional(Type.Union([Type.Literal("always"), Type.Literal("users")])),
      related_user_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 })),
      recall_user_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 })),
      shelf_after: Type.Optional(RelativeDurationSchema),
      target_state: Type.Optional(Type.Union([
        Type.Literal("active"),
        Type.Literal("shelved"),
        Type.Literal("archived"),
      ])),
      source_revision: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute(_toolCallId: string, params: unknown): Promise<NotebookToolResult> {
      const input = params as {
        action: "create" | "rewrite" | "state" | "trash" | "restore" | "restore_revision";
        notebook_id?: number;
        expected_revision?: number;
        title?: string;
        content?: string;
        recall_scope?: "anywhere" | "guild";
        recall_guild_id?: string;
        recall_mode?: "always" | "users";
        related_user_ids?: string[];
        recall_user_ids?: string[];
        shelf_after?: RelativeDuration;
        target_state?: "active" | "shelved" | "archived";
        source_revision?: number;
      };
      try {
        if (input.action === "create") {
          if (input.title === undefined) return Promise.resolve(toolError("create requires title."));
          const notebook = createNotebook(deps.db, {
            title: input.title,
            content: input.content,
            recallScope: input.recall_scope,
            recallGuildId: input.recall_scope === "guild"
              ? input.recall_guild_id ?? deps.currentGuildId
              : input.recall_guild_id,
            recallMode: input.recall_mode,
            relatedUserIds: input.related_user_ids,
            recallUserIds: input.recall_user_ids,
            shelfAfterMs: input.shelf_after === undefined
              ? deps.defaultShelfAfterMs
              : relativeDurationToMilliseconds(input.shelf_after),
          });
          return Promise.resolve(mutationResult({ notebook }));
        }
        if (input.notebook_id === undefined || input.expected_revision === undefined) {
          return Promise.resolve(toolError(`${input.action} requires notebook_id and expected_revision.`));
        }
        if (input.action === "rewrite") {
          return Promise.resolve(mutationResult(rewriteNotebook(deps.db, input.notebook_id, {
            expectedRevision: input.expected_revision,
            title: input.title,
            content: input.content,
            recallScope: input.recall_scope,
            recallGuildId: input.recall_guild_id,
            recallMode: input.recall_mode,
            relatedUserIds: input.related_user_ids,
            recallUserIds: input.recall_user_ids,
            shelfAfterMs: input.shelf_after === undefined
              ? undefined
              : relativeDurationToMilliseconds(input.shelf_after),
          })));
        }
        if (input.action === "trash") {
          return Promise.resolve(mutationResult(
            trashNotebook(deps.db, input.notebook_id, input.expected_revision),
          ));
        }
        const targetState = normalizeState(input.target_state);
        if (input.action === "state") {
          if (targetState === undefined) return Promise.resolve(toolError("state requires target_state."));
          return Promise.resolve(mutationResult(
            setNotebookState(deps.db, input.notebook_id, input.expected_revision, targetState),
          ));
        }
        if (input.action === "restore") {
          if (targetState === undefined) return Promise.resolve(toolError("restore requires target_state."));
          return Promise.resolve(mutationResult(
            restoreTrashedNotebook(deps.db, input.notebook_id, input.expected_revision, targetState),
          ));
        }
        if (input.source_revision === undefined) {
          return Promise.resolve(toolError("restore_revision requires source_revision."));
        }
        return Promise.resolve(mutationResult(restoreNotebookRevision(
          deps.db,
          input.notebook_id,
          input.expected_revision,
          input.source_revision,
          targetState,
        )));
      } catch (cause) {
        return Promise.resolve(toolError(cause instanceof Error ? cause.message : "Notebook action failed."));
      }
    },
  } satisfies AgentTool;

  return [findNotebooks, searchNotebook, readNotebook, listRevisions, patch, manage];
}

/** Format approximate counts for bounded prompt indexes. */
export function formatNaturalCount(count: number): string {
  if (count <= 0) return "";
  if (count === 1) return "1";
  if (count <= 4) return "a few";
  if (count <= 7) return "about 5";
  if (count <= 19) return "about 10";
  if (count <= 49) return "about 30";
  if (count <= 99) return "about 50";
  return "over 100";
}

function calendarWeekStart(timestamp: number): number {
  const date = new Date(timestamp);
  const day = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day);
}

function overflowLine(count: number): string | undefined {
  const natural = formatNaturalCount(count);
  return natural === "" ? undefined : `And ${natural} more.`;
}

function coldStoreLine(archived: number, trashed: number): string | undefined {
  const parts: string[] = [];
  const archivedCount = formatNaturalCount(archived);
  const trashedCount = formatNaturalCount(trashed);
  if (archivedCount !== "") parts.push(`${archivedCount} archived`);
  if (trashedCount !== "") parts.push(`${trashedCount} trashed`);
  if (parts.length === 0) return undefined;
  const subject = archived + trashed === 1 ? "notebook is" : "notebooks are";
  const joined = parts.length === 2 ? `${parts[0]} and ${parts[1]}` : parts[0] ?? "";
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)} ${subject} stored separately.`;
}

/** Build the bounded title-only notebook prompt section. */
export function buildNotebooksContext(input: {
  db: Database;
  guildId: string;
  visibleUserIds?: readonly string[];
  maxTitles: number;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  const applicable = listApplicableNotebooks(input.db, {
    guildId: input.guildId,
    visibleUserIds: input.visibleUserIds,
    now,
  });
  const ranked = [...applicable].sort((a, b) => {
    if (a.state !== b.state) return a.state === "active" ? -1 : 1;
    const week = calendarWeekStart(b.editedAt) - calendarWeekStart(a.editedAt);
    return week !== 0 ? week : a.id - b.id;
  });
  const selectedIds = new Set(ranked.slice(0, Math.max(0, input.maxTitles)).map((notebook) => notebook.id));
  const active = applicable.filter((notebook) => notebook.state === "active");
  const shelved = applicable.filter((notebook) => notebook.state === "shelved");
  const selected = (rows: Notebook[]): Notebook[] => rows
    .filter((notebook) => selectedIds.has(notebook.id))
    .sort((a, b) => {
      const created = a.createdAt - b.createdAt;
      return created !== 0 ? created : a.id - b.id;
    });
  const selectedActive = selected(active);
  const selectedShelved = selected(shelved);
  const cold = countColdNotebooks(input.db, now);
  if (active.length === 0 && shelved.length === 0 && cold.archived === 0 && cold.trashed === 0) return "";

  const lines = ["## Notebooks"];
  if (selectedShelved.length > 0) {
    lines.push("", "A shelved row's `[age]` is the rough time since its last edit.");
  }
  if (shelved.length > 0) {
    lines.push("", "### Shelved", "");
    lines.push(...selectedShelved.map((notebook) =>
      `${notebook.id} [${formatMemoryAge(notebook.editedAt, now)}] | ${notebook.title}`));
    const overflow = overflowLine(shelved.length - selectedShelved.length);
    if (overflow !== undefined) lines.push(...(selectedShelved.length > 0 ? [""] : []), overflow);
  }
  if (active.length > 0) {
    lines.push("", "### Active", "");
    lines.push(...selectedActive.map((notebook) => `${notebook.id} | ${notebook.title}`));
    const overflow = overflowLine(active.length - selectedActive.length);
    if (overflow !== undefined) lines.push(...(selectedActive.length > 0 ? [""] : []), overflow);
  }
  const coldLine = coldStoreLine(cold.archived, cold.trashed);
  if (coldLine !== undefined) lines.push("", coldLine);
  return lines.join("\n");
}

export function isNotebookMutationFailure(value: NotebookMutationResult): value is NotebookMutationFailure {
  return !("notebook" in value);
}
