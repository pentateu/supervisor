# Work ledger

One row per plan. Status: `designed → in dev → review complete → merged to main → manually tested and approved`.

The supervisor is its own product (split from agent-bus on 2026-08-15); this ledger covers supervisor plans only.

| Plan | Status | Notes |
|---|---|---|
| `docs/plans/plan_2026-08_supervisor-webui-i31.md` | merged to main | I-31 detailed design. Phase A (A1-A5) live-gated 2026-08-15; Phase B (B1-B6) shipped 2026-08-16 — reviewed APPROVE (r1 BLOCK → r3 APPROVE), manual walk 16/16. Awaiting manual test sign-off. |
| `docs/plans/plan_high_level_2026-08_supervisor-webui-i31.md` | designed | I-31 web-UI live surface (approved 2026-08-15). Functionality-first: Phase A daemon+CLI, Phase B UI. |
| `docs/plans/plan_high_level_2026-08_webui-polish-e2e.md` | designed | Playwright e2e + a11y only. |
