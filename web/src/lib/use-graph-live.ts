// Page-side bridge between REST and SSE for one graph's node states (B2).
//
// The 2s node-state polls are gone: the initial snapshot loads once from
// `GET /graphs/{id}/nodes?ws=`; afterwards the SSE reducer (`live.nodeStates`)
// is the single state authority and simply overlays the snapshot.
//
// Also derives the two canvas props that transient animations need —
// `idle` (no node mid-run) and `animatingEdges` (a LoopBack event is in
// flight, or a node just became ready) — from `live.lastEvents`, with a short
// local timeout. The canvas itself stays pure.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/endpoints";
import type { BusEvent, GraphDef, NodeState } from "../api/types";
import { useLive } from "../store/live-store";

const ANIMATION_MS = 4000;

export interface GraphLiveStates {
  /** REST snapshot overlaid with SSE transitions (last writer wins). */
  states: Record<string, NodeState>;
  /** Human-readable time of the most recent run transition, if any. */
  lastRun?: string;
  /** True when no node is running or ready: last-run states at low
   *  emphasis with an "idle — last run" caption. */
  idle: boolean;
  /** Edge ids to animate while their bus event is in flight. */
  animatingEdges: string[];
}

const EMPTY_STATES: Record<string, NodeState> = {};

function rowsToStates(rows: Array<{ node_id: string; state: NodeState }>): Record<string, NodeState> {
  const states: Record<string, NodeState> = {};
  for (const row of rows) states[row.node_id] = row.state;
  return states;
}

/**
 * Load a graph's node states once over REST, then overlay SSE transitions.
 *
 * `ws` is the workspace scope (`GET /graphs/{id}/nodes?ws=`). When unknown
 * (the Graphs page has no workspace in context), both the REST snapshot and
 * the SSE overlay merge states across workspaces for the same graph id:
 * node state is keyed by (ws, graph, node) and one graph can run in several
 * workspaces, so a merged canvas is last-writer-wins and arbitrary under
 * concurrent runs. Pre-existing limitation (the old 2s poll reduced the same
 * way); graph definitions themselves are global.
 */
export function useGraphLiveStates(ws: string | undefined, graph: GraphDef | null): GraphLiveStates {
  const live = useLive();
  const graphId = graph?.id ?? null;

  const { data } = useQuery({
    queryKey: ["graphNodes", graphId, ws ?? "all"],
    queryFn: () => api.graphNodes(ws, graphId ?? ""),
    enabled: graphId !== null,
  });

  const rest = useMemo(() => rowsToStates(data ?? []), [data]);

  // The reducer's view wins over the snapshot — it saw the same state plus
  // every transition since the page loaded. With no ws this merges every
  // workspace's states for the graph id (same cross-workspace ambiguity as
  // the REST snapshot above).
  const sse = useMemo(() => {
    if (graphId === null) return EMPTY_STATES;
    if (ws) return live.nodeStates[ws]?.[graphId] ?? EMPTY_STATES;
    const merged: Record<string, NodeState> = {};
    for (const perGraph of Object.values(live.nodeStates)) {
      Object.assign(merged, perGraph[graphId]);
    }
    return merged;
  }, [live.nodeStates, ws, graphId]);

  const states = useMemo(() => ({ ...rest, ...sse }), [rest, sse]);

  const idle = useMemo(
    () => !Object.values(states).some((s) => s === "running" || s === "ready"),
    [states],
  );

  const lastRun = useMemo(() => {
    let latest: string | undefined;
    for (const row of data ?? []) {
      const t = row.finished_at ?? row.started_at;
      if (t && (latest === undefined || t > latest)) latest = t;
    }
    return latest ? new Date(latest).toLocaleTimeString() : undefined;
  }, [data]);

  // Transient edge animations: react to the most recent bus event for this
  // graph/workspace, hold the edge ids for a few seconds, then clear them.
  //
  // I1: expiry is tracked per edge in a ref and pruned by a fixed interval,
  // not by a per-effect setTimeout. This effect re-runs on EVERY bus event
  // (lastEvents is a fresh array each reduce); a setTimeout scheduled by a
  // previous run would be cancelled by the re-run's cleanup and never
  // rescheduled when the new event is unrelated — leaving edges animated
  // forever under traffic. Expiries survive unrelated re-runs, so an edge
  // always clears ~ANIMATION_MS after its own event.
  const [inFlight, setInFlight] = useState<string[]>([]);
  const lastSeen = useRef<BusEvent | null>(null);
  const expiries = useRef<Map<string, number>>(new Map());
  const lastEvents = live.lastEvents;
  // M3: a graph switch must not leak the previous graph's animation windows
  // — expiries are edge-id-keyed, and coincident ids (e.g. `dep-node`) would
  // animate the new canvas. Declared before the event effect so a genuine
  // event for the NEW graph (already in the ring at switch time) still
  // animates after the clear.
  useEffect(() => {
    expiries.current.clear();
    setInFlight([]);
  }, [graphId]);
  useEffect(() => {
    const last = lastEvents[lastEvents.length - 1] ?? null;
    if (last === lastSeen.current) return; // ring-buffer shift, not a new event
    lastSeen.current = last;
    if (!last || last.topic !== "workflow" || graphId === null) return;
    if (ws !== undefined && last.workspace_id !== ws) return;
    const inner = last.event;
    if (inner.graph !== graphId) return;
    const edges: string[] = [];
    if (inner.event === "loop_back" && typeof inner.node === "string" && typeof inner.target === "string") {
      // LoopBack {node: gate, target} — animate the gate→target edge.
      edges.push(`${inner.node}-${inner.target}`);
    } else if (inner.event === "node_ready" && typeof inner.node === "string") {
      // §6.3: a just-ready node animates its incoming depends_on edges.
      const deps = graph?.nodes.find((n) => n.id === inner.node)?.depends_on ?? [];
      for (const dep of deps) edges.push(`${dep}-${inner.node}`);
    }
    if (edges.length === 0) return;
    // A repeated event on an edge extends its window from the latest event.
    const now = Date.now();
    const map = expiries.current;
    for (const edge of edges) map.set(edge, now + ANIMATION_MS);
    setInFlight([...map.keys()]);
  }, [lastEvents, ws, graphId, graph?.nodes]);

  // Fixed-cadence prune, independent of bus traffic: an expired edge leaves
  // the set ~ANIMATION_MS after its event no matter what else arrives.
  useEffect(() => {
    const timer = setInterval(() => {
      const map = expiries.current;
      if (map.size === 0) return;
      const now = Date.now();
      let changed = false;
      for (const [edge, expiry] of map) {
        if (expiry <= now) {
          map.delete(edge);
          changed = true;
        }
      }
      if (changed) setInFlight([...map.keys()]);
    }, 250);
    return () => clearInterval(timer);
  }, []);

  return { states, lastRun, idle, animatingEdges: inFlight };
}
