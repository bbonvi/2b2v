/// <reference lib="dom" />

import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ManagementDirectory, ManagementLabel } from "./management";
import type { MemoryKind } from "../db/memory-kinds";

const MEMORY_KINDS = [
  "note",
  "preference",
  "relationship",
  "fact",
  "identity",
  "constraint",
  "interest",
  "journal",
  "scratchpad",
] as const satisfies readonly MemoryKind[];

const NON_CREDENTIAL_INPUT_PROPS = {
  autoComplete: "off",
  "data-1p-ignore": "true",
  "data-bwignore": "true",
  "data-lpignore": "true",
} as const;

type MemoryAbout = "community" | "user" | "self";
type MemoryStatus = "active" | "expired" | "deleted" | "all";

interface MemoryRecord {
  id: number;
  about: MemoryAbout;
  recallIn: "anywhere" | { guildId: string };
  guildName?: string;
  aboutUserId: string | null;
  aboutUsername?: string;
  recallWhen: "always" | string[];
  recallWhenUsernames: "always" | string[];
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
  about: MemoryAbout;
  recallScope: "anywhere" | "guild";
  recallGuildId: string;
  aboutUserId: string;
  recallMode: "always" | "users";
  recallUserIds: string[];
  kind: MemoryKind;
  content: string;
  sourceMessageId: string;
  provenanceText: string;
  confidence: number;
  important: boolean;
  expiresAtInput: string;
  createdAt: number | null;
  updatedAt: number | null;
  deletedAt: number | null;
}

interface Filters {
  query: string;
  guildId: string;
  channelId: string;
  about: "" | MemoryAbout;
  recallScope: "" | "anywhere" | "guild";
  kind: "" | MemoryKind;
  aboutUserId: string;
  relevantUserId: string;
  recallMode: "" | "always" | "users";
  importance: "" | "important" | "ordinary";
  status: MemoryStatus;
}

const EMPTY_FILTERS: Filters = {
  query: "",
  guildId: "",
  channelId: "",
  about: "",
  recallScope: "",
  kind: "",
  aboutUserId: "",
  relevantUserId: "",
  recallMode: "",
  importance: "",
  status: "active",
};

const FILTERS_KEY = "2b2v.dashboard.memories.filters.v2";

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
    about: memory.about,
    recallScope: memory.recallIn === "anywhere" ? "anywhere" : "guild",
    recallGuildId: memory.recallIn === "anywhere" ? "" : memory.recallIn.guildId,
    aboutUserId: memory.aboutUserId ?? "",
    recallMode: memory.recallWhen === "always" ? "always" : "users",
    recallUserIds: memory.recallWhen === "always" ? [] : memory.recallWhen,
    kind: memory.kind,
    content: memory.content,
    sourceMessageId: memory.sourceMessageId ?? "",
    provenanceText: memory.provenance === null ? "" : JSON.stringify(memory.provenance, null, 2),
    confidence: memory.confidence,
    important: memory.priority > 0,
    expiresAtInput: toLocalDateTimeInput(memory.expiresAt),
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    deletedAt: memory.deletedAt,
  };
}

function newDraft(directory: ManagementDirectory): MemoryDraft {
  return {
    id: null,
    about: "community",
    recallScope: "guild",
    recallGuildId: directory.guilds[0]?.id ?? "",
    aboutUserId: "",
    recallMode: "always",
    recallUserIds: [],
    kind: "note",
    content: "",
    sourceMessageId: "",
    provenanceText: "",
    confidence: 0.7,
    important: false,
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
          <input {...NON_CREDENTIAL_INPUT_PROPS} autoFocus value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search username or ID" />
          {props.value !== "" ? <button type="button" className="memory-picker-option muted" onClick={() => { props.onChange(""); setOpen(false); }}>Clear selection</button> : null}
          <div className="memory-picker-results">
            {shownUsers.map((user) => (
              <button type="button" className={user.id === props.value ? "memory-picker-option selected" : "memory-picker-option"} key={user.id} onClick={() => { props.onChange(user.id); setOpen(false); }}>
                <strong>@{user.name}</strong>
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = new Set(props.values);
  const candidates = props.users.filter((user) => {
    const needle = query.trim().toLocaleLowerCase();
    return !selected.has(user.id) && (needle === "" || user.name.toLocaleLowerCase().includes(needle) || user.id.includes(needle));
  }).slice(0, 10);

  return (
    <div
      className="memory-multi-picker"
      ref={rootRef}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget) === true) return;
        setOpen(false);
      }}
    >
      <div className="memory-user-chips">
        {props.values.map((userId) => (
          <button type="button" key={userId} onClick={() => props.onChange(props.values.filter((value) => value !== userId))} title="Remove">
            @{userLabel(props.users, userId)} <span>×</span>
          </button>
        ))}
      </div>
      <input {...NON_CREDENTIAL_INPUT_PROPS} value={query} onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.currentTarget.value); setOpen(true); }} placeholder="Type a username to add…" />
      {open ? (
        <div className="memory-multi-results">
          {candidates.map((user) => (
            <button type="button" key={user.id} onClick={() => { props.onChange([...props.values, user.id]); setQuery(""); setOpen(false); }}>
              <strong>@{user.name}</strong>
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
    if (notice === "") return;
    const timer = window.setTimeout(() => setNotice(""), 2_500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
    const controller = new AbortController();
    const sequence = ++loadSequence.current;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: "1000", status: filters.status });
      if (filters.query.trim() !== "") params.set("query", filters.query.trim());
      if (filters.guildId !== "") params.set("guildId", filters.guildId);
      if (filters.channelId !== "") params.set("channelId", filters.channelId);
      if (filters.about !== "") params.set("about", filters.about);
      if (filters.recallScope !== "") params.set("recallScope", filters.recallScope);
      if (filters.kind !== "") params.set("kind", filters.kind);
      if (filters.aboutUserId !== "") params.set("aboutUserId", filters.aboutUserId);
      if (filters.relevantUserId !== "") params.set("relevantUserId", filters.relevantUserId);
      if (filters.recallMode !== "") params.set("recallMode", filters.recallMode);
      if (filters.importance !== "") params.set("important", String(filters.importance === "important"));
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
  const resolvedUsers = useMemo(() => {
    const users = new Map(directory.users.map((user) => [user.id, user]));
    for (const memory of memories) {
      if (memory.aboutUserId !== null && memory.aboutUsername !== undefined && memory.aboutUsername !== memory.aboutUserId) {
        users.set(memory.aboutUserId, { id: memory.aboutUserId, name: memory.aboutUsername });
      }
      if (memory.recallWhen !== "always" && memory.recallWhenUsernames !== "always") {
        memory.recallWhen.forEach((userId, index) => {
          const username = memory.recallWhenUsernames[index];
          if (username !== undefined && username !== userId) users.set(userId, { id: userId, name: username });
        });
      }
    }
    return [...users.values()].sort((left, right) => {
      const nameOrder = left.name.localeCompare(right.name);
      return nameOrder !== 0 ? nameOrder : left.id.localeCompare(right.id);
    });
  }, [directory.users, memories]);
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
    if (draft.recallScope === "guild" && draft.recallGuildId === "") { setError("Choose a recall guild."); return; }
    if (draft.about === "community" && draft.recallScope !== "guild") { setError("Community memories must be recalled in one guild."); return; }
    if (draft.about === "user" && draft.aboutUserId === "") { setError("Choose who the memory is about."); return; }
    if (draft.recallMode === "users" && draft.recallUserIds.length === 0) { setError("Choose at least one recall-trigger user."); return; }
    if (draft.kind === "journal" && draft.about !== "self") { setError("Journal memories must be about self."); return; }
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
      about: draft.about,
      aboutUserId: draft.about === "user" ? draft.aboutUserId : null,
      recallIn: draft.recallScope === "anywhere" ? "anywhere" : { guildId: draft.recallGuildId },
      recallWhen: draft.recallMode === "always" ? "always" : draft.recallUserIds,
      kind: draft.kind,
      content: draft.content,
      sourceMessageId: draft.sourceMessageId.trim() === "" ? null : draft.sourceMessageId.trim(),
      provenance,
      confidence: draft.confidence,
      priority: draft.important ? 1 : 0,
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

  const setAbout = (about: MemoryAbout): void => {
    setDraft((current) => {
      if (current === null) return null;
      return {
        ...current,
        about,
        kind: current.kind === "journal" && about !== "self" ? "fact" : current.kind,
        recallScope: about === "community" ? "guild" : current.about === "community" ? "anywhere" : current.recallScope,
        recallGuildId: about === "community" && current.recallGuildId === ""
          ? directory.guilds[0]?.id ?? ""
          : current.recallGuildId,
        aboutUserId: about === "user" ? current.aboutUserId : "",
      };
    });
  };

  const clearFilters = (): void => setFilters(EMPTY_FILTERS);

  return (
    <div className="memories-workspace">
      <div className="memories-toolbar">
        <span className="memories-count">{loading ? "reading…" : `${memories.length} shown`}</span>
        <button className="btn" type="button" onClick={() => setReloadToken((value) => value + 1)}>Refresh</button>
        <button className="btn primary" type="button" onClick={() => { setDraft(newDraft(directory)); setError(""); setNotice(""); }}>New memory</button>
      </div>

      <section className="memory-filter-panel" aria-label="Memory filters">
        <label className="memory-filter-search">
          <span>Search</span>
          <input {...NON_CREDENTIAL_INPUT_PROPS} value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.currentTarget.value })} placeholder="Content, memory ID, or source message ID" />
        </label>
        <label><span>Available in guild</span><select value={filters.guildId} onChange={(event) => setFilters({ ...filters, guildId: event.currentTarget.value, channelId: "" })}><option value="">Every guild</option>{directory.guilds.map((guild) => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</select></label>
        <label><span>Source channel</span><select value={filters.channelId} onChange={(event) => setFilters({ ...filters, channelId: event.currentTarget.value })}><option value="">Every channel</option>{visibleChannels.map((channel) => <option key={`${channel.guildId}:${channel.id}`} value={channel.id}>#{channel.name}</option>)}</select></label>
        <label><span>About</span><select value={filters.about} onChange={(event) => setFilters({ ...filters, about: event.currentTarget.value as Filters["about"] })}><option value="">Everything</option><option value="community">Community</option><option value="user">User</option><option value="self">Self</option></select></label>
        <label><span>Recall location</span><select value={filters.recallScope} onChange={(event) => setFilters({ ...filters, recallScope: event.currentTarget.value as Filters["recallScope"] })}><option value="">Anywhere + guild</option><option value="anywhere">Anywhere</option><option value="guild">One guild</option></select></label>
        <label><span>Kind</span><select value={filters.kind} onChange={(event) => setFilters({ ...filters, kind: event.currentTarget.value as Filters["kind"] })}><option value="">Every kind</option>{MEMORY_KINDS.map((kind) => <option key={kind} value={kind}>{humanize(kind)}</option>)}</select></label>
        <label><span>Recall trigger</span><select value={filters.recallMode} onChange={(event) => setFilters({ ...filters, recallMode: event.currentTarget.value as Filters["recallMode"] })}><option value="">Always + user presence</option><option value="always">Always</option><option value="users">Users present</option></select></label>
        <label><span>Importance</span><select value={filters.importance} onChange={(event) => setFilters({ ...filters, importance: event.currentTarget.value as Filters["importance"] })}><option value="">Important + ordinary</option><option value="important">Important only</option><option value="ordinary">Ordinary only</option></select></label>
        <label><span>Status</span><select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.currentTarget.value as MemoryStatus })}><option value="active">Active</option><option value="expired">Expired</option><option value="deleted">Deleted</option><option value="all">All states</option></select></label>
        <div className="memory-filter-user"><span>About username</span><UserPicker compact users={resolvedUsers} value={filters.aboutUserId} onChange={(aboutUserId) => setFilters({ ...filters, aboutUserId })} placeholder="Any user" /></div>
        <div className="memory-filter-user"><span>Relevant with username</span><UserPicker compact users={resolvedUsers} value={filters.relevantUserId} onChange={(relevantUserId) => setFilters({ ...filters, relevantUserId })} placeholder="Any user" /></div>
        <button className="memory-clear-filters" type="button" onClick={clearFilters}>Clear filters</button>
      </section>

      {error !== "" ? <div className="memory-feedback error" role="alert">{error}</div> : null}
      {notice !== "" ? <div className="memory-feedback success" role="status">{notice}</div> : null}

      <div className="memories-layout">
        <section className="memory-catalog" aria-label="Memory catalog">
          <div className="memory-catalog-heading"><span>Memories</span><span>important first · then latest update</span></div>
          <div className="memory-list">
            {memories.map((memory) => {
              const status = memoryStatus(memory);
              const selected = draft?.id === memory.id;
              const owner = memory.about === "community" ? "Community" : memory.about === "user" ? `@${memory.aboutUsername ?? memory.aboutUserId ?? "unknown"}` : "2B / self";
              const recallLocation = memory.recallIn === "anywhere" ? "anywhere" : memory.guildName ?? memory.recallIn.guildId;
              const source = memory.sourceChannelId === null ? "no source link" : `${memory.sourceGuildName ?? memory.sourceGuildId ?? "guild"} / #${memory.sourceChannelName ?? memory.sourceChannelId}`;
              return (
                <button type="button" key={memory.id} className={`memory-card about-${memory.about} ${status}${selected ? " selected" : ""}${memory.priority > 0 ? " priority" : ""}`} onClick={() => { setDraft(draftFromMemory(memory)); setError(""); setNotice(""); }}>
                  <span className="memory-card-main">
                    <span className="memory-card-meta"><strong>#{memory.id}</strong>{memory.priority > 0 ? <b className="memory-important-badge">Important</b> : null}<span className={`memory-kind-label kind-${memory.kind}`}>{humanize(memory.kind)}</span><span className="memory-about-label">{humanize(memory.about)}</span><b className="memory-card-owner">{owner}</b>{status !== "active" ? <em>{status}</em> : null}</span>
                    <span className="memory-card-content">{memory.content}</span>
                    <span className="memory-card-foot">
                      <span>in {recallLocation}; {memory.recallWhenUsernames === "always" ? "always relevant" : <>when any of {memory.recallWhenUsernames.map((name, index) => <span key={`${name}:${index}`}>{index > 0 ? ", " : ""}<b>@{name}</b></span>)} are present</>}</span>
                      <span>{source}</span><span>updated {formatDate(memory.updatedAt)}</span>
                    </span>
                  </span>
                </button>
              );
            })}
            {!loading && memories.length === 0 ? <div className="memory-empty"><strong>No memories found.</strong><span>Adjust the filters or create a new structured memory.</span></div> : null}
          </div>
        </section>

        <aside className="memory-inspector" aria-label="Memory editor">
          {draft === null ? (
            <div className="memory-inspector-empty"><span>Memory inspector</span><strong>Select a row or create a new memory.</strong><p>What a memory describes, where it can be recalled, and when it is relevant are edited independently.</p></div>
          ) : (
            <form autoComplete="off" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <div className="memory-inspector-head">
                <div><span>{draft.id === null ? "New structured memory" : `Memory #${draft.id}`}</span><strong>{draft.id === null ? "Create" : humanize(draftLifecycle)}</strong></div>
                <button type="button" className="memory-inspector-close" onClick={() => setDraft(null)} aria-label="Close editor">×</button>
              </div>

              <fieldset disabled={saving || draft.deletedAt !== null}>
                <label className="memory-editor-content"><span>Memory</span><textarea {...NON_CREDENTIAL_INPUT_PROPS} autoFocus={draft.id === null} value={draft.content} onChange={(event) => updateDraft("content", event.currentTarget.value)} placeholder="Write one durable, focused memory…" /></label>

                <div className="memory-about-switch" aria-label="What the memory is about">
                  {(["community", "user", "self"] as const).map((about) => <button type="button" className={draft.about === about ? "active" : ""} key={about} onClick={() => setAbout(about)}>{humanize(about)}</button>)}
                </div>

                {draft.about === "user" ? <div className="memory-editor-picker"><span>About user</span><UserPicker users={resolvedUsers} value={draft.aboutUserId} onChange={(value) => updateDraft("aboutUserId", value)} placeholder="Choose username" /></div> : null}
                {draft.about === "self" ? <div className="memory-about-note"><strong>About self</strong><span>Context about 2B herself.</span></div> : null}

                <div className="memory-recall">
                  <div className="memory-editor-label"><span>Recall in</span><small>Independent from what it describes</small></div>
                  <div className="memory-recall-switch"><button type="button" disabled={draft.about === "community"} className={draft.recallScope === "anywhere" ? "active" : ""} onClick={() => updateDraft("recallScope", "anywhere")}>Anywhere</button><button type="button" className={draft.recallScope === "guild" ? "active" : ""} onClick={() => updateDraft("recallScope", "guild")}>One guild</button></div>
                  {draft.recallScope === "guild" ? <label><span>Guild</span><select value={draft.recallGuildId} onChange={(event) => updateDraft("recallGuildId", event.currentTarget.value)}><option value="">Choose guild</option>{directory.guilds.map((guild) => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</select></label> : null}
                </div>

                <div className="memory-editor-grid two">
                  <label><span>Kind</span><select value={draft.kind} onChange={(event) => updateDraft("kind", event.currentTarget.value as MemoryKind)}>{MEMORY_KINDS.filter((kind) => kind !== "journal" || draft.about === "self").map((kind) => <option key={kind} value={kind}>{humanize(kind)}</option>)}</select></label>
                  <div className="memory-important-editor">
                    <span>Importance</span>
                    <label><input type="checkbox" checked={draft.important} onChange={(event) => updateDraft("important", event.currentTarget.checked)} /><span><strong>Important</strong><small>Pinned above ordinary memories</small></span></label>
                  </div>
                </div>

                <div className="memory-recall">
                  <div className="memory-editor-label"><span>Recall when</span><small>Independent from what it describes</small></div>
                  <div className="memory-recall-switch"><button type="button" className={draft.recallMode === "always" ? "active" : ""} onClick={() => updateDraft("recallMode", "always")}>Always</button><button type="button" className={draft.recallMode === "users" ? "active" : ""} onClick={() => updateDraft("recallMode", "users")}>Users present</button></div>
                  {draft.recallMode === "users" ? <UserMultiPicker users={resolvedUsers} values={draft.recallUserIds} onChange={(values) => updateDraft("recallUserIds", values)} /> : <div className="memory-about-note"><strong>Always relevant</strong><span>Recall does not depend on who is present.</span></div>}
                </div>

                <div className="memory-confidence-row">
                  <label><span>Confidence</span><input type="range" min="0" max="1" step="0.05" value={draft.confidence} onChange={(event) => updateDraft("confidence", Number(event.currentTarget.value))} /></label>
                  <output>{draft.confidence.toFixed(2)}</output>
                </div>

                <div className="memory-expiry-editor">
                  <div className="memory-editor-label"><span>Expiry</span><small>{draft.kind === "scratchpad" ? "required for scratchpad" : "optional"}</small></div>
                  <input {...NON_CREDENTIAL_INPUT_PROPS} type="datetime-local" value={draft.expiresAtInput} onChange={(event) => updateDraft("expiresAtInput", event.currentTarget.value)} />
                  <div className="memory-expiry-shortcuts">
                    <button type="button" onClick={() => updateDraft("expiresAtInput", "")}>Never</button>
                    <button type="button" onClick={() => updateDraft("expiresAtInput", toLocalDateTimeInput(Date.now() + 86_400_000))}>+1 day</button>
                    <button type="button" onClick={() => updateDraft("expiresAtInput", toLocalDateTimeInput(Date.now() + 7 * 86_400_000))}>+7 days</button>
                    <button type="button" onClick={() => updateDraft("expiresAtInput", toLocalDateTimeInput(Date.now() + 30 * 86_400_000))}>+30 days</button>
                  </div>
                </div>

                <details className="memory-advanced">
                  <summary>Source & provenance</summary>
                  <label><span>Source message ID</span><input {...NON_CREDENTIAL_INPUT_PROPS} value={draft.sourceMessageId} onChange={(event) => updateDraft("sourceMessageId", event.currentTarget.value)} placeholder="Optional Discord message ID" /></label>
                  <label><span>Provenance JSON</span><textarea {...NON_CREDENTIAL_INPUT_PROPS} value={draft.provenanceText} onChange={(event) => updateDraft("provenanceText", event.currentTarget.value)} placeholder={'{\n  "source": "dashboard"\n}'} /></label>
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
