import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Issue } from '../src/domain.js';
import { JsonFileIssueRunLedger } from '../src/issue-run-ledger.js';
import { classifyKanbanLiveness, isBlockedByHumanOrExternalGate, isComputableClassification, recommendKanbanTaskAction, type KanbanLivenessClassification } from '../src/kanban-liveness.js';
import type { SymphonyKanbanSnapshot, SymphonyKanbanTaskSnapshot } from '../src/kanban-service.js';

const issue: Issue = {
  id: 'issue-1',
  identifier: 'HER-8',
  title: 'Try automatic Linear to Kanban bridge',
  description: 'Make a receipt and do not mutate the repo.',
  priority: 2,
  state: 'Todo',
  branch_name: 'janusz/her-8-bridge-test',
  url: 'https://linear.app/hermegeddon/issue/HER-8/try-automatic-linear-to-kanban-bridge',
  labels: ['symphony'],
  blocked_by: [],
  created_at: new Date('2026-06-24T12:00:00.000Z'),
  updated_at: new Date('2026-06-24T12:05:00.000Z'),
  team: { key: 'HER', name: 'Hermegeddon' },
  project: {
    id: 'project-1',
    name: 'Testflight',
    slug_id: '2a5d92446e9d',
    url: 'https://linear.app/hermegeddon/project/testflight',
  },
};

function task(overrides: Partial<SymphonyKanbanTaskSnapshot> & { readonly id: string; readonly title: string; readonly state: string }): SymphonyKanbanTaskSnapshot {
  return {
    status: overrides.state,
    assignee: null,
    source_identifier: null,
    provenance: { workflow_id: null, kanban_board: 'symphony-test', ledger_path: null },
    ...overrides,
  };
}

function availableSnapshot(tasks: readonly SymphonyKanbanTaskSnapshot[]): SymphonyKanbanSnapshot {
  return {
    backend: 'hermes_kanban',
    mode: 'available',
    board: 'symphony-test',
    dispatch: 'observe_only',
    counts: {
      total: tasks.length,
      pending: tasks.filter((t) => t.state === 'pending').length,
      review: tasks.filter((t) => t.state === 'review').length,
      running: tasks.filter((t) => t.state === 'running').length,
      blocked: tasks.filter((t) => t.state === 'blocked').length,
      completed: tasks.filter((t) => t.state === 'completed').length,
      archived: tasks.filter((t) => t.state === 'archived').length,
      unknown: tasks.filter((t) => t.state === 'unknown').length,
    },
    tasks,
    provenance_warnings: [],
  };
}

describe('Kanban liveness classifier', () => {
  it('classifies pending/running/blocked/completed/archived tasks as computable', () => {
    const snapshot = availableSnapshot([
      task({ id: 't1', title: 'Ready', state: 'pending', status: 'ready' }),
      task({ id: 't2', title: 'Running', state: 'running', status: 'running' }),
      task({ id: 't3', title: 'Blocked', state: 'blocked', status: 'blocked' }),
      task({ id: 't4', title: 'Review', state: 'review', status: 'review' }),
      task({ id: 't5', title: 'Done', state: 'completed', status: 'done' }),
      task({ id: 't6', title: 'Archived', state: 'archived', status: 'archived' }),
    ]);

    const result = classifyKanbanLiveness({ snapshot, ledger: null });

    expect(result.mode).toBe('available');
    expect(result.inventory.total).toBe(6);
    expect(result.inventory.computable).toBe(6);
    expect(result.inventory.degraded_or_unknown).toBe(0);
    expect(result.tasks.map((t) => [t.task_id, t.classification, t.computable])).toEqual([
      ['t1', 'ready_to_dispatch', true],
      ['t2', 'running_active', true],
      ['t3', 'blocked_waiting_on_dependency', true],
      ['t4', 'blocked_waiting_on_dependency', true],
      ['t5', 'completed_done', true],
      ['t6', 'archived_or_terminal', true],
    ]);
  });

  it('classifies unknown task states as degraded and unknown', () => {
    const snapshot = availableSnapshot([
      task({ id: 't1', title: 'Ready', state: 'pending', status: 'ready' }),
      task({ id: 't2', title: 'Weird', state: 'unknown', status: 'custom_status' }),
    ]);

    const result = classifyKanbanLiveness({ snapshot, ledger: null });

    expect(result.inventory.computable).toBe(1);
    expect(result.inventory.degraded_or_unknown).toBe(1);
    expect(result.tasks.find((t) => t.task_id === 't2')).toMatchObject({
      classification: 'unknown_unclassified',
      computable: false,
    });
  });

  it('classifies unavailable snapshots as degraded without tasks', () => {
    const snapshot: SymphonyKanbanSnapshot = {
      backend: 'hermes_kanban',
      mode: 'unavailable',
      board: 'symphony-test',
      dispatch: 'observe_only',
      counts: {
        total: 0,
        pending: 0,
        review: 0,
        running: 0,
        blocked: 0,
        completed: 0,
        archived: 0,
        unknown: 0,
      },
      tasks: [],
      error: 'Kanban client unreachable',
      provenance_warnings: [{ kind: 'unavailable', message: 'listTasks unavailable' }],
    };

    const result = classifyKanbanLiveness({ snapshot, ledger: null });

    expect(result.mode).toBe('unavailable');
    expect(result.inventory.total).toBe(0);
    expect(result.inventory.computable).toBe(0);
    expect(result.inventory.degraded_or_unknown).toBe(0);
    expect(result.inventory.by_classification.degraded_kanban_unavailable).toBe(1);
    expect(result.tasks).toHaveLength(0);
    expect(result.warnings).toContain('Kanban snapshot unavailable; classifications are degraded.');
  });

  it('classifies secret-like redacted titles as linear_required_label_missing (human gate)', () => {
    const snapshot = availableSnapshot([
      task({ id: 't1', title: 'HER-SECRET [title redacted]', state: 'pending', status: 'ready', source_identifier: 'HER-SECRET' }),
      task({ id: 't2', title: 'Normal task', state: 'pending', status: 'ready' }),
    ]);

    const result = classifyKanbanLiveness({ snapshot, ledger: null });

    const redacted = result.tasks.find((t) => t.task_id === 't1');
    expect(redacted).toBeDefined();
    expect(redacted?.classification).toBe('linear_required_label_missing');
    expect(redacted?.computable).toBe(false);
    expect(isBlockedByHumanOrExternalGate(redacted?.classification ?? 'ready_to_dispatch')).toBe(true);
    expect(isComputableClassification(redacted?.classification ?? 'ready_to_dispatch')).toBe(false);

    const normal = result.tasks.find((t) => t.task_id === 't2');
    expect(normal).toBeDefined();
    expect(normal?.classification).toBe('ready_to_dispatch');
    expect(normal?.computable).toBe(true);
  });

  it('classifies tasks whose source_identifier is missing from the ledger as ledger_mismatch_orphaned_task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-liveness-ledger-'));
    const ledger = new JsonFileIssueRunLedger(join(root, 'ledger.json'));
    const snapshot = availableSnapshot([
      task({
        id: 't_orphan',
        title: 'Orphan task',
        state: 'pending',
        status: 'ready',
        source_identifier: 'HER-9',
      }),
      task({
        id: 't_known',
        title: 'Known task',
        state: 'pending',
        status: 'ready',
        source_identifier: 'HER-8',
      }),
    ]);

    ledger.recordMutation({
      issue,
      key: 'kanban:task:materialized',
      operation: 'kanban.createTask',
      at: new Date('2026-06-24T12:10:00.000Z'),
      details: { task_id: 't_known' },
    });

    const result = classifyKanbanLiveness({ snapshot, ledger });

    const orphan = result.tasks.find((t) => t.task_id === 't_orphan');
    expect(orphan).toBeDefined();
    expect(orphan?.classification).toBe('ledger_mismatch_orphaned_task');
    expect(orphan?.computable).toBe(false);
    expect(orphan?.reason).toContain('HER-9');
    expect(isBlockedByHumanOrExternalGate(orphan?.classification ?? 'ready_to_dispatch')).toBe(true);

    const known = result.tasks.find((t) => t.task_id === 't_known');
    expect(known).toBeDefined();
    expect(known?.classification).toBe('ready_to_dispatch');
    expect(known?.computable).toBe(true);
  });

  it('does not recommend auto-unblock for human, external, degraded, or unknown gates', () => {
    const gates: KanbanLivenessClassification[] = [
      'linear_required_label_missing',
      'ledger_mismatch_orphaned_task',
      'degraded_kanban_unavailable',
      'unknown_unclassified',
    ];
    for (const gate of gates) {
      expect(isBlockedByHumanOrExternalGate(gate)).toBe(true);
      expect(isComputableClassification(gate)).toBe(false);
    }
  });

  it('does not orphan completed or archived tasks even without ledger records', () => {
    const snapshot = availableSnapshot([
      task({ id: 't_done', title: 'Done orphan', state: 'completed', status: 'done', source_identifier: 'HER-DONE' }),
      task({ id: 't_archived', title: 'Archived orphan', state: 'archived', status: 'archived', source_identifier: 'HER-ARCHIVED' }),
    ]);

    const result = classifyKanbanLiveness({ snapshot, ledger: null });

    expect(result.inventory.degraded_or_unknown).toBe(0);
    expect(result.tasks.every((t) => t.classification !== 'ledger_mismatch_orphaned_task')).toBe(true);
  });

  it('includes non-mutating suggestion-only recommendations with evidence and human-gate flags', () => {
    const snapshot = availableSnapshot([
      task({ id: 't_ready', title: 'Ready', state: 'pending', status: 'ready' }),
      task({ id: 't_running', title: 'Running', state: 'running', status: 'running' }),
      task({ id: 't_blocked', title: 'Blocked', state: 'blocked', status: 'blocked' }),
      task({ id: 't_review', title: 'Review', state: 'review', status: 'review' }),
      task({ id: 't_done', title: 'Done', state: 'completed', status: 'done' }),
      task({ id: 't_archived', title: 'Archived', state: 'archived', status: 'archived' }),
      task({ id: 't_unknown', title: 'Weird', state: 'unknown', status: 'custom_status' }),
      task({ id: 't_redacted', title: 'HER-SECRET [title redacted]', state: 'pending', status: 'ready', source_identifier: 'HER-SECRET' }),
    ]);

    const result = classifyKanbanLiveness({ snapshot, ledger: null });

    const recFor = (classification: KanbanLivenessClassification) => result.recommendations.find((r) => r.classification === classification);

    const ready = recFor('ready_to_dispatch');
    expect(ready).toMatchObject({ kind: 'observe', safe_to_auto_apply: false, requires_human_gate: false });
    expect(ready?.action).toMatch(/observe/i);
    expect(ready?.evidence.length).toBeGreaterThan(0);

    const running = recFor('running_active');
    expect(running).toMatchObject({ kind: 'observe', safe_to_auto_apply: false, requires_human_gate: false });
    expect(running?.action).toMatch(/observe|report/i);

    const blocked = recFor('blocked_waiting_on_dependency');
    expect(blocked).toMatchObject({ kind: 'observe', safe_to_auto_apply: false, requires_human_gate: false });
    expect(blocked?.action).toMatch(/observe|wait/i);

    const done = recFor('completed_done');
    expect(done).toMatchObject({ kind: 'report', safe_to_auto_apply: false, requires_human_gate: false });
    expect(done?.action).toMatch(/report/i);

    const archived = recFor('archived_or_terminal');
    expect(archived).toMatchObject({ kind: 'report', safe_to_auto_apply: false, requires_human_gate: false });
    expect(archived?.action).toMatch(/report/i);

    const unknown = recFor('unknown_unclassified');
    expect(unknown).toMatchObject({ kind: 'investigate', safe_to_auto_apply: false, requires_human_gate: true });

    const redacted = recFor('linear_required_label_missing');
    expect(redacted).toMatchObject({ kind: 'human_gate', safe_to_auto_apply: false, requires_human_gate: true });

    // Aggregate constraint: no recommendation should expose an auto-apply approval bit or describe a mutating action.
    for (const rec of result.recommendations) {
      expect(rec.safe_to_auto_apply).toBe(false);
      expect(rec.action).not.toMatch(/unblock|assign|retry|requeue|dispatch.*now|claim|mutate|auto.*(apply|dispatch|repair)/i);
      expect(rec.kind).not.toBe('dispatch');
    }
  });

  it('recommends human gate for unavailable snapshots without auto-applying any action', () => {
    const snapshot: SymphonyKanbanSnapshot = {
      backend: 'hermes_kanban',
      mode: 'unavailable',
      board: 'symphony-test',
      dispatch: 'observe_only',
      counts: {
        total: 0,
        pending: 0,
        review: 0,
        running: 0,
        blocked: 0,
        completed: 0,
        archived: 0,
        unknown: 0,
      },
      tasks: [],
      error: 'Kanban client unreachable',
      provenance_warnings: [{ kind: 'unavailable', message: 'listTasks unavailable' }],
    };

    const result = classifyKanbanLiveness({ snapshot, ledger: null });

    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      classification: 'degraded_kanban_unavailable',
      kind: 'investigate',
      safe_to_auto_apply: false,
      requires_human_gate: true,
    });
  });

  it('recommendKanbanTaskAction treats human/external gates as non-auto-action suggestions', () => {
    const gates: KanbanLivenessClassification[] = [
      'linear_required_label_missing',
      'ledger_mismatch_orphaned_task',
      'degraded_kanban_unavailable',
      'unknown_unclassified',
    ];
    for (const classification of gates) {
      const rec = recommendKanbanTaskAction(classification);
      expect(rec.safe_to_auto_apply).toBe(false);
      expect(rec.requires_human_gate).toBe(true);
      expect(rec.kind === 'investigate' || rec.kind === 'human_gate').toBe(true);
    }
  });

  it('recommendKanbanTaskAction returns safe_to_auto_apply false for every classification', () => {
    const all: KanbanLivenessClassification[] = [
      'ready_to_dispatch',
      'blocked_waiting_on_dependency',
      'running_active',
      'completed_done',
      'archived_or_terminal',
      'linear_required_label_missing',
      'ledger_mismatch_orphaned_task',
      'degraded_kanban_unavailable',
      'unknown_unclassified',
    ];
    for (const classification of all) {
      const rec = recommendKanbanTaskAction(classification);
      expect(rec.safe_to_auto_apply).toBe(false);
      expect(rec.kind).not.toBe('dispatch');
      expect(rec.kind).not.toBe('wait');
    }
  });
});
