# Fleet Supervisor — agent-bus Orchestration v2

One long-lived **supervisor** process owns every managed project's agents: it
brings projects up as opencode `serve` servers with cmux panes, drives
declarative workflow DAGs (feature lifecycle, bug flow), resolves completions
with a layered ACK contract, escalates through a rule engine with an LLM
fallback, and exposes a loopback REST/SSE API with a web UI.

The supervisor is a standalone product. It does not embed the agent-bus
event bus; it talks to opencode directly and can bridge other harnesses later
(see the spec's bridge deferral).

## Architecture

```
crates/
  supervisor-core/     # pure: types, port allocator, state machine, rules,
                       # DAG engine, layered ACK resolver, journal. No I/O.
  supervisor-daemon/   # the long-lived process: tokio, axum API, SQLite +
                       # journal store, workspace manager, SSE observer, inbox
                       # delivery, workflow runner, ingestion, usage collector.
  supervisor-cli/      # `supervisor` command: status/on/off/resume/start/smoke/
                       # dag/rules/bake-back/decide/stop/web/dashboard.
web/                   # the supervisor web UI (Vite + React + TS): live
                       # dashboard, workflow canvas, DAG editor, agent dialog.
```

## Quick start

```bash
cargo build --release

# configure (state lives in ~/.supervisor)
mkdir -p ~/.supervisor
printf '[supervisor]\nworkspace_root = "~/development"\nopen_supervisor_workspace = true\n' \
  > ~/.supervisor/supervisor.toml

# boot the daemon
supervisor-daemon                        # or: nohup supervisor-daemon > ~/.supervisor/daemon.log 2>&1 &

# register a project (writes a supervisor.toml roster) and bring it on
supervisor add ~/development/<project>
supervisor on <project>

# run the flagship workflow
supervisor start <project> feature_lifecycle --var feature="..."

# watch it live
supervisor web
supervisor dag status feature_lifecycle
supervisor stop                          # graceful daemon stop
```

## Verification

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
cd web && bun run test && bun run build
```

## Docs

The authoritative design lives in `docs/specs/` (supervisor detailed design,
web-UI design, wiring fixes, Graph Engine v2) with plans in `docs/plans/`
and the work ledger in `docs/ledger.md`.
