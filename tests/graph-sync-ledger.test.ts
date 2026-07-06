import { describe, expect, it } from 'vitest';

import {
  buildGraphSyncEdgeKey,
  buildGraphSyncSemanticEventKey,
  createEmptyGraphSyncLedger,
  createGraphSyncConflictRecord,
  createGraphSyncTombstoneRecord,
  kanbanEdgeSnapshotToCanonicalEdge,
  linearRelationSnapshotToCanonicalEdge,
  buildGraphSyncReadOnlyDiffReceipt,
} from '../src/graph-sync-ledger.js';

describe('GraphSyncLedger schema fixtures', () => {
  it('creates an empty ledger and maps Linear blocks relations to predecessor -> successor edges', () => {
    const ledger = createEmptyGraphSyncLedger({
      workflowId: 'symphony-linear-kanban-bridge',
      scope: {
        tracker: 'linear',
        selector: 'all_approved_projects',
        kanbanBoard: 'linear',
      },
      generatedAt: '2026-06-27T18:26:25.000Z',
    });

    expect(ledger).toEqual({
      version: 1,
      generated_by: 'symphony-linear-kanban-bridge',
      workflow_id: 'symphony-linear-kanban-bridge',
      generated_at: '2026-06-27T18:26:25.000Z',
      scope: {
        tracker: 'linear',
        selector: 'all_approved_projects',
        kanbanBoard: 'linear',
      },
      nodes: {},
      edges: {},
      conflicts: {},
      semantic_events: {},
      runs: [],
    });

    const directBlocks = linearRelationSnapshotToCanonicalEdge({
      relation: {
        id: 'rel_blocks_A_B',
        type: 'blocks',
        issue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
        relatedIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
        createdAt: '2026-06-27T18:00:00.000Z',
        updatedAt: '2026-06-27T18:05:00.000Z',
        archivedAt: null,
      },
      observedFrom: 'relations',
    });

    expect(directBlocks).toMatchObject({
      edge_key: buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks'),
      predecessor: 'linear:issue:lin_A',
      successor: 'linear:issue:lin_B',
      canonical_kind: 'blocks',
      source: 'linear',
      adoption_state: 'observed',
      linear: {
        relation_ids: ['rel_blocks_A_B'],
        relation_type: 'blocks',
        issue_id: 'lin_A',
        related_issue_id: 'lin_B',
        observed_from: 'relations',
        visibility: 'visible',
      },
    });

    const inverseBlocks = linearRelationSnapshotToCanonicalEdge({
      relation: {
        id: 'rel_blocks_A_B',
        type: 'blocks',
        issue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
        relatedIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
        createdAt: '2026-06-27T18:00:00.000Z',
        updatedAt: '2026-06-27T18:05:00.000Z',
        archivedAt: null,
      },
      observedFrom: 'inverseRelations',
      anchorIssueId: 'lin_B',
    });

    expect(inverseBlocks.predecessor).toBe('linear:issue:lin_A');
    expect(inverseBlocks.successor).toBe('linear:issue:lin_B');
    expect(inverseBlocks.linear).toBeDefined();
    if (inverseBlocks.linear === undefined) {
      throw new Error('expected inverse Linear blocks relation to preserve Linear edge metadata');
    }
    expect(inverseBlocks.linear.observed_from).toBe('inverseRelations');
    expect(inverseBlocks.adapter_vocabulary).toEqual({ blocked_by: 'linear:issue:lin_A' });
  });

  it('maps Kanban task links with explicit blocking metadata instead of treating all topology as scheduler-blocking', () => {
    const blockingEdge = kanbanEdgeSnapshotToCanonicalEdge({
      parentTaskId: 't_predecessor',
      childTaskId: 't_successor',
      kind: 'blocks',
      blocking: true,
      requiredParentStatuses: ['done'],
      source: 'symphony-linear-kanban-bridge',
      createdBy: 'symphony-ts',
      metadata: {
        workflow_id: 'symphony-linear-kanban-bridge',
        linear_relation_id: 'rel_blocks_A_B',
      },
    });

    expect(blockingEdge).toMatchObject({
      edge_key: buildGraphSyncEdgeKey('kanban:task:t_predecessor', 'kanban:task:t_successor', 'blocks'),
      predecessor: 'kanban:task:t_predecessor',
      successor: 'kanban:task:t_successor',
      canonical_kind: 'blocks',
      source: 'kanban',
      adoption_state: 'observed',
      kanban: {
        parent_task_id: 't_predecessor',
        child_task_id: 't_successor',
        kind: 'blocks',
        blocking: true,
        required_parent_statuses: ['done'],
        source: 'symphony-linear-kanban-bridge',
        created_by: 'symphony-ts',
        metadata: {
          workflow_id: 'symphony-linear-kanban-bridge',
          linear_relation_id: 'rel_blocks_A_B',
        },
      },
    });

    const topologyOnlyEdge = kanbanEdgeSnapshotToCanonicalEdge({
      parentTaskId: 't_reference',
      childTaskId: 't_followup',
      kind: 'related',
      blocking: false,
      requiredParentStatuses: [],
      source: null,
      createdBy: null,
      metadata: {},
    });

    expect(topologyOnlyEdge.canonical_kind).toBe('related');
    expect(topologyOnlyEdge.kanban?.blocking).toBe(false);
    expect(topologyOnlyEdge.kanban?.required_parent_statuses).toEqual([]);
    expect(topologyOnlyEdge.fingerprints['kanban']).toContain('nonblocking');
  });

  it('creates stable conflict, tombstone, and semantic-event records for fail-closed graph diffs', () => {
    const edgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks');
    const conflict = createGraphSyncConflictRecord({
      edgeKey,
      currentFingerprint: 'linear-relation|rel_2|blocks|lin_A|lin_B',
      previousFingerprint: 'linear-relation|rel_1|blocks|lin_A|lin_B',
      changedSides: ['linear'],
      blockedReason: 'Linear relation endpoint changed since last checkpoint.',
      proposedOperations: ['suppress_apply', 'write_read_only_diff_receipt'],
      humanResolutionOptions: ['accept_new_linear_edge', 'keep_existing_kanban_edge'],
    });

    expect(conflict).toEqual({
      conflict_key: buildGraphSyncSemanticEventKey('conflict', [edgeKey, 'linear-relation|rel_2|blocks|lin_A|lin_B']),
      edge_key: edgeKey,
      current_fingerprint: 'linear-relation|rel_2|blocks|lin_A|lin_B',
      previous_fingerprint: 'linear-relation|rel_1|blocks|lin_A|lin_B',
      changed_sides: ['linear'],
      blocked_reason: 'Linear relation endpoint changed since last checkpoint.',
      proposed_operations: ['suppress_apply', 'write_read_only_diff_receipt'],
      human_resolution_options: ['accept_new_linear_edge', 'keep_existing_kanban_edge'],
      severity: 'error',
      human_action_recommendation: 'human_decision_required',
    });

    const tombstone = createGraphSyncTombstoneRecord({
      tombstonedAt: '2026-06-27T19:00:00.000Z',
      reason: 'adopted Linear relation was deleted after checkpoint',
      source: 'linear',
    });

    expect(tombstone).toEqual({
      tombstoned_at: '2026-06-27T19:00:00.000Z',
      reason: 'adopted Linear relation was deleted after checkpoint',
      source: 'linear',
    });

    expect(buildGraphSyncSemanticEventKey('edge_deleted', [edgeKey, 'tombstone_hash'])).toBe(
      `edge_deleted:${edgeKey}:tombstone_hash`,
    );
  });

  it('builds a read-only graph diff receipt from matched Linear relations and Kanban edges', () => {
    const receipt = buildGraphSyncReadOnlyDiffReceipt({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-run-001',
      generatedAt: '2026-06-27T20:00:00.000Z',
      completedAt: '2026-06-27T20:00:01.000Z',
      scope: {
        tracker: 'linear',
        selector: 'all_approved_projects',
        kanbanBoard: 'linear',
      },
      nodeMappings: [
        {
          linearIssue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
          kanbanTask: { id: 't_predecessor', status: 'done' },
        },
        {
          linearIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
          kanbanTask: { id: 't_successor', status: 'blocked' },
        },
      ],
      linearRelations: [
        {
          relation: {
            id: 'rel_blocks_A_B',
            type: 'blocks',
            issue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
            relatedIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
            createdAt: '2026-06-27T18:00:00.000Z',
            updatedAt: '2026-06-27T18:05:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
      ],
      kanbanEdges: [
        {
          parentTaskId: 't_predecessor',
          childTaskId: 't_successor',
          kind: 'blocks',
          blocking: true,
          requiredParentStatuses: ['done'],
          source: 'symphony-linear-kanban-bridge',
          createdBy: 'symphony-ts',
          metadata: { linear_relation_id: 'rel_blocks_A_B' },
        },
      ],
    });

    const linearEdgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks');
    const kanbanEdgeKey = buildGraphSyncEdgeKey('kanban:task:t_predecessor', 'kanban:task:t_successor', 'blocks');

    expect(receipt).toMatchObject({
      ok: true,
      effect: 'graph_sync_read_only_diff',
      workflow_id: 'symphony-linear-kanban-bridge',
      run_id: 'graph-run-001',
      mode: 'read_only_diff',
      suppressed_writes: true,
      non_actions: [
        'linear_relation_create_update_delete_suppressed',
        'kanban_link_create_update_delete_suppressed',
        'service_timer_restart_suppressed',
        'mcp_apply_surface_suppressed',
      ],
      proposed_operations: [],
      summary: {
        linear_edges_seen: 1,
        kanban_edges_seen: 1,
        matched_edges: 1,
        missing_kanban_edges: 0,
        missing_linear_relations: 0,
        conflicts: 0,
        semantic_events: 0,
      },
    });
    expect(receipt.ledger.nodes['linear:issue:lin_A']).toMatchObject({
      canonical_id: 'linear:issue:lin_A',
      kind: 'linear_issue',
      materialization_status: 'materialized',
      linear_issue: { id: 'lin_A', identifier: 'HER-21', state_name: 'Done' },
      kanban_task: { id: 't_predecessor', status: 'done' },
    });
    expect(receipt.ledger.nodes['kanban:task:t_predecessor']).toMatchObject({
      canonical_id: 'kanban:task:t_predecessor',
      kind: 'kanban_task',
      materialization_status: 'materialized',
      linear_issue: { id: 'lin_A', identifier: 'HER-21', state_name: 'Done' },
      kanban_task: { id: 't_predecessor', status: 'done' },
    });
    expect(receipt.ledger.edges[linearEdgeKey]).toMatchObject({ edge_key: linearEdgeKey, source: 'linear' });
    expect(receipt.ledger.edges[kanbanEdgeKey]).toMatchObject({ edge_key: kanbanEdgeKey, source: 'kanban' });
    expect(receipt.diff.matched_edges).toEqual([
      {
        canonical_kind: 'blocks',
        linear_edge_key: linearEdgeKey,
        kanban_edge_key: kanbanEdgeKey,
      },
    ]);
  });

  it('reports missing graph counterparts as suppressed read-only proposals without applying them', () => {
    const receipt = buildGraphSyncReadOnlyDiffReceipt({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-run-002',
      generatedAt: '2026-06-27T20:05:00.000Z',
      completedAt: '2026-06-27T20:05:01.000Z',
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
        {
          linearIssue: { id: 'lin_C', identifier: 'HER-23', stateName: 'Todo' },
          kanbanTask: { id: 't_C', status: 'todo' },
        },
      ],
      linearRelations: [
        {
          relation: {
            id: 'rel_blocks_A_B',
            type: 'blocks',
            issue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
            relatedIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
            createdAt: '2026-06-27T18:00:00.000Z',
            updatedAt: '2026-06-27T18:05:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
      ],
      kanbanEdges: [
        {
          parentTaskId: 't_B',
          childTaskId: 't_C',
          kind: 'blocks',
          blocking: true,
          requiredParentStatuses: ['done'],
          source: 'symphony-linear-kanban-bridge',
          createdBy: 'symphony-ts',
          metadata: {},
        },
      ],
    });

    const linearEdgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks');
    const missingKanbanEdgeKey = buildGraphSyncEdgeKey('kanban:task:t_A', 'kanban:task:t_B', 'blocks');
    const kanbanEdgeKey = buildGraphSyncEdgeKey('kanban:task:t_B', 'kanban:task:t_C', 'blocks');
    const missingLinearEdgeKey = buildGraphSyncEdgeKey('linear:issue:lin_B', 'linear:issue:lin_C', 'blocks');

    expect(receipt.summary).toMatchObject({
      matched_edges: 0,
      missing_kanban_edges: 1,
      missing_linear_relations: 1,
    });
    expect(receipt.diff.missing_kanban_edges).toEqual([
      {
        canonical_kind: 'blocks',
        linear_edge_key: linearEdgeKey,
        expected_kanban_edge_key: missingKanbanEdgeKey,
        reason: 'linear_relation_has_no_matching_kanban_edge',
      },
    ]);
    expect(receipt.diff.missing_linear_relations).toEqual([
      {
        canonical_kind: 'blocks',
        kanban_edge_key: kanbanEdgeKey,
        expected_linear_edge_key: missingLinearEdgeKey,
        reason: 'kanban_edge_has_no_matching_linear_relation',
      },
    ]);
    expect(receipt.proposed_operations).toEqual([
      {
        operation: 'create_kanban_edge',
        source: 'linear',
        source_edge_key: linearEdgeKey,
        target_edge_key: missingKanbanEdgeKey,
        reason: 'linear_relation_has_no_matching_kanban_edge',
        severity: 'warning',
        human_action_recommendation: 'review',
        suppressed: true,
      },
      {
        operation: 'create_linear_relation',
        source: 'kanban',
        source_edge_key: kanbanEdgeKey,
        target_edge_key: missingLinearEdgeKey,
        reason: 'kanban_edge_has_no_matching_linear_relation',
        severity: 'warning',
        human_action_recommendation: 'review',
        suppressed: true,
      },
    ]);
    expect(receipt.suppressed_writes).toBe(true);
  });

  it('records endpoint policies for Linear dependency endpoints missing Kanban mappings without proposing apply', () => {
    const receipt = buildGraphSyncReadOnlyDiffReceipt({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-run-003',
      generatedAt: '2026-06-27T20:08:00.000Z',
      completedAt: '2026-06-27T20:08:01.000Z',
      scope: { tracker: 'linear', kanbanBoard: 'linear' },
      nodeMappings: [
        {
          linearIssue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
          kanbanTask: { id: 't_A', status: 'done' },
        },
      ],
      linearRelations: [
        {
          relation: {
            id: 'rel_blocks_A_B_unmapped',
            type: 'blocks',
            issue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
            relatedIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
            createdAt: '2026-06-27T18:00:00.000Z',
            updatedAt: '2026-06-27T18:05:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
      ],
      kanbanEdges: [],
    });

    const linearEdgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks');

    expect(receipt.summary).toMatchObject({
      missing_kanban_edges: 1,
      endpoint_policies: 1,
    });
    expect(receipt.diff.missing_kanban_edges).toEqual([
      {
        canonical_kind: 'blocks',
        linear_edge_key: linearEdgeKey,
        expected_kanban_edge_key: 'unmapped',
        reason: 'linear_edge_endpoint_missing_kanban_mapping',
      },
    ]);
    expect(receipt.diff.endpoint_policies).toEqual([
      {
        policy_key:
          'endpoint_policy:blocks:linear:issue:lin_A->linear:issue:lin_B:linear:issue:lin_B:linear_edge_endpoint_missing_kanban_mapping',
        edge_key: linearEdgeKey,
        endpoint_id: 'linear:issue:lin_B',
        endpoint_kind: 'linear_issue',
        source: 'linear',
        scope_visibility: 'visible',
        materialization_status: 'missing',
        reason: 'linear_edge_endpoint_missing_kanban_mapping',
        policy: 'record_only_no_apply',
        suppressed_operations: ['create_kanban_edge'],
        severity: 'warning',
        human_action_recommendation: 'inspect_endpoint_policy',
      },
    ]);
    expect(receipt.proposed_operations).toEqual([]);
    expect(receipt.suppressed_writes).toBe(true);
  });

  it('records explicit outside-scope and deleted endpoint policy metadata without proposing apply', () => {
    const receipt = buildGraphSyncReadOnlyDiffReceipt({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-run-004',
      generatedAt: '2026-06-27T20:09:00.000Z',
      completedAt: '2026-06-27T20:09:01.000Z',
      scope: { tracker: 'linear', kanbanBoard: 'linear' },
      nodeMappings: [
        {
          linearIssue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
          kanbanTask: { id: 't_A', status: 'done' },
        },
      ],
      endpointPolicyHints: [
        {
          endpoint: {
            kind: 'linear_issue',
            issue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
          },
          scopeVisibility: 'outside_scope',
          materializationStatus: 'external',
          reason: 'dependency_endpoint_outside_scope',
        },
        {
          endpoint: {
            kind: 'linear_issue',
            issue: { id: 'lin_C', identifier: 'HER-23', stateName: null },
          },
          scopeVisibility: 'deleted_or_archived',
          materializationStatus: 'missing',
          reason: 'dependency_endpoint_deleted_or_archived',
        },
      ],
      linearRelations: [
        {
          relation: {
            id: 'rel_blocks_A_B_outside_scope',
            type: 'blocks',
            issue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
            relatedIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
            createdAt: '2026-06-27T18:00:00.000Z',
            updatedAt: '2026-06-27T18:05:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
        {
          relation: {
            id: 'rel_blocks_A_C_deleted',
            type: 'blocks',
            issue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
            relatedIssue: { id: 'lin_C', identifier: 'HER-23', stateName: null },
            createdAt: '2026-06-27T18:10:00.000Z',
            updatedAt: '2026-06-27T18:15:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
      ],
      kanbanEdges: [],
    });

    const outsideScopeEdgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks');
    const deletedEdgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_C', 'blocks');

    expect(receipt.summary).toMatchObject({
      missing_kanban_edges: 2,
      endpoint_policies: 2,
    });
    expect(receipt.diff.endpoint_policies).toEqual([
      {
        policy_key:
          'endpoint_policy:blocks:linear:issue:lin_A->linear:issue:lin_B:linear:issue:lin_B:dependency_endpoint_outside_scope',
        edge_key: outsideScopeEdgeKey,
        endpoint_id: 'linear:issue:lin_B',
        endpoint_kind: 'linear_issue',
        source: 'linear',
        scope_visibility: 'outside_scope',
        materialization_status: 'external',
        reason: 'dependency_endpoint_outside_scope',
        policy: 'record_only_no_apply',
        suppressed_operations: ['create_kanban_edge'],
        severity: 'warning',
        human_action_recommendation: 'inspect_endpoint_policy',
      },
      {
        policy_key:
          'endpoint_policy:blocks:linear:issue:lin_A->linear:issue:lin_C:linear:issue:lin_C:dependency_endpoint_deleted_or_archived',
        edge_key: deletedEdgeKey,
        endpoint_id: 'linear:issue:lin_C',
        endpoint_kind: 'linear_issue',
        source: 'linear',
        scope_visibility: 'deleted_or_archived',
        materialization_status: 'missing',
        reason: 'dependency_endpoint_deleted_or_archived',
        policy: 'record_only_no_apply',
        suppressed_operations: ['create_kanban_edge'],
        severity: 'warning',
        human_action_recommendation: 'inspect_endpoint_policy',
      },
    ]);
    expect(receipt.ledger.nodes['linear:issue:lin_B']).toMatchObject({
      canonical_id: 'linear:issue:lin_B',
      kind: 'linear_issue',
      scope_visibility: 'outside_scope',
      materialization_status: 'external',
      linear_issue: { id: 'lin_B', identifier: 'HER-22', state_name: 'Todo' },
    });
    expect(receipt.ledger.nodes['linear:issue:lin_C']).toMatchObject({
      canonical_id: 'linear:issue:lin_C',
      kind: 'linear_issue',
      scope_visibility: 'deleted_or_archived',
      materialization_status: 'missing',
      linear_issue: { id: 'lin_C', identifier: 'HER-23', state_name: null },
    });
    expect(receipt.proposed_operations).toEqual([]);
  });

  it('records endpoint policies for Kanban dependency endpoints missing Linear mappings without proposing apply', () => {
    const receipt = buildGraphSyncReadOnlyDiffReceipt({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-run-005',
      generatedAt: '2026-06-27T20:09:30.000Z',
      completedAt: '2026-06-27T20:09:31.000Z',
      scope: { tracker: 'linear', kanbanBoard: 'linear' },
      nodeMappings: [
        {
          linearIssue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
          kanbanTask: { id: 't_A', status: 'done' },
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
          source: 'symphony-linear-kanban-bridge',
          createdBy: 'symphony-ts',
          metadata: {},
        },
      ],
    });

    const kanbanEdgeKey = buildGraphSyncEdgeKey('kanban:task:t_A', 'kanban:task:t_B', 'blocks');

    expect(receipt.summary).toMatchObject({
      missing_linear_relations: 1,
      endpoint_policies: 1,
    });
    expect(receipt.diff.missing_linear_relations).toEqual([
      {
        canonical_kind: 'blocks',
        kanban_edge_key: kanbanEdgeKey,
        expected_linear_edge_key: 'unmapped',
        reason: 'kanban_edge_endpoint_missing_linear_mapping',
      },
    ]);
    expect(receipt.diff.endpoint_policies).toEqual([
      {
        policy_key:
          'endpoint_policy:blocks:kanban:task:t_A->kanban:task:t_B:kanban:task:t_B:kanban_edge_endpoint_missing_linear_mapping',
        edge_key: kanbanEdgeKey,
        endpoint_id: 'kanban:task:t_B',
        endpoint_kind: 'kanban_task',
        source: 'kanban',
        scope_visibility: 'visible',
        materialization_status: 'missing',
        reason: 'kanban_edge_endpoint_missing_linear_mapping',
        policy: 'record_only_no_apply',
        suppressed_operations: ['create_linear_relation'],
        severity: 'warning',
        human_action_recommendation: 'inspect_endpoint_policy',
      },
    ]);
    expect(receipt.proposed_operations).toEqual([]);
  });

  it('preserves duplicate Linear relation IDs on one canonical edge instead of overwriting them', () => {
    const receipt = buildGraphSyncReadOnlyDiffReceipt({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-run-006',
      generatedAt: '2026-06-27T20:10:00.000Z',
      completedAt: '2026-06-27T20:10:01.000Z',
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
            id: 'rel_blocks_A_B_primary',
            type: 'blocks',
            issue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
            relatedIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
            createdAt: '2026-06-27T18:00:00.000Z',
            updatedAt: '2026-06-27T18:05:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
        {
          relation: {
            id: 'rel_blocks_A_B_duplicate',
            type: 'blocks',
            issue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
            relatedIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
            createdAt: '2026-06-27T18:10:00.000Z',
            updatedAt: '2026-06-27T18:15:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
      ],
      kanbanEdges: [],
    });

    const linearEdgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks');

    expect(receipt.ledger.edges[linearEdgeKey]).toMatchObject({
      duplicate_state: 'duplicate_linear_relations',
      linear: {
        relation_ids: ['rel_blocks_A_B_primary', 'rel_blocks_A_B_duplicate'],
      },
    });
    expect(receipt.proposed_operations).toHaveLength(1);
  });

  it('adds receipt-only severity and human-action metadata to operator findings without authorizing writes', () => {
    const conflict = createGraphSyncConflictRecord({
      edgeKey: buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks'),
      currentFingerprint: 'linear-relation|rel_2|blocks|lin_A|lin_B',
      previousFingerprint: 'linear-relation|rel_1|blocks|lin_A|lin_B',
      changedSides: ['linear'],
      blockedReason: 'Linear relation endpoint changed since last checkpoint.',
      proposedOperations: ['suppress_apply', 'write_read_only_diff_receipt'],
      humanResolutionOptions: ['accept_new_linear_edge', 'keep_existing_kanban_edge'],
    });

    expect(conflict).toMatchObject({
      severity: 'error',
      human_action_recommendation: 'human_decision_required',
    });

    const receipt = buildGraphSyncReadOnlyDiffReceipt({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-run-007',
      generatedAt: '2026-06-27T20:20:00.000Z',
      completedAt: '2026-06-27T20:20:01.000Z',
      scope: { tracker: 'linear', kanbanBoard: 'linear' },
      nodeMappings: [
        {
          linearIssue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Todo' },
          kanbanTask: { id: 't_A', status: 'todo' },
        },
        {
          linearIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
          kanbanTask: { id: 't_B', status: 'todo' },
        },
      ],
      endpointPolicyHints: [
        {
          endpoint: {
            kind: 'linear_issue',
            issue: { id: 'lin_C', identifier: 'HER-23', stateName: null },
          },
          scopeVisibility: 'inaccessible',
          materializationStatus: 'external',
          reason: 'dependency_endpoint_inaccessible',
        },
      ],
      linearRelations: [
        {
          relation: {
            id: 'rel_A_B',
            type: 'blocks',
            issue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Todo' },
            relatedIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
            createdAt: '2026-06-27T18:00:00.000Z',
            updatedAt: '2026-06-27T18:00:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
        {
          relation: {
            id: 'rel_B_A',
            type: 'blocks',
            issue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
            relatedIssue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Todo' },
            createdAt: '2026-06-27T18:01:00.000Z',
            updatedAt: '2026-06-27T18:01:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
        {
          relation: {
            id: 'rel_A_C_unmapped',
            type: 'blocks',
            issue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Todo' },
            relatedIssue: { id: 'lin_C', identifier: 'HER-23', stateName: null },
            createdAt: '2026-06-27T18:02:00.000Z',
            updatedAt: '2026-06-27T18:02:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
      ],
      kanbanEdges: [],
    });

    expect(receipt.diff.cycles).toEqual([
      expect.objectContaining({
        severity: 'error',
        human_action_recommendation: 'resolve_cycle',
      }),
    ]);
    expect(Object.values(receipt.ledger.semantic_events)).toEqual([
      expect.objectContaining({
        severity: 'error',
        human_action_recommendation: 'resolve_cycle',
      }),
    ]);
    expect(receipt.diff.endpoint_policies).toEqual([
      expect.objectContaining({
        reason: 'dependency_endpoint_inaccessible',
        severity: 'warning',
        human_action_recommendation: 'inspect_endpoint_policy',
      }),
    ]);
    expect(receipt.proposed_operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'create_kanban_edge',
          severity: 'warning',
          human_action_recommendation: 'review',
          suppressed: true,
        }),
      ]),
    );
    expect(receipt.suppressed_writes).toBe(true);
    expect(receipt.non_actions).toEqual([
      'linear_relation_create_update_delete_suppressed',
      'kanban_link_create_update_delete_suppressed',
      'service_timer_restart_suppressed',
      'mcp_apply_surface_suppressed',
    ]);
  });

  it('emits a cycle semantic event for read-only graph cycles without introducing apply operations', () => {
    const receipt = buildGraphSyncReadOnlyDiffReceipt({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-run-004',
      generatedAt: '2026-06-27T20:15:00.000Z',
      completedAt: '2026-06-27T20:15:01.000Z',
      scope: { tracker: 'linear', kanbanBoard: 'linear' },
      nodeMappings: [
        {
          linearIssue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Todo' },
          kanbanTask: { id: 't_A', status: 'todo' },
        },
        {
          linearIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
          kanbanTask: { id: 't_B', status: 'todo' },
        },
        {
          linearIssue: { id: 'lin_C', identifier: 'HER-23', stateName: 'Todo' },
          kanbanTask: { id: 't_C', status: 'todo' },
        },
      ],
      linearRelations: [
        {
          relation: {
            id: 'rel_A_B',
            type: 'blocks',
            issue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Todo' },
            relatedIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
            createdAt: '2026-06-27T18:00:00.000Z',
            updatedAt: '2026-06-27T18:00:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
        {
          relation: {
            id: 'rel_B_C',
            type: 'blocks',
            issue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
            relatedIssue: { id: 'lin_C', identifier: 'HER-23', stateName: 'Todo' },
            createdAt: '2026-06-27T18:01:00.000Z',
            updatedAt: '2026-06-27T18:01:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
        {
          relation: {
            id: 'rel_C_A',
            type: 'blocks',
            issue: { id: 'lin_C', identifier: 'HER-23', stateName: 'Todo' },
            relatedIssue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Todo' },
            createdAt: '2026-06-27T18:02:00.000Z',
            updatedAt: '2026-06-27T18:02:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
      ],
      kanbanEdges: [
        {
          parentTaskId: 't_A',
          childTaskId: 't_B',
          kind: 'blocks',
          blocking: true,
          requiredParentStatuses: ['done'],
          source: 'symphony-linear-kanban-bridge',
          createdBy: 'symphony-ts',
          metadata: { linear_relation_id: 'rel_A_B' },
        },
        {
          parentTaskId: 't_B',
          childTaskId: 't_C',
          kind: 'blocks',
          blocking: true,
          requiredParentStatuses: ['done'],
          source: 'symphony-linear-kanban-bridge',
          createdBy: 'symphony-ts',
          metadata: { linear_relation_id: 'rel_B_C' },
        },
        {
          parentTaskId: 't_C',
          childTaskId: 't_A',
          kind: 'blocks',
          blocking: true,
          requiredParentStatuses: ['done'],
          source: 'symphony-linear-kanban-bridge',
          createdBy: 'symphony-ts',
          metadata: { linear_relation_id: 'rel_C_A' },
        },
      ],
    });

    const cycleEventKey =
      'cycle:blocks:linear:issue:lin_A->linear:issue:lin_B|blocks:linear:issue:lin_B->linear:issue:lin_C|blocks:linear:issue:lin_C->linear:issue:lin_A';

    expect(receipt.summary).toMatchObject({
      matched_edges: 3,
      missing_kanban_edges: 0,
      missing_linear_relations: 0,
      cycles_detected: 1,
      semantic_events: 1,
    });
    expect(receipt.diff.cycles).toEqual([
      {
        cycle_key: cycleEventKey,
        canonical_kind: 'blocks',
        node_ids: ['linear:issue:lin_A', 'linear:issue:lin_B', 'linear:issue:lin_C', 'linear:issue:lin_A'],
        edge_keys: [
          'blocks:linear:issue:lin_A->linear:issue:lin_B',
          'blocks:linear:issue:lin_B->linear:issue:lin_C',
          'blocks:linear:issue:lin_C->linear:issue:lin_A',
        ],
        sources: ['linear', 'kanban'],
        severity: 'error',
        human_action_recommendation: 'resolve_cycle',
      },
    ]);
    expect(Object.values(receipt.ledger.semantic_events)).toEqual([
      {
        event_key: cycleEventKey,
        kind: 'cycle',
        first_seen_at: '2026-06-27T20:15:00.000Z',
        last_seen_at: '2026-06-27T20:15:00.000Z',
        count: 1,
        severity: 'error',
        human_action_recommendation: 'resolve_cycle',
      },
    ]);
    expect(receipt.proposed_operations).toEqual([]);
    expect(receipt.suppressed_writes).toBe(true);
  });
});
