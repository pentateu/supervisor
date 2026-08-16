// @vitest-environment jsdom
// B2: the shared graph-live hook must load node states once from REST (no
// refetchInterval), then let the SSE reducer overlay live transitions — the
// reducer is the single state authority afterwards. Also derives the idle
// flag and the in-flight edge animations (loop_back / just-ready node).

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BusEvent, GraphDef } from "../api/types";
import type { LiveState } from "../store/reduce";
import { useGraphLiveStates } from "./use-graph-live";

const { api } = vi.hoisted(() => ({ api: { graphNodes: vi.fn() } }));
vi.mock("../api/endpoints", () => ({ api }));

const mockLive = vi.hoisted(() => ({
  live: {
    workspaceStates: {},
    agentStates: {},
    permissionPending: {},
    nodeStates: {},
    lastEvents: [],
  } as LiveState,
}));
vi.mock("../store/live-store", () => ({ useLive: () => mockLive.live }));

const GRAPH: GraphDef = {
  id: "g",
  name: "g",
  nodes: [
    { id: "a1", role: "dev", depends_on: [], start_template: "x", done_when: { ack: "a1" }, on_error: "delegate", mode: "foreground" },
    { id: "a2", role: "reviewer", depends_on: ["a1"], start_template: "x", done_when: { ack: "a2" }, on_error: "delegate", mode: "foreground" },
    {
      id: "gate",
      role: "designer",
      depends_on: ["a2"],
      start_template: "submit",
      done_when: { ack: "gate", approved: true },
      on_error: "delegate",
      mode: "foreground",
      gate: "manager",
      loop_back: { on: "needs_revision", small: "gate", big: "a2" },
    },
  ],
};

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function loopBack(ws: string, node: string, target: string): BusEvent {
  return {
    topic: "workflow",
    workspace_id: ws,
    event: { event: "loop_back", graph: "g", node, target },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mockLive.live = {
    workspaceStates: {},
    agentStates: {},
    permissionPending: {},
    nodeStates: {},
    lastEvents: [],
  };
});

describe("useGraphLiveStates — poll removal", () => {
  it("loads node states once from the REST endpoint and never refetches", async () => {
    vi.useFakeTimers();
    api.graphNodes.mockResolvedValue([
      { graph_id: "g", node_id: "a1", state: "done", attempt: 1, started_at: null, finished_at: "2026-08-16T03:41:00Z", error: null },
    ]);
    const { result } = renderHook(() => useGraphLiveStates("ws1", GRAPH), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.graphNodes).toHaveBeenCalledTimes(1);
    expect(api.graphNodes).toHaveBeenCalledWith("ws1", "g");
    // Past the old 2s poll interval: still a single fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(api.graphNodes).toHaveBeenCalledTimes(1);
    expect(result.current.states).toEqual({ a1: "done" });
    expect(result.current.lastRun).toBeDefined();
  });
});

describe("useGraphLiveStates — SSE overlays REST", () => {
  it("lets the reducer's node state win over the REST snapshot", async () => {
    api.graphNodes.mockResolvedValue([
      { graph_id: "g", node_id: "a1", state: "done", attempt: 1, started_at: null, finished_at: null, error: null },
      { graph_id: "g", node_id: "a2", state: "done", attempt: 1, started_at: null, finished_at: null, error: null },
    ]);
    mockLive.live = {
      ...mockLive.live,
      nodeStates: { ws1: { g: { a1: "running" } } },
    };
    const { result } = renderHook(() => useGraphLiveStates("ws1", GRAPH), { wrapper });
    await waitFor(() => expect(result.current.states).toEqual({ a1: "running", a2: "done" }));
  });

  it("merges SSE states across workspaces when ws is unknown (graphs page)", async () => {
    api.graphNodes.mockResolvedValue([]);
    mockLive.live = {
      ...mockLive.live,
      nodeStates: { ws1: { g: { a1: "failed" } }, ws2: { g: { a2: "done" } } },
    };
    const { result } = renderHook(() => useGraphLiveStates(undefined, GRAPH), { wrapper });
    await waitFor(() => expect(result.current.states).toEqual({ a1: "failed", a2: "done" }));
  });
});

describe("useGraphLiveStates — idle derivation", () => {
  it("is idle when no node is running or ready", async () => {
    api.graphNodes.mockResolvedValue([
      { graph_id: "g", node_id: "a1", state: "done", attempt: 1, started_at: null, finished_at: "2026-08-16T03:41:00Z", error: null },
    ]);
    const { result } = renderHook(() => useGraphLiveStates("ws1", GRAPH), { wrapper });
    await waitFor(() => expect(result.current.idle).toBe(true));
  });

  it("is not idle while a node is running or ready", () => {
    api.graphNodes.mockResolvedValue([]);
    mockLive.live = { ...mockLive.live, nodeStates: { ws1: { g: { a1: "ready" } } } };
    const { result } = renderHook(() => useGraphLiveStates("ws1", GRAPH), { wrapper });
    expect(result.current.idle).toBe(false);
  });
});

describe("useGraphLiveStates — in-flight edge animations", () => {
  it("animates the loop_back edge while its event is in flight, then clears it", async () => {
    vi.useFakeTimers();
    api.graphNodes.mockResolvedValue([]);
    mockLive.live = { ...mockLive.live, lastEvents: [loopBack("ws1", "gate", "a2")] };
    const { result } = renderHook(() => useGraphLiveStates("ws1", GRAPH), { wrapper });
    expect(result.current.animatingEdges).toEqual(["gate-a2"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4001);
    });
    expect(result.current.animatingEdges).toEqual([]);
  });

  it("ignores loop_back events for other graphs and workspaces", () => {
    api.graphNodes.mockResolvedValue([]);
    mockLive.live = {
      ...mockLive.live,
      lastEvents: [loopBack("ws2", "gate", "a2"), loopBack("ws1", "gate", "a2")].slice(1),
    };
    mockLive.live.lastEvents[0] = {
      topic: "workflow",
      workspace_id: "ws1",
      event: { event: "loop_back", graph: "other", node: "gate", target: "a2" },
    };
    const { result } = renderHook(() => useGraphLiveStates("ws1", GRAPH), { wrapper });
    expect(result.current.animatingEdges).toEqual([]);
  });

  it("animates the incoming depends_on edges of a node that just became ready", () => {
    api.graphNodes.mockResolvedValue([]);
    mockLive.live = {
      ...mockLive.live,
      lastEvents: [
        { topic: "workflow", workspace_id: "ws1", event: { event: "node_ready", graph: "g", node: "a2" } },
      ],
    };
    const { result } = renderHook(() => useGraphLiveStates("ws1", GRAPH), { wrapper });
    expect(result.current.animatingEdges).toEqual(["a1-a2"]);
  });
});
