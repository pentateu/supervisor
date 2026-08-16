// @vitest-environment jsdom
// B2 canvas tests: state glyphs (never color-only), loop_back edges,
// on_error tags, and the idle prop. Rendered through the real React Flow
// canvas — no mocks of the component under test.

import { act, cleanup, fireEvent, render, screen, type RenderResult } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../test/jsdom-polyfills";

import type { GraphDef } from "../api/types";
import { WorkflowCanvas } from "./WorkflowCanvas";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// React Flow measures nodes via ResizeObserver after mount; the measurement
// gates node visibility and edge rendering. Flush those microtasks.
async function renderCanvas(ui: React.ReactElement): Promise<RenderResult> {
  const result = render(ui);
  await act(async () => {});
  return result;
}

const GRAPH: GraphDef = {
  id: "g",
  name: "g",
  nodes: [
    {
      id: "a1",
      role: "dev",
      depends_on: [],
      start_template: "do it",
      done_when: { ack: "a1" },
      on_error: "delegate",
      mode: "foreground",
    },
    {
      id: "a2",
      role: "reviewer",
      depends_on: ["a1"],
      start_template: "do it",
      done_when: { ack: "a2" },
      on_error: "skip",
      mode: "foreground",
    },
    {
      id: "gate",
      role: "designer",
      depends_on: ["a2"],
      start_template: "submit the plan",
      done_when: { ack: "gate", approved: true },
      on_error: { rerun: { max: 2 } },
      mode: "foreground",
      gate: "manager",
      loop_back: { on: "needs_revision", small: "gate", big: "a2" },
    },
    {
      id: "b1",
      role: "tester",
      depends_on: ["gate"],
      start_template: "test it",
      done_when: { ack: "b1" },
      on_error: "delegate",
      mode: "foreground",
    },
    {
      id: "b2",
      role: "dev",
      depends_on: ["b1"],
      start_template: "polish",
      done_when: { ack: "b2" },
      on_error: "delegate",
      mode: "foreground",
    },
  ],
};

describe("WorkflowCanvas state glyphs", () => {
  it("renders a glyph with the state in its aria-label for every state (never color-only)", async () => {
    await renderCanvas(
      <WorkflowCanvas
        graph={GRAPH}
        mode="live"
        nodeStates={{ a1: "done", a2: "failed", gate: "blocked", b1: "needs_decision", b2: "missing_role" }}
      />,
    );
    expect(screen.getByRole("img", { name: "done" })).toHaveTextContent("✓");
    expect(screen.getByRole("img", { name: "failed" })).toHaveTextContent("✕");
    expect(screen.getByRole("img", { name: "blocked" })).toHaveTextContent("⛔");
    expect(screen.getByRole("img", { name: "needs_decision" })).toHaveTextContent("!");
    expect(screen.getByRole("img", { name: "missing_role" })).toHaveTextContent("⚠");
  });

  it("marks a ready node with a pulsing indicator carrying the state name", async () => {
    await renderCanvas(<WorkflowCanvas graph={GRAPH} mode="live" nodeStates={{ a1: "ready" }} />);
    expect(screen.getByRole("img", { name: "ready" })).toBeInTheDocument();
  });
});

describe("WorkflowCanvas on_error tag", () => {
  it("renders delegate, skip, and rerun ×N chips", async () => {
    await renderCanvas(<WorkflowCanvas graph={GRAPH} mode="live" />);
    expect(screen.getAllByText("on_error: delegate").length).toBeGreaterThan(0);
    expect(screen.getByText("on_error: skip")).toBeInTheDocument();
    expect(screen.getByText("on_error: rerun ×2")).toBeInTheDocument();
  });
});

describe("WorkflowCanvas loop_back edges", () => {
  it("draws one dashed loop_back edge per existing target, labeled small/big", async () => {
    const { container } = await renderCanvas(<WorkflowCanvas graph={GRAPH} mode="live" />);
    // 4 depends_on edges + 2 loop_back edges (gate→gate, gate→a2).
    expect(container.querySelectorAll(".react-flow__edge")).toHaveLength(6);
    expect(screen.getByText("small")).toBeInTheDocument();
    expect(screen.getByText("big")).toBeInTheDocument();
  });

  it("animates a loop_back edge only while a LoopBack event is in flight", async () => {
    const { container, rerender } = await renderCanvas(<WorkflowCanvas graph={GRAPH} mode="live" />);
    expect(container.querySelector('[data-id="gate-a2"]')).not.toHaveClass("animated");
    // Controlled updates re-register nodes (measured state resets); flush the
    // measurement microtasks again so edges re-render.
    rerender(<WorkflowCanvas graph={GRAPH} mode="live" animatingEdges={["gate-a2"]} />);
    await act(async () => {});
    expect(container.querySelector('[data-id="gate-a2"]')).toHaveClass("animated");
  });
});

describe("WorkflowCanvas idle prop", () => {
  it("shows the idle caption, suppresses spinners, and stays clickable", async () => {
    const onNodeClick = vi.fn();
    const { container } = await renderCanvas(
      <WorkflowCanvas
        graph={GRAPH}
        mode="live"
        nodeStates={{ a1: "running" }}
        agentStates={{ dev: "working" }}
        idle
        lastRun="3:41 PM"
        onNodeClick={onNodeClick}
      />,
    );
    expect(screen.getByText("idle — last run 3:41 PM")).toBeInTheDocument();
    expect(container.querySelector(".wf-spinner")).not.toBeInTheDocument();
    fireEvent.click(container.querySelector('[data-id="a1"]')!);
    expect(onNodeClick).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), undefined);
  });

  it("hides the caption when no last run time is known", async () => {
    await renderCanvas(<WorkflowCanvas graph={GRAPH} mode="live" idle />);
    expect(screen.queryByText(/idle — last run/)).not.toBeInTheDocument();
  });
});
