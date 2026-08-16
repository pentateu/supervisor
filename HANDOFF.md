# Fleet Supervisor — Agent Handoff

**Date:** 2026-08-15
**Repo:** `/Users/rafael/Development/supervisor` → `git@github.com:pentateu/supervisor` (public)
**Product:** the Fleet Supervisor (agent-bus Orchestration v2) — a standalone product split from the `agent-bus` repo on 2026-08-15.
**Status:** Phase A of the I-31 live-surface plan is **complete and live-gated**. Phase B (web UI) is next.

---

## Read first

- **Design hub:** `docs/specs/2026-08-13-supervisor-detailed-design.md` (authoritative), `docs/specs/2026-08-14-supervisor-webui-detailed-design.md`, `docs/specs/2026-08-14-supervisor-wiring-fixes-design.md`, `docs/specs/2026-08-14-supervisor-graph-engine-v2.md`
- **Current plan (in dev):** `docs/plans/plan_2026-08_supervisor-webui-i31.md` — Phase A (A1–A5) done; Phase B (B1–B6) is the active checklist (§9 = build order, §11 = acceptance)
- **Ledger:** `docs/ledger.md`
- **Product record:** `PRODUCT.md`

## What this project is

One long-lived process that owns every managed project's agents:
- brings projects up as `opencode serve` servers with cmux panes (`supervisor on`),
- drives declarative workflow DAGs (`feature_lifecycle`, `bug_flow`) with a layered ACK completion contract,
- resolves escalations through a rule engine with an LLM (manager) fallback,
- exposes a loopback REST/SSE API (`127.0.0.1:4198`) with a web UI (`/ui/`).

It does **not** embed the agent-bus event bus. The agent-bus bridge worker is deferred (recorded in the detailed design spec).

## Repo layout

```
crates/
  supervisor-core/     # pure: types, port allocator, state machine, rule engine,
                       # DAG engine, layered ACK resolver, journal. No I/O/async.
  supervisor-daemon/   # the long-lived process: tokio, axum API, SQLite + journal,
                       # workspace manager, SSE observer, inbox delivery, workflow
                       # runner, ingestion, usage collector.
  supervisor-cli/      # `supervisor` command (status/on/off/resume/start/smoke/
                       # dag/rules/bake-back/decide/stop/web/dashboard).
web/                   # the web UI (Vite + React + TS): live dashboard, workflow
                       # canvas, DAG editor, agent dialog.
```

## Current state (everything landed so far)

- **Reviewed + merged:** the full supervisor implementation + three review rounds closed (6 Criticals, 34 Importants, minors) — see `docs/reviews/review_2026-08_supervisor-v2*.md`.
- **I-31 Phase A (complete, live-gated 2026-08-15):**
  - A1: `workspace_id` on bus workflow events (wire: `{"topic":"workflow","workspace_id":"…","event":{…}}`; the journal shape is unchanged).
  - A2: `missing_role` surface marker (engine holds at `Ready`; the daemon persists the marker; `recheck_missing` fires when an agent appears).
  - A3: cmux adopt-or-create in `on()` (a cmux workspace survives a daemon restart; `off()` closes adopted too).
  - A4: `POST …/nodes/{node}/decide` + `supervisor dag decide <graph> <node> --action done|rerun|skip` — journal-first ruling (`human.ruling.<g>/<n>`, DecisionRecord), 409/404.
  - A5: `GET /api/v1/triage` + `supervisor status` triage section.
  - Two live-gate bugs fixed along the way: `~` in `supervisor.toml` paths is now expanded; `cmux list-workspaces --json` (object shape, name in `custom_title`) is parsed correctly.
- **Phase A gate passed live:** `on` twice → one cmux workspace; a 2s-timeout node → `needs_decision` → `dag decide --action rerun` → running (ruling journaled); status shows triage.

## Next: I-31 Phase B (the web UI) — `docs/plans/plan_2026-08_supervisor-webui-i31.md` §9

Follow §9 in order, `cd web && bun run test && bun run build` after each:

1. **B1** types + reducer: `NodeState` += `"missing_role"`; the workflow arm reads the nested `event`; key node states under `nodeStates[workspace_id][graph][node]` (the synthetic `""` fallback was deleted).
2. **B2** canvas: state glyphs (✓✕⛔!⚠, never color-only), `loop_back` dashed edges, `on_error` tags, `idle` prop; **remove the 2s node-state polls** — initial state loads once from `GET /graphs/{id}/nodes?ws=`, updates via SSE (the reducer is the single authority).
3. **B3** dashboard Live/Stats tabs; triage strip (pinned, `GET /api/v1/triage` + SSE); workspace cards are agent-first with a fg/bg segmented control; canvas only while a workflow runs; collapsed off-workspaces; resume button.
4. **B4** real workspace detail page (`#/workspaces/:ws`): on/off/resume, agent grid with fg/bg filter, per-agent 24h cost mini-chart (hand-rolled SVG), installed-graph canvases.
5. **B5** agent dialog: activity feed (from `live.lastEvents`), decide banner (Depth 2: Done/Rerun/Skip → the decide endpoint).
6. **B6** intake page, rules page, full editor property panel.

**Forbidden (plan §10):** no new node-state polling, no chart library (SVG only), no engine-semantics change for `missing_role`, no DB write without the journal first, no token in storage, no Decide Depth 3 / agent spawning / graph-schema freeze.

## Conventions (match these — the owner uses them elsewhere)

- **Worktrees share one cargo `target/`.** Dev work happens in `.worktrees/feature/<topic>/`; the `post-checkout` hook in `.git/hooks/` auto-symlinks the worktree's `target` → the repo root's `target/`. Never create a real `target/` inside a worktree. Manual equivalent: `ln -s /Users/rafael/Development/supervisor/target .worktrees/feature/<topic>/target`. (This is the AI_Tutor convention.)
- **Cleanup step when finishing a feature:** `cargo sweep --stamp && cargo sweep --file` on the main repo target, then `git worktree remove .worktrees/feature/<topic>` and `git branch -d feature/<topic>` + `git worktree prune`.
- **Worktree start:** `git fetch origin && git worktree add .worktrees/feature/<topic> -b feature/<topic> origin/main`.
- **Verification:** `cargo test --workspace` · `cargo clippy --workspace --all-targets -- -D warnings` · `cargo fmt --all -- --check` · `cd web && bun run test && bun run build`.
- **Ledger + docs lifecycle:** one ledger row per plan; update at every transition; broadcast doc changes on the bus per `docs/agents/memory-keeper.md` (plans → `supervisor/dev`).
- **Review loop:** milestones go to `supervisor/review` (post with `--from dev`), fixes from findings, re-request until APPROVE.

## Roster, skills, plugins

- `.opencode/` is installed: the lily agent roster (`agents/`: dev, reviewer,
  tester, designer, memory-keeper), the bundled skills (`skills/`: rust-standards,
  react-ts-vite-standards, impeccable, ui-skills, playwright-*, docs-standards,
  agent-browser, webapp-testing, …), and the plugin config (`opencode.json`:
  envsitter-guard, @plannotator/opencode). `node_modules/` is gitignored but
  present so the plugins work immediately.
- `docs/agents/` holds the mission docs + `install-memory-keeper.sh` (the
  twice-daily docs sweep).
- The mission doc is `docs/agents/dev-orchestrator.md` — read it first.

## Environment notes

- Binaries: `cargo build --release` + copy `target/release/supervisor{,-daemon}` to `~/.cargo/bin/`.
- State dir: `~/.supervisor` (`SUPERVISOR_STATE_DIR` overrides it; the daemon + CLI both honor it). Config: `~/.supervisor/supervisor.toml` (`workspace_root = "~/development"`, `open_supervisor_workspace = true`).
- Ports: API 4198, supervisor workspace 4199, projects 4100+.
- `supervisor stop` for a graceful daemon stop; the CLI execs the daemon so signals reach it.
- opencode 1.18.18 is the verified target; cmux is at `/Applications/cmux.app/…/bin/cmux`.

## Related

- The bus it came from: `pentateu/agent_bus` (`~/Development/agent-bus`) — restored to bus-only after the split.
- The bus integration test (idle shutdown) lives in the bus repo, not here.
