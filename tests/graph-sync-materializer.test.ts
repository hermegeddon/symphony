import { describe, expect, it } from 'vitest';

import { buildGraphSyncEdgeKey, buildGraphSyncReadOnlyDiffReceipt } from '../src/graph-sync-ledger.js';
import {
  applyGraphSyncMissingLinearBlockingRelations,
  materializeGraphSyncMissingKanbanBlockingEdges,
} from '../src/graph-sync-materializer.js';
import type { CreateLinearIssueRelationInput } from '../src/tracker.js';
import type {
  CreateKanbanTaskLinkInput,
  KanbanClient,
  KanbanTaskDetail,
  KanbanTaskLink,
} from '../src/kanban-types.js';

describe('GraphSync fake-only Kanban blocking-edge materializer', () => {
  it('creates missing Linear-authoritative blocking links through an injected fake Kanban client and verifies readback', async () => {
    const receipt = buildGraphSyncReadOnlyDiffReceipt({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-run-fake-materialize',
      generatedAt: '2026-06-28T23:40:00.000Z',
      completedAt: '2026-06-28T23:40:01.000Z',
      scope: { tracker: 'linear', kanbanBoard: 'linear' },
      nodeMappings: [
        {
          linearIssue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
          kanbanTask: { id: 't_A', status: 'done' },
        },
        {
          linearIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
          kanbanTask: { id: 't_B', status: 'todo' },
        },
      ],
      linearRelations: [
        {
          relation: {
            id: 'rel_blocks_A_B',
            type: 'blocks',
            issue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
            relatedIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
            createdAt: '2026-06-28T22:00:00.000Z',
            updatedAt: '2026-06-28T22:05:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
      ],
      kanbanEdges: [],
    });
    const linearEdgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks');
    const kanbanEdgeKey = buildGraphSyncEdgeKey('kanban:task:t_A', 'kanban:task:t_B', 'blocks');
    const createCalls: CreateKanbanTaskLinkInput[] = [];
    const parentLinks: KanbanTaskLink[] = [];
    const kanbanClient: Pick<KanbanClient, 'createTaskLink' | 'showTask'> = {
      createTaskLink: (input) => {
        createCalls.push(input);
        const link: KanbanTaskLink = {
          parentTaskId: input.parentId,
          childTaskId: input.childId,
          kind: input.kind ?? 'blocks',
          blocking: input.blocking ?? false,
          requiredParentStatuses: input.requiredParentStatuses ?? [],
          source: input.source ?? null,
          createdBy: input.createdBy ?? null,
          metadata: input.metadata ?? {},
        };
        parentLinks.push(link);
        return Promise.resolve(link);
      },
      showTask: (id): Promise<KanbanTaskDetail> => Promise.resolve({
        id,
        title: 'Blocked task',
        status: 'blocked',
        assignee: null,
        body: null,
        parents: [],
        children: [],
        parentLinks,
        childLinks: [],
        comments: [],
        raw: {},
      }),
    };

    const result = await materializeGraphSyncMissingKanbanBlockingEdges({
      boundary: 'fake_only',
      receipt,
      kanbanClient,
    });

    expect(createCalls).toEqual([
      {
        parentId: 't_A',
        childId: 't_B',
        kind: 'blocks',
        blocking: true,
        requiredParentStatuses: ['done'],
        source: 'symphony-graph-sync',
        createdBy: 'symphony-ts',
        metadata: {
          graph_sync_edge_key: linearEdgeKey,
          linear_relation_ids: 'rel_blocks_A_B',
        },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      effect: 'graph_sync_fake_kanban_blocking_edge_materialization',
      boundary: 'fake_only',
      source_receipt_run_id: 'graph-run-fake-materialize',
      source_receipt_mode: 'read_only_diff',
      non_actions: [
        'did_not_query_linear',
        'did_not_create_update_delete_linear_relations',
        'did_not_read_or_mutate_live_hermes_kanban_board',
        'did_not_start_or_restart_services_or_timers',
        'did_not_dispatch_workers_or_gateway',
        'did_not_push_publish_deploy_or_open_pr',
      ],
      summary: {
        candidate_missing_kanban_edges: 1,
        created_kanban_edges: 1,
        skipped_edges: 0,
        readback_verified: 1,
      },
      created_links: [
        {
          linear_edge_key: linearEdgeKey,
          kanban_edge_key: kanbanEdgeKey,
          parent_task_id: 't_A',
          child_task_id: 't_B',
          relation_ids: ['rel_blocks_A_B'],
          readback_verified: true,
        },
      ],
      skipped_edges: [],
    });
  });

  it('treats the typed create response as verification when Hermes show omits registry-backed edges', async () => {
    const receipt = buildGraphSyncReadOnlyDiffReceipt({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-run-create-response-readback',
      generatedAt: '2026-06-29T23:00:00.000Z',
      completedAt: '2026-06-29T23:00:01.000Z',
      scope: { tracker: 'linear', kanbanBoard: 'linear' },
      nodeMappings: [
        {
          linearIssue: { id: 'lin_A', identifier: 'HER-91', stateName: 'Done' },
          kanbanTask: { id: 't_A', status: 'blocked' },
        },
        {
          linearIssue: { id: 'lin_B', identifier: 'HER-92', stateName: 'Todo' },
          kanbanTask: { id: 't_B', status: 'blocked' },
        },
      ],
      linearRelations: [
        {
          relation: {
            id: 'rel_blocks_A_B',
            type: 'blocks',
            issue: { id: 'lin_A', identifier: 'HER-91', stateName: 'Done' },
            relatedIssue: { id: 'lin_B', identifier: 'HER-92', stateName: 'Todo' },
            createdAt: '2026-06-29T22:00:00.000Z',
            updatedAt: '2026-06-29T22:05:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
      ],
      kanbanEdges: [],
    });
    const createdLink: KanbanTaskLink = {
      parentTaskId: 't_A',
      childTaskId: 't_B',
      kind: 'blocks',
      blocking: true,
      requiredParentStatuses: ['done'],
      source: 'symphony-graph-sync',
      createdBy: 'symphony-ts',
      metadata: { graph_sync_edge_key: buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks') },
    };
    const kanbanClient: Pick<KanbanClient, 'createTaskLink' | 'showTask'> = {
      createTaskLink: () => Promise.resolve(createdLink),
      showTask: (id): Promise<KanbanTaskDetail> => Promise.resolve({
        id,
        title: 'Blocked task',
        status: 'blocked',
        assignee: null,
        body: null,
        parents: [],
        children: [],
        parentLinks: [],
        childLinks: [],
        comments: [],
        raw: {},
      }),
    };

    const result = await materializeGraphSyncMissingKanbanBlockingEdges({
      boundary: 'fake_only',
      receipt,
      kanbanClient,
    });

    expect(result.summary).toMatchObject({
      candidate_missing_kanban_edges: 1,
      created_kanban_edges: 1,
      readback_verified: 1,
    });
    expect(result.created_links[0]?.readback_verified).toBe(true);
  });
});

describe('GraphSync live Linear blocking-relation apply', () => {
  it('creates missing Kanban-authoritative Linear blocks relations through an injected Linear client and verifies readback', async () => {
    const receipt = buildGraphSyncReadOnlyDiffReceipt({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-run-linear-live-apply',
      generatedAt: '2026-06-30T16:20:00.000Z',
      completedAt: '2026-06-30T16:20:01.000Z',
      scope: { tracker: 'linear', kanbanBoard: 'linear' },
      nodeMappings: [
        {
          linearIssue: { id: 'lin_A', identifier: 'HER-101', stateName: 'Todo' },
          kanbanTask: { id: 't_A', status: 'blocked' },
        },
        {
          linearIssue: { id: 'lin_B', identifier: 'HER-102', stateName: 'Todo' },
          kanbanTask: { id: 't_B', status: 'blocked' },
        },
      ],
      linearRelations: [],
      kanbanEdges: [
        {
          parentTaskId: 't_A',
          childTaskId: 't_B',
          kind: 'blocks',
          blocking: true,
          requiredParentStatuses: ['done'],
          source: 'symphony-k2l-test',
          createdBy: 'symphony-ts',
          metadata: {},
        },
      ],
    });
    const kanbanEdgeKey = buildGraphSyncEdgeKey('kanban:task:t_A', 'kanban:task:t_B', 'blocks');
    const linearEdgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks');
    expect(receipt.summary).toMatchObject({ missing_linear_relations: 1 });
    expect(receipt.diff.missing_linear_relations).toEqual([
      {
        canonical_kind: 'blocks',
        kanban_edge_key: kanbanEdgeKey,
        expected_linear_edge_key: linearEdgeKey,
        reason: 'kanban_edge_has_no_matching_linear_relation',
      },
    ]);
    expect(receipt.proposed_operations).toEqual([
      expect.objectContaining({
        operation: 'create_linear_relation',
        source: 'kanban',
        source_edge_key: kanbanEdgeKey,
        target_edge_key: linearEdgeKey,
        suppressed: true,
      }),
    ]);

    const createCalls: CreateLinearIssueRelationInput[] = [];
    const createdRelationIds: string[] = [];
    const linearClient = {
      createIssueRelation: (input: CreateLinearIssueRelationInput) => {
        createCalls.push(input);
        createdRelationIds.push('rel_lin_A_lin_B');
        return Promise.resolve({
          relation_id: 'rel_lin_A_lin_B',
          type: input.type,
          issue_id: input.issueId,
          related_issue_id: input.relatedIssueId,
        });
      },
      hasIssueRelation: (input: CreateLinearIssueRelationInput) => Promise.resolve(
        input.issueId === 'lin_A'
          && input.relatedIssueId === 'lin_B'
          && createdRelationIds.includes('rel_lin_A_lin_B'),
      ),
    };

    const result = await applyGraphSyncMissingLinearBlockingRelations({
      boundary: 'live_apply',
      receipt,
      linearClient,
      approvedScope: 'K2L test: create one Linear blocks relation for t_A -> t_B only',
      maxCreatedRelations: 1,
    });

    expect(createCalls).toEqual([
      {
        issueId: 'lin_A',
        relatedIssueId: 'lin_B',
        type: 'blocks',
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      effect: 'graph_sync_live_linear_blocking_relation_apply',
      mode: 'kanban_authoritative_apply',
      boundary: 'live_apply',
      approved_scope: 'K2L test: create one Linear blocks relation for t_A -> t_B only',
      suppressed_writes: false,
      summary: {
        candidate_missing_linear_relations: 1,
        created_linear_relations: 1,
        skipped_relations: 0,
        readback_verified: 1,
      },
      created_relations: [
        {
          kanban_edge_key: kanbanEdgeKey,
          linear_edge_key: linearEdgeKey,
          parent_issue_id: 'lin_A',
          child_issue_id: 'lin_B',
          relation_id: 'rel_lin_A_lin_B',
          readback_verified: true,
        },
      ],
      skipped_relations: [],
    });
    expect(result.actions).toEqual(['created_live_linear_blocking_relations']);
    expect(result.non_actions).toEqual([
      'did_not_query_or_mutate_hermes_kanban',
      'did_not_create_update_delete_kanban_links',
      'did_not_move_linear_issue_states',
      'did_not_start_or_restart_services_or_timers',
      'did_not_dispatch_workers_or_gateway',
      'did_not_push_publish_deploy_or_open_pr',
      'did_not_expose_raw_linear_token_or_authorization_header',
    ]);
  });
});
