import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Issue } from '../src/domain.js';
import {
  createGraphSyncRecurringStateManager,
  type GraphSyncRecurringClock,
} from '../src/graph-sync-recurring-state.js';
import {
  captureGraphSyncReadOnlySnapshot,
  type GraphSyncKanbanGraphReader,
  type GraphSyncLinearGraphReader,
  type GraphSyncMappingReader,
} from '../src/graph-sync-live-snapshot.js';
import type { KanbanTaskDetail, KanbanTaskLink } from '../src/kanban-types.js';
import type { LinearKanbanBridgeTickReceipt } from '../src/linear-kanban-bridge.js';
import {
  runRecurringLinearKanbanGraphSyncCanary,
  runRecurringLinearKanbanGraphSyncTick,
} from '../src/linear-kanban-graph-sync-tick.js';

describe('recurring Linear ↔ Kanban GraphSync tick contract', () => {
  it('runs lifecycle before GraphSync and allows dispatch reliance only after a same-scope clean DAG receipt', async () => {
    const calls: string[] = [];
    const lifecycleReceipt: LinearKanbanBridgeTickReceipt = {
      ok: true,
      effect: 'linear_kanban_bridge_tick',
      workflow_id: 'workflow-1',
      board: 'linear',
      artifact_root: '/tmp/symphony-recurring-graph-sync',
      dispatch_policy: 'dispatchable',
      candidates: 2,
      materialized: [
        {
          issue_id: 'lin_A',
          issue_identifier: 'HER-201',
          task_id: 't_A',
          created: false,
          dispatch_policy: 'dispatchable',
          requested_assignee: 'default',
          sticky_block_applied: false,
        },
        {
          issue_id: 'lin_B',
          issue_identifier: 'HER-202',
          task_id: 't_B',
          created: false,
          dispatch_policy: 'dispatchable',
          requested_assignee: 'default',
          sticky_block_applied: false,
        },
      ],
      skipped: [],
      completed: [],
      provenance_warnings: [],
    };
    const issueA = issue({
      id: 'lin_A',
      identifier: 'HER-201',
      state: 'Done',
      linear_relations: [
        {
          id: 'rel_blocks_A_B',
          type: 'blocks',
          observed_from: 'relations' as const,
          issue: { id: 'lin_A', identifier: 'HER-201', state: 'Done' },
          related_issue: { id: 'lin_B', identifier: 'HER-202', state: 'Todo' },
          created_at: new Date('2026-07-01T20:00:00.000Z'),
          updated_at: new Date('2026-07-01T20:01:00.000Z'),
          archived_at: null,
        },
      ],
    });
    const issueB = issue({ id: 'lin_B', identifier: 'HER-202', state: 'Todo' });
    const blockingLink: KanbanTaskLink = {
      parentTaskId: 't_A',
      childTaskId: 't_B',
      kind: 'blocks',
      blocking: true,
      requiredParentStatuses: ['done'],
      source: 'symphony-graph-sync',
      createdBy: 'symphony-ts',
      metadata: { linear_relation_id: 'rel_blocks_A_B' },
    };
    const taskA = task({ id: 't_A', status: 'done', childLinks: [blockingLink] });
    const taskB = task({ id: 't_B', status: 'todo', parentLinks: [blockingLink] });

    const receipt = await runRecurringLinearKanbanGraphSyncTick({
      workflowId: 'workflow-1',
      runId: 'recurring-tick-001',
      runLifecycleTick: () => {
        calls.push('lifecycle');
        return Promise.resolve(lifecycleReceipt);
      },
      captureGraphSyncSnapshot: () => {
        calls.push('graph-sync');
        return captureGraphSyncReadOnlySnapshot({
          workflowId: 'workflow-1',
          runId: 'graph-recurring-tick-001',
          scope: { tracker: 'linear', selector: 'all_approved_projects', kanbanBoard: 'linear' },
          linearReader: fakeLinearReader([issueA, issueB]),
          kanbanReader: fakeKanbanReader([taskA, taskB]),
          mappingReader: fakeMappingReader([
            { linearIssueId: 'lin_A', kanbanTaskId: 't_A' },
            { linearIssueId: 'lin_B', kanbanTaskId: 't_B' },
          ]),
          now: new Date('2026-07-01T20:05:00.000Z'),
        });
      },
      now: new Date('2026-07-01T20:05:05.000Z'),
    });

    expect(calls).toEqual(['lifecycle', 'graph-sync']);
    expect(receipt).toMatchObject({
      ok: true,
      effect: 'linear_kanban_graph_sync_recurring_tick',
      status: 'PASS',
      workflow_id: 'workflow-1',
      run_id: 'recurring-tick-001',
      lifecycle: {
        effect: 'linear_kanban_bridge_tick',
        board: 'linear',
        candidates: 2,
      },
      graph_sync: {
        effect: 'graph_sync_read_only_snapshot_capture',
        status: 'PASS',
        run_id: 'graph-recurring-tick-001',
      },
      dependency_readiness: {
        state: 'fresh_and_clean',
        dispatch_reliance_allowed: true,
        graph_sync_receipt_run_id: 'graph-recurring-tick-001',
        reasons: [],
      },
    });
    expect(receipt.graph_sync.ok).toBe(true);
    if (!receipt.graph_sync.ok) {
      throw new Error('expected GraphSync success');
    }
    expect(receipt.graph_sync.receipt.summary).toMatchObject({
      matched_edges: 1,
      missing_kanban_edges: 0,
      missing_linear_relations: 0,
      cycles_detected: 0,
    });
    expect(receipt.non_actions).toEqual([
      'did_not_edit_restart_or_disable_services_or_timers',
      'did_not_dispatch_workers_or_gateway',
      'did_not_push_publish_deploy_or_open_pr',
    ]);
  });

  it('blocks dispatch reliance when the clean GraphSync receipt is for a different Kanban board scope', async () => {
    const lifecycleReceipt: LinearKanbanBridgeTickReceipt = {
      ok: true,
      effect: 'linear_kanban_bridge_tick',
      workflow_id: 'workflow-1',
      board: 'linear',
      artifact_root: '/tmp/symphony-recurring-graph-sync',
      dispatch_policy: 'dispatchable',
      candidates: 0,
      materialized: [],
      skipped: [],
      completed: [],
      provenance_warnings: [],
    };

    const receipt = await runRecurringLinearKanbanGraphSyncTick({
      workflowId: 'workflow-1',
      runId: 'recurring-tick-scope-mismatch',
      runLifecycleTick: () => Promise.resolve(lifecycleReceipt),
      captureGraphSyncSnapshot: () => captureCleanGraphSyncSnapshot('testflight'),
      now: new Date('2026-07-01T20:06:00.000Z'),
    });

    expect(receipt.status).toBe('BLOCK');
    expect(receipt.dependency_readiness).toEqual({
      state: 'blocked',
      dispatch_reliance_decision: 'blocked',
      dispatch_reliance_allowed: false,
      graph_sync_receipt_run_id: 'graph-recurring-clean-testflight',
      reasons: ['graph_sync_scope_board_mismatch'],
      freshness_ttl_ms: 300000,
      receipt_fresh: false,
      generation: 0,
      prior_receipt_sha256: null,
      stale_reason: 'no prior state',
    });
  });

  it('defers dispatch reliance when same-scope GraphSync proposes a missing executable Kanban edge', async () => {
    const lifecycleReceipt: LinearKanbanBridgeTickReceipt = {
      ok: true,
      effect: 'linear_kanban_bridge_tick',
      workflow_id: 'workflow-1',
      board: 'linear',
      artifact_root: '/tmp/symphony-recurring-graph-sync',
      dispatch_policy: 'dispatchable',
      candidates: 2,
      materialized: [],
      skipped: [],
      completed: [],
      provenance_warnings: [],
    };

    const receipt = await runRecurringLinearKanbanGraphSyncTick({
      workflowId: 'workflow-1',
      runId: 'recurring-tick-missing-kanban-edge',
      runLifecycleTick: () => Promise.resolve(lifecycleReceipt),
      captureGraphSyncSnapshot: () => captureMissingKanbanEdgeSnapshot(),
      now: new Date('2026-07-01T20:07:00.000Z'),
    });

    expect(receipt.status).toBe('REVIEW');
    expect(receipt.dependency_readiness).toEqual({
      state: 'review_required',
      dispatch_reliance_decision: 'deferred',
      dispatch_reliance_allowed: false,
      graph_sync_receipt_run_id: 'graph-recurring-missing-kanban-edge',
      reasons: ['graph_sync_review_required', 'graph_sync_missing_kanban_edges'],
      freshness_ttl_ms: 300000,
      receipt_fresh: false,
      generation: 0,
      prior_receipt_sha256: null,
      stale_reason: 'no prior state',
    });
    expect(receipt.graph_sync.ok).toBe(true);
    if (!receipt.graph_sync.ok) {
      throw new Error('expected GraphSync success');
    }
    expect(receipt.graph_sync.receipt.proposed_operations).toEqual([
      expect.objectContaining({ operation: 'create_kanban_edge', suppressed: true }),
    ]);
  });

  it('persists a canary receipt and suppresses dispatch reliance when dependency readiness is deferred', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'symphony-recurring-graph-sync-canary-'));
    let dispatchProbeCalls = 0;
    const lifecycleReceipt: LinearKanbanBridgeTickReceipt = {
      ok: true,
      effect: 'linear_kanban_bridge_tick',
      workflow_id: 'workflow-1',
      board: 'linear',
      artifact_root: artifactRoot,
      dispatch_policy: 'dispatchable',
      candidates: 2,
      materialized: [],
      skipped: [],
      completed: [],
      provenance_warnings: [],
    };

    const receipt = await runRecurringLinearKanbanGraphSyncCanary({
      workflowId: 'workflow-1',
      runId: 'recurring-canary-deferred',
      artifactRoot,
      runLifecycleTick: () => Promise.resolve(lifecycleReceipt),
      captureGraphSyncSnapshot: () => captureMissingKanbanEdgeSnapshot(),
      dispatchRelianceProbe: () => {
        dispatchProbeCalls += 1;
        return Promise.resolve({
          ok: true,
          effect: 'linear_kanban_graph_sync_dispatch_reliance_probe',
          dispatch_reliance_attempted: true,
          notes: ['would inspect gateway dispatch readiness if dependency readiness allowed it'],
        });
      },
      now: new Date('2026-07-01T20:08:00.000Z'),
    });

    expect(dispatchProbeCalls).toBe(0);
    expect(receipt).toMatchObject({
      ok: true,
      effect: 'linear_kanban_graph_sync_recurring_canary',
      status: 'REVIEW',
      workflow_id: 'workflow-1',
      run_id: 'recurring-canary-deferred',
      dispatch_reliance_decision: 'deferred',
      dispatch_reliance_suppressed: true,
      dispatch_probe: null,
    });
    expect(receipt.artifacts.tick_receipt_path).toBe(join(artifactRoot, 'recurring-canary-deferred', 'recurring-tick-receipt.json'));
    expect(receipt.artifacts.status_path).toBe(join(artifactRoot, 'recurring-canary-deferred', 'status.json'));
    expect(receipt.artifacts.summary_path).toBe(join(artifactRoot, 'recurring-canary-deferred', 'summary.md'));
    expect(receipt.artifacts.tick_receipt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.artifacts.status_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.artifacts.summary_sha256).toMatch(/^[a-f0-9]{64}$/);

    const persistedTick = JSON.parse(await readFile(receipt.artifacts.tick_receipt_path, 'utf8')) as {
      readonly dependency_readiness: { readonly dispatch_reliance_decision: string };
    };
    expect(persistedTick.dependency_readiness.dispatch_reliance_decision).toBe('deferred');

    const persistedStatus = JSON.parse(await readFile(receipt.artifacts.status_path, 'utf8')) as {
      readonly status: string;
      readonly dispatch_reliance_decision: string;
      readonly dispatch_reliance_suppressed: boolean;
    };
    expect(persistedStatus).toMatchObject({
      status: 'REVIEW',
      dispatch_reliance_decision: 'deferred',
      dispatch_reliance_suppressed: true,
    });

    const summary = await readFile(receipt.artifacts.summary_path, 'utf8');
    expect(summary).toContain('Operator status: `REVIEW`');
    expect(summary).toContain('Dispatch reliance decision: `deferred`');
    expect(summary).toContain('No worker/gateway dispatch was performed.');
  });

  it('persists a canary receipt and suppresses dispatch reliance when dependency readiness is blocked', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'symphony-recurring-graph-sync-canary-blocked-'));
    let dispatchProbeCalls = 0;
    const lifecycleReceipt = cleanLifecycleReceipt(artifactRoot);

    const receipt = await runRecurringLinearKanbanGraphSyncCanary({
      workflowId: 'workflow-1',
      runId: 'recurring-canary-blocked',
      artifactRoot,
      runLifecycleTick: () => Promise.resolve(lifecycleReceipt),
      captureGraphSyncSnapshot: () => captureCleanGraphSyncSnapshot('testflight'),
      dispatchRelianceProbe: () => {
        dispatchProbeCalls += 1;
        return Promise.resolve({
          ok: true,
          effect: 'linear_kanban_graph_sync_dispatch_reliance_probe',
          dispatch_reliance_attempted: true,
          notes: ['would inspect gateway dispatch readiness if dependency readiness allowed it'],
        });
      },
      now: new Date('2026-07-01T20:09:00.000Z'),
    });

    expect(dispatchProbeCalls).toBe(0);
    expect(receipt.status).toBe('BLOCK');
    expect(receipt.dispatch_reliance_decision).toBe('blocked');
    expect(receipt.dispatch_reliance_suppressed).toBe(true);
    expect(receipt.dispatch_probe).toBeNull();

    const persistedStatus = JSON.parse(await readFile(receipt.artifacts.status_path, 'utf8')) as {
      readonly status: string;
      readonly dispatch_reliance_decision: string;
      readonly dispatch_reliance_suppressed: boolean;
      readonly reasons: readonly string[];
    };
    expect(persistedStatus).toMatchObject({
      status: 'BLOCK',
      dispatch_reliance_decision: 'blocked',
      dispatch_reliance_suppressed: true,
      reasons: ['graph_sync_scope_board_mismatch'],
    });
  });

  it('fails closed with a lock receipt when a second tick attempts to run while the lock is held', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'symphony-recurring-canary-lock-'));
    const lifecycleReceipt = cleanLifecycleReceipt(artifactRoot);
    const start = new Date('2026-07-01T20:10:00.000Z');
    const clock = fixedClock(start);
    const manager = createGraphSyncRecurringStateManager({
      artifactRoot,
      workflowId: 'workflow-lock',
      clock,
      freshnessTtlMs: 300000,
      leaseTtlMs: 300000,
    });

    // Pre-acquire a lock with a different run id and do not release it, so the canary must fail closed.
    const preHold = await manager.acquireLock('pre-held');
    expect(preHold.acquired).toBe(true);

    const second = await runRecurringLinearKanbanGraphSyncCanary({
      workflowId: 'workflow-lock',
      runId: 'lock-contender',
      artifactRoot,
      runLifecycleTick: () => Promise.resolve(lifecycleReceipt),
      captureGraphSyncSnapshot: () => captureCleanGraphSyncSnapshot('linear'),
      stateManager: manager,
      now: start,
    });

    expect(second.status).toBe('BLOCK');
    expect(second.ok).toBe(true);
    expect(second.lock_receipt?.acquired).toBe(false);
    expect(second.lock_receipt?.status).toBe('held');
    expect(second.lock_receipt?.holder).toBe(preHold.lock.holder);
    expect(second.lock_fail_closed_receipt).not.toBeNull();
    expect(second.lock_fail_closed_receipt?.ok).toBe(false);
    expect(second.lock_fail_closed_receipt?.effect).toBe('linear_kanban_graph_sync_recurring_canary_lock_failed_closed');
    expect(second.lock_fail_closed_receipt?.lock.status).toBe('held');
    expect(second.lock_fail_closed_receipt?.non_actions).toContain('did_not_dispatch_workers_or_gateway');
    expect(second.tick.dependency_readiness.dispatch_reliance_decision).toBe('blocked');
    expect(second.tick.dependency_readiness.stale_reason).toBe('lock not acquired');
    expect(second.tick.graph_sync.ok).toBe(false);
    if (!second.tick.graph_sync.ok) {
      expect(second.tick.graph_sync.error).toBe('lock not acquired; GraphSync snapshot skipped');
    }

    // The fail-closed path does not write a second receipt/status/summary.
    expect(second.artifacts.tick_receipt_path).toBe('');
    expect(second.artifacts.status_path).toBe('');
    expect(second.artifacts.summary_path).toBe('');
    expect(second.state_read).toBeNull();
    expect(second.state_write).toBeNull();
  });

  it('blocks dispatch reliance when the prior clean receipt is stale', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'symphony-recurring-canary-stale-'));
    const lifecycleReceipt = cleanLifecycleReceipt(artifactRoot);
    const start = new Date('2026-07-01T20:00:00.000Z');
    const clock = fixedClock(start);
    const manager = createGraphSyncRecurringStateManager({
      artifactRoot,
      workflowId: 'workflow-stale',
      clock,
      freshnessTtlMs: 300000,
      leaseTtlMs: 300000,
    });

    await manager.acquireLock('lock-1');
    await manager.writeState({
      runId: 'lock-1',
      status: 'PASS',
      receiptSha256: 'a'.repeat(64),
      completedAt: start,
    });
    await manager.releaseLock('lock-1');

    clock.advance(301000);

    const receipt = await runRecurringLinearKanbanGraphSyncCanary({
      workflowId: 'workflow-stale',
      runId: 'stale-tick',
      artifactRoot,
      runLifecycleTick: () => Promise.resolve(lifecycleReceipt),
      captureGraphSyncSnapshot: () => captureCleanGraphSyncSnapshot('linear'),
      stateManager: manager,
      now: new Date(start.getTime() + 301000),
    });

    expect(receipt.status).toBe('REVIEW');
    expect(receipt.tick.dependency_readiness.dispatch_reliance_decision).toBe('deferred');
    expect(receipt.tick.dependency_readiness.receipt_fresh).toBe(false);
    expect(receipt.tick.dependency_readiness.stale_reason).toContain('exceeds freshness_ttl_ms');
    expect(receipt.tick.dependency_readiness.reasons).toContain('prior_receipt_stale');
    expect(receipt.state_read?.receipt_fresh).toBe(false);
    expect(receipt.state_read?.stale_reason).toContain('exceeds freshness_ttl_ms');
    expect(receipt.state_write?.previous_generation).toBe(1);
    expect(receipt.state_write?.next_generation).toBe(2);
  });

  it('backs up and reports corrupt recurring state without overwriting it silently', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'symphony-recurring-canary-corrupt-'));
    const lifecycleReceipt = cleanLifecycleReceipt(artifactRoot);
    await writeFile(join(artifactRoot, 'graph-sync-recurring.state.json'), 'this is not json', 'utf8');

    const receipt = await runRecurringLinearKanbanGraphSyncCanary({
      workflowId: 'workflow-corrupt',
      runId: 'corrupt-tick',
      artifactRoot,
      runLifecycleTick: () => Promise.resolve(lifecycleReceipt),
      captureGraphSyncSnapshot: () => captureCleanGraphSyncSnapshot('linear'),
      now: new Date('2026-07-01T20:11:00.000Z'),
    });

    expect(receipt.status).toBe('PASS');
    expect(receipt.state_read).not.toBeNull();
    expect(receipt.state_read?.corrupt_backup_path).not.toBeNull();
    expect(await readFile(receipt.state_read?.corrupt_backup_path ?? '', 'utf8')).toBe('this is not json');
    expect(receipt.state_read?.receipt_fresh).toBe(false);
    expect(receipt.state_read?.stale_reason).toBe('no prior completion');
    expect(receipt.state_write?.previous_generation).toBe(0);
    expect(receipt.state_write?.next_generation).toBe(1);
    expect(receipt.artifacts.state_backup_path).toBe(receipt.state_read?.corrupt_backup_path);

    const stateOnDisk = await readFile(join(artifactRoot, 'graph-sync-recurring.state.json'), 'utf8');
    const parsedState = JSON.parse(stateOnDisk) as { readonly last_generation: number };
    expect(parsedState.last_generation).toBe(1);
  });

  it('reports non-empty prior receipt hash when a prior successful state exists and current tick is still fresh', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'symphony-recurring-canary-prior-hash-'));
    const lifecycleReceipt = cleanLifecycleReceipt(artifactRoot);
    const manager = createGraphSyncRecurringStateManager({
      artifactRoot,
      workflowId: 'workflow-hash',
      clock: fixedClock(new Date('2026-07-01T20:12:00.000Z')),
      freshnessTtlMs: 300000,
      leaseTtlMs: 300000,
    });
    const now = new Date('2026-07-01T20:12:00.000Z');

    await manager.acquireLock('prior-run');
    const firstSha256 = 'b'.repeat(64);
    await manager.writeState({
      runId: 'prior-run',
      status: 'PASS',
      receiptSha256: firstSha256,
      completedAt: now,
    });
    await manager.releaseLock('prior-run');

    const receipt = await runRecurringLinearKanbanGraphSyncCanary({
      workflowId: 'workflow-hash',
      runId: 'next-run',
      artifactRoot,
      runLifecycleTick: () => Promise.resolve(lifecycleReceipt),
      captureGraphSyncSnapshot: () => captureCleanGraphSyncSnapshot('linear'),
      stateManager: manager,
      now,
    });

    expect(receipt.status).toBe('PASS');
    expect(receipt.tick.dependency_readiness.prior_receipt_sha256).toBe(firstSha256);
    expect(receipt.tick.dependency_readiness.generation).toBe(1);
    expect(receipt.tick.dependency_readiness.receipt_fresh).toBe(true);
    expect(receipt.state_read?.prior_state?.last_receipt_sha256).toBe(firstSha256);
    expect(receipt.state_write?.previous_generation).toBe(1);
    expect(receipt.state_write?.next_generation).toBe(2);
  });
});

function cleanLifecycleReceipt(artifactRoot: string): LinearKanbanBridgeTickReceipt {
  return {
    ok: true,
    effect: 'linear_kanban_bridge_tick',
    workflow_id: 'workflow-1',
    board: 'linear',
    artifact_root: artifactRoot,
    dispatch_policy: 'dispatchable',
    candidates: 0,
    materialized: [],
    skipped: [],
    completed: [],
    provenance_warnings: [],
  };
}

function fixedClock(at: Date): GraphSyncRecurringClock & { advance(ms: number): void } {
  let current = new Date(at.getTime());
  return {
    now: () => new Date(current.getTime()),
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

function captureCleanGraphSyncSnapshot(kanbanBoard: string) {
  const issueA = issue({
    id: 'lin_A',
    identifier: 'HER-201',
    state: 'Done',
    linear_relations: [
      {
        id: 'rel_blocks_A_B',
        type: 'blocks',
        observed_from: 'relations' as const,
        issue: { id: 'lin_A', identifier: 'HER-201', state: 'Done' },
        related_issue: { id: 'lin_B', identifier: 'HER-202', state: 'Todo' },
        created_at: new Date('2026-07-01T20:00:00.000Z'),
        updated_at: new Date('2026-07-01T20:01:00.000Z'),
        archived_at: null,
      },
    ],
  });
  const issueB = issue({ id: 'lin_B', identifier: 'HER-202', state: 'Todo' });
  const blockingLink: KanbanTaskLink = {
    parentTaskId: 't_A',
    childTaskId: 't_B',
    kind: 'blocks',
    blocking: true,
    requiredParentStatuses: ['done'],
    source: 'symphony-graph-sync',
    createdBy: 'symphony-ts',
    metadata: { linear_relation_id: 'rel_blocks_A_B' },
  };
  const taskA = task({ id: 't_A', status: 'done', childLinks: [blockingLink] });
  const taskB = task({ id: 't_B', status: 'todo', parentLinks: [blockingLink] });

  return captureGraphSyncReadOnlySnapshot({
    workflowId: 'workflow-1',
    runId: `graph-recurring-clean-${kanbanBoard}`,
    scope: { tracker: 'linear', selector: 'all_approved_projects', kanbanBoard },
    linearReader: fakeLinearReader([issueA, issueB]),
    kanbanReader: fakeKanbanReader([taskA, taskB]),
    mappingReader: fakeMappingReader([
      { linearIssueId: 'lin_A', kanbanTaskId: 't_A' },
      { linearIssueId: 'lin_B', kanbanTaskId: 't_B' },
    ]),
    now: new Date('2026-07-01T20:05:00.000Z'),
  });
}

function captureMissingKanbanEdgeSnapshot() {
  const issueA = issue({
    id: 'lin_A',
    identifier: 'HER-201',
    state: 'Done',
    linear_relations: [
      {
        id: 'rel_blocks_A_B',
        type: 'blocks',
        observed_from: 'relations' as const,
        issue: { id: 'lin_A', identifier: 'HER-201', state: 'Done' },
        related_issue: { id: 'lin_B', identifier: 'HER-202', state: 'Todo' },
        created_at: new Date('2026-07-01T20:00:00.000Z'),
        updated_at: new Date('2026-07-01T20:01:00.000Z'),
        archived_at: null,
      },
    ],
  });
  const issueB = issue({ id: 'lin_B', identifier: 'HER-202', state: 'Todo' });
  const taskA = task({ id: 't_A', status: 'done' });
  const taskB = task({ id: 't_B', status: 'todo' });

  return captureGraphSyncReadOnlySnapshot({
    workflowId: 'workflow-1',
    runId: 'graph-recurring-missing-kanban-edge',
    scope: { tracker: 'linear', selector: 'all_approved_projects', kanbanBoard: 'linear' },
    linearReader: fakeLinearReader([issueA, issueB]),
    kanbanReader: fakeKanbanReader([taskA, taskB]),
    mappingReader: fakeMappingReader([
      { linearIssueId: 'lin_A', kanbanTaskId: 't_A' },
      { linearIssueId: 'lin_B', kanbanTaskId: 't_B' },
    ]),
    now: new Date('2026-07-01T20:06:00.000Z'),
  });
}

function issue(overrides: Pick<Issue, 'id' | 'identifier' | 'state'> & Partial<Issue>): Issue {
  return {
    title: `${overrides.identifier} title`,
    description: null,
    priority: null,
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function task(overrides: Pick<KanbanTaskDetail, 'id' | 'status'> & Partial<KanbanTaskDetail>): KanbanTaskDetail {
  return {
    title: overrides.id,
    assignee: null,
    body: null,
    parents: [],
    children: [],
    parentLinks: [],
    childLinks: [],
    comments: [],
    raw: {},
    ...overrides,
  };
}

function fakeLinearReader(issues: readonly Issue[]): GraphSyncLinearGraphReader {
  return {
    readIssuesWithRelations(): Promise<readonly Issue[]> {
      return Promise.resolve(issues);
    },
  };
}

function fakeKanbanReader(tasks: readonly KanbanTaskDetail[]): GraphSyncKanbanGraphReader {
  return {
    readTaskDetails(): Promise<readonly KanbanTaskDetail[]> {
      return Promise.resolve(tasks);
    },
  };
}

function fakeMappingReader(mappings: readonly { linearIssueId: string; kanbanTaskId: string }[]): GraphSyncMappingReader {
  return {
    readMappings(): Promise<readonly { linearIssueId: string; kanbanTaskId: string }[]> {
      return Promise.resolve(mappings);
    },
  };
}
