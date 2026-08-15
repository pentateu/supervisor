import { describe, expect, it } from "vitest";
import { initialLiveState, reduce, reduceAll } from "./reduce";
import type { BusEvent } from "../api/types";

const fleetAgent = (ws: string, agent: string, state: string): BusEvent => ({
  topic: "fleet",
  kind: "agent_state",
  workspace_id: ws,
  agent_id: agent,
  state,
});

const wf = (ws: string, inner: Record<string, unknown>): BusEvent =>
  ({ topic: "workflow", workspace_id: ws, event: inner }) as BusEvent;

describe("reduce", () => {
  it("tracks workspace state", () => {
    const e: BusEvent = {
      topic: "fleet",
      kind: "workspace_state",
      workspace: { id: "iot", state: "on" },
    } as BusEvent;
    const s = reduce(initialLiveState(), e);
    expect(s.workspaceStates["iot"]).toBe("on");
  });

  it("tracks agent state", () => {
    const s = reduce(initialLiveState(), fleetAgent("iot", "dev_01", "working"));
    expect(s.agentStates["iot"]["dev_01"]).toBe("working");
  });

  it("permission_asked sets the pending banner", () => {
    const e: BusEvent = {
      topic: "signal",
      signal: "permission_asked",
      ws: "iot",
      agent: "dev_01",
      permission_id: "p_9",
    } as BusEvent;
    const s = reduce(initialLiveState(), e);
    expect(s.permissionPending["iot"]["dev_01"]).toBe("p_9");
  });

  it("idle and step_started drive the agent state", () => {
    let s = initialLiveState();
    s = reduce(s, { topic: "signal", signal: "step_started", ws: "iot", agent: "a" } as BusEvent);
    expect(s.agentStates["iot"]["a"]).toBe("working");
    s = reduce(s, { topic: "signal", signal: "session_idle", ws: "iot", agent: "a" } as BusEvent);
    expect(s.agentStates["iot"]["a"]).toBe("idle");
  });

  it("keeps a bounded event ring", () => {
    const events: BusEvent[] = Array.from({ length: 250 }, () => fleetAgent("w", "a", "idle"));
    const s = reduceAll(initialLiveState(), events);
    expect(s.lastEvents.length).toBe(200);
  });

  it("folds the node lifecycle into nodeStates under (ws, graph, node)", () => {
    let s = initialLiveState();
    s = reduce(s, wf("iot", { event: "node_ready", graph: "feature_lifecycle", node: "brainstorm" }));
    expect(s.nodeStates["iot"]["feature_lifecycle"]["brainstorm"]).toBe("ready");
    s = reduce(s, wf("iot", { event: "node_started", graph: "feature_lifecycle", node: "brainstorm" }));
    expect(s.nodeStates["iot"]["feature_lifecycle"]["brainstorm"]).toBe("running");
    s = reduce(s, wf("iot", { event: "node_done", graph: "feature_lifecycle", node: "brainstorm", skipped: false }));
    expect(s.nodeStates["iot"]["feature_lifecycle"]["brainstorm"]).toBe("done");
    s = reduce(s, wf("iot", { event: "node_failed", graph: "feature_lifecycle", node: "dev" }));
    expect(s.nodeStates["iot"]["feature_lifecycle"]["dev"]).toBe("failed");
    s = reduce(s, wf("iot", { event: "node_blocked", graph: "feature_lifecycle", node: "deploy", reason: "no port" }));
    expect(s.nodeStates["iot"]["feature_lifecycle"]["deploy"]).toBe("blocked");
    s = reduce(s, wf("iot", { event: "node_needs_decision", graph: "feature_lifecycle", node: "hl_gate" }));
    expect(s.nodeStates["iot"]["feature_lifecycle"]["hl_gate"]).toBe("needs_decision");
  });

  it("keys node states independently by workspace and graph", () => {
    let s = initialLiveState();
    s = reduce(s, wf("iot", { event: "node_started", graph: "g1", node: "n1" }));
    s = reduce(s, wf("iot", { event: "node_ready", graph: "g2", node: "n1" }));
    s = reduce(s, wf("ws2", { event: "node_done", graph: "g1", node: "n1", skipped: false }));
    expect(s.nodeStates["iot"]["g1"]["n1"]).toBe("running");
    expect(s.nodeStates["iot"]["g2"]["n1"]).toBe("ready");
    expect(s.nodeStates["ws2"]["g1"]["n1"]).toBe("done");
  });

  it("missing_role marks the node as a surface hold", () => {
    const s = reduce(
      initialLiveState(),
      wf("iot", { event: "missing_role", graph: "g1", node: "review", role: "reviewer" }),
    );
    expect(s.nodeStates["iot"]["g1"]["review"]).toBe("missing_role");
  });

  it("loop_back reverts its target node to ready and leaves the gate as-is", () => {
    let s = initialLiveState();
    s = reduce(s, wf("iot", { event: "node_done", graph: "g1", node: "hld", skipped: false }));
    s = reduce(s, wf("iot", { event: "node_done", graph: "g1", node: "hl_gate", skipped: false }));
    s = reduce(s, wf("iot", { event: "loop_back", graph: "g1", node: "hl_gate", target: "hld", revision: "big" }));
    expect(s.nodeStates["iot"]["g1"]["hld"]).toBe("ready");
    expect(s.nodeStates["iot"]["g1"]["hl_gate"]).toBe("done");
  });

  it("ack events carry no node and leave nodeStates untouched", () => {
    const s = reduce(
      initialLiveState(),
      wf("iot", { event: "ack", graph: "g1", ack: { task_id: "t1", status: "done" } }),
    );
    expect(s.nodeStates).toEqual({});
  });
});
