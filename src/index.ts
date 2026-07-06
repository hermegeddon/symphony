export type {
  CodexEventName,
  CodexRateLimitSnapshot,
  CodexTokenTotals,
  Issue,
  IssueBlockerRef,
  LinearIssueProjectRef,
  LinearIssueTeamRef,
  LiveSession,
  OrchestratorRuntimeState,
  RetryEntry,
  RunAttempt,
  RunAttemptStatus,
  RunningIssueEntry,
  Workspace,
  WorkflowDefinition as DomainWorkflowDefinition,
} from './domain.js';
export {
  createEmptyOrchestratorRuntimeState,
  normalizeIssueStateName,
  sanitizeWorkspaceKeyFromIssue,
  toSessionId,
} from './domain.js';
export * from './codex-runner.js';
export * from './codex-preflight.js';
export * from './codex-issue-run.js';
export * from './codex-patch-promotion.js';
export * from './observability.js';
export * from './orchestrator.js';
export * from './issue-run-ledger.js';
export * from './linear-lifecycle-notifier.js';
export * from './control-plane.js';
export * from './kanban-client.js';
export * from './kanban-canary-operator.js';
export * from './kanban-graph-materializer.js';
export * from './graph-sync-ledger.js';
export * from './graph-sync-snapshot-importer.js';
export * from './graph-sync-materializer.js';
export * from './graph-sync-live-snapshot.js';
export * from './graph-sync-live-readers.js';
export * from './linear-kanban-graph-sync-tick.js';
export * from './graph-sync-recurring-state.js';
export * from './graph-sync-status.js';
export * from './graph-sync-state.js';
export * from './linear-kanban-canary.js';
export {
  buildKanbanMaterializationBody,
  buildKanbanMaterializationBodyWithCustomSection,
  buildKanbanMaterializationContext,
  buildMinimalKanbanMaterializationBody,
  fenceUntrustedText,
  fenceUntrustedTextBounded,
  quoteUntrustedText,
  quoteUntrustedTextBounded,
  redactIssueFreeText,
  redactIssueFreeTextBounded,
  type KanbanMaterializationBodyOptions,
  type KanbanMaterializationBridgeContext,
  type KanbanMaterializationContext,
  type KanbanMaterializationIssueContext,
  type KanbanMaterializationKanbanContext,
  type KanbanMaterializationLedgerContext,
} from './kanban-materialization.js';
export * from './linear-kanban-bridge.js';
export * from './kanban-readiness.js';
export {
  classifyKanbanLiveness,
  isBlockedByHumanOrExternalGate,
  isComputableClassification,
  recommendKanbanTaskAction,
  type ClassifyKanbanLivenessInput,
  type KanbanLivenessClassification,
  type KanbanLivenessClassificationResult,
  type KanbanLivenessComputabilityInventory,
  type KanbanLivenessRecommendation,
  type KanbanLivenessRecommendationKind,
  type KanbanLivenessTaskClassification,
} from './kanban-liveness.js';
export {
  createKanbanServiceFacade,
  type CreateKanbanServiceFacadeInput,
  type KanbanProvenanceWarning,
  type KanbanSymphonyService,
  mapKanbanStatusToSymphonyState,
  redactReceiptText,
  type SymphonyKanbanSnapshot,
  type SymphonyKanbanTaskCounts,
  type SymphonyKanbanTaskSnapshot,
  type SymphonyKanbanTaskState,
} from './kanban-service.js';
export * from './kanban-types.js';
export * from './service.js';
export * from './tracker.js';
export * from './workflow.js';
export * from './workspace.js';

export const symphonyImplementationName = 'symphony-ts' as const;

export interface ImplementationPolicyDecision {
  readonly topic: string;
  readonly status: 'selected' | 'gated' | 'explicit_non_goal';
  readonly decision: string;
  readonly evidence: readonly string[];
}

export const implementationPolicyDecisions: readonly ImplementationPolicyDecision[] = [
  {
    topic: 'trust-and-safety-posture',
    status: 'selected',
    decision: 'Local fake/demo verification remains the default posture. Live Linear dispatch, live mutations, persistent service rollout, PR/release/publication, and control-plane work are gated behind explicit workflow limits, durable ledgers, redacted receipts, digest-bound operator gates, and rollback evidence.',
    evidence: ['README.md#implementation-defined-policy-ledger', 'tests/cli-service.test.ts', 'tests/orchestrator.test.ts'],
  },
  {
    topic: 'operator-confirmation',
    status: 'selected',
    decision: 'Live-looking Codex/OpenAI service commands require a deterministic print-only confirmation packet and matching digest before startup; check/print modes are no-side-effect readiness gates.',
    evidence: ['src/cli/service.ts', 'tests/cli-service.test.ts'],
  },
  {
    topic: 'workspace-population-policy',
    status: 'selected',
    decision: 'Fake/demo workflows may use empty directories. Live-readiness requires an explicit clean git-worktree source repository and refuses unrelated existing directories or repos.',
    evidence: ['src/workspace.ts', 'tests/workspace.test.ts', 'README.md#workspace-manager-policy'],
  },
  {
    topic: 'dynamic-workflow-reload',
    status: 'selected',
    decision: 'The service polls WORKFLOW.md by interval, keeps last-known-good runtime on invalid reloads, and reapplies tracker/workspace/runner-affecting default dependencies on valid reloads before the next dispatch tick.',
    evidence: ['src/service.ts', 'tests/service.test.ts'],
  },
  {
    topic: 'live-validation-boundary',
    status: 'gated',
    decision: 'Historical bounded canaries are evidence for their exact scopes only. Reviewed broad-selector operation requires bounded selectors, max issues per poll, max active runs, durable issue-run ledgers, idempotent Linear mutation markers, private workflow artifacts, and receipt-backed live rollout gates.',
    evidence: ['README.md#implementation-defined-policy-ledger', 'tests/workflow.test.ts', 'tests/cli-service.test.ts'],
  },
  {
    topic: 'durable-live-service-state',
    status: 'selected',
    decision: 'Persistent live service workflows use a private service.state_path JSON ledger to recover interrupted runs, remember completed issue IDs across restarts, and dedupe Linear mutation keys before posting comments or state transitions.',
    evidence: ['src/issue-run-ledger.ts', 'src/orchestrator.ts', 'src/linear-lifecycle-notifier.ts', 'tests/issue-run-ledger.test.ts', 'tests/orchestrator.test.ts', 'tests/linear-lifecycle-notifier.test.ts'],
  },
  {
    topic: 'control-plane-read-privacy',
    status: 'selected',
    decision: 'Read-only /health remains minimal and unauthenticated on loopback. /status and /snapshot are unauthenticated only when the control plane is bound to loopback; any non-loopback bind requires bearer authentication for /status and /snapshot, and external bind is refused at runtime unless explicitly allowed by config.',
    evidence: ['src/control-plane.ts', 'src/workflow.ts', 'tests/control-plane.test.ts', 'tests/control-plane-kanban.test.ts'],
  },
  {
    topic: 'hermes-kanban-backend',
    status: 'selected',
    decision: 'When backend.kind is hermes_kanban, Symphony is a typed facade over Hermes Kanban and must not run a second dispatcher; board/task creation, typed task link create/unlink/readback parsing, readiness, graph materialization, service snapshots, and no-worker canary receipts flow through the narrow CLI seam. The typed task-link seam is fake-tested locally; real-board mutation and gateway dispatch remain separately gated.',
    evidence: ['src/kanban-client.ts', 'src/kanban-graph-materializer.ts', 'src/linear-kanban-canary.ts', 'src/kanban-canary-operator.ts', 'src/service.ts', 'tests/kanban-canary-operator.test.ts', 'tests/kanban-integration.test.ts', 'docs/hermes-kanban-backend.md'],
  },
  {
    topic: 'linear-kanban-bridge',
    status: 'selected',
    decision: 'symphony-linear-kanban-bridge is the Kanban-first Linear integration surface: it polls eligible Linear issues, including explicit all-visible Linear scope via tracker.all_approved_projects when reviewed and bounded, materializes Hermes Kanban tasks with durable idempotency keys, syncs observed Kanban completion back to Linear through configured lifecycle mutations, and never invokes the legacy Codex runner.',
    evidence: ['src/linear-kanban-bridge.ts', 'src/cli/linear-kanban-bridge.ts', 'src/tracker.ts', 'tests/linear-kanban-bridge.test.ts', 'tests/cli-linear-kanban-bridge.test.ts', 'tests/tracker.test.ts', 'README.md#linear--kanban-bridge-operator'],
  },
  {
    topic: 'graph-sync-read-only-diff',
    status: 'selected',
    decision: 'symphony-graph-sync-diff is a local-only GraphSync receipt artifact builder: it consumes an explicit JSON snapshot, writes a declared local read_only_diff receipt artifact, emits receipt-only severity and human-action metadata for operator findings, can write declared local summary.md and status.json triage artifacts, preserves suppressed-write non-actions, and does not query Linear, read or mutate Hermes Kanban, edit services/timers, or expose an MCP/apply surface.',
    evidence: ['src/graph-sync-ledger.ts', 'src/cli/graph-sync-readonly-diff.ts', 'tests/graph-sync-ledger.test.ts', 'tests/cli-graph-sync-readonly-diff.test.ts', 'README.md#graphsync-read-only-diff-artifacts'],
  },
  {
    topic: 'graph-sync-fake-kanban-materialization',
    status: 'selected',
    decision: 'GraphSync Linear-authoritative Kanban blocking-edge materialization has a fake-only, dependency-injected helper for local tests. It consumes a local read_only_diff receipt, calls an injected KanbanClient createTaskLink/showTask seam, emits explicit non-actions, and does not construct a real Hermes client, query Linear, mutate a live/shared Kanban board, edit services/timers, dispatch workers, or expose an MCP/apply surface. Live Kanban mutation is handled only by the separate gated CLI.',
    evidence: ['src/graph-sync-materializer.ts', 'tests/graph-sync-materializer.test.ts', 'tests/index.test.ts'],
  },
  {
    topic: 'graph-sync-live-kanban-apply',
    status: 'gated',
    decision: 'symphony-graph-sync-materialize-kanban is the gated live Kanban apply surface for GraphSync Linear-authoritative blocking edges. It consumes a local read_only_diff receipt, requires --mode linear_authoritative_apply, --allow-live-kanban-apply, an exact --approved-scope, explicit Hermes command/home/board config, and a max-created cap, then creates typed live Hermes Kanban blocking links with readback receipts. It still does not query Linear, create/update/delete Linear relations, edit services/timers, dispatch workers, or expose MCP apply behavior.',
    evidence: ['src/graph-sync-materializer.ts', 'src/cli/graph-sync-materialize-kanban.ts', 'tests/cli-graph-sync-materialize-kanban.test.ts', 'tests/package-cli-surface.test.ts', 'README.md#graphsync-read-only-diff-artifacts'],
  },
  {
    topic: 'graph-sync-live-linear-apply',
    status: 'gated',
    decision: 'symphony-graph-sync-materialize-linear is the gated live Linear apply surface for GraphSync Kanban-authoritative blocking relations. It consumes a local read_only_diff receipt, requires --mode kanban_authoritative_apply, LINEAR_API_KEY from the environment, --allow-live-linear-apply, an exact --approved-scope, and a max-created cap, then creates missing Linear blocks relations with readback receipts. It does not mutate Hermes Kanban, move Linear issue states, edit services/timers, dispatch workers, push, publish, deploy, or expose MCP apply behavior.',
    evidence: ['src/graph-sync-materializer.ts', 'src/cli/graph-sync-materialize-linear.ts', 'tests/cli-graph-sync-materialize-linear.test.ts', 'tests/package-cli-surface.test.ts', 'README.md#graphsync-read-only-diff-artifacts'],
  },
  {
    topic: 'graph-sync-read-only-snapshot-capture',
    status: 'selected',
    decision: 'symphony-graph-sync-snapshot captures read-only GraphSync observations of mapped Linear issues/relations and Hermes Kanban task/links, using the bridge ledger service.state_path for issue↔task mappings and exact Linear issue-id readback for relation fields. It builds an observed snapshot and read_only_diff receipt with explicit completeness metadata, writes local snapshot/receipt/summary/status artifacts, emits suppressed-write non-actions, and exits with status-derived codes. It remains read-only: no Linear relation writes, Kanban link writes, service/timer edits, worker dispatch, push, publish, or deploy.',
    evidence: ['src/graph-sync-live-snapshot.ts', 'src/graph-sync-live-readers.ts', 'src/cli/graph-sync-snapshot.ts', 'tests/graph-sync-live-snapshot.test.ts', 'tests/graph-sync-live-readers.test.ts', 'tests/cli-graph-sync-snapshot.test.ts', 'tests/package-cli-surface.test.ts'],
  },
  {
    topic: 'recurring-lifecycle-graph-sync-tick',
    status: 'selected',
    decision: 'runRecurringLinearKanbanGraphSyncTick is a local coordinator contract for full-live readiness work: it runs the lifecycle tick before the GraphSync snapshot, preserves both receipts, and emits dependency readiness plus dispatch_reliance_decision values of allowed, deferred, or blocked. runRecurringLinearKanbanGraphSyncCanary is a local canary harness that writes local receipt/status/summary artifacts and suppresses dispatch-reliance probes when readiness is deferred or blocked. The new symphony-linear-kanban-graph-sync-tick CLI is the fake/local-readonly packaged surface for Swarm 1; it records mutation non-action booleans as false, exits 0/1/2/3 for PASS/error/REVIEW/BLOCK, and does not construct live Linear/Hermes clients. Neither surface dispatches workers or edits services/timers.',
    evidence: ['src/linear-kanban-graph-sync-tick.ts', 'src/cli/linear-kanban-graph-sync-tick.ts', 'tests/linear-kanban-graph-sync-tick.test.ts', 'tests/cli-linear-kanban-graph-sync-tick.test.ts', 'tests/package-cli-surface.test.ts', 'tests/index.test.ts'],
  },
  {
    topic: 'graph-sync-status-watchdog',
    status: 'selected',
    decision: 'symphony-graph-sync-status reads the recurring GraphSync last-run.json wrapper and classifies PASS, REVIEW, and BLOCK with a 15-minute default stale threshold for timer jitter. It emits a compact operator JSON artifact for watchdog/readiness checks and does not mutate Linear or Hermes Kanban, does not edit services/timers or dispatch workers/gateway, and does not push, publish, deploy, or expose raw secrets.',
    evidence: ['src/graph-sync-status.ts', 'src/cli/graph-sync-status.ts', 'tests/graph-sync-status.test.ts', 'tests/cli-graph-sync-status.test.ts', 'tests/package-cli-surface.test.ts', 'README.md#current-status'],
  },
  {
    topic: 'live-bidirectional-sync-definition',
    status: 'gated',
    decision: 'Full live bidirectional Linear ↔ Hermes Kanban sync is not satisfied by a recurring lifecycle bridge alone. It requires a recurring DAG/GraphSync companion loop ordered with lifecycle ticks: mapped Linear/Kanban graph capture, fresh read_only_diff/status receipts, gated dependency-edge apply or proposal behavior in both authority directions, dependency-readiness output before gateway/worker dispatch reliance, and stop/rollback behavior for stale, cyclic, conflicting, incomplete, or over-cap graph state.',
    evidence: ['docs/linear-kanban-dag-sync-roadmap.md', 'a private operator GraphSync bridge plan (not shipped)', 'README.md#implementation-defined-policy-ledger', 'tests/index.test.ts'],
  },
  {
    topic: 'graph-sync-config-schema',
    status: 'selected',
    decision: 'The top-level graph_sync workflow config is accepted inertly by default and fail-closed for live/apply modes. It exposes typed read_only_diff settings, positive read caps, propose-only proposal policy, and disabled-by-default dispatch reliance, but it is not dispatch authority, not service/timer authorization, and not live mutation approval. Apply-like modes or non-propose-only proposal policies are rejected at config resolution time.',
    evidence: ['src/workflow.ts', 'tests/workflow.test.ts', 'tests/index.test.ts'],
  },
  {
    topic: 'linear-comment-privacy-interlock',
    status: 'selected',
    decision: 'Every outbound Linear lifecycle comment body is built from safe, non-local fields and passed through sanitizeLinearCommentBody. Start/complete templates deliberately never consume workspacePath, and failure/cancel reasons have absolute local paths and private dot-directories redacted before posting. Local paths remain inside Hermes Kanban task bodies and local receipts; they are not copied into Linear comments or control-plane external outputs.',
    evidence: ['src/linear-lifecycle-notifier.ts', 'tests/linear-lifecycle-notifier.test.ts', 'tests/kanban-graph-materializer.test.ts'],
  },
  {
    topic: 'backend-direction',
    status: 'selected',
    decision: 'Hermes Kanban is the canonical Symphony work engine. backend.kind: hermes_kanban is the preferred path for new workflows and live evidence; backend.kind: in_process_linear_codex and the symphony-codex-* CLIs remain legacy compatibility surfaces until a reviewed removal slice retires them. A successful direct Codex issue-run or focused fake Codex test proves only that the legacy runner seam works for the exact approved issue; it does not prove that the Kanban-first work engine can materialize a task graph, pass a no-worker canary, or safely dispatch through the Hermes gateway.',
    evidence: ['src/linear-kanban-canary.ts', 'src/service.ts', 'tests/linear-kanban-canary.test.ts', 'tests/service.test.ts', 'docs/kanban-first-migration.md'],
  },
] as const;
