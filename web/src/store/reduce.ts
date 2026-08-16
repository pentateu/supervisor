// The pure live-state reducer (§6.4): `BusEvent[]` → `LiveState`. Unit-tested;
// drives the dashboard and every WorkflowCanvas. No network, no React.

import type { AgentState, BusEvent, NodeState, WorkspaceState } from "../api/types";

export interface LiveState {
  workspaceStates: Record<string, WorkspaceState>;
  agentStates: Record<string, Record<string, AgentState>>;
  /** ws → agent → pending permission id (or null). */
  permissionPending: Record<string, Record<string, string | null>>;
  /** ws → graph → node → live node state, folded from workflow bus events. */
  nodeStates: Record<string, Record<string, Record<string, NodeState>>>;
  lastEvents: BusEvent[];
}

export function initialLiveState(): LiveState {
  return {
    workspaceStates: {},
    agentStates: {},
    permissionPending: {},
    nodeStates: {},
    lastEvents: [],
  };
}

const MAX_EVENTS = 200;

export function reduce(prev: LiveState, event: BusEvent): LiveState {
  const next: LiveState = {
    ...prev,
    workspaceStates: { ...prev.workspaceStates },
    agentStates: prev.agentStates,
    permissionPending: prev.permissionPending,
    nodeStates: prev.nodeStates,
    lastEvents: [...prev.lastEvents, event].slice(-MAX_EVENTS),
  };

  if (event.topic === "fleet") {
    const kind = event.kind as string;
    if (kind === "workspace_state" || kind === "workspaceState") {
      const ws = event.workspace as { id: string; state: WorkspaceState };
      if (ws?.id) next.workspaceStates[ws.id] = ws.state;
    } else if (kind === "agent_state" || kind === "agentState") {
      const wid = event.workspace_id as string;
      const aid = event.agent_id as string;
      const st = event.state as AgentState;
      if (wid && aid && st) {
        const perWs = next.agentStates[wid] ?? {};
        next.agentStates = { ...next.agentStates, [wid]: { ...perWs, [aid]: st } };
      }
    }
  } else if (event.topic === "signal") {
    const wid = event.ws as string;
    const aid = event.agent as string;
    const sig = event.signal as string;
    if (sig === "permission_asked" && wid && aid) {
      const perWs = next.permissionPending[wid] ?? {};
      next.permissionPending = {
        ...next.permissionPending,
        [wid]: { ...perWs, [aid]: (event.permission_id as string) ?? "" },
      };
    }
    if (wid && aid && (sig === "session_idle" || sig === "step_started")) {
      const perWs = next.agentStates[wid] ?? {};
      next.agentStates = {
        ...next.agentStates,
        [wid]: {
          ...perWs,
          [aid]: sig === "step_started" ? "working" : "idle",
        },
      };
    }
  } else if (event.topic === "workflow") {
    // The workflow bus event (§4.18): workspace_id scopes the inner
    // serde-tagged WorkflowEvent (dag.rs). Node states fold into
    // nodeStates[ws][graph][node]; `loop_back` re-readies its target;
    // `ack` carries no node and is ignored here.
    const wid = event.workspace_id;
    const inner = event.event;
    if (wid && inner.graph) {
      const setNode = (node: unknown, state: NodeState): void => {
        if (typeof node !== "string" || node === "") return;
        const perGraph = next.nodeStates[wid] ?? {};
        const perNode = perGraph[inner.graph] ?? {};
        next.nodeStates = {
          ...next.nodeStates,
          [wid]: { ...perGraph, [inner.graph]: { ...perNode, [node]: state } },
        };
      };
      switch (inner.event) {
        case "node_ready":
          setNode(inner.node, "ready");
          break;
        case "node_started":
          setNode(inner.node, "running");
          break;
        case "node_done":
          setNode(inner.node, "done");
          break;
        case "node_failed":
          setNode(inner.node, "failed");
          break;
        case "node_blocked":
          setNode(inner.node, "blocked");
          break;
        case "node_needs_decision":
          setNode(inner.node, "needs_decision");
          break;
        case "missing_role":
          setNode(inner.node, "missing_role");
          break;
        case "loop_back":
          setNode(inner.target, "ready");
          break;
        default:
          break;
      }
    }
  }

  return next;
}

/** Fold many events. */
export function reduceAll(initial: LiveState, events: BusEvent[]): LiveState {
  return events.reduce(reduce, initial);
}
