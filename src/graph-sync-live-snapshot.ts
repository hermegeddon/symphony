import type { Issue } from './domain.js';
import {
  buildGraphSyncReadOnlyDiffReceipt,
  type GraphSyncReadOnlyDiffReceipt,
  type GraphSyncScope,
} from './graph-sync-ledger.js';
import {
  buildGraphSyncReadOnlySnapshotFromObservedGraph,
  type BuildGraphSyncReadOnlySnapshotFromObservedGraphInput,
  type GraphSyncObservedNodeMapping,
} from './graph-sync-snapshot-importer.js';
import {
  createGraphSyncCheckpointFromReceipt,
  type GraphSyncCheckpointReceipt,
  type GraphSyncStateStorage,
} from './graph-sync-state.js';
import { createInMemoryGraphSyncStateStorage } from './graph-sync-state-storage.js';
import type { KanbanTaskDetail } from './kanban-types.js';

export interface GraphSyncLinearGraphReader {
  readIssuesWithRelations(
    scope: GraphSyncScope,
    mappings?: readonly GraphSyncObservedNodeMapping[],
  ): Promise<readonly Issue[]>;
}

export interface GraphSyncKanbanGraphReader {
  readTaskDetails(taskIds: readonly string[]): Promise<readonly KanbanTaskDetail[]>;
}

export interface GraphSyncMappingReader {
  readMappings(scope: GraphSyncScope): Promise<readonly GraphSyncObservedNodeMapping[]>;
}

export type GraphSyncSnapshotObservationStatus = 'complete' | 'partial' | 'truncated' | 'failed';

export interface GraphSyncSnapshotCompleteness {
  readonly linear_issues: GraphSyncSnapshotObservationStatus;
  readonly linear_relations: GraphSyncSnapshotObservationStatus;
  readonly linear_inverse_relations: GraphSyncSnapshotObservationStatus;
  readonly dependency_closure: GraphSyncSnapshotObservationStatus;
  readonly kanban_tasks: GraphSyncSnapshotObservationStatus;
  readonly kanban_links: GraphSyncSnapshotObservationStatus;
  readonly max_nodes_reached: boolean;
  readonly max_depth_reached: boolean;
  readonly max_pages_reached: boolean;
  readonly inaccessible_or_deleted_endpoint_count: number;
  readonly archived_endpoint_count: number;
  readonly reader_errors: readonly string[];
  readonly rate_limited: boolean;
  readonly apply_eligible: boolean;
}

export interface GraphSyncObservedSnapshot {
  readonly runId: string;
  readonly scope: GraphSyncScope;
  readonly completeness: GraphSyncSnapshotCompleteness;
  readonly issues: readonly Issue[];
  readonly kanbanTasks: readonly KanbanTaskDetail[];
  readonly nodeMappings: readonly GraphSyncObservedNodeMapping[];
  readonly non_actions: readonly string[];
}

export interface GraphSyncSnapshotCaptureResult {
  readonly ok: true;
  readonly effect: 'graph_sync_read_only_snapshot_capture';
  readonly status: 'PASS' | 'REVIEW' | 'BLOCK';
  readonly workflow_id: string;
  readonly run_id: string;
  readonly generated_at: string;
  readonly completed_at: string;
  readonly mode: 'read_only_snapshot';
  readonly suppressed_writes: true;
  readonly snapshot: GraphSyncObservedSnapshot;
  readonly receipt: GraphSyncReadOnlyDiffReceipt;
  readonly checkpoint: GraphSyncCheckpointReceipt | null;
  readonly checkpoint_state_path: 'memory' | 'injected';
  readonly summary: GraphSyncSnapshotSummary;
  readonly non_actions: readonly string[];
}

export interface GraphSyncSnapshotSummary {
  readonly linear_issues_read: number;
  readonly kanban_tasks_read: number;
  readonly mappings_resolved: number;
  readonly linear_edges_seen: number;
  readonly kanban_edges_seen: number;
  readonly matched_edges: number;
  readonly missing_kanban_edges: number;
  readonly missing_linear_relations: number;
  readonly endpoint_policies: number;
  readonly cycles_detected: number;
  readonly proposed_operations: number;
}

export interface CaptureGraphSyncReadOnlySnapshotInput {
  readonly workflowId: string;
  readonly runId: string;
  readonly scope: GraphSyncScope;
  readonly linearReader: GraphSyncLinearGraphReader;
  readonly kanbanReader: GraphSyncKanbanGraphReader;
  readonly mappingReader: GraphSyncMappingReader;
  readonly stateStorage?: GraphSyncStateStorage | undefined;
  readonly now?: Date | undefined;
}

export interface GraphSyncSnapshotCaptureError {
  readonly ok: false;
  readonly effect: 'graph_sync_read_only_snapshot_capture';
  readonly status: 'BLOCK';
  readonly workflow_id: string;
  readonly run_id: string;
  readonly generated_at: string;
  readonly completed_at: string;
  readonly mode: 'read_only_snapshot';
  readonly suppressed_writes: true;
  readonly error: string;
  readonly non_actions: readonly string[];
}

export type CaptureGraphSyncReadOnlySnapshotResult = GraphSyncSnapshotCaptureResult | GraphSyncSnapshotCaptureError;

export async function captureGraphSyncReadOnlySnapshot(
  input: CaptureGraphSyncReadOnlySnapshotInput,
): Promise<CaptureGraphSyncReadOnlySnapshotResult> {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const nonActions = graphSyncSnapshotNonActions();

  const mappingReadResult = await readMappingsSafely(input.mappingReader, input.scope);
  if (!mappingReadResult.ok) {
    return buildSnapshotCaptureError(input, generatedAt, now, mappingReadResult.error, nonActions);
  }
  const mappings = mappingReadResult.mappings;

  const linearReadResult = await readLinearIssuesSafely(input.linearReader, input.scope, mappings);
  if (!linearReadResult.ok) {
    return buildSnapshotCaptureError(input, generatedAt, now, linearReadResult.error, nonActions);
  }
  const issues = linearReadResult.issues;

  const kanbanReadResult = await readKanbanTasksSafely(input.kanbanReader, mappings);
  if (!kanbanReadResult.ok) {
    return buildSnapshotCaptureError(input, generatedAt, now, kanbanReadResult.error, nonActions);
  }
  const kanbanTasks = kanbanReadResult.tasks;

  const completeness = buildCompleteness({
    linearOk: linearReadResult.complete,
    mappingOk: mappingReadResult.complete,
    kanbanOk: kanbanReadResult.complete,
    linearErrors: linearReadResult.errors,
    kanbanErrors: kanbanReadResult.errors,
    issueCount: issues.length,
    taskCount: kanbanTasks.length,
    mappingCount: mappings.length,
  });

  const snapshotInput: BuildGraphSyncReadOnlySnapshotFromObservedGraphInput = {
    workflowId: input.workflowId,
    runId: input.runId,
    generatedAt,
    completedAt: now.toISOString(),
    scope: input.scope,
    issues,
    kanbanTasks,
    nodeMappings: mappings,
  };
  const importerInput = buildGraphSyncReadOnlySnapshotFromObservedGraph(snapshotInput);
  const receipt = buildGraphSyncReadOnlyDiffReceipt(importerInput);
  const stateStorage = input.stateStorage ?? createInMemoryGraphSyncStateStorage();
  const checkpointResult = await createGraphSyncCheckpointFromReceipt({
    receipt,
    previousState: null,
    storage: stateStorage,
    generatedAt,
    mode: 'read_only_diff',
  });
  const checkpoint = checkpointResult.ok ? checkpointResult : null;

  const snapshot: GraphSyncObservedSnapshot = {
    runId: input.runId,
    scope: input.scope,
    completeness,
    issues,
    kanbanTasks,
    nodeMappings: mappings,
    non_actions: nonActions,
  };

  return {
    ok: true,
    effect: 'graph_sync_read_only_snapshot_capture',
    status: classifySnapshotStatus(receipt, completeness),
    workflow_id: input.workflowId,
    run_id: input.runId,
    generated_at: generatedAt,
    completed_at: now.toISOString(),
    mode: 'read_only_snapshot',
    suppressed_writes: true,
    snapshot,
    receipt,
    checkpoint,
    checkpoint_state_path: input.stateStorage === undefined ? 'memory' : 'injected',
    summary: buildSnapshotSummary(receipt, snapshot),
    non_actions: nonActions,
  };
}

interface SafeReadLinearResult {
  readonly ok: true;
  readonly issues: readonly Issue[];
  readonly complete: boolean;
  readonly errors: readonly string[];
}

interface SafeReadLinearError {
  readonly ok: false;
  readonly error: string;
}

type SafeReadLinearOutcome = SafeReadLinearResult | SafeReadLinearError;

async function readLinearIssuesSafely(
  reader: GraphSyncLinearGraphReader,
  scope: GraphSyncScope,
  mappings: readonly GraphSyncObservedNodeMapping[],
): Promise<SafeReadLinearOutcome> {
  try {
    const issues = await reader.readIssuesWithRelations(scope, mappings);
    return { ok: true, issues, complete: true, errors: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Linear graph read failed: ${message}` };
  }
}

interface SafeReadMappingsResult {
  readonly ok: true;
  readonly mappings: readonly GraphSyncObservedNodeMapping[];
  readonly complete: boolean;
  readonly errors: readonly string[];
}

interface SafeReadMappingsError {
  readonly ok: false;
  readonly error: string;
}

type SafeReadMappingsOutcome = SafeReadMappingsResult | SafeReadMappingsError;

async function readMappingsSafely(
  reader: GraphSyncMappingReader,
  scope: GraphSyncScope,
): Promise<SafeReadMappingsOutcome> {
  try {
    const mappings = await reader.readMappings(scope);
    return { ok: true, mappings, complete: true, errors: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Mapping read failed: ${message}` };
  }
}

interface SafeReadKanbanResult {
  readonly ok: true;
  readonly tasks: readonly KanbanTaskDetail[];
  readonly complete: boolean;
  readonly errors: readonly string[];
}

interface SafeReadKanbanError {
  readonly ok: false;
  readonly error: string;
}

type SafeReadKanbanOutcome = SafeReadKanbanResult | SafeReadKanbanError;

async function readKanbanTasksSafely(
  reader: GraphSyncKanbanGraphReader,
  mappings: readonly GraphSyncObservedNodeMapping[],
): Promise<SafeReadKanbanOutcome> {
  const taskIds = mappings.map((mapping) => mapping.kanbanTaskId);
  if (taskIds.length === 0) {
    return { ok: true, tasks: [], complete: true, errors: [] };
  }
  try {
    const tasks = await reader.readTaskDetails(taskIds);
    return { ok: true, tasks, complete: true, errors: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Kanban graph read failed: ${message}` };
  }
}

function buildCompleteness(input: {
  readonly linearOk: boolean;
  readonly mappingOk: boolean;
  readonly kanbanOk: boolean;
  readonly linearErrors: readonly string[];
  readonly kanbanErrors: readonly string[];
  readonly issueCount: number;
  readonly taskCount: number;
  readonly mappingCount: number;
}): GraphSyncSnapshotCompleteness {
  const allOk = input.linearOk && input.mappingOk && input.kanbanOk;
  const anyError = input.linearErrors.length > 0 || input.kanbanErrors.length > 0;
  const applyEligible = allOk && !anyError;

  const statusFor = (ok: boolean): GraphSyncSnapshotObservationStatus => {
    if (!ok) return 'failed';
    return 'complete';
  };

  return {
    linear_issues: statusFor(input.linearOk),
    linear_relations: statusFor(input.linearOk),
    linear_inverse_relations: statusFor(input.linearOk),
    dependency_closure: statusFor(input.linearOk),
    kanban_tasks: statusFor(input.kanbanOk),
    kanban_links: statusFor(input.kanbanOk),
    max_nodes_reached: false,
    max_depth_reached: false,
    max_pages_reached: false,
    inaccessible_or_deleted_endpoint_count: 0,
    archived_endpoint_count: 0,
    reader_errors: [...input.linearErrors, ...input.kanbanErrors],
    rate_limited: false,
    apply_eligible: applyEligible,
  };
}

function buildSnapshotSummary(
  receipt: GraphSyncReadOnlyDiffReceipt,
  snapshot: GraphSyncObservedSnapshot,
): GraphSyncSnapshotSummary {
  return {
    linear_issues_read: snapshot.issues.length,
    kanban_tasks_read: snapshot.kanbanTasks.length,
    mappings_resolved: snapshot.nodeMappings.length,
    linear_edges_seen: receipt.summary.linear_edges_seen,
    kanban_edges_seen: receipt.summary.kanban_edges_seen,
    matched_edges: receipt.summary.matched_edges,
    missing_kanban_edges: receipt.summary.missing_kanban_edges,
    missing_linear_relations: receipt.summary.missing_linear_relations,
    endpoint_policies: receipt.summary.endpoint_policies,
    cycles_detected: receipt.summary.cycles_detected,
    proposed_operations: receipt.proposed_operations.length,
  };
}

function classifySnapshotStatus(
  receipt: GraphSyncReadOnlyDiffReceipt,
  completeness: GraphSyncSnapshotCompleteness,
): 'PASS' | 'REVIEW' | 'BLOCK' {
  if (!completeness.apply_eligible) {
    return 'BLOCK';
  }
  const hasErrors =
    receipt.diff.cycles.length > 0 ||
    Object.keys(receipt.ledger.conflicts).length > 0 ||
    receipt.diff.endpoint_policies.some((policy) => policy.severity === 'error');
  if (hasErrors) {
    return 'BLOCK';
  }
  const hasWarnings =
    receipt.proposed_operations.length > 0 ||
    receipt.diff.endpoint_policies.some((policy) => policy.severity === 'warning');
  if (hasWarnings) {
    return 'REVIEW';
  }
  return 'PASS';
}

function buildSnapshotCaptureError(
  input: CaptureGraphSyncReadOnlySnapshotInput,
  generatedAt: string,
  now: Date,
  error: string,
  nonActions: readonly string[],
): GraphSyncSnapshotCaptureError {
  return {
    ok: false,
    effect: 'graph_sync_read_only_snapshot_capture',
    status: 'BLOCK',
    workflow_id: input.workflowId,
    run_id: input.runId,
    generated_at: generatedAt,
    completed_at: now.toISOString(),
    mode: 'read_only_snapshot',
    suppressed_writes: true,
    error,
    non_actions: nonActions,
  };
}

function graphSyncSnapshotNonActions(): readonly string[] {
  return [
    'did_not_create_update_delete_linear_relations',
    'did_not_create_update_delete_kanban_links',
    'did_not_edit_restart_or_disable_services_or_timers',
    'did_not_dispatch_workers_or_gateway',
    'did_not_expose_raw_linear_token_or_authorization_header',
    'did_not_push_publish_deploy_or_open_pr',
  ];
}

export function createFakeGraphSyncLinearGraphReader(
  issues: readonly Issue[],
): GraphSyncLinearGraphReader {
  return {
    readIssuesWithRelations(): Promise<readonly Issue[]> {
      return Promise.resolve(issues);
    },
  };
}

export function createFakeGraphSyncKanbanGraphReader(
  tasks: readonly KanbanTaskDetail[],
): GraphSyncKanbanGraphReader {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  return {
    readTaskDetails(taskIds: readonly string[]): Promise<readonly KanbanTaskDetail[]> {
      return Promise.resolve(
        taskIds.map((taskId) => tasksById.get(taskId)).filter((task): task is KanbanTaskDetail => task !== undefined),
      );
    },
  };
}

export function createFakeGraphSyncMappingReader(
  mappings: readonly GraphSyncObservedNodeMapping[],
): GraphSyncMappingReader {
  return {
    readMappings(): Promise<readonly GraphSyncObservedNodeMapping[]> {
      return Promise.resolve(mappings);
    },
  };
}
