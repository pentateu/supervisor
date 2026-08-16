import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, parseGraph } from "../api/endpoints";
import { useLive } from "../store/live-store";
import { useGraphLiveStates } from "../lib/use-graph-live";
import { AgentChip, WorkflowCanvas } from "../components/WorkflowCanvas";
import type {
  Agent,
  AgentMode,
  AgentState,
  GraphRecord,
  Metrics,
  MetricsTotals,
  NodeState,
  Triage,
  Workspace,
  WorkspaceState,
} from "../api/types";
import type { LiveState } from "../store/reduce";

function Metric({ label, value, est }: { label: string; value: string; est?: boolean }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">
        {value}
        {est ? " est." : ""}
      </span>
    </div>
  );
}

/** A live canvas for one installed graph (hook-safe child). Full-width, one
 * per workspace at a time (the workspace card tabs between them). Node states
 * load once over REST, then SSE bus events drive the canvas (B2 — no polls). */
function LiveGraph({ ws, graph, agents }: { ws: string; graph: GraphRecord; agents: Agent[] }) {
  const live = useLive();
  const parsed = useMemo(() => parseGraph(graph.data), [graph.data]);
  const { states, lastRun, idle, animatingEdges } = useGraphLiveStates(ws, parsed);
  const agentStates = agents.reduce<Record<string, AgentState>>((acc, a) => {
    acc[a.agent_id] = live.agentStates[ws]?.[a.agent_id] ?? a.state;
    return acc;
  }, {});
  return (
    <div className="ws-canvas">
      <a className="canvas-title" href={`#/graphs/${graph.id}`}>
        {graph.id}
      </a>
      <WorkflowCanvas
        graph={parsed}
        mode="live"
        nodeStates={states}
        agentStates={agentStates}
        idle={idle}
        lastRun={lastRun}
        animatingEdges={animatingEdges}
        onNodeClick={(n, agent) => {
          if (agent) window.location.hash = `#/workspaces/${ws}/agents/${agent}`;
          else void n;
        }}
      />
    </div>
  );
}

// --- Triage (B3) ------------------------------------------------------------

/** Plan §7.3 severity ladder: agents first, then node attention states. */
const TRIAGE_SEVERITY: Record<string, number> = {
  blocked_permission: 0,
  waiting_input: 1,
  needs_decision: 2,
  error: 3,
  failed: 4,
  blocked: 5,
  missing_role: 6,
};

const TRIAGE_AGENT_STATES: ReadonlySet<string> = new Set(["waiting_input", "blocked_permission", "error"]);
const TRIAGE_NODE_STATES: ReadonlySet<string> = new Set(["needs_decision", "failed", "blocked", "missing_role"]);

const TRIAGE_GLYPH: Record<string, string> = {
  blocked_permission: "⛔",
  waiting_input: "💬",
  needs_decision: "!",
  error: "✕",
  failed: "✕",
  blocked: "⛔",
  missing_role: "⚠",
};

export type TriageRow =
  | { kind: "agent"; ws: string; agent_id: string; state: AgentState; permission_id: string | null }
  | { kind: "node"; ws: string; graph_id: string; node_id: string; state: NodeState; error: string | null };

function rowKey(r: TriageRow): string {
  return r.kind === "agent" ? `agent/${r.ws}/${r.agent_id}` : `node/${r.ws}/${r.graph_id}/${r.node_id}`;
}

function rowLabel(r: TriageRow): string {
  return r.kind === "agent" ? r.agent_id : `${r.graph_id}/${r.node_id}`;
}

/** The triage strip's data: the one-time REST snapshot overlaid with SSE
 * state. The reducer is the authority for everything it has seen — a state
 * that recovered drops its row, a new attention state appears, and rows for
 * workspaces known to be off are dropped. No polling (plan §10). */
export function buildTriage(rest: Triage, live: LiveState): TriageRow[] {
  const rows = new Map<string, TriageRow>();
  for (const a of rest.agents) {
    if (TRIAGE_AGENT_STATES.has(a.state)) {
      rows.set(rowKey({ kind: "agent", ...a }), { kind: "agent", ...a });
    }
  }
  for (const n of rest.nodes) {
    if (TRIAGE_NODE_STATES.has(n.state)) {
      rows.set(rowKey({ kind: "node", ...n }), { kind: "node", ...n });
    }
  }
  for (const [ws, perAgent] of Object.entries(live.agentStates)) {
    for (const [agentId, state] of Object.entries(perAgent)) {
      const key = `agent/${ws}/${agentId}`;
      if (TRIAGE_AGENT_STATES.has(state)) {
        rows.set(key, { kind: "agent", ws, agent_id: agentId, state, permission_id: null });
      } else {
        rows.delete(key);
      }
    }
  }
  for (const [ws, perGraph] of Object.entries(live.nodeStates)) {
    for (const [graphId, perNode] of Object.entries(perGraph)) {
      for (const [nodeId, state] of Object.entries(perNode)) {
        const key = `node/${ws}/${graphId}/${nodeId}`;
        if (TRIAGE_NODE_STATES.has(state)) {
          rows.set(key, { kind: "node", ws, graph_id: graphId, node_id: nodeId, state, error: null });
        } else {
          rows.delete(key);
        }
      }
    }
  }
  const result = [...rows.values()].filter((r) => live.workspaceStates[r.ws] !== "off");
  result.sort((a, b) => {
    const bySeverity = (TRIAGE_SEVERITY[a.state] ?? 99) - (TRIAGE_SEVERITY[b.state] ?? 99);
    if (bySeverity !== 0) return bySeverity;
    if (a.ws !== b.ws) return a.ws < b.ws ? -1 : 1;
    const labelA = rowLabel(a);
    const labelB = rowLabel(b);
    if (labelA !== labelB) return labelA < labelB ? -1 : 1;
    return a.kind === b.kind ? 0 : a.kind === "agent" ? -1 : 1;
  });
  return result;
}

/** The pinned attention strip: glyph + label + ws per row; agent rows open the
 * agent dialog, node rows the graph. */
function TriageStrip({ rows }: { rows: TriageRow[] }) {
  if (rows.length === 0) return <p className="triage-empty dim">nothing needs attention</p>;
  return (
    <section className="triage-strip" aria-label="triage">
      {rows.map((r) => (
        <a
          key={rowKey(r)}
          className="triage-row"
          href={r.kind === "agent" ? `#/workspaces/${r.ws}/agents/${r.agent_id}` : `#/graphs/${r.graph_id}`}
        >
          <span className="triage-glyph" role="img" aria-label={r.state}>
            {TRIAGE_GLYPH[r.state] ?? "•"}
          </span>
          <span className="triage-label">{rowLabel(r)}</span>
          <span className="triage-ws dim">{r.ws}</span>
        </a>
      ))}
    </section>
  );
}

// --- Workspace cards (B3) ---------------------------------------------------

const FILTERS: Array<{ value: AgentMode | "all"; label: string }> = [
  { value: "all", label: "all" },
  { value: "foreground", label: "fg" },
  { value: "background", label: "bg" },
];

function WorkspaceCard({ ws, restState }: { ws: string; restState: WorkspaceState }) {
  const live = useLive();
  const [activeGraph, setActiveGraph] = useState<string | null>(null);
  const [filter, setFilter] = useState<AgentMode | "all">("all");
  const [startGraphId, setStartGraphId] = useState("");
  const [wsError, setWsError] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const { data: agents } = useQuery({
    queryKey: ["agents", ws],
    queryFn: () => api.agents(ws),
    refetchInterval: 3000,
  });
  const { data: graphs } = useQuery({ queryKey: ["graphs"], queryFn: api.graphs });
  const agentList = agents ?? [];
  const installed = graphs ?? [];
  // One process at a time: tabs when several are active, defaulting to the
  // first. If the selected graph vanishes, fall back to the first active one.
  const running = installed.filter((g) => g.active);
  const current = running.find((g) => g.id === activeGraph) ?? running[0];
  // The SSE workspace state wins over the REST snapshot (the reducer is the
  // authority); the snapshot is only the boot-time fallback.
  const state = live.workspaceStates[ws] ?? restState;
  const shown = agentList.filter((a) => filter === "all" || a.mode === filter);
  const triage = agentList.filter((a) => a.state === "waiting_input" || a.state === "blocked_permission");

  // I-28: lifecycle mutations must surface failures, not vanish.
  const toggle = async (next: "on" | "off") => {
    setWsError(null);
    try {
      if (next === "on") await api.workspaceOn(ws);
      else await api.workspaceOff(ws, true);
    } catch (e) {
      setWsError(`${next} failed: ${(e as Error).message}`);
    }
  };
  const attach = async (a: Agent) => {
    setAttachError(null);
    try {
      await api.attachAgent(ws, a.agent_id);
    } catch (e) {
      setAttachError(`attach ${a.agent_id} failed: ${(e as Error).message}`);
    }
  };
  const start = async () => {
    if (!startGraphId) return;
    setStartError(null);
    try {
      await api.startGraph(ws, startGraphId);
    } catch (e) {
      setStartError(`start ${startGraphId} failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className={`ws-card ws-${state}`}>
      <div className="ws-header">
        <a href={`#/workspaces/${ws}`} className="ws-name">
          {ws}
        </a>
        <span className="ws-state">{state}</span>
        {state === "off" ? (
          <button onClick={() => void toggle("on")}>on</button>
        ) : (
          <button onClick={() => void toggle("off")}>off</button>
        )}
      </div>
      {wsError && (
        <div className="ws-triage" role="alert">
          {wsError}
        </div>
      )}

      <div className="ws-filter" role="group" aria-label={`${ws} agent filter`}>
        {FILTERS.map((f) => (
          <button
            key={f.value}
            className={filter === f.value ? "active" : ""}
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="ws-agents">
        {shown.map((a) => {
          const liveState = live.agentStates[ws]?.[a.agent_id] ?? a.state;
          return (
            <div className="ws-agent-row" key={a.agent_id}>
              <a href={`#/workspaces/${ws}/agents/${a.agent_id}`}>
                <AgentChip agent={a.agent_id} state={liveState} />
              </a>
              <span className="ws-agent-state">{liveState}</span>
              <span className="ws-agent-depth dim">
                inbox {a.inbox_depth != null ? a.inbox_depth : "—"}
              </span>
              <a className="ws-agent-action" href={`#/workspaces/${ws}/agents/${a.agent_id}`}>
                message
              </a>
              <button className="ws-agent-action" onClick={() => void attach(a)}>
                attach
              </button>
            </div>
          );
        })}
        {shown.length === 0 && (
          <span className="dim">{filter === "all" ? "no agents configured" : `no ${filter} agents`}</span>
        )}
      </div>
      {attachError && (
        <div className="ws-triage" role="alert">
          {attachError}
        </div>
      )}
      {triage.length > 0 && <div className="ws-triage">⚠ {triage.length} awaiting input/approval</div>}

      {running.length > 1 && (
        <div className="graph-tabs" role="tablist" aria-label={`${ws} workflows`}>
          {running.map((g) => (
            <button
              key={g.id}
              role="tab"
              aria-selected={g.id === current?.id}
              className={`graph-tab${g.id === current?.id ? " active" : ""}`}
              onClick={() => setActiveGraph(g.id)}
            >
              {g.id}
            </button>
          ))}
        </div>
      )}
      {/* The canvas lives only while the workspace runs (plan §7.3); the
          hook's `idle` is for last-run emphasis, not for hiding. */}
      {state !== "off" && current && <LiveGraph key={current.id} ws={ws} graph={current} agents={agentList} />}
      {running.length === 0 && <p className="dim">no active graphs</p>}

      <div className="ws-start">
        <select
          aria-label="start workflow"
          value={startGraphId}
          onChange={(e) => setStartGraphId(e.target.value)}
        >
          <option value="">start workflow…</option>
          {installed.map((g) => (
            <option key={g.id} value={g.id}>
              {g.id}
            </option>
          ))}
        </select>
        <button disabled={!startGraphId} onClick={() => void start()}>
          start
        </button>
      </div>
      {startError && (
        <div className="ws-triage" role="alert">
          {startError}
        </div>
      )}
    </div>
  );
}

/** Collapsed list of off workspaces — name, state, and an `on` button each. */
function OffWorkspaces({ workspaces }: { workspaces: Workspace[] }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const turnOn = async (w: Workspace) => {
    setErrors((e) => ({ ...e, [w.id]: "" }));
    try {
      await api.workspaceOn(w.id);
    } catch (e) {
      setErrors((prev) => ({ ...prev, [w.id]: `on failed: ${(e as Error).message}` }));
    }
  };
  if (workspaces.length === 0) return null;
  return (
    <details className="off-workspaces">
      <summary>off workspaces</summary>
      {workspaces.map((w) => (
        <div className="off-ws" key={w.id}>
          <span className="ws-name">{w.id}</span>
          <span className="ws-state">off</span>
          <button onClick={() => void turnOn(w)}>on</button>
          {errors[w.id] && (
            <span className="ws-triage" role="alert">
              {errors[w.id]}
            </span>
          )}
        </div>
      ))}
    </details>
  );
}

// --- Stats (B3) -------------------------------------------------------------

/** Hand-rolled SVG bars over the daemon's 1h buckets — no chart library. */
function TimeSeriesChart({ series }: { series: Metrics["time_series"] }) {
  const W = 640;
  const H = 120;
  const PAD = 2;
  const max = Math.max(1, ...series.map((s) => s.messages));
  const bw = series.length > 0 ? W / series.length : W;
  return (
    <svg className="time-series" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="messages per hour">
      {series.map((s, i) => {
        const h = Math.max(1, (s.messages / max) * (H - 16));
        const x = i * bw;
        return (
          <g key={s.ts}>
            <rect x={x + PAD} y={H - 8 - h} width={Math.max(bw - PAD * 2, 2)} height={h} className="ts-bar">
              <title>{`${s.ts}: ${s.messages} messages`}</title>
            </rect>
            {i % 4 === 0 && (
              <text x={x + bw / 2} y={H - 1} className="ts-label" textAnchor="middle">
                {s.ts.slice(11, 16)}
              </text>
            )}
          </g>
        );
      })}
      <line x1={0} y1={H - 8} x2={W} y2={H - 8} className="ts-axis" />
    </svg>
  );
}

function cost(cents: number | null | undefined): string {
  return cents != null ? `$${(cents / 100).toFixed(2)}` : "—";
}

function MetricsTable({ rows }: { rows: Array<[string, Partial<MetricsTotals>]> }) {
  if (rows.length === 0) return <p className="dim">no data yet</p>;
  return (
    <table className="stats-table">
      <thead>
        <tr>
          <th>id</th>
          <th>messages</th>
          <th>errors</th>
          <th>decisions</th>
          <th>nodes done</th>
          <th>cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([id, m]) => (
          <tr key={id}>
            <td>{id}</td>
            <td>{m.messages_delivered ?? "—"}</td>
            <td>{m.errors ?? "—"}</td>
            <td>{m.decisions ?? "—"}</td>
            <td>{m.nodes_done ?? "—"}</td>
            <td>{cost(m.cost_cents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatsTab() {
  const { data: metrics } = useQuery({
    queryKey: ["metrics"],
    queryFn: () => api.metrics(),
    refetchInterval: 5000,
  });
  const totals = metrics?.totals;
  const series = metrics?.time_series ?? [];
  const perWs = Object.entries(metrics?.per_workspace ?? {});
  const perAgent = Object.entries(metrics?.per_agent ?? {});

  return (
    <section className="stats">
      <div className="metrics-strip">
        <Metric label="messages" value={String(totals?.messages_delivered ?? "—")} />
        <Metric label="errors" value={String(totals?.errors ?? "—")} />
        <Metric label="decisions" value={String(totals?.decisions ?? "—")} />
        <Metric label="nodes done" value={String(totals?.nodes_done ?? "—")} />
        <Metric label="tokens" value={String(totals?.tokens ?? "—")} />
        <Metric label="est. cost" value={cost(totals?.cost_cents)} est />
      </div>

      <h2>messages per hour</h2>
      <TimeSeriesChart series={series} />
      <h2>per workspace</h2>
      <MetricsTable rows={perWs} />
      <h2>per agent</h2>
      <MetricsTable rows={perAgent} />

      <div className="stats-shortcuts">
        <a href="#/graphs">Graphs</a>
        <a href="#/rules">Rules</a>
        <a href="#/decisions">Decisions</a>
        <a href="#/intake">Intake</a>
      </div>
    </section>
  );
}

// --- Tab shell (B3) ---------------------------------------------------------

export function Dashboard({ ws }: { ws?: string }) {
  const [tab, setTab] = useState<"live" | "stats">("live");
  const live = useLive();
  const [resumeError, setResumeError] = useState<string | null>(null);
  const { data: triage } = useQuery({ queryKey: ["triage"], queryFn: api.triage });
  const { data: workspaces } = useQuery({
    queryKey: ["workspaces"],
    queryFn: api.workspaces,
    refetchInterval: 3000,
  });
  // The badge on the Live tab is the current triage row count (plan §7.3).
  const rows = useMemo(() => buildTriage(triage ?? { agents: [], nodes: [] }, live), [triage, live]);

  const resume = async () => {
    setResumeError(null);
    try {
      await api.resume();
    } catch (e) {
      setResumeError(`resume failed: ${(e as Error).message}`);
    }
  };

  const visible = (workspaces ?? []).filter((w) => !ws || w.id === ws);
  const runningWs = visible.filter((w) => (live.workspaceStates[w.id] ?? w.state) !== "off");
  const offWs = visible.filter((w) => (live.workspaceStates[w.id] ?? w.state) === "off");

  return (
    <div className="page">
      <div className="dash-header">
        <div className="dash-tabs" role="tablist" aria-label="dashboard">
          <button
            role="tab"
            aria-selected={tab === "live"}
            className={`dash-tab${tab === "live" ? " active" : ""}`}
            onClick={() => setTab("live")}
          >
            Live <span className="tab-badge">{rows.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === "stats"}
            className={`dash-tab${tab === "stats" ? " active" : ""}`}
            onClick={() => setTab("stats")}
          >
            Stats
          </button>
        </div>
        <button onClick={() => void resume()}>resume</button>
      </div>
      {resumeError && (
        <div className="ws-triage" role="alert">
          {resumeError}
        </div>
      )}

      {tab === "live" && (
        <>
          <TriageStrip rows={rows} />
          {visible.length === 0 && (
            <p className="empty">
              No workspaces yet — run <code>supervisor add &lt;path&gt;</code>.
            </p>
          )}
          <div className="ws-grid">
            {runningWs.map((w) => (
              <WorkspaceCard key={w.id} ws={w.id} restState={w.state} />
            ))}
          </div>
          <OffWorkspaces workspaces={offWs} />
        </>
      )}
      {tab === "stats" && <StatsTab />}
    </div>
  );
}