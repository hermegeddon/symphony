import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Issue } from '../src/domain.js';
import { buildGraphSyncEdgeKey } from '../src/graph-sync-ledger.js';
import {
  captureGraphSyncReadOnlySnapshot,
  createFakeGraphSyncKanbanGraphReader,
  createFakeGraphSyncLinearGraphReader,
  createFakeGraphSyncMappingReader,
  type GraphSyncKanbanGraphReader,
  type GraphSyncLinearGraphReader,
  type GraphSyncMappingReader,
} from '../src/graph-sync-live-snapshot.js';
import {
  createFileSystemGraphSyncStateStorage,
  createInMemoryGraphSyncStateStorage,
} from '../src/graph-sync-state-storage.js';
import type { KanbanTaskDetail, KanbanTaskLink } from '../src/kanban-types.js';

describe('GraphSync read-only snapshot capture orchestration', () => {
  it('tracer bullet: fake readers produce a snapshot, diff receipt, and one matched edge', async () => {
    const relationCreatedAt = new Date('2026-06-29T14:00:00.000Z');
    const relationUpdatedAt = new Date('2026-06-29T14:05:00.000Z');
    const issueA = issue({
      id: 'lin_A',
      identifier: 'HER-51',
      state: 'Done',
      linear_relations: [
        {
          id: 'rel_blocks_A_B',
          type: 'blocks',
          observed_from: 'relations' as const,
          issue: { id: 'lin_A', identifier: 'HER-51', state: 'Done' },
          related_issue: { id: 'lin_B', identifier: 'HER-52', state: 'Todo' },
          created_at: relationCreatedAt,
          updated_at: relationUpdatedAt,
          archived_at: null,
        },
      ],
    });
    const issueB = issue({ id: 'lin_B', identifier: 'HER-52', state: 'Todo' });
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

    const result = await captureGraphSyncReadOnlySnapshot({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-snapshot-run-001',
      scope: { tracker: 'linear', selector: 'exact_canary', kanbanBoard: 'linear' },
      linearReader: fakeLinearReader([issueA, issueB]),
      kanbanReader: fakeKanbanReader([taskA, taskB]),
      mappingReader: fakeMappingReader([
        { linearIssueId: 'lin_A', kanbanTaskId: 't_A' },
        { linearIssueId: 'lin_B', kanbanTaskId: 't_B' },
      ]),
      now: new Date('2026-06-29T14:10:00.000Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected success but got ${result.error}`);
    }
    expect(result.effect).toBe('graph_sync_read_only_snapshot_capture');
    expect(result.status).toBe('PASS');
    expect(result.mode).toBe('read_only_snapshot');
    expect(result.suppressed_writes).toBe(true);
    expect(result.workflow_id).toBe('symphony-linear-kanban-bridge');
    expect(result.run_id).toBe('graph-snapshot-run-001');

    expect(result.snapshot.issues).toEqual([issueA, issueB]);
    expect(result.snapshot.kanbanTasks).toEqual([taskA, taskB]);
    expect(result.snapshot.nodeMappings).toEqual([
      { linearIssueId: 'lin_A', kanbanTaskId: 't_A' },
      { linearIssueId: 'lin_B', kanbanTaskId: 't_B' },
    ]);
    expect(result.snapshot.completeness.apply_eligible).toBe(true);
    expect(result.snapshot.completeness.linear_issues).toBe('complete');
    expect(result.snapshot.completeness.kanban_tasks).toBe('complete');
    expect(result.snapshot.completeness.reader_errors).toEqual([]);
    expect(result.snapshot.completeness.rate_limited).toBe(false);

    expect(result.receipt.summary).toMatchObject({
      linear_edges_seen: 1,
      kanban_edges_seen: 1,
      matched_edges: 1,
      missing_kanban_edges: 0,
      missing_linear_relations: 0,
    });
    expect(result.receipt.proposed_operations).toEqual([]);
    expect(result.receipt.suppressed_writes).toBe(true);
    expect(result.receipt.mode).toBe('read_only_diff');

    expect(result.summary).toMatchObject({
      linear_issues_read: 2,
      kanban_tasks_read: 2,
      mappings_resolved: 2,
      linear_edges_seen: 1,
      kanban_edges_seen: 1,
      matched_edges: 1,
      missing_kanban_edges: 0,
      missing_linear_relations: 0,
      endpoint_policies: 0,
      cycles_detected: 0,
      proposed_operations: 0,
    });

    expect(result.non_actions).toEqual([
      'did_not_create_update_delete_linear_relations',
      'did_not_create_update_delete_kanban_links',
      'did_not_edit_restart_or_disable_services_or_timers',
      'did_not_dispatch_workers_or_gateway',
      'did_not_expose_raw_linear_token_or_authorization_header',
      'did_not_push_publish_deploy_or_open_pr',
    ]);
  });

  it('proposes create_kanban_edge when Linear has a blocks relation but Kanban does not', async () => {
    const issueA = issue({ id: 'lin_A', identifier: 'HER-61', state: 'Done' });
    const issueB = issue({
      id: 'lin_B',
      identifier: 'HER-62',
      state: 'Todo',
      linear_relations: [
        {
          id: 'rel_blocks_A_B',
          type: 'blocks',
          observed_from: 'relations' as const,
          issue: { id: 'lin_A', identifier: 'HER-61', state: 'Done' },
          related_issue: { id: 'lin_B', identifier: 'HER-62', state: 'Todo' },
          created_at: new Date('2026-06-29T14:00:00.000Z'),
          updated_at: new Date('2026-06-29T14:05:00.000Z'),
          archived_at: null,
        },
      ],
    });
    const taskA = task({ id: 't_A', status: 'done' });
    const taskB = task({ id: 't_B', status: 'todo' });

    const storage = createInMemoryGraphSyncStateStorage();
    const result = await captureGraphSyncReadOnlySnapshot({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-snapshot-run-002',
      scope: { tracker: 'linear', selector: 'exact_canary', kanbanBoard: 'linear' },
      linearReader: fakeLinearReader([issueA, issueB]),
      kanbanReader: fakeKanbanReader([taskA, taskB]),
      mappingReader: fakeMappingReader([
        { linearIssueId: 'lin_A', kanbanTaskId: 't_A' },
        { linearIssueId: 'lin_B', kanbanTaskId: 't_B' },
      ]),
      stateStorage: storage,
      now: new Date('2026-06-29T14:20:00.000Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected success but got ${result.error}`);
    }
    expect(result.checkpoint_state_path).toBe('injected');
    expect(result.checkpoint).not.toBeNull();
    expect(result.checkpoint?.state.generation).toBe(1);
    expect(result.status).toBe('REVIEW');
    expect(result.receipt.summary).toMatchObject({
      linear_edges_seen: 1,
      kanban_edges_seen: 0,
      matched_edges: 0,
      missing_kanban_edges: 1,
    });
    expect(result.receipt.proposed_operations).toEqual([
      expect.objectContaining({
        operation: 'create_kanban_edge',
        source: 'linear',
        target_edge_key: buildGraphSyncEdgeKey('kanban:task:t_A', 'kanban:task:t_B', 'blocks'),
        suppressed: true,
      }),
    ]);

    const stored = await storage.read();
    expect(stored).not.toBeNull();
    expect(stored?.generation).toBe(1);
  });

  it('advances checkpoint generation from durable state across two runs', async () => {
    const relationCreatedAt = new Date('2026-06-29T14:00:00.000Z');
    const relationUpdatedAt = new Date('2026-06-29T14:05:00.000Z');
    const issueA = issue({
      id: 'lin_A',
      identifier: 'HER-51',
      state: 'Done',
      linear_relations: [
        {
          id: 'rel_blocks_A_B',
          type: 'blocks',
          observed_from: 'relations' as const,
          issue: { id: 'lin_A', identifier: 'HER-51', state: 'Done' },
          related_issue: { id: 'lin_B', identifier: 'HER-52', state: 'Todo' },
          created_at: relationCreatedAt,
          updated_at: relationUpdatedAt,
          archived_at: null,
        },
      ],
    });
    const issueB = issue({ id: 'lin_B', identifier: 'HER-52', state: 'Todo' });
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

    const storage = createInMemoryGraphSyncStateStorage();

    const result1 = await captureGraphSyncReadOnlySnapshot({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-snapshot-run-001',
      scope: { tracker: 'linear', selector: 'exact_canary', kanbanBoard: 'linear' },
      linearReader: createFakeGraphSyncLinearGraphReader([issueA, issueB]),
      kanbanReader: createFakeGraphSyncKanbanGraphReader([taskA, taskB]),
      mappingReader: createFakeGraphSyncMappingReader([
        { linearIssueId: 'lin_A', kanbanTaskId: 't_A' },
        { linearIssueId: 'lin_B', kanbanTaskId: 't_B' },
      ]),
      stateStorage: storage,
      now: new Date('2026-06-29T14:10:00.000Z'),
    });

    expect(result1.ok).toBe(true);
    if (!result1.ok) {
      throw new Error(`expected first run to succeed but got ${result1.error}`);
    }
    expect(result1.checkpoint_state_path).toBe('injected');
    expect(result1.checkpoint?.state.generation).toBe(1);

    const result2 = await captureGraphSyncReadOnlySnapshot({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-snapshot-run-002',
      scope: { tracker: 'linear', selector: 'exact_canary', kanbanBoard: 'linear' },
      linearReader: createFakeGraphSyncLinearGraphReader([issueA, issueB]),
      kanbanReader: createFakeGraphSyncKanbanGraphReader([taskA, taskB]),
      mappingReader: createFakeGraphSyncMappingReader([
        { linearIssueId: 'lin_A', kanbanTaskId: 't_A' },
        { linearIssueId: 'lin_B', kanbanTaskId: 't_B' },
      ]),
      stateStorage: storage,
      now: new Date('2026-06-29T14:15:00.000Z'),
    });

    expect(result2.ok).toBe(true);
    if (!result2.ok) {
      throw new Error(`expected second run to succeed but got ${result2.error}`);
    }
    expect(result2.checkpoint_state_path).toBe('injected');
    expect(result2.checkpoint?.state.generation).toBe(2);
    expect(result2.checkpoint?.state.previous_generation).toBe(1);

    const stored = await storage.read();
    expect(stored).not.toBeNull();
    expect(stored?.generation).toBe(2);
    expect(stored?.previous_generation).toBe(1);
  });

  it('persists checkpoint state to a file and reloads it on the next run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-state-path-'));
    const statePath = join(root, 'state.json');

    const issueA = issue({ id: 'lin_A', identifier: 'HER-91', state: 'Done' });
    const issueB = issue({
      id: 'lin_B',
      identifier: 'HER-92',
      state: 'Todo',
      linear_relations: [
        {
          id: 'rel_blocks_A_B',
          type: 'blocks',
          observed_from: 'relations' as const,
          issue: { id: 'lin_A', identifier: 'HER-91', state: 'Done' },
          related_issue: { id: 'lin_B', identifier: 'HER-92', state: 'Todo' },
          created_at: new Date('2026-06-29T14:00:00.000Z'),
          updated_at: new Date('2026-06-29T14:05:00.000Z'),
          archived_at: null,
        },
      ],
    });
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

    const storage = createFileSystemGraphSyncStateStorage({ statePath, dryRun: false });

    const result1 = await captureGraphSyncReadOnlySnapshot({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-snapshot-run-file-001',
      scope: { tracker: 'linear', selector: 'exact_canary', kanbanBoard: 'linear' },
      linearReader: createFakeGraphSyncLinearGraphReader([issueA, issueB]),
      kanbanReader: createFakeGraphSyncKanbanGraphReader([taskA, taskB]),
      mappingReader: createFakeGraphSyncMappingReader([
        { linearIssueId: 'lin_A', kanbanTaskId: 't_A' },
        { linearIssueId: 'lin_B', kanbanTaskId: 't_B' },
      ]),
      stateStorage: storage,
      now: new Date('2026-06-29T14:10:00.000Z'),
    });

    expect(result1.ok).toBe(true);
    if (!result1.ok) {
      throw new Error(`expected first file-backed run to succeed but got ${result1.error}`);
    }
    expect(result1.checkpoint?.state.generation).toBe(1);

    const storage2 = createFileSystemGraphSyncStateStorage({ statePath, dryRun: false });

    const result2 = await captureGraphSyncReadOnlySnapshot({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-snapshot-run-file-002',
      scope: { tracker: 'linear', selector: 'exact_canary', kanbanBoard: 'linear' },
      linearReader: createFakeGraphSyncLinearGraphReader([issueA, issueB]),
      kanbanReader: createFakeGraphSyncKanbanGraphReader([taskA, taskB]),
      mappingReader: createFakeGraphSyncMappingReader([
        { linearIssueId: 'lin_A', kanbanTaskId: 't_A' },
        { linearIssueId: 'lin_B', kanbanTaskId: 't_B' },
      ]),
      stateStorage: storage2,
      now: new Date('2026-06-29T14:15:00.000Z'),
    });

    expect(result2.ok).toBe(true);
    if (!result2.ok) {
      throw new Error(`expected second file-backed run to succeed but got ${result2.error}`);
    }
    expect(result2.checkpoint?.state.generation).toBe(2);
    expect(result2.checkpoint?.state.previous_generation).toBe(1);

    await rm(root, { recursive: true, force: true });
  });

  it('proposes create_linear_relation when Kanban has a blocks link but Linear does not', async () => {
    const issueA = issue({ id: 'lin_A', identifier: 'HER-71', state: 'Done' });
    const issueB = issue({ id: 'lin_B', identifier: 'HER-72', state: 'Todo' });
    const blockingLink: KanbanTaskLink = {
      parentTaskId: 't_A',
      childTaskId: 't_B',
      kind: 'blocks',
      blocking: true,
      requiredParentStatuses: ['done'],
      source: 'symphony-graph-sync',
      createdBy: 'symphony-ts',
      metadata: {},
    };
    const taskA = task({ id: 't_A', status: 'done', childLinks: [blockingLink] });
    const taskB = task({ id: 't_B', status: 'todo', parentLinks: [blockingLink] });

    const result = await captureGraphSyncReadOnlySnapshot({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-snapshot-run-003',
      scope: { tracker: 'linear', selector: 'exact_canary', kanbanBoard: 'linear' },
      linearReader: fakeLinearReader([issueA, issueB]),
      kanbanReader: fakeKanbanReader([taskA, taskB]),
      mappingReader: fakeMappingReader([
        { linearIssueId: 'lin_A', kanbanTaskId: 't_A' },
        { linearIssueId: 'lin_B', kanbanTaskId: 't_B' },
      ]),
      now: new Date('2026-06-29T14:30:00.000Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected success but got ${result.error}`);
    }
    expect(result.status).toBe('REVIEW');
    expect(result.receipt.summary).toMatchObject({
      linear_edges_seen: 0,
      kanban_edges_seen: 1,
      matched_edges: 0,
      missing_linear_relations: 1,
    });
    expect(result.receipt.proposed_operations).toEqual([
      expect.objectContaining({
        operation: 'create_linear_relation',
        source: 'kanban',
        target_edge_key: buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks'),
        suppressed: true,
      }),
    ]);
  });

  it('records endpoint policy when a Kanban endpoint has no Linear mapping', async () => {
    const issueA = issue({ id: 'lin_A', identifier: 'HER-81', state: 'Done' });
    const blockingLink: KanbanTaskLink = {
      parentTaskId: 't_A',
      childTaskId: 't_B',
      kind: 'blocks',
      blocking: true,
      requiredParentStatuses: ['done'],
      source: 'symphony-graph-sync',
      createdBy: 'symphony-ts',
      metadata: {},
    };
    const taskA = task({ id: 't_A', status: 'done', childLinks: [blockingLink] });
    const taskB = task({ id: 't_B', status: 'todo', parentLinks: [blockingLink] });

    const result = await captureGraphSyncReadOnlySnapshot({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-snapshot-run-004',
      scope: { tracker: 'linear', selector: 'exact_canary', kanbanBoard: 'linear' },
      linearReader: fakeLinearReader([issueA]),
      kanbanReader: fakeKanbanReader([taskA, taskB]),
      mappingReader: fakeMappingReader([{ linearIssueId: 'lin_A', kanbanTaskId: 't_A' }]),
      now: new Date('2026-06-29T14:40:00.000Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected success but got ${result.error}`);
    }
    expect(result.status).toBe('REVIEW');
    expect(result.receipt.summary.endpoint_policies).toBeGreaterThan(0);
    expect(result.receipt.proposed_operations).toEqual([]);
    expect(result.receipt.diff.endpoint_policies[0]).toMatchObject({
      policy: 'record_only_no_apply',
      severity: 'warning',
      human_action_recommendation: 'inspect_endpoint_policy',
    });
  });

  it('returns BLOCK when a reader fails and marks completeness apply_eligible false', async () => {
    const result = await captureGraphSyncReadOnlySnapshot({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-snapshot-run-005',
      scope: { tracker: 'linear', selector: 'exact_canary', kanbanBoard: 'linear' },
      linearReader: failingLinearReader('Linear API rate limited'),
      kanbanReader: fakeKanbanReader([]),
      mappingReader: fakeMappingReader([]),
      now: new Date('2026-06-29T14:50:00.000Z'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.status).toBe('BLOCK');
    expect(result.error).toContain('Linear API rate limited');
    expect(result.suppressed_writes).toBe(true);
  });
});

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

function failingLinearReader(message: string): GraphSyncLinearGraphReader {
  return {
    readIssuesWithRelations(): Promise<readonly Issue[]> {
      return Promise.reject(new Error(message));
    },
  };
}
