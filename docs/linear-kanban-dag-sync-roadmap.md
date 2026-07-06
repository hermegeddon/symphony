# Linear ↔ Hermes Kanban DAG Sync roadmap

This roadmap is the public-safe continuation point for the Symphony Linear ↔ Hermes Kanban DAG/GraphSync tranche. It reconciles the original broader T1–T12 tranche plan with the implemented local/read-only GraphSync commit-label sequence and later gated apply/canary slices. Those commit labels are not the same as the original tranche's T1–T5 issue labels: the implemented sequence covers ledger substrate, read-only diff receipts, cycle receipts, endpoint policy receipts, the local CLI artifact wrapper, richer relation read-shape support, read-only mapped live snapshot capture, fake Kanban materialization, narrowly gated live Kanban and Linear apply operators, and operator-private exact-scope dependent-worker canary evidence. It is not blanket live-operation approval.

## Boundary

Reusable package scope for this roadmap is local code, tests, docs, examples, read-only/fake-only receipt artifacts, read-only mapped live snapshot capture, and the gated `symphony-graph-sync-materialize-kanban` / `symphony-graph-sync-materialize-linear` operators for exact-scope live blocking-link/relation apply from prior read-only receipts. The roadmap and package docs do **not** authorize:

- live Hermes Kanban link/unlink apply outside the exact `symphony-graph-sync-materialize-kanban` command scope, flags, cap, and receipt/readback contract;
- live Linear relation create/update/delete outside the exact `symphony-graph-sync-materialize-linear` command scope, flags, cap, and receipt/readback contract;
- live or non-fake use of the `symphony-linear-kanban-graph-sync-tick` CLI outside `--mode fake_local_readonly`;
- service/timer edits or restarts;
- gateway/worker dispatch;
- MCP mutation tools;
- PR creation, tag, npm publish, deploy, or public visibility changes.

Any live/apply/public expansion beyond the gated Kanban link operator, gated Linear relation operator, or already approved exact canary scope still needs a fresh exact-scope approval packet with preconditions, commands, artifacts, readback expectations, allowed mutations, forbidden mutations, rollback/disable steps, and receipt preservation.

## Definition gate: live bidirectional sync

For Symphony, **live bidirectional sync** is not satisfied by the recurring lifecycle bridge alone. A live bidirectional claim requires a recurring DAG/GraphSync companion loop that is ordered with the lifecycle bridge and that, at minimum, can repeatedly:

1. capture mapped Linear issue/relation state and Hermes Kanban task/link state;
2. produce a fresh read-only GraphSync diff/status receipt for the approved scope;
3. apply or propose dependency-edge changes according to an explicit authority mode, caps, gates, and readbacks;
4. make dependency readiness visible before worker/gateway dispatch can treat successors as runnable.

Until that recurring GraphSync loop exists and has clean receipts for the approved scope, the broad `symphony-linear-kanban-bridge` timer is a **live lifecycle bridge**, not full live bidirectional Linear ↔ Hermes Kanban sync. Linear `blocks` relations and Linear parent/sub-issue hierarchy must be treated as provenance unless a GraphSync apply/readback has created the corresponding executable Kanban dependency edges.

## Sources reconciled

- Original DAG/GraphSync tranche proposal from 2026-06-27.
- Read-only Linear relation schema / Kanban edge seam / GraphSyncLedger spike from 2026-06-27.
- Local GraphSync implementation commit-label sequence through the read-only diff CLI, read-only snapshot capture, gated Kanban apply, gated Linear apply, and dependency-registry snapshot-reader slices.
- Current repository policy in `AGENTS.md`, `README.md`, and `docs/spec-compliance-matrix.md`.
- Operator-private exact-scope canary evidence through the 2026-07-01 H1 dependent-worker run.

The original plan's T1–T12 labels are broader than the later local GraphSync commit-label sequence T1–T5. Treat the local commit-label sequence as a safe subset/repackaging of the early tranche substrate, not as completion of the full original T1–T12 roadmap or of original T4/T5 apply/fill-in behavior.

## Completed local/read-only and fake-only substrate

| Local slice | Status | Evidence |
|---|---|---|
| GraphSyncLedger model, edge keys, schema fixtures | Done | `src/graph-sync-ledger.ts`, `tests/graph-sync-ledger.test.ts` |
| Read-only diff receipt builder | Done | `buildGraphSyncReadOnlyDiffReceipt`, duplicate/merge behavior, suppressed proposed operations |
| Cycle receipts | Done | `diff.cycles`, `summary.cycles_detected`, cycle semantic events |
| Endpoint policy receipts | Done | unmapped/out-of-scope/deleted/inaccessible endpoint policy records; invalid apply proposals suppressed |
| Local CLI artifact wrapper | Done | `symphony-graph-sync-diff --mode read_only_diff --input ... --output ...` |
| Snapshot examples | Done in this continuation slice | `examples/graph-sync-readonly-diff/*.snapshot.json`, CLI example test coverage |
| Receipt-only severity and human-action metadata | Done in the receipt-metadata slice | closed `severity` and `human_action_recommendation` fields on conflicts, cycles, endpoint policies, semantic events, and suppressed proposed operations |
| Operator summary/status artifacts | Done in the operator-artifacts slice | optional declared `--summary-output` Markdown and `--status-output` JSON artifacts from explicit local snapshots; triage status only, no apply authority |
| Fake-only typed Kanban blocking-edge seam | Done in the typed-link seam slice | `createTaskLink` / `deleteTaskLink` wrappers around `hermes kanban link` / `unlink` plus typed `showTask` parent/child link readback parsing; covered by fake CLI executor tests only |
| Richer Linear relation read-shape coverage | Done in the relation-read-shape slice | tracker reads both `relations` and `inverseRelations`, preserving relation IDs, endpoint orientation, timestamps, archive state, and observation source while keeping `blocked_by` compatibility |
| Read-only mapped live GraphSync snapshot capture | Done in the snapshot-capture slice | `symphony-graph-sync-snapshot --mode read_only_snapshot` reads bridge-ledger mappings, exact Linear issue relation state, and enriched Hermes Kanban task-link state into local snapshot/receipt/summary/status artifacts with suppressed-write non-actions |
| Fake-only Linear-authoritative Kanban blocking-edge materializer | Done in the fake-materializer slice | `materializeGraphSyncMissingKanbanBlockingEdges` consumes local read-only diff receipts, calls an injected `KanbanClient`, creates typed `blocks` links, verifies readback, and emits explicit non-actions without constructing a live client |
| Top-level `graph_sync` workflow config schema | Done in the Swarm 1 config slice | `src/workflow.ts` accepts the block inertly by default, rejects apply-like modes and non-propose-only proposal policies, enforces positive read caps, defaults `dispatch_reliance.enabled` to false, and records the API policy boundary in `tests/index.test.ts` |
| Gated live Linear-authoritative Kanban blocking-edge apply | Done in the live-apply CLI slice | `symphony-graph-sync-materialize-kanban --mode linear_authoritative_apply` consumes a prior read-only receipt, requires exact approved scope, explicit Hermes command/home/board config, `--allow-live-kanban-apply`, and a max-created cap, then creates typed live Kanban `blocks` links with child-task readback receipts |
| Gated live Kanban-authoritative Linear relation apply | Done in the live-apply CLI slice | `symphony-graph-sync-materialize-linear --mode kanban_authoritative_apply` consumes a prior read-only receipt, requires `LINEAR_API_KEY`, exact approved scope, `--allow-live-linear-apply`, and a max-created cap, then creates missing Linear `blocks` relations with readback receipts |
| Fake/local-readonly recurring lifecycle + GraphSync tick CLI | Done in the recurring-tick CLI slice | `symphony-linear-kanban-graph-sync-tick --mode fake_local_readonly` runs injected fake lifecycle and GraphSync fixtures, writes local receipt/status/summary artifacts, exits `0/1/2/3` for PASS/error/REVIEW/BLOCK, records mutation non-action booleans as `false`, and does not construct live Linear/Hermes clients |
| Exact-scope integrated dependent-worker canary | Done for the operator-private H1 scope | Two fresh Linear issues plus one Linear `blocks` relation were materialized to board `linear`; GraphSync created/read back one Kanban blocking edge; provider-registered dispatch spawned parent before child; both Kanban tasks completed; Linear completion sync was exactly-once. This is not broad/gateway/service evidence. |
| Fake/local GraphSync checkpoint state-path persistence | Done in this state-path slice | `createFileSystemGraphSyncStateStorage` and `createInMemoryGraphSyncStateStorage` provide durable checkpoint-state seams. `symphony-graph-sync-snapshot` exposes `--state-path PATH` and `--dry-run-state`. Repeated read-only snapshot runs advance `generation`/`previous_generation` from durable state; writes remain local and read-only, with no Linear/Kanban/service mutation |

Current receipt-metadata schema placement and allowed values:
- `human_action_recommendation`: `none`, `review`, `inspect_endpoint_policy`, `resolve_cycle`, or `human_decision_required`.
- Placement: `GraphSyncConflictRecord`, `GraphSyncCycleRecord`, cycle `GraphSyncSemanticEventRecord`, `GraphSyncEndpointPolicyRecord`, and suppressed `GraphSyncProposedOperationRecord`.
- Current read-only emitters use `error`/`resolve_cycle` for cycles, `error`/`human_decision_required` for conflicts, `warning`/`inspect_endpoint_policy` for endpoint policies, and `warning`/`review` for suppressed proposed operations.
- These metadata fields are operator triage hints only; they do not authorize writes, apply mode, live Linear/Kanban mutation, service changes, or MCP mutation tools.

## Original T1–T12 reconciliation

| Original tranche item | Reconciled status | Notes / next action |
|---|---|---|
| T1 — Canonical dependency graph model, GraphSyncLedger, and fixtures | Mostly done locally | Ledger/types/fixtures exist. Keep extending fixtures as new edge states are introduced. |
| T2 — Read-only Linear/Kanban full-graph importer and diff receipts | Partially done | Local explicit-snapshot diff receipts exist. Live/full graph import and dependency-closure reads remain future gated work. |
| T3 — Linear relation and Kanban edge seam/schema spike | Read-shape, fake Kanban edge seam, and exact relation-write canaries complete | Spike confirmed Linear relation fields/mutations and Kanban CLI flags. The tracker preserves richer relation read-shape data, and the fake-tested typed Kanban seam covers blocking-edge create/unlink/readback shape. Exact private relation-write canaries prove the Linear `blocks` orientation for approved throwaway issues. `blocked_by` is adapter-only vocabulary and must not be configured as a Linear enum. Broader relation mutation remains gated. |
| T4 — Linear → Kanban blocking-edge materialization | Fake helper, gated live Kanban apply operator, and exact H1 apply evidence complete; broader apply still gated | `materializeGraphSyncMissingKanbanBlockingEdges` proves Linear-authoritative blocking-edge materialization against injected fake clients. `symphony-graph-sync-materialize-kanban` provides exact-scope live Kanban link apply from prior read-only receipts with cap/readback receipts. H1 proved one fresh Linear relation becoming one executable Kanban `blocks` edge on a shared board. Unlink/delete, missing-node fill-in, broad scheduler reliance, and recurring bidirectional apply remain gated future work. |
| T5 — Missing Kanban node fill-in from Linear dependencies | Remaining | Implement local policy for full task vs blocked stub vs external/inaccessible endpoint reporting before any live apply. Stub titles/provenance for out-of-scope or external endpoints must be redacted/minimized so private team/project/issue context is not leaked into shared Kanban or Linear surfaces. |
| T6 — Dependency-aware scheduler gates | Partially proven for exact canaries; local recurring tick/canary contract added; product/service integration remaining | H1 proved a provider-registered dispatcher path skips a child until the parent reaches `done`, then spawns the child, and the follow-up provider-load gate proved the actual gateway path can reject an externally blocked child. `runRecurringLinearKanbanGraphSyncTick` now fake-tests the lifecycle-before-GraphSync ordering contract and emits `dispatch_reliance_decision` receipts for clean, deferred, and blocked graph states; `runRecurringLinearKanbanGraphSyncCanary` writes local receipt/status/summary artifacts and suppresses dispatch-reliance probes when readiness is deferred or blocked. The `symphony-linear-kanban-graph-sync-tick` CLI packages the fake/local-readonly side of this contract with exit codes `0/1/2/3` for PASS/error/REVIEW/BLOCK and mutation non-action booleans. Remaining work is to wire dependency readiness into recurring service/gateway operation for broad dispatch, including terminal non-success policy and receipts that prove Linear DAG changes are reflected before successors run. |
| T7 — Kanban → Linear dependency diff in propose-only mode | Partially bypassed by gated apply CLI; proposal UX still remaining | `symphony-graph-sync-materialize-linear` can apply missing Linear `blocks` relations from Kanban-authoritative read-only receipts under exact live gates. A richer propose-only operator UX for Kanban-only executable edges remains future work and should precede any broad recurring Linear apply. |
| T8 — Gated Kanban → Linear relation apply mode | Implemented as a capped exact-scope CLI; broader apply still gated | The CLI requires a prior read-only receipt, `LINEAR_API_KEY`, exact approved scope, `--allow-live-linear-apply`, and `--max-created`, and verifies relation readback. Delete/unlink, tombstones, conflict handling, recurring apply, and broad scopes remain future gates. |
| T9 — Canary rollout on one approved Linear project | Exact canary evidence exists; broader lifecycle rollout is enabled but not DAG-complete | H1 proved one fresh dependent-worker pair on the shared board under exact scope, and the later broad lifecycle timer rollout was quiescent because no active Linear candidates were visible. The local recurring tick and canary harness define the receipt/artifact shape a bounded recurring GraphSync/DAG canary should satisfy, but the integrated live canary itself still needs lifecycle materialization, Linear relation/sub-issue observation, Kanban edge apply/proposal, readiness receipts, and gateway dispatch ordering verified together. Linear Project/issue creation beyond exact canaries remains proposal-first external mutation and is not implied by this roadmap. |
| T10 — Linear stub issue proposal/create policy | Remaining / gated | Default should remain propose-only; create mode needs dedupe, exact project/team scope, idempotency key, approval, and redacted/minimized stub title/body/provenance. |
| T11 — Richer commands, receipts, comments, and operator UX | Partial | CLI artifact wrapper, examples, and local `summary.md` / `status.json` artifacts exist. Remaining: richer exit codes and exactly-once conflict/cycle comments. |
| T12 — MCP read-only graph/status/proposal tools | Remaining | MCP v0 should be read-only/proposal-only with bounded/redacted output and no apply surface. |

## Recommended execution phases

### Phase A — Finish read-only/operator usability

1. Keep `symphony-graph-sync-diff` example snapshots executable and public-safe.
2. Keep receipt-only severity and human-action recommendation fields on cycles, endpoint policies, conflicts, semantic events, and suppressed proposed operations; do not treat those fields as write authorization.
3. Keep richer operator artifacts such as `summary.md` and `status.json` generated only from explicit local snapshots and declared output paths.
4. Add fixture coverage for inaccessible vs deleted/archive endpoint distinctions when the read model can represent them precisely.

### Phase B — Build fake-only apply machinery

1. Keep the Linear relation adapter preserving relation IDs, both endpoints, timestamps, archive state, and observation source; extend with pagination, duplicate relation IDs, type-shift state, and permission/visibility diagnostics as fixture coverage expands.
2. Keep the fake helper as the default test substrate; use `symphony-graph-sync-materialize-kanban` only for exact-scope approved live Kanban blocking-link apply from a prior read-only receipt.
3. Implement missing-node/stub policy against fake clients only, including redacted/minimized external/out-of-scope endpoint provenance.
4. Implement dependency readiness computation and scheduler gates against fake graphs only, preserving `human_decision_required` as the default terminal-non-success policy.

### Phase C — Exact-scope canaries

Completed exact-scope evidence now includes: read-only Linear graph snapshots for mapped canary pairs, live Linear relation write for throwaway issues, live Kanban blocking-link apply for one relation, the H1 integrated dependent-worker canary, and a provider-load/readiness gate for the actual gateway path. Remaining canary work should focus on surfaces not yet proven by H1/provider-load evidence:

1. Temp-board link/unlink canary: prove blocking link create/readback/unlink and dry-run dispatch skip behavior on a non-shared board.
2. Recurring DAG canary for an exact approved subset: run lifecycle materialization plus recurring read-only GraphSync snapshot/diff, then apply/propose dependency edges under caps before any successor dispatch claim.
3. Broader shared-board DAG canary: exact approved subset only, repeated read-only snapshot/diff receipts, max-created caps, duplicate-free evidence, and no ambient ready/default-assignee surprises.
4. Terminal-non-success dependency canary: prove successors become `human_decision_required` rather than silently wedged or auto-unblocked.

### Phase D — Reverse/propose and later apply

1. Add Kanban → Linear propose-only graph diff.
2. Add bidirectional relation apply only after checkpoint/conflict/readback rules and human gates are proven.
3. Add Linear stub issue create mode only after dedupe/proposal policy and exact scope are approved.
4. Add MCP graph/status/proposal tools as read-only resources first; keep MCP apply out of v0.

## Per-slice engineering discipline

- Use strict TDD: one failing test, minimal implementation, then refactor.
- Prefer vertical slices through public APIs/CLIs over broad internal scaffolding.
- Keep fake/local tests as the default evidence.
- Preserve exact non-actions in receipts and docs.
- Keep private live workflow details out of shipped examples and public-safe docs.
- Commit locally after each verified slice unless a concrete no-commit reason applies.

## Next safe slices

Recommended immediate follow-ups after H1:

1. Extend the local canary harness into an exact-scope integrated canary that persists lifecycle + GraphSync receipts from real approved inputs and proves no dispatch reliance when `dispatch_reliance_decision` is `deferred` or `blocked` before any service/gateway wiring.
2. Add missing-node/stub policy against fake clients only, including redacted/minimized external/out-of-scope endpoint provenance.
3. Promote dependency-readiness computation into first-class fixtures and service/gateway pre-spawn gates, preserving `human_decision_required` as the default terminal-non-success policy.
4. Add Kanban → Linear propose-only graph diff UX around the existing exact-scope Linear apply CLI; keep broad/recurring Linear writes and MCP/apply surfaces out of scope.
