// @vitest-environment jsdom
// B6 property-panel tests: every field edit flows through the pure
// graph-edit helpers into the saved GraphDef JSON — role/agent_id/
// start_template, done_when ack/approved/match, on_error (delegate/skip as
// strings, rerun as {rerun:{max:N}}, never a raw "rerun" string), gate
// nulling, loop_back on/small/big (+ clear affordance nulling), mode,
// timeout_secs nulling. The page is rendered through the real component
// (live + edit canvases); only the REST api and the live store are stubbed.

import { act, cleanup, fireEvent, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/jsdom-polyfills";

import type { GraphDef, GraphRecord, NodeDef } from "../api/types";
import type { LiveState } from "../store/reduce";
import { Graphs } from "./Graphs";

const { api } = vi.hoisted(() => ({
  api: { graphs: vi.fn(), graphNodes: vi.fn(), saveGraph: vi.fn() },
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

const NODE: NodeDef = {
  id: "fix",
  role: "dev",
  agent_id: "dev_01",
  depends_on: [],
  start_template: "fix it",
  done_when: { ack: "fix" },
  on_error: "delegate",
  mode: "foreground",
};

const GRAPH: GraphRecord = {
  id: "bug_flow",
  name: "bug flow",
  data: JSON.stringify({ id: "bug_flow", name: "bug flow", nodes: [NODE] }),
  version: 1,
  active: true,
  updated_at: "2026-08-16T00:00:00Z",
};

async function renderEditor(): Promise<RenderResult> {
  api.graphs.mockResolvedValue([GRAPH]);
  api.graphNodes.mockResolvedValue([]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <Graphs id="bug_flow" />
    </QueryClientProvider>,
  );
  // The react-query promise settles on a macrotask; wait for the editor to
  // mount (its section renders only once the graph query resolves).
  await screen.findByText("bug_flow — edit");
  await act(async () => {});
  return result;
}

/** Click the node in the EDIT canvas (the live canvas has no panel). */
function selectNode(container: HTMLElement) {
  const node = container.querySelector(".editor-canvas [data-id='fix']");
  expect(node).not.toBeNull();
  fireEvent.click(node!);
}

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Click save and return the GraphDef JSON the endpoint received. */
async function save(expectedCalls = 1): Promise<GraphDef> {
  fireEvent.click(screen.getByRole("button", { name: "save" }));
  await waitFor(() => expect(api.saveGraph).toHaveBeenCalledTimes(expectedCalls));
  const data = api.saveGraph.mock.calls[expectedCalls - 1][1] as string;
  return JSON.parse(data) as GraphDef;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLive.live = { workspaceStates: {}, agentStates: {}, permissionPending: {}, nodeStates: {}, lastEvents: [] };
});

afterEach(() => {
  cleanup();
});

describe("editor property panel", () => {
  it("opens the panel on node select and edits role, agent_id, start_template", async () => {
    const { container } = await renderEditor();
    selectNode(container);
    expect(screen.getByLabelText("start_template")).toBeInTheDocument();
    change("role", "tester");
    change("agent_id", "tst_01");
    change("start_template", "test the fix");
    const graph = await save();
    expect(graph.nodes[0]).toMatchObject({
      role: "tester",
      agent_id: "tst_01",
      start_template: "test the fix",
    });
  });

  it("nulls agent_id when cleared", async () => {
    const { container } = await renderEditor();
    selectNode(container);
    change("agent_id", "");
    const graph = await save();
    expect(graph.nodes[0].agent_id).toBeNull();
  });

  it("edits done_when ack, approved, and match", async () => {
    const { container } = await renderEditor();
    selectNode(container);
    change("done_when.ack", "fix2");
    fireEvent.click(screen.getByLabelText("done_when.approved"));
    change("done_when.match", "LGTM");
    const graph = await save();
    expect(graph.nodes[0].done_when).toEqual({ ack: "fix2", approved: true, match: "LGTM" });
  });

  it("writes on_error skip and delegate as plain strings", async () => {
    const { container } = await renderEditor();
    selectNode(container);
    change("on_error", "skip");
    expect(await save().then((g) => g.nodes[0].on_error)).toBe("skip");
    change("on_error", "delegate");
    const graph = await save(2);
    expect(graph.nodes[0].on_error).toBe("delegate");
  });

  it("writes on_error rerun as {rerun:{max:N}} and edits the max — never a raw string", async () => {
    const { container } = await renderEditor();
    selectNode(container);
    change("on_error", "rerun");
    change("on_error.max", "5");
    const graph = await save();
    expect(graph.nodes[0].on_error).toEqual({ rerun: { max: 5 } });
    expect(graph.nodes[0].on_error).not.toBe("rerun");
  });

  it("edits gate and nulls it when cleared", async () => {
    const { container } = await renderEditor();
    selectNode(container);
    change("gate", "manager");
    expect((await save()).nodes[0].gate).toBe("manager");
    change("gate", "");
    const graph = await save(2);
    expect(graph.nodes[0].gate).toBeNull();
  });

  it("writes loop_back small/big and drops an empty on", async () => {
    const { container } = await renderEditor();
    selectNode(container);
    change("loop_back.small", "fix");
    change("loop_back.big", "fix");
    change("loop_back.on", "");
    const graph = await save();
    expect(graph.nodes[0].loop_back).toEqual({ small: "fix", big: "fix" });
  });

  it("clears loop_back to null via the clear affordance when every field is empty", async () => {
    const { container } = await renderEditor();
    selectNode(container);
    change("loop_back.small", "fix");
    change("loop_back.small", "");
    expect(screen.getByRole("button", { name: "clear loop_back" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "clear loop_back" }));
    const graph = await save();
    expect(graph.nodes[0].loop_back).toBeNull();
  });

  it("edits mode and timeout_secs, nulling timeout when cleared", async () => {
    const { container } = await renderEditor();
    selectNode(container);
    change("mode", "background");
    change("timeout_secs", "120");
    let graph = await save();
    expect(graph.nodes[0].mode).toBe("background");
    expect(graph.nodes[0].timeout_secs).toBe(120);
    change("timeout_secs", "");
    graph = await save(2);
    expect(graph.nodes[0].timeout_secs).toBeNull();
  });

  it("produces the exact full NodeDef JSON with every field edited", async () => {
    const { container } = await renderEditor();
    selectNode(container);
    change("role", "tester");
    change("agent_id", "tst_01");
    change("start_template", "test the fix");
    change("done_when.ack", "tst_01");
    fireEvent.click(screen.getByLabelText("done_when.approved"));
    change("done_when.match", "banner: PASS");
    change("on_error", "rerun");
    change("on_error.max", "3");
    change("gate", "manager");
    change("loop_back.small", "fix");
    change("loop_back.big", "fix");
    change("mode", "background");
    change("timeout_secs", "300");
    const graph = await save();
    expect(graph.nodes[0]).toEqual({
      id: "fix",
      role: "tester",
      agent_id: "tst_01",
      depends_on: [],
      start_template: "test the fix",
      done_when: { ack: "tst_01", approved: true, match: "banner: PASS" },
      on_error: { rerun: { max: 3 } },
      gate: "manager",
      loop_back: { small: "fix", big: "fix" },
      mode: "background",
      timeout_secs: 300,
    });
  });
});