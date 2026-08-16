# Review: supervisor web UI — I-31 Phase B (web/)

**Date:** 2026-08-16
**Mode:** diff-scoped review of `6fec772..975c609` on `feature/webui-phase-b`
(8 commits, 29 files, +4736/−175). Review performed in the worktree
`.worktrees/feature/webui-phase-b` (tests, builds, code reads) — the main
checkout was used only for this report.
**Verdict:** BLOCK

## Summary

Phase B delivers B1–B6 as planned: SSE-driven node states with no polls, canvas
glyphs/loop_back/on_error/idle, the Live/Stats dashboard with triage strip,
the workspace detail page, the agent activity feed + decide banner, intake/
rules pages, and the full editor property panel. 122 vitest tests and the
build are green, and the backend wire contract was integrated correctly
(workflow bus events, triage/decide/intake/rules/usage endpoints all match the
TS types). One Critical defect blocks: the decide banner's ownership rule is
inverted in `Agent.tsx` (a `needs_decision` node explicitly owned by another
agent still banners in any dialog whose agent shares the node's role), and the
test meant to cover it passes vacuously because it asserts before react-query
settles. Five Important findings follow, all verified by tracing or by running
read-only probes.

## Verification performed

- Tests: `cd web && npm run test` → 122 passed (11 files), no act() warnings
  (claimed 24 → 122 across the branch; consistent with the diff).
- Build: `cd web && npm run build` → green (one chunk-size warning >500 kB,
  pre-existing — React Flow).
- Wire contract (verified in main repo, read-only): `BusEvent::Workflow
  { workspace_id, event }` (crates/supervisor-core/src/event.rs) with
  `WorkflowEvent` serde `tag="event"`/`snake_case` (dag.rs:226) — matches
  `web/src/api/types.ts` exactly; `MissingRole` is a surface-only marker the
  engine never sets (types.rs:98-116, services/workflow.rs:584) — matches the
  spec §5.1 text; `OnError::Delegate` (default) → `NeedsDecision` (dag.rs:595)
  — matches the plan F1 note; endpoints triage/decide/intake/rules/
  rules/reload/usage/agents(inbox_depth)/metrics verified against
  crates/supervisor-daemon/src/api.rs handlers.
- Lint leftovers: no `console.log`/`dbg!`/`TODO`, no secrets, no `any` in the
  changed TS.
- Contamination check: worktree and main checkout `git status` unchanged from
  the start of the review (main checkout's pre-existing agent-doc edits
  untouched).

## Findings

### Critical

**C1. Decide-banner ownership rule is inverted; its test passes vacuously**
- Location: `web/src/pages/Agent.tsx:109` (live path) and `:135` (REST
  fallback); vacuous test `web/src/pages/Agent.test.tsx:272-278`.
- What is wrong: the skip condition `if (node.agent_id !== agent &&
  node.role !== role) continue;` skips a node only when *neither* the
  agent_id nor the role matches. The stated contract (comment in Agent.tsx:82,
  and the plan §7.5 ownership rule) is: explicit `agent_id` wins; role
  matching is the fallback for nodes *without* an agent_id. Dashboard.tsx
  implements the rule correctly (`node.agent_id ?? agents.find(a => a.role
  === node.role)?.agent_id`, Dashboard.tsx:188); Agent.tsx does not.
- Concrete failure scenario: node `fix` with `agent_id: "rev_01"`,
  `role: "dev"`, state `needs_decision`. Open `dev_01`'s dialog (role `dev`).
  Once the agents/graphs queries settle, the condition is `"rev_01" !==
  "dev_01" && "dev" !== "dev"` = false → the banner renders with
  Done/Rerun/Skip for another agent's node, in every dialog whose agent shares
  the role. The covering test stays green because it asserts with synchronous
  `queryByText` right after one `act` flush, before the queries settle (role
  then falls back to the agent id `"dev_01"`, which makes the skip condition
  true by accident). Probed from an isolated temp copy (no worktree writes):
  banner absent after one act flush, present after two — the test would fail
  if its data had settled.
- How it was verified: two independent specialists (boolean trace +
  empirical probe), plus orchestrator code trace. Confidence: certain.
- Suggested fix: `if (node.agent_id ? node.agent_id !== agent : node.role
  !== role) continue;` in both paths; rewrite the test to wait for
  settlement (e.g. `await screen.findByText(...)` on a settled marker) before
  the negative assertion.

### Important

**I1. Transient edge animations go stale indefinitely under bus traffic**
- Location: `web/src/lib/use-graph-live.ts:94-115`.
- What is wrong: the 4s clear for `animatingEdges` is a `setTimeout` whose
  cleanup (`clearTimeout`) runs before every effect re-invocation, and the
  effect re-runs on *every* bus event (`lastEvents` is a new array each
  reduce). Any unrelated event within the 4s window (a heartbeat/signal —
  constant in a live fleet) cancels the pending clear; the new run returns
  early without scheduling a new one; `inFlight` keeps the edge ids
  indefinitely. The same happens from the Graphs page's 5s graph-def refetch.
- Concrete failure scenario: `loop_back` fires at t=0 (edge animates); a
  signal event arrives at t=1s → timer cancelled, no replacement → the
  dashed violet edge keeps animating forever, violating plan §7.2 ("a few
  seconds, then clear"). Probed with fake timers by the test reviewer
  (mid-window event → edges still set at t+7000).
- Suggested fix: per-edge timers that are not cancelled by unrelated
  re-runs, or derive `inFlight` from event timestamps instead of effect
  cleanup.

**I2. react-query key collision when a workspace id equals a graph id**
- Location: `web/src/pages/Agent.tsx:121` (`["graphNodes", ws, "all"]`) vs
  `web/src/lib/use-graph-live.ts:54` (`["graphNodes", graphId, ws ?? "all"]`).
- What is wrong: for ws `"g"` and graph `"g"` viewed without a workspace
  (Graphs page), both keys are `["graphNodes","g","all"]` in the one global
  QueryClient, with different queryFns and scopes. Demonstrated against the
  installed react-query 5.59: the second observer receives the first query's
  payload, then its refetch overwrites the cache for both.
- Concrete failure scenario: the Agent dialog's fresh-load `restDecision` for
  ws "g" receives only graph-"g" rows — a persisted needs_decision in another
  graph never surfaces; the Graphs-page canvas for graph "g" receives
  all-graphs-for-ws-"g" rows and maps foreign node states onto the canvas.
- Suggested fix: non-overlapping key shapes (e.g. `["graphNodesForWs", ws]`
  for the dialog probe).

**I3. Metrics test fixtures invent wire fields the daemon never sends**
- Location: `web/src/pages/Dashboard.test.tsx:437-461`; daemon truth at
  `crates/supervisor-daemon/src/api.rs:1084-1090`.
- What is wrong: the metrics handler emits `per_workspace` entries with only
  `{decisions, tokens, cost_cents}` and `per_agent: {}` always. The fixtures
  add `messages_delivered`/`errors`/`nodes_done` per workspace and invent a
  per-agent row, so the tests assert a UI state that cannot occur in
  production: the per-agent table always shows "no data yet" and three of the
  five per-workspace columns always show "—".
- Concrete failure scenario: the per-workspace/per-agent table rendering can
  break and no test fails; operators see permanently empty columns the UI
  promises.
- Suggested fix: mirror the wire in the fixtures (and assert the empty
  per-agent state), or enrich the endpoint; decide whether the dead columns
  should render at all.

**I4. Fresh load: the workspace page never renders idle canvases**
- Location: `web/src/pages/Workspace.tsx:198-199` (seen-set from
  `live.nodeStates[ws]` only).
- What is wrong: canvases are gated on graphs the SSE reducer has seen *this
  session*. The ring has no replay, so a graph that ran before the page
  loaded renders no canvas, and the page shows "no graphs have run in this
  workspace yet" — actively false. Plan §7.4 requires installed-graph
  canvases with the `idle` prop for last-run states; the idle path is
  unreachable on any fresh load (the dev added an F3-style REST backstop for
  the decide banner in Agent.tsx but not here, though
  `GET /graphs/{id}/nodes?ws=` returns the persisted rows needed).
- Suggested fix: derive the seen set from the REST node-state rows
  (F3-style backstop), falling back to SSE keys.

**I5. Graphs-page cross-workspace merge is ambiguous; the new comment is wrong**
- Location: `web/src/lib/use-graph-live.ts:41-48, 63-71`.
- What is wrong: with no ws (Graphs page), the SSE overlay merges all
  workspaces' states for a graph id with `Object.assign`, and the REST
  snapshot (`node_states_all`, api.rs:566) does the same last-row-wins.
  Graph definitions are global and one graph can run in several workspaces
  (state.rs keys node states by (ws, graph, node)), so the merged canvas is
  arbitrary. The comment claims graph ids are workspace-scoped and the merge
  "is unambiguous in practice" — that claim is false. The ambiguity predates
  this branch (the old 2s poll reduced the same way), but the comment is new
  and wrong.
- Suggested fix: at minimum correct the comment; ideally key merged states by
  `workspace_id` (rows carry it) and render per-workspace, or drop the no-ws
  live view.

### Minor

Grouped by theme.

- **Stale/incorrect counts:** the per-card "⚠ N awaiting input/approval" uses
  REST agent state (Dashboard.tsx:269) — lags the live strip up to 3s and
  excludes `error` agents the strip counts. The `permission_id` pass-through
  in `buildTriage` (M2) has no real producer — the daemon hardcodes
  `permission_id: null` in triage (api.rs:667).
- **Workspace page:** state defaults to `"off"` until the workspace query
  settles (Workspace.tsx:170) — `on`-button flicker for an on-workspace
  (daemon `on()` is idempotent, so harmless).
- **Editor panel:** the "clear loop_back" button only appears when all
  loop_back fields are empty; a partially-filled loop_back cannot be cleared
  through the affordance (must empty the fields manually first).
- **Canvas:** the running spinner and the corner agent-state dot are
  motion/`title`-only cues (no aria-label) — screen readers cannot tell a
  running node from a pending one; `missing_role` glyph contrast ≈3.8:1
  (styles.css:236); `!` non-null assertion at WorkflowCanvas.tsx:256; the
  `compact` prop is unused (spec §6.1 said the dashboard uses compact — the
  full-height card canvas looks deliberate, but the spec line is unmet).
- **A11y patterns:** dash tabs have no arrow-key handling/aria-controls (APG
  tab conformance nit); the fg/bg segmented controls use `aria-pressed`
  toggle semantics for a single-select (a radiogroup would be more accurate);
  per-bar chart values are hover-only (`<title>`), not keyboard-reachable.
- **Agent dialog:** the feed expand button sits inside the `aria-live` log
  (announcement noise on toggle); the feed receipt-time test regex
  (Agent.test.tsx:172) is locale-dependent (`toLocaleTimeString`).
- **GET failure states:** every page renders a misleading empty state when
  its GET fails ("no rules", "no intake items", "No workspaces yet — run
  `supervisor add <path>`"). This is the polish plan's acknowledged
  "Failure states" row, not claimed done here — recorded so it is not
  silently forgotten; the I-28 mutation surfacing is complete.
- **Live/Stats tabs:** switching to Stats unmounts Live; returning refetches
  and briefly re-renders canvases from REST snapshots (SSE state persists
  app-level, so no data loss).
- **Test infrastructure:** the jsdom-polyfill fixed 180×64 measurements mask
  container-geometry regressions (accepted jsdom tradeoff); coverage gaps —
  ring-overflow × feed-walk interaction, workspace-page live overlay flips,
  and the I1 interleaving are untested.

## What is correct

- The SSE reducer folds the workflow wire format exactly (node_ready/started/
  done/failed/blocked/needs_decision/missing_role/loop_back/ack) with
  immutable nested updates, and loop_back reverting only its target matches
  the engine; no node-state polling remains anywhere (plan §10 held).
- `buildTriage` overlay semantics (seed → overlay → delete-on-recovery →
  workspace-off drop) are correct, and `resolveTriageHref` implements the
  agent_id-first ownership rule correctly — which is what makes the Agent.tsx
  divergence in C1 stand out.
- `useAgentActivity` ring walk: scope reset, identity walk (no
  double-counting), StrictMode-safe.
- The editor property panel cannot serialize invalid GraphDef JSON
  (`deny_unknown_fields`-safe; rerun never a raw string; timeout guards).
- Canvas glyphs carry the state name in aria-labels (§6.2), loop_back edges
  are dashed violet with small/big labels and not deletable (§6.3), the idle
  prop behaves per §7.2, and every new mutation surfaces failures via
  `role="alert"` (I-28).
- Docs are accurate: spec §5.1 (SSE reality, no polls, missing_role
  surface-marker), spec §13 records 16–18 (decide journal-first + 409, triage
  aggregate, cmux adopt-or-create — verified against api.rs/services), the F1
  note (delegate on_error → needs_decision, dag.rs:595), and the polish plan
  scope trim all match the code.
- Tests: 122/122 green, no act() warnings; the Dashboard SSE-overlay, Agent
  optimistic-dismissal/re-arm, and Graphs full-NodeDef tests are genuine
  regression tests.

## Coverage and gaps

- Dimensions dispatched: correctness + design alignment (general specialist),
  test quality (general specialist), UI/UX + a11y + TS idiom (general
  specialist). Docs reviewed by the orchestrator against the daemon code.
  Nothing came back BLOCKED; two runs returned DONE_WITH_CONCERNS, both
  resolved to verified findings.
- Not dispatched: a dedicated performance reviewer (dashboard-scale data
  volumes are tiny; the only algorithmic paths — the 200-event ring walks and
  triage rebuild — were traced by the correctness reviewer); a dedicated
  security reviewer (no auth/token/secret changes; the new pages reuse the
  bearer-gated client unchanged).
- The one probe that could not run inside the worktree (settled-data banner
  render, C1) was run by the test reviewer from an isolated temp copy outside
  the repo — no worktree writes anywhere.

## Design alignment

- Conforms: §5.1 SSE single-authority reality; §7.2 poll removal and glyph
  contract; §7.3 severity ladder, tab shell, triage strip, off-workspaces
  section; §7.4 workspace page structure; §7.5 feed (role="log",
  aria-live="polite") and decide banner (amber strip, Done/Rerun/Skip, 409
  surfacing); §7.6 intake/rules/property panel.
- Deviates: the decide-banner ownership predicate (C1 — accidental, inverted
  vs its own comment); the workspace-page canvas gating (I4 — looks
  deliberate but leaves §7.4's idle path unreachable on fresh loads); the
  metrics table columns beyond the wire (I3 — deliberate UI, untested against
  reality); `compact` unused (§6.1 — likely deliberate, spec line stale).
