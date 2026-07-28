/// <reference lib="dom" />

import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Notebook, NotebookState } from "../db/notebook-repository";
import type { RelativeDuration, RelativeDurationUnit } from "../time/relative-duration";

interface NotebookResponse {
  notebook: Notebook;
}

interface NotebookListResponse {
  notebooks: Notebook[];
  defaultShelfAfterMs: number;
}

interface NotebookDraft {
  title: string;
  content: string;
  shelfAfter: RelativeDuration;
}

const DURATION_UNITS: readonly RelativeDurationUnit[] = ["minutes", "hours", "days", "weeks", "months"];
const EMPTY_DRAFT: NotebookDraft = {
  title: "",
  content: "",
  shelfAfter: { amount: 7, unit: "days" },
};

function formatDate(value: number): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function durationFromMilliseconds(milliseconds: number): RelativeDuration {
  const minuteMs = 60 * 1000;
  const dayMs = 24 * 60 * minuteMs;
  if (milliseconds >= dayMs) return { amount: Number((milliseconds / dayMs).toFixed(2)), unit: "days" };
  if (milliseconds >= 60 * minuteMs) return { amount: Number((milliseconds / (60 * minuteMs)).toFixed(2)), unit: "hours" };
  return { amount: Number((milliseconds / minuteMs).toFixed(2)), unit: "minutes" };
}

function draftFromNotebook(notebook: Notebook): NotebookDraft {
  return {
    title: notebook.title,
    content: notebook.content,
    shelfAfter: durationFromMilliseconds(notebook.shelfAfterMs),
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (response.status === 401) {
    location.href = "/login";
    throw new Error("Dashboard session expired.");
  }
  const data = await response.json() as unknown;
  if (!response.ok) {
    const message = data !== null && typeof data === "object" && "error" in data
      ? String((data as { error?: unknown }).error)
      : "Notebook request failed.";
    throw new Error(message);
  }
  return data as T;
}

function NotebooksTab(): JSX.Element {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<NotebookDraft>(EMPTY_DRAFT);
  const [stateFilter, setStateFilter] = useState<NotebookState | "all">("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [defaultShelfAfter, setDefaultShelfAfter] = useState<RelativeDuration>(EMPTY_DRAFT.shelfAfter);

  const selected = notebooks.find((notebook) => notebook.id === selectedId);
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return notebooks.filter((notebook) =>
      (stateFilter === "all" || notebook.state === stateFilter)
      && (needle === "" || notebook.title.toLocaleLowerCase().includes(needle) || notebook.content.toLocaleLowerCase().includes(needle)));
  }, [notebooks, query, stateFilter]);

  useEffect(() => {
    void api<NotebookListResponse>("/api/management/notebooks")
      .then((result) => {
        const defaultDuration = durationFromMilliseconds(result.defaultShelfAfterMs);
        setDefaultShelfAfter(defaultDuration);
        setNotebooks(result.notebooks);
        const first = result.notebooks[0];
        if (first !== undefined) {
          setSelectedId(first.id);
        } else {
          setDraft({ ...EMPTY_DRAFT, shelfAfter: defaultDuration });
        }
      })
      .catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : String(cause)); });
  }, []);

  useEffect(() => {
    if (selected !== undefined) setDraft(draftFromNotebook(selected));
  }, [selected?.id, selected?.revision]);

  const updateNotebook = (notebook: Notebook): void => {
    setNotebooks((current) => [...current.filter((row) => row.id !== notebook.id), notebook]
      .sort((a, b) => {
        const editOrder = b.editedAt - a.editedAt;
        return editOrder !== 0 ? editOrder : b.id - a.id;
      }));
    setSelectedId(notebook.id);
  };

  const run = async (action: () => Promise<NotebookResponse>): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      updateNotebook((await action()).notebook);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = (): void => {
    if (draft.title.trim() === "") {
      setError("Title is required.");
      return;
    }
    const body = {
      title: draft.title,
      content: draft.content,
      shelfAfter: draft.shelfAfter,
      ...(selected === undefined ? {} : { expectedRevision: selected.revision }),
    };
    void run(() => api<NotebookResponse>(
      selected === undefined ? "/api/management/notebooks" : `/api/management/notebooks/${selected.id}`,
      {
        method: selected === undefined ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ));
  };

  const changeState = (targetState: Exclude<NotebookState, "trashed">): void => {
    if (selected === undefined) return;
    void run(() => api<NotebookResponse>(`/api/management/notebooks/${selected.id}/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: selected.revision, targetState }),
    }));
  };

  const moveToTrash = (): void => {
    if (selected === undefined || !window.confirm(`Move "${selected.title}" to trash?`)) return;
    void run(() => api<NotebookResponse>(`/api/management/notebooks/${selected.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: selected.revision }),
    }));
  };

  const startNew = (): void => {
    setSelectedId(null);
    setDraft({ ...EMPTY_DRAFT, shelfAfter: defaultShelfAfter });
    setError("");
  };

  const editable = selected === undefined || selected.state === "active";
  return (
    <div className="notebooks-workspace">
      <aside className="notebooks-index">
        <div className="notebooks-index-head">
          <div>
            <span className="notebooks-kicker">Private archive</span>
            <h2>Notebooks</h2>
          </div>
          <button type="button" className="btn primary" onClick={startNew}>New</button>
        </div>
        <div className="notebooks-filters">
          <input
            aria-label="Search notebooks"
            autoComplete="off"
            placeholder="Find a title or line"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <select aria-label="Notebook state" value={stateFilter} onChange={(event) => setStateFilter(event.currentTarget.value as NotebookState | "all")}>
            <option value="all">All states</option>
            <option value="active">Active</option>
            <option value="shelved">Shelved</option>
            <option value="archived">Archived</option>
            <option value="trashed">Trash</option>
          </select>
        </div>
        <div className="notebooks-list">
          {shown.map((notebook) => (
            <button
              type="button"
              className={`notebook-index-row${notebook.id === selectedId ? " selected" : ""}`}
              key={notebook.id}
              onClick={() => setSelectedId(notebook.id)}
            >
              <span className={`notebook-state-dot ${notebook.state}`} />
              <span className="notebook-index-copy">
                <strong>{notebook.title}</strong>
                <small>#{notebook.id} · {notebook.state} · r{notebook.revision}</small>
              </span>
            </button>
          ))}
          {shown.length === 0 ? <div className="notebooks-empty">No notebooks in this view.</div> : null}
        </div>
      </aside>

      <main className="notebook-editor">
        <header className="notebook-editor-head">
          <div>
            <span className="notebooks-kicker">{selected === undefined ? "New notebook" : `Notebook ${selected.id}`}</span>
            <div className="notebook-editor-meta">
              {selected === undefined
                ? "Unsaved"
                : `${selected.state} · revision ${selected.revision} · edited ${formatDate(selected.editedAt)}`}
            </div>
          </div>
          <div className="notebook-actions">
            {selected?.state === "active" ? (
              <>
                <button type="button" className="btn" disabled={busy} onClick={() => changeState("shelved")}>Shelve</button>
                <button type="button" className="btn" disabled={busy} onClick={() => changeState("archived")}>Archive</button>
              </>
            ) : null}
            {selected !== undefined && selected.state !== "active" ? (
              <button type="button" className="btn primary" disabled={busy} onClick={() => changeState("active")}>Activate</button>
            ) : null}
            {selected !== undefined && selected.state !== "trashed" ? (
              <button type="button" className="btn danger" disabled={busy} onClick={moveToTrash}>Delete</button>
            ) : null}
            {editable ? <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button> : null}
          </div>
        </header>

        {error !== "" ? <div className="notebook-error">{error}</div> : null}
        <div className="notebook-title-row">
          <input
            aria-label="Notebook title"
            disabled={!editable || busy}
            placeholder="Untitled notebook"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
          />
          <label>
            <span>Shelf after</span>
            <input
              aria-label="Shelf duration amount"
              type="number"
              min="0.01"
              step="any"
              disabled={!editable || busy}
              value={draft.shelfAfter.amount}
              onChange={(event) => setDraft({
                ...draft,
                shelfAfter: { ...draft.shelfAfter, amount: Number(event.currentTarget.value) },
              })}
            />
            <select
              aria-label="Shelf duration unit"
              disabled={!editable || busy}
              value={draft.shelfAfter.unit}
              onChange={(event) => setDraft({
                ...draft,
                shelfAfter: { ...draft.shelfAfter, unit: event.currentTarget.value as RelativeDurationUnit },
              })}
            >
              {DURATION_UNITS.map((unit) => <option value={unit} key={unit}>{unit}</option>)}
            </select>
          </label>
        </div>
        <textarea
          className="notebook-content-editor"
          aria-label="Notebook content"
          disabled={!editable || busy}
          placeholder="Start anywhere."
          value={draft.content}
          onChange={(event) => setDraft({ ...draft, content: event.currentTarget.value })}
        />
        {!editable ? <div className="notebook-readonly">Activate this notebook before you edit it.</div> : null}
      </main>
    </div>
  );
}

const root = document.getElementById("notebooks-tab-root");
if (root !== null) createRoot(root).render(<NotebooksTab />);
