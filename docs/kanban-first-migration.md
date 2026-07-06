# Kanban-first migration policy

This document records the current backend direction for Symphony after the first Hermes Kanban implementation milestone.

## Decision

Hermes Kanban is the canonical Symphony work engine.

Architecture framing:

- **Linear** is the human/project issue interface.
- **Symphony** is the typed facade, materializer, control surface, and provenance layer.
- **Hermes Kanban** is the durable work engine / execution substrate.
- **Codex** is a legacy compatibility runner surface.

Selected backend posture:

- `backend.kind: hermes_kanban` is the preferred backend for new local workflows, canaries, and live-readiness evidence.
- `backend.kind: in_process_linear_codex` remains a legacy compatibility backend for historical workflows and comparison tests.
- The direct `symphony-codex-*` CLIs remain packaged only as compatibility/operator recovery surfaces until a reviewed removal slice retires them.
- A live direct Codex issue-run is not evidence that the Kanban work-engine path is ready. Historical bounded live Codex canary evidence (recorded in repo-local operator docs) is legacy compatibility bridge evidence, not direct evidence that the Kanban execution path is ready.

## Architecture boundary

Kanban-first Symphony means:

```text
Linear project/issue intent
  -> Symphony typed facade/materializer/control/provenance layer
  -> Hermes Kanban board/task graph
  -> Hermes Kanban gateway/worker substrate, when separately authorized
  -> readback receipts, artifacts, and review gates
```

Symphony must not run a second worker dispatcher in Kanban mode. It may create/read/materialize Kanban task graphs and expose snapshots. Gateway-managed Kanban dispatch remains external to Symphony and needs a separate exact-scope operator gate.

## Compatibility stance

Do not delete the legacy Linear/Codex implementation in the same slice as the policy flip. Keep it available while Kanban gathers equivalent or better evidence across all supported workflows:

1. service startup in `hermes_kanban` mode does not require Linear tracker or Codex runner config;
2. no-worker Linear Project -> Kanban materialization canary remains blocked/unassigned and dry-run-safe;
3. real-board materialization evidence exists for the exact approved board scope;
4. exact lifecycle-worker and dependent-worker canaries are separately approved and receipt-backed;
5. the actual long-running dispatcher/gateway path has provider-load/readiness evidence before broad dependent-task dispatch;
6. public docs and examples no longer direct new work toward direct Codex issue-runs.

## Current implemented evidence

- `src/linear-kanban-canary.ts` materializes a blocked/unassigned no-worker canary DAG and verifies dry-run cannot spawn or default-auto-assign tasks.
- `src/kanban-canary-operator.ts` and `symphony-kanban-canary` package the repeatable operator workflow for readback-only and materialize-if-missing no-worker canary receipts.
- `src/service.ts` starts a Kanban backend facade without constructing the legacy Linear tracker/Codex runner path.
- `src/kanban-service.ts` exposes Kanban-backed snapshots for the control plane.
- `tests/linear-kanban-canary.test.ts` covers blocked/no-spawn materialization and default-assignment pitfalls.
- `tests/kanban-canary-operator.test.ts` covers readback-only success, idempotent materialize-if-missing behavior, blocked/unassigned/body/topology/dry-run failure modes, and receipt JSON/manifest output.
- `tests/service.test.ts` covers Kanban service startup without legacy Linear/Codex config.
- `tests/kanban-integration.test.ts` covers isolated temp-home Kanban materialization, readback, snapshot, and dry-run behavior.
- `symphony-linear-kanban-bridge` is the Kanban-first lifecycle bridge operator for Linear polling, Kanban task materialization, and Kanban completion → Linear completion sync with durable ledger idempotency.
- GraphSync now includes read-only mapped live snapshot capture, gated exact-scope Kanban blocking-link apply, and gated exact-scope Linear blocking-relation apply CLIs.
- Operator-private H1 evidence proves one exact integrated dependent-worker path: fresh Linear parent/child relation, Kanban blocking edge, provider-registered parent-before-child worker dispatch, Kanban completion, and exactly-once Linear completion sync.

## Legacy Codex quarantine/removal posture

The `symphony-codex-*` CLIs and the underlying `CodexAppServerRunner` surface are retained only as legacy compatibility and operator-recovery paths. They are **not** the canonical work engine, they are **not** the path to Kanban readiness, and a successful direct Codex issue-run does **not** prove that `backend.kind: hermes_kanban` can materialize tasks, pass no-worker canaries, or safely dispatch through the Hermes gateway. A future reviewed removal slice may retire these CLIs and the direct runner when equivalent or better Kanban-first evidence exists for all supported workflows. Until then, docs and tests must keep the legacy surface clearly labeled as compatibility-only.

## Next gates

Before relying on live Kanban execution, produce a reviewed operator packet naming:

1. exact Linear team/project/issue scope;
2. exact Kanban board slug and Hermes profile/home;
3. artifact root and workspace policy;
4. dispatch mode: `observe_only`, `dry_run`, or `allow_gateway_dispatch`;
5. worker profile(s) and gateway/service status assumptions;
6. rollback/cleanup commands;
7. receipt expectations and secret-scan rules.

No push, PR, publish, deploy, service restart, worker dispatch, Linear mutation, or real-board mutation is implied by this migration policy alone.

## Worker/gateway pilot gates after H1

A first exact operator-controlled dependent-worker canary has passed for one two-task scope. Do not infer broader authority from it. The next gate for broader or long-running worker/gateway reliance must name the exact board, task set, worker profile(s), dispatch path, dependency-provider preflight, rollback/block command, expected task-run logs/artifacts, and whether repo/Linear/external mutation is separately authorized. In particular, verify the actual dispatcher/gateway process has `kanban_cross_deps` registered; H1 showed that an internal helper without provider registration can falsely treat a blocked child as spawnable.
