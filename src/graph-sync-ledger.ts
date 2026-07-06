export const GRAPH_SYNC_LEDGER_VERSION = 1 as const;
export const GRAPH_SYNC_LEDGER_GENERATOR = 'symphony-linear-kanban-bridge' as const;

export type GraphSyncScopeValue = string | number | boolean | null | readonly string[];
export type GraphSyncScope = Readonly<Record<string, GraphSyncScopeValue>>;

export type GraphSyncCanonicalKind = 'blocks' | 'duplicate' | 'related' | 'similar';
export type GraphSyncEdgeSource = 'linear' | 'kanban' | 'bidirectional';
export type GraphSyncConcreteEdgeSource = Exclude<GraphSyncEdgeSource, 'bidirectional'>;
export type GraphSyncAdoptionState = 'observed' | 'adopted' | 'proposed' | 'conflicted' | 'tombstoned';
export type GraphSyncNodeKind = 'linear_issue' | 'kanban_task' | 'external_stub' | 'proposed_stub';
export type GraphSyncScopeVisibility = 'visible' | 'inaccessible' | 'outside_scope' | 'deleted_or_archived' | 'unknown';
export type GraphSyncMaterializationStatus = 'missing' | 'materialized' | 'stubbed' | 'external' | 'proposed';
export type GraphSyncDuplicateState = 'single' | 'duplicate_linear_relations' | 'duplicate_kanban_edges' | 'ambiguous';
export type GraphSyncFindingSeverity = 'info' | 'warning' | 'error';
export type GraphSyncHumanActionRecommendation =
  | 'none'
  | 'review'
  | 'inspect_endpoint_policy'
  | 'resolve_cycle'
  | 'human_decision_required';

export interface GraphSyncLedger {
  readonly version: typeof GRAPH_SYNC_LEDGER_VERSION;
  readonly generated_by: typeof GRAPH_SYNC_LEDGER_GENERATOR;
  readonly workflow_id: string;
  readonly generated_at: string;
  readonly scope: GraphSyncScope;
  readonly nodes: Readonly<Record<string, GraphSyncNodeRecord>>;
  readonly edges: Readonly<Record<string, GraphSyncEdgeRecord>>;
  readonly conflicts: Readonly<Record<string, GraphSyncConflictRecord>>;
  readonly semantic_events: Readonly<Record<string, GraphSyncSemanticEventRecord>>;
  readonly runs: readonly GraphSyncRunRecord[];
}

export interface GraphSyncNodeRecord {
  readonly canonical_id: string;
  readonly kind: GraphSyncNodeKind;
  readonly scope_visibility: GraphSyncScopeVisibility;
  readonly materialization_status: GraphSyncMaterializationStatus;
  readonly last_seen_at: string | null;
  readonly fingerprint: string;
  readonly linear_issue?: GraphSyncLinearIssueRef;
  readonly kanban_task?: GraphSyncKanbanTaskRef;
}

export interface GraphSyncLinearIssueRef {
  readonly id: string;
  readonly identifier: string | null;
  readonly state_name: string | null;
}

export interface GraphSyncKanbanTaskRef {
  readonly id: string;
  readonly status: string | null;
}

export interface GraphSyncEdgeAdoptionReceipt {
  readonly run_id: string;
  readonly mode: GraphSyncRunMode;
  readonly approved_scope: string;
  readonly adopted_at: string;
}
export interface GraphSyncEdgeRecord {
  readonly edge_key: string;
  readonly predecessor: string;
  readonly successor: string;
  readonly canonical_kind: GraphSyncCanonicalKind;
  readonly source: GraphSyncEdgeSource;
  readonly adoption_state: GraphSyncAdoptionState;
  readonly linear?: GraphSyncLinearEdgeRecord;
  readonly kanban?: GraphSyncKanbanEdgeRecord;
  readonly adapter_vocabulary?: GraphSyncAdapterVocabulary;
  readonly checkpoint_generation: number;
  readonly duplicate_state: GraphSyncDuplicateState;
  readonly tombstone: GraphSyncTombstoneRecord | null;
  readonly fingerprints: Readonly<Record<string, string>>;
  readonly adoption_receipts?: readonly GraphSyncEdgeAdoptionReceipt[];
}

export interface GraphSyncAdapterVocabulary {
  readonly blocked_by?: string;
}

export interface GraphSyncLinearEdgeRecord {
  readonly relation_ids: readonly string[];
  readonly relation_type: LinearIssueRelationType;
  readonly issue_id: string;
  readonly related_issue_id: string;
  readonly observed_from: LinearRelationObservationSource;
  readonly visibility: GraphSyncScopeVisibility;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly archived_at: string | null;
}

export interface GraphSyncKanbanEdgeRecord {
  readonly parent_task_id: string;
  readonly child_task_id: string;
  readonly kind: KanbanGraphEdgeKind;
  readonly blocking: boolean;
  readonly required_parent_statuses: readonly string[];
  readonly source: string | null;
  readonly created_by: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface GraphSyncTombstoneRecord {
  readonly tombstoned_at: string;
  readonly reason: string;
  readonly source: GraphSyncEdgeSource;
}

export type GraphSyncSemanticEventKind =
  | 'cycle'
  | 'conflict'
  | 'human_action_required'
  | 'stub_created'
  | 'edge_deleted';

export interface CreateGraphSyncConflictRecordInput {
  readonly edgeKey: string;
  readonly currentFingerprint: string;
  readonly previousFingerprint: string | null;
  readonly changedSides: readonly GraphSyncEdgeSource[];
  readonly blockedReason: string;
  readonly proposedOperations: readonly string[];
  readonly humanResolutionOptions: readonly string[];
}

export interface CreateGraphSyncTombstoneRecordInput {
  readonly tombstonedAt: string;
  readonly reason: string;
  readonly source: GraphSyncEdgeSource;
}

export interface GraphSyncConflictRecord {
  readonly conflict_key: string;
  readonly edge_key: string;
  readonly current_fingerprint: string;
  readonly previous_fingerprint: string | null;
  readonly changed_sides: readonly GraphSyncEdgeSource[];
  readonly blocked_reason: string;
  readonly proposed_operations: readonly string[];
  readonly human_resolution_options: readonly string[];
  readonly severity: GraphSyncFindingSeverity;
  readonly human_action_recommendation: GraphSyncHumanActionRecommendation;
}

export interface GraphSyncSemanticEventRecord {
  readonly event_key: string;
  readonly kind: string;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly count: number;
  readonly severity: GraphSyncFindingSeverity;
  readonly human_action_recommendation: GraphSyncHumanActionRecommendation;
  readonly edge_key?: string;
  readonly node_id?: string;
}

export type GraphSyncRunMode = 'read_only_diff' | 'linear_authoritative_apply' | 'kanban_authoritative_propose' | 'bidirectional_apply' | 'stub_automation';

export interface GraphSyncRunRecord {
  readonly run_id: string;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly mode: GraphSyncRunMode;
  readonly suppressed_writes: boolean;
  readonly edges_seen: number;
  readonly conflicts_seen: number;
}

export interface CreateEmptyGraphSyncLedgerInput {
  readonly workflowId: string;
  readonly scope: GraphSyncScope;
  readonly generatedAt?: string;
}

export type LinearIssueRelationType = 'blocks' | 'duplicate' | 'related' | 'similar';
export type LinearRelationObservationSource = 'relations' | 'inverseRelations';

export interface LinearRelationIssueSnapshot {
  readonly id: string;
  readonly identifier: string | null;
  readonly stateName: string | null;
}

export interface LinearIssueRelationSnapshot {
  readonly id: string;
  readonly type: LinearIssueRelationType;
  readonly issue: LinearRelationIssueSnapshot;
  readonly relatedIssue: LinearRelationIssueSnapshot;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly archivedAt: string | null;
}

export interface LinearRelationSnapshotToCanonicalEdgeInput {
  readonly relation: LinearIssueRelationSnapshot;
  readonly observedFrom: LinearRelationObservationSource;
  readonly anchorIssueId?: string;
}

export interface KanbanEdgeSnapshotToCanonicalEdgeInput {
  readonly parentTaskId: string;
  readonly childTaskId: string;
  readonly kind: KanbanGraphEdgeKind;
  readonly blocking: boolean;
  readonly requiredParentStatuses: readonly string[];
  readonly source: string | null;
  readonly createdBy: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export type KanbanGraphEdgeKind =
  | 'blocks'
  | 'depends_on'
  | 'depends_on_decision'
  | 'derived_from_research'
  | 'feeds'
  | 'informed_by'
  | 'related'
  | 'supersedes';

export interface GraphSyncNodeMappingSnapshot {
  readonly linearIssue: LinearRelationIssueSnapshot;
  readonly kanbanTask: GraphSyncKanbanTaskRef;
}

export interface BuildGraphSyncReadOnlyDiffReceiptInput {
  readonly workflowId: string;
  readonly runId: string;
  readonly generatedAt: string;
  readonly completedAt: string;
  readonly scope: GraphSyncScope;
  readonly nodeMappings: readonly GraphSyncNodeMappingSnapshot[];
  readonly endpointPolicyHints?: readonly GraphSyncEndpointPolicyHint[];
  readonly linearRelations: readonly LinearRelationSnapshotToCanonicalEdgeInput[];
  readonly kanbanEdges: readonly KanbanEdgeSnapshotToCanonicalEdgeInput[];
}

export interface GraphSyncReadOnlyDiffReceipt {
  readonly ok: boolean;
  readonly effect: 'graph_sync_read_only_diff';
  readonly workflow_id: string;
  readonly run_id: string;
  readonly generated_at: string;
  readonly completed_at: string;
  readonly mode: 'read_only_diff';
  readonly suppressed_writes: true;
  readonly non_actions: readonly string[];
  readonly proposed_operations: readonly GraphSyncProposedOperationRecord[];
  readonly summary: GraphSyncReadOnlyDiffSummary;
  readonly diff: GraphSyncReadOnlyDiff;
  readonly ledger: GraphSyncLedger;
}

export type GraphSyncProposedOperationKind = 'create_kanban_edge' | 'create_linear_relation';
export type GraphSyncEndpointPolicyAction = 'record_only_no_apply';
export type GraphSyncEndpointPolicyReason =
  | 'linear_edge_endpoint_missing_kanban_mapping'
  | 'kanban_edge_endpoint_missing_linear_mapping'
  | 'dependency_endpoint_deleted_or_archived'
  | 'dependency_endpoint_outside_scope'
  | 'dependency_endpoint_inaccessible';

export type GraphSyncEndpointPolicyEndpoint =
  | {
      readonly kind: 'linear_issue';
      readonly issue: LinearRelationIssueSnapshot;
    }
  | {
      readonly kind: 'kanban_task';
      readonly task: GraphSyncKanbanTaskRef;
    };

export interface GraphSyncEndpointPolicyHint {
  readonly endpoint: GraphSyncEndpointPolicyEndpoint;
  readonly scopeVisibility: GraphSyncScopeVisibility;
  readonly materializationStatus: GraphSyncMaterializationStatus;
  readonly reason: GraphSyncEndpointPolicyReason;
}

export interface GraphSyncProposedOperationRecord {
  readonly operation: GraphSyncProposedOperationKind;
  readonly source: 'linear' | 'kanban';
  readonly source_edge_key: string;
  readonly target_edge_key: string;
  readonly reason: string;
  readonly severity: GraphSyncFindingSeverity;
  readonly human_action_recommendation: GraphSyncHumanActionRecommendation;
  readonly suppressed: true;
}

export interface GraphSyncReadOnlyDiffSummary {
  readonly linear_edges_seen: number;
  readonly kanban_edges_seen: number;
  readonly matched_edges: number;
  readonly missing_kanban_edges: number;
  readonly missing_linear_relations: number;
  readonly endpoint_policies: number;
  readonly cycles_detected: number;
  readonly conflicts: number;
  readonly semantic_events: number;
}

export interface GraphSyncReadOnlyDiff {
  readonly matched_edges: readonly GraphSyncMatchedEdgeRecord[];
  readonly missing_kanban_edges: readonly GraphSyncMissingKanbanEdgeRecord[];
  readonly missing_linear_relations: readonly GraphSyncMissingLinearRelationRecord[];
  readonly endpoint_policies: readonly GraphSyncEndpointPolicyRecord[];
  readonly cycles: readonly GraphSyncCycleRecord[];
}

export interface GraphSyncEndpointPolicyRecord {
  readonly policy_key: string;
  readonly edge_key: string;
  readonly endpoint_id: string;
  readonly endpoint_kind: Extract<GraphSyncNodeKind, 'linear_issue' | 'kanban_task'>;
  readonly source: GraphSyncConcreteEdgeSource;
  readonly scope_visibility: GraphSyncScopeVisibility;
  readonly materialization_status: GraphSyncMaterializationStatus;
  readonly reason: GraphSyncEndpointPolicyReason;
  readonly policy: GraphSyncEndpointPolicyAction;
  readonly suppressed_operations: readonly GraphSyncProposedOperationKind[];
  readonly severity: GraphSyncFindingSeverity;
  readonly human_action_recommendation: GraphSyncHumanActionRecommendation;
}

export interface GraphSyncCycleRecord {
  readonly cycle_key: string;
  readonly canonical_kind: GraphSyncCanonicalKind;
  readonly node_ids: readonly string[];
  readonly edge_keys: readonly string[];
  readonly sources: readonly GraphSyncConcreteEdgeSource[];
  readonly severity: GraphSyncFindingSeverity;
  readonly human_action_recommendation: GraphSyncHumanActionRecommendation;
}

export interface GraphSyncMatchedEdgeRecord {
  readonly canonical_kind: GraphSyncCanonicalKind;
  readonly linear_edge_key: string;
  readonly kanban_edge_key: string;
}

export interface GraphSyncMissingKanbanEdgeRecord {
  readonly canonical_kind: GraphSyncCanonicalKind;
  readonly linear_edge_key: string;
  readonly expected_kanban_edge_key: string;
  readonly reason: string;
}

export interface GraphSyncMissingLinearRelationRecord {
  readonly canonical_kind: GraphSyncCanonicalKind;
  readonly kanban_edge_key: string;
  readonly expected_linear_edge_key: string;
  readonly reason: string;
}

export function createEmptyGraphSyncLedger(input: CreateEmptyGraphSyncLedgerInput): GraphSyncLedger {
  return {
    version: GRAPH_SYNC_LEDGER_VERSION,
    generated_by: GRAPH_SYNC_LEDGER_GENERATOR,
    workflow_id: input.workflowId,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    scope: input.scope,
    nodes: {},
    edges: {},
    conflicts: {},
    semantic_events: {},
    runs: [],
  };
}

export function buildGraphSyncEdgeKey(predecessor: string, successor: string, kind: GraphSyncCanonicalKind): string {
  return `${kind}:${predecessor}->${successor}`;
}

export function buildGraphSyncSemanticEventKey(kind: GraphSyncSemanticEventKind, components: readonly string[]): string {
  return [kind, ...components].join(':');
}

export function createGraphSyncConflictRecord(input: CreateGraphSyncConflictRecordInput): GraphSyncConflictRecord {
  return {
    conflict_key: buildGraphSyncSemanticEventKey('conflict', [input.edgeKey, input.currentFingerprint]),
    edge_key: input.edgeKey,
    current_fingerprint: input.currentFingerprint,
    previous_fingerprint: input.previousFingerprint,
    changed_sides: input.changedSides,
    blocked_reason: input.blockedReason,
    proposed_operations: input.proposedOperations,
    human_resolution_options: input.humanResolutionOptions,
    severity: 'error',
    human_action_recommendation: 'human_decision_required',
  };
}

export function createGraphSyncTombstoneRecord(input: CreateGraphSyncTombstoneRecordInput): GraphSyncTombstoneRecord {
  return {
    tombstoned_at: input.tombstonedAt,
    reason: input.reason,
    source: input.source,
  };
}

export function buildLinearIssueCanonicalId(issueId: string): string {
  return `linear:issue:${issueId}`;
}

export function buildKanbanTaskCanonicalId(taskId: string): string {
  return `kanban:task:${taskId}`;
}

export function linearRelationSnapshotToCanonicalEdge(input: LinearRelationSnapshotToCanonicalEdgeInput): GraphSyncEdgeRecord {
  const predecessor = buildLinearIssueCanonicalId(input.relation.issue.id);
  const successor = buildLinearIssueCanonicalId(input.relation.relatedIssue.id);
  const edgeKey = buildGraphSyncEdgeKey(predecessor, successor, input.relation.type);
  const adapterVocabulary = adapterVocabularyForLinearObservation(input, predecessor, successor);

  return {
    edge_key: edgeKey,
    predecessor,
    successor,
    canonical_kind: input.relation.type,
    source: 'linear',
    adoption_state: 'observed',
    linear: {
      relation_ids: [input.relation.id],
      relation_type: input.relation.type,
      issue_id: input.relation.issue.id,
      related_issue_id: input.relation.relatedIssue.id,
      observed_from: input.observedFrom,
      visibility: input.relation.archivedAt === null ? 'visible' : 'deleted_or_archived',
      created_at: input.relation.createdAt,
      updated_at: input.relation.updatedAt,
      archived_at: input.relation.archivedAt,
    },
    ...(adapterVocabulary === null ? {} : { adapter_vocabulary: adapterVocabulary }),
    checkpoint_generation: 0,
    duplicate_state: 'single',
    tombstone: null,
    fingerprints: {
      linear: linearRelationFingerprint(input.relation),
    },
  };
}

export function kanbanEdgeSnapshotToCanonicalEdge(input: KanbanEdgeSnapshotToCanonicalEdgeInput): GraphSyncEdgeRecord {
  const predecessor = buildKanbanTaskCanonicalId(input.parentTaskId);
  const successor = buildKanbanTaskCanonicalId(input.childTaskId);
  const canonicalKind = canonicalKindForKanbanEdge(input.kind);
  return {
    edge_key: buildGraphSyncEdgeKey(predecessor, successor, canonicalKind),
    predecessor,
    successor,
    canonical_kind: canonicalKind,
    source: 'kanban',
    adoption_state: 'observed',
    kanban: {
      parent_task_id: input.parentTaskId,
      child_task_id: input.childTaskId,
      kind: input.kind,
      blocking: input.blocking,
      required_parent_statuses: input.requiredParentStatuses,
      source: input.source,
      created_by: input.createdBy,
      metadata: input.metadata,
    },
    checkpoint_generation: 0,
    duplicate_state: 'single',
    tombstone: null,
    fingerprints: {
      kanban: kanbanEdgeFingerprint(input),
    },
  };
}

export function buildGraphSyncReadOnlyDiffReceipt(
  input: BuildGraphSyncReadOnlyDiffReceiptInput,
): GraphSyncReadOnlyDiffReceipt {
  const linearEdges = input.linearRelations.map((linearRelation) => linearRelationSnapshotToCanonicalEdge(linearRelation));
  const kanbanEdges = input.kanbanEdges.map((kanbanEdge) => kanbanEdgeSnapshotToCanonicalEdge(kanbanEdge));
  const endpointPolicyHints = input.endpointPolicyHints ?? [];
  const endpointPolicyHintsById = buildEndpointPolicyHintMap(endpointPolicyHints);
  const nodes = buildGraphSyncNodeRecords(input.nodeMappings, input.generatedAt, endpointPolicyHints);
  const edges = buildGraphSyncEdgeRecordMap([...linearEdges, ...kanbanEdges]);
  const importedEdges = Object.values(edges);
  const cycles = buildGraphSyncCycleRecords(input.nodeMappings, importedEdges);
  const semanticEvents = buildGraphSyncCycleSemanticEvents(cycles, input.generatedAt);
  const diff = buildReadOnlyDiff(
    input.nodeMappings,
    importedEdges.filter(hasLinearEdgeRecord),
    importedEdges.filter(hasKanbanEdgeRecord),
    cycles,
    endpointPolicyHintsById,
  );
  const proposedOperations = buildReadOnlyProposedOperations(diff);
  const ledger: GraphSyncLedger = {
    ...createEmptyGraphSyncLedger({
      workflowId: input.workflowId,
      scope: input.scope,
      generatedAt: input.generatedAt,
    }),
    nodes,
    edges,
    semantic_events: semanticEvents,
    runs: [
      {
        run_id: input.runId,
        started_at: input.generatedAt,
        completed_at: input.completedAt,
        mode: 'read_only_diff',
        suppressed_writes: true,
        edges_seen: linearEdges.length + kanbanEdges.length,
        conflicts_seen: 0,
      },
    ],
  };

  return {
    ok: true,
    effect: 'graph_sync_read_only_diff',
    workflow_id: input.workflowId,
    run_id: input.runId,
    generated_at: input.generatedAt,
    completed_at: input.completedAt,
    mode: 'read_only_diff',
    suppressed_writes: true,
    non_actions: graphSyncReadOnlyNonActions(),
    proposed_operations: proposedOperations,
    summary: {
      linear_edges_seen: linearEdges.length,
      kanban_edges_seen: kanbanEdges.length,
      matched_edges: diff.matched_edges.length,
      missing_kanban_edges: diff.missing_kanban_edges.length,
      missing_linear_relations: diff.missing_linear_relations.length,
      endpoint_policies: diff.endpoint_policies.length,
      cycles_detected: diff.cycles.length,
      conflicts: Object.keys(ledger.conflicts).length,
      semantic_events: Object.keys(ledger.semantic_events).length,
    },
    diff,
    ledger,
  };
}

function buildGraphSyncNodeRecords(
  nodeMappings: readonly GraphSyncNodeMappingSnapshot[],
  lastSeenAt: string,
  endpointPolicyHints: readonly GraphSyncEndpointPolicyHint[] = [],
): Readonly<Record<string, GraphSyncNodeRecord>> {
  const nodes: Record<string, GraphSyncNodeRecord> = {};
  for (const mapping of nodeMappings) {
    const linearNodeId = buildLinearIssueCanonicalId(mapping.linearIssue.id);
    const kanbanNodeId = buildKanbanTaskCanonicalId(mapping.kanbanTask.id);
    const linearIssue: GraphSyncLinearIssueRef = {
      id: mapping.linearIssue.id,
      identifier: mapping.linearIssue.identifier,
      state_name: mapping.linearIssue.stateName,
    };
    const nodeCommon = {
      scope_visibility: 'visible' as const,
      materialization_status: 'materialized' as const,
      last_seen_at: lastSeenAt,
      linear_issue: linearIssue,
      kanban_task: mapping.kanbanTask,
    };
    nodes[linearNodeId] = {
      canonical_id: linearNodeId,
      kind: 'linear_issue',
      fingerprint: nodeMappingFingerprint(linearNodeId, mapping),
      ...nodeCommon,
    };
    nodes[kanbanNodeId] = {
      canonical_id: kanbanNodeId,
      kind: 'kanban_task',
      fingerprint: nodeMappingFingerprint(kanbanNodeId, mapping),
      ...nodeCommon,
    };
  }
  for (const hint of endpointPolicyHints) {
    const node = graphSyncNodeRecordFromEndpointPolicyHint(hint, lastSeenAt);
    nodes[node.canonical_id] ??= node;
  }
  return nodes;
}

function graphSyncNodeRecordFromEndpointPolicyHint(
  hint: GraphSyncEndpointPolicyHint,
  lastSeenAt: string,
): GraphSyncNodeRecord {
  const canonicalId = canonicalIdForEndpointPolicyHint(hint);
  const common = {
    canonical_id: canonicalId,
    scope_visibility: hint.scopeVisibility,
    materialization_status: hint.materializationStatus,
    last_seen_at: lastSeenAt,
    fingerprint: endpointPolicyHintFingerprint(hint),
  };
  if (hint.endpoint.kind === 'linear_issue') {
    return {
      ...common,
      kind: 'linear_issue',
      linear_issue: {
        id: hint.endpoint.issue.id,
        identifier: hint.endpoint.issue.identifier,
        state_name: hint.endpoint.issue.stateName,
      },
    };
  }
  return {
    ...common,
    kind: 'kanban_task',
    kanban_task: hint.endpoint.task,
  };
}

function canonicalIdForEndpointPolicyHint(hint: GraphSyncEndpointPolicyHint): string {
  if (hint.endpoint.kind === 'linear_issue') {
    return buildLinearIssueCanonicalId(hint.endpoint.issue.id);
  }
  return buildKanbanTaskCanonicalId(hint.endpoint.task.id);
}

function buildEndpointPolicyHintMap(
  endpointPolicyHints: readonly GraphSyncEndpointPolicyHint[],
): ReadonlyMap<string, GraphSyncEndpointPolicyHint> {
  return new Map(endpointPolicyHints.map((hint) => [canonicalIdForEndpointPolicyHint(hint), hint]));
}

function buildGraphSyncEdgeRecordMap(
  edges: readonly GraphSyncEdgeRecord[],
): Readonly<Record<string, GraphSyncEdgeRecord>> {
  const edgeMap: Record<string, GraphSyncEdgeRecord> = {};
  for (const edge of edges) {
    const existing = edgeMap[edge.edge_key];
    edgeMap[edge.edge_key] = existing === undefined ? edge : mergeGraphSyncEdgeRecords(existing, edge);
  }
  return edgeMap;
}

function buildGraphSyncCycleSemanticEvents(
  cycles: readonly GraphSyncCycleRecord[],
  observedAt: string,
): Readonly<Record<string, GraphSyncSemanticEventRecord>> {
  const semanticEvents: Record<string, GraphSyncSemanticEventRecord> = {};
  for (const cycle of cycles) {
    semanticEvents[cycle.cycle_key] = {
      event_key: cycle.cycle_key,
      kind: 'cycle',
      first_seen_at: observedAt,
      last_seen_at: observedAt,
      count: 1,
      severity: 'error',
      human_action_recommendation: 'resolve_cycle',
    };
  }
  return semanticEvents;
}

function buildGraphSyncCycleRecords(
  nodeMappings: readonly GraphSyncNodeMappingSnapshot[],
  edges: readonly GraphSyncEdgeRecord[],
): readonly GraphSyncCycleRecord[] {
  const normalizedEdges = normalizeGraphSyncCycleEdges(nodeMappings, edges);
  const edgeByKey = new Map(normalizedEdges.map((edge) => [edge.edge_key, edge]));
  const cycleEdgePaths = detectGraphSyncCycleEdgePaths(normalizedEdges);
  const cycles: GraphSyncCycleRecord[] = [];
  for (const edgePath of cycleEdgePaths) {
    const cycleEdges = edgePath.map((edgeKey) => edgeByKey.get(edgeKey)).filter((edge): edge is GraphSyncEdgeRecord => edge !== undefined);
    cycles.push({
      cycle_key: buildGraphSyncSemanticEventKey('cycle', [edgePath.join('|')]),
      canonical_kind: 'blocks',
      node_ids: cycleNodeIds(cycleEdges),
      edge_keys: edgePath,
      sources: cycleSources(cycleEdges),
      severity: 'error',
      human_action_recommendation: 'resolve_cycle',
    });
  }
  return cycles;
}

function normalizeGraphSyncCycleEdges(
  nodeMappings: readonly GraphSyncNodeMappingSnapshot[],
  edges: readonly GraphSyncEdgeRecord[],
): readonly GraphSyncEdgeRecord[] {
  const linearIssueIdByKanbanTaskCanonicalId = new Map<string, string>();
  for (const mapping of nodeMappings) {
    linearIssueIdByKanbanTaskCanonicalId.set(
      buildKanbanTaskCanonicalId(mapping.kanbanTask.id),
      buildLinearIssueCanonicalId(mapping.linearIssue.id),
    );
  }

  const normalizedEdges = new Map<string, GraphSyncEdgeRecord>();
  for (const edge of edges) {
    if (edge.canonical_kind !== 'blocks') {
      continue;
    }
    const predecessor = linearIssueIdByKanbanTaskCanonicalId.get(edge.predecessor) ?? edge.predecessor;
    const successor = linearIssueIdByKanbanTaskCanonicalId.get(edge.successor) ?? edge.successor;
    const edgeKey = buildGraphSyncEdgeKey(predecessor, successor, edge.canonical_kind);
    const existing = normalizedEdges.get(edgeKey);
    normalizedEdges.set(edgeKey, {
      ...edge,
      edge_key: edgeKey,
      predecessor,
      successor,
      source: existing === undefined || existing.source === edge.source ? edge.source : 'bidirectional',
    });
  }
  return Array.from(normalizedEdges.values());
}

function cycleNodeIds(cycleEdges: readonly GraphSyncEdgeRecord[]): readonly string[] {
  const [firstEdge] = cycleEdges;
  if (firstEdge === undefined) {
    return [];
  }
  return [firstEdge.predecessor, ...cycleEdges.map((edge) => edge.successor)];
}

function cycleSources(cycleEdges: readonly GraphSyncEdgeRecord[]): readonly GraphSyncConcreteEdgeSource[] {
  const sources = new Set<GraphSyncConcreteEdgeSource>();
  for (const edge of cycleEdges) {
    if (edge.source === 'bidirectional') {
      sources.add('linear');
      sources.add('kanban');
      continue;
    }
    sources.add(edge.source);
  }
  return (['linear', 'kanban'] as const).filter((source) => sources.has(source));
}

function detectGraphSyncCycleEdgePaths(edges: readonly GraphSyncEdgeRecord[]): readonly (readonly string[])[] {
  const adjacency = new Map<string, { readonly successor: string; readonly edgeKey: string }[]>();
  for (const edge of edges) {
    const outgoing = adjacency.get(edge.predecessor) ?? [];
    outgoing.push({ successor: edge.successor, edgeKey: edge.edge_key });
    adjacency.set(edge.predecessor, outgoing);
  }
  for (const outgoing of adjacency.values()) {
    outgoing.sort((left, right) => left.edgeKey.localeCompare(right.edgeKey));
  }

  const cycles = new Map<string, readonly string[]>();
  const visited = new Set<string>();
  const activeNodes: string[] = [];
  const activeEdges: string[] = [];

  for (const node of Array.from(adjacency.keys()).sort()) {
    detectGraphSyncCycleEdgePathsFromNode(node, adjacency, visited, activeNodes, activeEdges, cycles);
  }

  return Array.from(cycles.values()).sort((left, right) => left.join('|').localeCompare(right.join('|')));
}

function detectGraphSyncCycleEdgePathsFromNode(
  node: string,
  adjacency: ReadonlyMap<string, readonly { readonly successor: string; readonly edgeKey: string }[]>,
  visited: Set<string>,
  activeNodes: string[],
  activeEdges: string[],
  cycles: Map<string, readonly string[]>,
): void {
  const activeIndex = activeNodes.indexOf(node);
  if (activeIndex !== -1) {
    const cycleEdges = activeEdges.slice(activeIndex);
    const cycleKey = canonicalGraphSyncCycleKey(cycleEdges);
    cycles.set(cycleKey, cycleEdges);
    return;
  }
  if (visited.has(node)) {
    return;
  }

  visited.add(node);
  activeNodes.push(node);
  for (const edge of adjacency.get(node) ?? []) {
    activeEdges.push(edge.edgeKey);
    detectGraphSyncCycleEdgePathsFromNode(edge.successor, adjacency, visited, activeNodes, activeEdges, cycles);
    activeEdges.pop();
  }
  activeNodes.pop();
}

function canonicalGraphSyncCycleKey(edgeKeys: readonly string[]): string {
  if (edgeKeys.length === 0) {
    return '';
  }
  const rotations = edgeKeys.map((_, index) => [...edgeKeys.slice(index), ...edgeKeys.slice(0, index)].join('|'));
  return rotations.sort()[0] ?? edgeKeys.join('|');
}

function hasLinearEdgeRecord(edge: GraphSyncEdgeRecord): boolean {
  return edge.linear !== undefined;
}

function hasKanbanEdgeRecord(edge: GraphSyncEdgeRecord): boolean {
  return edge.kanban !== undefined;
}

function mergeGraphSyncEdgeRecords(existing: GraphSyncEdgeRecord, incoming: GraphSyncEdgeRecord): GraphSyncEdgeRecord {
  const linear = mergeGraphSyncLinearEdgeRecords(existing.linear, incoming.linear);
  const kanban = mergeGraphSyncKanbanEdgeRecords(existing.kanban, incoming.kanban);
  return {
    ...existing,
    source: existing.source === incoming.source ? existing.source : 'bidirectional',
    ...(linear === undefined ? {} : { linear }),
    ...(kanban === undefined ? {} : { kanban }),
    duplicate_state: mergedDuplicateState(existing, incoming),
    fingerprints: {
      ...existing.fingerprints,
      ...incoming.fingerprints,
    },
  };
}

function mergeGraphSyncLinearEdgeRecords(
  existing: GraphSyncLinearEdgeRecord | undefined,
  incoming: GraphSyncLinearEdgeRecord | undefined,
): GraphSyncLinearEdgeRecord | undefined {
  if (existing === undefined) {
    return incoming;
  }
  if (incoming === undefined) {
    return existing;
  }
  return {
    ...existing,
    relation_ids: uniqueOrderedStrings([...existing.relation_ids, ...incoming.relation_ids]),
  };
}

function mergeGraphSyncKanbanEdgeRecords(
  existing: GraphSyncKanbanEdgeRecord | undefined,
  incoming: GraphSyncKanbanEdgeRecord | undefined,
): GraphSyncKanbanEdgeRecord | undefined {
  return existing ?? incoming;
}

function mergedDuplicateState(existing: GraphSyncEdgeRecord, incoming: GraphSyncEdgeRecord): GraphSyncDuplicateState {
  if (existing.linear !== undefined && incoming.linear !== undefined) {
    return 'duplicate_linear_relations';
  }
  if (existing.kanban !== undefined && incoming.kanban !== undefined) {
    return 'duplicate_kanban_edges';
  }
  if (existing.source !== incoming.source) {
    return 'ambiguous';
  }
  if (existing.duplicate_state !== 'single') {
    return existing.duplicate_state;
  }
  return incoming.duplicate_state;
}

function uniqueOrderedStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

function buildReadOnlyDiff(
  nodeMappings: readonly GraphSyncNodeMappingSnapshot[],
  linearEdges: readonly GraphSyncEdgeRecord[],
  kanbanEdges: readonly GraphSyncEdgeRecord[],
  cycles: readonly GraphSyncCycleRecord[],
  endpointPolicyHintsById: ReadonlyMap<string, GraphSyncEndpointPolicyHint>,
): GraphSyncReadOnlyDiff {
  const taskIdByLinearIssueId = new Map<string, string>();
  const linearIssueIdByTaskId = new Map<string, string>();
  for (const mapping of nodeMappings) {
    taskIdByLinearIssueId.set(mapping.linearIssue.id, mapping.kanbanTask.id);
    linearIssueIdByTaskId.set(mapping.kanbanTask.id, mapping.linearIssue.id);
  }

  const kanbanEdgeByKey = new Map(kanbanEdges.map((edge) => [edge.edge_key, edge]));
  const linearEdgeByKey = new Map(linearEdges.map((edge) => [edge.edge_key, edge]));
  const matchedKanbanEdgeKeys = new Set<string>();
  const matchedEdges: GraphSyncMatchedEdgeRecord[] = [];
  const missingKanbanEdges: GraphSyncMissingKanbanEdgeRecord[] = [];
  const missingLinearRelations: GraphSyncMissingLinearRelationRecord[] = [];
  const endpointPolicies: GraphSyncEndpointPolicyRecord[] = [];

  for (const linearEdge of linearEdges) {
    const expectedKanbanEdgeKey = expectedKanbanEdgeKeyForLinearEdge(linearEdge, taskIdByLinearIssueId);
    if (expectedKanbanEdgeKey === null) {
      missingKanbanEdges.push({
        canonical_kind: linearEdge.canonical_kind,
        linear_edge_key: linearEdge.edge_key,
        expected_kanban_edge_key: 'unmapped',
        reason: 'linear_edge_endpoint_missing_kanban_mapping',
      });
      endpointPolicies.push(...endpointPoliciesForLinearEdgeMissingKanbanMappings(linearEdge, taskIdByLinearIssueId, endpointPolicyHintsById));
      continue;
    }

    if (kanbanEdgeByKey.has(expectedKanbanEdgeKey)) {
      matchedKanbanEdgeKeys.add(expectedKanbanEdgeKey);
      matchedEdges.push({
        canonical_kind: linearEdge.canonical_kind,
        linear_edge_key: linearEdge.edge_key,
        kanban_edge_key: expectedKanbanEdgeKey,
      });
      continue;
    }

    missingKanbanEdges.push({
      canonical_kind: linearEdge.canonical_kind,
      linear_edge_key: linearEdge.edge_key,
      expected_kanban_edge_key: expectedKanbanEdgeKey,
      reason: 'linear_relation_has_no_matching_kanban_edge',
    });
  }

  for (const kanbanEdge of kanbanEdges) {
    if (matchedKanbanEdgeKeys.has(kanbanEdge.edge_key)) {
      continue;
    }

    const expectedLinearEdgeKey = expectedLinearEdgeKeyForKanbanEdge(kanbanEdge, linearIssueIdByTaskId);
    if (expectedLinearEdgeKey === null) {
      missingLinearRelations.push({
        canonical_kind: kanbanEdge.canonical_kind,
        kanban_edge_key: kanbanEdge.edge_key,
        expected_linear_edge_key: 'unmapped',
        reason: 'kanban_edge_endpoint_missing_linear_mapping',
      });
      endpointPolicies.push(...endpointPoliciesForKanbanEdgeMissingLinearMappings(kanbanEdge, linearIssueIdByTaskId, endpointPolicyHintsById));
      continue;
    }

    if (!linearEdgeByKey.has(expectedLinearEdgeKey)) {
      missingLinearRelations.push({
        canonical_kind: kanbanEdge.canonical_kind,
        kanban_edge_key: kanbanEdge.edge_key,
        expected_linear_edge_key: expectedLinearEdgeKey,
        reason: 'kanban_edge_has_no_matching_linear_relation',
      });
    }
  }

  return {
    matched_edges: matchedEdges,
    missing_kanban_edges: missingKanbanEdges,
    missing_linear_relations: missingLinearRelations,
    endpoint_policies: uniqueEndpointPolicyRecords(endpointPolicies),
    cycles,
  };
}

function endpointPoliciesForLinearEdgeMissingKanbanMappings(
  linearEdge: GraphSyncEdgeRecord,
  taskIdByLinearIssueId: ReadonlyMap<string, string>,
  endpointPolicyHintsById: ReadonlyMap<string, GraphSyncEndpointPolicyHint>,
): readonly GraphSyncEndpointPolicyRecord[] {
  const policies: GraphSyncEndpointPolicyRecord[] = [];
  const predecessorId = linearIssueIdFromCanonicalId(linearEdge.predecessor);
  const successorId = linearIssueIdFromCanonicalId(linearEdge.successor);
  if (predecessorId !== null && !taskIdByLinearIssueId.has(predecessorId)) {
    policies.push(
      createEndpointPolicyRecordWithOptionalHint(
        {
          edgeKey: linearEdge.edge_key,
          endpointId: linearEdge.predecessor,
          endpointKind: 'linear_issue',
          source: 'linear',
          reason: 'linear_edge_endpoint_missing_kanban_mapping',
          suppressedOperations: ['create_kanban_edge'],
        },
        endpointPolicyHintsById.get(linearEdge.predecessor),
      ),
    );
  }
  if (successorId !== null && !taskIdByLinearIssueId.has(successorId)) {
    policies.push(
      createEndpointPolicyRecordWithOptionalHint(
        {
          edgeKey: linearEdge.edge_key,
          endpointId: linearEdge.successor,
          endpointKind: 'linear_issue',
          source: 'linear',
          reason: 'linear_edge_endpoint_missing_kanban_mapping',
          suppressedOperations: ['create_kanban_edge'],
        },
        endpointPolicyHintsById.get(linearEdge.successor),
      ),
    );
  }
  return policies;
}

function endpointPoliciesForKanbanEdgeMissingLinearMappings(
  kanbanEdge: GraphSyncEdgeRecord,
  linearIssueIdByTaskId: ReadonlyMap<string, string>,
  endpointPolicyHintsById: ReadonlyMap<string, GraphSyncEndpointPolicyHint>,
): readonly GraphSyncEndpointPolicyRecord[] {
  const policies: GraphSyncEndpointPolicyRecord[] = [];
  const parentTaskId = kanbanTaskIdFromCanonicalId(kanbanEdge.predecessor);
  const childTaskId = kanbanTaskIdFromCanonicalId(kanbanEdge.successor);
  if (parentTaskId !== null && !linearIssueIdByTaskId.has(parentTaskId)) {
    policies.push(
      createEndpointPolicyRecordWithOptionalHint(
        {
          edgeKey: kanbanEdge.edge_key,
          endpointId: kanbanEdge.predecessor,
          endpointKind: 'kanban_task',
          source: 'kanban',
          reason: 'kanban_edge_endpoint_missing_linear_mapping',
          suppressedOperations: ['create_linear_relation'],
        },
        endpointPolicyHintsById.get(kanbanEdge.predecessor),
      ),
    );
  }
  if (childTaskId !== null && !linearIssueIdByTaskId.has(childTaskId)) {
    policies.push(
      createEndpointPolicyRecordWithOptionalHint(
        {
          edgeKey: kanbanEdge.edge_key,
          endpointId: kanbanEdge.successor,
          endpointKind: 'kanban_task',
          source: 'kanban',
          reason: 'kanban_edge_endpoint_missing_linear_mapping',
          suppressedOperations: ['create_linear_relation'],
        },
        endpointPolicyHintsById.get(kanbanEdge.successor),
      ),
    );
  }
  return policies;
}

function createEndpointPolicyRecordWithOptionalHint(
  input: Omit<Parameters<typeof createEndpointPolicyRecord>[0], 'hint'>,
  hint: GraphSyncEndpointPolicyHint | undefined,
): GraphSyncEndpointPolicyRecord {
  if (hint === undefined) {
    return createEndpointPolicyRecord(input);
  }
  return createEndpointPolicyRecord({ ...input, hint });
}

function createEndpointPolicyRecord(input: {
  readonly edgeKey: string;
  readonly endpointId: string;
  readonly endpointKind: Extract<GraphSyncNodeKind, 'linear_issue' | 'kanban_task'>;
  readonly source: GraphSyncConcreteEdgeSource;
  readonly reason: GraphSyncEndpointPolicyReason;
  readonly suppressedOperations: readonly GraphSyncProposedOperationKind[];
  readonly hint?: GraphSyncEndpointPolicyHint;
  readonly scopeVisibility?: GraphSyncScopeVisibility;
  readonly materializationStatus?: GraphSyncMaterializationStatus;
}): GraphSyncEndpointPolicyRecord {
  const reason = input.hint?.reason ?? input.reason;
  return {
    policy_key: ['endpoint_policy', input.edgeKey, input.endpointId, reason].join(':'),
    edge_key: input.edgeKey,
    endpoint_id: input.endpointId,
    endpoint_kind: input.endpointKind,
    source: input.source,
    scope_visibility: input.hint?.scopeVisibility ?? input.scopeVisibility ?? 'visible',
    materialization_status: input.hint?.materializationStatus ?? input.materializationStatus ?? 'missing',
    reason,
    policy: 'record_only_no_apply',
    suppressed_operations: input.suppressedOperations,
    severity: 'warning',
    human_action_recommendation: 'inspect_endpoint_policy',
  };
}

function uniqueEndpointPolicyRecords(
  endpointPolicies: readonly GraphSyncEndpointPolicyRecord[],
): readonly GraphSyncEndpointPolicyRecord[] {
  const policiesByKey = new Map(endpointPolicies.map((policy) => [policy.policy_key, policy]));
  return Array.from(policiesByKey.values()).sort((left, right) => left.policy_key.localeCompare(right.policy_key));
}

function buildReadOnlyProposedOperations(diff: GraphSyncReadOnlyDiff): readonly GraphSyncProposedOperationRecord[] {
  return [
    ...diff.missing_kanban_edges
      .filter((missingEdge) => missingEdge.expected_kanban_edge_key !== 'unmapped')
      .map((missingEdge): GraphSyncProposedOperationRecord => ({
        operation: 'create_kanban_edge',
        source: 'linear',
        source_edge_key: missingEdge.linear_edge_key,
        target_edge_key: missingEdge.expected_kanban_edge_key,
        reason: missingEdge.reason,
        severity: 'warning',
        human_action_recommendation: 'review',
        suppressed: true,
      })),
    ...diff.missing_linear_relations
      .filter((missingRelation) => missingRelation.expected_linear_edge_key !== 'unmapped')
      .map((missingRelation): GraphSyncProposedOperationRecord => ({
        operation: 'create_linear_relation',
        source: 'kanban',
        source_edge_key: missingRelation.kanban_edge_key,
        target_edge_key: missingRelation.expected_linear_edge_key,
        reason: missingRelation.reason,
        severity: 'warning',
        human_action_recommendation: 'review',
        suppressed: true,
      })),
  ];
}

function expectedKanbanEdgeKeyForLinearEdge(
  linearEdge: GraphSyncEdgeRecord,
  taskIdByLinearIssueId: ReadonlyMap<string, string>,
): string | null {
  const predecessorId = linearIssueIdFromCanonicalId(linearEdge.predecessor);
  const successorId = linearIssueIdFromCanonicalId(linearEdge.successor);
  if (predecessorId === null || successorId === null) {
    return null;
  }
  const parentTaskId = taskIdByLinearIssueId.get(predecessorId);
  const childTaskId = taskIdByLinearIssueId.get(successorId);
  if (parentTaskId === undefined || childTaskId === undefined) {
    return null;
  }
  return buildGraphSyncEdgeKey(buildKanbanTaskCanonicalId(parentTaskId), buildKanbanTaskCanonicalId(childTaskId), linearEdge.canonical_kind);
}

function expectedLinearEdgeKeyForKanbanEdge(
  kanbanEdge: GraphSyncEdgeRecord,
  linearIssueIdByTaskId: ReadonlyMap<string, string>,
): string | null {
  const parentTaskId = kanbanTaskIdFromCanonicalId(kanbanEdge.predecessor);
  const childTaskId = kanbanTaskIdFromCanonicalId(kanbanEdge.successor);
  if (parentTaskId === null || childTaskId === null) {
    return null;
  }
  const predecessorIssueId = linearIssueIdByTaskId.get(parentTaskId);
  const successorIssueId = linearIssueIdByTaskId.get(childTaskId);
  if (predecessorIssueId === undefined || successorIssueId === undefined) {
    return null;
  }
  return buildGraphSyncEdgeKey(
    buildLinearIssueCanonicalId(predecessorIssueId),
    buildLinearIssueCanonicalId(successorIssueId),
    kanbanEdge.canonical_kind,
  );
}

function linearIssueIdFromCanonicalId(canonicalId: string): string | null {
  const prefix = 'linear:issue:';
  return canonicalId.startsWith(prefix) ? canonicalId.slice(prefix.length) : null;
}

function kanbanTaskIdFromCanonicalId(canonicalId: string): string | null {
  const prefix = 'kanban:task:';
  return canonicalId.startsWith(prefix) ? canonicalId.slice(prefix.length) : null;
}

function graphSyncReadOnlyNonActions(): readonly string[] {
  return [
    'linear_relation_create_update_delete_suppressed',
    'kanban_link_create_update_delete_suppressed',
    'service_timer_restart_suppressed',
    'mcp_apply_surface_suppressed',
  ];
}

function nodeMappingFingerprint(canonicalId: string, mapping: GraphSyncNodeMappingSnapshot): string {
  return [
    'node-map',
    canonicalId,
    mapping.linearIssue.id,
    mapping.linearIssue.identifier ?? 'null',
    mapping.linearIssue.stateName ?? 'null',
    mapping.kanbanTask.id,
    mapping.kanbanTask.status ?? 'null',
  ].join('|');
}

function endpointPolicyHintFingerprint(hint: GraphSyncEndpointPolicyHint): string {
  const endpointParts =
    hint.endpoint.kind === 'linear_issue'
      ? [hint.endpoint.kind, hint.endpoint.issue.id, hint.endpoint.issue.identifier ?? 'null', hint.endpoint.issue.stateName ?? 'null']
      : [hint.endpoint.kind, hint.endpoint.task.id, hint.endpoint.task.status ?? 'null'];
  return ['endpoint-policy-hint', ...endpointParts, hint.scopeVisibility, hint.materializationStatus, hint.reason].join('|');
}

function canonicalKindForKanbanEdge(kind: KanbanGraphEdgeKind): GraphSyncCanonicalKind {
  switch (kind) {
    case 'blocks':
    case 'depends_on':
    case 'depends_on_decision':
      return 'blocks';
    case 'related':
      return 'related';
    case 'derived_from_research':
    case 'feeds':
    case 'informed_by':
    case 'supersedes':
      return 'related';
  }
}

function kanbanEdgeFingerprint(input: KanbanEdgeSnapshotToCanonicalEdgeInput): string {
  return [
    'kanban-edge',
    input.parentTaskId,
    input.childTaskId,
    input.kind,
    input.blocking ? 'blocking' : 'nonblocking',
    input.requiredParentStatuses.join(','),
    input.source ?? 'null',
    input.createdBy ?? 'null',
    stableMetadataFingerprint(input.metadata),
  ].join('|');
}

function stableMetadataFingerprint(metadata: Readonly<Record<string, string>>): string {
  return Object.entries(metadata)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function adapterVocabularyForLinearObservation(
  input: LinearRelationSnapshotToCanonicalEdgeInput,
  predecessor: string,
  successor: string,
): GraphSyncAdapterVocabulary | null {
  if (input.relation.type !== 'blocks' || input.observedFrom !== 'inverseRelations') {
    return null;
  }
  if (input.anchorIssueId !== undefined && buildLinearIssueCanonicalId(input.anchorIssueId) !== successor) {
    return null;
  }
  return { blocked_by: predecessor };
}

function linearRelationFingerprint(relation: LinearIssueRelationSnapshot): string {
  return [
    'linear-relation',
    relation.id,
    relation.type,
    relation.issue.id,
    relation.relatedIssue.id,
    relation.createdAt ?? 'null',
    relation.updatedAt ?? 'null',
    relation.archivedAt ?? 'null',
  ].join('|');
}
