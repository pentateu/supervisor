// @vitest-environment jsdom
// B5 agent dialog tests: the activity feed (ticks for the 9 signal kinds,
// filtered by (ws, agent), receipt timestamps, session_idle/heartbeat
// excluded, last-10 with an expand for older, arrivals appended while open)
// and the decide banner (needs_decision-node + agent-error triggers, ownership
// by agent_id and by role, Done/Rerun/Skip hitting the decide endpoint,
// I-28 error surfacing, optimistic dismissal that re-arms once the reducer
// folds the transition). Rendered through the real component — only the REST
// api and the live store are stubbed; fixtures are real wire shapes.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/jsdom-polyfills";

import type { Agent, BusEvent, GraphRecord, NodeStateRow } from "../api/types";
import type { LiveState } from "../store/reduce";
import { AgentDialog } from "./Agent";

const { api } = vi.hoisted(() => ({
  api: {
    agents: vi.fn(),
    transcript: vi.fn(),
    graphs: vi.fn(),
    graphNodes: vi.fn(),
    decide: vi.fn(),
    sendMessage: vi.fn(),
    abortAgent: vi.fn(),
    attachAgent: vi.fn(),
    respondPermission: vi.fn(),
  },
}));
vi.mock("../api/endpoints", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../api/endpoints")>();
  return { ...mod, api };
});

const mockLive = vi.hoisted(() => ({
  live: {
    workspaceStates: {},
    agentStates: {},
    permissionPending: {},
    nodeStates: {},
    lastEvents: [],
  } as LiveState,
  clear: vi.fn(),
}));
vi.mock("../store/live-store", () => ({
  useLive: () => mockLive.live,
  useClearPermission: () => mockLive.clear,
}));

const DEV: Agent = {
  workspace_id: "iot",
  agent_id: "dev_01",
  role: "dev",
  model: null,
  session_id: null,
  driver: "opencode",
  mode: "foreground",
  state: "idle",
  confidence: 0.4,
  inbox_depth: 0,
};
const REV: Agent = {
  ...DEV,
  agent_id: "rev_01",
  role: "reviewer",
};

const GRAPH_DATA = JSON.stringify({
  id: "bug_flow",
  name: "bug flow",
  nodes: [
    {
      id: "fix",
      role: "dev",
      agent_id: "dev_01",
      depends_on: [],
      start_template: "fix it",
      done_when: { ack: "fix" },
      on_error: "delegate",
      mode: "foreground",
    },
  ],
});
const GRAPH: GraphRecord = {
  id: "bug_flow",
  name: "bug flow",
  data: GRAPH_DATA,
  version: 1,
  active: true,
  updated_at: "2026-08-16T00:00:00Z",
};

function graphWith(nodes: unknown[]): GraphRecord {
  return { ...GRAPH, data: JSON.stringify({ id: "bug_flow", name: "bug flow", nodes }) };
}

/** A signal bus event for the dialog's agent (iot/dev_01). */
function signal(sig: string, extra: Record<string, unknown> = {}): BusEvent {
  return { topic: "signal", signal: sig, ws: "iot", agent: "dev_01", ...extra };
}

function newLive(patch?: Partial<LiveState>): LiveState {
  return {
    workspaceStates: {},
    agentStates: {},
    permissionPending: {},
    nodeStates: {},
    lastEvents: [],
    ...patch,
  };
}

async function renderDialog(opts: {
  live?: LiveState;
  agents?: Agent[];
  graphs?: GraphRecord[];
  graphNodes?: NodeStateRow[];
  agent?: string;
} = {}) {
  if (opts.live) mockLive.live = opts.live;
  if (opts.agents) api.agents.mockResolvedValue(opts.agents);
  if (opts.graphs) api.graphs.mockResolvedValue(opts.graphs);
  if (opts.graphNodes) api.graphNodes.mockResolvedValue(opts.graphNodes);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const agent = opts.agent ?? "dev_01";
  const result = render(
    <QueryClientProvider client={client}>
      <AgentDialog ws="iot" agent={agent} />
    </QueryClientProvider>,
  );
  await act(async () => {});
  return { client, result };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLive.live = newLive();
  api.agents.mockResolvedValue([DEV]);
  api.transcript.mockResolvedValue([]);
  api.graphs.mockResolvedValue([GRAPH]);
  api.graphNodes.mockResolvedValue([]);
  api.decide.mockResolvedValue({ node: "fix", state: "done", action: "done", workspace: "iot", graph: "bug_flow" });
  api.sendMessage.mockResolvedValue({});
  api.abortAgent.mockResolvedValue({});
  api.attachAgent.mockResolvedValue({ attach: "pane", spawned: false });
  api.respondPermission.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
});

describe("activity feed", () => {
  const KINDS: Array<[string, string]> = [
    ["step_started", "started"],
    ["step_ended", "step done"],
    ["step_failed", "step failed"],
    ["tool_failed", "tool failed"],
    ["diff", "diff"],
    ["permission_asked", "permission"],
    ["needs_input", "needs input"],
    ["session_error", "session error"],
    ["session_status", "status"],
  ];

  it("renders a tick per signal kind with glyph + label + receipt time", async () => {
    await renderDialog({ live: newLive({ lastEvents: KINDS.map(([k]) => signal(k)) }) });
    const log = await screen.findByRole("log");
    expect(within(log).getAllByRole("img")).toHaveLength(9);
    for (const [kind, label] of KINDS) {
      expect(within(log).getByRole("img", { name: kind })).toBeInTheDocument();
      expect(within(log).getByText(label)).toBeInTheDocument();
    }
    for (const tick of [...log.querySelectorAll(".feed-tick")]) {
      // M13: the component formats receipt times locale-independently
      // (manual HH:MM padding), so this assertion must not depend on the
      // runner's toLocaleTimeString output.
      expect(tick.querySelector(".feed-time")?.textContent).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it("filters by (ws, agent) and excludes session_idle + heartbeat", async () => {
    await renderDialog({
      live: newLive({
        lastEvents: [
          signal("step_started"),
          signal("session_idle"),
          signal("heartbeat"),
          { topic: "signal", signal: "step_ended", ws: "iot", agent: "rev_01" },
          { topic: "signal", signal: "diff", ws: "other", agent: "dev_01" },
        ],
      }),
    });
    const log = await screen.findByRole("log");
    expect(within(log).getAllByRole("img")).toHaveLength(1);
    expect(within(log).getByRole("img", { name: "step_started" })).toBeInTheDocument();
  });

  it("shows the last 10 ticks and expands to the older ones", async () => {
    await renderDialog({
      live: newLive({ lastEvents: Array.from({ length: 13 }, () => signal("step_started")) }),
    });
    const log = await screen.findByRole("log");
    expect(log.querySelectorAll(".feed-tick")).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "+3 more" }));
    expect(log.querySelectorAll(".feed-tick")).toHaveLength(13);
    expect(screen.getByRole("button", { name: "fewer" })).toBeInTheDocument();
  });

  it("appends ticks for events that arrive while the dialog is open", async () => {
    const { client, result } = await renderDialog({ live: newLive({ lastEvents: [signal("step_started")] }) });
    const log = await screen.findByRole("log");
    expect(log.querySelectorAll(".feed-tick")).toHaveLength(1);
    mockLive.live = newLive({ lastEvents: [...mockLive.live.lastEvents, signal("diff")] });
    result.rerender(
      <QueryClientProvider client={client}>
        <AgentDialog ws="iot" agent="dev_01" />
      </QueryClientProvider>,
    );
    await act(async () => {});
    expect(log.querySelectorAll(".feed-tick")).toHaveLength(2);
    expect(within(log).getByRole("img", { name: "diff" })).toBeInTheDocument();
  });
});

describe("decide banner", () => {
  function decisionLive(): LiveState {
    return newLive({
      agentStates: { iot: { dev_01: "idle" } },
      nodeStates: { iot: { bug_flow: { fix: "needs_decision" } } },
    });
  }

  it("renders on a needs_decision node owned by the agent, naming node + graph", async () => {
    await renderDialog({ live: decisionLive() });
    expect(await screen.findByText(/fix in bug_flow needs a decision/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rerun" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    expect(screen.queryByText(/needs a decision —/)).not.toBeInTheDocument();
  });

  it("renders when the agent is in error with a node to rule on", async () => {
    await renderDialog({
      live: newLive({
        agentStates: { iot: { dev_01: "error" } },
        nodeStates: { iot: { bug_flow: { fix: "needs_decision" } } },
      }),
    });
    expect(await screen.findByText(/fix in bug_flow needs a decision/)).toBeInTheDocument();
  });

  it("renders nothing without a needs_decision node", async () => {
    await renderDialog({ live: newLive({ agentStates: { iot: { dev_01: "error" } } }) });
    expect(screen.queryByText(/needs a decision/)).not.toBeInTheDocument();
  });

  it("surfaces a persisted needs_decision from REST rows after a fresh load", async () => {
    await renderDialog({
      live: newLive(),
      graphNodes: [
        { graph_id: "bug_flow", node_id: "fix", state: "needs_decision", attempt: 1, started_at: null, finished_at: null, error: "stale failure" },
      ],
    });
    expect(await screen.findByText(/fix in bug_flow needs a decision — stale failure/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith("iot", "bug_flow", "fix", "done"));
  });

  it("resolves ownership by role when the node has no agent_id", async () => {
    const byRole = graphWith([
      { id: "fix", role: "dev", depends_on: [], start_template: "fix it", done_when: { ack: "fix" }, on_error: "delegate", mode: "foreground" },
    ]);
    await renderDialog({ live: decisionLive(), graphs: [byRole] });
    expect(await screen.findByText(/fix in bug_flow needs a decision/)).toBeInTheDocument();
  });

  it("skips nodes owned by a different agent — the explicit agent_id wins over the shared role", async () => {
    const byOther = graphWith([
      { id: "fix", role: "dev", agent_id: "rev_01", depends_on: [], start_template: "fix it", done_when: { ack: "fix" }, on_error: "delegate", mode: "foreground" },
    ]);
    await renderDialog({ live: decisionLive(), graphs: [byOther] });
    // Settlement: the fresh-load REST probe runs only after the graphs query
    // has resolved and no SSE decision was found — under the inverted rule
    // the banner would render (role dev matches), the probe never fires, and
    // this wait fails. Only after it passes is the negative assertion
    // meaningful.
    await waitFor(() => expect(api.graphNodes).toHaveBeenCalled());
    expect(screen.queryByText(/needs a decision/)).not.toBeInTheDocument();
  });

  it("banners in the explicit agent_id owner's dialog even when the node's role is another agent's", async () => {
    const byOther = graphWith([
      { id: "fix", role: "dev", agent_id: "rev_01", depends_on: [], start_template: "fix it", done_when: { ack: "fix" }, on_error: "delegate", mode: "foreground" },
    ]);
    // The node's role is "dev" (dev_01's role) but its agent_id is rev_01:
    // the banner must follow the agent_id. findByText waits for the graphs
    // query to settle — the banner cannot render before the node defs load.
    await renderDialog({ live: decisionLive(), graphs: [byOther], agent: "rev_01", agents: [DEV, REV] });
    expect(await screen.findByText(/fix in bug_flow needs a decision/)).toBeInTheDocument();
  });

  it("shows the reason from the node's REST row when present", async () => {
    await renderDialog({
      live: decisionLive(),
      graphNodes: [
        { graph_id: "bug_flow", node_id: "fix", state: "needs_decision", attempt: 1, started_at: null, finished_at: null, error: "the fix failed" },
      ],
    });
    expect(await screen.findByText(/fix in bug_flow needs a decision — the fix failed/)).toBeInTheDocument();
  });

  it("falls back to the last step_failed error for the agent", async () => {
    await renderDialog({
      live: newLive({
        agentStates: { iot: { dev_01: "idle" } },
        nodeStates: { iot: { bug_flow: { fix: "needs_decision" } } },
        lastEvents: [signal("step_failed", { error: "timeout" })],
      }),
    });
    expect(await screen.findByText(/needs a decision — timeout/)).toBeInTheDocument();
  });

  it("Done posts the done ruling to the decide endpoint", async () => {
    await renderDialog({ live: decisionLive() });
    await screen.findByText(/fix in bug_flow needs a decision/);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith("iot", "bug_flow", "fix", "done"));
  });

  it("Rerun posts the rerun ruling to the decide endpoint", async () => {
    await renderDialog({ live: decisionLive() });
    await screen.findByText(/fix in bug_flow needs a decision/);
    fireEvent.click(screen.getByRole("button", { name: "Rerun" }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith("iot", "bug_flow", "fix", "rerun"));
  });

  it("Skip posts the skip ruling to the decide endpoint", async () => {
    await renderDialog({ live: decisionLive() });
    await screen.findByText(/fix in bug_flow needs a decision/);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith("iot", "bug_flow", "fix", "skip"));
  });

  it("surfaces a 409 from the decide endpoint in the alert pattern", async () => {
    api.decide.mockRejectedValue(new Error("not needs_decision"));
    await renderDialog({ live: decisionLive() });
    await screen.findByText(/fix in bug_flow needs a decision/);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("decide failed: not needs_decision");
  });

  it("dismisses the banner optimistically and re-arms on a fresh needs_decision", async () => {
    const { client, result } = await renderDialog({ live: decisionLive() });
    await screen.findByText(/fix in bug_flow needs a decision/);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledTimes(1));
    // The reducer has not folded the transition yet — the banner must not
    // linger, but it is the human's ruling; the SSE transition follows.
    expect(screen.queryByText(/needs a decision/)).not.toBeInTheDocument();
    // The SSE transition arrives: the node leaves needs_decision…
    mockLive.live = newLive({ agentStates: { iot: { dev_01: "idle" } }, nodeStates: { iot: { bug_flow: { fix: "done" } } } });
    result.rerender(
      <QueryClientProvider client={client}>
        <AgentDialog ws="iot" agent="dev_01" />
      </QueryClientProvider>,
    );
    await act(async () => {});
    // …and a later needs_decision on the same node re-arms the banner.
    mockLive.live = newLive({ agentStates: { iot: { dev_01: "idle" } }, nodeStates: { iot: { bug_flow: { fix: "needs_decision" } } } });
    result.rerender(
      <QueryClientProvider client={client}>
        <AgentDialog ws="iot" agent="dev_01" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/fix in bug_flow needs a decision/)).toBeInTheDocument();
  });
});