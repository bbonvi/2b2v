import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { sortVoiceHistoryNewestFirst } from "../voice/history.ts";
import type { VoiceHistoryRecord } from "../voice/repository.ts";

interface Transcript {
  id: number;
  username: string;
  userId: string;
  normalizedText: string;
  startedAt: number;
  source: string;
  synthetic: boolean;
}

interface Instruction {
  id: string;
  status: string;
  instruction: string;
  requesterUsername: string;
  createdAt: number;
}

interface Snapshot {
  enabled: boolean;
  state: string;
  sessionId?: string;
  guildId?: string;
  guildName?: string;
  channelId?: string;
  channelName?: string;
  participants: Array<{ userId: string; username: string }>;
  speakingUserIds: string[];
  currentOutput?: { turnId: string; plannedText: string; audibleText: string; interrupted: boolean };
  lastError?: string;
  dependencyReport: string;
  transcript: Transcript[];
  history: VoiceHistoryRecord[];
  instructions: Instruction[];
}

interface VoiceTurnTrigger {
  type: "voice_turn";
  sessionId: string;
  segmentId: number;
  instructionId?: string;
}

interface RequestSummary {
  requestId: string;
  authorUsername: string;
  trigger: unknown;
  status?: "active";
  llmCallCount: number;
  timestamp: string;
}

interface LlmCall {
  id?: string;
  status?: "running" | "completed" | "error";
  model: string;
  startedAt?: string;
  durationMs?: number;
  requestPayload?: unknown;
}

interface RequestDetail {
  requestId: string;
  authorUsername: string;
  trigger: unknown;
  status?: "active";
  timestamp: string;
  llmCalls: LlmCall[];
}

interface VoiceChannel {
  id: string;
  name: string;
  guildId: string;
  guildName: string;
  members: string[];
}

async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new ApiError(result.error ?? `Request failed (${response.status})`, response.status);
  return result;
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function time(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function voiceTurnTrigger(value: unknown): VoiceTurnTrigger | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const trigger = value as Record<string, unknown>;
  if (
    trigger.type !== "voice_turn"
    || typeof trigger.sessionId !== "string"
    || typeof trigger.segmentId !== "number"
  ) return null;
  return {
    type: "voice_turn",
    sessionId: trigger.sessionId,
    segmentId: trigger.segmentId,
    ...(typeof trigger.instructionId === "string" ? { instructionId: trigger.instructionId } : {}),
  };
}

function VoiceTab(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [channels, setChannels] = useState<VoiceChannel[]>([]);
  const [channelId, setChannelId] = useState("");
  const [injection, setInjection] = useState("");
  const [error, setError] = useState("");
  const [contextTurns, setContextTurns] = useState<RequestSummary[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState("");
  const [selectedRequest, setSelectedRequest] = useState<RequestDetail | null>(null);
  const [selectedCallId, setSelectedCallId] = useState("");
  const [contextError, setContextError] = useState("");
  const busy = snapshot?.state === "connecting" || snapshot?.state === "leaving";

  useEffect(() => {
    void Promise.all([
      api<Snapshot>("/api/voice").then(setSnapshot),
      api<{ channels: VoiceChannel[] }>("/api/voice/channels").then((value) => setChannels(value.channels)),
    ]).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    const events = new EventSource("/api/voice/live");
    events.onmessage = (event) => {
      try {
        if (typeof event.data !== "string") throw new Error("Voice event data was not text");
        setSnapshot(JSON.parse(event.data) as Snapshot);
      } catch {
        setError("Invalid live voice event");
      }
    };
    events.onerror = () => setError("Live voice event stream disconnected; reconnecting.");
    return () => events.close();
  }, []);

  useEffect(() => {
    const activeChannelId = snapshot?.channelId;
    const activeSessionId = snapshot?.sessionId;
    if (activeChannelId === undefined || activeSessionId === undefined) {
      setContextTurns([]);
      setSelectedRequestId("");
      setSelectedRequest(null);
      return;
    }
    const refresh = async (): Promise<void> => {
      const summaries = await api<RequestSummary[]>(`/api/logs?channelId=${encodeURIComponent(activeChannelId)}`);
      const voiceTurns = summaries.filter((summary) =>
        voiceTurnTrigger(summary.trigger)?.sessionId === activeSessionId
      );
      setContextTurns(voiceTurns);
      setSelectedRequestId((current) =>
        current !== "" && voiceTurns.some((turn) => turn.requestId === current)
          ? current
          : voiceTurns[0]?.requestId ?? ""
      );
      setContextError("");
    };
    const handleError = (reason: unknown): void => {
      setContextError(reason instanceof Error ? reason.message : String(reason));
    };
    void refresh().catch(handleError);
    const timer = setInterval(() => {
      void refresh().catch(handleError);
    }, 2_000);
    return () => clearInterval(timer);
  }, [snapshot?.channelId, snapshot?.sessionId]);

  const selectedSummary = contextTurns.find((turn) => turn.requestId === selectedRequestId);
  useEffect(() => {
    if (selectedRequestId === "") {
      setSelectedRequest(null);
      return;
    }
    const refresh = async (): Promise<void> => {
      setSelectedRequest(await api<RequestDetail>(`/api/logs/${encodeURIComponent(selectedRequestId)}`));
      setContextError("");
    };
    const handleError = (reason: unknown): void => {
      if (reason instanceof ApiError && reason.status === 404) {
        setSelectedRequest(null);
        setSelectedRequestId("");
        setContextError("");
        return;
      }
      setContextError(reason instanceof Error ? reason.message : String(reason));
    };
    void refresh().catch(handleError);
    if (selectedSummary?.status !== "active") return;
    const timer = setInterval(() => {
      void refresh().catch(handleError);
    }, 1_000);
    return () => clearInterval(timer);
  }, [selectedRequestId, selectedSummary?.status, selectedSummary?.llmCallCount]);

  useEffect(() => {
    const calls = selectedRequest?.llmCalls ?? [];
    setSelectedCallId((current) =>
      current !== "" && calls.some((call) => call.id === current)
        ? current
        : calls[0]?.id ?? ""
    );
  }, [selectedRequest]);

  const selected = useMemo(() => channels.find((channel) => channel.id === channelId), [channels, channelId]);
  const selectedCall = selectedRequest?.llmCalls.find((call) => call.id === selectedCallId);
  const displayHistory = sortVoiceHistoryNewestFirst(snapshot?.history ?? []);
  const rawPayload = selectedCall?.requestPayload === undefined
    ? ""
    : JSON.stringify(selectedCall.requestPayload, null, 2);
  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setError("");
    try {
      await action();
      setSnapshot(await api<Snapshot>("/api/voice"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return <div className="voice-console">
    <style>{`
      .voice-console{--v-accent:#d6f26b;--v-cyan:#74d9d2;display:grid;gap:16px;padding-bottom:32px}
      .voice-hero{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(280px,.6fr);gap:14px}
      .voice-panel{background:linear-gradient(145deg,rgba(25,29,31,.96),rgba(15,18,20,.98));border:1px solid var(--border);border-radius:10px;padding:16px;box-shadow:0 14px 36px rgba(0,0,0,.22)}
      .voice-kicker{font:600 10px/1.2 "JetBrains Mono",monospace;text-transform:uppercase;letter-spacing:.15em;color:var(--text-dim)}
      .voice-state{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-top:10px}
      .voice-state h2{margin:0;font:500 clamp(28px,4vw,46px)/.95 "IBM Plex Sans",sans-serif;letter-spacing:-.04em;text-transform:capitalize}
      .voice-dot{width:10px;height:10px;border-radius:50%;background:var(--v-accent);box-shadow:0 0 18px var(--v-accent)}
      .voice-location{margin-top:12px;color:var(--text-dim);font-size:12px}
      .voice-controls{display:grid;gap:10px}
      .voice-controls select,.voice-controls textarea{width:100%;box-sizing:border-box;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:9px;font:12px "JetBrains Mono",monospace}
      .voice-controls textarea{min-height:74px;resize:vertical}
      .voice-actions{display:flex;gap:8px;flex-wrap:wrap}
      .voice-actions button{background:transparent;color:var(--text);border:1px solid var(--border-active);border-radius:5px;padding:8px 12px;font:600 10px "JetBrains Mono",monospace;text-transform:uppercase;letter-spacing:.08em;cursor:pointer}
      .voice-actions button.primary{background:var(--v-accent);border-color:var(--v-accent);color:#15170e}
      .voice-actions button:disabled{opacity:.35;cursor:not-allowed}
      .voice-error{background:rgba(226,91,91,.09);color:#ffaaaa;border-left:3px solid #e25b5b;padding:9px 11px;font-size:12px}
      .voice-grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(270px,.6fr);gap:14px}
      .voice-title{display:flex;justify-content:space-between;gap:12px;margin-bottom:12px;font:600 10px "JetBrains Mono",monospace;text-transform:uppercase;letter-spacing:.12em;color:var(--text-dim)}
      .voice-feed{display:grid;gap:7px;max-height:580px;overflow:auto}
      .voice-line{display:grid;grid-template-columns:72px 132px minmax(0,1fr);gap:10px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.055);font-size:12px}
      .voice-line time{color:var(--text-dim);font-family:"JetBrains Mono",monospace}
      .voice-speaker{color:var(--v-cyan);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .voice-line.synthetic .voice-speaker{color:#d9a6ff}
      .voice-line.assistant .voice-speaker{color:var(--v-accent)}
      .voice-line.interrupted{opacity:.72}
      .voice-presence{display:grid;grid-template-columns:72px minmax(0,1fr);gap:10px;padding:7px 0;color:var(--text-dim);font:10px "JetBrains Mono",monospace}
      .voice-side{display:grid;gap:14px;align-content:start}
      .voice-chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}
      .voice-chip{border:1px solid var(--border);border-radius:999px;padding:5px 8px;font:10px "JetBrains Mono",monospace}
      .voice-chip.speaking{border-color:var(--v-accent);color:var(--v-accent)}
      .voice-output{white-space:pre-wrap;font-size:12px;line-height:1.55}
      .voice-output strong{display:block;color:var(--v-accent);margin-bottom:5px;font:600 10px "JetBrains Mono",monospace;text-transform:uppercase}
      .voice-instruction{padding:9px 0;border-bottom:1px solid rgba(255,255,255,.055);font-size:11px;line-height:1.5}
      .voice-instruction code{color:var(--v-cyan)}
      .voice-deps{max-height:240px;overflow:auto;white-space:pre-wrap;color:var(--text-dim);font:10px/1.5 "JetBrains Mono",monospace}
      .voice-context{display:grid;gap:12px}
      .voice-context-controls{display:grid;grid-template-columns:minmax(220px,1fr) minmax(180px,.55fr) auto;gap:8px}
      .voice-context-controls select{min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;font:11px "JetBrains Mono",monospace}
      .voice-context-controls button{background:transparent;color:var(--v-accent);border:1px solid var(--border-active);border-radius:5px;padding:8px 11px;font:600 10px "JetBrains Mono",monospace;text-transform:uppercase;letter-spacing:.08em;cursor:pointer}
      .voice-context-controls button:disabled{opacity:.35;cursor:not-allowed}
      .voice-context-meta{display:flex;gap:12px;flex-wrap:wrap;color:var(--text-dim);font:10px "JetBrains Mono",monospace}
      .voice-raw{max-height:720px;overflow:auto;margin:0;padding:14px;background:#0b0d0e;border-radius:7px;white-space:pre-wrap;overflow-wrap:anywhere;color:#d9e1dc;font:10px/1.55 "JetBrains Mono",monospace;tab-size:2}
      @media(max-width:900px){.voice-hero,.voice-grid{grid-template-columns:1fr}.voice-line{grid-template-columns:58px 100px minmax(0,1fr)}}
      @media(max-width:720px){.voice-context-controls{grid-template-columns:1fr}.voice-context-controls button{justify-self:start}}
    `}</style>
    {error !== "" ? <div className="voice-error">{error}</div> : null}
    <section className="voice-hero">
      <div className="voice-panel">
        <div className="voice-kicker">Live Discord voice / single presence</div>
        <div className="voice-state">
          <h2>{snapshot?.state ?? "loading"}</h2>
          <span className="voice-dot" style={{ opacity: snapshot?.state === "active" ? 1 : .25 }} />
        </div>
        <div className="voice-location">
          {snapshot?.channelName !== undefined
            ? `${snapshot.guildName} / ${snapshot.channelName} · ${snapshot.sessionId}`
            : "No active room"}
        </div>
        <div className="voice-chips">
          {(snapshot?.participants ?? []).map((participant) =>
            <span className={`voice-chip ${snapshot?.speakingUserIds.includes(participant.userId) === true ? "speaking" : ""}`} key={participant.userId}>
              @{participant.username}
            </span>)}
        </div>
      </div>
      <div className="voice-panel voice-controls">
        <div className="voice-title"><span>Transport controls</span><span>{channels.length} rooms</span></div>
        <select value={channelId} onChange={(event) => setChannelId(event.currentTarget.value)}>
          <option value="">Select voice channel</option>
          {channels.map((channel) => <option key={channel.id} value={channel.id}>
            {channel.guildName} / {channel.name} ({channel.members.length})
          </option>)}
        </select>
        <div className="voice-actions">
          <button className="primary" disabled={busy || channelId === "" || snapshot?.state === "active"} onClick={() => void act(() => api("/api/voice/join", { channelId }))}>Join</button>
          <button disabled={busy || snapshot?.state !== "active"} onClick={() => void act(() => api("/api/voice/leave", {}))}>Leave</button>
        </div>
        <textarea value={injection} onChange={(event) => setInjection(event.currentTarget.value)} placeholder="Synthetic spoken line…" />
        <div className="voice-actions">
          <button disabled={snapshot?.state !== "active" || injection.trim() === ""} onClick={() => void act(async () => {
            await api("/api/voice/inject", { text: injection });
            setInjection("");
          })}>Inject line</button>
        </div>
        {selected !== undefined ? <div className="voice-kicker">Target · {selected.id}</div> : null}
      </div>
    </section>
    <section className="voice-grid">
      <div className="voice-panel">
        <div className="voice-title"><span>Room history</span><span>{snapshot?.history.length ?? 0} events</span></div>
        <div className="voice-feed">
          {displayHistory.map((entry) => entry.kind === "transcript"
            ? <div className={`voice-line ${entry.transcript.synthetic ? "synthetic" : ""}`} key={`transcript:${entry.transcript.id}`}>
              <time>{time(entry.startedAt)}</time>
              <span className="voice-speaker">@{entry.transcript.username}</span>
              <span>{entry.transcript.normalizedText}</span>
            </div>
            : entry.kind === "output"
              ? <div className={`voice-line assistant ${entry.output.cutoff ? "interrupted" : ""}`} key={`output:${entry.output.id}`}>
              <time>{time(entry.startedAt)}</time>
              <span className="voice-speaker">2B{entry.output.cutoff ? " · cut off" : ""}</span>
              <span>{entry.output.audibleText}</span>
              </div>
              : <div className="voice-presence" key={`presence:${entry.presence.sessionId}:${entry.startedAt}:${entry.presence.userId ?? "2b"}:${entry.presence.action}`}>
                <time>{time(entry.startedAt)}</time>
                <span>{entry.presence.actor === "2b"
                  ? `2B ${entry.presence.action === "joined"
                    ? "joined the voice channel"
                    : entry.presence.action === "disconnected"
                      ? "disconnected during an unclean shutdown"
                      : "left the voice channel"}`
                  : `@${entry.presence.username ?? "unknown"} ${entry.presence.action === "present" ? "was already present" : `${entry.presence.action} the voice channel`}`}
                </span>
              </div>)}
          {snapshot?.history.length === 0 ? <div className="voice-kicker">Nothing finalized yet.</div> : null}
        </div>
      </div>
      <aside className="voice-side">
        <div className="voice-panel">
          <div className="voice-title"><span>Current output</span><span>{snapshot?.currentOutput?.interrupted === true ? "cut off" : "stream"}</span></div>
          <div className="voice-output"><strong>Audible</strong>{snapshot?.currentOutput?.audibleText !== undefined && snapshot.currentOutput.audibleText !== "" ? snapshot.currentOutput.audibleText : "—"}</div>
          <div className="voice-output" style={{ marginTop: 12 }}><strong>Planned</strong>{snapshot?.currentOutput?.plannedText !== undefined && snapshot.currentOutput.plannedText !== "" ? snapshot.currentOutput.plannedText : "—"}</div>
        </div>
        <div className="voice-panel">
          <div className="voice-title"><span>Open instructions</span><span>{snapshot?.instructions.length ?? 0}</span></div>
          {(snapshot?.instructions ?? []).map((item) => <div className="voice-instruction" key={item.id}>
            <code>{item.status} · {item.id.slice(0, 8)}</code><br />@{item.requesterUsername}: {item.instruction}
          </div>)}
        </div>
        <div className="voice-panel">
          <div className="voice-title"><span>Dependency health</span><span>DAVE / Opus / FFmpeg</span></div>
          <pre className="voice-deps">{snapshot?.dependencyReport ?? "Loading…"}</pre>
        </div>
      </aside>
    </section>
    <section className="voice-panel voice-context">
      <div className="voice-title"><span>Raw Luna context</span><span>Exact request payload</span></div>
      <div className="voice-context-controls">
        <select value={selectedRequestId} onChange={(event) => setSelectedRequestId(event.currentTarget.value)}>
          <option value="">No voice turn selected</option>
          {contextTurns.map((turn) => {
            const trigger = voiceTurnTrigger(turn.trigger);
            return <option key={turn.requestId} value={turn.requestId}>
              {new Date(turn.timestamp).toLocaleTimeString()} · segment {trigger?.segmentId ?? "?"} · @{turn.authorUsername}{turn.status === "active" ? " · live" : ""}
            </option>;
          })}
        </select>
        <select value={selectedCallId} onChange={(event) => setSelectedCallId(event.currentTarget.value)} disabled={(selectedRequest?.llmCalls.length ?? 0) === 0}>
          <option value="">No model request</option>
          {(selectedRequest?.llmCalls ?? []).map((call, index) => <option key={call.id ?? index} value={call.id ?? ""}>
            {index + 1} · {call.model} · {call.status ?? "unknown"}
          </option>)}
        </select>
        <button disabled={rawPayload === ""} onClick={() => {
          if (rawPayload !== "") void navigator.clipboard.writeText(rawPayload);
        }}>Copy JSON</button>
      </div>
      <div className="voice-context-meta">
        <span>request {selectedRequestId === "" ? "—" : selectedRequestId}</span>
        <span>model {selectedCall?.model ?? "—"}</span>
        <span>duration {selectedCall?.durationMs !== undefined ? `${selectedCall.durationMs} ms` : "—"}</span>
        <span>{selectedCall?.status ?? selectedSummary?.status ?? "idle"}</span>
        {contextError !== "" ? <span style={{ color: "#ffaaaa" }}>{contextError}</span> : null}
      </div>
      <pre className="voice-raw">{rawPayload !== ""
        ? rawPayload
        : contextError !== ""
          ? "Context inspector is temporarily unavailable."
          : "The exact outbound Luna payload will appear when a live voice model request starts."}</pre>
    </section>
  </div>;
}

const root = document.getElementById("voice-tab-root");
if (root !== null) createRoot(root).render(<VoiceTab />);
