// @vitest-environment jsdom
// B6 intake page tests: rows with kind/title/severity/graph link/received_at
// from GET /api/v1/intake; — for a missing severity and no link when
// graph_id is null; the empty state. Rendered through the real component —
// only the REST api is stubbed; fixtures are real wire shapes.

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/jsdom-polyfills";

import type { IntakeItem } from "../api/types";
import { Intake } from "./Intake";

const { api } = vi.hoisted(() => ({
  api: { intake: vi.fn() },
}));
vi.mock("../api/endpoints", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../api/endpoints")>();
  return { ...mod, api };
});

const BUG: IntakeItem = {
  id: "int_01",
  source: "github",
  kind: "bug",
  title: "crash on save",
  body: "repro steps",
  severity: "high",
  refs: [],
  graph_id: "bug_flow",
  received_at: "2026-08-16T09:00:00Z",
};
const FEEDBACK: IntakeItem = {
  ...BUG,
  id: "int_02",
  source: "app-feedback",
  kind: "feedback",
  title: "liking the dark theme",
  severity: null,
  graph_id: null,
};

async function renderIntake(items?: IntakeItem[]) {
  if (items) api.intake.mockResolvedValue(items);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Intake />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.intake.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("Intake page", () => {
  it("renders a row per item with kind, title, severity, graph link, received_at", async () => {
    await renderIntake([BUG]);
    expect(await screen.findByText("crash on save")).toBeInTheDocument();
    expect(screen.getByText("bug")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "bug_flow" });
    expect(link).toHaveAttribute("href", "#/graphs/bug_flow");
    expect(screen.getByText("2026-08-16T09:00:00Z")).toBeInTheDocument();
  });

  it("renders — for a missing severity and no graph link when graph_id is null", async () => {
    await renderIntake([FEEDBACK]);
    expect(await screen.findByText("liking the dark theme")).toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    await renderIntake();
    expect(await screen.findByText("no intake items")).toBeInTheDocument();
  });
});