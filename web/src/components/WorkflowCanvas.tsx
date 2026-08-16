// The reusable WorkflowCanvas (§6): one renderer, two modes.
// - `live`: nodeStates + agentStates drive colors/animations; positions from
//   dagre; click-to-open only.
// - `edit`: React Flow manages positions; wiring fires `onChange`.
// Pure component — no network calls, no timers. Transient animations
// (`animatingEdges`) arrive as props; callers derive them from `live.lastEvents`.

import { useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { AgentState, GraphDef, NodeDef, NodeState, OnError } from "../api/types";
import { layoutGraph } from "../lib/layout";
import { connect, disconnect, removeNodes } from "../lib/graph-edit";

const ROLE_GLYPH: Record<string, string> = {
  dev: "⚙️",
  reviewer: "🔍",
  tester: "🧪",
  designer: "🎨",
  "memory-keeper": "📚",
  manager: "🧭",
};

// §6.2: state is never color-only — every state glyph carries the state name
// in its aria-label. Pending/running have no glyph char (muted / spinner);
// ready renders a pulsing dot.
const STATE_GLYPH: Partial<Record<NodeState, string>> = {
  done: "✓",
  failed: "✕",
  blocked: "⛔",
  needs_decision: "!",
  missing_role: "⚠",
};

const NODE_W = 180;
const NODE_H = 64;
// A stable empty-state object: `?? {}` created a fresh object every render,
// which invalidated the editSeed memo and re-ran the re-seed effect each
// render (pre-existing review minor).
const EMPTY_STATES: Record<string, never> = {};
// Loop-back "revision" edges (§6.3) render in a distinct violet.
const LOOP_COLOR = "#a371f7";

export interface WorkflowCanvasProps {
  graph: GraphDef;
  mode: "edit" | "live";
  nodeStates?: Record<string, NodeState>;
  agentStates?: Record<string, AgentState>;
  onNodeClick?: (node: NodeDef, agentId?: string) => void;
  onChange?: (graph: GraphDef) => void;
  compact?: boolean;
  /** Last-run display: states render at low emphasis with no spinner and an
   * "idle — last run <time>" caption. Not a mode — still clickable. */
  idle?: boolean;
  /** Human-readable time of the most recent run (shown in the idle caption). */
  lastRun?: string;
  /** Edge ids whose animation is in flight (loop_back fired, or a node just
   * became ready). Derived by the caller from `live.lastEvents` — the canvas
   * stays pure. */
  animatingEdges?: string[];
}

type CardData = {
  label: string;
  role: string;
  state: NodeState;
  agent?: string;
  agentState?: AgentState;
  onError?: OnError;
  idle: boolean;
} & Record<string, unknown>;

function onErrorLabel(o?: OnError): string | null {
  if (o === undefined || o === null) return null;
  if (typeof o === "string") return `on_error: ${o}`;
  return `on_error: rerun ×${o.rerun.max}`;
}

function StateCard({ data }: NodeProps<Node<CardData>>) {
  const d = data;
  const glyph = ROLE_GLYPH[d.role] ?? "▫️";
  const missing = d.state === "pending" && !d.agent;
  const stateGlyph = d.state === "ready" ? "●" : (STATE_GLYPH[d.state] ?? null);
  const onError = onErrorLabel(d.onError);
  return (
    <div className={`wf-node wf-${d.state}${missing ? " wf-missing" : ""}${d.idle ? " wf-idle" : ""}`}>
      <Handle type="target" position={Position.Top} />
      <div className="wf-glyph">{glyph}</div>
      {stateGlyph !== null && (
        <span className="wf-state-glyph" role="img" aria-label={d.state}>
          {stateGlyph}
        </span>
      )}
      <div className="wf-id">{d.label}</div>
      <div className="wf-meta">
        {d.agent ?? (missing ? "no agent" : "—")}
        {onError && <span className="wf-on-error">{onError}</span>}
      </div>
      {!d.idle && d.state === "running" && <div className="wf-spinner" />}
      {!d.idle && d.agentState && (
        <span className={`wf-agent-state wf-agent-${d.agentState}`} title={d.agentState} />
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

interface ToFlowOptions {
  idle?: boolean;
  animatingEdges?: string[];
}

function toFlow(
  graph: GraphDef,
  states: Record<string, NodeState>,
  agentStates: Record<string, AgentState>,
  positions?: Array<{ id: string; x: number; y: number }>,
  opts?: ToFlowOptions,
): { nodes: Node<CardData>[]; edges: Edge[] } {
  const pos = positions ? new Map(positions.map((p) => [p.id, p])) : new Map();
  const animating = new Set(opts?.animatingEdges ?? []);
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const nodes: Node<CardData>[] = graph.nodes.map((n, i) => {
    const p = pos.get(n.id);
    return {
      id: n.id,
      type: "stateCard",
      position: p ? { x: p.x, y: p.y } : { x: 40 + (i % 3) * 220, y: 40 + Math.floor(i / 3) * 110 },
      data: {
        label: n.id,
        role: n.role,
        state: states[n.id] ?? "pending",
        agent: n.agent_id ?? undefined,
        agentState: n.agent_id ? agentStates[n.agent_id] : undefined,
        onError: n.on_error,
        idle: opts?.idle ?? false,
      },
    };
  });
  const edges: Edge[] = graph.nodes.flatMap((n) => {
    const dependsOn = n.depends_on.map((dep) => {
      const id = `${dep}-${n.id}`;
      const inFlight = animating.has(id);
      return {
        id,
        source: dep,
        target: n.id,
        animated: inFlight || (states[dep] === "done" && states[n.id] === "ready"),
        style: {
          strokeWidth: 1.5,
          // §6.3: a just-ready node gets an animated dashed edge for a few
          // seconds (prop-driven, same as the LoopBack-in-flight animation).
          ...(inFlight ? { strokeDasharray: "6 3" } : {}),
        },
      };
    });
    // §6.3: human-gate `loop_back` targets draw as dashed violet revision
    // edges from the gate. `on` is the revision condition key today, but if
    // it names a node it renders unlabeled (forward-compat). Edges are
    // derived, not user-wired: not deletable in edit mode.
    const loopBack: Edge[] = [];
    const lb = n.loop_back;
    if (lb) {
      const seen = new Set<string>();
      const add = (target: string, label?: string) => {
        const id = `${n.id}-${target}`;
        if (!target || !nodeIds.has(target) || seen.has(id)) return;
        seen.add(id);
        loopBack.push({
          id,
          source: n.id,
          target,
          label,
          animated: animating.has(id),
          deletable: false,
          style: { stroke: LOOP_COLOR, strokeDasharray: "6 3", strokeWidth: 1.5 },
        });
      };
      add(lb.small, "small");
      add(lb.big, "big");
      add(lb.on ?? "", undefined);
    }
    return [...dependsOn, ...loopBack];
  });
  return { nodes, edges };
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  const { graph, mode, nodeStates, agentStates, onNodeClick, onChange, compact, idle, lastRun, animatingEdges } = props;
  const states = nodeStates ?? EMPTY_STATES;
  const agentStateMap = agentStates ?? {};

  const layout = useMemo(() => (mode === "live" ? layoutGraph(graph, NODE_W, NODE_H) : undefined), [graph, mode]);
  const live = mode === "live";

  // Live: fully derived from props (re-renders on SSE state changes).
  const liveFlow = useMemo(
    () => toFlow(graph, states, agentStateMap, layout, { idle, animatingEdges }),
    [graph, states, agentStateMap, layout, idle, animatingEdges],
  );
  const liveNodes = liveFlow.nodes;
  const liveEdges = liveFlow.edges;

  // Edit: React Flow owns positions; we only re-seed when the graph structure
  // changes.
  const editSeed = useMemo(() => toFlow(graph, states, agentStateMap, undefined), [graph, states, agentStateMap]);
  const [nodes, setNodes, onNodesChange] = useNodesState(editSeed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(editSeed.edges);
  useEffect(() => {
    if (live) return;
    setNodes(editSeed.nodes);
    setEdges(editSeed.edges);
  }, [editSeed, live, setNodes, setEdges]);

  const nodeTypes = useMemo(() => ({ stateCard: StateCard }), []);

  const onConnectEdit = (conn: { source?: string; target?: string }) => {
    if (!onChange || !conn.source || !conn.target) return;
    onChange(connect(graph, conn.target, conn.source));
  };
  const onNodesChangeEdit: import("@xyflow/react").OnNodesChange<Node<CardData>> = (changes) => {
    onNodesChange(changes);
    if (!onChange) return;
    // C-6: backspace removal must reach the parent graph (and save). F-2 /
    // M-3: fold a batch of removals into ONE onChange applied sequentially —
    // each change used to rebuild from the same stale `graph` prop, so
    // box-delete resurrected all but the last node.
    const removed: string[] = [];
    for (const c of changes) {
      if (c.type === "remove" && "id" in c && c.id) removed.push(c.id);
    }
    if (removed.length > 0) onChange(removeNodes(graph, removed));
  };
  const onEdgesDeleteEdit = (deleted: Edge[]) => {
    if (!onChange) return;
    let next = graph;
    for (const edge of deleted) next = disconnect(next, edge.target ?? "", edge.source ?? "");
    onChange(next);
  };
  const handleNodeClick = (_: unknown, n: Node<CardData>) => {
    onNodeClick?.(graph.nodes.find((g) => g.id === n.id)!, n.data.agent);
  };

  return (
    <div className={`wf-canvas${compact ? " wf-compact" : ""}${idle ? " wf-idle" : ""}`}>
      {idle && lastRun && <div className="wf-idle-caption">idle — last run {lastRun}</div>}
      <ReactFlow
        nodes={live ? liveNodes : nodes}
        edges={live ? liveEdges : edges}
        nodeTypes={nodeTypes}
        onNodesChange={live ? undefined : onNodesChangeEdit}
        onEdgesChange={live ? undefined : onEdgesChange}
        onConnect={live ? undefined : onConnectEdit}
        onEdgesDelete={live ? undefined : onEdgesDeleteEdit}
        nodesDraggable={!live}
        nodesConnectable={!live}
        fitView
        proOptions={{ hideAttribution: true }}
        onNodeClick={handleNodeClick}
      >
        <Background />
        <Controls showInteractive={!live} />
      </ReactFlow>
    </div>
  );
}

/** The agent-state pill (used in canvases + dashboard). */
export function AgentChip({ agent, state }: { agent: string; state?: AgentState }) {
  return <span className={`wf-agent-chip wf-agent-${state ?? "unknown"}`}>{agent}</span>;
}
