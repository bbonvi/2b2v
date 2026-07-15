/// <reference lib="dom" />

import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ManagementDirectory, ManagementLabel } from "./management";
import type { MemoryKind } from "../db/memory-kinds";

const MEMORY_KINDS = [
  "global_note",
  "user_note",
  "preference",
  "relationship",
  "fact",
  "identity",
  "constraint",
  "interest",
  "journal",
  "scratchpad",
] as const satisfies readonly MemoryKind[];

type MemoryScope = "guild" | "user" | "self";
type MemoryStatus = "active" | "expired" | "deleted" | "all";

interface MemoryRecord {
  id: number;
  scope: MemoryScope;
  guildId: string | null;
  guildName?: string;
  subjectUserId: string | null;
  subjectUsername?: string;
  appliesTo: "all" | string[];
  appliesToUsernames: "all" | string[];
  kind: MemoryKind;
  content: string;
  sourceMessageId: string | null;
  sourceGuildId: string | null;
  sourceGuildName?: string;
  sourceChannelId: string | null;
  sourceChannelName?: string;
  provenance: Record<string, unknown> | null;
  confidence: number;
  priority: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  deletedAt: number | null;
}

interface MemoryDraft {
  id: number | null;
  scope: MemoryScope;
  guildId: string;
  subjectUserId: string;
  appliesToMode: "all" | "users";
  appliesToUserIds: string[];
  kind: MemoryKind;
  content: string;
  sourceMessageId: string;
  provenanceText: string;
  confidence: number;
  priority: number;
  expiresAtInput: string;
  createdAt: number | null;
  updatedAt: number | null;
  deletedAt: number | null;
}

interface Filters {
  query: string;
  guildId: string;
  channelId: string;
  scope: "" | MemoryScope;
  kind: "" | MemoryKind;
  subjectUserId: string;
  applicableToUserId: string;
  applicabilityMode: "" | "all" | "users";
  status: MemoryStatus;
}

const EMPTY_FILTERS: Filters = {
  query: "",
  guildId: "",
  channelId: "",
  scope: "",
  kind: "",
  subjectUserId: "",
  applicableToUserId: "",
  applicabilityMode: "",
  status: "active",
};

const FILTERS_KEY = "2b2v.dashboard.memories.filters.v1";

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function toLocalDateTimeInput(ms: number | null): string {
  if (ms === null) return "";
  const date = new Date(ms);
  const local = new Date(ms - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function memoryStatus(memory: MemoryRecord): "active" | "expired" | "deleted" {
  if (memory.deletedAt !== null) return "deleted";
  if (memory.expiresAt !== null && memory.expiresAt <= Date.now()) return "expired";
  return "active";
}

function draftFromMemory(memory: MemoryRecord): MemoryDraft {
  return {
    id: memory.id,
    scope: memory.scope,
    guildId: memory.guildId ?? "",
    subjectUserId: memory.subjectUserId ?? "",
    appliesToMode: memory.appliesTo === "all" ? "all" : "users",
    appliesToUserIds: memory.appliesTo === "all" ? [] : memory.appliesTo,
    kind: memory.kind,
    content: memory.content,
    sourceMessageId: memory.sourceMessageId ?? "",
    provenanceText: memory.provenance === null ? "" : JSON.stringify(memory.provenance, null, 2),
    confidence: memory.confidence,
    priority: memory.priority,
    expiresAtInput: toLocalDateTimeInput(memory.expiresAt),
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    deletedAt: memory.deletedAt,
  };
}

function newDraft(directory: ManagementDirectory): MemoryDraft {
  return {
    id: null,
    scope: "guild",
    guildId: directory.guilds[0]?.id ?? "",
    subjectUserId: "",
    appliesToMode: "all",
    appliesToUserIds: [],
    kind: "global_note",
    content: "",
    sourceMessageId: "",
    provenanceText: "",
    confidence: 0.7,
    priority: 0,
    expiresAtInput: "",
    createdAt: null,
    updatedAt: null,
    deletedAt: null,
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (response.status === 401) {
    location.href = "/login";
    throw new Error("Dashboard session expired.");
  }
  const text = await response.text();
  const data = text === "" ? null : JSON.parse(text) as unknown;
  if (!response.ok) {
    const message = data !== null && typeof data === "object" && "error" in data
      ? String((data as { error?: unknown }).error)
      : "Memory request failed.";
    throw new Error(message);
  }
  return data as T;
}

function userLabel(users: ManagementLabel[], userId: string): string {
  return users.find((user) => user.id === userId)?.name ?? userId;
}

function UserPicker(props: {
  users: ManagementLabel[];
  value: string;
  onChange: (userId: string) => void;
  placeholder: string;
  compact?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = props.users.find((user) => user.id === props.value);
  const shownUsers = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return props.users
      .filter((user) => needle === "" || user.name.toLocaleLowerCase().includes(needle) || user.id.includes(needle))
      .slice(0, 12);
  }, [props.users, query]);

  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (rootRef.current !== null && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => { document.removeEventListener("mousedown", close); };
  }, []);

  return (
    <div className={`memory-user-picker${props.compact === true ? " compact" : ""}`} ref={rootRef}>
      <button type="button" className="memory-picker-trigger" onClick={() => { setOpen(!open); setQuery(""); }}>
        <span>{selected === undefined ? props.placeholder : `@${selected.name}`}</span>
        <span className="memory-picker-chevron">⌄</span>
      </button>
      {open ? (
        <div className="memory-picker-popover">
          <input autoFocus value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search username or ID" />
          {props.value !== "" ? <button type="button" className="memory-picker-option muted" onClick={() => { props.onChange(""); setOpen(false); }}>Clear selection</button> : null}
          <div className="memory-picker-results">
            {shownUsers.map((user) => (
              <button type="button" className={user.id === props.value ? "memory-picker-option selected" : "memory-picker-option"} key={user.id} onClick={() => { props.onChange(user.id); setOpen(false); }}>
                <strong>@{user.name}</strong><small>{user.id}</small>
              </button>
            ))}
            {shownUsers.length === 0 ? <div className="memory-picker-empty">No matching users</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function UserMultiPicker(props: {
  users: ManagementLabel[];
  values: string[];
  onChange: (userIds: string[]) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const selected = new Set(props.values);
  const candidates = props.users.filter((user) => {
    const needle = query.trim().toLocaleLowerCase();
    return !selected.has(user.id) && (needle === "" || user.name.toLocaleLowerCase().includes(needle) || user.id.includes(needle));
  }).slice(0, 10);

  return (
    <div className="memory-multi-picker">
      <div className="memory-user-chips">
        {props.values.map((userId) => (
          <button type="button" key={userId} onClick={() => props.onChange(props.values.filter((value) => value !== userId))} title="Remove">
            @{userLabel(props.users, userId)} <span>×</span>
          </button>
        ))}
      </div>
      <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Type a username to add…" />
      {query !== "" ? (
        <div className="memory-multi-results">
          {candidates.map((user) => (
            <button type="button" key={user.id} onClick={() => { props.onChange([...props.values, user.id]); setQuery(""); }}>
              <strong>@{user.name}</strong><small>{user.id}</small>
            </button>
          ))}
          {candidates.length === 0 ? <div>No matching users</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function MemoriesTab(): JSX.Element {
  const [directory, setDirectory] = useState<ManagementDirectory>({ guilds: [], channels: [], users: [] });
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [filters, setFilters] = useState<Filters>(() => {
    try {
      const stored = localStorage.getItem(FILTERS_KEY);
      return stored === null ? EMPTY_FILTERS : { ...EMPTY_FILTERS, ...JSON.parse(stored) as Partial<Filters> };
    } catch {
      return EMPTY_FILTERS;
    }
  });
  const [draft, setDraft] = useState<MemoryDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const loadSequence = useRef(0);

  useEffect(() => {
    void api<ManagementDirectory>("/api/management/directory")
      .then(setDirectory)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, []);

  useEffect(() => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
    const controller = new AbortController();
    const sequence = ++loadSequence.current;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: "1000", status: filters.status });
      if (filters.query.trim() !== "") params.set("query", filters.query.trim());
      if (filters.guildId !== "") params.set("guildId", filters.guildId);
      if (filters.channelId !== "") params.set("channelId", filters.channelId);
      if (filters.scope !== "") params.set("scope", filters.scope);
      if (filters.kind !== "") params.set("kind", filters.kind);
      if (filters.subjectUserId !== "") params.set("subjectUserId", filters.subjectUserId);
      if (filters.applicableToUserId !== "") params.set("applicableToUserId", filters.applicableToUserId);
      if (filters.applicabilityMode !== "") params.set("applicabilityMode", filters.applicabilityMode);
      setLoading(true);
      setError("");
      void api<{ memories: MemoryRecord[] }>(`/api/management/memories?${params.toString()}`, { signal: controller.signal })
        .then((result) => {
          if (sequence !== loadSequence.current) return;
          setMemories(result.memories);
          setDraft((current) => {
            if (current === null || current.id === null) return current;
            const refreshed = result.memories.find((memory) => memory.id === current.id);
            return refreshed === undefined ? current : draftFromMemory(refreshed);
          });
        })
        .catch((caught: unknown) => {
          if (sequence === loadSequence.current && !(caught instanceof DOMException && caught.name === "AbortError")) {
            setError(caught instanceof Error ? caught.message : String(caught));
          }
        })
        .finally(() => { if (sequence === loadSequence.current) setLoading(false); });
    }, filters.query === "" ? 0 : 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [filters, reloadToken]);

  const visibleChannels = useMemo(() => directory.channels.filter((channel) => filters.guildId === "" || channel.guildId === filters.guildId), [directory.channels, filters.guildId]);
  const draftLifecycle = draft?.deletedAt !== null && draft?.deletedAt !== undefined
    ? "deleted"
    : draft !== null && draft.expiresAtInput !== "" && new Date(draft.expiresAtInput).getTime() <= Date.now()
      ? "expired"
      : "active";

  const updateDraft = <K extends keyof MemoryDraft>(key: K, value: MemoryDraft[K]): void => {
    setDraft((current) => current === null ? null : { ...current, [key]: value });
  };

  const save = async (): Promise<void> => {
    if (draft === null) return;
    setError("");
    setNotice("");
    if (draft.content.trim() === "") { setError("Memory content cannot be empty."); return; }
    if (draft.scope === "guild" && draft.guildId === "") { setError("Choose a guild for a guild memory."); return; }
    if (draft.scope === "user" && draft.subjectUserId === "") { setError("Choose a subject for a user memory."); return; }
    if (draft.appliesToMode === "users" && draft.appliesToUserIds.length === 0) { setError("Choose at least one applies-to user."); return; }
    if (draft.kind === "journal" && draft.scope !== "self") { setError("Journal memories must use self scope."); return; }
    if (draft.kind === "scratchpad" && draft.expiresAtInput === "") { setError("Scratchpad memories require an expiry time."); return; }
    let provenance: Record<string, unknown> | null = null;
    if (draft.provenanceText.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(draft.provenanceText);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        provenance = parsed as Record<string, unknown>;
      } catch {
        setError("Provenance must be a valid JSON object.");
        return;
      }
    }
    const expiresAt = draft.expiresAtInput === "" ? null : new Date(draft.expiresAtInput).getTime();
    if (expiresAt !== null && !Number.isFinite(expiresAt)) { setError("Expiry time is invalid."); return; }
    const payload = {
      scope: draft.scope,
      guildId: draft.scope === "guild" ? draft.guildId : null,
      subjectUserId: draft.scope === "user" ? draft.subjectUserId : null,
      appliesTo: draft.appliesToMode === "all" ? "all" : draft.appliesToUserIds,
      kind: draft.kind,
      content: draft.content,
      sourceMessageId: draft.sourceMessageId.trim() === "" ? null : draft.sourceMessageId.trim(),
      provenance,
      confidence: draft.confidence,
      priority: Math.max(0, Math.trunc(draft.priority)),
      expiresAt,
    };
    setSaving(true);
    try {
      const path = draft.id === null ? "/api/management/memories" : `/api/management/memories/${draft.id}`;
      const result = await api<{ memory: MemoryRecord }>(path, {
        method: draft.id === null ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      setDraft(draftFromMemory(result.memory));
      setNotice(draft.id === null ? `Created memory #${result.memory.id}.` : `Saved memory #${result.memory.id}.`);
      setReloadToken((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (draft?.id === null || draft === null) return;
    if (!confirm(`Delete memory #${draft.id}? It can be restored until database cleanup removes it.`)) return;
    setSaving(true);
    try {
      await api(`/api/management/memories/${draft.id}`, { method: "DELETE" });
      setDraft(null);
      setNotice(`Deleted memory #${draft.id}.`);
      setReloadToken((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const restore = async (): Promise<void> => {
    if (draft?.id === null || draft === null) return;
    setSaving(true);
    try {
      const result = await api<{ memory: MemoryRecord }>(`/api/management/memories/${draft.id}/restore`, { method: "POST" });
      setDraft(draftFromMemory(result.memory));
      setNotice(`Restored memory #${draft.id}.`);
      setReloadToken((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const setScope = (scope: MemoryScope): void => {
    setDraft((current) => {
      if (current === null) return null;
      return {
        ...current,
        scope,
        kind: current.kind === "journal" && scope !== "self" ? "fact" : current.kind,
        guildId: scope === "guild"
          ? (current.guildId !== "" ? current.guildId : directory.guilds[0]?.id ?? "")
          : "",
        subjectUserId: scope === "user" ? current.subjectUserId : "",
      };
    });
  };

  const clearFilters = (): void => setFilters(EMPTY_FILTERS);

  return (
    <div className="memories-workspace">
      <header className="memories-header">
        <div>
          <span className="memories-kicker">Structured context archive</span>
          <h1>Memories</h1>
          <p>Portable, server-local, and private memories in the exact order 2B considers them: priority first, then latest update.</p>
        </div>
        <div className="memories-header-actions">
          <span className="memories-count">{loading ? "reading…" : `${memories.length} shown`}</span>
          <button className="btn" type="button" onClick={() => setReloadToken((value) => value + 1)}>Refresh</button>
          <button className="btn primary" type="button" onClick={() => { setDraft(newDraft(directory)); setError(""); setNotice(""); }}>New memory</button>
        </div>
      </header>

      <section className="memory-filter-panel" aria-label="Memory filters">
        <label className="memory-filter-search">
          <span>Search</span>
          <input value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.currentTarget.value })} placeholder="Content, memory ID, or source message ID" />
        </label>
        <label><span>Guild visibility</span><select value={filters.guildId} onChange={(event) => setFilters({ ...filters, guildId: event.currentTarget.value, channelId: "" })}><option value="">Every guild</option>{directory.guilds.map((guild) => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</select></label>
        <label><span>Source channel</span><select value={filters.channelId} onChange={(event) => setFilters({ ...filters, channelId: event.currentTarget.value })}><option value="">Every channel</option>{visibleChannels.map((channel) => <option key={`${channel.guildId}:${channel.id}`} value={channel.id}>#{channel.name}</option>)}</select></label>
        <label><span>Scope</span><select value={filters.scope} onChange={(event) => setFilters({ ...filters, scope: event.currentTarget.value as Filters["scope"] })}><option value="">Every scope</option><option value="guild">Guild</option><option value="user">User</option><option value="self">Self</option></select></label>
        <label><span>Kind</span><select value={filters.kind} onChange={(event) => setFilters({ ...filters, kind: event.currentTarget.value as Filters["kind"] })}><option value="">Every kind</option>{MEMORY_KINDS.map((kind) => <option key={kind} value={kind}>{humanize(kind)}</option>)}</select></label>
        <label><span>Applicability</span><select value={filters.applicabilityMode} onChange={(event) => setFilters({ ...filters, applicabilityMode: event.currentTarget.value as Filters["applicabilityMode"] })}><option value="">Everyone + selected</option><option value="all">Everyone only</option><option value="users">Selected users only</option></select></label>
        <label><span>Status</span><select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.currentTarget.value as MemoryStatus })}><option value="active">Active</option><option value="expired">Expired</option><option value="deleted">Deleted</option><option value="all">All states</option></select></label>
        <div className="memory-filter-user"><span>Subject username</span><UserPicker compact users={directory.users} value={filters.subjectUserId} onChange={(subjectUserId) => setFilters({ ...filters, subjectUserId })} placeholder="Any subject" /></div>
        <div className="memory-filter-user"><span>Applies to username</span><UserPicker compact users={directory.users} value={filters.applicableToUserId} onChange={(applicableToUserId) => setFilters({ ...filters, applicableToUserId })} placeholder="Any viewer" /></div>
        <button className="memory-clear-filters" type="button" onClick={clearFilters}>Clear filters</button>
      </section>

      {error !== "" ? <div className="memory-feedback error">{error}</div> : null}
      {notice !== "" ? <div className="memory-feedback success">{notice}</div> : null}

      <div className="memories-layout">
        <section className="memory-catalog" aria-label="Memory catalog">
          <div className="memory-catalog-heading"><span>2B order</span><span>priority ↓ · updated ↓</span></div>
          <div className="memory-list">
            {memories.map((memory) => {
              const status = memoryStatus(memory);
              const selected = draft?.id === memory.id;
              const owner = memory.scope === "guild" ? memory.guildName ?? memory.guildId ?? "Guild" : memory.scope === "user" ? `@${memory.subjectUsername ?? memory.subjectUserId ?? "unknown"}` : "2B / self";
              const source = memory.sourceChannelId === null ? "no source link" : `${memory.sourceGuildName ?? memory.sourceGuildId ?? "guild"} / #${memory.sourceChannelName ?? memory.sourceChannelId}`;
              return (
                <button type="button" key={memory.id} className={`memory-card ${status}${selected ? " selected" : ""}${memory.priority > 0 ? " priority" : ""}`} onClick={() => { setDraft(draftFromMemory(memory)); setError(""); setNotice(""); }}>
                  <span className="memory-card-rank">{memory.priority > 0 ? `P${memory.priority}` : "—"}</span>
                  <span className="memory-card-main">
                    <span className="memory-card-meta"><strong>#{memory.id}</strong><span>{humanize(memory.kind)}</span><span>{humanize(memory.scope)}</span><span>{owner}</span>{status !== "active" ? <em>{status}</em> : null}</span>
                    <span className="memory-card-content">{memory.content}</span>
                    <span className="memory-card-foot"><span>{memory.appliesToUsernames === "all" ? "applies to everyone" : `applies to ${memory.appliesToUsernames.map((name) => `@${name}`).join(", ")}`}</span><span>{source}</span><span>updated {formatDate(memory.updatedAt)}</span></span>
                  </span>
                </button>
              );
            })}
            {!loading && memories.length === 0 ? <div className="memory-empty"><strong>No memories found.</strong><span>Adjust the filters or create a new structured memory.</span></div> : null}
          </div>
        </section>

        <aside className="memory-inspector" aria-label="Memory editor">
          {draft === null ? (
            <div className="memory-inspector-empty"><span>Memory inspector</span><strong>Select a row or create a new memory.</strong><p>Subject, scope, applicability, expiry, ordering, confidence, and provenance are edited here without exposing stored Discord IDs as the primary interface.</p></div>
          ) : (
            <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <div className="memory-inspector-head">
                <div><span>{draft.id === null ? "New structured memory" : `Memory #${draft.id}`}</span><strong>{draft.id === null ? "Create" : humanize(draftLifecycle)}</strong></div>
                <button type="button" className="memory-inspector-close" onClick={() => setDraft(null)} aria-label="Close editor">×</button>
              </div>

              <fieldset disabled={saving || draft.deletedAt !== null}>
                <label className="memory-editor-content"><span>Memory</span><textarea autoFocus={draft.id === null} value={draft.content} onChange={(event) => updateDraft("content", event.currentTarget.value)} placeholder="Write one durable, focused memory…" /></label>

                <div className="memory-scope-switch" aria-label="Memory scope">
                  {(["guild", "user", "self"] as const).map((scope) => <button type="button" className={draft.scope === scope ? "active" : ""} key={scope} onClick={() => setScope(scope)}>{humanize(scope)}</button>)}
                </div>

                {draft.scope === "guild" ? <label><span>Guild</span><select value={draft.guildId} onChange={(event) => updateDraft("guildId", event.currentTarget.value)}><option value="">Choose guild</option>{directory.guilds.map((guild) => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</select></label> : null}
                {draft.scope === "user" ? <div className="memory-editor-picker"><span>Subject</span><UserPicker users={directory.users} value={draft.subjectUserId} onChange={(value) => updateDraft("subjectUserId", value)} placeholder="Choose username" /></div> : null}
                {draft.scope === "self" ? <div className="memory-scope-note"><strong>Self scope</strong><span>Private, portable context about 2B herself.</span></div> : null}

                <div className="memory-editor-grid two">
                  <label><span>Kind</span><select value={draft.kind} onChange={(event) => updateDraft("kind", event.currentTarget.value as MemoryKind)}>{MEMORY_KINDS.filter((kind) => kind !== "journal" || draft.scope === "self").map((kind) => <option key={kind} value={kind}>{humanize(kind)}</option>)}</select></label>
                  <label><span>Priority <small>ordering</small></span><input type="number" min="0" step="1" value={draft.priority} onChange={(event) => updateDraft("priority", Number(event.currentTarget.value))} /></label>
                </div>

                <div className="memory-applicability">
                  <div className="memory-editor-label"><span>Applies to</span><small>Independent from subject</small></div>
                  <div className="memory-applicability-switch"><button type="button" className={draft.appliesToMode === "all" ? "active" : ""} onClick={() => updateDraft("appliesToMode", "all")}>Everyone</button><button type="button" className={draft.appliesToMode === "users" ? "active" : ""} onClick={() => updateDraft("appliesToMode", "users")}>Selected users</button></div>
                  {draft.appliesToMode === "users" ? <UserMultiPicker users={directory.users} values={draft.appliesToUserIds} onChange={(values) => updateDraft("appliesToUserIds", values)} /> : <div className="memory-scope-note"><strong>Universal relevance</strong><span>This memory is eligible regardless of who is present.</span></div>}
                </div>

                <div className="memory-confidence-row">
                  <label><span>Confidence</span><input type="range" min="0" max="1" step="0.05" value={draft.confidence} onChange={(event) => updateDraft("confidence", Number(event.currentTarget.value))} /></label>
                  <output>{draft.confidence.toFixed(2)}</output>
                </div>

                <div className="memory-expiry-editor">
                  <div className="memory-editor-label"><span>Expiry</span><small>{draft.kind === "scratchpad" ? "required for scratchpad" : "optional"}</small></div>
                  <input type="datetime-local" value={draft.expiresAtInput} onChange={(event) => updateDraft("expiresAtInput", event.currentTarget.value)} />
                  <div className="memory-expiry-shortcuts">
                    <button type="button" onClick={() => updateDraft("expiresAtInput", "")}>Never</button>
                    <button type="button" onClick={() => updateDraft("expiresAtInput", toLocalDateTimeInput(Date.now() + 86_400_000))}>+1 day</button>
                    <button type="button" onClick={() => updateDraft("expiresAtInput", toLocalDateTimeInput(Date.now() + 7 * 86_400_000))}>+7 days</button>
                    <button type="button" onClick={() => updateDraft("expiresAtInput", toLocalDateTimeInput(Date.now() + 30 * 86_400_000))}>+30 days</button>
                  </div>
                </div>

                <details className="memory-advanced">
                  <summary>Source & provenance</summary>
                  <label><span>Source message ID</span><input value={draft.sourceMessageId} onChange={(event) => updateDraft("sourceMessageId", event.currentTarget.value)} placeholder="Optional Discord message ID" /></label>
                  <label><span>Provenance JSON</span><textarea value={draft.provenanceText} onChange={(event) => updateDraft("provenanceText", event.currentTarget.value)} placeholder={'{\n  "source": "dashboard"\n}'} /></label>
                </details>
              </fieldset>

              {draft.createdAt !== null ? <div className="memory-audit"><span>Created {formatDate(draft.createdAt)}</span><span>Updated {formatDate(draft.updatedAt ?? draft.createdAt)}</span></div> : null}
              <div className="memory-editor-actions">
                {draft.id !== null && draft.deletedAt === null ? <button type="button" className="btn danger" disabled={saving} onClick={() => void remove()}>Delete</button> : null}
                {draft.id !== null && draft.deletedAt !== null ? <button type="button" className="btn" disabled={saving} onClick={() => void restore()}>Restore</button> : null}
                <span />
                <button type="button" className="btn" disabled={saving} onClick={() => setDraft(null)}>Cancel</button>
                {draft.deletedAt === null ? <button type="submit" className="btn primary" disabled={saving}>{saving ? "Saving…" : draft.id === null ? "Create memory" : "Save changes"}</button> : null}
              </div>
            </form>
          )}
        </aside>
      </div>
    </div>
  );
}

const root = document.getElementById("memories-tab-root");
if (root !== null) createRoot(root).render(<MemoriesTab />);
