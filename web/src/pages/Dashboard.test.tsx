// @vitest-environment jsdom
// B3 dashboard tests: tab shell (Live default + triage-count badge), triage
// strip (severity-sorted rows, SSE overlay, empty state, row targets), workspace
// cards (agent rows with state + queue depth + message/attach actions, fg/bg
// filter, canvas only while a workflow runs, start-workflow picker, resume),
// the collapsed off section, and the Stats tab (metrics strip, hand-rolled SVG
// time series, per-workspace/per-agent tables, shortcut links). Rendered
// through the real components — only the REST api and the live store are
// stubbed; fixtures are real wire shapes.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/jsdom-polyfills";

import type { Agent, GraphRecord, Metrics, Triage, Workspace } from "../api/types";
import type { LiveState } from "../store/reduce";
import { Dashboard } from "./Dashboard";

const { api } = vi.hoisted(() => ({
  api: {
    triage: vi.fn(),
    workspaces: vi.fn(),
    agents: vi.fn(),
    graphs: vi.fn(),
    graphNodes: vi.fn(),
    metrics: vi.fn(),
    resume: vi.fn(),
    attachAgent: vi.fn(),
    workspaceOn: vi.fn(),
    workspaceOff: vi.fn(),
    startGraph: vi.fn(),
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
}));
vi.mock("../store/live-store", () => ({ useLive: () => mockLive.live }));

const WS_ON: Workspace = {
  id: "iot",
  path: "/srv/iot",
  port: 4401,
  server_pid: 11,
  state: "on",
  cmux_ws: null,
  layout_path: null,
  updated_at: "2026-08-16T00:00:00Z",
};
const WS_OFF: Workspace = {
  ...WS_ON,
  id: "ledger",
  path: "/srv/ledger",
  port: null,
  server_pid: null,
  state: "off",
};

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
  inbox_depth: 3,
};
const REVIEWER: Agent = {
  ...DEV,
  agent_id: "rev_01",
  role: "reviewer",
  mode: "background",
  state: "working",
  inbox_depth: 0,
};

const GRAPH_DATA = JSON.stringify({
  id: "bug_flow",
  name: "bug flow",
  nodes: [
    { id: "fix", role: "dev", depends_on: [], start_template: "fix it", done_when: { ack: "fix" }, on_error: "delegate", mode: "foreground" },
  ],
});
const GRAPH_ACTIVE: GraphRecord = {
  id: "bug_flow",
  name: "bug flow",
  data: GRAPH_DATA,
  version: 1,
  active: true,
  updated_at: "2026-08-16T00:00:00Z",
};
const GRAPH_IDLE: GraphRecord = { ...GRAPH_ACTIVE, id: "other_flow", active: false };

const EMPTY_METRICS: Metrics = {
  since: "2026-08-16T00:00:00Z",
  totals: { messages_delivered: 0, errors: 0, decisions: 0, nodes_done: 0, nodes_failed: 0, tokens: 0, cost_cents: null },
  per_workspace: {},
  per_agent: {},
  time_series: [],
};

async function renderDashboard(opts: {
  workspaces?: Workspace[];
  agents?: Agent[];
  graphs?: GraphRecord[];
  triage?: Triage;
  metrics?: Metrics;
} = {}) {
  if (opts.workspaces) api.workspaces.mockResolvedValue(opts.workspaces);
  if (opts.agents) api.agents.mockResolvedValue(opts.agents);
  if (opts.graphs) api.graphs.mockResolvedValue(opts.graphs);
  if (opts.triage) api.triage.mockResolvedValue(opts.triage);
  if (opts.metrics) api.metrics.mockResolvedValue(opts.metrics);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <Dashboard />
    </QueryClientProvider>,
  );
  // Flush the ResizeObserver microtask so React Flow measures + renders nodes.
  await act(async () => {});
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLive.live = { workspaceStates: {}, agentStates: {}, permissionPending: {}, nodeStates: {}, lastEvents: [] };
  api.triage.mockResolvedValue({ agents: [], nodes: [] });
  api.workspaces.mockResolvedValue([]);
  api.agents.mockResolvedValue([]);
  api.graphs.mockResolvedValue([]);
  api.graphNodes.mockResolvedValue([]);
  api.metrics.mockResolvedValue(EMPTY_METRICS);
  api.resume.mockResolvedValue({ state: "resumed" });
  api.attachAgent.mockResolvedValue({ attach: "pane", spawned: false });
  api.workspaceOn.mockResolvedValue({ workspace: "iot", state: "on" });
  api.workspaceOff.mockResolvedValue({});
  api.startGraph.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
});

describe("Dashboard tab shell", () => {
  it("renders Live and Stats tabs with Live active by default", async () => {
    await renderDashboard({ workspaces: [WS_ON] });
    const liveTab = screen.getByRole("tab", { name: /live/i });
    const statsTab = screen.getByRole("tab", { name: /stats/i });
    expect(liveTab).toHaveAttribute("aria-selected", "true");
    expect(statsTab).toHaveAttribute("aria-selected", "false");
  });

  it("carries the triage count badge on the Live tab", async () => {
    await renderDashboard({
      triage: {
        agents: [{ ws: "iot", agent_id: "dev_01", state: "waiting_input", permission_id: null }],
        nodes: [{ ws: "iot", graph_id: "bug_flow", node_id: "fix", state: "needs_decision", error: null }],
      },
    });
    const tab = await screen.findByRole("tab", { name: /live 2/i });
    expect(tab.querySelector(".tab-badge")).toHaveTextContent("2");
  });

  it("posts to the resume endpoint from the header action", async () => {
    await renderDashboard({ workspaces: [WS_ON] });
    fireEvent.click(screen.getByRole("button", { name: "resume" }));
    await waitFor(() => expect(api.resume).toHaveBeenCalledTimes(1));
  });
});

describe("triage strip", () => {
  // The full severity ladder in a deliberately shuffled fixture (plan §7.3):
  // blocked_permission → waiting_input → needs_decision → error → failed →
  // blocked → missing_role.
  const SHUFFLED: Triage = {
    agents: [
      { ws: "iot", agent_id: "rev_01", state: "error", permission_id: null },
      { ws: "iot", agent_id: "dev_01", state: "waiting_input", permission_id: null },
      { ws: "iot", agent_id: "mem_01", state: "blocked_permission", permission_id: "p1" },
    ],
    nodes: [
      { ws: "iot", graph_id: "g", node_id: "plan", state: "missing_role", error: null },
      { ws: "iot", graph_id: "g", node_id: "test", state: "blocked", error: null },
      { ws: "iot", graph_id: "g", node_id: "ship", state: "failed", error: null },
      { ws: "iot", graph_id: "g", node_id: "fix", state: "needs_decision", error: null },
    ],
  };

  it("sorts rows by severity and shows glyph + label + ws", async () => {
    await renderDashboard({ triage: SHUFFLED });
    const strip = await screen.findByLabelText("triage");
    const labels = [...strip.querySelectorAll(".triage-label")].map((el) => el.textContent);
    expect(labels).toEqual(["mem_01", "dev_01", "g/fix", "rev_01", "g/ship", "g/test", "g/plan"]);
    const first = within(strip).getAllByRole("link")[0];
    expect(first.querySelector(".triage-glyph")).toHaveTextContent("⛔");
    expect(first).toHaveTextContent("iot");
  });

  it("links agent rows to the agent dialog and node rows to the graph", async () => {
    await renderDashboard({ triage: SHUFFLED });
    const strip = await screen.findByLabelText("triage");
    expect(within(strip).getByRole("link", { name: /dev_01/ })).toHaveAttribute("href", "#/workspaces/iot/agents/dev_01");
    expect(within(strip).getByRole("link", { name: /g\/fix/ })).toHaveAttribute("href", "#/graphs/g");
  });

  it("shows the empty state when nothing needs attention", async () => {
    await renderDashboard({ triage: { agents: [], nodes: [] } });
    expect(await screen.findByText("nothing needs attention")).toBeInTheDocument();
  });

  it("shows attention states that arrive over SSE without polling", async () => {
    mockLive.live = {
      ...mockLive.live,
      agentStates: { iot: { dev_01: "blocked_permission" } },
      nodeStates: { iot: { g: { fix: "needs_decision" } } },
    };
    await renderDashboard({ triage: { agents: [], nodes: [] } });
    const strip = await screen.findByLabelText("triage");
    expect(within(strip).getByRole("link", { name: /dev_01/ })).toBeInTheDocument();
    expect(within(strip).getByRole("link", { name: /g\/fix/ })).toBeInTheDocument();
  });

  it("drops REST rows whose state recovered over SSE", async () => {
    mockLive.live = { ...mockLive.live, agentStates: { iot: { dev_01: "idle" } } };
    await renderDashboard({
      triage: { agents: [{ ws: "iot", agent_id: "dev_01", state: "waiting_input", permission_id: null }], nodes: [] },
    });
    expect(await screen.findByText("nothing needs attention")).toBeInTheDocument();
  });
});

describe("workspace cards", () => {
  it("renders agent rows with state, queue depth, and message/attach actions", async () => {
    await renderDashboard({ workspaces: [WS_ON], agents: [DEV, REVIEWER] });
    expect(await screen.findByText("dev_01")).toBeInTheDocument();
    expect(screen.getByText("rev_01")).toBeInTheDocument();
    expect(screen.getByText("working")).toBeInTheDocument();
    expect(screen.getByText("inbox 3")).toBeInTheDocument();
    expect(screen.getByText("inbox 0")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /message/i })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "attach" })).toHaveLength(2);
  });

  it("renders a dash for the queue depth when a row lacks inbox_depth", async () => {
    const legacy = { ...DEV, inbox_depth: undefined } as unknown as Agent;
    await renderDashboard({ workspaces: [WS_ON], agents: [legacy] });
    expect(await screen.findByText("inbox —")).toBeInTheDocument();
  });

  it("filters agent rows by fg/bg mode", async () => {
    await renderDashboard({ workspaces: [WS_ON], agents: [DEV, REVIEWER] });
    expect(await screen.findByText("dev_01")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "fg" }));
    expect(screen.getByText("dev_01")).toBeInTheDocument();
    expect(screen.queryByText("rev_01")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "bg" }));
    expect(screen.getByText("rev_01")).toBeInTheDocument();
    expect(screen.queryByText("dev_01")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "all" }));
    expect(screen.getByText("dev_01")).toBeInTheDocument();
    expect(screen.getByText("rev_01")).toBeInTheDocument();
  });

  it("attach posts to the attach endpoint", async () => {
    await renderDashboard({ workspaces: [WS_ON], agents: [DEV] });
    fireEvent.click(await screen.findByRole("button", { name: "attach" }));
    await waitFor(() => expect(api.attachAgent).toHaveBeenCalledWith("iot", "dev_01"));
  });

  it("renders the live canvas only while a workflow runs", async () => {
    const { container } = await renderDashboard({ workspaces: [WS_ON], graphs: [GRAPH_ACTIVE] });
    expect(await screen.findByRole("link", { name: /bug_flow/ })).toBeInTheDocument();
    await act(async () => {});
    expect(container.querySelector(".ws-canvas .wf-node")).not.toBeNull();
    expect(screen.queryByText("no active graphs")).not.toBeInTheDocument();
  });

  it("hides the canvas and says so when no workflow runs", async () => {
    const { container } = await renderDashboard({ workspaces: [WS_ON], graphs: [GRAPH_IDLE] });
    expect(await screen.findByText("no active graphs")).toBeInTheDocument();
    expect(container.querySelector(".ws-canvas")).toBeNull();
  });

  it("start workflow posts to the start endpoint from the installed-graph picker", async () => {
    await renderDashboard({ workspaces: [WS_ON], graphs: [GRAPH_ACTIVE, GRAPH_IDLE] });
    const select = await screen.findByLabelText("start workflow");
    // Wait for the installed-graph options to load — changing a jsdom select
    // to a value that is not yet an option is a silent no-op.
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "other_flow" })).toBeInTheDocument(),
    );
    fireEvent.change(select, { target: { value: "other_flow" } });
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await waitFor(() => expect(api.startGraph).toHaveBeenCalledWith("iot", "other_flow"));
  });
});

describe("off workspaces", () => {
  it("renders off workspaces in the collapsed section, cards only for running ones", async () => {
    const { container } = await renderDashboard({ workspaces: [WS_ON, WS_OFF] });
    expect(await screen.findByText("off workspaces")).toBeInTheDocument();
    expect(container.querySelectorAll(".ws-grid .ws-card")).toHaveLength(1);
    expect(screen.getByText("ledger")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "on" })).toBeInTheDocument();
  });

  it("the on button posts to the workspace on endpoint", async () => {
    await renderDashboard({ workspaces: [WS_OFF] });
    fireEvent.click(await screen.findByRole("button", { name: "on" }));
    await waitFor(() => expect(api.workspaceOn).toHaveBeenCalledWith("ledger"));
  });

  it("renders no off section when every workspace runs", async () => {
    await renderDashboard({ workspaces: [WS_ON] });
    expect(await screen.findByText("iot")).toBeInTheDocument();
    expect(screen.queryByText("off workspaces")).not.toBeInTheDocument();
  });
});

describe("Stats tab", () => {
  const METRICS: Metrics = {
    since: "2026-08-16T00:00:00Z",
    totals: { messages_delivered: 42, errors: 1, decisions: 3, nodes_done: 9, nodes_failed: 1, tokens: 1200, cost_cents: 123 },
    per_workspace: { iot: { messages_delivered: 42, errors: 1, decisions: 3, nodes_done: 9, cost_cents: 123 } },
    per_agent: { "iot/dev_01": { messages_delivered: 40, errors: 0, decisions: 2, nodes_done: 7, cost_cents: 100 } },
    time_series: [
      { ts: "2026-08-16T01:00:00Z", messages: 10, errors: 0, cost_cents: null },
      { ts: "2026-08-16T02:00:00Z", messages: 20, errors: 1, cost_cents: 60 },
    ],
  };

  it("shows the metrics strip, the SVG time series, tables, and shortcut links", async () => {
    await renderDashboard({ workspaces: [WS_ON], metrics: METRICS });
    fireEvent.click(screen.getByRole("tab", { name: /stats/i }));
    expect(await screen.findByText("$1.23 est.")).toBeInTheDocument();
    const chart = screen.getByRole("img", { name: "messages per hour" });
    expect(chart.querySelectorAll(".ts-bar")).toHaveLength(2);
    expect(screen.getByText("per workspace")).toBeInTheDocument();
    expect(screen.getByText("per agent")).toBeInTheDocument();
    expect(screen.getByText("iot/dev_01")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Graphs" })).toHaveAttribute("href", "#/graphs");
    expect(screen.getByRole("link", { name: "Rules" })).toHaveAttribute("href", "#/rules");
    expect(screen.getByRole("link", { name: "Decisions" })).toHaveAttribute("href", "#/decisions");
    expect(screen.getByRole("link", { name: "Intake" })).toHaveAttribute("href", "#/intake");
  });
});