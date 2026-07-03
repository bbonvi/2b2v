/// <reference lib="dom" />

import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RelationshipEvent, RelationshipProfile } from "../relationships/types";

interface Overview {
  profiles: RelationshipProfile[];
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [eventFilter, setEventFilter] = useState("");

  const load = async (): Promise<void> => {
    setError("");
    setOverview(await api("/api/relationships"));
  };

  useEffect(() => { void load(); }, []);

  const reset = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      setOverview(await api("/api/relationships/reset", {}));
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

  if (overview === null) return <div className="relationships-error">Loading Relationships Lab...</div>;

  return (
    <div className="relationships-shell">
      <aside>
        {error !== "" ? <div className="relationships-error">{error}</div> : null}
        <section className="relationships-panel">
          <div className="relationships-title"><span>Relationships</span><span>{overview.config.enabled ? "on" : "off"}</span></div>
          <div className="relationships-row"><div className="relationships-label">Post-reply pass</div><div className="relationships-value">main model</div></div>
          <div className="relationships-row"><div className="relationships-label">Max axis delta</div><div className="relationships-value">{overview.config.maxAxisDeltaPerSignal}</div></div>
          <div className="relationships-actions">
            <button className="btn danger" disabled={busy} onClick={() => void reset()}>Reset</button>
            <button className="btn" disabled={busy} onClick={() => void load()}>Refresh</button>
          </div>
        </section>
        <section className="relationships-panel">
          <div className="relationships-title"><span>Prompt Preview</span></div>
          <pre className="relationships-code">{overview.promptPreview}</pre>
        </section>
      </aside>

      <main className="relationships-main">
        <section>
          <div className="relationships-panel">
            <div className="relationships-title"><span>Profiles</span></div>
            <div className="relationships-list">
              {overview.profiles.map((profile) => (
                <article className="relationships-event" key={profile.userId}>
                  <div className="relationships-event-top"><span>{profile.userId}</span><span>{time(profile.updatedAt)}</span></div>
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
