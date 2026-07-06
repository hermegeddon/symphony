# Hermes Kanban backend runbook

This document describes the Kanban-backed Symphony milestone implemented from `a private operator implementation plan (not shipped)`. It is a safe operator runbook, not a live-dispatch approval packet. `docs/kanban-first-migration.md` records the selected backend direction.

Architecture framing:

- **Linear** is the human/project issue interface.
- **Symphony** is the typed facade, materializer, control surface, and provenance layer.
- **Hermes Kanban** is the durable work engine / execution substrate.
- **Codex** is a legacy compatibility runner surface.

Direct Codex issue-runs are not evidence that the Kanban work-engine path is ready. Historical bounded live Codex canary evidence (recorded in repo-local operator docs) is legacy bridge evidence.

## What Kanban mode is

`backend.kind: hermes_kanban` makes Symphony a typed local facade over Hermes Kanban and is the preferred backend for new workflows:

- workflow/config validation keeps board, profile, workspace, artifact, and dispatch policy explicit;
- `HermesKanbanCliClient` is the only production seam that shells out to `hermes kanban ... --json`;
- graph materialization creates idempotent Kanban tasks with parent IDs, safety boundaries, acceptance criteria, artifact expectations, and review handoff text;
- the control plane exposes Kanban board/task state as Symphony-shaped JSON snapshots;
- service startup in Kanban mode does not require legacy Linear tracker or Codex runner config;
- no-worker Linear Project → Kanban canaries can materialize blocked/unassigned task graphs and verify dry-run no-spawn behavior;
- `symphony-kanban-canary` turns no-worker materialization/readback into a repeatable operator CLI with JSON receipts and hash manifests;
- `symphony-linear-kanban-bridge` materializes eligible Linear issues as Kanban tasks and syncs observed Kanban completion back to Linear exactly once through the durable ledger;
- GraphSync CLIs provide read-only mapped snapshot capture plus exact-scope gated Kanban link and Linear relation apply from prior read-only receipts;
- operator-private H1 evidence proves one exact parent-before-child dependent-worker canary when the dispatch path has the `kanban_cross_deps` provider registered;
- Hermes Kanban remains the durable scheduler/worker dispatcher.

Symphony **does not** run a second worker dispatcher in Kanban mode. It creates, observes, and reports on Kanban state. Gateway-managed Kanban dispatch remains external to Symphony and requires a separate live-operation gate. Direct Codex issue-runs are legacy compatibility evidence and do not prove Kanban work-engine readiness.

## Authority boundaries

Local code edits, fake tests, temp-home Kanban tests, docs, and local commits are allowed for this repo. The following are **not** authorized by this runbook unless a separate exact-scope operator gate names the objects, commands, receipts, rollback path, and non-actions:

- mutating an existing real Kanban project board;
- starting or restarting the Hermes gateway, Kanban daemon, dispatcher, or system services;
- relying on gateway dispatch for assigned ready tasks;
- treating a direct Codex issue-run as a Kanban backend canary;
- pushing commits, creating PRs, publishing packages, deploying, or exposing the control plane;
- writing raw secrets, credentials, request bodies, tokens, or auth headers into task bodies, comments, receipts, fixtures, or docs.

Use temp/test board slugs for validation, such as `symphony-test-smoke`, and isolated `HERMES_HOME` directories for integration tests.

## Config shape

See `examples/kanban-workflow.md` for a safe copy-paste starting point. The important fields are:

```yaml
backend:
  kind: hermes_kanban

kanban:
  hermes_command: hermes
  hermes_home: ./.symphony/hermes-home
  board: symphony-test-local
  board_create: false
  dispatch: dry_run          # observe_only | dry_run | allow_gateway_dispatch
  dispatch_policy: dispatchable # dispatchable | no_worker
  default_assignee: default
  artifact_root: ./.symphony/kanban-artifacts/symphony-test-local
  workspace:
    kind: scratch            # scratch | dir | worktree
  safety:
    require_profile_preflight: true
    require_review_gate_for_repo_mutation: true
    require_human_gate_for_external_actions: true
```

Semantics:

- `board_create: false` is the normal service/readiness posture. Create test boards in an explicit setup step, not implicitly during service startup.
- `dispatch: observe_only` allows reads/materialization without nudging dispatch.
- `dispatch: dry_run` allows `hermes kanban dispatch --dry-run --json`; it must not spawn workers.
- `dispatch: allow_gateway_dispatch` records that an operator has separately approved relying on the running gateway dispatcher. The current Symphony control-plane `/tick` path still refuses to spawn or drive gateway dispatch directly.
- `dispatch_policy: dispatchable` is the normal service/readiness posture. `dispatch_policy: no_worker` is for exact-scope bridge/canary containment: bridge-created tasks are materialized unassigned, immediately sticky-blocked, and reported with `requested_assignee` / `sticky_block_applied` receipt fields.
- Repo-mutating cards require an explicit `worktree:<absolute-path>` workspace and an explicit review child in the materialized graph.
- External-action cards must be explicit unassigned human gates.

## Local temp-home validation

The automated integration smoke is the preferred validation path:

```bash
npm test -- tests/kanban-integration.test.ts
```

It creates a fresh temporary `HERMES_HOME`, initializes Kanban there, creates a `symphony-test-smoke` board, materializes a two-task DAG, verifies parent linkage, reads a Kanban-backed control-plane snapshot, runs `dispatch --dry-run`, asserts that no tasks are spawned, and deletes the temp home.

If the local Hermes CLI is installed somewhere non-default, use:

```bash
SYMPHONY_KANBAN_HERMES_COMMAND=/absolute/path/to/hermes npm test -- tests/kanban-integration.test.ts
```

Manual equivalent for debugging only:

```bash
tmp_home=$(mktemp -d)
HERMES_HOME="$tmp_home" hermes kanban init
HERMES_HOME="$tmp_home" hermes kanban boards create symphony-test-smoke --name "Symphony Test Smoke"
HERMES_HOME="$tmp_home" hermes kanban --board symphony-test-smoke create "K0 smoke anchor" --body "temporary smoke task body" --idempotency-key smoke:k0 --json
HERMES_HOME="$tmp_home" hermes kanban --board symphony-test-smoke list --json
HERMES_HOME="$tmp_home" hermes kanban --board symphony-test-smoke dispatch --dry-run --max 1 --json
rm -rf "$tmp_home"
```

Do not run the manual commands against the default `~/.hermes` unless an operator has approved the exact board slug and scope.

## Operator no-worker canary CLI

Use `symphony-kanban-canary` after an exact board/workflow/Linear scope has been approved. The CLI has two modes:

- `--mode readback-only` — read an already-materialized K0 → K1 → K2 graph, validate it from `show` readbacks, run `dispatch --dry-run --max 1 --json`, and write a PASS/BLOCK receipt.
- `--mode materialize-if-missing` — discover existing cards by workflow id, Linear issue, and `Node key`, create only missing no-worker cards with stable idempotency keys, then validate from readback. If the graph already exists, it does not call create.

Required scope flags are explicit: `--board`, `--workflow-id`, `--artifact-root`, `--linear-team-key`, `--linear-project-id`, `--linear-project-name`, `--linear-issue-identifier`, and `--linear-issue-title`. Existing live cards can be pinned with `--task-id K0=t_... --task-id K1=t_... --task-id K2=t_...`.

The receipt includes:

- command argv with secret-like values redacted;
- task IDs, statuses, assignees, parent/child IDs, and body checks for workflow id, Linear issue, artifact root, and safety/non-authorization text;
- expected topology K0 → K1 → K2;
- dry-run dispatch `spawned`, `auto_assigned_default`, and skipped-nonspawnable data;
- explicit non-actions: no push, PR, publish, deploy, service restart, Linear mutation, or real worker/gateway dispatch;
- receipt/manifest artifact hashes when `--receipt-path` is supplied.

Example shape:

```bash
node dist/src/cli/kanban-canary.js \
  --mode readback-only \
  --board <board-slug> \
  --workflow-id <workflow-id> \
  --artifact-root <artifact-root> \
  --linear-team-key <team-key> \
  --linear-project-id <project-id> \
  --linear-project-name <project-name> \
  --linear-issue-identifier <issue-id> \
  --linear-issue-title <issue-title> \
  --task-id K0=<anchor-task-id> \
  --task-id K1=<readback-task-id> \
  --task-id K2=<human-gate-task-id> \
  --receipt-path <artifact-root>/kanban-canary-readback.json
```

Any invariant failure exits nonzero and writes a `status: "BLOCK"` receipt when `--receipt-path` is provided. A BLOCK receipt is evidence to stop and repair/gate; it is not authorization to unblock, assign, or dispatch the cards.

## Control-plane behavior

When started with a Kanban facade, read endpoints return snapshots like:

```json
{
  "ok": true,
  "snapshot": {
    "backend": "hermes_kanban",
    "mode": "available",
    "board": "symphony-test-local",
    "dispatch": "dry_run",
    "counts": { "total": 2, "pending": 2 }
  }
}
```

If the Hermes CLI output shape drifts or a read fails, the snapshot is still HTTP 200 but reports `mode: "unavailable"` with bounded redacted diagnostics. Mutating endpoints still require bearer auth. In Kanban mode `/tick` refuses to dispatch workers unless a future separately reviewed design adds an explicit safe action. `startSymphonyService` wires the Kanban control-plane facade directly when `backend.kind: hermes_kanban`, rather than constructing the legacy Linear tracker/Codex runner path.

## Rollback / disable path

To disable Kanban mode, set:

```yaml
backend:
  kind: in_process_linear_codex
```

or remove the `backend` block entirely to preserve the legacy default. Do not delete Kanban boards as part of rollback unless an operator approves the exact temp/test board slug; for temp homes, deleting the temp `HERMES_HOME` is sufficient cleanup.

## Validation checklist

Run at least:

```bash
npm test -- tests/kanban-canary-operator.test.ts tests/kanban-client.test.ts tests/kanban-readiness.test.ts tests/kanban-graph-materializer.test.ts tests/control-plane-kanban.test.ts tests/kanban-integration.test.ts
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

The full repo gate remains `npm run check && npm run build && git diff --check`.

## Worker/gateway pilot gate after H1

A first exact operator-controlled dependent-worker canary has passed, but only for its two-task scope and provider-registered dispatch helper. Do **not** execute broader worker/gateway pilots from no-worker or H1 receipts alone. The next human gate must name, at minimum:

1. exact Kanban board slug;
2. exact task ID(s) to make runnable;
3. exact worker profile(s) and whether profile preflight is required;
4. dispatch mode and whether the running gateway, a foreground `hermes kanban dispatch`, or another operator path is in scope;
5. proof that the chosen dispatch path has dependency providers such as `kanban_cross_deps` registered before spawn;
6. rollback/block commands and the condition that stops the pilot;
7. expected logs, task-run receipts, workspace/artifact roots, and readback commands;
8. whether repo mutation, Linear mutation, external API calls, push/PR, deploy, or service restart are separately authorized. Default answer: no.

Until that gate is approved, keep no-worker cards blocked/unassigned and treat dry-run `spawned: []` plus `auto_assigned_default: []` as the final execution boundary.

## Legacy compatibility and deferred work

Direct SQLite/dashboard API optimization, direct Symphony-driven dispatch, removal of the legacy Linear/Codex orchestrator, broad real-board worker dogfood rollout, and recurring GraphSync service automation are deferred. The migration decision itself is no longer deferred: new work should prefer Kanban mode, while `in_process_linear_codex` remains compatibility until a reviewed removal slice. Each live or removal step requires a fresh exact-scope review packet with board slug, profiles, workspace roots, artifact roots, dispatch policy, provider-load expectations, rollback steps, and receipts.

## Legacy Codex quarantine/removal posture

The `symphony-codex-*` CLIs and the underlying `CodexAppServerRunner` surface are retained only as legacy compatibility and operator-recovery paths. They are **not** the canonical work engine, they are **not** the path to Kanban readiness, and a successful direct Codex issue-run does **not** prove that `backend.kind: hermes_kanban` can materialize tasks, pass no-worker canaries, or safely dispatch through the Hermes gateway. Do not cite direct Codex issue-run receipts as evidence for Kanban readiness; cite Kanban canary, bridge, or integration receipts instead. A future reviewed removal slice may retire these CLIs and the direct runner when equivalent or better Kanban-first evidence exists for all supported workflows.
