import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, parseGraph } from "../api/endpoints";
import { useClearPermission, useLive } from "../store/live-store";
import type { BusEvent, DecisionAction, NodeStateRow, TranscriptMessage } from "../api/types";

/** §5.4 feed kinds: glyph + short label per signal. `session_idle` and
 * `heartbeat` are deliberately excluded — no activity to show. */
const FEED_KINDS: Record<string, { glyph: string; label: string }> = {
  step_started: { glyph: "▶", label: "started" },
  step_ended: { glyph: "✓", label: "step done" },
  step_failed: { glyph: "✕", label: "step failed" },
  tool_failed: { glyph: "⚠", label: "tool failed" },
  diff: { glyph: "±", label: "diff" },
  permission_asked: { glyph: "🔒", label: "permission" },
  needs_input: { glyph: "✉", label: "needs input" },
  session_error: { glyph: "💥", label: "session error" },
  session_status: { glyph: "◉", label: "status" },
};

export interface FeedTick {
  id: number;
  event: Extract<BusEvent, { topic: "signal" }>;
  /** SSE carries no timestamps — the feed records receipt time (B5). */
  at: number;
}

/** §5.4 activity feed: ticks from `live.lastEvents` filtered by (ws, agent).
 * The ring is timestamp-less, so the dialog timestamps at receipt: watch the
 * ring grow by event identity (same trick as `useGraphLiveStates`) and keep
 * every matching arrival for this dialog session. */
function useAgentActivity(ws: string, agent: string, lastEvents: BusEvent[]): FeedTick[] {
  const [ticks, setTicks] = useState<FeedTick[]>([]);
  const scope = `${ws}/${agent}`;
  const scopeRef = useRef(scope);
  const prevEvents = useRef<BusEvent[] | null>(null);
  const nextId = useRef(0);

  useEffect(() => {
    if (scopeRef.current !== scope) {
      // A different agent in the same dialog slot: drop the previous agent's
      // ticks and re-seed from the ring tail (the mount path below).
      scopeRef.current = scope;
      prevEvents.current = null;
      setTicks([]);
    }
    const before = prevEvents.current;
    prevEvents.current = lastEvents;
    const fresh: BusEvent[] = [];
    if (before === null) {
      fresh.push(...lastEvents);
    } else {
      const beforeLast = before.length > 0 ? before[before.length - 1] : null;
      let i = lastEvents.length - 1;
      for (; i >= 0; i--) {
        const ev = lastEvents[i];
        if (ev === beforeLast) break;
        fresh.push(ev);
      }
      fresh.reverse();
    }
    const now = Date.now();
    const newTicks: FeedTick[] = [];
    for (const ev of fresh) {
      if (ev.topic !== "signal" || ev.ws !== ws || ev.agent !== agent) continue;
      if (!(ev.signal in FEED_KINDS)) continue;
      newTicks.push({ id: nextId.current++, event: ev, at: now });
    }
    if (newTicks.length > 0) setTicks((prev) => [...prev, ...newTicks]);
  }, [lastEvents, scope]);

  return ticks;
}

interface DecisionTarget {
  graph: string;
  node: string;
  reason?: string;
}

/** The human's ruling target: the first `needs_decision` node owned by this
 * agent — node.agent_id, else node.role === the agent's role (the REST meta,
 * falling back to the agent id). The live view is the first authority (every
 * graph the reducer has seen for this workspace); the REST node rows of the
 * installed graphs backstop it after a fresh load, because the SSE ring has
 * no replay and a persisted needs_decision would otherwise never surface.
 * Graph defs load over REST for ownership only (no polling). */
function useAgentDecision(ws: string, agent: string) {
  const live = useLive();
  const { data: agents } = useQuery({ queryKey: ["agents", ws], queryFn: () => api.agents(ws) });
  const { data: graphs } = useQuery({ queryKey: ["graphs"], queryFn: api.graphs });
  const meta = (agents ?? []).find((a) => a.agent_id === agent);
  const role = meta?.role ?? agent;
  const state = live.agentStates[ws]?.[agent] ?? meta?.state ?? "unknown";

  const defs = useMemo(() => (graphs ?? []).map((g) => parseGraph(g.data)), [graphs]);
  const defById = useMemo(() => new Map(defs.map((g) => [g.id, g])), [defs]);

  // The live authority: the first needs_decision node owned by this agent
  // across every graph the reducer has seen for this workspace.
  const sseDecision = useMemo<DecisionTarget | null>(() => {
    const perGraph = live.nodeStates[ws];
    if (!perGraph) return null;
    for (const [graphId, perNode] of Object.entries(perGraph)) {
      for (const [nodeId, nodeState] of Object.entries(perNode)) {
        if (nodeState !== "needs_decision") continue;
        const node = defById.get(graphId)?.nodes.find((n) => n.id === nodeId);
        if (!node) continue;
        if (node.agent_id !== agent && node.role !== role) continue;
        return { graph: graphId, node: nodeId };
      }
    }
    return null;
  }, [live.nodeStates, ws, defById, agent, role]);

  // Fresh-load fallback (F3): the SSE ring has no replay, so probe the REST
  // node rows of the installed graphs once — same ownership rule — until a
  // needs_decision row for this agent is found (its reason is the row's
  // `error`).
  const { data: restRows } = useQuery({
    queryKey: ["graphNodes", ws, "all"],
    queryFn: async () => {
      const rows: NodeStateRow[] = [];
      for (const g of graphs ?? []) rows.push(...(await api.graphNodes(ws, g.id)));
      return rows;
    },
    enabled: sseDecision === null && (graphs ?? []).length > 0,
  });
  const restDecision = useMemo<DecisionTarget | null>(() => {
    if (sseDecision !== null) return null;
    for (const row of restRows ?? []) {
      if (row.state !== "needs_decision") continue;
      const node = defById.get(row.graph_id)?.nodes.find((n) => n.id === row.node_id);
      if (!node) continue;
      if (node.agent_id !== agent && node.role !== role) continue;
      const target: DecisionTarget = { graph: row.graph_id, node: row.node_id };
      if (row.error) target.reason = row.error;
      return target;
    }
    return null;
  }, [sseDecision, restRows, defById, agent, role]);

  const decision = sseDecision ?? restDecision;

  const { data: nodeRows } = useQuery({
    queryKey: ["graphNodes", decision?.graph, ws],
    queryFn: () => api.graphNodes(ws, decision?.graph ?? ""),
    enabled: decision !== null,
  });

  const reason = useMemo(() => {
    if (!decision) return undefined;
    const row = (nodeRows ?? []).find((r) => r.node_id === decision.node);
    if (row?.error) return row.error;
    if (decision.reason) return decision.reason;
    // Fall back to the agent's last failed step/session error (the wire
    // carries `error` only on step_failed).
    for (let i = live.lastEvents.length - 1; i >= 0; i--) {
      const ev = live.lastEvents[i];
      if (ev.topic !== "signal" || ev.ws !== ws || ev.agent !== agent) continue;
      if (ev.signal !== "step_failed" && ev.signal !== "session_error") continue;
      const err = ev.error as string | undefined;
      if (err) return err;
    }
    return undefined;
  }, [nodeRows, decision, live.lastEvents, ws, agent]);

  return { meta, state, decision: decision ? { ...decision, reason } : null };
}

export function AgentDialog({ ws, agent }: { ws: string; agent: string }) {
  const live = useLive();
  const clearPermission = useClearPermission();
  const [compose, setCompose] = useState("");
  const [high, setHigh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedExpanded, setFeedExpanded] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const { meta, state, decision } = useAgentDecision(ws, agent);
  const pendingPermission = live.permissionPending[ws]?.[agent];

  const { data: transcript } = useQuery({
    queryKey: ["transcript", ws, agent],
    queryFn: () => api.transcript(ws, agent, 50),
    refetchInterval: state === "working" ? 1500 : 10000,
  });

  const ticks = useAgentActivity(ws, agent, live.lastEvents);
  const shownTicks = feedExpanded ? ticks : ticks.slice(-10);

  // Forget dismissals once the reducer folds the node out of needs_decision,
  // so a later needs_decision on the same node re-arms the banner.
  useEffect(() => {
    setDismissed((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const key of prev) {
        const [graph, node] = key.split("/");
        if (live.nodeStates[ws]?.[graph]?.[node] === "needs_decision") next.add(key);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [live.nodeStates, ws]);

  const decide = useMutation({
    mutationFn: ({ graph, node, action }: { graph: string; node: string; action: DecisionAction }) =>
      api.decide(ws, graph, node, action),
    // I-28: a ruling dismisses its banner optimistically — it is the human's
    // decision; the SSE reducer folds the resulting transition afterwards (no
    // manual state fight with the reducer).
    onSuccess: (_data, vars) => setDismissed((prev) => new Set(prev).add(`${vars.graph}/${vars.node}`)),
    onError: (e) => setError(`decide failed: ${(e as Error).message}`),
  });

  const send = useMutation({
    mutationFn: (body: string) => api.sendMessage(ws, agent, body, high ? "high" : "normal"),
    // I-28: mutation failures must not be silent.
    onError: (e) => setError(`send failed: ${(e as Error).message}`),
  });
  const abort = useMutation({
    mutationFn: () => api.abortAgent(ws, agent),
    onError: (e) => setError(`abort failed: ${(e as Error).message}`),
  });
  const attach = useMutation({
    mutationFn: () => api.attachAgent(ws, agent),
    onError: (e) => setError(`attach failed: ${(e as Error).message}`),
  });
  const permission = useMutation({
    mutationFn: ({ pid, allow }: { pid: string; allow: boolean }) =>
      api.respondPermission(ws, agent, pid, allow ? "allow" : "deny", true),
    onSuccess: () => clearPermission(ws, agent), // I-27: no stale banner
    onError: (e) => setError(`permission response failed: ${(e as Error).message}`),
  });

  const rows = (transcript ?? []) as TranscriptMessage[];

  // Auto-scroll to the newest row.
  useEffect(() => {
    const el = document.querySelector(".transcript");
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  return (
    <div className="page agent-page">
      <header className="agent-header">
        <a href={`#/workspaces/${ws}`} className="dim">← {ws}</a>
        <h1>
          {agent} <span className={`agent-state wf-agent-${state}`}>{state}</span>
        </h1>
        <div className="dim">
          role {meta?.role} · {meta?.mode} · driver {meta?.driver}
          {meta?.session_id ? ` · ${meta.session_id}` : ""}
        </div>
      </header>

      {pendingPermission && (
        <div className="permission-banner">
          <strong>Permission requested</strong> ({pendingPermission})
          <button onClick={() => permission.mutate({ pid: pendingPermission, allow: true })}>Allow</button>
          <button onClick={() => permission.mutate({ pid: pendingPermission, allow: false })}>Deny</button>
        </div>
      )}

      {decision && !dismissed.has(`${decision.graph}/${decision.node}`) && (
        <div className="permission-banner">
          <strong>
            {decision.node} in {decision.graph} needs a decision
            {decision.reason ? ` — ${decision.reason}` : ""}
          </strong>
          <button
            disabled={decide.isPending}
            onClick={() => decide.mutate({ graph: decision.graph, node: decision.node, action: "done" })}
          >
            Done
          </button>
          <button
            disabled={decide.isPending}
            onClick={() => decide.mutate({ graph: decision.graph, node: decision.node, action: "rerun" })}
          >
            Rerun
          </button>
          <button
            disabled={decide.isPending}
            onClick={() => decide.mutate({ graph: decision.graph, node: decision.node, action: "skip" })}
          >
            Skip
          </button>
        </div>
      )}

      {error && (
        <div className="permission-banner" role="alert">
          <strong>{error}</strong>
          <button onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      {ticks.length > 0 && (
        <div className="agent-feed" role="log" aria-live="polite" aria-label={`${agent} activity`}>
          {shownTicks.map((t) => (
            <span key={t.id} className="feed-tick" title={new Date(t.at).toLocaleTimeString()}>
              <span className="feed-time">{new Date(t.at).toLocaleTimeString()}</span>
              <span className="feed-glyph" role="img" aria-label={t.event.signal}>
                {FEED_KINDS[t.event.signal].glyph}
              </span>
              <span className="feed-label">{FEED_KINDS[t.event.signal].label}</span>
            </span>
          ))}
          {ticks.length > 10 && (
            <button className="feed-more" onClick={() => setFeedExpanded((e) => !e)}>
              {feedExpanded ? "fewer" : `+${ticks.length - 10} more`}
            </button>
          )}
        </div>
      )}

      <div className="transcript">
        {rows.length === 0 && <p className="dim">No transcript yet.</p>}
        {rows.map((m, i) => (
          <div key={i} className={`row row-${m.role}`}>
            <span className="row-role">{m.role}</span>
            <span className="row-ts">{m.ts}</span>
            <pre>{m.text}</pre>
          </div>
        ))}
      </div>

      <div className="actions">
        <button disabled={abort.isPending} onClick={() => abort.mutate()}>
          abort
        </button>
        <button disabled={attach.isPending} onClick={() => attach.mutate()}>
          attach pane
        </button>
        {meta?.mode === "background" && <span className="dim">currently headless</span>}
        {attach.data && <span className="dim">{attach.data.spawned ? "pane spawned" : attach.data.attach}</span>}
      </div>

      <form
        className="compose"
        onSubmit={(e) => {
          e.preventDefault();
          if (!compose.trim()) return;
          send.mutate(compose);
          setCompose("");
        }}
      >
        <input
          value={compose}
          onChange={(e) => setCompose(e.target.value)}
          placeholder={`message ${agent}…`}
        />
        <label className="high">
          <input type="checkbox" checked={high} onChange={(e) => setHigh(e.target.checked)} />
          high
        </label>
        <button type="submit">send</button>
      </form>
    </div>
  );
}