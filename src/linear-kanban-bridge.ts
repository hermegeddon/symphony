import type { Issue } from './domain.js';
import type { IssueRunLedger, IssueRunLedgerEvent } from './issue-run-ledger.js';
import type { CreateKanbanTaskInput, KanbanClient, KanbanWorkspaceSpec } from './kanban-types.js';
import { buildKanbanMaterializationBody, buildKanbanMaterializationContext } from './kanban-materialization.js';
import type { KanbanMaterializationDispatchPolicy } from './kanban-materialization.js';
import { sanitizeLinearCommentBody } from './linear-lifecycle-notifier.js';
import type { LinearIssueMutationClient } from './tracker.js';
import type { KanbanWorkspacePolicy } from './workflow.js';

export const LINEAR_KANBAN_BRIDGE_ACTOR = 'symphony-linear-kanban-bridge' as const;

export type LinearKanbanBridgeDispatchPolicy = KanbanMaterializationDispatchPolicy;

export interface LinearKanbanBridgeTracker {
  fetch_candidate_issues(): Promise<readonly Issue[]>;
  fetch_all_candidate_issues?(): Promise<readonly Issue[]>;
  getRequiredLabels?(): readonly string[];
  selectorScopeForReceipt?(): {
    readonly kind: 'project_slug' | 'team_key' | 'all_approved_projects';
    readonly value: string;
    readonly required_labels: readonly string[];
    readonly canary_labels?: readonly string[];
    readonly canary_issue_identifier?: string | null;
    readonly active_states: readonly string[];
    readonly max_issues_per_poll: number;
  };
}

export interface RunLinearKanbanBridgeOnceInput {
  readonly workflowId: string;
  readonly board: string;
  readonly artifactRoot: string;
  readonly tracker: LinearKanbanBridgeTracker;
  readonly kanbanClient: KanbanClient;
  readonly ledger: IssueRunLedger;
  readonly linearMutationClient: LinearIssueMutationClient;
  readonly defaultAssignee: string | null;
  readonly workspace: KanbanWorkspaceSpec;
  readonly startStateId: string | null;
  readonly completedStateId: string | null;
  readonly commentMarker: string;
  readonly dispatchPolicy?: LinearKanbanBridgeDispatchPolicy;
  readonly now?: Date;
}

export interface LinearKanbanBridgeMaterializedIssue {
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly task_id: string;
  readonly created: boolean;
  readonly dispatch_policy: LinearKanbanBridgeDispatchPolicy;
  readonly requested_assignee: string | null;
  readonly sticky_block_applied: boolean;
}

export interface LinearKanbanBridgeCompletion {
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly task_id: string;
  readonly task_status: string;
  readonly completed: boolean;
}

export interface LinearKanbanBridgeSkippedIssue {
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly reason: 'linear_required_label_missing';
  readonly missing_labels: readonly string[];
}

export interface LinearKanbanBridgeTickReceipt {
  readonly ok: true;
  readonly effect: 'linear_kanban_bridge_tick';
  readonly workflow_id: string;
  readonly board: string;
  readonly artifact_root: string;
  readonly dispatch_policy: LinearKanbanBridgeDispatchPolicy;
  readonly selector_scope?: {
    readonly kind: 'project_slug' | 'team_key' | 'all_approved_projects';
    readonly value: string;
    readonly required_labels: readonly string[];
    readonly canary_labels?: readonly string[];
    readonly canary_issue_identifier?: string | null;
    readonly active_states: readonly string[];
    readonly max_issues_per_poll: number;
  };
  readonly candidates: number;
  readonly materialized: readonly LinearKanbanBridgeMaterializedIssue[];
  readonly skipped: readonly LinearKanbanBridgeSkippedIssue[];
  readonly completed: readonly LinearKanbanBridgeCompletion[];
  readonly provenance_warnings: readonly LinearKanbanBridgeProvenanceWarning[];
}

export interface LinearKanbanBridgeProvenanceWarning {
  readonly kind: 'conflict' | 'degraded' | 'unavailable';
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly message: string;
}

const MATERIALIZED_TASK_KEY = 'kanban:task:materialized';
const START_COMMENT_KEY = 'linear:comment:start';
const COMPLETED_COMMENT_KEY = 'linear:comment:completed';
const REQUIRED_LABEL_MISSING_KEY = 'linear:required_label_missing';

export async function runLinearKanbanBridgeOnce(input: RunLinearKanbanBridgeOnceInput): Promise<LinearKanbanBridgeTickReceipt> {
  const at = input.now ?? new Date();
  const dispatchPolicy = input.dispatchPolicy ?? 'dispatchable';
  const requiredLabels = normalizeRequiredLabels(input.tracker.getRequiredLabels?.());
  const provenanceWarnings: LinearKanbanBridgeProvenanceWarning[] = [];
  const allIssues = input.tracker.fetch_all_candidate_issues !== undefined
    ? await safeFetchAll(input.tracker, provenanceWarnings)
    : await safeFetchCandidates(input.tracker, provenanceWarnings);
  const materialized: LinearKanbanBridgeMaterializedIssue[] = [];
  const skipped: LinearKanbanBridgeSkippedIssue[] = [];
  const completed: LinearKanbanBridgeCompletion[] = [];

  for (const issue of allIssues) {
    const normalizedIssueLabels = issue.labels.map((label) => label.toLowerCase().trim());
    const missingLabels = requiredLabels.filter((required) => !normalizedIssueLabels.includes(required));
    if (missingLabels.length > 0) {
      input.ledger.recordMutation({
        issue,
        key: REQUIRED_LABEL_MISSING_KEY,
        operation: 'linear.required_label_missing',
        at,
        details: {
          missing_labels: missingLabels,
          required_labels: requiredLabels,
        },
      });
      skipped.push({
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        reason: 'linear_required_label_missing',
        missing_labels: missingLabels,
      });
      continue;
    }
    const existingTaskId = findMaterializedTaskId(input.ledger, issue.id);
    const materialization = existingTaskId === null
      ? await createKanbanTask(input, issue, at, dispatchPolicy)
      : {
          taskId: existingTaskId,
          requestedAssignee: requestedAssigneeForPolicy(input.defaultAssignee, dispatchPolicy),
          stickyBlockApplied: false,
        };
    const created = existingTaskId === null;
    if (input.startStateId !== null) {
      await updateLinearStateOnce(input, issue, `linear:state:start:${input.startStateId}`, input.startStateId, at);
    }
    await commentLinearOnce(input, issue, START_COMMENT_KEY, buildStartComment(input, issue, materialization.taskId), at);
    materialized.push({
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      task_id: materialization.taskId,
      created,
      dispatch_policy: dispatchPolicy,
      requested_assignee: materialization.requestedAssignee,
      sticky_block_applied: materialization.stickyBlockApplied,
    });
    const completion = await syncCompletionFromKanban(input, issue, materialization.taskId, at);
    if (completion !== null) {
      completed.push(completion);
    }
  }

  // Fail-safe provenance: already-materialized issues that have dropped a required label may
  // disappear from the next fetch because the tracker prefilters candidates by required labels.
  // Re-scan known materializations from the ledger and emit skipped/ledger provenance for any
  // that are no longer present among fetched candidates, so operator review has a receipt.
  if (requiredLabels.length > 0) {
    const candidateIds = new Set(allIssues.map((issue) => issue.id));
    const knownMaterializations = findAllMaterializedTaskIds(input.ledger);
    for (const [issueId, known] of knownMaterializations) {
      if (candidateIds.has(issueId)) {
        continue;
      }
      if (input.ledger.hasMutation(issueId, REQUIRED_LABEL_MISSING_KEY)) {
        continue;
      }
      const ledgerIssue = buildIssueFromKnownMaterialization(known, issueId);
      input.ledger.recordMutation({
        issue: ledgerIssue,
        key: REQUIRED_LABEL_MISSING_KEY,
        operation: 'linear.required_label_missing',
        at,
        details: {
          missing_labels: requiredLabels,
          required_labels: requiredLabels,
          reason: 'materialized_issue_no_longer_matches_required_labels',
          last_known_issue_identifier: known.issue_identifier,
          last_known_task_id: known.task_id,
        },
      });
      skipped.push({
        issue_id: issueId,
        issue_identifier: known.issue_identifier,
        reason: 'linear_required_label_missing',
        missing_labels: requiredLabels,
      });
    }
  }

  const selectorScope = input.tracker.selectorScopeForReceipt?.();
  return {
    ok: true,
    effect: 'linear_kanban_bridge_tick',
    workflow_id: input.workflowId,
    board: input.board,
    artifact_root: input.artifactRoot,
    dispatch_policy: dispatchPolicy,
    ...(selectorScope === undefined ? {} : {
      selector_scope: {
        kind: selectorScope.kind,
        value: selectorScope.value,
        required_labels: selectorScope.required_labels,
        ...(selectorScope.canary_labels === undefined ? {} : { canary_labels: selectorScope.canary_labels }),
        ...(selectorScope.canary_issue_identifier === undefined ? {} : { canary_issue_identifier: selectorScope.canary_issue_identifier }),
        active_states: selectorScope.active_states,
        max_issues_per_poll: selectorScope.max_issues_per_poll,
      },
    }),
    candidates: allIssues.length,
    materialized,
    skipped,
    completed,
    provenance_warnings: provenanceWarnings,
  };
}

async function createKanbanTask(
  input: RunLinearKanbanBridgeOnceInput,
  issue: Issue,
  at: Date,
  dispatchPolicy: LinearKanbanBridgeDispatchPolicy,
): Promise<{ readonly taskId: string; readonly requestedAssignee: string | null; readonly stickyBlockApplied: boolean }> {
  // Linear issue free text is treated as untrusted source data. Materialization body
  // is rendered by a code-owned builder that fences/quotes, redacts, size-bounds,
  // and includes non-overridable safety/provenance anchors.
  const existingTaskId = findMaterializedTaskId(input.ledger, issue.id);
  const materialized = existingTaskId !== null;
  const idempotencyKey = bridgeIdempotencyKey(input.workflowId, issue);
  const requestedAssignee = requestedAssigneeForPolicy(input.defaultAssignee, dispatchPolicy);
  const context = buildKanbanMaterializationContext({
    issue,
    workflowId: input.workflowId,
    board: input.board,
    artifactRoot: input.artifactRoot,
    idempotencyKey,
    dispatchMode: 'dry_run', // bridge itself does not dispatch; gateway dispatch is separately gated
    dispatchPolicy,
    defaultAssignee: input.defaultAssignee,
    requestedAssignee,
    workspace: workspacePolicyFromSpec(input.workspace),
    safety: {
      requireProfilePreflight: false,
      requireReviewGateForRepoMutation: true,
      requireHumanGateForExternalActions: true,
    },
    ledger: { materialized, knownTaskId: existingTaskId },
  });
  const body = buildKanbanMaterializationBody({ context });
  const taskInput: CreateKanbanTaskInput = {
    title: safeRenderBridgeTaskTitle(`${issue.identifier}: ${issue.title}`, issue.identifier),
    body,
    assignee: requestedAssignee,
    workspace: input.workspace,
    ...(issue.priority === null ? {} : { priority: issue.priority }),
    idempotencyKey,
    createdBy: LINEAR_KANBAN_BRIDGE_ACTOR,
  };
  const task = await input.kanbanClient.createTask(taskInput);
  const stickyBlockApplied = await applyNoWorkerBlockIfNeeded(input, issue, task.id, dispatchPolicy);
  input.ledger.recordMutation({
    issue,
    key: MATERIALIZED_TASK_KEY,
    operation: 'kanban.createTask',
    at,
    details: {
      task_id: task.id,
      board: input.board,
      idempotency_key: idempotencyKey,
      artifact_root: input.artifactRoot,
      dispatch_policy: dispatchPolicy,
      requested_assignee: requestedAssignee,
      sticky_block_applied: stickyBlockApplied,
    },
  });
  return { taskId: task.id, requestedAssignee, stickyBlockApplied };
}

function requestedAssigneeForPolicy(defaultAssignee: string | null, dispatchPolicy: LinearKanbanBridgeDispatchPolicy): string | null {
  return dispatchPolicy === 'no_worker' ? null : defaultAssignee;
}

async function applyNoWorkerBlockIfNeeded(
  input: RunLinearKanbanBridgeOnceInput,
  issue: Issue,
  taskId: string,
  dispatchPolicy: LinearKanbanBridgeDispatchPolicy,
): Promise<boolean> {
  if (dispatchPolicy !== 'no_worker') {
    return false;
  }
  await input.kanbanClient.blockTask(taskId, noWorkerBlockReason(input, issue));
  return true;
}

function noWorkerBlockReason(input: RunLinearKanbanBridgeOnceInput, issue: Issue): string {
  return `Symphony Linear→Kanban bridge no-worker policy: ${issue.identifier} was materialized for exact-scope validation only; keep nonspawnable pending explicit human remediation gate. workflow=${input.workflowId}`;
}

function workspacePolicyFromSpec(spec: KanbanWorkspaceSpec): KanbanWorkspacePolicy {
  if (spec === 'scratch') {
    return { kind: 'scratch' };
  }
  if (spec.startsWith('worktree:')) {
    return { kind: 'worktree', root: spec.slice('worktree:'.length) };
  }
  if (spec.startsWith('dir:')) {
    return { kind: 'dir', root: spec.slice('dir:'.length) };
  }
  return { kind: 'dir', root: spec };
}

function bridgeIdempotencyKey(workflowId: string, issue: Issue): string {
  return `${LINEAR_KANBAN_BRIDGE_ACTOR}:${workflowId}:${issue.id}`;
}

function buildStartComment(input: RunLinearKanbanBridgeOnceInput, issue: Issue, taskId: string): string {
  return sanitizeLinearCommentBody([
    marker(input.commentMarker, START_COMMENT_KEY),
    `Symphony materialized ${issue.identifier} into Hermes Kanban.`,
    `Kanban board: ${input.board}`,
    `Kanban task: ${taskId}`,
  ].join('\n'));
}

async function syncCompletionFromKanban(
  input: RunLinearKanbanBridgeOnceInput,
  issue: Issue,
  taskId: string,
  at: Date,
): Promise<LinearKanbanBridgeCompletion | null> {
  const detail = await input.kanbanClient.showTask(taskId);
  if (detail.status !== 'done') {
    return null;
  }
  const completedStateKey = input.completedStateId === null ? null : `linear:state:completed:${input.completedStateId}`;
  const alreadyCompleted = input.ledger.hasMutation(issue.id, COMPLETED_COMMENT_KEY)
    && (completedStateKey === null || input.ledger.hasMutation(issue.id, completedStateKey));
  if (!alreadyCompleted) {
    if (input.completedStateId !== null && completedStateKey !== null) {
      await updateLinearStateOnce(input, issue, completedStateKey, input.completedStateId, at);
    }
    await commentLinearOnce(input, issue, COMPLETED_COMMENT_KEY, buildCompletionComment(input, issue, taskId), at);
  }
  return {
    issue_id: issue.id,
    issue_identifier: issue.identifier,
    task_id: taskId,
    task_status: detail.status,
    completed: !alreadyCompleted,
  };
}

function buildCompletionComment(input: RunLinearKanbanBridgeOnceInput, issue: Issue, taskId: string): string {
  return sanitizeLinearCommentBody([
    marker(input.commentMarker, COMPLETED_COMMENT_KEY),
    `Symphony observed Kanban task ${taskId} completed.`,
    `Linear issue: ${issue.identifier}`,
    `Kanban board: ${input.board}`,
  ].join('\n'));
}

async function updateLinearStateOnce(
  input: RunLinearKanbanBridgeOnceInput,
  issue: Issue,
  key: string,
  stateId: string,
  at: Date,
): Promise<void> {
  if (input.ledger.hasMutation(issue.id, key)) {
    return;
  }
  await input.linearMutationClient.updateIssueState({ issueId: issue.id, stateId });
  input.ledger.recordMutation({
    issue,
    key,
    operation: 'issueUpdate',
    at,
    details: { state_id: stateId },
  });
}

async function commentLinearOnce(
  input: RunLinearKanbanBridgeOnceInput,
  issue: Issue,
  key: string,
  body: string,
  at: Date,
): Promise<void> {
  if (input.ledger.hasMutation(issue.id, key)) {
    return;
  }
  const redactedBody = sanitizeLinearCommentBody(body);
  if (redactedBody.trim() === '') {
    return;
  }
  const receipt = await input.linearMutationClient.createComment({ issueId: issue.id, body: redactedBody });
  input.ledger.recordMutation({
    issue,
    key,
    operation: 'commentCreate',
    at,
    details: {
      comment_id: receipt.comment_id,
      comment_url: receipt.comment_url,
    },
  });
}

function findMaterializedTaskId(ledger: IssueRunLedger, issueId: string): string | null {
  const events = [...ledger.snapshot().events].reverse();
  for (const event of events) {
    if (!isMaterializedTaskEvent(event, issueId)) {
      continue;
    }
    const taskId = event.details['task_id'];
    if (typeof taskId === 'string' && taskId.trim() !== '') {
      return taskId;
    }
  }
  return null;
}

interface KnownMaterialization {
  readonly task_id: string;
  readonly issue_identifier: string;
}

function findAllMaterializedTaskIds(ledger: IssueRunLedger): ReadonlyMap<string, KnownMaterialization> {
  const result = new Map<string, KnownMaterialization>();
  const events = [...ledger.snapshot().events];
  for (const event of events) {
    if (event.kind !== 'mutation_recorded') {
      continue;
    }
    const key = event.details['key'];
    if (key !== MATERIALIZED_TASK_KEY) {
      continue;
    }
    const taskId = event.details['task_id'];
    const issueIdentifier = event.issue_identifier;
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      continue;
    }
    if (typeof issueIdentifier !== 'string' || issueIdentifier.trim() === '') {
      continue;
    }
    result.set(event.issue_id, { task_id: taskId, issue_identifier: issueIdentifier });
  }
  return result;
}

function buildIssueFromKnownMaterialization(known: KnownMaterialization, issueId: string): Issue {
  return {
    id: issueId,
    identifier: known.issue_identifier,
    title: `${known.issue_identifier} (known materialization, current fetch did not match required labels)`,
    description: null,
    priority: null,
    state: 'unknown',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
  };
}

function isMaterializedTaskEvent(event: IssueRunLedgerEvent, issueId: string): boolean {
  return event.kind === 'mutation_recorded'
    && event.issue_id === issueId
    && event.details['key'] === MATERIALIZED_TASK_KEY;
}

function normalizeRequiredLabels(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined || value.length === 0) {
    return [];
  }
  return [...value].map((label) => label.toLowerCase().trim()).filter((label) => label !== '');
}

function marker(namespace: string, key: string): string {
  return `<!-- ${namespace}:${key} -->`;
}

function safeFetchAll(
  tracker: LinearKanbanBridgeTracker,
  warnings: LinearKanbanBridgeProvenanceWarning[],
): Promise<readonly Issue[]> {
  const fetch = tracker.fetch_all_candidate_issues?.bind(tracker);
  if (fetch === undefined) {
    return Promise.resolve([]);
  }
  return fetch().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push({
      kind: 'unavailable',
      issue_id: 'unknown',
      issue_identifier: 'unknown',
      message: `fetch_all_candidate_issues unavailable: ${redactReceiptText(message)}`,
    });
    return [];
  });
}

function safeFetchCandidates(
  tracker: LinearKanbanBridgeTracker,
  warnings: LinearKanbanBridgeProvenanceWarning[],
): Promise<readonly Issue[]> {
  return tracker.fetch_candidate_issues().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push({
      kind: 'unavailable',
      issue_id: 'unknown',
      issue_identifier: 'unknown',
      message: `fetch_candidate_issues unavailable: ${redactReceiptText(message)}`,
    });
    return [];
  });
}

function redactReceiptText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)[A-Z0-9_]*\s*[:=]\s*["']?)([^"'\s,}]+)/gi, '$1[REDACTED]')
    .replace(/(--(?:api[-_]?key|token|secret|password)\s+)([^\s]+)/gi, '$1[REDACTED]')
    .replace(/\bsk[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bsess_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\blin_(?:api|oauth)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
}

function safeRenderBridgeTaskTitle(value: string, issueIdentifier: string): string {
  const redacted = redactReceiptText(value);
  if (redacted !== value) {
    return `${issueIdentifier} [title redacted]`;
  }
  return value;
}
