# Symphony live autonomy rollout plan

## Fresh authorization

Janusz explicitly authorized the next Symphony phase on 2026-06-23: broad Linear selector dispatch, multi-issue live autonomy, persistent live systemd rollout, live Linear mutation as part of service operation, PR creation, deploy/restart beyond the one-off launcher, public release/publish, and an external HTTP/control-plane listener.

This authorization supersedes older documents that said those actions were not yet authorized. It does not authorize raw secret disclosure, force-push, destructive history rewrite, deletion of unrelated artifacts/workspaces, leaking private Hermes/Kanban/internal context into public docs, or bypassing tests and secret scans.

## Prior evidence to preserve

Do not duplicate these files here; treat them as the evidence base for this rollout:

- `docs/live-canary-policy-decision-2026-06-21.md` — bounded read-only Linear `HER-1` canary.
- `docs/her-1-live-codex-run-2026-06-21.md` — bounded live Codex app-server canary.
- `docs/her-1-local-live-codex-canary-2026-06-22.md` — productized local-live issue-run path and timeout lesson.
- `docs/codex-protocol-preflight-harness.md` — Codex protocol preflight receipt contract.
- `docs/codex-issue-run-harness.md` — single-issue issue-run and patch-promotion receipt contract.
- `docs/next-live-codex-issue-run-approval.md` — historical exact-scope operator packet template.
- Private receipts under `~/.hermes/artifacts/symphony/live-service/`, especially `live-run-20260622T201548Z/` and `gates-20260622T201528Z/`.
- HER-9 Testflight bridge canary under `~/.hermes/artifacts/symphony/testflight/linear-kanban-bridge-service/` — first project-bounded Kanban bridge success: Linear `HER-9` in Testflight `Todo` → Kanban task `t_6cea039e` → worker completion → Linear `Done` with idempotent start/completion comments, no duplicate task creation, and no raw secret leakage. This is bridge evidence that the Linear → Symphony → Hermes Kanban → Linear path can complete a real issue; it is not direct Codex runner evidence.
- H1 dependent-worker canary under `~/.hermes/artifacts/symphony/h1-dependent-worker-canary-20260701T160406Z/` — exact two-issue dependent-worker proof: fresh Linear parent/child issues, one Linear `blocks` relation, exact Kanban materialization, one GraphSync Kanban blocking edge, provider-registered parent-before-child worker dispatch, both Kanban tasks `done`, and exactly-once Linear completion sync. This is evidence for that exact scope and dispatch path only; broader recurring/gateway dispatch still needs provider-load/readiness evidence.

## Current 2026-07-01 status

The implementation is no longer merely fake/local for the Kanban-first bridge path. Operator-private receipts now prove these exact-scope live slices: no-worker materialization, lifecycle worker completion sync, Linear relation write orientation, GraphSync read-only snapshot/readback, live Kanban blocking-link apply, and one integrated H1 dependent-worker pair. Those receipts do **not** authorize broad polling, broad dispatch, recurring GraphSync automation, service/timer rollout, public release, or gateway reliance without a fresh gate.

The immediate next live gate is provider-load/readiness for the actual long-running dispatcher/gateway path: prove `kanban_cross_deps` is registered and blocks children immediately before spawn. H1 used a provider-registered operator helper; a bare helper without provider registration falsely reported the child spawnable during diagnosis.

## Selected policies for the approved phase

### Current 2026-06-23 live pilot selection

- Stale or hypothetical exact canary identifiers such as `HER-123` must not be used unless a fresh read-only Linear lookup proves they exist and match the intended scope.
- The current approved pilot uses a private workflow artifact with `tracker.team_key: HER`, `active_states: [Todo, In Progress]`, `tracker.max_issues_per_poll: 1`, `agent.max_concurrent_agents: 1`, and a durable `service.state_path` ledger outside the repo.
- The private receipts record the read-only selector preview's first candidate. Public/package docs should describe the selector policy and evidence boundary, not hard-code a transient HER issue identifier as the live target.

### Broad selector and concurrency policy

- Broad dispatch must be explicit in workflow config; the absence of a canary selector is not enough.
- Broad dispatch remains bounded by project/team key, active-state list, optional labels, `tracker.max_issues_per_poll`, `agent.max_concurrent_agents`, and `agent.max_concurrent_agents_by_state`.
- Multi-issue live service readiness requires a durable state ledger so restarts do not redispatch completed issues or duplicate live mutations.
- Bounded live rollout starts at low concurrency and can increase only after receipts show no duplicate mutation or fan-out surprise.

### Durable state policy

- Live broad service workflows must configure `service.state_path` outside the repo, normally under `~/.hermes/artifacts/symphony/` or `~/.local/state/symphony-ts/`.
- The ledger records run start/completion/failure and mutation idempotency keys.
- On service startup, any previously running ledger entries are marked interrupted/stale before new dispatch begins.
- Completed issue IDs in the ledger seed the orchestrator completed set, preventing restart redispatch when Linear state remains active.

### Linear mutation policy

- Live Linear mutation is opt-in via workflow config.
- Mutations are redacted in receipts and must not expose raw auth headers/tokens.
- Status comments and state transitions use idempotency keys stored in the durable ledger to avoid duplicate comments/transitions across restarts.
- If state IDs/names are not configured, the service may still run comment-only mutation but must report that state transitions are disabled.

### Codex execution policy

- Preserve the known good live path: `codex app-server`, explicit approval/sandbox config, live-appropriate timeouts, `workspace.source.kind: git_worktree`, cwd containment, and Linear-token env scrubbing before child Codex spawn.
- Do not inject raw OpenAI/Linear/Codex tokens into prompts, workspaces, logs, or receipts.
- The `symphony-codex-*` CLIs and the underlying `CodexAppServerRunner` surface are retained only as legacy compatibility and operator-recovery paths. They are not the path to Kanban readiness; a successful direct Codex issue-run proves only that the legacy runner seam can spawn an app-server for the exact approved issue and does not prove that the Kanban-first work engine can materialize tasks, pass a no-worker canary, or safely dispatch through the Hermes gateway. Do not cite direct Codex run receipts as evidence for Kanban readiness; cite Kanban canary, bridge, or integration receipts instead. A future reviewed removal slice may retire these CLIs and the direct runner when equivalent or better Kanban-first evidence exists for all supported workflows.

### PR and patch-promotion policy

- Non-empty Codex output must be promoted through the existing local patch-promotion surface or a stronger equivalent before branch push/PR creation.
- Verification must pass before local commit and push.
- PR creation and Linear PR-status updates must record receipt paths and live readback URLs.

### Systemd rollout policy

- The existing user unit is currently a safe `--demo-idle` service. Switching it to a live workflow is a behavioral rollout.
- Before editing the unit, run print/check readiness for the exact private workflow artifact.
- Back up the unit and workflow path before restart; after restart verify active state, command line, journal, restart counters, and issue-selection behavior.

### Control-plane policy

- No listener starts unless `service.control_plane.enabled: true`.
- Default bind is loopback. External bind requires explicit `allow_external_bind: true` and an auth token for mutating endpoints.
- Read-only endpoints expose health/status/snapshot with redaction. Mutating endpoints require bearer-token authorization.

### Release/publication policy

- Public source/package metadata uses Apache-2.0 to match the upstream `openai/symphony` repository license posture.
- The npm package name is the owned scoped name `@hermegeddon/symphony-ts`; the unscoped `symphony-ts` name is occupied by another publisher and must not be used for publication.
- Publishing still requires clean package/audit receipts, npm authentication for the intended scope, and post-publish readback. If registry permissions are missing or ambiguous, complete local release-readiness checks and report the blocker instead of pretending publication succeeded.

## Implementation phases

1. Add durable issue-run ledger and restart-safety integration.
2. Add explicit broad-dispatch workflow config and service readiness predicates.
3. Add opt-in Linear mutation client/notifier with redacted receipts and ledger idempotency.
4. Add loopback-default HTTP control plane with authenticated mutating endpoints.
5. Update docs/API policy ledger/tests for the approved phase.
6. Run local fake verification: focused tests, `npm run check`, `npm run build`, `npm run smoke:local`, `npm run demo:fake`, `git diff --check`.
7. Prepare private live workflow artifact and no-side-effect confirmation/check.
8. Run a low-concurrency broad-selector live pilot through secret-exec only if credentials and exact workflow state are available.
9. Promote any non-empty patch through local verification, branch push, PR creation, and Linear update when GitHub/Linear permissions are available.
10. Roll persistent systemd unit from demo-idle to the private live workflow after readiness passes.
11. Complete public release/package readiness; publish only if license, name, registry auth, and scans are clean.

## Stop conditions

Stop and report instead of continuing if raw secrets would need to be revealed, a destructive history rewrite is required, license/package publication choice cannot be made safely, external credentials or permissions are missing, broad dispatch produces duplicate mutation or unbounded fan-out, or required verification fails and cannot be repaired locally.

## Receipt and artifact locations

Use private receipt roots under `~/.hermes/artifacts/symphony/` for live workflow artifacts, run ledgers, mutation receipts, control-plane readiness checks, systemd backups, pre-publication audit reports, and release receipts. Keep checked-in docs portable and avoid embedding private absolute receipt contents unless the path is intentionally operator-facing.
