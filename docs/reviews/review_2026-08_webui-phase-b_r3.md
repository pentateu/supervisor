# Review: supervisor web UI — I-31 Phase B, round 3 (minors close-out)

**Date:** 2026-08-16
**Mode:** diff-scoped re-review of `fda2bce..2d54d34` on
`feature/webui-phase-b` (close-out round on top of `82a78b0`; 10 files,
+130/−26). Review performed in the worktree
`.worktrees/feature/webui-phase-b` — the main checkout was used only for this
report.
**Verdict:** APPROVE

## Summary

The three round-2 Minors are closed and verified. M1 (backstop race) is fixed
with a settle-once probe (`enabled: installed.length > 0` +
`staleTime: Infinity`) and two race tests pinning both interleavings; M3
(animation expiries leaking across a graph switch) is fixed with a clear
effect keyed on `graphId` plus a switch test; M2 (toolchain reconciliation) is
complete in the committed docs except for one leftover npm line in
`docs/agents/dev-orchestrator.md`. 134 vitest tests pass; `bun run build` is
green; both checkouts are clean.

## Verification performed

- `cd web && bun run test` → 134 passed (11 files). `bun run build` → green.
- Read the full round-3 diff and traced each fix against its round-2 finding.

## Round-2 minors — resolution

- **M1 (backstop race) — fixed, `web/src/pages/Workspace.tsx:208-216`.**
  The probe is now gated only on `installed.length > 0` with
  `staleTime: Infinity`, so SSE activity can no longer disable or preempt it;
  it settles exactly once and never refetches (staleTime Infinity suppresses
  focus/reconnect refetches — plan §10 held). Two new tests pin the exact
  race interleavings: the first workflow event arriving mid-fetch, and SSE
  arriving before the graphs list resolves. Both assert the persisted
  graph's canvas still renders (2 canvases, idle caption). Correct.
- **M3 (expiries across a graph switch) — fixed,
  `web/src/lib/use-graph-live.ts:108-117`.**
  A `[graphId]` effect clears the expiry map and `inFlight` on switch,
  declared before the event effect so a genuine event for the new graph
  already in the ring still animates after the clear. The new test switches
  from graph "a" to "b" (same coincident edge id `gate-a2`), asserts the
  expiry does not carry over, then asserts a fresh event on "b" animates.
  Correct.
- **M2 (bun reconciliation) — fixed with one leftover.**
  `web/bun.lock` is committed, `package-lock.json` removed, and
  HANDOFF.md, README.md, docs/agents/reviewer.md, the web-UI spec, and both
  plans now document `bun run test && bun run build` (the polish plan's
  open "npm vs Bun" question is marked resolved). Leftover:
  `docs/agents/dev-orchestrator.md:67` still reads `cd web && npm run test
  && npm run build` — update that one line. Note: the close-out message
  claims AGENTS.md was updated; AGENTS.md is not tracked in this repo (it is
  a local untracked file in the main checkout and does not exist in the
  worktree), so the branch cannot and did not touch it — the local copy
  still says npm. If bun is now canonical, update that local file at merge
  time.

## Findings

### Minor

- **dev-orchestrator.md:67** — the dev agent's dispatch contract still
  documents the npm verify commands while every other committed doc says
  bun. One-line edit.

## What is correct

- The M1 fix's one-shot property genuinely holds (no refetchInterval, no
  focus refetch, no mount refetch after first settle); SSE stays the live
  authority as before.
- The M3 fix covers both directions: no leak into the new graph, and no
  suppression of genuine new-graph events at switch time.
- The new tests fail under the old code for the reasons stated in their
  comments (the enabled-gate flip, the expiry carry-over) — verified by
  tracing, and the suite is green under the new code.

## Coverage and gaps

- No specialist dispatch for this round: 130 changed lines, every line traced
  by the orchestrator against its round-2 finding, with the new tests
  exercised (134 green). No dimension left unreviewed that this diff touches.

## Design alignment

- Conforms: the toolchain docs are now consistent with the actual toolchain
  (bun.lock), and the race-prone gating the round-2 review flagged is gone.
  The one dev-orchestrator.md line and the untracked AGENTS.md copy are
  housekeeping, not design questions.
