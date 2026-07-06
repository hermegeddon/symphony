# @hermegeddon/symphony-ts

Local-first TypeScript implementation of the OpenAI Symphony service specification.

Spec: https://github.com/openai/symphony/blob/main/SPEC.md

## Support and maturity

**This project is experimental and maintained best-effort by a single maintainer.** There is no production support, SLA, or backward-compatibility guarantee until a 1.0 release. Pre-1.0 releases may include breaking changes documented in `CHANGELOG.md`.

Bug reports and feature requests are welcome via GitHub Issues. Pull requests following `CONTRIBUTING.md` are welcome. Security reports must follow `SECURITY.md` (private channel, not public issues).

## Current status

This repository is a local-first package and service implementation for the OpenAI Symphony service specification. The current direction is Kanban-first: Hermes Kanban is the canonical Symphony work engine, while the direct in-process Linear/Codex path remains a legacy compatibility surface. The implemented surface is production-shaped for local operation, fake/demo verification, Kanban facade operation, and approval-gated live operation. Live Linear/Kanban/Codex use remains fail-closed behind explicit human approval, reviewed private workflow artifacts, bounded selectors/concurrency, durable service state, redacted receipts, and rollback evidence:

1. Workflow loader and typed config layer
2. Linear-compatible tracker read adapter and normalized issue model
3. Workspace manager and hook runner with path-containment invariants
4. Hermes Kanban backend facade with typed config, CLI seam, readiness checks, graph materialization, typed task-link create/unlink/readback parsing, service snapshot mapping, and no-worker canary support
5. Orchestrator scheduler, retries, continuation, reconciliation, and state snapshot for the legacy in-process backend
6. Observability/status surface and CLI/service entrypoint
7. Conformance fixture suite
8. Local-only Codex protocol preflight receipt harness
9. Single-issue Codex issue-run receipt packet API, fake-tested and live-gated
10. Local-only patch promotion API/CLI for turning an existing exported issue-run patch into a reviewed local branch/commit after verification
11. No-side-effect service live-readiness gates for reviewed workflow/service startup
12. Typed git-worktree workspace source materialization for real local source repos
13. Durable issue-run ledger for completed/interrupted run recovery and Linear mutation idempotency markers
14. Optional loopback-first HTTP control plane for health/status/snapshot and authenticated control actions
15. Explicit Linear lifecycle mutation support for redacted, idempotent status comments and state transitions
16. Legacy Codex app-server runner abstraction, single-issue receipt harness, and patch-promotion compatibility CLIs
17. Kanban-mode service startup that exposes the Kanban control-plane facade without requiring legacy Linear tracker or Codex runner config
18. `symphony-kanban-canary` operator CLI for repeatable no-worker Kanban materialization/readback receipts before any worker/gateway dispatch gate
19. `symphony-linear-kanban-bridge` operator CLI for Linear issue polling, Kanban task materialization, and idempotent Kanban→Linear lifecycle sync without invoking the legacy Codex runner
20. `symphony-graph-sync-diff` local-only CLI for building read-only Linear ↔ Hermes Kanban GraphSync receipt artifacts from explicit JSON snapshots, including receipt-only severity/human-action metadata and optional declared `summary.md` / `status.json` operator artifacts
21. `symphony-graph-sync-snapshot` read-only CLI for capturing mapped Linear issue/relation and Hermes Kanban task/link observations into GraphSync snapshot/receipt/summary/status artifacts using the bridge ledger as the mapping source
22. Fake-only GraphSync helper for Linear-authoritative Kanban blocking-edge materialization through an injected `KanbanClient`, with typed link create/readback receipts and no live/shared-board apply authority
23. `symphony-graph-sync-materialize-kanban` gated live-apply CLI for creating Linear-authoritative Hermes Kanban blocking links from a prior read-only GraphSync receipt, requiring exact scope, explicit board/client config, live-apply flag, max-create cap, and readback receipt
24. `symphony-graph-sync-materialize-linear` gated live-apply CLI for creating Kanban-authoritative Linear `blocks` relations from a prior read-only GraphSync receipt, requiring `LINEAR_API_KEY`, exact scope, live-apply flag, max-create cap, and readback receipt
25. Top-level `graph_sync` workflow config block accepted inertly by default and fail-closed for live/apply modes; only `read_only_diff` mode and `propose_only` proposal policies are accepted in this version, and `dispatch_reliance.enabled` defaults to false
26. `symphony-linear-kanban-graph-sync-tick` fake/local-readonly recurring tick CLI: runs an injected fake lifecycle tick and fake GraphSync snapshot, writes local receipt/status/summary artifacts, exits `0/1/2/3` for `PASS/error/REVIEW/BLOCK`, records `lifecycle_mutations_attempted`, `kanban_mutations_attempted`, `linear_mutations_attempted`, and `dispatch_reliance_attempted` booleans, and does not construct live Linear/Hermes clients
27. `symphony-graph-sync-status` read-only status/watchdog CLI: reads a recurring GraphSync `last-run.json` wrapper, classifies `PASS`/`REVIEW`/`BLOCK`, uses a 15-minute default stale threshold, emits compact operator JSON, and does not mutate Linear/Kanban, edit services/timers, or dispatch workers/gateway
28. Operator-private exact-scope dependent-worker canary evidence for the integrated Linear relation → Kanban blocking link → provider-gated worker dispatch → Linear completion loop; broader recurring/gateway dispatch remains separately gated

## Quickstart (local, fake-only)

```bash
npm install
npm run check        # typecheck + lint + tests
npm run build
npm run smoke:local  # deterministic fake smoke
npm run demo:fake    # same as smoke:local via fake-check CLI
node dist/src/cli/service.js --demo-idle WORKFLOW.md  # long-running local idle service loop for systemd; --workflow WORKFLOW.md is equivalent
npx symphony-fake-check
```

All of the above run without live credentials or network access. They use the fake fixtures in `src/demo/*`.

## Repository files

| File | Purpose |
|------|---------|
| `README.md` | This overview |
| `WORKFLOW.md` | Sample Kanban-backed workflow config for local facade/check workflows |
| `AGENTS.md` | Repo-local conventions and gates for agents/editors |
| `package.json` | Scripts, exports, `symphony-service`, `symphony-fake-check`, `symphony-kanban-canary`, `symphony-linear-kanban-bridge`, `symphony-linear-kanban-graph-sync-tick`, `symphony-graph-sync-diff`, `symphony-graph-sync-snapshot`, `symphony-graph-sync-status`, `symphony-graph-sync-materialize-kanban`, `symphony-graph-sync-materialize-linear`, and legacy compatibility `symphony-codex-*` bin entries |
| `src/index.ts` | Public API surface |
| `src/codex-preflight.ts` | Local-only Codex protocol preflight receipt harness |
| `src/codex-issue-run.ts` | Single-issue Codex issue-run receipt packet, ephemeral worktree wrapper, patch/status export, and operator-confirmation APIs |
| `src/codex-patch-promotion.ts` | Local-only promotion of an exported issue-run patch into a fresh local branch/worktree/commit after verification |
| `src/cli/fake-check.ts` | Local CLI entrypoint for the fake check |
| `src/cli/codex-issue-run-confirm.ts` | Print-only CLI entrypoint for a single-issue Codex run confirmation packet |
| `src/cli/codex-issue-run.ts` | Local single-issue operator CLI with `--print-confirmation`, `--check`, and fake-tested `--yes` execution modes |
| `src/cli/codex-promote-patch.ts` | Local patch-promotion CLI with no-side-effect `--check` and verification-gated `--yes` modes |
| `src/cli/kanban-canary.ts` | Operator CLI for no-worker Kanban canary readback/materialize-if-missing receipts |
| `src/cli/linear-kanban-bridge.ts` | Operator CLI for Linear→Kanban materialization and Kanban→Linear lifecycle sync in `--once` or long-running polling mode |
| `src/cli/linear-kanban-graph-sync-tick.ts` | Fake/local-readonly recurring lifecycle + GraphSync tick CLI that writes receipt/status/summary artifacts and exits `0/1/2/3` for PASS/error/REVIEW/BLOCK |
| `src/cli/graph-sync-readonly-diff.ts` | Local-only CLI for writing read-only GraphSync diff receipt artifacts from explicit JSON snapshots; no live Linear/Kanban reads or writes |
| `src/cli/graph-sync-snapshot.ts` | Read-only GraphSync snapshot CLI for mapped live observations: bridge-ledger mappings, exact Linear relation reads, enriched Kanban task-link readback, and local snapshot/receipt/summary/status artifacts |
| `src/cli/graph-sync-status.ts` / `src/graph-sync-status.ts` | Read-only recurring GraphSync status/watchdog surface over `last-run.json`; emits `PASS`/`REVIEW`/`BLOCK` JSON without applying graph changes, editing services/timers, or dispatching workers |
| `src/cli/graph-sync-materialize-kanban.ts` | Gated live GraphSync Kanban apply CLI that reads a prior `read_only_diff` receipt and creates missing `blocks` links on an exact Hermes Kanban board with readback receipts |
| `src/cli/graph-sync-materialize-linear.ts` | Gated live GraphSync Linear apply CLI that reads a prior `read_only_diff` receipt and creates missing Linear `blocks` relations from Kanban-authoritative edges with readback receipts |
| `src/graph-sync-live-snapshot.ts` / `src/graph-sync-live-readers.ts` | Read-only GraphSync live snapshot orchestration and readers for bridge-ledger mappings, Linear relation readback, and enriched Hermes Kanban dependency-registry links |
| `src/graph-sync-materializer.ts` | GraphSync materializer helpers: fake-only injected-client Kanban materialization plus gated live Kanban and Linear blocking-edge apply logic used by the packaged CLIs |
| `src/control-plane.ts` | Optional HTTP control plane; disabled by default, loopback-first, minimal unauthenticated /health on loopback, bearer-authenticated /status and /snapshot on non-loopback bind, runtime refusal of external bind without opt-in, authenticated mutating endpoints |
| `src/kanban-client.ts` / `src/kanban-types.ts` | Narrow typed CLI seam for `hermes kanban ... --json`, including fake-tested task link create/unlink/readback parsing, and version-tolerant parsing |
| `src/kanban-canary-operator.ts` | Operator receipt layer for no-worker Kanban canary readback/materialize-if-missing validation |
| `src/kanban-readiness.ts` | Read-only Kanban backend readiness checks for board/profile/dry-run availability |
| `src/kanban-graph-materializer.ts` | Idempotent Kanban DAG materializer with task body, parent, review, and human-gate safety policy |
| `src/kanban-service.ts` | Symphony-facing Kanban snapshot facade and lifecycle state mapping |
| `src/linear-kanban-canary.ts` | No-worker Linear Project → Hermes Kanban materialization canary with blocked/unassigned tasks and dry-run safety checks |
| `src/issue-run-ledger.ts` | Private JSON issue-run ledger for completed/interrupted run recovery and mutation idempotency keys |
| `src/linear-lifecycle-notifier.ts` | Idempotent Linear lifecycle mutation adapter for comments and state transitions |
| `src/cli/service.ts` | Long-running local service CLI; accepts either positional `WORKFLOW.md` or `--workflow WORKFLOW.md`; `--demo-idle` swaps live tracker/runner dependencies for deterministic fake local dependencies and returns no candidates for service smoke/systemd setup; `--print-confirmation` and `--check` are no-side-effect live-readiness modes for reviewed workflow/service startup |
| `src/cli/smoke-local.ts` | Local CLI entrypoint for the fake smoke |
| `src/demo/*` | Reusable fake tracker, runner, workspace manager, and workflow fixtures |
| `examples/fake-workflow.md` | Copy-paste example of a minimal workflow config |
| `examples/kanban-workflow.md` | Safe/demo Kanban backend workflow example using a temp/test board posture |
| `examples/graph-sync-readonly-diff/*.snapshot.json` | Public-safe explicit GraphSync snapshot examples for `symphony-graph-sync-diff` |
| `docs/linear-kanban-dag-sync-roadmap.md` | Public-safe continuation roadmap reconciling the original DAG/GraphSync T1–T12 tranche with implemented read-only snapshot/diff, gated apply, and exact-scope dependent-worker canary evidence |
| `docs/hermes-kanban-backend.md` | Kanban backend setup, temp-home validation, control-plane behavior, rollback, and authority-boundary runbook |
| `docs/kanban-first-migration.md` | Kanban-first backend direction, compatibility stance, and next live-worker gates |
| `docs/kanban-phase-7-follow-up.md` | Historical phase-7 migration question, now resolved in favor of Kanban-first compatibility mode |
| `docs/codex-protocol-preflight-harness.md` | Local-only Codex preflight receipt contract and live-run gate |
| `docs/codex-issue-run-harness.md` | Single-issue Codex issue-run receipt packet contract, local operator CLI, artifact placement, and explicit non-actions |
| `docs/spec-compliance-matrix.md` | Current implementation/compliance matrix, verification commands, selected policies, gated live paths, and deferred evidence |
| `docs/next-live-codex-issue-run-approval.md` | Operator-only historical approval checklist and command template for an exact-issue live Codex canary; not shipped in the npm package |
| Repo-local operator rollout plans | Private live-service pilot plans and receipt policies; not shipped in the npm package |

## Package / import notes

- Package name: `@hermegeddon/symphony-ts`.
- License: Apache-2.0, selected to match the upstream `openai/symphony` repository's declared Apache-2.0 license posture for the Symphony specification.
- Build output goes to `dist/` preserving the source layout (`dist/src/*.js`).
- Main entry point is `./dist/src/index.js` (and matching `.d.ts`).
- CLI bins include `symphony-service`, `symphony-fake-check`, `symphony-kanban-canary`, `symphony-linear-kanban-bridge`, `symphony-graph-sync-diff`, `symphony-graph-sync-snapshot`, `symphony-graph-sync-materialize-kanban`, `symphony-graph-sync-materialize-linear`, `symphony-linear-kanban-graph-sync-tick`, and legacy compatibility `symphony-codex-issue-run-confirm`, `symphony-codex-issue-run`, and `symphony-codex-promote-patch`.
- Import with extensions (e.g. `../domain.js`) because `module: NodeNext` is enabled.
- `files` in `package.json` ships `dist/src/**/*`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `examples/**/*`. Repo-local operator docs are intentionally not included in the npm package.
- The unscoped npm name `symphony-ts` is not used by this package; it is already occupied by another publisher.

## Development

Package manager: npm 11 via the `packageManager` field.

Commands:

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run check
```

## Implementation-defined policy ledger

Live-operation evidence is exact-scope and operator-private. Historical canary/run receipts remain in repo-local operator docs, while the npm package README describes only the reusable policy boundaries: live behavior requires reviewed workflow configuration, bounded selectors/concurrency, durable ledgers, idempotent mutation markers, redacted receipts, no-side-effect gates, and rollback rules.

The Symphony spec leaves several behaviors implementation-defined. This implementation records the selected conservative choices instead of treating them as implicit defaults:

| Topic | Selected policy |
|---|---|
| Trust and safety posture | Local fake/demo verification is the default. Kanban-first live behavior requires reviewed authorization, exact board/profile/workspace scope, bounded dispatch policy, durable artifacts, receipts, and rollback evidence. Legacy live Linear/Codex behavior remains fail-closed behind digest-bound operator confirmation. The `symphony-codex-*` CLIs and `CodexAppServerRunner` are retained as legacy compatibility/operator-recovery surfaces and are not evidence of Kanban readiness; a direct Codex issue-run or focused fake Codex test does not prove that the Kanban work engine can materialize a task graph, pass a no-worker canary, or safely dispatch through the Hermes gateway. A future reviewed removal slice may retire them. |
| Backend direction | Hermes Kanban is the canonical Symphony work engine. `backend.kind: hermes_kanban` is the preferred path for new workflows and live evidence; `backend.kind: in_process_linear_codex` and `symphony-codex-*` remain legacy compatibility surfaces. Direct Codex issue-runs and focused fake Codex tests do not prove Kanban readiness; they prove only that the legacy runner seam works for the exact approved issue. A future reviewed removal slice may retire the direct runner and `symphony-codex-*` CLIs when equivalent or better Kanban-first evidence exists for all supported workflows. |
| Approval policy | Codex approval requests fail unless a workflow explicitly selects the runner's `auto_approve` mode; tests and readiness checks do not auto-authorize live runs. |
| Sandbox policy | Symphony sandbox values pass through to the Codex runner using the Codex `0.141.0`-compatible split between `thread/start` string `sandbox` and `turn/start` object `sandboxPolicy`. |
| Operator confirmation | `--print-confirmation` and `--check` are no-side-effect readiness modes. Live-looking Codex/OpenAI commands require `--allow-live-codex-openai-command` and a matching digest from the reviewed print-only packet. |
| Linear selectors and mutation | Exact canary selectors remain preferred for canaries. Broad dispatch requires an explicit selector scope (`tracker.project_slug`, `tracker.team_key`, or `tracker.all_approved_projects: true`), `tracker.allow_broad_dispatch`, `tracker.max_issues_per_poll`, bounded `agent.max_concurrent_agents`, active-state filters, private `service.state_path`, and redacted receipts. Linear comments/state transitions are opt-in under `tracker.mutations` and deduped with ledger mutation keys. |
| Workspace population/synchronization | Fake/demo workflows may create empty directories. Live-readiness requires `workspace.source.kind: git_worktree` with a clean existing source repo; dependency bootstrap remains explicit hook-defined behavior. |
| Dynamic reload | The service polls `WORKFLOW.md` by interval, keeps last-known-good runtime dependencies on invalid reloads, and reapplies tracker/workspace/runner-affecting default dependencies on valid reloads before the next dispatch tick. |
| Durable service state | `service.state_path` enables a private JSON ledger that marks interrupted runs on restart, preserves completed issue IDs, and prevents completed issue redispatch in ledger-backed live service mode. |
| Control plane exposure | No HTTP listener is started by default. When enabled, the control plane defaults to loopback, exposes an unauthenticated minimal `/health` endpoint on loopback, requires bearer auth for `/status` and `/snapshot` on any non-loopback bind, refuses runtime external bind without `allow_external_bind: true`, and requires bearer auth for mutating endpoints. |
| Hermes Kanban backend | `backend.kind: hermes_kanban` makes Symphony a typed facade over Hermes Kanban, not a second dispatcher. It uses the narrow CLI seam, idempotent graph materialization, read-only readiness, no-worker canaries, typed task-link create/unlink/readback parsing, and Kanban snapshot mapping. In service mode it can expose the Kanban control-plane facade without requiring legacy Linear tracker or Codex runner config. The typed task-link seam is fake-tested locally; real-board mutation and gateway dispatch require a separate exact-scope gate. |
| GraphSync DAG sync | GraphSync currently provides local read-only diff receipts from explicit snapshots, read-only live snapshot capture for mapped bridge tasks/issues, fake-only Linear-authoritative Kanban blocking-edge materialization through injected clients, a gated live Kanban apply CLI for missing `blocks` links, a gated live Linear apply CLI for missing Kanban-authoritative Linear `blocks` relations, and a fake/local-readonly `symphony-linear-kanban-graph-sync-tick` CLI that packages the recurring lifecycle + GraphSync tick contract without live clients. Richer Linear relation read-shape normalization preserves relation IDs, endpoint orientation, timestamps, archive state, and observation source for local planning. The apply CLIs require prior `read_only_diff` receipts, exact approved scope, explicit live flags, max-created caps, and readback receipts; they still do not edit services/timers, dispatch workers/gateway, push, publish, deploy, or expose MCP apply behavior. Operator-private exact-scope evidence exists for a two-task dependent-worker canary, but full live bidirectional sync is not satisfied by recurring lifecycle pickup alone: it requires recurring GraphSync capture/diff/apply-or-propose receipts and dependency-readiness evidence before broad gateway/worker reliance. |
| Live bidirectional sync definition | A recurring `symphony-linear-kanban-bridge` lifecycle timer is live lifecycle sync, not by itself full live bidirectional Linear ↔ Hermes Kanban sync. Full live bidirectional sync additionally requires a recurring DAG/GraphSync companion loop ordered with lifecycle ticks: mapped Linear/Kanban graph capture, fresh read-only diff/status receipts, gated dependency-edge apply or proposal behavior in both authority directions, dependency-readiness output, and stop/rollback behavior for stale, cyclic, conflicting, incomplete, or over-cap graph state. |
| Recurring lifecycle + GraphSync tick contract | `runRecurringLinearKanbanGraphSyncTick` is now a local, dependency-injected coordinator contract: it runs a lifecycle tick before a GraphSync snapshot, preserves both receipts, and emits `dispatch_reliance_decision: allowed | deferred | blocked`. `runRecurringLinearKanbanGraphSyncCanary` adds a fake-tested local canary harness that writes receipt/status/summary artifacts and suppresses dispatch-reliance probes when readiness is deferred or blocked. Neither surface edits services/timers or dispatches workers/gateway; live recurring apply/dispatch integration remains separately gated. |

See `implementationPolicyDecisions` in `src/index.ts` and `docs/spec-compliance-matrix.md` for the API-readable ledger and verification matrix.

## Workflow loader and config policy

The Section 5-6 workflow/config layer implements the repository-owned `WORKFLOW.md` contract with these choices:

- YAML front matter is optional. If present, it must be a root map/object; unknown top-level keys are ignored for forward compatibility.
- Prompt bodies are trimmed and rendered with strict Liquid-compatible semantics: unknown variables and unknown filters fail the affected render attempt.
- Built-in defaults follow the spec cheat sheet for tracker, polling, workspace, hooks, agent, and codex fields.
- Environment variables do not globally override YAML. `$VAR_NAME` indirection is resolved only for `tracker.api_key` and `workspace.root` values that explicitly equal a variable token.
- Linear tracker scope may be configured with `tracker.project_slug` (for project-scoped workspaces), `tracker.team_key` (for team-only Linear workspaces), or explicit `tracker.all_approved_projects: true` (for all Linear issues visible to the configured token). Dispatch preflight fails closed unless one of those selector scopes is present.
- `workspace.root` expands `~`, resolves exact `$VAR_NAME` tokens, resolves relative paths against the directory containing `WORKFLOW.md`, and is normalized to an absolute path.
- `workspace.source` defaults to `{ kind: empty_directory }` for local fake/demo compatibility. For live-readiness, use `workspace.source.kind: git_worktree` with explicit `repo`, optional `base_ref` (default `HEAD`), and optional `git_command` (default `git`). Relative `repo` paths resolve against the directory containing `WORKFLOW.md`.
- Canary selectors (`tracker.canary_issue_identifier` and `tracker.canary_labels`) restrict Linear candidate fetches to a single issue identifier or to issues with any of the configured labels when `tracker.require_canary: true` is set. Labels are normalized to lowercase.
- Broad live dispatch is fail-closed for live-looking Codex/OpenAI service commands unless `tracker.allow_broad_dispatch: true` is explicit. Use `tracker.max_issues_per_poll`, `tracker.active_states`, `agent.max_concurrent_agents`, and optionally `agent.max_concurrent_agents_by_state` to bound fan-out; this is especially important with `tracker.all_approved_projects: true` because it polls all active issues visible to the Linear token.
- `tracker.mutations` is disabled by default. When enabled, the service can create Linear status comments and update configured state IDs; mutation receipts are redacted and duplicate comments/transitions are prevented by `service.state_path` ledger keys.
- `service.state_path` resolves like other config paths and enables durable restart recovery. `service.control_plane` is disabled by default; enabled listeners default to `127.0.0.1`, and non-loopback binds require `allow_external_bind: true` plus a non-empty `auth_token`. On a non-loopback bind, `/status` and `/snapshot` require bearer authentication; `/health` remains minimal and unauthenticated. `$VAR_NAME` indirection is supported for `service.control_plane.auth_token`.
- For backward compatibility, omitted `backend.kind` still resolves to `in_process_linear_codex`. New workflows should declare `backend.kind: hermes_kanban`, which parses the typed `kanban` block (`hermes_command`, `hermes_home`, `board`, `board_create`, `dispatch`, `dispatch_policy`, `default_assignee`, `artifact_root`, `workspace`, and `safety`). `kanban.dispatch_policy` defaults to `dispatchable`; `no_worker` materializes bridge-created tasks unassigned and immediately applies a sticky no-worker block with receipt evidence. Kanban dispatch preflight does not require legacy Linear/Codex tracker fields, and Kanban service startup does not construct the legacy Linear tracker/Codex runner path; real-board mutation and live gateway dispatch remain separately gated.
- Codex-owned `approval_policy`, `thread_sandbox`, and `turn_sandbox_policy` remain pass-through values; when absent they are exposed as `null` rather than silently inventing implementation defaults.
- Dispatch preflight exposes typed error records for missing/unsupported tracker config, missing API key/selector scope (`tracker.project_slug` or `tracker.team_key`), missing codex command, missing canary selector when required, and invalid typed config.

## Workspace manager policy

The Section 9 workspace manager implements only deterministic local directory lifecycle behavior:

- Workspace keys are derived from issue identifiers by replacing every character outside `[A-Za-z0-9._-]` with `_`.
- Per-issue paths are computed as `<workspace.root>/<workspace_key>` and rejected unless normalized realpath-aware containment keeps them under the normalized workspace root.
- `workspace.source.kind: empty_directory` preserves the original local fake/demo behavior by creating the per-issue directory directly.
- `workspace.source.kind: git_worktree` materializes a real detached local worktree with `git worktree add --detach <workspace_path> <base_ref>` from the configured source repo; existing per-issue paths must already be git worktree checkouts or they are refused rather than silently reused.
- Terminal cleanup for git-worktree sources runs `git worktree remove --force <workspace_path>` after the nonfatal `before_remove` hook; it does not create a persistent branch.
- Agent launch callers must validate `cwd === workspace_path` immediately before spawning the coding agent.
- Hooks run via `sh -lc <script>` with the per-issue workspace as `cwd`; `hooks.timeout_ms` defaults to 60000 ms.
- `after_create` and `before_run` failures/timeouts are fatal; `after_run` and `before_remove` failures/timeouts are logged/nonfatal.
- Successful runs preserve workspaces. Terminal cleanup runs `before_remove` and then removes the per-issue workspace or git worktree.
- Dependency bootstrap remains hook-defined; live-readiness requires an explicit git-worktree source so the service is not dependent on empty fake workspaces.

## Legacy Codex app-server runner policy

The legacy Section 10 runner abstraction targets the documented Codex app-server stdio transport: JSON-RPC 2.0-style messages without a `jsonrpc` header, newline-delimited JSON on stdout/stdin, and diagnostic stderr kept out of protocol framing. Schema source for a concrete deployment must be the targeted Codex version's generated schema (`codex app-server generate-json-schema --out <path>`) or the published app-server docs for that version; the fake fixtures in this repository intentionally exercise only the subset needed by the compatibility runner contract.

> **Quarantine / removal posture.** This runner and the `symphony-codex-*` CLIs are retained only as legacy compatibility and operator-recovery surfaces until a reviewed removal slice retires them. They are intentionally **not** the path to Kanban readiness. A successful direct Codex issue-run proves only that this legacy runner seam can spawn an app-server for the exact approved issue; it does not prove that the Kanban-first work engine (`backend.kind: hermes_kanban`) can materialize tasks, pass no-worker canaries, or safely dispatch through the Hermes gateway. Do not cite direct Codex run receipts as evidence that the Kanban work engine is ready; cite Kanban canary, bridge, or integration receipts instead.

Implementation-defined choices for this slice:

- Launch uses `bash -lc <codex.command>` with `cwd` set to the per-issue workspace path.
- First turns render the issue/workflow prompt template. In-worker continuation turns reuse the same live `thread_id` and send continuation guidance rather than resending the original issue prompt.
- Runtime events normalize `thread_id`, `turn_id`, `session_id = <thread_id>-<turn_id>`, app-server pid, token usage, rate-limit updates, agent updates, unsupported tool calls, and turn terminal states when the targeted protocol exposes them.
- Approval requests are auto-approved only when the runner config explicitly selects `approval.mode: auto_approve`; otherwise they fail the run.
- User-input-required turn signals are hard failures so worker runs do not stall indefinitely.
- Unsupported dynamic tool calls receive a structured failure tool result and the session continues.
- Optional `linear_graphql` is capability-gated. When enabled, it uses configured tracker endpoint/auth from Symphony runtime config and never requires the coding agent to supply or read raw tokens.
- No live Codex or Linear session is required or authorized by tests; protocol behavior is covered with fake JSONL app-server processes. Codex child processes scrub Linear-related environment variables before spawn so tracker/service secrets are not inherited by coding agents unless a future design explicitly adds a reviewed capability.

## Codex protocol preflight and issue-run receipt harnesses

`runCodexProtocolPreflight` in `src/codex-preflight.ts` is a local-only wrapper around `CodexAppServerRunner` for proving startup/protocol receipt shape before any real Codex/OpenAI run is approved. The harness emits `codex_app_server_spawn`, `codex_protocol_request_response`, `codex_runtime_event`, and `codex_preflight_result` receipts, and `validateCodexPreflightReceipts` flags secret-like payloads before local artifacts are trusted. Receipt sinks are observability hooks and are nonfatal for both synchronous throws and asynchronous rejections.

`runCodexIssueRun` in `src/codex-issue-run.ts` productizes the bounded exact-issue wrapper pattern as an API-first, fake-tested local receipt packet for one explicit issue. It rejects missing issue identifiers, non-fail-closed approval mode, and unapproved Linear tool exposure before spawning `codex.command`; it writes redacted receipts, validation, machine-readable outcome, human summary, and artifact manifest. `runCodexIssueRunInEphemeralGitWorktree` adds the selected P5/P10A lifecycle policy: create a temporary detached git worktree for the issue run, run Codex with cwd exactly equal to that worktree, export `codex-issue-run-worktree.patch` and `codex-issue-run-worktree-status.txt`, record lifecycle evidence, remove the worktree, and create no persistent branch. `buildCodexIssueRunOperatorConfirmation`, `symphony-codex-issue-run-confirm`, and `symphony-codex-issue-run --print-confirmation` add print-only operator-confirmation packets. `symphony-codex-issue-run --check` performs a no-spawn local readiness check. `symphony-codex-issue-run --yes` executes exactly one local issue run through the ephemeral worktree wrapper after explicit operator confirmation; tests use only fake app-server commands. Commands that look like live `codex` or OpenAI invocations fail closed unless the operator also supplies `--allow-live-codex-openai-command` and a matching `--confirmation-digest` printed by `--print-confirmation` for the exact same deterministic inputs. That override path is fake-tested only and does not authorize a real Codex/OpenAI run without a fresh exact-scope human gate. `promoteCodexIssueRunPatch` and `symphony-codex-promote-patch` are a separate local-only promotion surface for an existing exported patch: `--check` is no-side-effect, while `--yes` requires a clean source repo, safe branch name, fresh local branch/worktree, patch apply, approved local verification command JSON, and successful local commit. Linear mutation, git push, PR creation, deployment, service restart, broad dispatch, and live Codex/OpenAI execution remain explicitly out of scope without separate approval.

> **Legacy / quarantine posture.** The CLIs in this section are retained only as legacy compatibility and operator-recovery surfaces. They are not the path to Kanban readiness; a successful direct Codex issue-run proves only that the legacy runner seam can spawn an app-server for the exact approved issue and does not prove that the Kanban-first work engine can materialize tasks, pass no-worker canaries, or safely dispatch through the Hermes gateway. Do not cite direct Codex run receipts or focused fake Codex test success as evidence for Kanban readiness; cite Kanban canary, bridge, or integration receipts instead. A future reviewed removal slice may retire these CLIs and the direct runner when equivalent or better Kanban-first evidence exists for all supported workflows.

## Focused verification is fake-only:

```bash
npm test -- tests/codex-preflight.test.ts
npm test -- tests/codex-issue-run.test.ts
npm test -- tests/cli-codex-issue-run.test.ts
npm test -- tests/codex-patch-promotion.test.ts tests/cli-codex-promote-patch.test.ts
```

These focused tests exercise the legacy runner seam and must remain fake-only; passing them does not authorize or prove live Codex/OpenAI operation, and they do not prove Kanban readiness.

See `docs/codex-protocol-preflight-harness.md` and `docs/codex-issue-run-harness.md` for the receipt contracts, redaction/minimization rules, and the approval-gated live Codex/OpenAI boundary.

> **Quarantine / removal posture.** The CLIs and runner APIs in this section are retained as legacy compatibility/operator-recovery surfaces until a reviewed removal slice retires them. They are not the path to Kanban readiness; do not cite focused Codex test success or direct Codex issue-run receipts as evidence that the Kanban work engine is ready.

## Linear ↔ Kanban bridge operator

`symphony-linear-kanban-bridge` is the Kanban-first operator for the normal Linear workflow: create eligible Linear issues, let Symphony materialize Hermes Kanban tasks, and sync observed Kanban completion back to Linear. It uses `backend.kind: hermes_kanban`, `LinearTrackerClient`, `HermesKanbanCliClient`, `LinearIssueMutationClient`, and the durable `service.state_path` ledger; it does **not** invoke the legacy Codex app-server runner.

Modes:

```bash
symphony-linear-kanban-bridge --once --workflow WORKFLOW.md
symphony-linear-kanban-bridge --workflow WORKFLOW.md
```

`--once` runs one poll/materialize/sync tick and prints a JSON receipt. Without `--once`, the command performs an immediate tick, logs structured tick results, and repeats at `polling.interval_ms` until stopped by the process supervisor. Live use remains gated by the same exact-scope rules as other Linear/Kanban mutation paths: reviewed private workflow, bounded selectors (`tracker.require_canary` or explicit `tracker.allow_broad_dispatch`), `tracker.mutations.enabled: true`, private `service.state_path`, redacted receipts/logs, and explicit board/profile/workspace scope. Use `tracker.all_approved_projects: true` only when the reviewed scope is intentionally “all active Linear issues visible to this token”; pair it with `kanban.board: linear`, narrow `tracker.active_states`, and low `tracker.max_issues_per_poll` for the initial rollout.

Focused verification is fake-only:

```bash
npm test -- tests/linear-kanban-bridge.test.ts tests/cli-linear-kanban-bridge.test.ts
```

## GraphSync read-only diff artifacts

`symphony-graph-sync-diff` is a local-only receipt-artifact wrapper for the Linear ↔ Hermes Kanban dependency-sync ledger. It consumes an explicit JSON snapshot matching `BuildGraphSyncReadOnlyDiffReceiptInput`, writes a declared local `read_only_diff` receipt artifact, and prints a compact artifact summary:

```bash
symphony-graph-sync-diff --mode read_only_diff --input graph-snapshot.json --output graph-receipt.json
```

Optional declared operator artifacts can be written alongside the receipt:

```bash
symphony-graph-sync-diff --mode read_only_diff --input graph-snapshot.json --output graph-receipt.json \
  --summary-output summary.md \
  --status-output status.json
```

This command does **not** query Linear, read or mutate Hermes Kanban, restart services/timers, or expose an MCP/apply surface. It is intended for operator-facing graph-diff receipts before any later exact-scope apply gate. Missing counterparts, cycles, endpoint policies, and proposed operations remain receipt/proposal data only; `suppressed_writes` stays true. Operator findings include closed `severity` and `human_action_recommendation` fields so humans can triage cycles, endpoint policies, and suppressed proposals without implying write approval. `summary.md` is a local human-readable digest and `status.json` is a local machine-readable triage artifact with `PASS` / `REVIEW` / `BLOCK` operator status; neither artifact grants write authority.

For mapped live observations, `symphony-graph-sync-snapshot --mode read_only_snapshot` reads bridge-ledger issue↔task mappings, exact Linear issue relation state, and Hermes Kanban task-link state, then writes local snapshot, receipt, summary, and status artifacts. It is read-only: it does not mutate Linear, mutate Hermes Kanban, edit services/timers, dispatch workers/gateway, push, publish, or deploy.

The public API also exposes `materializeGraphSyncMissingKanbanBlockingEdges` as the fake-only helper. That helper consumes a local `read_only_diff` receipt, calls only an injected `KanbanClient` test double or caller-provided seam, creates typed `blocks` links with `blocking: true` and `requiredParentStatuses: ['done']`, reads the child task back, and emits a local receipt with explicit non-actions. It does not construct a real `HermesKanbanCliClient`; the live Kanban CLI below is the separate gated surface.

For approved exact-scope Kanban link apply, `symphony-graph-sync-materialize-kanban` consumes a prior `read_only_diff` receipt and constructs a real `HermesKanbanCliClient` only after the operator supplies an exact board/client/scope packet and the noisy live flag:

```bash
symphony-graph-sync-materialize-kanban \
  --mode linear_authoritative_apply \
  --input graph-receipt.json \
  --output kanban-apply-receipt.json \
  --board linear \
  --hermes-command /path/to/hermes \
  --hermes-home /path/to/hermes-home \
  --approved-scope 'board=linear edge=<parent-task-id>-><child-task-id> source=<read-only-run-id>' \
  --max-created 1 \
  --allow-live-kanban-apply
```

The live Kanban apply CLI creates only typed Hermes Kanban `blocks` links with `blocking: true`, `requiredParentStatuses: ['done']`, `source: 'symphony-graph-sync'`, and bridge metadata. It refuses source receipts with conflicts, cycles, endpoint-policy findings, or candidate counts above `--max-created`; writes a local apply receipt; and verifies readback from the child task. It does **not** query Linear, create/update/delete Linear relations, restart services/timers, dispatch workers/gateway, use MCP mutation tools, push, publish, deploy, or open PRs.

For approved exact-scope Linear relation apply, `symphony-graph-sync-materialize-linear` consumes a prior `read_only_diff` receipt in `kanban_authoritative_apply` mode and constructs a Linear mutation client only when `LINEAR_API_KEY` is present and `--allow-live-linear-apply` is supplied. It creates capped missing Linear `blocks` relations from Kanban-authoritative edges, verifies readback, and writes a local apply receipt. It does **not** mutate Hermes Kanban, move Linear issue states, restart services/timers, dispatch workers/gateway, use MCP mutation tools, push, publish, deploy, or open PRs. Service/timer rollout, broad apply, worker/gateway dispatch, MCP apply, and public release remain separate gates.

Public-safe snapshot examples live under `examples/graph-sync-readonly-diff/` and cover a matched edge, a missing Kanban edge, and an unmapped Kanban endpoint. The repo continuation roadmap for the broader DAG tranche is `docs/linear-kanban-dag-sync-roadmap.md`; it separates completed local/read-only substrate from future fake-only, canary, apply, service, and MCP gates.

Focused verification is local-only:

```bash
npm test -- tests/tracker.test.ts tests/graph-sync-ledger.test.ts tests/graph-sync-live-snapshot.test.ts tests/graph-sync-live-readers.test.ts tests/cli-graph-sync-snapshot.test.ts tests/cli-graph-sync-readonly-diff.test.ts tests/cli-graph-sync-materialize-kanban.test.ts tests/cli-graph-sync-materialize-linear.test.ts tests/graph-sync-materializer.test.ts tests/index.test.ts tests/package-cli-surface.test.ts tests/cli-linear-kanban-graph-sync-tick.test.ts
```

## GraphSync recurring tick config and fake/local-readonly CLI

A top-level `graph_sync` workflow block configures the recurring lifecycle + GraphSync companion loop. It is **inert by default** (`enabled: false` or absent) and **fail-closed** for any live/apply mode. In this version only `read_only_diff` mode and `propose_only` proposal policies are accepted; apply-like modes and non-propose-only policies are rejected at config resolution time. `dispatch_reliance.enabled` defaults to `false`.

```yaml
graph_sync:
  enabled: true
  mode: read_only_diff
  artifact_root: <absolute-private-artifact-root>
  state_path: <absolute-private-state-file>
  require_lifecycle_receipt: true
  require_same_board_scope: true
  freshness_ttl_ms: 300000
  caps:
    max_nodes: 50
    max_relations: 100
    max_kanban_tasks: 50
    max_pages: 5
  proposal_policy:
    linear_to_kanban: propose_only
    kanban_to_linear: propose_only
  dispatch_reliance:
    enabled: false
    require_fresh_pass: true
```

`symphony-linear-kanban-graph-sync-tick` is the fake/local-readonly packaged surface for Swarm 1. It accepts `--mode fake_local_readonly`, `--workflow WORKFLOW.md`, and `--artifact-root PATH`, runs injected fake lifecycle and GraphSync fixtures, and writes `receipt.json`, `recurring-tick-receipt.json`, `status.json`, and `summary.md` under a timestamped run directory.

```bash
symphony-linear-kanban-graph-sync-tick \
  --mode fake_local_readonly \
  --workflow WORKFLOW.md \
  --artifact-root <absolute-private-artifact-root>
```

Exit codes for this CLI:

| Status | Exit | Meaning |
|---|---|---|
| `PASS` | 0 | Fake/local scope is clean for this run |
| runtime/config error | 1 | CLI or workflow error |
| `REVIEW` | 2 | Dependency readiness deferred; human review required |
| `BLOCK` | 3 | Dependency readiness blocked; repair before reliance |

The CLI prints a JSON artifact with `lifecycle_mutations_attempted: false`, `kanban_mutations_attempted: false`, `linear_mutations_attempted: false`, and `dispatch_reliance_attempted` reflecting only the fake-local probe. It does **not** construct a real `LinearTrackerClient`, `HermesKanbanCliClient`, or `LinearIssueMutationClient`; it does not edit services/timers, dispatch workers/gateway, push, publish, deploy, or open PRs. Real workflow-derived lifecycle execution and live GraphSync capture remain separately gated.

Focused verification:

```bash
npm test -- tests/workflow.test.ts tests/cli-linear-kanban-graph-sync-tick.test.ts tests/linear-kanban-graph-sync-tick.test.ts
```

## Orchestrator scheduler policy

The Section 7-8 orchestrator implementation is an in-process single-authority scheduler. All scheduling mutations are serialized through the orchestrator; collaborators provide tracker reads, workspace operations, and runner handles but do not mutate claim/retry/running state directly.

Implementation-defined choices for this slice:

- Tick order is fixed as reconcile running issues, dispatch preflight validation, candidate fetch, deterministic sort, eligible dispatch while slots remain, then snapshot/status consumers can read state.
- Candidate eligibility requires non-empty `id`, `identifier`, `title`, and `state`, an active non-terminal tracker state, no running/claimed entry, available global and per-state slots, and terminal blockers when a candidate is in `Todo`.
- Dispatch sorting is priority ascending with null priority last, then `created_at` oldest first with missing timestamps last, then identifier lexicographic.
- Clean worker exits remove the running entry, update aggregate runtime/token totals, and mark the issue completed for observability. Without a durable ledger, they may queue the configured clean-success continuation retry; `agent.success_continuation_delay_ms: 0` disables that bounded canary continuation. With `service.state_path`, completed issue IDs are recovered across restarts and are not redispatched.
- Abnormal exits and stall cancellations queue failure retries using `min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`.
- Retry timers re-fetch active candidates and dispatch only the specific issue when eligible; missing or no-longer-active issues release their claim, while slot exhaustion requeues with `no available orchestrator slots`.
- Reconciliation performs stall detection before tracker-state refresh. Terminal tracker states cancel the run and clean the workspace; inactive non-terminal states cancel without cleanup; refresh failures keep workers running for the next tick.
- Startup cleanup fetches terminal issues and removes their workspaces; cleanup fetch failures are warning-class and do not block startup.
- Ledger-backed restart recovery marks running runs as interrupted, restores completed issue IDs to suppress duplicate dispatch, and keeps Linear mutation idempotency keys for comments/state transitions.

## Observability and service startup policy

The Section 13 observability/service slice exposes local in-process surfaces by default. Optional HTTP control-plane support is available only when configured; it is disabled by default and loopback-first when enabled.

Implementation-defined choices for this slice:

- Structured logs are stable `key=value` lines ordered by `level`, `event`, `outcome`, `issue_id`, `issue_identifier`, `session_id`, and `reason`, followed by sorted scalar fields.
- Raw payload-like fields (`raw_payload`, `payload`, `large_payload`, `body`, and `response_body`) are omitted from default log lines; long string values are truncated to 240 characters.
- Runtime snapshots include running rows with `turn_count`, retry rows under both `retry_attempts` and `retrying`, aggregate `codex_totals`, latest Codex `rate_limits`, and recommended `timeout`/`unavailable` error modes.
- Dispatch and agent-session retry logs include issue context and concise reasons; session retry logs include `session_id` when the runner has emitted one.
- `startSymphonyService` is the minimal local operator entrypoint: it loads `WORKFLOW.md`, performs dispatch preflight validation with visible startup logs, runs startup cleanup, schedules an immediate tick, polls for recurring ticks, keeps the last-known-good workflow and runtime dependencies across invalid reloads, reapplies tracker/workspace/runner-affecting default dependencies on valid reloads, and returns the current workflow, orchestrator, optional control plane, and `stop()` handle for embedding. `symphony-service --demo-idle WORKFLOW.md` and `symphony-service --demo-idle --workflow WORKFLOW.md` wrap this path as a long-running process while replacing live tracker/runner dependencies with deterministic fake local dependencies and returning no candidates, which is the safe default for local systemd setup. `symphony-service --print-confirmation <live-workflow>` or `--print-confirmation --workflow <live-workflow>` prints the resolved workflow, selector policy, workspace root/source, Codex policy, durable state/control-plane config, explicit non-actions, and an operator-confirmation digest without starting the service. `symphony-service --check <live-workflow>` validates the reviewed-live-service predicates without querying Linear, starting Codex, creating workspaces, or writing receipts; live-readiness requires a clean, existing git-worktree source repo, resolvable base ref, bounded selector scope (`require_canary` with canary selector or `allow_broad_dispatch` with per-poll/concurrency limits), durable state for broad mode, live-appropriate timeouts, explicit sandbox/approval, and the digest-bound live-command override. In workflow mode, live-looking Codex/OpenAI commands fail closed before service startup unless the operator supplies `--allow-live-codex-openai-command` and the matching `--confirmation-digest` from `--print-confirmation`.
- `LinearTrackerClient`, `LinearIssueMutationClient`, and `startSymphonyService({ trackerReceiptSink })` can emit live-validation evidence without exposing tracker secrets: request/response receipts include operation, endpoint, query hash, redacted auth headers, redacted variables, and GraphQL outcome; exact canary selection also emits the selected issue id, identifier, title, team, state, and URL; mutation receipts record operation/issue/result without raw auth. Receipt sink failures are nonfatal.
- Workflow reload is interval-based `WORKFLOW.md` polling rather than an OS-native file watcher. The optional control plane exposes `/health` (minimal, unauthenticated on loopback), `/status`, and `/snapshot`; `/status` and `/snapshot` require bearer auth when bound outside loopback. Mutating endpoints currently include authenticated `/tick` and `/shutdown`. Non-loopback bind requires explicit `service.control_plane.allow_external_bind: true` and a non-empty auth token; the runtime refuses external bind without that opt-in.

## Hermes Kanban backend policy

`backend.kind: hermes_kanban` is the canonical backend direction and uses Hermes Kanban as the durable execution substrate. Symphony validates typed Kanban config, creates idempotent task graphs through `HermesKanbanCliClient`, exposes Kanban board/task status through the control-plane snapshot facade, can run an isolated temp-home smoke test, and has a no-worker Linear Project → Kanban materialization canary. The packaged `symphony-kanban-canary` CLI makes that canary repeatable for operators: it can read back an already-materialized blocked/unassigned graph, or materialize missing approved no-worker cards, then writes a JSON PASS/BLOCK receipt with task IDs, topology, body safety checks, dry-run dispatch results, explicit non-actions, and a hash manifest. It does not start or restart the Hermes gateway, does not dispatch workers, and does not mutate existing real boards by default.

Focused local validation:

```bash
npm test -- tests/kanban-canary-operator.test.ts tests/kanban-client.test.ts tests/kanban-readiness.test.ts tests/kanban-graph-materializer.test.ts tests/control-plane-kanban.test.ts tests/kanban-integration.test.ts
```

See `docs/hermes-kanban-backend.md` for setup, example config, temp-home smoke details, rollback/disable steps, and the human gates required before real-board use. See `docs/kanban-first-migration.md` for the selected Kanban-first migration policy and the compatibility status of the direct Codex path.

## npm warnings / troubleshooting

- If `npm install` warns about `packageManager` mismatch, run with the pinned npm version (`npm@11.11.0`) or use `corepack`/`mise` to select the correct node/npm pair.
- If `npm run lint` fails with `parserOptions.projectService`, ensure TypeScript and `typescript-eslint` versions match `package-lock.json` (delete `node_modules` and re-run `npm install`).
- If a CLI script is invoked before `npm run build`, it will fail because the `dist/` files are missing. Build first, or run `npm run check`.

Live Linear/Kanban/Codex credentials are not required for tests. When approved for Kanban-first live operation, configure exact board/profile/workspace/artifact scope and keep dispatch at `observe_only` or `dry_run` until a separate worker/gateway gate is approved. Legacy direct Linear/Codex operation still requires exact canary scope (`tracker.require_canary: true` plus `tracker.canary_issue_identifier` or approved `tracker.canary_labels`) or a reviewed broad phase (`tracker.allow_broad_dispatch: true` plus an explicit selector scope, bounded states, per-poll/concurrency limits, private durable state, and receipt capture). The `symphony-codex-*` CLIs and `CodexAppServerRunner` are retained as legacy compatibility/operator-recovery surfaces and are not evidence of Kanban readiness; do not cite direct Codex issue-run receipts or focused fake Codex test success as proof that the Kanban work engine is ready. Tests remain fake-only.
