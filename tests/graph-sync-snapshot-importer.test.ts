import { describe, expect, it } from 'vitest';

import type { Issue } from '../src/domain.js';
import {
  buildGraphSyncEdgeKey,
  buildGraphSyncReadOnlyDiffReceipt,
} from '../src/graph-sync-ledger.js';
import { buildGraphSyncReadOnlySnapshotFromObservedGraph } from '../src/graph-sync-snapshot-importer.js';
import type { KanbanTaskDetail, KanbanTaskLink } from '../src/kanban-types.js';

describe('GraphSync observed graph snapshot importer', () => {
  it('normalizes Linear relations and deduplicated Kanban task link readbacks into read-only diff input', () => {
    const relationCreatedAt = new Date('2026-06-29T14:00:00.000Z');
    const relationUpdatedAt = new Date('2026-06-29T14:05:00.000Z');
    const issueA = issue({
      id: 'lin_A',
      identifier: 'HER-31',
      state: 'Done',
      linear_relations: [
        {
          id: 'rel_blocks_A_B',
          type: 'blocks',
          observed_from: 'relations',
          issue: { id: 'lin_A', identifier: 'HER-31', state: 'Done' },
          related_issue: { id: 'lin_B', identifier: 'HER-32', state: 'Todo' },
          created_at: relationCreatedAt,
          updated_at: relationUpdatedAt,
          archived_at: null,
        },
      ],
    });
    const issueB = issue({ id: 'lin_B', identifier: 'HER-32', state: 'Todo' });
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

    const snapshot = buildGraphSyncReadOnlySnapshotFromObservedGraph({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-import-run-001',
      generatedAt: '2026-06-29T14:10:00.000Z',
      completedAt: '2026-06-29T14:10:01.000Z',
      scope: { tracker: 'linear', selector: 'exact_canary', kanbanBoard: 'linear' },
      issues: [issueA, issueB],
      kanbanTasks: [taskA, taskB],
      nodeMappings: [
        { linearIssueId: 'lin_A', kanbanTaskId: 't_A' },
        { linearIssueId: 'lin_B', kanbanTaskId: 't_B' },
      ],
    });

    expect(snapshot).toMatchObject({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-import-run-001',
      generatedAt: '2026-06-29T14:10:00.000Z',
      completedAt: '2026-06-29T14:10:01.000Z',
      scope: { tracker: 'linear', selector: 'exact_canary', kanbanBoard: 'linear' },
      nodeMappings: [
        {
          linearIssue: { id: 'lin_A', identifier: 'HER-31', stateName: 'Done' },
          kanbanTask: { id: 't_A', status: 'done' },
        },
        {
          linearIssue: { id: 'lin_B', identifier: 'HER-32', stateName: 'Todo' },
          kanbanTask: { id: 't_B', status: 'todo' },
        },
      ],
      linearRelations: [
        {
          relation: {
            id: 'rel_blocks_A_B',
            type: 'blocks',
            issue: { id: 'lin_A', identifier: 'HER-31', stateName: 'Done' },
            relatedIssue: { id: 'lin_B', identifier: 'HER-32', stateName: 'Todo' },
            createdAt: relationCreatedAt.toISOString(),
            updatedAt: relationUpdatedAt.toISOString(),
            archivedAt: null,
          },
          observedFrom: 'relations',
          anchorIssueId: 'lin_A',
        },
      ],
      kanbanEdges: [
        {
          parentTaskId: 't_A',
          childTaskId: 't_B',
          kind: 'blocks',
          blocking: true,
          requiredParentStatuses: ['done'],
          source: 'symphony-graph-sync',
          createdBy: 'symphony-ts',
          metadata: { linear_relation_id: 'rel_blocks_A_B' },
        },
      ],
    });

    const receipt = buildGraphSyncReadOnlyDiffReceipt(snapshot);
    const linearEdgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks');
    const kanbanEdgeKey = buildGraphSyncEdgeKey('kanban:task:t_A', 'kanban:task:t_B', 'blocks');

    expect(receipt.summary).toMatchObject({
      linear_edges_seen: 1,
      kanban_edges_seen: 1,
      matched_edges: 1,
      missing_kanban_edges: 0,
      missing_linear_relations: 0,
    });
    expect(receipt.diff.matched_edges).toEqual([
      { canonical_kind: 'blocks', linear_edge_key: linearEdgeKey, kanban_edge_key: kanbanEdgeKey },
    ]);
    expect(receipt.proposed_operations).toEqual([]);
    expect(receipt.suppressed_writes).toBe(true);
  });

  it('records mapped Kanban-only blocking links as suppressed Linear relation proposals', () => {
    const issueA = issue({ id: 'lin_A', identifier: 'HER-41', state: 'Done' });
    const issueB = issue({ id: 'lin_B', identifier: 'HER-42', state: 'Todo' });
    const taskA = task({
      id: 't_A',
      status: 'done',
      childLinks: [
        {
          parentTaskId: 't_A',
          childTaskId: 't_B',
          kind: 'blocks',
          blocking: true,
          requiredParentStatuses: ['done'],
          source: 'symphony-graph-sync',
          createdBy: 'symphony-ts',
          metadata: {},
        },
      ],
    });
    const taskB = task({ id: 't_B', status: 'todo' });

    const receipt = buildGraphSyncReadOnlyDiffReceipt(buildGraphSyncReadOnlySnapshotFromObservedGraph({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-import-run-002',
      generatedAt: '2026-06-29T14:20:00.000Z',
      completedAt: '2026-06-29T14:20:01.000Z',
      scope: { tracker: 'linear', selector: 'exact_canary', kanbanBoard: 'linear' },
      issues: [issueA, issueB],
      kanbanTasks: [taskA, taskB],
      nodeMappings: [
        { linearIssueId: 'lin_A', kanbanTaskId: 't_A' },
        { linearIssueId: 'lin_B', kanbanTaskId: 't_B' },
      ],
    }));

    expect(receipt.summary).toMatchObject({
      linear_edges_seen: 0,
      kanban_edges_seen: 1,
      matched_edges: 0,
      missing_linear_relations: 1,
    });
    expect(receipt.proposed_operations).toEqual([
      expect.objectContaining({
        operation: 'create_linear_relation',
        source: 'kanban',
        target_edge_key: buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks'),
        suppressed: true,
      }),
    ]);
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
