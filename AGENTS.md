# Project notes for Symphony

This file lives in the repository root so every agent or editor that opens the project can read the same constraints. Treat `README.md` as the public overview and this file as the agent-facing operating boundary.

## Current scope

This repository is a local-first TypeScript implementation of the OpenAI Symphony service specification. It is now Kanban-first: Hermes Kanban is the canonical Symphony work engine, and the direct in-process Linear/Codex backend is legacy compatibility. It is package/service-ready for local fake/demo verification, Kanban facade operation, no-worker Linear Project → Kanban canaries, and gated live-autonomy phases. Fake/demo remains the default posture; live operation requires private workflow artifacts, exact board/profile/workspace scope, bounded dispatch policy, durable state/artifacts, receipts, and rollback evidence.

The local implementation currently includes:

1. Workflow loader and typed config layer
2. Linear-compatible tracker read adapter and normalized issue model
3. Workspace manager and hook runner with path-containment invariants
4. Hermes Kanban backend facade with typed config, CLI seam, readiness checks, graph materialization, typed task-link create/unlink/readback parsing, service snapshot mapping, and no-worker canary support
5. Orchestrator scheduler, retries, continuation, reconciliation, and state snapshot for the legacy in-process backend
6. Observability/status surface and CLI/service entrypoint
7. Conformance fixture suite
8. Redacted Linear validation receipts via `LinearTrackerClient` and `startSymphonyService({ trackerReceiptSink })`
9. Local-only Codex protocol preflight receipts via `runCodexProtocolPreflight` for legacy compatibility
10. Single-issue Codex issue-run and local patch-promotion operator CLIs as legacy compatibility/recovery surfaces
11. Service CLI print/check live-readiness gates that do not query Linear, start Codex, create workspaces, or write receipts
12. Typed `workspace.source.kind: git_worktree` materialization for real local source repos without persistent branches
13. Durable issue-run ledger for restart-safe completed/interrupted run state and mutation idempotency markers
14. Optional loopback-first HTTP control plane for health/status/snapshot and authenticated local control actions
15. Configured Linear lifecycle mutation client/notifier for redacted, idempotent comments and state transitions
16. Kanban-mode service startup that exposes the Kanban control-plane facade without requiring legacy Linear tracker or Codex runner config
17. Packaged `symphony-kanban-canary` operator CLI for repeatable no-worker Kanban readback/materialize-if-missing receipts before any worker/gateway dispatch gate
18. Packaged `symphony-linear-kanban-bridge` operator CLI for Linear issue polling, Kanban task materialization, and idempotent Kanban→Linear lifecycle sync without invoking the legacy Codex runner
19. Packaged GraphSync CLIs for local/read-only diff receipts, mapped read-only live snapshots, read-only recurring status/watchdog checks, exact-scope live Kanban blocking-link apply, and exact-scope live Linear relation apply
20. Private exact-scope integrated dependent-worker canary evidence for Linear relation creation, Kanban blocking-link materialization, provider-registered parent-before-child worker dispatch, and exactly-once Linear completion sync

## Local-first rules

- No live credentials, tokens, or network calls are required by tests or demo scripts.
- CLI demo scripts use fake/demo fixtures only (`src/demo/*`). The checked-in root `WORKFLOW.md` is Kanban-backed; fake smoke fixtures live in `src/demo/workflow.ts`.
- The normal verification path is local: `npm run check`, `npm run build`, and fake/demo smokes.
- No push, publish, deploy, service restart, public release, or remote branch update is authorized by default. The 2026-06-23 live-autonomy authorization is recorded in `docs/live-autonomy-rollout-plan.md`; future sessions must preserve its safeguards and receipt/rollback requirements instead of treating it as blanket permission for unrelated scope.
- Package metadata now targets public release under the owned scoped npm name `@hermegeddon/symphony-ts` and Apache-2.0, matching the upstream `openai/symphony` repository license posture. Publishing still requires npm auth/readback for that scope.

## Live/public gates

Any test, script, or manual command that touches a real tracker, real Kanban board, real Kanban gateway/worker, real Codex process, real workspace hook, or external API must be behind explicit opt-in and human authorization for the exact scope.

For Kanban-first live validation and dispatch:

- Prefer `backend.kind: hermes_kanban` for new workflows and canaries.
- Treat direct Codex issue-runs as legacy compatibility evidence only; they do not prove the Kanban work-engine path.
- Prefer `symphony-kanban-canary --mode readback-only` for existing approved no-worker graphs and `--mode materialize-if-missing` only for an exact approved no-worker canary scope.
- Start with no-worker or `dispatch: dry_run` materialization/readback canaries: blocked/unassigned cards, explicit human gates, expected parent chain, and dry-run `spawned: []` plus `auto_assigned_default: []`.
- Exact-scope private evidence now exists for a two-task dependent-worker canary on board `linear`: Linear `blocks` relation → GraphSync Kanban `blocks` edge → provider-registered parent-before-child dispatch → Kanban `done` → exactly-once Linear `Done` sync. Treat that as evidence for that exact operator-controlled path only.
- Before broader or long-running gateway/worker dispatch, verify the actual dispatcher/gateway process has the Hermes `kanban_cross_deps` provider registered; a bare internal dispatch helper without that provider can falsely report blocked children as spawnable.
- Real-board mutation, worker/gateway dispatch beyond the exact approved canary, service restart, Linear mutation, PRs, deploys, and public release each remain separate exact-scope gates.

For live Linear validation and dispatch:

- Use `tracker.require_canary: true` plus an exact `tracker.canary_issue_identifier` whenever possible for canaries.
- For the approved broad phase, `tracker.allow_broad_dispatch: true` must be explicit and paired with project/team scope or an explicitly reviewed `tracker.all_approved_projects: true` all-visible-Linear scope, `tracker.active_states`, `tracker.max_issues_per_poll`, `agent.max_concurrent_agents`, durable `service.state_path`, and receipt capture.
- If an exact identifier is unavailable, use `tracker.canary_labels` only when the active human gate explicitly approves that broader selector and its blast radius.
- Do not infer a live issue identifier from test fixtures such as `OPS-42`; tests are fake-only.
- Use the exact issue/team/credential scope named by the active human gate or prior reviewed artifact.
- Preserve redacted request/response receipts and selected issue metadata receipts.
- Never print raw tokens, Authorization headers, API keys, or unredacted request bodies.
- Read-only Linear GraphQL queries are not permission to dispatch Codex, mutate Linear, push commits, or broaden project/state fan-out.

For legacy live Codex/autonomy:

- Treat real Codex runs as a separate legacy gate from read-only Linear validation and from Kanban readiness.
- The local `runCodexProtocolPreflight` harness may be exercised with fake JSONL app-server fixtures only unless a fresh human gate approves an exact live Codex/OpenAI preflight scope.
- The `symphony-service --print-confirmation` and `symphony-service --check` modes are no-side-effect readiness gates. They must not query Linear, start Codex, create workspaces, or write receipts.
- Live-readiness requires `workspace.source.kind: git_worktree` with an existing clean local source repo and resolvable base ref; do not rely on empty directories or hook-only checkout behavior for live canaries.
- Service workflow mode must fail closed before startup for live-looking Codex/OpenAI commands unless the operator supplies `--allow-live-codex-openai-command` and the matching `--confirmation-digest` from the reviewed print-only packet.
- Broad autonomy is authorized only for the 2026-06-23 phase described in `docs/live-autonomy-rollout-plan.md`; start with low concurrency/limits, preserve ledger/receipt evidence, and stop on duplicate dispatch/mutation or unbounded fan-out.
- Approval, sandbox, operator-confirmation, workspace sync/population, and Codex default policies must be selected deliberately; do not invent defaults just to keep coding.

HTTP/control-plane surfaces:

- The control plane is disabled by default. When enabled, default bind is loopback; non-loopback bind requires explicit `allow_external_bind: true` and a non-empty auth token.
- Read-only `/health` and `/status`/`/snapshot` must not expose raw secrets. Mutating endpoints such as `/tick` and `/shutdown` require bearer auth.
- Do not expose through a reverse proxy, firewall, tailnet ACL, or public listener without a separate exact-scope exposure receipt.

## Tooling

- Node `>=24.0.0`
- npm `11.11.0` via `packageManager`
- TypeScript, Vitest, ESLint

Common commands:

```bash
npm install
npm run check        # typecheck + lint + tests
npm run typecheck
npm run lint
npm test
npm run build
```

Demo scripts (fake-only, no credentials):

```bash
npm run smoke:local
npm run demo:fake
npx symphony-fake-check
```

## Important file paths

- `README.md` — public-facing repo overview and policy notes
- `WORKFLOW.md` — sample Kanban-backed workflow config used for local facade/check workflows
- `package.json` — scripts, exports, bin entry
- `src/index.ts` — public API surface
- `src/workflow.ts` — workflow loader/effective config
- `src/tracker.ts` — Linear-compatible tracker and redacted receipt types
- `src/workspace.ts` — workspace manager and hook runner
- `src/codex-runner.ts` — legacy Codex app-server runner abstraction
- `src/codex-preflight.ts` — local-only legacy Codex protocol preflight receipt harness
- `src/linear-kanban-canary.ts` — no-worker Linear Project → Hermes Kanban materialization canary
- `src/kanban-canary-operator.ts` — operator receipt/validation layer for no-worker Kanban readback/materialize-if-missing workflows
- `src/cli/kanban-canary.ts` — packaged `symphony-kanban-canary` CLI entrypoint
- `src/linear-kanban-bridge.ts` and `src/cli/linear-kanban-bridge.ts` — Kanban-first Linear lifecycle bridge operator
- `src/graph-sync-live-snapshot.ts`, `src/graph-sync-live-readers.ts`, and `src/cli/graph-sync-snapshot.ts` — read-only mapped GraphSync snapshot capture
- `src/graph-sync-status.ts` and `src/cli/graph-sync-status.ts` — read-only recurring GraphSync `last-run.json` status/watchdog classifier; emits `PASS`/`REVIEW`/`BLOCK` without graph apply, service edits, or dispatch
- `src/graph-sync-materializer.ts`, `src/cli/graph-sync-materialize-kanban.ts`, and `src/cli/graph-sync-materialize-linear.ts` — gated GraphSync apply surfaces for exact-scope Kanban links and Linear relations
- `src/orchestrator.ts` — scheduler/retry/reconciliation logic
- `src/service.ts` — service startup/reload wrapper
- `src/demo/*` — reusable fake fixtures
- `src/cli/*` — local CLI entrypoints
- `docs/codex-protocol-preflight-harness.md` — preflight receipt contract and live-run gate
- `docs/kanban-first-migration.md` — selected Kanban-first backend direction and compatibility stance
- `examples/fake-workflow.md` — copy-paste example of a minimal workflow
- `tests/*` — fake-only unit/conformance coverage

## Package / import notes

- Build output goes to `dist/` preserving the source layout (`dist/src/*.js`).
- Public entry point is `./dist/src/index.js` (and matching `.d.ts`).
- CLI bins include `symphony-service`, `symphony-fake-check`, `symphony-kanban-canary`, `symphony-linear-kanban-bridge`, `symphony-graph-sync-diff`, `symphony-graph-sync-snapshot`, `symphony-graph-sync-status`, `symphony-graph-sync-materialize-kanban`, `symphony-graph-sync-materialize-linear`, and legacy compatibility `symphony-codex-issue-run-confirm`, `symphony-codex-issue-run`, and `symphony-codex-promote-patch`.
- Import with extensions (for example `../domain.js`) because `module: NodeNext` is enabled.
- `files` in `package.json` ships `dist/src/**/*`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `examples/**/*`; repo-local operator docs are not shipped.

## Current live-autonomy policy decision

The bounded `HER-1` Linear canary passed on 2026-06-21 and remains evidence for that exact historical scope. On 2026-06-23 Janusz authorized the next live-autonomy phase; `docs/live-autonomy-rollout-plan.md` records the replacement private `team_key: HER` low-concurrency pilot safeguards for broad Linear dispatch, multi-issue live autonomy, persistent systemd rollout, live Linear mutation, PR creation, deploy/restart, publication, and control-plane work. The authorization does not permit raw secret disclosure, destructive git history rewriting, unrelated branch deletion, public release without package/license gates, or claiming live behavior from fake/demo evidence.

## Selected policies and remaining gates

Selected conservative implementation-defined policies are recorded in `README.md`, `src/index.ts` (`implementationPolicyDecisions`), and `docs/spec-compliance-matrix.md`:

- Local fake/demo verification is the default trust posture.
- The GraphSync status/watchdog surface is read-only operator observation: it reads the recurring GraphSync `last-run.json`, classifies `PASS`/`REVIEW`/`BLOCK` with a 15-minute default stale threshold, and does not authorize graph apply, Linear/Kanban mutation, service/timer edits, or worker/gateway dispatch.
- Kanban-first live behavior requires human authorization, exact board/profile/workspace/artifact scope, blocked/no-worker or dry-run evidence first, provider-registered dependency enforcement for dependent-worker dispatch, and redacted receipts. Private exact-scope H1 evidence proves a two-task dependent-worker path only; broader dispatch/service rollout still requires a fresh gate. Legacy live Linear/Codex behavior requires human authorization, digest-bound operator confirmation, clean git-worktree source repos, and redacted receipts. Exact canary selectors remain preferred for legacy canaries; broad dispatch requires `tracker.allow_broad_dispatch`, bounded selectors, per-poll/concurrency limits, and durable `service.state_path`.
- Approval requests fail unless explicitly configured for auto-approval.
- Sandbox values pass through to the legacy Codex runner with the documented Codex `0.141.0` wire-shape mapping.
- Fake/demo workspaces may be empty directories; live-readiness requires clean git-worktree source repos.
- The service keeps last-known-good runtime dependencies on invalid reloads and reapplies default runtime dependencies on valid reloads.
- HTTP/control-plane support is disabled by default; enabled listeners default to loopback and require bearer auth for mutating endpoints. In Kanban mode, the control plane exposes the Kanban facade and refuses worker dispatch because gateway dispatch is external to Symphony.

Do not broaden any of those policies silently. Any scope outside `docs/live-autonomy-rollout-plan.md` still requires a fresh exact-scope gate and documentation update before implementation.

## npm warnings / troubleshooting

- If `npm install` warns about `packageManager` mismatch, run with the pinned npm version (`npm@11.11.0`) or use `corepack`/`mise` to select the correct node/npm pair.
- If `npm run lint` fails with `parserOptions.projectService`, ensure TypeScript and `typescript-eslint` versions match `package-lock.json` (delete `node_modules` and re-run `npm install`).
- If a CLI script is invoked before `npm run build`, it will fail because the `dist/` files are missing. Build first, or run `npm run check`.
