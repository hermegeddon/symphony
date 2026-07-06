import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildGraphSyncEdgeKey,
  buildGraphSyncReadOnlyDiffReceipt,
  createEmptyGraphSyncLedger,
  type GraphSyncReadOnlyDiffReceipt,
} from '../src/graph-sync-ledger.js';
import {
  createFileSystemGraphSyncStateStorage,
  createInMemoryGraphSyncStateStorage,
} from '../src/graph-sync-state-storage.js';

import {
  adoptGraphSyncEdge,
  createGraphSyncCheckpointFromReceipt,
  GRAPH_SYNC_STATE_VERSION,
  type GraphSyncState,
  type GraphSyncStateStorage,
} from '../src/graph-sync-state.js';

function minimalMatchedReceipt(input?: { runId?: string; generatedAt?: string; completedAt?: string }): GraphSyncReadOnlyDiffReceipt {
  return buildGraphSyncReadOnlyDiffReceipt({
    workflowId: 'symphony-graph-sync-state',
    runId: input?.runId ?? 'run-001',
    generatedAt: input?.generatedAt ?? '2026-06-29T20:00:00.000Z',
    completedAt: input?.completedAt ?? '2026-06-29T20:00:01.000Z',
    scope: { tracker: 'linear', kanbanBoard: 'linear' },
    nodeMappings: [
      {
        linearIssue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
        kanbanTask: { id: 't_A', status: 'done' },
      },
      {
        linearIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
        kanbanTask: { id: 't_B', status: 'blocked' },
      },
    ],
    linearRelations: [
      {
        relation: {
          id: 'rel_blocks_A_B',
          type: 'blocks',
          issue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
          relatedIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
          createdAt: '2026-06-29T19:00:00.000Z',
          updatedAt: '2026-06-29T19:00:00.000Z',
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
        metadata: { linear_relation_id: 'rel_blocks_A_B' },
      },
    ],
  });
}

function emptyInMemoryStorage(): GraphSyncStateStorage {
  let state: GraphSyncState | undefined;
  return {
    read: () => Promise.resolve(state ?? null),
    write: (next) => {
      state = next;
      return Promise.resolve();
    },
  };
}

function createThrowawaySeamStorage(): GraphSyncStateStorage {
  let state: GraphSyncState | null = null;
  return {
    read: () => Promise.resolve(state),
    write: (next) => {
      state = next;
      return Promise.resolve();
    },
  };
}

describe('GraphSyncState', () => {
  it('empty ledger + first receipt -> checkpoint generation 1', async () => {
    const receipt = minimalMatchedReceipt();
    const storage = emptyInMemoryStorage();
    const checkpoint = await createGraphSyncCheckpointFromReceipt({
      receipt,
      previousState: null,
      storage,
      generatedAt: '2026-06-29T20:00:02.000Z',
    });

    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) {
      throw new Error('expected checkpoint to succeed');
    }
    expect(checkpoint.state.generation).toBe(1);
    expect(checkpoint.state.workflow_id).toBe('symphony-graph-sync-state');
    expect(checkpoint.state.previous_generation).toBeNull();
    expect(checkpoint.state.receipt_run_id).toBe('run-001');

    const edgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks');
    expect(checkpoint.ledger.edges[edgeKey]).toBeDefined();
    expect(checkpoint.ledger.edges[edgeKey]?.checkpoint_generation).toBe(1);
    expect(checkpoint.ledger.edges[edgeKey]?.adoption_state).toBe('observed');
    expect(checkpoint.ledger.edges[edgeKey]?.duplicate_state).toBe('single');
  });

  it('unchanged receipt -> no new semantic event and stable fingerprints', async () => {
    const receipt1 = minimalMatchedReceipt({ runId: 'run-001' });
    const storage = emptyInMemoryStorage();
    const checkpoint1 = await createGraphSyncCheckpointFromReceipt({
      receipt: receipt1,
      previousState: null,
      storage,
      generatedAt: '2026-06-29T20:00:02.000Z',
    });
    expect(checkpoint1.ok).toBe(true);
    if (!checkpoint1.ok) {
      throw new Error('expected first checkpoint to succeed');
    }

    const stored = await storage.read();
    expect(stored).not.toBeNull();

    const receipt2 = minimalMatchedReceipt({ runId: 'run-002', generatedAt: '2026-06-29T20:05:00.000Z', completedAt: '2026-06-29T20:05:01.000Z' });
    const checkpoint2 = await createGraphSyncCheckpointFromReceipt({
      receipt: receipt2,
      previousState: stored,
      storage,
      generatedAt: '2026-06-29T20:05:02.000Z',
    });

    expect(checkpoint2.ok).toBe(true);
    if (!checkpoint2.ok) {
      throw new Error('expected second checkpoint to succeed');
    }
    expect(checkpoint2.state.generation).toBe(2);
    expect(checkpoint2.state.previous_generation).toBe(1);

    const edgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks');
    const storedAfter = await storage.read();
    if (storedAfter === null) {
      throw new Error('expected stored state');
    }
    expect(storedAfter.ledger.edges[edgeKey]?.checkpoint_generation).toBe(1);
    expect(storedAfter.ledger.edges[edgeKey]?.fingerprints).toEqual(checkpoint1.ledger.edges[edgeKey]?.fingerprints);
    expect(Object.keys(checkpoint2.ledger.semantic_events)).toHaveLength(0);
  });

  it('stored checkpoint without caller previous state -> advances from durable storage', async () => {
    const storage = emptyInMemoryStorage();
    const checkpoint1 = await createGraphSyncCheckpointFromReceipt({
      receipt: minimalMatchedReceipt({ runId: 'run-001' }),
      previousState: null,
      storage,
      generatedAt: '2026-06-29T20:00:02.000Z',
    });
    expect(checkpoint1.ok).toBe(true);
    if (!checkpoint1.ok) {
      throw new Error('expected first checkpoint to succeed');
    }

    const checkpoint2 = await createGraphSyncCheckpointFromReceipt({
      receipt: minimalMatchedReceipt({ runId: 'run-002', generatedAt: '2026-06-29T20:05:00.000Z', completedAt: '2026-06-29T20:05:01.000Z' }),
      previousState: null,
      storage,
      generatedAt: '2026-06-29T20:05:02.000Z',
    });

    expect(checkpoint2.ok).toBe(true);
    if (!checkpoint2.ok) {
      throw new Error('expected second checkpoint to use durable storage');
    }
    expect(checkpoint2.state.generation).toBe(2);
    expect(checkpoint2.state.previous_generation).toBe(1);
    expect(checkpoint2.state.receipt_run_id).toBe('run-002');

    const storedAfter = await storage.read();
    if (storedAfter === null) {
      throw new Error('expected stored state');
    }
    expect(storedAfter.generation).toBe(2);
    expect(storedAfter.previous_generation).toBe(1);
  });

  it('Linear edge disappears once -> pending tombstone candidate, no delete proposal', async () => {
    const receipt1 = minimalMatchedReceipt({ runId: 'run-001' });
    const storage = emptyInMemoryStorage();
    const checkpoint1 = await createGraphSyncCheckpointFromReceipt({
      receipt: receipt1,
      previousState: null,
      storage,
      generatedAt: '2026-06-29T20:00:02.000Z',
    });
    expect(checkpoint1.ok).toBe(true);

    const stored1 = await storage.read();

    const receipt2 = buildGraphSyncReadOnlyDiffReceipt({
      workflowId: 'symphony-graph-sync-state',
      runId: 'run-002',
      generatedAt: '2026-06-29T20:05:00.000Z',
      completedAt: '2026-06-29T20:05:01.000Z',
      scope: { tracker: 'linear', kanbanBoard: 'linear' },
      nodeMappings: [
        {
          linearIssue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
          kanbanTask: { id: 't_A', status: 'done' },
        },
        {
          linearIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
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
          source: 'symphony-linear-kanban-bridge',
          createdBy: 'symphony-ts',
          metadata: { linear_relation_id: 'rel_blocks_A_B' },
        },
      ],
    });

    const checkpoint2 = await createGraphSyncCheckpointFromReceipt({
      receipt: receipt2,
      previousState: stored1,
      storage,
      generatedAt: '2026-06-29T20:05:02.000Z',
    });

    expect(checkpoint2.ok).toBe(true);
    if (!checkpoint2.ok) {
      throw new Error('expected checkpoint to succeed');
    }

    const edgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks');
    const edge = checkpoint2.ledger.edges[edgeKey];
    expect(edge).toBeDefined();
    expect(edge?.adoption_state).toBe('tombstoned');
    expect(edge?.tombstone).toMatchObject({
      reason: 'edge no longer observed in either side; pending checkpoint confirmation',
      source: 'linear',
    });
    expect(checkpoint2.ledger.conflicts[edgeKey]).toBeUndefined();
  });

  it('adopted Linear edge disappears from Kanban -> recreate proposal in linear_authoritative_apply', async () => {
    const receipt1 = minimalMatchedReceipt({ runId: 'run-001' });
    const storage = emptyInMemoryStorage();
    const checkpoint1 = await createGraphSyncCheckpointFromReceipt({
      receipt: receipt1,
      previousState: null,
      storage,
      generatedAt: '2026-06-29T20:00:02.000Z',
    });
    expect(checkpoint1.ok).toBe(true);
    if (!checkpoint1.ok) {
      throw new Error('expected checkpoint to succeed');
    }

    const edgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks');
    const adopted = adoptGraphSyncEdge({
      ledger: checkpoint1.ledger,
      edgeKey,
      mode: 'linear_authoritative_apply',
      approvedScope: 'test-adoption-001',
      runId: 'adopt-run-001',
      generatedAt: '2026-06-29T20:01:00.000Z',
    });
    expect(adopted).toMatchObject({ ok: true, adoption_state: 'adopted', edge_key: edgeKey });
    if (!adopted.ok) {
      throw new Error('expected adoption to succeed');
    }

    const checkpoint1State = checkpoint1.state;
    const storage2 = emptyInMemoryStorage();
    await storage2.write({
      ...checkpoint1State,
      ledger: adopted.ledger,
      version: GRAPH_SYNC_STATE_VERSION,
      workflow_id: checkpoint1State.workflow_id,
      scope: { ...checkpoint1State.scope },
      generation: checkpoint1State.generation,
      previous_generation: checkpoint1State.previous_generation,
      generated_at: checkpoint1State.generated_at,
      receipt_run_id: checkpoint1State.receipt_run_id,
    });

    const receipt2 = buildGraphSyncReadOnlyDiffReceipt({
      workflowId: 'symphony-graph-sync-state',
      runId: 'run-002',
      generatedAt: '2026-06-29T20:05:00.000Z',
      completedAt: '2026-06-29T20:05:01.000Z',
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
      linearRelations: [],
      kanbanEdges: [],
    });

    const checkpoint2 = await createGraphSyncCheckpointFromReceipt({
      receipt: receipt2,
      previousState: await storage2.read(),
      storage: storage2,
      generatedAt: '2026-06-29T20:05:02.000Z',
      mode: 'linear_authoritative_apply',
    });

    expect(checkpoint2.ok).toBe(true);
    if (!checkpoint2.ok) {
      throw new Error('expected checkpoint to succeed');
    }
    const recreated = checkpoint2.ledger.edges[edgeKey];
    expect(recreated).toBeDefined();
    expect(recreated?.adoption_state).toBe('proposed');
    const recreateProposal = checkpoint2.proposed_operations.find(
      (op) => op.operation === 'create_kanban_edge' && op.target_edge_key === buildGraphSyncEdgeKey('kanban:task:t_A', 'kanban:task:t_B', 'blocks'),
    );
    expect(recreateProposal).toBeDefined();
    expect(recreateProposal?.reason).toContain('linear_authoritative_apply');
  });

  it('both sides changed incompatibly -> conflict record with manual resolution options', async () => {
    const receipt1 = minimalMatchedReceipt({ runId: 'run-001' });
    const storage = emptyInMemoryStorage();
    const checkpoint1 = await createGraphSyncCheckpointFromReceipt({
      receipt: receipt1,
      previousState: null,
      storage,
      generatedAt: '2026-06-29T20:00:02.000Z',
    });
    expect(checkpoint1.ok).toBe(true);

    const stored1 = await storage.read();

    const receipt2 = buildGraphSyncReadOnlyDiffReceipt({
      workflowId: 'symphony-graph-sync-state',
      runId: 'run-002',
      generatedAt: '2026-06-29T20:05:00.000Z',
      completedAt: '2026-06-29T20:05:01.000Z',
      scope: { tracker: 'linear', kanbanBoard: 'linear' },
      nodeMappings: [
        {
          linearIssue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
          kanbanTask: { id: 't_A', status: 'done' },
        },
        {
          linearIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
          kanbanTask: { id: 't_B', status: 'blocked' },
        },
      ],
      linearRelations: [
        {
          relation: {
            id: 'rel_blocks_A_B_changed',
            type: 'blocks',
            issue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
            relatedIssue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
            createdAt: '2026-06-29T19:00:00.000Z',
            updatedAt: '2026-06-29T19:10:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
      ],
      kanbanEdges: [
        {
          parentTaskId: 't_B',
          childTaskId: 't_A',
          kind: 'blocks',
          blocking: true,
          requiredParentStatuses: ['done'],
          source: 'symphony-linear-kanban-bridge',
          createdBy: 'symphony-ts',
          metadata: { linear_relation_id: 'rel_blocks_A_B_changed' },
        },
      ],
    });

    const checkpoint2 = await createGraphSyncCheckpointFromReceipt({
      receipt: receipt2,
      previousState: stored1,
      storage,
      generatedAt: '2026-06-29T20:05:02.000Z',
    });

    expect(checkpoint2.ok).toBe(true);
    if (!checkpoint2.ok) {
      throw new Error('expected checkpoint to succeed');
    }

    const edgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks');
    const reverseEdgeKey = buildGraphSyncEdgeKey('linear:issue:lin_B', 'linear:issue:lin_A', 'blocks');
    expect(checkpoint2.ledger.edges[edgeKey]?.adoption_state).toBe('conflicted');
    expect(checkpoint2.ledger.conflicts[edgeKey]).toMatchObject({
      edge_key: edgeKey,
      changed_sides: ['linear', 'kanban'],
      severity: 'error',
      human_action_recommendation: 'human_decision_required',
    });
    expect(checkpoint2.ledger.conflicts[edgeKey]?.human_resolution_options).toContain('accept_new_linear_edge');
    expect(checkpoint2.ledger.conflicts[edgeKey]?.human_resolution_options).toContain('keep_existing_kanban_edge');
    expect(checkpoint2.ledger.edges[reverseEdgeKey]?.adoption_state).toBe('proposed');
  });

  it('foreign Kanban links remain observed and are never auto-adopted or deletable', async () => {
    const receipt = buildGraphSyncReadOnlyDiffReceipt({
      workflowId: 'symphony-graph-sync-state',
      runId: 'run-001',
      generatedAt: '2026-06-29T20:00:00.000Z',
      completedAt: '2026-06-29T20:00:01.000Z',
      scope: { tracker: 'linear', kanbanBoard: 'linear' },
      nodeMappings: [
        {
          linearIssue: { id: 'lin_A', identifier: 'HER-21', stateName: 'Done' },
          kanbanTask: { id: 't_A', status: 'done' },
        },
        {
          linearIssue: { id: 'lin_B', identifier: 'HER-22', stateName: 'Todo' },
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
          source: null,
          createdBy: 'janusz',
          metadata: {},
        },
      ],
    });

    const storage = emptyInMemoryStorage();
    const checkpoint = await createGraphSyncCheckpointFromReceipt({
      receipt,
      previousState: null,
      storage,
      generatedAt: '2026-06-29T20:00:02.000Z',
    });

    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) {
      throw new Error('expected checkpoint to succeed');
    }

    const kanbanEdgeKey = buildGraphSyncEdgeKey('kanban:task:t_A', 'kanban:task:t_B', 'blocks');
    const edge = checkpoint.ledger.edges[kanbanEdgeKey];
    expect(edge).toBeDefined();
    expect(edge?.adoption_state).toBe('observed');
    expect(edge?.kanban?.source).toBeNull();
    expect(edge?.kanban?.created_by).toBe('janusz');

    const adoptResult = adoptGraphSyncEdge({
      ledger: checkpoint.ledger,
      edgeKey: kanbanEdgeKey,
      mode: 'linear_authoritative_apply',
      approvedScope: 'test-foreign-adopt',
      runId: 'adopt-run-001',
      generatedAt: '2026-06-29T20:01:00.000Z',
    });
    expect(adoptResult.ok).toBe(false);
    if (adoptResult.ok) {
      throw new Error('expected foreign link adoption to fail');
    }
    expect(adoptResult.error).toContain('foreign');
  });

  it('adoptGraphSyncEdge requires an exact approved scope and records adoption receipt', () => {
    const ledger = minimalMatchedReceipt().ledger;
    const edgeKey = buildGraphSyncEdgeKey('linear:issue:lin_A', 'linear:issue:lin_B', 'blocks');
    const result = adoptGraphSyncEdge({
      ledger,
      edgeKey,
      mode: 'linear_authoritative_apply',
      approvedScope: 'adoption-packet-001',
      runId: 'adopt-run-001',
      generatedAt: '2026-06-29T20:01:00.000Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected adoption to succeed');
    }
    expect(result.adoption_state).toBe('adopted');
    expect(result.ledger.edges[edgeKey]?.adoption_state).toBe('adopted');
    expect(result.ledger.edges[edgeKey]?.adoption_receipts).toEqual([
      {
        run_id: 'adopt-run-001',
        mode: 'linear_authoritative_apply',
        approved_scope: 'adoption-packet-001',
        adopted_at: '2026-06-29T20:01:00.000Z',
      },
    ]);
  });

  it('createGraphSyncStateStorage reads and writes through async storage seams', async () => {
    const storage = createThrowawaySeamStorage();
    const state: GraphSyncState = {
      version: 1,
      workflow_id: 'test',
      scope: { tracker: 'linear' },
      generation: 1,
      previous_generation: null,
      generated_at: '2026-06-29T20:00:00.000Z',
      receipt_run_id: 'run-001',
      ledger: createEmptyGraphSyncLedger({ workflowId: 'test', scope: { tracker: 'linear' } }),
    };

    await storage.write(state);

    const read = await storage.read();
    expect(read?.generation).toBe(1);

    await storage.write({ ...state, generation: 2 });
    const readAfter = await storage.read();
    expect(readAfter?.generation).toBe(2);
  });

  it('createInMemoryGraphSyncStateStorage survives a read/write/read cycle', async () => {
    const storage = createInMemoryGraphSyncStateStorage();
    const state: GraphSyncState = {
      version: GRAPH_SYNC_STATE_VERSION,
      workflow_id: 'mem-test',
      scope: { tracker: 'linear' },
      generation: 1,
      previous_generation: null,
      generated_at: '2026-06-29T20:00:00.000Z',
      receipt_run_id: 'run-001',
      ledger: createEmptyGraphSyncLedger({ workflowId: 'mem-test', scope: { tracker: 'linear' } }),
    };

    await storage.write(state);
    const read = await storage.read();
    expect(read?.workflow_id).toBe('mem-test');
    expect(read?.generation).toBe(1);
  });

  it('createFileSystemGraphSyncStateStorage writes and reads JSON state atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-sync-state-storage-'));
    const statePath = join(root, 'state.json');
    const storage = createFileSystemGraphSyncStateStorage({ statePath, dryRun: false });

    const state: GraphSyncState = {
      version: GRAPH_SYNC_STATE_VERSION,
      workflow_id: 'fs-test',
      scope: { tracker: 'linear' },
      generation: 1,
      previous_generation: null,
      generated_at: '2026-06-29T20:00:00.000Z',
      receipt_run_id: 'run-001',
      ledger: createEmptyGraphSyncLedger({ workflowId: 'fs-test', scope: { tracker: 'linear' } }),
    };

    await storage.write(state);

    const storage2 = createFileSystemGraphSyncStateStorage({ statePath, dryRun: false });
    const read = await storage2.read();
    expect(read?.workflow_id).toBe('fs-test');
    expect(read?.generation).toBe(1);
    expect(read?.ledger.workflow_id).toBe('fs-test');

    await rm(root, { recursive: true, force: true });
  });

  it('createFileSystemGraphSyncStateStorage dryRun never writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-sync-state-storage-dry-'));
    const statePath = join(root, 'state.json');
    const storage = createFileSystemGraphSyncStateStorage({ statePath, dryRun: true });

    const state: GraphSyncState = {
      version: GRAPH_SYNC_STATE_VERSION,
      workflow_id: 'dry-test',
      scope: { tracker: 'linear' },
      generation: 1,
      previous_generation: null,
      generated_at: '2026-06-29T20:00:00.000Z',
      receipt_run_id: 'run-001',
      ledger: createEmptyGraphSyncLedger({ workflowId: 'dry-test', scope: { tracker: 'linear' } }),
    };

    await storage.write(state);

    const storage2 = createFileSystemGraphSyncStateStorage({ statePath, dryRun: false });
    const read = await storage2.read();
    expect(read).toBeNull();

    await rm(root, { recursive: true, force: true });
  });

  it('checkpoint refuses if previous generation does not match stored state', async () => {
    const receipt = minimalMatchedReceipt({ runId: 'run-001' });
    const storage = emptyInMemoryStorage();
    const checkpoint1 = await createGraphSyncCheckpointFromReceipt({
      receipt,
      previousState: null,
      storage,
      generatedAt: '2026-06-29T20:00:02.000Z',
    });
    expect(checkpoint1.ok).toBe(true);

    const staleState = await storage.read();
    expect(staleState).not.toBeNull();
    if (staleState === null) {
      throw new Error('expected stored state');
    }
    const tampered = { ...staleState, generation: 99 };

    const receipt2 = minimalMatchedReceipt({ runId: 'run-002', generatedAt: '2026-06-29T20:05:00.000Z', completedAt: '2026-06-29T20:05:01.000Z' });
    const checkpoint2 = await createGraphSyncCheckpointFromReceipt({
      receipt: receipt2,
      previousState: tampered,
      storage,
      generatedAt: '2026-06-29T20:05:02.000Z',
    });

    expect(checkpoint2.ok).toBe(false);
    if (checkpoint2.ok) {
      throw new Error('expected generation mismatch to fail');
    }
    expect(checkpoint2.error).toContain('generation');
  });
});
