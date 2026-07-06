import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  CaptureGraphSyncReadOnlySnapshotResult,
  GraphSyncSnapshotCaptureResult,
} from './graph-sync-live-snapshot.js';
import {
  createGraphSyncRecurringStateManager,
  type GraphSyncRecurringLockReceipt,
  type GraphSyncRecurringStateDocument,
  type GraphSyncRecurringStateManager,
  type GraphSyncRecurringStateReadReceipt,
} from './graph-sync-recurring-state.js';
import type { LinearKanbanBridgeTickReceipt } from './linear-kanban-bridge.js';

export type LinearKanbanGraphSyncRecurringTickStatus = 'PASS' | 'REVIEW' | 'BLOCK';

export type LinearKanbanGraphSyncDependencyReadinessState =
  | 'fresh_and_clean'
  | 'review_required'
  | 'blocked';

export type LinearKanbanGraphSyncDispatchRelianceDecision =
  | 'allowed'
  | 'deferred'
  | 'blocked';

export interface RunRecurringLinearKanbanGraphSyncTickInput {
  readonly workflowId: string;
  readonly runId: string;
  readonly runLifecycleTick: () => Promise<LinearKanbanBridgeTickReceipt>;
  readonly captureGraphSyncSnapshot: () => Promise<CaptureGraphSyncReadOnlySnapshotResult>;
  readonly now?: Date;
  readonly stateManager?: GraphSyncRecurringStateManager;
}

export interface LinearKanbanGraphSyncDependencyReadiness {
  readonly state: LinearKanbanGraphSyncDependencyReadinessState;
  readonly dispatch_reliance_decision: LinearKanbanGraphSyncDispatchRelianceDecision;
  readonly dispatch_reliance_allowed: boolean;
  readonly graph_sync_receipt_run_id: string;
  readonly reasons: readonly string[];
  readonly freshness_ttl_ms: number;
  readonly receipt_fresh: boolean;
  readonly generation: number;
  readonly prior_receipt_sha256: string | null;
  readonly stale_reason: string | null;
}

export interface LinearKanbanGraphSyncRecurringTickReceipt {
  readonly ok: true;
  readonly effect: 'linear_kanban_graph_sync_recurring_tick';
  readonly status: LinearKanbanGraphSyncRecurringTickStatus;
  readonly workflow_id: string;
  readonly run_id: string;
  readonly generated_at: string;
  readonly lifecycle: LinearKanbanBridgeTickReceipt;
  readonly graph_sync: CaptureGraphSyncReadOnlySnapshotResult;
  readonly dependency_readiness: LinearKanbanGraphSyncDependencyReadiness;
  readonly non_actions: readonly string[];
}

export interface LinearKanbanGraphSyncDispatchRelianceProbeReceipt {
  readonly ok: true;
  readonly effect: 'linear_kanban_graph_sync_dispatch_reliance_probe';
  readonly dispatch_reliance_attempted: boolean;
  readonly notes: readonly string[];
}

export type LinearKanbanGraphSyncDispatchRelianceProbe = (
  receipt: LinearKanbanGraphSyncRecurringTickReceipt,
) => Promise<LinearKanbanGraphSyncDispatchRelianceProbeReceipt>;

export interface RunRecurringLinearKanbanGraphSyncCanaryInput extends RunRecurringLinearKanbanGraphSyncTickInput {
  readonly artifactRoot: string;
  readonly dispatchRelianceProbe?: LinearKanbanGraphSyncDispatchRelianceProbe | undefined;
  readonly stateManager?: GraphSyncRecurringStateManager;
  readonly freshnessTtlMs?: number;
}

export interface LinearKanbanGraphSyncRecurringCanaryArtifacts {
  readonly tick_receipt_path: string;
  readonly tick_receipt_sha256: string;
  readonly status_path: string;
  readonly status_sha256: string;
  readonly summary_path: string;
  readonly summary_sha256: string;
  readonly state_path: string | null;
  readonly state_backup_path: string | null;
}

export interface LinearKanbanGraphSyncRecurringCanaryReceipt {
  readonly ok: true;
  readonly effect: 'linear_kanban_graph_sync_recurring_canary';
  readonly status: LinearKanbanGraphSyncRecurringTickStatus;
  readonly workflow_id: string;
  readonly run_id: string;
  readonly generated_at: string;
  readonly artifact_root: string;
  readonly tick: LinearKanbanGraphSyncRecurringTickReceipt;
  readonly artifacts: LinearKanbanGraphSyncRecurringCanaryArtifacts;
  readonly dispatch_reliance_decision: LinearKanbanGraphSyncDispatchRelianceDecision;
  readonly dispatch_reliance_suppressed: boolean;
  readonly dispatch_probe: LinearKanbanGraphSyncDispatchRelianceProbeReceipt | null;
  readonly non_actions: readonly string[];
  readonly state_read: {
    readonly prior_state: GraphSyncRecurringStateDocument | null;
    readonly state_path: string;
    readonly corrupt_backup_path: string | null;
    readonly receipt_fresh: boolean;
    readonly freshness_ttl_ms: number;
    readonly generation: number;
    readonly stale_reason: string | null;
  } | null;
  readonly state_write: {
    readonly previous_generation: number;
    readonly next_generation: number;
    readonly receipt_sha256: string;
    readonly state_path: string;
  } | null;
  readonly lock_receipt: {
    readonly acquired: boolean;
    readonly status: 'held' | 'available' | 'stale' | 'corrupt';
    readonly holder: string | null;
    readonly holder_pid: number | null;
    readonly acquired_at: string | null;
    readonly expires_at: string | null;
    readonly lease_ttl_ms: number;
    readonly stale_reason: string | null;
  } | null;
  readonly lock_fail_closed_receipt: {
    readonly ok: false;
    readonly effect: 'linear_kanban_graph_sync_recurring_canary_lock_failed_closed';
    readonly run_id: string;
    readonly workflow_id: string;
    readonly generated_at: string;
    readonly lock: {
      readonly status: 'held' | 'stale' | 'corrupt';
      readonly holder: string | null;
      readonly holder_pid: number | null;
      readonly expires_at: string | null;
      readonly lease_ttl_ms: number;
      readonly stale_reason: string | null;
    };
    readonly non_actions: readonly string[];
  } | null;
}

interface LinearKanbanGraphSyncRecurringCanaryStatusArtifact {
  readonly ok: true;
  readonly effect: 'linear_kanban_graph_sync_recurring_canary_status';
  readonly status: LinearKanbanGraphSyncRecurringTickStatus;
  readonly workflow_id: string;
  readonly run_id: string;
  readonly generated_at: string;
  readonly dispatch_reliance_decision: LinearKanbanGraphSyncDispatchRelianceDecision;
  readonly dispatch_reliance_suppressed: boolean;
  readonly dependency_readiness_state: LinearKanbanGraphSyncDependencyReadinessState;
  readonly reasons: readonly string[];
  readonly tick_receipt_path: string;
  readonly non_actions: readonly string[];
}

const RECURRING_TICK_NON_ACTIONS = [
  'did_not_edit_restart_or_disable_services_or_timers',
  'did_not_dispatch_workers_or_gateway',
  'did_not_push_publish_deploy_or_open_pr',
] as const;

export async function runRecurringLinearKanbanGraphSyncTick(
  input: RunRecurringLinearKanbanGraphSyncTickInput,
): Promise<LinearKanbanGraphSyncRecurringTickReceipt> {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const lifecycle = await input.runLifecycleTick();
  const graphSync = await input.captureGraphSyncSnapshot();
  const priorState = input.stateManager === undefined ? null : await input.stateManager.readState(input.runId);
  const dependencyReadiness = classifyDependencyReadiness(lifecycle, graphSync, priorState);
  return {
    ok: true,
    effect: 'linear_kanban_graph_sync_recurring_tick',
    status: statusForDependencyReadiness(dependencyReadiness),
    workflow_id: input.workflowId,
    run_id: input.runId,
    generated_at: generatedAt,
    lifecycle,
    graph_sync: graphSync,
    dependency_readiness: dependencyReadiness,
    non_actions: RECURRING_TICK_NON_ACTIONS,
  };
}

export async function runRecurringLinearKanbanGraphSyncCanary(
  input: RunRecurringLinearKanbanGraphSyncCanaryInput,
): Promise<LinearKanbanGraphSyncRecurringCanaryReceipt> {
  const stateManager = input.stateManager ?? createGraphSyncRecurringStateManager({
    artifactRoot: input.artifactRoot,
    workflowId: input.workflowId,
    freshnessTtlMs: input.freshnessTtlMs,
  });
  const lock = await stateManager.acquireLock(input.runId);
  const generatedAt = (input.now ?? new Date()).toISOString();

  if (!lock.acquired) {
    return {
      ok: true,
      effect: 'linear_kanban_graph_sync_recurring_canary',
      status: 'BLOCK',
      workflow_id: input.workflowId,
      run_id: input.runId,
      generated_at: generatedAt,
      artifact_root: input.artifactRoot,
      tick: buildFailClosedTick(input, generatedAt),
      artifacts: {
        tick_receipt_path: '',
        tick_receipt_sha256: '',
        status_path: '',
        status_sha256: '',
        summary_path: '',
        summary_sha256: '',
        state_path: stateManager.config.statePath,
        state_backup_path: null,
      },
      dispatch_reliance_decision: 'blocked',
      dispatch_reliance_suppressed: true,
      dispatch_probe: null,
      non_actions: RECURRING_TICK_NON_ACTIONS,
      state_read: null,
      state_write: null,
      lock_receipt: lockToCanaryLockReceipt(lock),
      lock_fail_closed_receipt: {
        ok: false,
        effect: 'linear_kanban_graph_sync_recurring_canary_lock_failed_closed',
        run_id: input.runId,
        workflow_id: input.workflowId,
        generated_at: generatedAt,
        lock: {
          status: lock.lock.status as 'held' | 'stale' | 'corrupt',
          holder: lock.lock.holder,
          holder_pid: lock.lock.holder_pid,
          expires_at: lock.lock.expires_at,
          lease_ttl_ms: lock.lock.lease_ttl_ms,
          stale_reason: lock.lock.stale_reason,
        },
        non_actions: RECURRING_TICK_NON_ACTIONS,
      },
    };
  }

  const priorStateRead = await stateManager.readState(input.runId);
  const tick = await runRecurringLinearKanbanGraphSyncTick({ ...input, stateManager });
  const dispatchRelianceSuppressed = !tick.dependency_readiness.dispatch_reliance_allowed;
  const dispatchProbe = dispatchRelianceSuppressed || input.dispatchRelianceProbe === undefined
    ? null
    : await input.dispatchRelianceProbe(tick);
  const runDirectory = join(input.artifactRoot, safeRunDirectoryName(input.runId));
  const tickReceiptPath = join(runDirectory, 'recurring-tick-receipt.json');
  const statusPath = join(runDirectory, 'status.json');
  const summaryPath = join(runDirectory, 'summary.md');
  const statusArtifact = buildCanaryStatusArtifact(tick, dispatchRelianceSuppressed, tickReceiptPath);
  const tickPayload = jsonPayload(tick);
  const statusPayload = jsonPayload(statusArtifact);
  const summaryPayload = renderCanarySummaryMarkdown(tick, statusArtifact);

  await mkdir(runDirectory, { recursive: true });
  await writeArtifactAtomic(tickReceiptPath, tickPayload);
  await writeArtifactAtomic(statusPath, statusPayload);
  await writeArtifactAtomic(summaryPath, summaryPayload);

  const writeReceipt = await stateManager.writeState({
    runId: input.runId,
    status: tick.status,
    receiptSha256: sha256Hex(tickPayload),
    completedAt: input.now ?? new Date(),
  });

  await stateManager.releaseLock(input.runId);

  return {
    ok: true,
    effect: 'linear_kanban_graph_sync_recurring_canary',
    status: tick.status,
    workflow_id: tick.workflow_id,
    run_id: tick.run_id,
    generated_at: tick.generated_at,
    artifact_root: input.artifactRoot,
    tick,
    artifacts: {
      tick_receipt_path: tickReceiptPath,
      tick_receipt_sha256: sha256Hex(tickPayload),
      status_path: statusPath,
      status_sha256: sha256Hex(statusPayload),
      summary_path: summaryPath,
      summary_sha256: sha256Hex(summaryPayload),
      state_path: stateManager.config.statePath,
      state_backup_path: priorStateRead.corrupt_backup_path,
    },
    dispatch_reliance_decision: tick.dependency_readiness.dispatch_reliance_decision,
    dispatch_reliance_suppressed: dispatchRelianceSuppressed,
    dispatch_probe: dispatchProbe,
    non_actions: tick.non_actions,
    state_read: {
      prior_state: priorStateRead.state,
      state_path: priorStateRead.state_path,
      corrupt_backup_path: priorStateRead.corrupt_backup_path,
      receipt_fresh: priorStateRead.receipt_fresh,
      freshness_ttl_ms: priorStateRead.freshness_ttl_ms,
      generation: priorStateRead.generation,
      stale_reason: priorStateRead.stale_reason,
    },
    state_write: {
      previous_generation: writeReceipt.previous_generation,
      next_generation: writeReceipt.next_generation,
      receipt_sha256: writeReceipt.receipt_sha256,
      state_path: writeReceipt.state_path,
    },
    lock_receipt: lockToCanaryLockReceipt(lock),
    lock_fail_closed_receipt: null,
  };
}

function buildFailClosedTick(
  input: RunRecurringLinearKanbanGraphSyncCanaryInput,
  generatedAt: string,
): LinearKanbanGraphSyncRecurringTickReceipt {
  return {
    ok: true,
    effect: 'linear_kanban_graph_sync_recurring_tick',
    status: 'BLOCK',
    workflow_id: input.workflowId,
    run_id: input.runId,
    generated_at: generatedAt,
    lifecycle: {
      ok: true,
      effect: 'linear_kanban_bridge_tick',
      workflow_id: input.workflowId,
      board: 'unknown',
      artifact_root: input.artifactRoot,
      dispatch_policy: 'no_worker',
      candidates: 0,
      materialized: [],
      skipped: [],
      completed: [],
      provenance_warnings: [{ kind: 'degraded' as const, issue_id: 'none', issue_identifier: 'none', message: 'lock not acquired; lifecycle tick skipped' }],
    },
    graph_sync: {
      ok: false,
      effect: 'graph_sync_read_only_snapshot_capture',
      status: 'BLOCK',
      workflow_id: input.workflowId,
      run_id: input.runId,
      generated_at: generatedAt,
      completed_at: generatedAt,
      mode: 'read_only_snapshot',
      suppressed_writes: true,
      error: 'lock not acquired; GraphSync snapshot skipped',
      non_actions: ['did_not_create_update_delete_linear_relations', 'did_not_create_update_delete_kanban_links'],
    },
    dependency_readiness: {
      state: 'blocked',
      dispatch_reliance_decision: 'blocked',
      dispatch_reliance_allowed: false,
      graph_sync_receipt_run_id: input.runId,
      reasons: ['recurring_tick_lock_failed_closed'],
      freshness_ttl_ms: input.freshnessTtlMs ?? 300000,
      receipt_fresh: false,
      generation: 0,
      prior_receipt_sha256: null,
      stale_reason: 'lock not acquired',
    },
    non_actions: RECURRING_TICK_NON_ACTIONS,
  };
}

function lockToCanaryLockReceipt(lock: GraphSyncRecurringLockReceipt): LinearKanbanGraphSyncRecurringCanaryReceipt['lock_receipt'] {
  return {
    acquired: lock.acquired,
    status: lock.lock.status,
    holder: lock.lock.holder,
    holder_pid: lock.lock.holder_pid,
    acquired_at: lock.lock.acquired_at,
    expires_at: lock.lock.expires_at,
    lease_ttl_ms: lock.lock.lease_ttl_ms,
    stale_reason: lock.lock.stale_reason,
  };
}

function buildCanaryStatusArtifact(
  tick: LinearKanbanGraphSyncRecurringTickReceipt,
  dispatchRelianceSuppressed: boolean,
  tickReceiptPath: string,
): LinearKanbanGraphSyncRecurringCanaryStatusArtifact {
  return {
    ok: true,
    effect: 'linear_kanban_graph_sync_recurring_canary_status',
    status: tick.status,
    workflow_id: tick.workflow_id,
    run_id: tick.run_id,
    generated_at: tick.generated_at,
    dispatch_reliance_decision: tick.dependency_readiness.dispatch_reliance_decision,
    dispatch_reliance_suppressed: dispatchRelianceSuppressed,
    dependency_readiness_state: tick.dependency_readiness.state,
    reasons: tick.dependency_readiness.reasons,
    tick_receipt_path: tickReceiptPath,
    non_actions: tick.non_actions,
  };
}

function renderCanarySummaryMarkdown(
  tick: LinearKanbanGraphSyncRecurringTickReceipt,
  status: LinearKanbanGraphSyncRecurringCanaryStatusArtifact,
): string {
  const lines: string[] = [
    '# Recurring lifecycle + GraphSync canary summary',
    '',
    `Operator status: \`${tick.status}\``,
    `Dispatch reliance decision: \`${tick.dependency_readiness.dispatch_reliance_decision}\``,
    `Dispatch reliance suppressed: \`${String(status.dispatch_reliance_suppressed)}\``,
    '',
    'No worker/gateway dispatch was performed.',
    '',
    '## Artifact provenance',
    '',
    `- Workflow: \`${tick.workflow_id}\``,
    `- Run: \`${tick.run_id}\``,
    `- Tick receipt: \`${status.tick_receipt_path}\``,
    '',
    '## Dependency readiness',
    '',
    `- State: \`${tick.dependency_readiness.state}\``,
    `- GraphSync receipt run: \`${tick.dependency_readiness.graph_sync_receipt_run_id}\``,
    `- Freshness TTL (ms): \`${String(tick.dependency_readiness.freshness_ttl_ms)}\``,
    `- Receipt fresh: \`${String(tick.dependency_readiness.receipt_fresh)}\``,
    `- Generation: \`${String(tick.dependency_readiness.generation)}\``,
    `- Prior receipt SHA256: \`${tick.dependency_readiness.prior_receipt_sha256 ?? 'none'}\``,
    `- Stale reason: \`${tick.dependency_readiness.stale_reason ?? 'none'}\``,
    '',
  ];
  if (tick.dependency_readiness.reasons.length > 0) {
    lines.push('### Reasons');
    lines.push('');
    for (const reason of tick.dependency_readiness.reasons) {
      lines.push(`- ${reason}`);
    }
    lines.push('');
  }
  lines.push('## Explicit non-actions');
  lines.push('');
  for (const nonAction of tick.non_actions) {
    lines.push(`- ${nonAction}`);
  }
  lines.push('');
  return lines.join('\n');
}

function classifyDependencyReadiness(
  lifecycle: LinearKanbanBridgeTickReceipt,
  graphSync: CaptureGraphSyncReadOnlySnapshotResult,
  priorState: GraphSyncRecurringStateReadReceipt | null,
): LinearKanbanGraphSyncDependencyReadiness {
  const freshnessTtlMs = priorState?.freshness_ttl_ms ?? 300000;
  const generation = priorState?.generation ?? 0;
  const priorReceiptSha256 = priorState?.state?.last_receipt_sha256 ?? null;
  const staleReason = priorState?.stale_reason ?? 'no prior state';
  const receiptFresh = priorState?.receipt_fresh ?? false;

  if (!graphSync.ok) {
    return {
      state: 'blocked',
      dispatch_reliance_decision: 'blocked',
      dispatch_reliance_allowed: false,
      graph_sync_receipt_run_id: graphSync.run_id,
      reasons: ['graph_sync_capture_blocked'],
      freshness_ttl_ms: freshnessTtlMs,
      receipt_fresh: false,
      generation,
      prior_receipt_sha256: priorReceiptSha256,
      stale_reason: 'graph_sync_capture_blocked',
    };
  }

  const reasons = [...graphSyncReadinessReasons(lifecycle, graphSync)];
  const hasPriorCompletion = priorState?.state?.last_completed_at !== null && priorState?.state?.last_completed_at !== undefined;
  if (hasPriorCompletion && !receiptFresh && reasons.length === 0) {
    reasons.push('prior_receipt_stale');
  }

  if (reasons.length === 0) {
    return {
      state: 'fresh_and_clean',
      dispatch_reliance_decision: 'allowed',
      dispatch_reliance_allowed: true,
      graph_sync_receipt_run_id: graphSync.run_id,
      reasons,
      freshness_ttl_ms: freshnessTtlMs,
      receipt_fresh: receiptFresh,
      generation,
      prior_receipt_sha256: priorReceiptSha256,
      stale_reason: staleReason,
    };
  }

  return {
    state: dependencyReadinessState(graphSync, reasons),
    dispatch_reliance_decision: dispatchRelianceDecision(graphSync, reasons),
    dispatch_reliance_allowed: false,
    graph_sync_receipt_run_id: graphSync.run_id,
    reasons,
    freshness_ttl_ms: freshnessTtlMs,
    receipt_fresh: receiptFresh,
    generation,
    prior_receipt_sha256: priorReceiptSha256,
    stale_reason: staleReason,
  };
}

function graphSyncReadinessReasons(
  lifecycle: LinearKanbanBridgeTickReceipt,
  graphSync: GraphSyncSnapshotCaptureResult,
): readonly string[] {
  const reasons: string[] = [];
  if (!graphSyncScopeMatchesLifecycleBoard(lifecycle, graphSync)) {
    reasons.push('graph_sync_scope_board_mismatch');
  }
  if (graphSync.status === 'REVIEW') {
    reasons.push('graph_sync_review_required');
  }
  if (graphSync.status === 'BLOCK') {
    reasons.push('graph_sync_blocked');
  }
  if (graphSync.receipt.summary.cycles_detected > 0) {
    reasons.push('graph_sync_cycles_detected');
  }
  if (graphSync.receipt.summary.missing_kanban_edges > 0) {
    reasons.push('graph_sync_missing_kanban_edges');
  }
  if (graphSync.receipt.summary.missing_linear_relations > 0) {
    reasons.push('graph_sync_missing_linear_relations');
  }
  return reasons;
}

function dependencyReadinessState(
  graphSync: GraphSyncSnapshotCaptureResult,
  reasons: readonly string[],
): LinearKanbanGraphSyncDependencyReadinessState {
  if (graphSync.status === 'BLOCK' || reasons.includes('graph_sync_scope_board_mismatch')) {
    return 'blocked';
  }
  return 'review_required';
}

function dispatchRelianceDecision(
  graphSync: GraphSyncSnapshotCaptureResult,
  reasons: readonly string[],
): LinearKanbanGraphSyncDispatchRelianceDecision {
  return dependencyReadinessState(graphSync, reasons) === 'blocked' ? 'blocked' : 'deferred';
}

function graphSyncScopeMatchesLifecycleBoard(
  lifecycle: LinearKanbanBridgeTickReceipt,
  graphSync: GraphSyncSnapshotCaptureResult,
): boolean {
  const scope = graphSync.snapshot.scope as { readonly kanbanBoard?: unknown };
  const scopeBoard = scope.kanbanBoard;
  return typeof scopeBoard === 'string' && scopeBoard === lifecycle.board;
}

function statusForDependencyReadiness(
  readiness: LinearKanbanGraphSyncDependencyReadiness,
): LinearKanbanGraphSyncRecurringTickStatus {
  if (readiness.dispatch_reliance_allowed) {
    return 'PASS';
  }
  if (readiness.state === 'review_required') {
    return 'REVIEW';
  }
  return 'BLOCK';
}

function safeRunDirectoryName(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error('recurring GraphSync canary runId must contain only letters, numbers, dot, underscore, or hyphen');
  }
  return runId;
}

function jsonPayload(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function writeArtifactAtomic(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, filePath);
}
