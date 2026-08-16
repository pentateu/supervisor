# Review: supervisor web UI — I-31 Phase B, round 2 (fix round)

**Date:** 2026-08-16
**Mode:** diff-scoped re-review of `6de07c5..82a78b0` on `feature/webui-phase-b`
(fix round on top of `975c609`; 15 files, +760/−3334 — most deletions are the
package-lock removal). Review performed in the worktree
`.worktrees/feature/webui-phase-b` — the main checkout was used only for this
report.
**Verdict:** APPROVE

## Summary

All six blocking findings from round 1 are fixed and verified: the decide
banner ownership rule is now agent_id-first in both paths with tests that wait
for settlement (and fail under the old inverted rule), the edge-animation
expiry no longer dies under bus traffic, the react-query key collision is
gone, the metrics fixtures mirror the daemon wire, fresh-load idle canvases
render via a one-shot REST backstop, and the cross-workspace merge comment is
corrected. 131 vitest tests pass; both `npm run build` and `bun run build` are
green. Three Minor notes remain, none blocking.

## Verification performed

- Tests: `cd web && npm run test` → 131 passed (11 files), green.
- Build: `npm run build` → green; `bun run build` → green (chunk-size warning
  only, pre-existing).
- Read the full round-2 diff (632 lines of source/test/CSS) and traced every
  fix against the round-1 finding it claims to address.

## Round-1 findings — resolution

| R1 finding | Fix commit | Verified |
|---|---|---|
| C1 decide-banner ownership inverted + vacuous test | 6de07c5 | **Fixed.** `if (node.agent_id ? node.agent_id !== agent : node.role !== role) continue;` in both paths (Agent.tsx:118, :148) — matches the stated contract and Dashboard's `resolveTriageHref`. The skip test now waits on a settlement marker (`waitFor(api.graphNodes called)`), which under the old inverted rule fails (the decision would be non-null, the `nodeRows` query would satisfy the wait, and the banner would be found). New positive test covers the agent_id-owner-with-foreign-role case. |
| I1 stale edge animations under traffic | 6de07c5 | **Fixed.** Expiry is now a per-edge deadline in a ref map, pruned by a fixed 250 ms interval independent of the event effect (`use-graph-live.ts:126-152`). Unrelated events can no longer cancel a pending clear; a repeated event extends its edge's window. New fake-timer test interleaves an unrelated heartbeat inside the 4 s window and asserts the edge clears at ~4 s. |
| I2 react-query key collision | 6de07c5 | **Fixed.** The dialog probe key is `["graphNodesForWs", ws]` — different array length and first element from every `use-graph-live` key (`["graphNodes", id, ws ?? "all"]`), so no collision is possible. |
| I3 metrics fixtures invent wire fields | 746c6ff | **Fixed.** Fixtures now mirror api.rs exactly (`per_workspace` = {decisions, tokens, cost_cents}; `per_agent` = {}); the always-dead columns (messages/errors/nodes-done) are dropped from `MetricsTable`; new tests assert the exact column set and the per-agent "no data yet" empty state. |
| I4 fresh-load idle canvases | 6de07c5 | **Fixed.** A one-shot `["wsNodeRows", ws]` REST backstop adds persisted `graph_id`s to the seen set when the SSE ring has seen nothing for the workspace (Workspace.tsx:190-208). New test: fresh mount with persisted rows renders the canvas with the idle/last-run caption (plan §7.4). |
| I5 cross-ws merge comment wrong | 6de07c5 | **Fixed.** The comment now states the merge is last-writer-wins and arbitrary under concurrent runs, and that the limitation predates the branch. |
| Minors (badge lag, loop_back clear, spinner/dot labels, contrast, `!`, feed toggle, locale) | 6de07c5, 746c6ff | **Fixed and tested.** Card badge counts live states including `error` (2 new tests); "clear loop_back" shows for partially-filled objects (test); spinner/dot carry `role="img"` + aria-labels (test); `--dim` for the missing_role glyph (≈5.5:1); the `!` assertion replaced with a guard; the expand toggle moved outside the aria-live log; feed times render via a locale-independent `hhmm()`. |

## New findings

### Minor

- **M1. Backstop race (Workspace.tsx:194-199).** The REST backstop is
  disabled once `sseSeen.size > 0`. If the first workflow event for the
  workspace arrives while the probe fetch is still in flight, react-query
  cancels the probe and a second graph that ran before the page load gets no
  canvas until it runs again this session. Narrow window (one mount, one
  fetch), self-healing on next run. Consider leaving the probe enabled until
  it has settled once (`enabled: installed.length > 0` with a `staleTime` or
  a `settled` ref) instead of tying it to SSE activity.
- **M2. Lockfile swap contradicts the documented toolchain.** Commit 82a78b0
  removes `web/package-lock.json` for `bun.lock`. The repo convention
  (`AGENTS.md` verify section) documents `cd web && npm run test && npm run
  build`; there is no CI config today. Both toolchains build and test green,
  so nothing breaks today, but `npm ci` is now impossible and a future npm
  install regenerates a second lockfile. Reconcile one way: keep the npm
  lockfile, or update AGENTS.md/HANDOFF.md to bun and commit to it.
- **M3. Animation expiries outlive a graph switch (use-graph-live.ts:126-152).**
  The `expiries` map is per hook instance, not per graph id. When the Graphs
  page switches between graphs in the same mounted hook, edges of the
  previous graph with coincident ids (`dep-node`) can animate the new graph's
  canvas for the remainder of their ≤4 s window. Cosmetic, self-expiring;
  r1 had the same property.

## What is correct

- The C1 test construction is now sound in both directions: the settlement
  marker can only be satisfied by the probe when the ownership rule correctly
  returns null, and the new positive test pins the agent_id-first behavior.
- The I1 mechanism has no cancellation path left: expiry pruning is
  independent of event traffic, and the interval cleanup on unmount is
  present. The new test reproduces the exact r1 failure interleaving.
- The Workspace backstop query is one-shot (no polling — plan §10 held) and
  its key cannot collide with the other node-row queries.
- No new polling, no `any`, no debug leftovers, no secrets in the round-2
  diff; contamination check clean in both checkouts (only this report file is
  new in the main repo).

## Coverage and gaps

- No fresh specialist dispatch for this round: the diff is a fix round whose
  every line maps to a round-1 finding that was already validated by
  specialists and by the orchestrator. Each fix was traced against its
  finding; the two genuinely new mechanisms (interval pruning, REST backstop)
  were traced line by line and exercised by the new tests (131 green).
- Not re-reviewed in depth: the r1-reviewed surfaces untouched by this round
  (reducer, triage overlay, property panel, intake/rules, CSS not in the
  diff). Docs unchanged in this round; r1 doc verdict stands.

## Design alignment

- All r1 deviations are resolved or documented: ownership matches the plan
  §7.5 contract, the workspace page now satisfies plan §7.4's idle-canvas
  path, metrics render exactly the wire, and the merge limitation is
  documented as pre-existing. The lockfile question (M2) is the one open
  convention choice; the human or dev can settle it without re-review.
