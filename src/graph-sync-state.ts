import { createHash } from 'node:crypto';

import {
  buildGraphSyncEdgeKey,
  buildGraphSyncSemanticEventKey,
  createEmptyGraphSyncLedger,
  createGraphSyncConflictRecord,
  createGraphSyncTombstoneRecord,
  type GraphSyncAdoptionState,
  type GraphSyncConflictRecord,
  type GraphSyncEdgeRecord,
  type GraphSyncLedger,
  type GraphSyncNodeRecord,
  type GraphSyncReadOnlyDiffReceipt,
  type GraphSyncRunMode,
  type GraphSyncScopeValue,
  type GraphSyncSemanticEventRecord,
} from './graph-sync-ledger.js';

export const GRAPH_SYNC_STATE_VERSION = 1 as const;

export interface GraphSyncState {
  readonly version: typeof GRAPH_SYNC_STATE_VERSION;
  readonly workflow_id: string;
  readonly scope: Record<string, GraphSyncScopeValue>;
  readonly generation: number;
  readonly previous_generation: number | null;
  readonly generated_at: string;
  readonly receipt_run_id: string;
  readonly ledger: GraphSyncLedger;
}

export type { GraphSyncScopeValue } from './graph-sync-ledger.js';

export interface GraphSyncStateStorage {
  readonly read: () => Promise<GraphSyncState | null>;
  readonly write: (state: GraphSyncState) => Promise<void>;
}

export interface GraphSyncCheckpointReceipt {
  readonly ok: true;
  readonly state: GraphSyncState;
  readonly ledger: GraphSyncLedger;
  readonly proposed_operations: readonly ProposedOperationWithContext[];
}

export interface GraphSyncCheckpointError {
  readonly ok: false;
  readonly error: string;
  readonly state: GraphSyncState | null;
}

export type GraphSyncCheckpointResult = GraphSyncCheckpointReceipt | GraphSyncCheckpointError;

export interface CreateGraphSyncCheckpointInput {
  readonly receipt: GraphSyncReadOnlyDiffReceipt;
  readonly previousState: GraphSyncState | null;
  readonly storage: GraphSyncStateStorage;
  readonly generatedAt: string;
  readonly mode?: GraphSyncRunMode;
}

export interface ProposedOperationWithContext {
  readonly operation: 'create_kanban_edge' | 'create_linear_relation';
  readonly source: 'linear' | 'kanban';
  readonly source_edge_key: string;
  readonly target_edge_key: string;
  readonly reason: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly human_action_recommendation: 'none' | 'review' | 'inspect_endpoint_policy' | 'resolve_cycle' | 'human_decision_required';
  readonly suppressed: true;
}

export interface AdoptGraphSyncEdgeInput {
  readonly ledger: GraphSyncLedger;
  readonly edgeKey: string;
  readonly mode: GraphSyncRunMode;
  readonly approvedScope: string;
  readonly runId: string;
  readonly generatedAt: string;
}

export interface AdoptGraphSyncEdgeReceipt {
  readonly ok: true;
  readonly ledger: GraphSyncLedger;
  readonly edge_key: string;
  readonly adoption_state: GraphSyncAdoptionState;
}

export interface AdoptGraphSyncEdgeError {
  readonly ok: false;
  readonly error: string;
}

export type AdoptGraphSyncEdgeResult = AdoptGraphSyncEdgeReceipt | AdoptGraphSyncEdgeError;

export function createGraphSyncStateStorage(seams: {
  readonly read: () => Promise<object | null | undefined>;
  readonly write: (state: GraphSyncState) => Promise<void>;
}): GraphSyncStateStorage {
  return {
    read: async () => {
      const raw = await seams.read();
      if (raw === null || raw === undefined) {
        return null;
      }
      return assertGraphSyncState(raw);
    },
    write: (state: GraphSyncState) => seams.write(state),
  };
}

function assertGraphSyncState(raw: unknown): GraphSyncState {
  const record = raw as Record<string, unknown>;
  if (record['version'] !== GRAPH_SYNC_STATE_VERSION) {
    throw new Error(`GraphSyncState version ${String(record['version'])} is not supported`);
  }
  if (
    typeof record['workflow_id'] !== 'string'
    || typeof record['generation'] !== 'number'
    || typeof record['generated_at'] !== 'string'
    || typeof record['receipt_run_id'] !== 'string'
    || typeof record['ledger'] !== 'object'
    || record['ledger'] === null
  ) {
    throw new Error('GraphSyncState missing required fields');
  }
  return record as unknown as GraphSyncState;
}

export async function createGraphSyncCheckpointFromReceipt(
  input: CreateGraphSyncCheckpointInput,
): Promise<GraphSyncCheckpointResult> {
  const previous = await input.storage.read();
  if (previous !== null && input.previousState !== null && previous.generation !== input.previousState.generation) {
    return { ok: false, error: 'stored GraphSync generation has advanced; refusing stale checkpoint', state: previous };
  }

  const effectivePreviousState = input.previousState ?? previous;
  const nextGeneration = (effectivePreviousState?.generation ?? 0) + 1;
  const receiptScope = (input.receipt as unknown as Record<string, unknown>)['scope'] ?? {};
  const baseLedger: GraphSyncLedger = effectivePreviousState?.ledger ?? createEmptyGraphSyncLedger({
    workflowId: input.receipt.workflow_id,
    scope: receiptScope as GraphSyncLedger['scope'],
    generatedAt: input.generatedAt,
  });

  const { ledger, proposedOperations } = reconcileLedger({
    baseLedger,
    receipt: input.receipt,
    previousState: effectivePreviousState,
    nextGeneration,
    generatedAt: input.generatedAt,
    mode: input.mode ?? 'read_only_diff',
  });

  const state: GraphSyncState = {
    version: GRAPH_SYNC_STATE_VERSION,
    workflow_id: input.receipt.workflow_id,
    scope: { ...(receiptScope as Record<string, GraphSyncScopeValue>) },
    generation: nextGeneration,
    previous_generation: effectivePreviousState?.generation ?? null,
    generated_at: input.generatedAt,
    receipt_run_id: input.receipt.run_id,
    ledger,
  };

  await input.storage.write(state);

  return {
    ok: true,
    state,
    ledger,
    proposed_operations: proposedOperations,
  };
}

interface ReconcileLedgerResult {
  readonly ledger: GraphSyncLedger;
  readonly proposedOperations: readonly ProposedOperationWithContext[];
}

interface ReconcileLedgerInput {
  readonly baseLedger: GraphSyncLedger;
  readonly receipt: GraphSyncReadOnlyDiffReceipt;
  readonly previousState: GraphSyncState | null;
  readonly nextGeneration: number;
  readonly generatedAt: string;
  readonly mode: GraphSyncRunMode;
}

function reconcileLedger(input: ReconcileLedgerInput): ReconcileLedgerResult {
  const { receipt, baseLedger, nextGeneration, generatedAt, mode } = input;
  const incomingEdges = receipt.ledger.edges;
  const previousEdges = baseLedger.edges;

  const nodes = { ...baseLedger.nodes, ...receipt.ledger.nodes };
  const edges: Record<string, GraphSyncEdgeRecord> = {};
  const conflicts: Record<string, GraphSyncConflictRecord> = { ...baseLedger.conflicts };
  const semanticEvents: Record<string, GraphSyncSemanticEventRecord> = {};
  const proposedOperations: ProposedOperationWithContext[] = [];

  for (const [edgeKey, incomingEdge] of Object.entries(incomingEdges)) {
    const previousEdge = previousEdges[edgeKey];
    if (previousEdge === undefined) {
      edges[edgeKey] = {
        ...incomingEdge,
        checkpoint_generation: nextGeneration,
        adoption_state: inferAdoptionStateForNewEdge(incomingEdge, mode),
      };
      continue;
    }

    const incomingLinearFingerprint = incomingEdge.fingerprints['linear'];
    const previousLinearFingerprint = previousEdge.fingerprints['linear'];
    const incomingKanbanFingerprint = incomingEdge.fingerprints['kanban'];
    const previousKanbanFingerprint = previousEdge.fingerprints['kanban'];

    const linearChanged = incomingLinearFingerprint !== undefined && incomingLinearFingerprint !== previousLinearFingerprint;
    const kanbanChanged = incomingKanbanFingerprint !== undefined && incomingKanbanFingerprint !== previousKanbanFingerprint;

    if (linearChanged && kanbanChanged) {
      const conflict = createGraphSyncConflictRecord({
        edgeKey,
        currentFingerprint: incomingEdge.fingerprints['linear'] ?? incomingEdge.fingerprints['kanban'] ?? edgeKey,
        previousFingerprint: previousEdge.fingerprints['linear'] ?? previousEdge.fingerprints['kanban'] ?? edgeKey,
        changedSides: ['linear', 'kanban'],
        blockedReason: bothSidesConflict(previousEdge, incomingEdge)
          ? 'Both Linear and Kanban changed incompatibly since the last checkpoint.'
          : 'Both Linear and Kanban changed since the last checkpoint; orientation is ambiguous.',
        proposedOperations: ['suppress_apply', 'write_read_only_diff_receipt'],
        humanResolutionOptions: ['accept_new_linear_edge', 'keep_existing_kanban_edge', 'manual_conflict_resolution'],
      });
      conflicts[edgeKey] = conflict;
      edges[edgeKey] = {
        ...previousEdge,
        source: incomingEdge.source,
        adoption_state: 'conflicted',
        fingerprints: { ...previousEdge.fingerprints, ...incomingEdge.fingerprints },
      };
      semanticEvents[conflict.conflict_key] = {
        event_key: conflict.conflict_key,
        kind: 'conflict',
        first_seen_at: generatedAt,
        last_seen_at: generatedAt,
        count: 1,
        severity: 'error',
        human_action_recommendation: 'human_decision_required',
        edge_key: edgeKey,
      };
      continue;
    }

    if (linearChanged && hasLinearEdgeRecord(previousEdge) && !hasLinearEdgeRecord(incomingEdge)) {
      edges[edgeKey] = tombstoneEdge(previousEdge, 'linear', generatedAt, nextGeneration);
      const eventKey = buildGraphSyncSemanticEventKey('edge_deleted', [edgeKey, 'linear']);
      semanticEvents[eventKey] = {
        event_key: eventKey,
        kind: 'edge_deleted',
        first_seen_at: generatedAt,
        last_seen_at: generatedAt,
        count: 1,
        severity: 'warning',
        human_action_recommendation: 'review',
        edge_key: edgeKey,
      };
      continue;
    }

    if (linearChanged) {
      const orientationsDiffer =
        previousEdge.linear !== undefined
        && incomingEdge.linear !== undefined
        && previousEdge.linear.issue_id !== incomingEdge.linear.issue_id;
      if (orientationsDiffer) {
        const linearFingerprint = incomingEdge.fingerprints['linear'] ?? edgeKey;
        const conflict = createGraphSyncConflictRecord({
          edgeKey,
          currentFingerprint: linearFingerprint,
          previousFingerprint: previousEdge.fingerprints['linear'] ?? edgeKey,
          changedSides: ['linear'],
          blockedReason: 'Linear relation orientation changed since last checkpoint.',
          proposedOperations: ['suppress_apply', 'write_read_only_diff_receipt'],
          humanResolutionOptions: ['accept_new_linear_edge', 'keep_existing_kanban_edge'],
        });
        conflicts[edgeKey] = conflict;
        edges[edgeKey] = {
          ...previousEdge,
          source: incomingEdge.source,
          adoption_state: 'conflicted',
          fingerprints: { ...previousEdge.fingerprints, linear: linearFingerprint },
        };
        const oldEdgeKey = previousEdge.edge_key;
        if (oldEdgeKey !== edgeKey) {
          edges[oldEdgeKey] = tombstoneEdge(previousEdge, 'linear', generatedAt, nextGeneration);
        }
        const newReverseEdge = {
          ...incomingEdge,
          checkpoint_generation: nextGeneration,
          adoption_state: inferAdoptionStateForNewEdge(incomingEdge, mode),
        };
        edges[incomingEdge.edge_key] = newReverseEdge;
        semanticEvents[conflict.conflict_key] = {
          event_key: conflict.conflict_key,
          kind: 'conflict',
          first_seen_at: generatedAt,
          last_seen_at: generatedAt,
          count: 1,
          severity: 'error',
          human_action_recommendation: 'human_decision_required',
          edge_key: edgeKey,
        };
        continue;
      }
    }

    if (kanbanChanged && hasKanbanEdgeRecord(previousEdge) && !hasKanbanEdgeRecord(incomingEdge)) {
      const proposedKey = buildExpectedKanbanEdgeKey(previousEdge, baseLedger.nodes);
      const isAdoptedLinearEdge = previousEdge.adoption_state === 'adopted' && previousEdge.source !== 'kanban';
      if (mode === 'linear_authoritative_apply' && isAdoptedLinearEdge && proposedKey !== null) {
        proposedOperations.push({
          operation: 'create_kanban_edge',
          source: 'linear',
          source_edge_key: edgeKey,
          target_edge_key: proposedKey,
          reason: 'adopted Linear edge no longer observed in Kanban under linear_authoritative_apply',
          severity: 'warning',
          human_action_recommendation: 'review',
          suppressed: true,
        });
      }
      edges[edgeKey] = tombstoneEdge(previousEdge, 'kanban', generatedAt, nextGeneration);
      const eventKey = buildGraphSyncSemanticEventKey('edge_deleted', [edgeKey, 'kanban']);
      semanticEvents[eventKey] = {
        event_key: eventKey,
        kind: 'edge_deleted',
        first_seen_at: generatedAt,
        last_seen_at: generatedAt,
        count: 1,
        severity: 'warning',
        human_action_recommendation: 'review',
        edge_key: edgeKey,
      };
      continue;
    }

    edges[edgeKey] = {
      ...previousEdge,
      ...(previousEdge.checkpoint_generation === 0 ? { checkpoint_generation: nextGeneration } : {}),
      fingerprints: { ...previousEdge.fingerprints, ...incomingEdge.fingerprints },
      source: mergeSources(previousEdge.source, incomingEdge.source),
      adoption_state: stabilizeAdoptionState(previousEdge.adoption_state),
      ...(incomingEdge.tombstone === null ? {} : { tombstone: incomingEdge.tombstone }),
    };
  }

  for (const [edgeKey, previousEdge] of Object.entries(previousEdges)) {
    if (edges[edgeKey] !== undefined) {
      continue;
    }
    if (previousEdge.adoption_state === 'tombstoned') {
      edges[edgeKey] = previousEdge;
      continue;
    }
    const reversedLinearIncomingEdge = findIncomingLinearOrientationFlip(previousEdge, incomingEdges);
    const previousKanbanEdgeKey = buildExpectedKanbanEdgeKey(previousEdge, baseLedger.nodes);
    const previousKanbanEdge = previousKanbanEdgeKey === null ? undefined : previousEdges[previousKanbanEdgeKey];
    const reversedKanbanIncomingEdge = previousKanbanEdge === undefined
      ? undefined
      : findIncomingKanbanOrientationFlip(previousKanbanEdge, incomingEdges);
    if (reversedLinearIncomingEdge !== undefined && reversedKanbanIncomingEdge !== undefined) {
      const conflict = createGraphSyncConflictRecord({
        edgeKey,
        currentFingerprint: reversedLinearIncomingEdge.fingerprints['linear'] ?? reversedKanbanIncomingEdge.fingerprints['kanban'] ?? reversedLinearIncomingEdge.edge_key,
        previousFingerprint: previousEdge.fingerprints['linear'] ?? previousEdge.fingerprints['kanban'] ?? edgeKey,
        changedSides: ['linear', 'kanban'],
        blockedReason: 'Both Linear and Kanban reversed orientation since the last checkpoint.',
        proposedOperations: ['suppress_apply', 'write_read_only_diff_receipt'],
        humanResolutionOptions: ['accept_new_linear_edge', 'keep_existing_kanban_edge', 'manual_conflict_resolution'],
      });
      conflicts[edgeKey] = conflict;
      edges[edgeKey] = {
        ...previousEdge,
        source: mergeSources(previousEdge.source, mergeSources(reversedLinearIncomingEdge.source, reversedKanbanIncomingEdge.source)),
        checkpoint_generation: nextGeneration,
        adoption_state: 'conflicted',
        fingerprints: { ...previousEdge.fingerprints, ...reversedLinearIncomingEdge.fingerprints, ...reversedKanbanIncomingEdge.fingerprints },
      };
      edges[reversedLinearIncomingEdge.edge_key] = {
        ...(edges[reversedLinearIncomingEdge.edge_key] ?? reversedLinearIncomingEdge),
        checkpoint_generation: nextGeneration,
        adoption_state: 'proposed',
      };
      semanticEvents[conflict.conflict_key] = {
        event_key: conflict.conflict_key,
        kind: 'conflict',
        first_seen_at: generatedAt,
        last_seen_at: generatedAt,
        count: 1,
        severity: 'error',
        human_action_recommendation: 'human_decision_required',
        edge_key: edgeKey,
      };
      continue;
    }
    if (previousEdge.adoption_state === 'adopted' && previousEdge.source === 'kanban') {
      edges[edgeKey] = tombstoneEdge(previousEdge, 'kanban', generatedAt, nextGeneration);
      continue;
    }
    if (previousEdge.adoption_state === 'adopted' && mode === 'linear_authoritative_apply') {
      const proposedKey = buildExpectedKanbanEdgeKey(previousEdge, baseLedger.nodes);
      if (proposedKey !== null) {
        proposedOperations.push({
          operation: 'create_kanban_edge',
          source: 'linear',
          source_edge_key: edgeKey,
          target_edge_key: proposedKey,
          reason: 'adopted Linear edge no longer observed in Kanban under linear_authoritative_apply',
          severity: 'warning',
          human_action_recommendation: 'review',
          suppressed: true,
        });
      }
      edges[edgeKey] = {
        ...previousEdge,
        checkpoint_generation: nextGeneration,
        adoption_state: 'proposed',
      };
      continue;
    }
    const source: 'linear' | 'kanban' = previousEdge.source === 'kanban' ? 'kanban' : 'linear';
    edges[edgeKey] = {
      ...previousEdge,
      checkpoint_generation: nextGeneration,
      adoption_state: 'tombstoned',
      tombstone: createGraphSyncTombstoneRecord({
        tombstonedAt: generatedAt,
        reason: 'edge no longer observed in either side; pending checkpoint confirmation',
        source,
      }),
    };
  }

  const ledger: GraphSyncLedger = {
    ...baseLedger,
    nodes,
    edges,
    conflicts,
    semantic_events: semanticEvents,
    runs: [
      ...baseLedger.runs,
      {
        run_id: receipt.run_id,
        started_at: receipt.generated_at,
        completed_at: receipt.completed_at,
        mode: receipt.mode,
        suppressed_writes: true,
        edges_seen: receipt.summary.linear_edges_seen + receipt.summary.kanban_edges_seen,
        conflicts_seen: Object.keys(conflicts).length,
      },
    ],
  };

  return { ledger, proposedOperations };
}

function inferAdoptionStateForNewEdge(edge: GraphSyncEdgeRecord, mode: GraphSyncRunMode): GraphSyncAdoptionState {
  if (mode === 'read_only_diff') {
    return 'observed';
  }
  if ((mode === 'linear_authoritative_apply' || mode === 'bidirectional_apply' || mode === 'stub_automation') && edge.source === 'linear') {
    return 'proposed';
  }
  if ((mode === 'bidirectional_apply' || mode === 'stub_automation') && edge.source === 'kanban') {
    return 'proposed';
  }
  return 'observed';
}

function bothSidesConflict(previousEdge: GraphSyncEdgeRecord, incomingEdge: GraphSyncEdgeRecord): boolean {
  return linearOrientationFlipped(previousEdge, incomingEdge) && kanbanOrientationFlipped(previousEdge, incomingEdge);
}

function linearOrientationFlipped(previousEdge: GraphSyncEdgeRecord, incomingEdge: GraphSyncEdgeRecord): boolean {
  const previousLinear = previousEdge.linear;
  const incomingLinear = incomingEdge.linear;
  if (previousLinear === undefined || incomingLinear === undefined) {
    return false;
  }
  return previousLinear.issue_id === incomingLinear.related_issue_id
    && previousLinear.related_issue_id === incomingLinear.issue_id;
}

function kanbanOrientationFlipped(previousEdge: GraphSyncEdgeRecord, incomingEdge: GraphSyncEdgeRecord): boolean {
  const previousKanban = previousEdge.kanban;
  const incomingKanban = incomingEdge.kanban;
  if (previousKanban === undefined || incomingKanban === undefined) {
    return false;
  }
  return previousKanban.parent_task_id === incomingKanban.child_task_id
    && previousKanban.child_task_id === incomingKanban.parent_task_id;
}

function findIncomingLinearOrientationFlip(
  previousEdge: GraphSyncEdgeRecord,
  incomingEdges: Readonly<Record<string, GraphSyncEdgeRecord>>,
): GraphSyncEdgeRecord | undefined {
  return Object.values(incomingEdges).find((incomingEdge) => linearOrientationFlipped(previousEdge, incomingEdge));
}

function findIncomingKanbanOrientationFlip(
  previousEdge: GraphSyncEdgeRecord,
  incomingEdges: Readonly<Record<string, GraphSyncEdgeRecord>>,
): GraphSyncEdgeRecord | undefined {
  return Object.values(incomingEdges).find((incomingEdge) => kanbanOrientationFlipped(previousEdge, incomingEdge));
}

function hasLinearEdgeRecord(edge: GraphSyncEdgeRecord): boolean {
  return edge.linear !== undefined;
}

function hasKanbanEdgeRecord(edge: GraphSyncEdgeRecord): boolean {
  return edge.kanban !== undefined;
}

function tombstoneEdge(
  edge: GraphSyncEdgeRecord,
  source: 'linear' | 'kanban',
  generatedAt: string,
  nextGeneration: number,
): GraphSyncEdgeRecord {
  return {
    ...edge,
    checkpoint_generation: nextGeneration,
    adoption_state: 'tombstoned',
    tombstone: createGraphSyncTombstoneRecord({
      tombstonedAt: generatedAt,
      reason: `${source} side no longer observed in a single snapshot; pending checkpoint confirmation`,
      source,
    }),
  };
}

function buildExpectedKanbanEdgeKey(
  edge: GraphSyncEdgeRecord,
  nodes: Readonly<Record<string, GraphSyncNodeRecord>>,
): string | null {
  const kanban = edge.kanban;
  if (kanban !== undefined) {
    return buildGraphSyncEdgeKey(
      buildKanbanTaskCanonicalId(kanban.parent_task_id),
      buildKanbanTaskCanonicalId(kanban.child_task_id),
      edge.canonical_kind,
    );
  }
  const linear = edge.linear;
  if (linear === undefined) {
    return null;
  }
  const parentTaskId = findMappedKanbanTaskId(nodes, linear.issue_id);
  const childTaskId = findMappedKanbanTaskId(nodes, linear.related_issue_id);
  if (parentTaskId === null || childTaskId === null) {
    return null;
  }
  return buildGraphSyncEdgeKey(
    buildKanbanTaskCanonicalId(parentTaskId),
    buildKanbanTaskCanonicalId(childTaskId),
    edge.canonical_kind,
  );
}

function findMappedKanbanTaskId(
  nodes: Readonly<Record<string, GraphSyncNodeRecord>>,
  linearIssueId: string,
): string | null {
  for (const node of Object.values(nodes)) {
    if (node.linear_issue?.id === linearIssueId && node.kanban_task !== undefined) {
      return node.kanban_task.id;
    }
  }
  return null;
}

function buildKanbanTaskCanonicalId(taskId: string): string {
  return `kanban:task:${taskId}`;
}

function mergeSources(left: 'linear' | 'kanban' | 'bidirectional', right: 'linear' | 'kanban' | 'bidirectional'): 'linear' | 'kanban' | 'bidirectional' {
  if (left === right) {
    return left;
  }
  return 'bidirectional';
}

function stabilizeAdoptionState(state: GraphSyncAdoptionState): GraphSyncAdoptionState {
  if (state === 'proposed') {
    return 'observed';
  }
  if (state === 'tombstoned') {
    return 'tombstoned';
  }
  return state;
}

export function adoptGraphSyncEdge(input: AdoptGraphSyncEdgeInput): AdoptGraphSyncEdgeResult {
  const { ledger, edgeKey, mode, approvedScope, runId, generatedAt } = input;
  const edge = ledger.edges[edgeKey];
  if (edge === undefined) {
    return { ok: false, error: `edge ${edgeKey} not found` };
  }
  if (edge.adoption_state === 'adopted') {
    return { ok: false, error: `edge ${edgeKey} is already adopted` };
  }
  if (edge.adoption_state === 'conflicted' || edge.adoption_state === 'tombstoned') {
    return { ok: false, error: `edge ${edgeKey} cannot be adopted while ${edge.adoption_state}` };
  }
  if (edge.kanban !== undefined && (edge.kanban.source === null || edge.kanban.source !== 'symphony-linear-kanban-bridge')) {
    const createdByBridge = edge.kanban.created_by === 'symphony-ts';
    if (!createdByBridge) {
      return { ok: false, error: `edge ${edgeKey} is foreign and cannot be adopted automatically` };
    }
  }

  const adoptionReceipt = {
    run_id: runId,
    mode,
    approved_scope: approvedScope,
    adopted_at: generatedAt,
  };

  const updatedEdge: GraphSyncEdgeRecord = {
    ...edge,
    adoption_state: 'adopted',
    adoption_receipts: [...(edge.adoption_receipts ?? []), adoptionReceipt],
  };

  return {
    ok: true,
    ledger: {
      ...ledger,
      edges: { ...ledger.edges, [edgeKey]: updatedEdge },
    },
    edge_key: edgeKey,
    adoption_state: 'adopted',
  };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}