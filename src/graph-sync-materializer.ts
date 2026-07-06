import type {
  GraphSyncCanonicalKind,
  GraphSyncMissingKanbanEdgeRecord,
  GraphSyncMissingLinearRelationRecord,
  GraphSyncReadOnlyDiffReceipt,
} from './graph-sync-ledger.js';
import type { KanbanClient, KanbanTaskDetail } from './kanban-types.js';
import type { CreateLinearIssueRelationInput, CreateLinearIssueRelationReceipt } from './tracker.js';

export type GraphSyncFakeMaterializationBoundary = 'fake_only';
export type GraphSyncLiveKanbanApplyBoundary = 'live_apply';
export type GraphSyncLiveLinearApplyBoundary = 'live_apply';

export interface MaterializeGraphSyncMissingKanbanBlockingEdgesInput {
  readonly boundary: GraphSyncFakeMaterializationBoundary;
  readonly receipt: GraphSyncReadOnlyDiffReceipt;
  readonly kanbanClient: Pick<KanbanClient, 'createTaskLink' | 'showTask'>;
}

export interface ApplyGraphSyncMissingKanbanBlockingEdgesInput {
  readonly boundary: GraphSyncLiveKanbanApplyBoundary;
  readonly receipt: GraphSyncReadOnlyDiffReceipt;
  readonly kanbanClient: Pick<KanbanClient, 'createTaskLink' | 'showTask'>;
  readonly approvedScope: string;
  readonly maxCreatedLinks: number;
}

export interface LinearRelationMutationClient {
  createIssueRelation(input: CreateLinearIssueRelationInput): Promise<CreateLinearIssueRelationReceipt>;
  hasIssueRelation(input: CreateLinearIssueRelationInput): Promise<boolean>;
}

export interface ApplyGraphSyncMissingLinearBlockingRelationsInput {
  readonly boundary: GraphSyncLiveLinearApplyBoundary;
  readonly receipt: GraphSyncReadOnlyDiffReceipt;
  readonly linearClient: Pick<LinearRelationMutationClient, 'createIssueRelation' | 'hasIssueRelation'>;
  readonly approvedScope: string;
  readonly maxCreatedRelations: number;
}

export interface GraphSyncFakeKanbanBlockingEdgeMaterializationReceipt {
  readonly ok: boolean;
  readonly effect: 'graph_sync_fake_kanban_blocking_edge_materialization';
  readonly boundary: GraphSyncFakeMaterializationBoundary;
  readonly source_receipt_run_id: string;
  readonly source_receipt_mode: GraphSyncReadOnlyDiffReceipt['mode'];
  readonly non_actions: readonly string[];
  readonly summary: GraphSyncKanbanBlockingEdgeMaterializationSummary;
  readonly created_links: readonly GraphSyncCreatedKanbanBlockingEdge[];
  readonly skipped_edges: readonly GraphSyncSkippedKanbanBlockingEdge[];
}

export interface GraphSyncLiveKanbanBlockingEdgeApplyReceipt {
  readonly ok: boolean;
  readonly effect: 'graph_sync_live_kanban_blocking_edge_apply';
  readonly mode: 'linear_authoritative_apply';
  readonly boundary: GraphSyncLiveKanbanApplyBoundary;
  readonly approved_scope: string;
  readonly source_receipt_run_id: string;
  readonly source_receipt_mode: GraphSyncReadOnlyDiffReceipt['mode'];
  readonly suppressed_writes: false;
  readonly actions: readonly string[];
  readonly non_actions: readonly string[];
  readonly safety: GraphSyncLiveKanbanBlockingEdgeApplySafety;
  readonly summary: GraphSyncKanbanBlockingEdgeMaterializationSummary;
  readonly created_links: readonly GraphSyncCreatedKanbanBlockingEdge[];
  readonly skipped_edges: readonly GraphSyncSkippedKanbanBlockingEdge[];
}

export interface GraphSyncLiveKanbanBlockingEdgeApplySafety {
  readonly max_created_links: number;
  readonly conflicts_seen: number;
  readonly cycles_seen: number;
  readonly endpoint_policies_seen: number;
}

export interface GraphSyncLiveLinearBlockingRelationApplyReceipt {
  readonly ok: boolean;
  readonly effect: 'graph_sync_live_linear_blocking_relation_apply';
  readonly mode: 'kanban_authoritative_apply';
  readonly boundary: GraphSyncLiveLinearApplyBoundary;
  readonly approved_scope: string;
  readonly source_receipt_run_id: string;
  readonly source_receipt_mode: GraphSyncReadOnlyDiffReceipt['mode'];
  readonly suppressed_writes: false;
  readonly actions: readonly string[];
  readonly non_actions: readonly string[];
  readonly safety: GraphSyncLiveLinearBlockingRelationApplySafety;
  readonly summary: GraphSyncLinearBlockingRelationApplySummary;
  readonly created_relations: readonly GraphSyncCreatedLinearBlockingRelation[];
  readonly skipped_relations: readonly GraphSyncSkippedLinearBlockingRelation[];
}

export interface GraphSyncLiveLinearBlockingRelationApplySafety {
  readonly max_created_relations: number;
  readonly conflicts_seen: number;
  readonly cycles_seen: number;
  readonly endpoint_policies_seen: number;
}

export interface GraphSyncLinearBlockingRelationApplySummary {
  readonly candidate_missing_linear_relations: number;
  readonly created_linear_relations: number;
  readonly skipped_relations: number;
  readonly readback_verified: number;
}

export interface GraphSyncCreatedLinearBlockingRelation {
  readonly kanban_edge_key: string;
  readonly linear_edge_key: string;
  readonly parent_issue_id: string;
  readonly child_issue_id: string;
  readonly relation_id: string | null;
  readonly readback_verified: boolean;
}

export interface GraphSyncSkippedLinearBlockingRelation {
  readonly kanban_edge_key: string;
  readonly expected_linear_edge_key: string;
  readonly reason:
    | 'not_blocks_relation'
    | 'unmapped_linear_endpoint'
    | 'invalid_expected_linear_edge_key'
    | 'invalid_kanban_edge_key'
    | 'relation_already_present';
}

export interface GraphSyncKanbanBlockingEdgeMaterializationSummary {
  readonly candidate_missing_kanban_edges: number;
  readonly created_kanban_edges: number;
  readonly skipped_edges: number;
  readonly readback_verified: number;
}

export interface GraphSyncCreatedKanbanBlockingEdge {
  readonly linear_edge_key: string;
  readonly kanban_edge_key: string;
  readonly parent_task_id: string;
  readonly child_task_id: string;
  readonly relation_ids: readonly string[];
  readonly readback_verified: boolean;
}

export interface GraphSyncSkippedKanbanBlockingEdge {
  readonly linear_edge_key: string;
  readonly expected_kanban_edge_key: string;
  readonly reason:
    | 'not_blocks_relation'
    | 'unmapped_kanban_endpoint'
    | 'invalid_expected_kanban_edge_key'
    | 'missing_linear_edge_record';
}

const GRAPH_SYNC_FAKE_MATERIALIZATION_NON_ACTIONS = [
  'did_not_query_linear',
  'did_not_create_update_delete_linear_relations',
  'did_not_read_or_mutate_live_hermes_kanban_board',
  'did_not_start_or_restart_services_or_timers',
  'did_not_dispatch_workers_or_gateway',
  'did_not_push_publish_deploy_or_open_pr',
] as const;

const GRAPH_SYNC_LIVE_KANBAN_APPLY_ACTIONS = [
  'created_live_hermes_kanban_blocking_links',
] as const;

const GRAPH_SYNC_LIVE_KANBAN_APPLY_NON_ACTIONS = [
  'did_not_query_linear',
  'did_not_create_update_delete_linear_relations',
  'did_not_start_or_restart_services_or_timers',
  'did_not_dispatch_workers_or_gateway',
  'did_not_use_mcp_mutation_tools',
  'did_not_push_publish_deploy_or_open_pr',
] as const;

const GRAPH_SYNC_LIVE_LINEAR_APPLY_ACTIONS = [
  'created_live_linear_blocking_relations',
] as const;

const GRAPH_SYNC_LIVE_LINEAR_APPLY_NON_ACTIONS = [
  'did_not_query_or_mutate_hermes_kanban',
  'did_not_create_update_delete_kanban_links',
  'did_not_move_linear_issue_states',
  'did_not_start_or_restart_services_or_timers',
  'did_not_dispatch_workers_or_gateway',
  'did_not_push_publish_deploy_or_open_pr',
  'did_not_expose_raw_linear_token_or_authorization_header',
] as const;

const KANBAN_TASK_CANONICAL_PREFIX = 'kanban:task:';
const LINEAR_ISSUE_CANONICAL_PREFIX = 'linear:issue:';

export async function materializeGraphSyncMissingKanbanBlockingEdges(
  input: MaterializeGraphSyncMissingKanbanBlockingEdgesInput,
): Promise<GraphSyncFakeKanbanBlockingEdgeMaterializationReceipt> {
  const result = await materializeMissingKanbanBlockingEdgesCore(input);
  return {
    ok: true,
    effect: 'graph_sync_fake_kanban_blocking_edge_materialization',
    boundary: input.boundary,
    source_receipt_run_id: input.receipt.run_id,
    source_receipt_mode: input.receipt.mode,
    non_actions: GRAPH_SYNC_FAKE_MATERIALIZATION_NON_ACTIONS,
    summary: result.summary,
    created_links: result.createdLinks,
    skipped_edges: result.skippedEdges,
  };
}

export async function applyGraphSyncMissingKanbanBlockingEdges(
  input: ApplyGraphSyncMissingKanbanBlockingEdgesInput,
): Promise<GraphSyncLiveKanbanBlockingEdgeApplyReceipt> {
  const approvedScope = input.approvedScope.trim();
  if (approvedScope === '') {
    throw new Error('approved GraphSync Kanban apply scope must be non-empty');
  }
  assertValidMaxCreatedLinks(input.maxCreatedLinks);
  assertLiveKanbanApplyPreconditions(input.receipt);

  const candidateCount = input.receipt.diff.missing_kanban_edges.filter(isMappedBlocksMissingKanbanEdge).length;
  if (candidateCount > input.maxCreatedLinks) {
    throw new Error(
      `live GraphSync Kanban apply candidate count ${String(candidateCount)} exceeds maxCreatedLinks ${String(input.maxCreatedLinks)}`,
    );
  }

  const result = await materializeMissingKanbanBlockingEdgesCore(input);
  const ok = result.summary.created_kanban_edges === result.summary.candidate_missing_kanban_edges
    && result.summary.readback_verified === result.summary.created_kanban_edges;

  return {
    ok,
    effect: 'graph_sync_live_kanban_blocking_edge_apply',
    mode: 'linear_authoritative_apply',
    boundary: input.boundary,
    approved_scope: approvedScope,
    source_receipt_run_id: input.receipt.run_id,
    source_receipt_mode: input.receipt.mode,
    suppressed_writes: false,
    actions: GRAPH_SYNC_LIVE_KANBAN_APPLY_ACTIONS,
    non_actions: GRAPH_SYNC_LIVE_KANBAN_APPLY_NON_ACTIONS,
    safety: {
      max_created_links: input.maxCreatedLinks,
      conflicts_seen: Object.keys(input.receipt.ledger.conflicts).length,
      cycles_seen: input.receipt.diff.cycles.length,
      endpoint_policies_seen: input.receipt.diff.endpoint_policies.length,
    },
    summary: result.summary,
    created_links: result.createdLinks,
    skipped_edges: result.skippedEdges,
  };
}

export async function applyGraphSyncMissingLinearBlockingRelations(
  input: ApplyGraphSyncMissingLinearBlockingRelationsInput,
): Promise<GraphSyncLiveLinearBlockingRelationApplyReceipt> {
  const approvedScope = input.approvedScope.trim();
  if (approvedScope === '') {
    throw new Error('approved GraphSync Linear apply scope must be non-empty');
  }
  assertValidMaxCreatedLinks(input.maxCreatedRelations);
  assertLiveLinearApplyPreconditions(input.receipt);

  const candidates = input.receipt.diff.missing_linear_relations
    .map((missingRelation) => ({ missingRelation, parsed: parseMappedBlocksMissingLinearRelation(missingRelation) }))
    .filter((candidate): candidate is {
      readonly missingRelation: GraphSyncMissingLinearRelationRecord;
      readonly parsed: {
        readonly parentIssueId: string;
        readonly childIssueId: string;
        readonly parentTaskId: string;
        readonly childTaskId: string;
      };
    } => candidate.parsed !== null);

  if (candidates.length > input.maxCreatedRelations) {
    throw new Error(
      `live GraphSync Linear apply candidate count ${String(candidates.length)} exceeds maxCreatedRelations ${String(input.maxCreatedRelations)}`,
    );
  }

  const createdRelations: GraphSyncCreatedLinearBlockingRelation[] = [];
  const skippedRelations: GraphSyncSkippedLinearBlockingRelation[] = [];

  for (const missingRelation of input.receipt.diff.missing_linear_relations) {
    const parsed = parseMappedBlocksMissingLinearRelation(missingRelation);
    if (parsed === null) {
      skippedRelations.push(skippedRelationForMissingLinearRelation(missingRelation));
      continue;
    }

    const relationInput: CreateLinearIssueRelationInput = {
      issueId: parsed.parentIssueId,
      relatedIssueId: parsed.childIssueId,
      type: 'blocks',
    };
    if (await input.linearClient.hasIssueRelation(relationInput)) {
      skippedRelations.push({
        kanban_edge_key: missingRelation.kanban_edge_key,
        expected_linear_edge_key: missingRelation.expected_linear_edge_key,
        reason: 'relation_already_present',
      });
      continue;
    }

    const receipt = await input.linearClient.createIssueRelation(relationInput);
    const readbackVerified = await input.linearClient.hasIssueRelation(relationInput);
    createdRelations.push({
      kanban_edge_key: missingRelation.kanban_edge_key,
      linear_edge_key: missingRelation.expected_linear_edge_key,
      parent_issue_id: parsed.parentIssueId,
      child_issue_id: parsed.childIssueId,
      relation_id: receipt.relation_id,
      readback_verified: readbackVerified,
    });
  }

  const summary: GraphSyncLinearBlockingRelationApplySummary = {
    candidate_missing_linear_relations: candidates.length,
    created_linear_relations: createdRelations.length,
    skipped_relations: skippedRelations.length,
    readback_verified: createdRelations.filter((relation) => relation.readback_verified).length,
  };
  const ok = summary.created_linear_relations === summary.candidate_missing_linear_relations
    && summary.readback_verified === summary.created_linear_relations;

  return {
    ok,
    effect: 'graph_sync_live_linear_blocking_relation_apply',
    mode: 'kanban_authoritative_apply',
    boundary: input.boundary,
    approved_scope: approvedScope,
    source_receipt_run_id: input.receipt.run_id,
    source_receipt_mode: input.receipt.mode,
    suppressed_writes: false,
    actions: GRAPH_SYNC_LIVE_LINEAR_APPLY_ACTIONS,
    non_actions: GRAPH_SYNC_LIVE_LINEAR_APPLY_NON_ACTIONS,
    safety: {
      max_created_relations: input.maxCreatedRelations,
      conflicts_seen: Object.keys(input.receipt.ledger.conflicts).length,
      cycles_seen: input.receipt.diff.cycles.length,
      endpoint_policies_seen: input.receipt.diff.endpoint_policies.length,
    },
    summary,
    created_relations: createdRelations,
    skipped_relations: skippedRelations,
  };
}

async function materializeMissingKanbanBlockingEdgesCore(input: {
  readonly receipt: GraphSyncReadOnlyDiffReceipt;
  readonly kanbanClient: Pick<KanbanClient, 'createTaskLink' | 'showTask'>;
}): Promise<{
  readonly summary: GraphSyncKanbanBlockingEdgeMaterializationSummary;
  readonly createdLinks: readonly GraphSyncCreatedKanbanBlockingEdge[];
  readonly skippedEdges: readonly GraphSyncSkippedKanbanBlockingEdge[];
}> {
  const createdLinks: GraphSyncCreatedKanbanBlockingEdge[] = [];
  const skippedEdges: GraphSyncSkippedKanbanBlockingEdge[] = [];
  const candidates = input.receipt.diff.missing_kanban_edges.filter(isMappedBlocksMissingKanbanEdge);

  for (const missingEdge of input.receipt.diff.missing_kanban_edges) {
    const parsed = parseMappedBlocksMissingKanbanEdge(missingEdge);
    if (parsed === null) {
      const skipped = skippedEdgeForMissingKanbanEdge(missingEdge);
      if (skipped !== null) {
        skippedEdges.push(skipped);
      }
      continue;
    }

    const linearEdge = input.receipt.ledger.edges[missingEdge.linear_edge_key];
    if (linearEdge?.linear === undefined) {
      skippedEdges.push({
        linear_edge_key: missingEdge.linear_edge_key,
        expected_kanban_edge_key: missingEdge.expected_kanban_edge_key,
        reason: 'missing_linear_edge_record',
      });
      continue;
    }

    const relationIds = linearEdge.linear.relation_ids;
    const metadata: Record<string, string> = {
      graph_sync_edge_key: missingEdge.linear_edge_key,
    };
    if (relationIds.length > 0) {
      metadata['linear_relation_ids'] = relationIds.join(',');
    }

    const createdLink = await input.kanbanClient.createTaskLink({
      parentId: parsed.parentTaskId,
      childId: parsed.childTaskId,
      kind: 'blocks',
      blocking: true,
      requiredParentStatuses: ['done'],
      source: 'symphony-graph-sync',
      createdBy: 'symphony-ts',
      metadata,
    });

    const detail = await input.kanbanClient.showTask(parsed.childTaskId);
    createdLinks.push({
      linear_edge_key: missingEdge.linear_edge_key,
      kanban_edge_key: missingEdge.expected_kanban_edge_key,
      parent_task_id: parsed.parentTaskId,
      child_task_id: parsed.childTaskId,
      relation_ids: relationIds,
      readback_verified: hasBlockingLinkReadback(detail, parsed.parentTaskId, parsed.childTaskId)
        || isExpectedBlockingLink(createdLink, parsed.parentTaskId, parsed.childTaskId),
    });
  }

  return {
    summary: {
      candidate_missing_kanban_edges: candidates.length,
      created_kanban_edges: createdLinks.length,
      skipped_edges: skippedEdges.length,
      readback_verified: createdLinks.filter((link) => link.readback_verified).length,
    },
    createdLinks,
    skippedEdges,
  };
}

function assertValidMaxCreatedLinks(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('maxCreatedLinks must be a positive integer');
  }
}

function assertLiveKanbanApplyPreconditions(receipt: GraphSyncReadOnlyDiffReceipt): void {
  assertLiveApplyPreconditions(receipt, 'Kanban');
}

function assertLiveLinearApplyPreconditions(receipt: GraphSyncReadOnlyDiffReceipt): void {
  assertLiveApplyPreconditions(receipt, 'Linear');
}

function assertLiveApplyPreconditions(receipt: GraphSyncReadOnlyDiffReceipt, target: 'Kanban' | 'Linear'): void {
  const runtimeReceipt = receipt as { readonly mode?: string; readonly suppressed_writes?: boolean };
  if (runtimeReceipt.mode !== 'read_only_diff' || runtimeReceipt.suppressed_writes !== true) {
    throw new Error(`live GraphSync ${target} apply requires a read_only_diff source receipt with suppressed_writes: true`);
  }
  const conflictCount = Object.keys(receipt.ledger.conflicts).length;
  if (conflictCount > 0) {
    throw new Error(`live GraphSync ${target} apply refused because source receipt has ${String(conflictCount)} conflict(s)`);
  }
  if (receipt.diff.cycles.length > 0) {
    throw new Error(`live GraphSync ${target} apply refused because source receipt has ${String(receipt.diff.cycles.length)} cycle(s)`);
  }
  if (receipt.diff.endpoint_policies.length > 0) {
    throw new Error(
      `live GraphSync ${target} apply refused because source receipt has ${String(receipt.diff.endpoint_policies.length)} endpoint policy finding(s)`,
    );
  }
}

function isMappedBlocksMissingKanbanEdge(edge: GraphSyncMissingKanbanEdgeRecord): boolean {
  return parseMappedBlocksMissingKanbanEdge(edge) !== null;
}

function parseMappedBlocksMissingKanbanEdge(
  edge: GraphSyncMissingKanbanEdgeRecord,
): { readonly parentTaskId: string; readonly childTaskId: string } | null {
  if (edge.canonical_kind !== 'blocks' || edge.expected_kanban_edge_key === 'unmapped') {
    return null;
  }
  return parseKanbanEdgeKey(edge.expected_kanban_edge_key, edge.canonical_kind);
}

function parseMappedBlocksMissingLinearRelation(
  relation: GraphSyncMissingLinearRelationRecord,
): {
  readonly parentIssueId: string;
  readonly childIssueId: string;
  readonly parentTaskId: string;
  readonly childTaskId: string;
} | null {
  if (relation.canonical_kind !== 'blocks' || relation.expected_linear_edge_key === 'unmapped') {
    return null;
  }
  const linear = parseLinearEdgeKey(relation.expected_linear_edge_key, relation.canonical_kind);
  const kanban = parseKanbanEdgeKey(relation.kanban_edge_key, relation.canonical_kind);
  if (linear === null || kanban === null) {
    return null;
  }
  return {
    parentIssueId: linear.parentIssueId,
    childIssueId: linear.childIssueId,
    parentTaskId: kanban.parentTaskId,
    childTaskId: kanban.childTaskId,
  };
}

function parseKanbanEdgeKey(
  edgeKey: string,
  kind: GraphSyncCanonicalKind,
): { readonly parentTaskId: string; readonly childTaskId: string } | null {
  const prefix = `${kind}:`;
  if (!edgeKey.startsWith(prefix)) {
    return null;
  }
  const edgeBody = edgeKey.slice(prefix.length);
  const separatorIndex = edgeBody.indexOf('->');
  if (separatorIndex < 0) {
    return null;
  }
  const predecessor = edgeBody.slice(0, separatorIndex);
  const successor = edgeBody.slice(separatorIndex + '->'.length);
  const parentTaskId = kanbanTaskIdFromCanonicalId(predecessor);
  const childTaskId = kanbanTaskIdFromCanonicalId(successor);
  if (parentTaskId === null || childTaskId === null) {
    return null;
  }
  return { parentTaskId, childTaskId };
}

function parseLinearEdgeKey(
  edgeKey: string,
  kind: GraphSyncCanonicalKind,
): { readonly parentIssueId: string; readonly childIssueId: string } | null {
  const prefix = `${kind}:`;
  if (!edgeKey.startsWith(prefix)) {
    return null;
  }
  const edgeBody = edgeKey.slice(prefix.length);
  const separatorIndex = edgeBody.indexOf('->');
  if (separatorIndex < 0) {
    return null;
  }
  const predecessor = edgeBody.slice(0, separatorIndex);
  const successor = edgeBody.slice(separatorIndex + '->'.length);
  const parentIssueId = linearIssueIdFromCanonicalId(predecessor);
  const childIssueId = linearIssueIdFromCanonicalId(successor);
  if (parentIssueId === null || childIssueId === null) {
    return null;
  }
  return { parentIssueId, childIssueId };
}

function kanbanTaskIdFromCanonicalId(canonicalId: string): string | null {
  if (!canonicalId.startsWith(KANBAN_TASK_CANONICAL_PREFIX)) {
    return null;
  }
  const taskId = canonicalId.slice(KANBAN_TASK_CANONICAL_PREFIX.length);
  return taskId.length > 0 ? taskId : null;
}

function linearIssueIdFromCanonicalId(canonicalId: string): string | null {
  if (!canonicalId.startsWith(LINEAR_ISSUE_CANONICAL_PREFIX)) {
    return null;
  }
  const issueId = canonicalId.slice(LINEAR_ISSUE_CANONICAL_PREFIX.length);
  return issueId.length > 0 ? issueId : null;
}

function skippedEdgeForMissingKanbanEdge(
  edge: GraphSyncMissingKanbanEdgeRecord,
): GraphSyncSkippedKanbanBlockingEdge | null {
  if (edge.canonical_kind !== 'blocks') {
    return {
      linear_edge_key: edge.linear_edge_key,
      expected_kanban_edge_key: edge.expected_kanban_edge_key,
      reason: 'not_blocks_relation',
    };
  }
  if (edge.expected_kanban_edge_key === 'unmapped') {
    return {
      linear_edge_key: edge.linear_edge_key,
      expected_kanban_edge_key: edge.expected_kanban_edge_key,
      reason: 'unmapped_kanban_endpoint',
    };
  }
  return {
    linear_edge_key: edge.linear_edge_key,
    expected_kanban_edge_key: edge.expected_kanban_edge_key,
    reason: 'invalid_expected_kanban_edge_key',
  };
}

function skippedRelationForMissingLinearRelation(
  relation: GraphSyncMissingLinearRelationRecord,
): GraphSyncSkippedLinearBlockingRelation {
  if (relation.canonical_kind !== 'blocks') {
    return {
      kanban_edge_key: relation.kanban_edge_key,
      expected_linear_edge_key: relation.expected_linear_edge_key,
      reason: 'not_blocks_relation',
    };
  }
  if (relation.expected_linear_edge_key === 'unmapped') {
    return {
      kanban_edge_key: relation.kanban_edge_key,
      expected_linear_edge_key: relation.expected_linear_edge_key,
      reason: 'unmapped_linear_endpoint',
    };
  }
  if (parseLinearEdgeKey(relation.expected_linear_edge_key, relation.canonical_kind) === null) {
    return {
      kanban_edge_key: relation.kanban_edge_key,
      expected_linear_edge_key: relation.expected_linear_edge_key,
      reason: 'invalid_expected_linear_edge_key',
    };
  }
  return {
    kanban_edge_key: relation.kanban_edge_key,
    expected_linear_edge_key: relation.expected_linear_edge_key,
    reason: 'invalid_kanban_edge_key',
  };
}

function hasBlockingLinkReadback(detail: KanbanTaskDetail, parentTaskId: string, childTaskId: string): boolean {
  return detail.parentLinks.some((link) => isExpectedBlockingLink(link, parentTaskId, childTaskId));
}

function isExpectedBlockingLink(link: {
  readonly parentTaskId: string;
  readonly childTaskId: string;
  readonly kind: string;
  readonly blocking: boolean;
  readonly requiredParentStatuses: readonly string[];
}, parentTaskId: string, childTaskId: string): boolean {
  return link.parentTaskId === parentTaskId
    && link.childTaskId === childTaskId
    && link.kind === 'blocks'
    && link.blocking
    && link.requiredParentStatuses.includes('done');
}
