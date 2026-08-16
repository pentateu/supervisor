# Fleet Supervisor — AGENTS.md

The Fleet Supervisor (`supervisor`, `pentateu/supervisor`): a long-lived process
that owns every managed project's agents, drives declarative workflow DAGs,
resolves escalations, and exposes a loopback REST/SSE API (port 4198) + web UI.
Split from the agent-bus repo on 2026-08-15; it does not embed the agent-bus
event bus (the bridge worker is deferred).

## Read first

- `HANDOFF.md` — current state, conventions, and next work (I-31 Phase B web UI).
- `docs/agents/dev-orchestrator.md` — the dev agent's mission and dispatch contract.
- `docs/agents/memory-keeper.md` — the doc taxonomy and bus protocol.

## Stack

Rust workspace: `crates/supervisor-core`, `crates/supervisor-daemon`,
`crates/supervisor-cli`; web UI in `web/` (Vite + React + TS).

## Verify

`cargo test --workspace` · `cargo clippy --workspace --all-targets -- -D warnings`
· `cargo fmt --all -- --check` · `cd web && bun run test && bun run build`

## Bus

Partition `supervisor`: topics `supervisor/dev`, `supervisor/review`,
`supervisor/tester`, `supervisor/docs`, `supervisor/design`.
