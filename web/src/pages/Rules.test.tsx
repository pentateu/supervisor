// @vitest-environment jsdom
// B6 rules page tests: the stored-rule list (id, source, confidence, active/
// approved badges, created_at), the TOML textarea add posting {"toml": …}
// with I-28 error surfacing, the reload button with success note + error
// surfacing, and the empty state. Rendered through the real component — only
// the REST api is stubbed; fixtures are real wire shapes.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/jsdom-polyfills";

import type { StoredRule } from "../api/types";
import { Rules } from "./Rules";

const { api } = vi.hoisted(() => ({
  api: { rules: vi.fn(), addRule: vi.fn(), reloadRules: vi.fn() },
}));
vi.mock("../api/endpoints", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../api/endpoints")>();
  return { ...mod, api };
});

const RULE: StoredRule = {
  id: "rule_1",
  toml: '[[rule]]\nid = "r1"',
  source: "data",
  confidence: 0.9,
  approved: true,
  active: true,
  created_at: "2026-08-16T08:00:00Z",
};

async function renderRules(rules?: StoredRule[]) {
  if (rules) api.rules.mockResolvedValue(rules);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Rules />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.rules.mockResolvedValue([]);
  api.addRule.mockResolvedValue({ rule: "rule_new", added: true });
  api.reloadRules.mockResolvedValue({ reloaded: true });
});

afterEach(() => {
  cleanup();
});

describe("Rules page", () => {
  it("lists stored rules with id, source, confidence, badges, and created_at", async () => {
    await renderRules([RULE]);
    expect(await screen.findByText("rule_1")).toBeInTheDocument();
    const row = screen.getByText("rule_1").closest(".rule");
    expect(row).toHaveTextContent("· data · conf 0.90 ·");
    expect(row).toHaveTextContent("approved");
    expect(row).toHaveTextContent("active");
    expect(row?.querySelector(".row-ts")).toHaveTextContent("2026-08-16T08:00:00Z");
  });

  it("posts the raw TOML block as {\"toml\": …} and clears the textarea on success", async () => {
    await renderRules();
    const textarea = await screen.findByLabelText("rule toml");
    fireEvent.change(textarea, { target: { value: '[[rule]]\nid = "r9"' } });
    fireEvent.click(screen.getByRole("button", { name: "add rule" }));
    await waitFor(() => expect(api.addRule).toHaveBeenCalledWith('[[rule]]\nid = "r9"'));
    await waitFor(() => expect(textarea).toHaveValue(""));
  });

  it("surfaces a 400 on invalid TOML in the alert pattern", async () => {
    api.addRule.mockRejectedValue(new Error("invalid rule toml"));
    await renderRules();
    const textarea = await screen.findByLabelText("rule toml");
    fireEvent.change(textarea, { target: { value: "not toml" } });
    fireEvent.click(screen.getByRole("button", { name: "add rule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("add rule failed: invalid rule toml");
  });

  it("posts to the reload endpoint and shows a success note", async () => {
    await renderRules();
    fireEvent.click(await screen.findByRole("button", { name: "reload" }));
    await waitFor(() => expect(api.reloadRules).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("status")).toHaveTextContent("rules reloaded");
  });

  it("surfaces a reload failure in the alert pattern", async () => {
    api.reloadRules.mockRejectedValue(new Error("cannot read rules.toml"));
    await renderRules();
    fireEvent.click(await screen.findByRole("button", { name: "reload" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("reload failed: cannot read rules.toml");
  });

  it("shows the empty state", async () => {
    await renderRules();
    expect(await screen.findByText("no rules")).toBeInTheDocument();
  });
});