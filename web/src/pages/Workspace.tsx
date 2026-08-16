// B4: the real workspace detail page (route #/workspaces/:ws).
//
// Sections (plan §7.4): lifecycle controls (on / off graceful / resume) with
// I-28 error surfacing; the agent grid with the page-level fg/bg segmented
// filter; a per-agent 24h cost mini-chart (hand-rolled SVG bars, 24 buckets
// × 1h, from `GET /api/v1/usage?ws=&agent=&since=` — no chart library); and
// installed-graph canvases fed by the B2 live hook (running graphs live,
// completed ones at low emphasis via the `idle` + `lastRun` props).
//
// No polling: node states and workspace/agent states come from the SSE
// reducer (plan §10); REST data loads once (or on the B3 card interval for
// the agent list) and is overlaid by live state.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, parseGraph } from "../api/endpoints";
import { useLive } from "../store/live-store";
import { useGraphLiveStates } from "../lib/use-graph-live";
import { AgentChip, WorkflowCanvas } from "../components/WorkflowCanvas";
import type { Agent, AgentMode, AgentState, GraphRecord, UsageRow } from "../api/types";

const HOUR_MS = 3_600_000;
const BUCKETS = 24;

export interface UsageBucket {
  /** UTC hour label of the bucket start, e.g. "09:00". */
  hour: string;
  /** Summed cost_cents of the bucket — null when the bucket has no rows or
   *  any of its rows has an unknown model cost (never 0, plan §7.4). */
  cents: number | null;
}

/** Fold usage rows into the 24 hourly buckets ending at `now`. Rows outside
 * the window are dropped; a bucket with no rows or with any null-cost row is
 * reported as unknown (the UI renders it as an empty bar + "—"). Pure and
 * timezone-independent (epoch hours, UTC labels). */
export function bucketUsage(rows: UsageRow[], now: Date): UsageBucket[] {
  const endHour = Math.floor(now.getTime() / HOUR_MS);
  const firstHour = endHour - (BUCKETS - 1);
  const sum = new Array<number>(BUCKETS).fill(0);
  const seen = new Array<boolean>(BUCKETS).fill(false);
  const unknown = new Array<boolean>(BUCKETS).fill(false);
  for (const row of rows) {
    const idx = Math.floor(new Date(row.ts).getTime() / HOUR_MS) - firstHour;
    if (!Number.isFinite(idx) || idx < 0 || idx >= BUCKETS) continue;
    seen[idx] = true;
    if (row.cost_cents == null) {
      unknown[idx] = true;
    } else if (!unknown[idx]) {
      sum[idx] += row.cost_cents;
    }
  }
  return Array.from({ length: BUCKETS }, (_, i) => ({
    hour: new Date((firstHour + i) * HOUR_MS).toISOString().slice(11, 16),
    cents: seen[i] && !unknown[i] ? sum[i] : null,
  }));
}

/** Hand-rolled SVG bars over the daemon's usage rows — no chart library.
 * Null-cost buckets render an empty bar whose tooltip reads "—" (an unknown
 * model cost is never shown as 0). */
function CostChart({ rows }: { rows: UsageRow[] }) {
  const buckets = useMemo(() => bucketUsage(rows, new Date()), [rows]);
  const W = 240;
  const H = 40;
  const PAD = 1;
  const max = Math.max(1, ...buckets.map((b) => b.cents ?? 0));
  const bw = W / buckets.length;
  return (
    <span className="cost-chart-wrap">
      <svg className="cost-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="24h est. cost per hour">
        {buckets.map((b, i) => {
          const cents = b.cents;
          const h = cents != null ? Math.max(1, (cents / max) * (H - 8)) : 0;
          const x = i * bw;
          return (
            <rect key={b.hour} className="ts-bar" x={x + PAD} y={H - 8 - h} width={Math.max(bw - PAD * 2, 2)} height={h}>
              <title>{`${b.hour}: ${cents != null ? `${cents}¢` : "—"}`}</title>
            </rect>
          );
        })}
        <line x1={0} y1={H - 8} x2={W} y2={H - 8} className="ts-axis" />
      </svg>
      <span className="dim">est.</span>
    </span>
  );
}

/** One agent row: chip link to the dialog, live state, inbox depth, and the
 *  per-agent 24h cost chart (hook-safe child — each row owns its usage query). */
function AgentRow({ ws, agent }: { ws: string; agent: Agent }) {
  const live = useLive();
  const { data } = useQuery({
    queryKey: ["usage", ws, agent.agent_id],
    queryFn: () => api.usage({ ws, agent: agent.agent_id, since: new Date(Date.now() - BUCKETS * HOUR_MS).toISOString() }),
  });
  const liveState = live.agentStates[ws]?.[agent.agent_id] ?? agent.state;
  return (
    <div className="ws-agent-row" data-mode={agent.mode}>
      <a href={`#/workspaces/${ws}/agents/${agent.agent_id}`}>
        <AgentChip agent={agent.agent_id} state={liveState} />
      </a>
      <span className="ws-agent-state">{liveState}</span>
      <span className="ws-agent-depth dim">inbox {agent.inbox_depth != null ? agent.inbox_depth : "—"}</span>
      <CostChart rows={data?.rows ?? []} />
    </div>
  );
}

const FILTERS: Array<{ value: AgentMode | "all"; label: string }> = [
  { value: "all", label: "all" },
  { value: "foreground", label: "fg" },
  { value: "background", label: "bg" },
];

/** A live canvas for one installed graph (hook-safe child). Node states load
 * once over REST, then SSE bus events drive the canvas (B2 — no polls). */
function GraphCanvas({ ws, graph, agents }: { ws: string; graph: GraphRecord; agents: Agent[] }) {
  const live = useLive();
  const parsed = useMemo(() => parseGraph(graph.data), [graph.data]);
  const { states, lastRun, idle, animatingEdges } = useGraphLiveStates(ws, parsed);
  // Stable identity over (agents, live.agentStates) so the canvas's node/edge
  // derivation memo doesn't re-run on every SSE event (M1).
  const agentStates = useMemo(() => {
    const perWs = live.agentStates[ws];
    return agents.reduce<Record<string, AgentState>>((acc, a) => {
      acc[a.agent_id] = perWs?.[a.agent_id] ?? a.state;
      return acc;
    }, {});
  }, [agents, live.agentStates, ws]);
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
          // M5: the canvas passes only the explicit agent_id; role-resolved
          // nodes (the common case) resolve here against the fetched agents.
          const aid = agent ?? agents.find((a) => a.role === n.role)?.agent_id;
          if (aid) window.location.hash = `#/workspaces/${ws}/agents/${aid}`;
        }}
      />
    </div>
  );
}

export function Workspace({ ws }: { ws: string }) {
  const live = useLive();
  const [filter, setFilter] = useState<AgentMode | "all">("all");
  // I-28: lifecycle mutations must surface failures, not vanish.
  const [wsError, setWsError] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const { data: workspace } = useQuery({ queryKey: ["workspace", ws], queryFn: () => api.workspace(ws) });
  const { data: agents } = useQuery({
    queryKey: ["agents", ws],
    queryFn: () => api.agents(ws),
    refetchInterval: 3000,
  });
  const { data: graphs } = useQuery({ queryKey: ["graphs"], queryFn: api.graphs });

  const agentList = agents ?? [];
  const state = live.workspaceStates[ws] ?? workspace?.state ?? "off";
  const shown = agentList.filter((a) => filter === "all" || a.mode === filter);

  const toggle = async (next: "on" | "off") => {
    setWsError(null);
    try {
      if (next === "on") await api.workspaceOn(ws);
      else await api.workspaceOff(ws, true);
    } catch (e) {
      setWsError(`${next} failed: ${(e as Error).message}`);
    }
  };
  const resume = async () => {
    setResumeError(null);
    try {
      await api.resume();
    } catch (e) {
      setResumeError(`resume failed: ${(e as Error).message}`);
    }
  };

  // §7.3: a canvas renders only while a workflow runs — only graphs the SSE
  // reducer has seen for this ws (live.nodeStates[ws] keys) get a canvas.
  // Seen-but-not-running renders with the `idle` + `lastRun` props; a
  // never-run installed graph gets no canvas (the empty note below). An
  // SSE-only id (graph deleted since its last run) can't render — only
  // installed records carry the topology a canvas needs — and is skipped.
  const installed = graphs ?? [];
  const seen = new Set(Object.keys(live.nodeStates[ws] ?? {}));
  const records = installed.filter((g) => seen.has(g.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return (
    <div className="page">
      <section className="ws-card ws-header">
        <h1 className="ws-name">{workspace?.id ?? ws}</h1>
        <span className="ws-state">{state}</span>
        <span className="dim">{workspace?.path}</span>
        <button onClick={() => void toggle(state === "off" ? "on" : "off")}>
          {state === "off" ? "on" : "off"}
        </button>
        <button onClick={() => void resume()}>resume</button>
        {wsError && (
          <div className="ws-triage" role="alert">
            {wsError}
          </div>
        )}
        {resumeError && (
          <div className="ws-triage" role="alert">
            {resumeError}
          </div>
        )}
      </section>

      <section className="ws-card">
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
          {shown.map((a) => (
            <AgentRow key={a.agent_id} ws={ws} agent={a} />
          ))}
          {shown.length === 0 && (
            <span className="dim">{filter === "all" ? "no agents configured" : `no ${filter} agents`}</span>
          )}
        </div>
      </section>

      <section className="ws-card">
        <h2>graphs</h2>
        {records.map((g) => (
          <GraphCanvas key={g.id} ws={ws} graph={g} agents={agentList} />
        ))}
        {records.length === 0 && <p className="dim">no graphs have run in this workspace yet</p>}
      </section>
    </div>
  );
}