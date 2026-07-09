/// <reference lib="dom" />

import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CSSProperties } from "react";
import type { RelationshipAxis, RelationshipEvent, RelationshipProfile } from "../relationships/types";
import { RELATIONSHIP_AXES } from "../relationships/state";

const INVERTED_AXES = new Set<RelationshipAxis>(["tension"]);

interface DirectoryUser {
  id: string;
  name: string;
}

interface Directory {
  users: DirectoryUser[];
}

interface Overview {
  profiles: RelationshipProfile[];
  selectedProfile: RelationshipProfile | null;
  events: RelationshipEvent[];
  promptPreview: string;
  config: {
    enabled: boolean;
    promptInjection: boolean;
    maxAxisDeltaPerSignal: number;
  };
}

async function api(path: string, body?: Record<string, unknown>): Promise<Overview> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text !== "" ? JSON.parse(text) as unknown : null;
  if (!response.ok) {
    throw new Error(data !== null && typeof data === "object" && "error" in data ? String((data as { error?: unknown }).error) : "Relationship request failed");
  }
  return data as Overview;
}

async function directoryApi(): Promise<Directory> {
  const response = await fetch("/api/management/directory");
  const text = await response.text();
  const data = text !== "" ? JSON.parse(text) as unknown : null;
  if (!response.ok) {
    throw new Error(data !== null && typeof data === "object" && "error" in data ? String((data as { error?: unknown }).error) : "Directory request failed");
  }
  return data as Directory;
}

function relationshipsPath(userId: string): string {
  return userId === "" ? "/api/relationships" : `/api/relationships?userId=${encodeURIComponent(userId)}`;
}

function time(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function profileText(profile: RelationshipProfile): string {
  const axes = Object.entries(profile.axes)
    .filter(([, value]) => value !== 0)
    .map(([axis, value]) => `${axis} ${value > 0 ? "+" : ""}${value}`)
    .join(", ");
  return [
    axes !== "" ? axes : "neutral",
    profile.notes.length > 0 ? `notes: ${profile.notes.slice(-3).join("; ")}` : "",
    profile.openLoops.length > 0 ? `open: ${profile.openLoops.slice(-3).join("; ")}` : "",
  ].filter((line) => line !== "").join("\n");
}

function RelationshipsLab(): JSX.Element {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [directory, setDirectory] = useState<Directory>({ users: [] });
  const [selectedUserId, setSelectedUserId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [eventFilter, setEventFilter] = useState("");

  const load = async (): Promise<void> => {
    setError("");
    const [nextOverview, nextDirectory] = await Promise.all([api(relationshipsPath(selectedUserId)), directoryApi()]);
    setOverview(nextOverview);
    setDirectory(nextDirectory);
  };

  useEffect(() => { void load(); }, [selectedUserId]);

  useEffect(() => {
    const firstUserId = overview?.profiles[0]?.userId ?? directory.users[0]?.id;
    if (selectedUserId === "" && firstUserId !== undefined) setSelectedUserId(firstUserId);
  }, [directory.users, overview, selectedUserId]);

  const reset = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      setOverview(await api(relationshipsPath(selectedUserId).replace("/api/relationships", "/api/relationships/reset"), {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const events = useMemo(() => {
    if (overview === null) return [];
    return eventFilter === "" ? overview.events : overview.events.filter((event) => event.source === eventFilter || event.visibility === eventFilter);
  }, [overview, eventFilter]);

  const userOptions = useMemo(() => {
    const users = new Map<string, string>();
    for (const user of directory.users) users.set(user.id, user.name);
    for (const profile of overview?.profiles ?? []) {
      if (!users.has(profile.userId)) users.set(profile.userId, profile.userId);
    }
    return [...users.entries()].sort((a, b) => {
      const nameOrder = a[1].localeCompare(b[1]);
      return nameOrder !== 0 ? nameOrder : a[0].localeCompare(b[0]);
    });
  }, [directory.users, overview]);

  const selectedLabel = userOptions.find(([id]) => id === selectedUserId)?.[1] ?? selectedUserId;
  const selectedProfile = overview?.selectedProfile ?? null;

  if (overview === null) return <div className="relationships-error">Loading Relationships Lab...</div>;

  return (
    <div className="relationships-shell">
      <aside>
        {error !== "" ? <div className="relationships-error">{error}</div> : null}
        <section className="relationships-panel">
          <div className="relationships-title"><span>Relationships</span><span>{overview.config.enabled ? "on" : "off"}</span></div>
          <div className="relationships-row">
            <div className="relationships-label">User</div>
            <select value={selectedUserId} onChange={(event) => setSelectedUserId(event.currentTarget.value)}>
              <option value="" disabled>Select user</option>
              {userOptions.map(([id, name]) => <option key={id} value={id}>@{name}</option>)}
            </select>
          </div>
          <div className="relationships-row"><div className="relationships-label">Post-reply pass</div><div className="relationships-value">main model</div></div>
          <div className="relationships-row"><div className="relationships-label">Max axis delta</div><div className="relationships-value">{overview.config.maxAxisDeltaPerSignal}</div></div>
          <div className="relationships-actions">
            <button className="btn danger" disabled={busy} onClick={() => void reset()}>Reset</button>
            <button className="btn" disabled={busy} onClick={() => void load()}>Refresh</button>
          </div>
        </section>
        <section className="relationships-panel">
          <div className="relationships-title"><span>Prompt Preview</span><span>{selectedLabel}</span></div>
          <pre className="relationships-code">{overview.promptPreview}</pre>
        </section>
      </aside>

      <main className="relationships-main">
        <section>
          <div className="relationships-panel">
            <div className="relationships-title"><span>Selected Profile</span><span>{selectedProfile === null ? "empty" : time(selectedProfile.updatedAt)}</span></div>
            {selectedProfile !== null
              ? <pre className="relationships-code">{profileText(selectedProfile)}</pre>
              : <div className="detail-state">No stored relationship profile for this user.</div>}
          </div>
          <div className="relationships-panel">
            <div className="relationships-title"><span>Raw Axes</span><span>{selectedProfile?.userId ?? "none"}</span></div>
            {selectedProfile !== null
              ? <div className="relationships-axis-list">
                  {RELATIONSHIP_AXES.map((axis) => {
                    const value = selectedProfile.axes[axis];
                    const bounded = Math.max(-100, Math.min(100, value));
                    const magnitude = Math.abs(bounded);
                    const health = INVERTED_AXES.has(axis) ? -bounded : bounded;
                    const style = {
                      "--axis-fill-left": `${bounded < 0 ? 50 - (magnitude / 2) : 50}%`,
                      "--axis-fill-width": `${magnitude / 2}%`,
                      "--axis-fill-color": health >= 0 ? "34,197,94" : "239,68,68",
                      "--axis-fill-alpha": String(Math.min(0.28, 0.055 + magnitude / 360)),
                    } as CSSProperties;
                    return (
                      <div className="relationships-axis-row" key={axis} style={style}>
                        <span>{axis}</span>
                        <code>{value.toFixed(1)}</code>
                      </div>
                    );
                  })}
                </div>
              : <div className="detail-state">No axes recorded.</div>}
          </div>
          <div className="relationships-panel">
            <div className="relationships-title"><span>All Profiles</span><span>{overview.profiles.length}</span></div>
            <div className="relationships-list">
              {overview.profiles.map((profile) => (
                <article className="relationships-event" key={profile.userId}>
                  <div className="relationships-event-top">
                    <button className="relationships-user-link" onClick={() => setSelectedUserId(profile.userId)}>{userOptions.find(([id]) => id === profile.userId)?.[1] ?? profile.userId}</button>
                    <span>{time(profile.updatedAt)}</span>
                  </div>
                  <pre className="relationships-code">{profileText(profile)}</pre>
                </article>
              ))}
              {overview.profiles.length === 0 ? <div className="detail-state">No relationship profiles.</div> : null}
            </div>
          </div>
        </section>
        <section>
          <div className="relationships-panel">
            <div className="relationships-title">
              <span>Signal Log</span>
              <select value={eventFilter} onChange={(event) => setEventFilter(event.currentTarget.value)}>
                <option value="">All</option>
                <option value="llm">LLM</option>
                <option value="admin">Admin</option>
                <option value="relationship-private">Private</option>
              </select>
            </div>
            <div className="relationships-list">
              {events.map((event) => (
                <article className="relationships-event" key={event.id}>
                  <div className="relationships-event-top"><span>{time(event.at)} / {event.source}</span><span>{event.userId ?? "no user"} / {event.visibility}</span></div>
                  <div className="relationships-event-summary">{event.summary}</div>
                </article>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

const root = document.getElementById("relationships-lab-root");
if (root !== null) createRoot(root).render(<RelationshipsLab />);
