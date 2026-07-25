/// <reference lib="dom" />

import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ManagementDirectory } from "./management";
import type {
  PromptInspection,
  PromptInspectionCatalogEntry,
  PromptInspectionDocument,
  PromptInspectionPhase,
  PromptScenarioId,
} from "../config/prompt-inspector";

type InspectorView = "selected" | "assembled" | "catalog";
type Provider = "openai-codex" | "openrouter";

const PHASE_LABELS: Record<PromptInspectionPhase, string> = {
  stable: "Stable prefix",
  volatile: "Runtime overlay",
  final: "Final action",
  pass: "Pass control",
};

async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, signal !== undefined ? { signal } : undefined);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body !== null && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function searchMatch(values: readonly string[], query: string): boolean {
  if (query === "") return true;
  const normalized = query.toLocaleLowerCase("en-US");
  return values.some((value) => value.toLocaleLowerCase("en-US").includes(normalized));
}

interface SourceCardProps {
  document: PromptInspectionDocument | PromptInspectionCatalogEntry;
  phase?: PromptInspectionPhase;
  reason?: string;
  role?: string;
  target?: string;
  cacheGroup?: string;
}

function SourceCard({ document, phase, reason, role, target, cacheGroup }: SourceCardProps) {
  const [open, setOpen] = useState(false);
  return (
    <article className={`pi-source-card pi-status-${document.status}`}>
      <button className="pi-source-summary" type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="pi-order-mark" aria-hidden="true">{open ? "−" : "+"}</span>
        <span className="pi-source-main">
          <span className="pi-source-path">{document.source}</span>
          <span className="pi-source-key">{document.groupId} / {document.key}</span>
        </span>
        <span className="pi-chip-row">
          {phase !== undefined ? <span className={`pi-chip pi-phase-${phase}`}>{PHASE_LABELS[phase]}</span> : null}
          <span className={`pi-chip pi-layer-${document.layer}`}>{document.layer}</span>
          <span className="pi-chip">{document.status}</span>
        </span>
        <span className="pi-source-size">{formatCount(document.chars)} ch</span>
      </button>
      {open ? (
        <div className="pi-source-detail">
          <div className="pi-source-meta">
            {reason !== undefined ? <span><b>Why</b>{reason}</span> : null}
            {role !== undefined ? <span><b>Role</b>{role}</span> : null}
            {target !== undefined ? <span><b>Target</b>{target}</span> : null}
            {cacheGroup !== undefined ? <span><b>Cache</b>{cacheGroup}</span> : null}
            <span><b>SHA-256</b>{document.sha256}</span>
          </div>
          {document.overriddenSources.length > 0 ? (
            <div className="pi-override">
              <strong>Overrides</strong>
              {document.overriddenSources.map((source) => <code key={source}>{source}</code>)}
            </div>
          ) : null}
          <pre className="pi-prompt-text">{document.text}</pre>
        </div>
      ) : null}
    </article>
  );
}

function EmptyState({ children }: { children: string }) {
  return <div className="pi-empty">{children}</div>;
}

function PromptInspector() {
  const [directory, setDirectory] = useState<ManagementDirectory>({ guilds: [], channels: [], users: [] });
  const [inspection, setInspection] = useState<PromptInspection | null>(null);
  const [scenario, setScenario] = useState<PromptScenarioId>("discord");
  const [provider, setProvider] = useState<Provider>("openai-codex");
  const [guildId, setGuildId] = useState("");
  const [view, setView] = useState<InspectorView>("selected");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void api<ManagementDirectory>("/api/management/directory")
      .then(setDirectory)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ scenario, provider });
    if (guildId !== "") params.set("guildId", guildId);
    setLoading(true);
    setError("");
    void api<PromptInspection>(`/api/management/prompts?${params.toString()}`, controller.signal)
      .then((next) => {
        setInspection(next);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      });
    return () => controller.abort();
  }, [guildId, provider, scenario]);

  const visibleDocuments = useMemo(() => {
    if (inspection === null) return [];
    return inspection.documents.filter((document) => searchMatch([
      document.source,
      document.groupId,
      document.key,
      document.reason,
      document.text,
      document.role ?? "",
      document.cacheGroup ?? "",
    ], query));
  }, [inspection, query]);

  const visibleCatalog = useMemo(() => {
    if (inspection === null) return [];
    return inspection.catalog.filter((document) => searchMatch([
      document.source,
      document.groupId,
      document.key,
      document.status,
      document.text,
    ], query));
  }, [inspection, query]);

  const phases = useMemo(() => {
    if (inspection === null) return [];
    return (["stable", "volatile", "final", "pass"] as const)
      .map((phase) => ({
        phase,
        count: inspection.documents.filter((document) => document.phase === phase).length,
      }))
      .filter((entry) => entry.count > 0);
  }, [inspection]);

  return (
    <div className="pi-shell">
      <style>{`
        .pi-shell{--pi-cyan:#55d6c2;--pi-blue:#69a7ff;--pi-violet:#a98cff;--pi-orange:#ffb45d;min-height:calc(100vh - 80px);max-width:1800px;margin:0 auto;color:var(--text)}
        .pi-header{display:grid;grid-template-columns:minmax(240px,1fr) auto;gap:1rem;align-items:end;margin-bottom:.85rem;padding:.25rem 0 .9rem;border-bottom:1px solid var(--border)}
        .pi-eyebrow{font:600 .6rem/1 var(--sans);letter-spacing:.2em;text-transform:uppercase;color:var(--pi-cyan)}
        .pi-title{margin:.32rem 0 .2rem;color:var(--text-bright);font:600 1.45rem/1.15 var(--sans);letter-spacing:-.02em}
        .pi-subtitle{max-width:740px;color:var(--text-dim);font:.7rem/1.5 var(--mono)}
        .pi-controls{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.5rem}.pi-control{display:grid;gap:.2rem}.pi-control span{font:600 .55rem/1 var(--sans);letter-spacing:.12em;text-transform:uppercase;color:var(--text-dim)}
        .pi-control select{min-width:180px;height:31px}.pi-control.provider select{min-width:150px}
        .pi-workbench{display:grid;grid-template-columns:245px minmax(0,1fr);gap:.85rem;align-items:start}
        .pi-scenario-rail{position:sticky;top:60px;max-height:calc(100vh - 80px);overflow:auto;border:1px solid var(--border);background:var(--surface)}
        .pi-rail-head{position:sticky;top:0;z-index:2;padding:.7rem .75rem;background:#0c0e0f;border-bottom:1px solid var(--border);font:600 .58rem/1 var(--sans);letter-spacing:.15em;text-transform:uppercase;color:var(--text-dim)}
        .pi-family{padding:.7rem .75rem .25rem;color:var(--text-dim);font:600 .55rem/1 var(--sans);letter-spacing:.12em;text-transform:uppercase}
        .pi-scenario{width:100%;display:grid;gap:.14rem;padding:.52rem .72rem;border:0;border-left:2px solid transparent;background:transparent;color:var(--text);text-align:left;cursor:pointer}
        .pi-scenario:hover{background:var(--surface-2)}.pi-scenario.active{border-left-color:var(--pi-cyan);background:linear-gradient(90deg,rgba(85,214,194,.1),transparent)}
        .pi-scenario strong{font:500 .67rem/1.25 var(--mono);color:var(--text-bright)}.pi-scenario span{font:.58rem/1.35 var(--sans);color:var(--text-dim)}
        .pi-main{min-width:0}.pi-overview{border:1px solid var(--border);background:linear-gradient(135deg,#111416,var(--surface) 60%);margin-bottom:.7rem}
        .pi-overview-top{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1rem;padding:.9rem 1rem}.pi-scenario-name{color:var(--text-bright);font:600 1.05rem/1.2 var(--sans)}
        .pi-scenario-desc{margin-top:.25rem;color:var(--text-dim);font:.68rem/1.45 var(--mono)}.pi-mode-stamp{align-self:start;border:1px solid var(--accent-dim);padding:.3rem .48rem;color:var(--pi-blue);font:.58rem/1 var(--mono);text-transform:uppercase}
        .pi-metrics{display:grid;grid-template-columns:repeat(5,minmax(90px,1fr));border-top:1px solid var(--border)}
        .pi-metric{padding:.65rem .8rem;border-right:1px solid var(--border)}.pi-metric:last-child{border-right:0}.pi-metric b{display:block;color:var(--text-bright);font:600 .86rem/1 var(--mono)}.pi-metric span{display:block;margin-top:.3rem;color:var(--text-dim);font:600 .52rem/1 var(--sans);letter-spacing:.11em;text-transform:uppercase}
        .pi-phase-track{display:flex;gap:2px;margin:.7rem 0}.pi-phase-segment{min-width:92px;display:flex;align-items:center;justify-content:space-between;gap:.6rem;padding:.45rem .6rem;border:1px solid var(--border);background:var(--surface);font:.58rem/1 var(--mono)}
        .pi-phase-segment b{font-weight:600}.pi-phase-stable{color:var(--pi-cyan)}.pi-phase-volatile{color:var(--pi-blue)}.pi-phase-final{color:var(--pi-orange)}.pi-phase-pass{color:var(--pi-violet)}
        .pi-toolbar{display:flex;align-items:center;gap:.45rem;margin-bottom:.55rem}.pi-view-tabs{display:flex;gap:2px}.pi-view-button{padding:.45rem .65rem;border:1px solid var(--border);background:var(--surface);color:var(--text-dim);font:600 .58rem/1 var(--sans);letter-spacing:.1em;text-transform:uppercase;cursor:pointer}
        .pi-view-button.active{border-color:var(--border-active);background:var(--surface-2);color:var(--text-bright)}.pi-search{margin-left:auto;min-width:280px;padding:.42rem .6rem;border:1px solid var(--border);background:var(--bg);color:var(--text);font:.66rem var(--mono);outline:none}.pi-search:focus{border-color:var(--accent)}
        .pi-source-list{display:grid;gap:3px}.pi-source-card{border:1px solid var(--border);background:var(--surface);border-left:2px solid var(--border-active)}
        .pi-status-generated{border-left-color:var(--pi-violet)}.pi-status-code{border-left-color:var(--pi-orange)}.pi-status-template{border-left-color:var(--pi-orange)}.pi-status-conditional{border-left-color:var(--pi-blue)}.pi-status-included{border-left-color:var(--pi-cyan)}
        .pi-source-summary{width:100%;display:grid;grid-template-columns:18px minmax(220px,1fr) auto 74px;gap:.6rem;align-items:center;padding:.56rem .65rem;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}
        .pi-source-summary:hover{background:rgba(255,255,255,.018)}.pi-order-mark{color:var(--text-dim);font-size:.85rem}.pi-source-main{min-width:0;display:grid;gap:.12rem}
        .pi-source-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-bright);font:500 .66rem/1.25 var(--mono)}.pi-source-key{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-dim);font:.56rem/1.2 var(--mono)}
        .pi-chip-row{display:flex;justify-content:flex-end;gap:.25rem;flex-wrap:wrap}.pi-chip{padding:.2rem .34rem;border:1px solid var(--border);color:var(--text-dim);font:500 .51rem/1 var(--mono);text-transform:uppercase}.pi-layer-profile{color:var(--pi-cyan)}.pi-layer-code{color:var(--pi-orange)}.pi-layer-generated{color:var(--pi-violet)}
        .pi-source-size{text-align:right;color:var(--text-dim);font:.56rem/1 var(--mono)}.pi-source-detail{border-top:1px solid var(--border);background:#0b0d0e}.pi-source-meta{display:flex;flex-wrap:wrap;gap:.4rem 1rem;padding:.55rem .75rem;border-bottom:1px solid var(--border)}
        .pi-source-meta span{display:flex;gap:.4rem;color:var(--text-dim);font:.55rem/1.35 var(--mono)}.pi-source-meta b{color:var(--text);font-weight:500}.pi-override{display:flex;flex-wrap:wrap;gap:.4rem;padding:.55rem .75rem;color:var(--text-dim);font:.56rem var(--mono)}.pi-override strong{color:var(--pi-orange);font-weight:500}.pi-override code{color:var(--text)}
        .pi-prompt-text,.pi-assembled-text{margin:0;padding:.8rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:#d6dce1;font:11px/1.62 var(--mono);tab-size:2}.pi-prompt-text{max-height:620px}
        .pi-dynamic{margin-top:.8rem;border:1px dashed var(--border-active);padding:.7rem .8rem}.pi-dynamic h3{margin:0 0 .5rem;color:var(--text-bright);font:600 .62rem/1 var(--sans);letter-spacing:.1em;text-transform:uppercase}.pi-dynamic li{margin:.18rem 0 .18rem 1.1rem;color:var(--text-dim);font:.62rem/1.45 var(--mono)}
        .pi-assembled{display:grid;gap:.5rem}.pi-assembled-block{border:1px solid var(--border);background:var(--surface)}.pi-assembled-head{display:flex;gap:.45rem;align-items:center;padding:.52rem .7rem;border-bottom:1px solid var(--border);color:var(--text-bright);font:600 .6rem/1 var(--sans);letter-spacing:.1em;text-transform:uppercase}.pi-assembled-head span:last-child{margin-left:auto;color:var(--text-dim);font-family:var(--mono);font-weight:400;letter-spacing:0;text-transform:none}
        .pi-empty{padding:2rem;border:1px dashed var(--border);color:var(--text-dim);text-align:center;font:.65rem var(--mono)}.pi-loading{opacity:.55;pointer-events:none}.pi-error{margin-bottom:.6rem;padding:.6rem .75rem;border:1px solid var(--red-dim);background:var(--red-dim);color:#ffb4b4;font:.64rem var(--mono)}
        @media(max-width:1050px){.pi-header{grid-template-columns:1fr}.pi-controls{justify-content:flex-start}.pi-workbench{grid-template-columns:1fr}.pi-scenario-rail{position:static;max-height:260px}.pi-metrics{grid-template-columns:repeat(3,1fr)}.pi-metric:nth-child(3){border-right:0}.pi-source-summary{grid-template-columns:18px minmax(180px,1fr) 70px}.pi-chip-row{display:none}}
        @media(max-width:620px){.pi-controls{display:grid;grid-template-columns:1fr}.pi-control select{max-width:none;width:100%}.pi-metrics{grid-template-columns:1fr 1fr}.pi-metric{border-bottom:1px solid var(--border)}.pi-toolbar{align-items:stretch;flex-direction:column}.pi-search{margin-left:0;min-width:0;width:100%}.pi-source-summary{grid-template-columns:18px minmax(0,1fr);}.pi-source-size{display:none}}
      `}</style>

      <header className="pi-header">
        <div>
          <div className="pi-eyebrow">Prompt cartography</div>
          <h1 className="pi-title">Effective instruction inspector</h1>
          <p className="pi-subtitle">Trace the exact documents, override chain, transport placement, and assembled text for every model call surface.</p>
        </div>
        <div className="pi-controls">
          <label className="pi-control">
            <span>Guild transport</span>
            <select value={guildId} onChange={(event) => setGuildId(event.currentTarget.value)}>
              <option value="">Profile default</option>
              {directory.guilds.map((guild) => <option key={guild.id} value={guild.id}>{guild.name}</option>)}
            </select>
          </label>
          <label className="pi-control provider">
            <span>Provider</span>
            <select
              value={inspection?.scenario.fixedProvider ?? provider}
              disabled={inspection?.scenario.fixedProvider !== undefined}
              onChange={(event) => setProvider(event.currentTarget.value as Provider)}
            >
              <option value="openai-codex">OpenAI Codex</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </label>
        </div>
      </header>

      {error !== "" ? <div className="pi-error">{error}</div> : null}

      <div className={`pi-workbench${loading ? " pi-loading" : ""}`}>
        <aside className="pi-scenario-rail">
          <div className="pi-rail-head">Call surfaces</div>
          {(["actor", "maintenance", "evaluator", "fallback", "generation"] as const).map((family) => {
            const scenarios = inspection?.scenarios.filter((entry) => entry.family === family) ?? [];
            if (scenarios.length === 0) return null;
            return (
              <section key={family}>
                <div className="pi-family">{family}</div>
                {scenarios.map((entry) => (
                  <button
                    className={`pi-scenario${entry.id === scenario ? " active" : ""}`}
                    type="button"
                    key={entry.id}
                    onClick={() => setScenario(entry.id)}
                  >
                    <strong>{entry.label}</strong>
                    <span>{entry.description}</span>
                  </button>
                ))}
              </section>
            );
          })}
        </aside>

        <main className="pi-main">
          {inspection !== null ? (
            <>
              <section className="pi-overview">
                <div className="pi-overview-top">
                  <div>
                    <div className="pi-scenario-name">{inspection.scenario.label}</div>
                    <div className="pi-scenario-desc">{inspection.scenario.description}</div>
                  </div>
                  <div className="pi-mode-stamp">{inspection.provider} · {inspection.transportMode}</div>
                </div>
                <div className="pi-metrics">
                  <div className="pi-metric"><b>{inspection.totals.selectedDocuments}</b><span>Selected docs</span></div>
                  <div className="pi-metric"><b>{formatCount(inspection.totals.selectedChars)}</b><span>Characters</span></div>
                  <div className="pi-metric"><b>≈{formatCount(inspection.totals.estimatedTokens)}</b><span>Tokens</span></div>
                  <div className="pi-metric"><b>{inspection.totals.catalogDocuments}</b><span>Catalog docs</span></div>
                  <div className="pi-metric"><b>{inspection.totals.overriddenDocuments}</b><span>Overridden</span></div>
                </div>
              </section>

              <div className="pi-phase-track" aria-label="Prompt phases">
                {phases.map(({ phase, count }) => (
                  <div className={`pi-phase-segment pi-phase-${phase}`} key={phase}>
                    <span>{PHASE_LABELS[phase]}</span><b>{count}</b>
                  </div>
                ))}
              </div>

              <div className="pi-toolbar">
                <div className="pi-view-tabs">
                  {(["selected", "assembled", "catalog"] as const).map((nextView) => (
                    <button className={`pi-view-button${view === nextView ? " active" : ""}`} type="button" key={nextView} onClick={() => setView(nextView)}>
                      {nextView}
                    </button>
                  ))}
                </div>
                {view !== "assembled" ? (
                  <input className="pi-search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Filter source, group, key, or text…" />
                ) : null}
              </div>

              {view === "selected" ? (
                <>
                  <div className="pi-source-list">
                    {visibleDocuments.map((document) => (
                      <SourceCard
                        key={`${document.order}:${document.source}`}
                        document={document}
                        phase={document.phase}
                        reason={document.reason}
                        role={document.role}
                        target={document.target}
                        cacheGroup={document.cacheGroup}
                      />
                    ))}
                    {visibleDocuments.length === 0 ? <EmptyState>No selected documents match this filter.</EmptyState> : null}
                  </div>
                  <section className="pi-dynamic">
                    <h3>Dynamic sections — present at runtime, not statically rendered here</h3>
                    <ul>{inspection.dynamicSections.map((section) => <li key={section}>{section}</li>)}</ul>
                  </section>
                </>
              ) : null}

              {view === "assembled" ? (
                <div className="pi-assembled">
                  {inspection.assembled.instructions !== "" ? (
                    <section className="pi-assembled-block">
                      <div className="pi-assembled-head"><strong>Instructions</strong><span>OpenAI Codex top-level instructions</span></div>
                      <pre className="pi-assembled-text">{inspection.assembled.instructions}</pre>
                    </section>
                  ) : null}
                  {inspection.assembled.input.map((block, index) => (
                    <section className="pi-assembled-block" key={`${index}:${block.sourceIds.join(":")}`}>
                      <div className="pi-assembled-head">
                        <strong>{String(index + 1).padStart(2, "0")} · {block.role} / {block.target}</strong>
                        <span>{block.phase}{block.cacheGroup !== undefined ? ` · cache ${block.cacheGroup}` : ""} · {block.sourceIds.length} source(s)</span>
                      </div>
                      <pre className="pi-assembled-text">{block.text}</pre>
                    </section>
                  ))}
                  {inspection.assembled.instructions === "" && inspection.assembled.input.length === 0 ? <EmptyState>No static assembled blocks exist for this pass.</EmptyState> : null}
                </div>
              ) : null}

              {view === "catalog" ? (
                <div className="pi-source-list">
                  {visibleCatalog.map((document, index) => <SourceCard key={`${index}:${document.groupId}:${document.source}`} document={document} />)}
                  {visibleCatalog.length === 0 ? <EmptyState>No catalog documents match this filter.</EmptyState> : null}
                </div>
              ) : null}
            </>
          ) : <EmptyState>{loading ? "Loading prompt map…" : "No prompt inspection is available."}</EmptyState>}
        </main>
      </div>
    </div>
  );
}

const root = document.getElementById("prompts-tab-root");
if (root !== null) createRoot(root).render(<PromptInspector />);
