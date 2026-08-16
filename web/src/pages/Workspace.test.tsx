// @vitest-environment jsdom
// B4 workspace detail page tests: the route target for #/workspaces/:ws —
// controls (on / off graceful / resume) with I-28 error surfacing, the agent
// grid with the fg/bg segmented filter, the per-agent 24h hand-rolled SVG
// cost chart (24 × 1h buckets, null-cost buckets empty + "—", "est." label,
// bucketing asserted against a fixture), and the installed-graph canvases
// (live vs. idle+lastRun) with the empty note. Rendered through the real
// components — only the REST api and the live store are stubbed.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/jsdom-polyfills";

import type { Agent, GraphRecord, UsageRow } from "../api/types";
import type { Workspace as WorkspaceRecord } from "../api/types";
import type { LiveState } from "../store/reduce";
import { bucketUsage, Workspace } from "./Workspace";

const { api } = vi.hoisted(() => ({
  api: {
    workspace: vi.fn(),
    agents: vi.fn(),
    graphs: vi.fn(),
    graphNodes: vi.fn(),
    usage: vi.fn(),
    resume: vi.fn(),
    workspaceOn: vi.fn(),
    workspaceOff: vi.fn(),
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

const WS_ON: WorkspaceRecord = {
  id: "iot",
  path: "/srv/iot",
  port: 4401,
  server_pid: 11,
  state: "on",
  cmux_ws: null,
  layout_path: null,
  updated_at: "2026-08-16T00:00:00Z",
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
const GRAPH_IDLE: GraphRecord = {
  ...GRAPH_ACTIVE,
  id: "other_flow",
  active: false,
  data: JSON.stringify({ ...JSON.parse(GRAPH_DATA), id: "other_flow" }),
};

/** Epoch-hour label exactly as the chart renders it (UTC "HH:00"). */
function hourLabel(epochHour: number): string {
  return new Date(epochHour * 3_600_000).toISOString().slice(11, 16);
}

/** ISO string at the top of the given epoch hour (UTC). */
function atHour(epochHour: number): string {
  return new Date(epochHour * 3_600_000).toISOString();
}

function usageRow(agent: string, ts: string, cents: number | null): UsageRow {
  return {
    id: `${agent}-${ts}`,
    workspace_id: "iot",
    agent_id: agent,
    model: null,
    ts,
    prompt_tokens: 10,
    completion_tokens: 5,
    cost_cents: cents,
  };
}

async function renderWorkspace(opts: {
  agents?: Agent[];
  graphs?: GraphRecord[];
  usage?: UsageRow[];
  live?: Partial<LiveState>;
} = {}) {
  if (opts.agents) api.agents.mockResolvedValue(opts.agents);
  if (opts.graphs) api.graphs.mockResolvedValue(opts.graphs);
  if (opts.usage) api.usage.mockResolvedValue({ rows: opts.usage, count: opts.usage.length });
  if (opts.live) mockLive.live = { ...mockLive.live, ...opts.live };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <Workspace ws="iot" />
    </QueryClientProvider>,
  );
  // Flush the ResizeObserver microtask so React Flow measures + renders nodes.
  await act(async () => {});
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLive.live = { workspaceStates: {}, agentStates: {}, permissionPending: {}, nodeStates: {}, lastEvents: [] };
  api.workspace.mockResolvedValue(WS_ON);
  api.agents.mockResolvedValue([]);
  api.graphs.mockResolvedValue([]);
  api.graphNodes.mockResolvedValue([]);
  api.usage.mockResolvedValue({ rows: [], count: 0 });
  api.resume.mockResolvedValue({ state: "resumed" });
  api.workspaceOn.mockResolvedValue({ workspace: "iot", state: "on" });
  api.workspaceOff.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
});

describe("Workspace page — controls", () => {
  it("renders the workspace header, the agent grid, and the controls", async () => {
    await renderWorkspace({ agents: [DEV] });
    expect(await screen.findByRole("heading", { name: "iot" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "off" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "resume" })).toBeInTheDocument();
    expect(await screen.findByText("dev_01")).toBeInTheDocument();
  });

  it("posts to the workspace on endpoint when the workspace is off", async () => {
    mockLive.live = { ...mockLive.live, workspaceStates: { iot: "off" } };
    await renderWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: "on" }));
    await waitFor(() => expect(api.workspaceOn).toHaveBeenCalledWith("iot"));
  });

  it("posts to the off endpoint with graceful=true", async () => {
    await renderWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: "off" }));
    await waitFor(() => expect(api.workspaceOff).toHaveBeenCalledWith("iot", true));
  });

  it("posts to the resume endpoint", async () => {
    await renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "resume" }));
    await waitFor(() => expect(api.resume).toHaveBeenCalledTimes(1));
  });

  it("surfaces on/off/resume failures inline instead of staying silent", async () => {
    api.workspaceOn.mockRejectedValue(new Error("boom"));
    api.resume.mockRejectedValue(new Error("nope"));
    mockLive.live = { ...mockLive.live, workspaceStates: { iot: "off" } };
    await renderWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: "on" }));
    expect(await screen.findByText("on failed: boom")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "resume" }));
    expect(await screen.findByText("resume failed: nope")).toBeInTheDocument();
  });
});

describe("agent grid — fg/bg filter", () => {
  it("filters agent rows by mode, mirroring the dashboard control", async () => {
    await renderWorkspace({ agents: [DEV, REVIEWER] });
    expect(await screen.findByText("dev_01")).toBeInTheDocument();
    expect(screen.getByText("rev_01")).toBeInTheDocument();

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
});

describe("per-agent 24h cost chart", () => {
  it("fetches usage scoped to the workspace and agent with a 24h since window", async () => {
    await renderWorkspace({ agents: [DEV] });
    await waitFor(() => expect(api.usage).toHaveBeenCalled());
    const [params] = api.usage.mock.calls[0] as [{ ws: string; agent: string; since: string }];
    expect(params.ws).toBe("iot");
    expect(params.agent).toBe("dev_01");
    const since = Date.parse(params.since);
    expect(Math.abs(Date.now() - since - 24 * 3_600_000)).toBeLessThan(5_000);
  });

  it("renders 24 hourly buckets with summed cents and est. label", async () => {
    const nowHour = Math.floor(Date.now() / 3_600_000);
    const rows = [
      usageRow("dev_01", atHour(nowHour), 10),
      usageRow("dev_01", atHour(nowHour), 15),
      usageRow("dev_01", atHour(nowHour - 2), null),
    ];
    const { container } = await renderWorkspace({ agents: [DEV], usage: rows });
    const chart = await screen.findByRole("img", { name: /24h est\. cost/i });
    // Usage rows arrive over react-query — wait for the bucketed titles.
    await waitFor(() => {
      const titles = [...container.querySelectorAll(".ts-bar title")].map((t) => t.textContent);
      // Same-hour rows sum into one bucket; a null-cost bucket renders empty.
      expect(titles).toContain(`${hourLabel(nowHour)}: 25¢`);
      expect(titles).toContain(`${hourLabel(nowHour - 2)}: —`);
    });
    expect(chart.querySelectorAll(".ts-bar")).toHaveLength(24);
    expect(screen.getByText("est.")).toBeInTheDocument();
  });

  it("renders a dash, never zero, for buckets without known cost", async () => {
    const { container } = await renderWorkspace({ agents: [DEV] });
    await screen.findByRole("img", { name: /24h est\. cost/i });
    const titles = [...container.querySelectorAll(".ts-bar title")].map((t) => t.textContent);
    expect(titles).toHaveLength(24);
    expect(titles.every((t) => t === null || t!.endsWith("—"))).toBe(true);
  });
});

describe("bucketUsage", () => {
  const NOW = new Date("2026-08-16T10:45:00Z");

  it("produces 24 hourly buckets ending at the current hour", () => {
    const buckets = bucketUsage([], NOW);
    expect(buckets).toHaveLength(24);
    expect(buckets[0]?.hour).toBe("11:00"); // 23h before 10:00
    expect(buckets[23]?.hour).toBe("10:00");
    expect(buckets[0]?.cents).toBeNull();
  });

  it("sums rows into their hour buckets and marks null-cost buckets unknown", () => {
    const buckets = bucketUsage(
      [
        usageRow("dev_01", "2026-08-16T09:30:00Z", 5),
        usageRow("dev_01", "2026-08-16T09:15:00Z", 3),
        usageRow("dev_01", "2026-08-16T10:00:00Z", 2),
        usageRow("dev_01", "2026-08-16T08:00:00Z", null),
      ],
      NOW,
    );
    const byHour = Object.fromEntries(buckets.map((b) => [b.hour, b.cents]));
    expect(byHour["09:00"]).toBe(8);
    expect(byHour["10:00"]).toBe(2);
    expect(byHour["08:00"]).toBeNull();
  });

  it("drops rows outside the 24h window", () => {
    const buckets = bucketUsage([usageRow("dev_01", "2026-08-15T10:30:00Z", 99)], NOW);
    expect(buckets.every((b) => b.cents === null)).toBe(true);
  });
});

describe("installed-graph canvases", () => {
  it("renders a canvas only for graphs the reducer has seen, live when seen running", async () => {
    mockLive.live = {
      ...mockLive.live,
      nodeStates: { iot: { bug_flow: { fix: "running" } } },
    };
    const { container } = await renderWorkspace({ graphs: [GRAPH_ACTIVE, GRAPH_IDLE] });
    expect(await screen.findByRole("link", { name: /bug_flow/ })).toBeInTheDocument();
    // The never-seen installed graph gets no canvas; the seen run renders
    // live (no idle caption for a run in progress).
    expect(container.querySelectorAll(".ws-canvas")).toHaveLength(1);
    expect(container.querySelectorAll(".wf-canvas.wf-idle")).toHaveLength(0);
    expect(container.querySelectorAll(".wf-idle-caption")).toHaveLength(0);
  });

  it("shows the idle caption with the last-run time for a seen-but-finished graph", async () => {
    mockLive.live = {
      ...mockLive.live,
      nodeStates: { iot: { bug_flow: { fix: "done" } } },
    };
    api.graphNodes.mockResolvedValue([
      { graph_id: "bug_flow", node_id: "fix", state: "done", attempt: 1, started_at: null, finished_at: "2026-08-16T03:41:00Z", error: null },
    ]);
    const { container } = await renderWorkspace({ graphs: [GRAPH_ACTIVE] });
    expect(await screen.findByText(/idle — last run/)).toBeInTheDocument();
    expect(container.querySelector(".wf-canvas.wf-idle")).not.toBeNull();
  });

  it("shows an empty note instead of a blank page when no graph has run here", async () => {
    const { container } = await renderWorkspace({ graphs: [GRAPH_ACTIVE] });
    // The one-shot REST backstop runs (and finds nothing) before the note is
    // meaningful — no persisted node rows anywhere for this workspace.
    await waitFor(() => expect(api.graphNodes).toHaveBeenCalled());
    expect(await screen.findByText(/no graph/i)).toBeInTheDocument();
    expect(container.querySelector(".ws-canvas")).toBeNull();
  });

  it("renders idle canvases from REST node rows after a fresh load (no SSE replay)", async () => {
    api.graphNodes.mockResolvedValue([
      { graph_id: "bug_flow", node_id: "fix", state: "done", attempt: 1, started_at: null, finished_at: "2026-08-16T03:41:00Z", error: null },
    ]);
    const { container } = await renderWorkspace({ graphs: [GRAPH_ACTIVE] });
    // Fresh mount: the SSE ring has seen nothing, so only the one-shot REST
    // backstop can surface the persisted run — the canvas must render with
    // the idle caption for the last-run state (plan §7.4).
    expect(await screen.findByText(/idle — last run/)).toBeInTheDocument();
    expect(container.querySelector(".wf-canvas.wf-idle")).not.toBeNull();
    expect(api.graphNodes).toHaveBeenCalledWith("iot", "bug_flow");
  });

  it("routes a role-resolved node click to the agent dialog", async () => {
    mockLive.live = {
      ...mockLive.live,
      nodeStates: { iot: { bug_flow: { fix: "running" } } },
    };
    const { container } = await renderWorkspace({ graphs: [GRAPH_ACTIVE], agents: [DEV] });
    await screen.findByRole("link", { name: /bug_flow/ });
    fireEvent.click(container.querySelector('[data-id="fix"]')!);
    expect(window.location.hash).toBe("#/workspaces/iot/agents/dev_01");
  });
});