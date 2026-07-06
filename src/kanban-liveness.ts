import type { IssueRunLedger, IssueRunLedgerEvent } from './issue-run-ledger.js';
import type { SymphonyKanbanSnapshot, SymphonyKanbanTaskSnapshot } from './kanban-service.js';

export type KanbanLivenessClassification =
  | 'ready_to_dispatch'
  | 'blocked_waiting_on_dependency'
  | 'running_active'
  | 'completed_done'
  | 'archived_or_terminal'
  | 'linear_required_label_missing'
  | 'ledger_mismatch_orphaned_task'
  | 'degraded_kanban_unavailable'
  | 'unknown_unclassified';

export interface KanbanLivenessTaskClassification {
  readonly task_id: string;
  readonly title: string;
  readonly state: string;
  readonly classification: KanbanLivenessClassification;
  readonly computable: boolean;
  readonly source_identifier: string | null;
  readonly reason: string;
}

export interface KanbanLivenessComputabilityInventory {
  readonly total: number;
  readonly computable: number;
  readonly degraded_or_unknown: number;
  readonly by_classification: Readonly<Partial<Record<KanbanLivenessClassification, number>>>;
}

export type KanbanLivenessRecommendationKind =
  | 'observe'
  | 'report'
  | 'investigate'
  | 'human_gate';

export interface KanbanLivenessRecommendation {
  readonly classification: KanbanLivenessClassification;
  /** Suggestion-only operational note; never an authorization to mutate or auto-dispatch. */
  readonly kind: KanbanLivenessRecommendationKind;
  /** Non-mutating suggested next step. Operator policy / human gate is required before any mutation or dispatch. */
  readonly action: string;
  /** Always false. This receipt is suggestion-only; no recommendation grants permission to auto-apply, dispatch, mutate, or repair. */
  readonly safe_to_auto_apply: false;
  readonly requires_human_gate: boolean;
  readonly evidence: readonly string[];
}

export interface KanbanLivenessClassificationResult {
  readonly backend: 'hermes_kanban';
  readonly board: string | null;
  readonly mode: 'available' | 'unavailable';
  readonly inventory: KanbanLivenessComputabilityInventory;
  readonly tasks: readonly KanbanLivenessTaskClassification[];
  readonly recommendations: readonly KanbanLivenessRecommendation[];
  readonly warnings: readonly string[];
}

export interface ClassifyKanbanLivenessInput {
  readonly snapshot: SymphonyKanbanSnapshot;
  readonly ledger: IssueRunLedger | null;
}

const HUMAN_OR_EXTERNAL_GATES: readonly KanbanLivenessClassification[] = [
  'linear_required_label_missing',
  'ledger_mismatch_orphaned_task',
  'degraded_kanban_unavailable',
  'unknown_unclassified',
];

export function classifyKanbanLiveness(input: ClassifyKanbanLivenessInput): KanbanLivenessClassificationResult {
  const { snapshot, ledger } = input;
  const warnings: string[] = [];

  if (snapshot.mode === 'unavailable') {
    warnings.push('Kanban snapshot unavailable; classifications are degraded.');
    const inventory: KanbanLivenessComputabilityInventory = {
      total: 0,
      computable: 0,
      degraded_or_unknown: 0,
      by_classification: { degraded_kanban_unavailable: 1 },
    };
    const recommendation = recommendKanbanTaskAction('degraded_kanban_unavailable');
    return {
      backend: snapshot.backend,
      board: snapshot.board,
      mode: 'unavailable',
      inventory,
      tasks: [],
      recommendations: [recommendation],
      warnings,
    };
  }

  const knownLedgerIssues = ledger !== null ? buildKnownLedgerIssueMap(ledger) : null;
  const tasks: KanbanLivenessTaskClassification[] = snapshot.tasks.map((task) => classifyTask(task, knownLedgerIssues));

  const inventory = buildInventory(tasks);
  const recommendations = buildRecommendations(tasks);

  return {
    backend: snapshot.backend,
    board: snapshot.board,
    mode: 'available',
    inventory,
    tasks,
    recommendations,
    warnings,
  };
}

function buildRecommendations(
  tasks: readonly KanbanLivenessTaskClassification[],
): KanbanLivenessRecommendation[] {
  const seen = new Set<KanbanLivenessClassification>();
  const recommendations: KanbanLivenessRecommendation[] = [];
  for (const task of tasks) {
    if (seen.has(task.classification)) {
      continue;
    }
    seen.add(task.classification);
    recommendations.push(recommendKanbanTaskAction(task.classification));
  }
  return recommendations;
}

export function recommendKanbanTaskAction(classification: KanbanLivenessClassification): KanbanLivenessRecommendation {
  switch (classification) {
    case 'ready_to_dispatch':
      return {
        classification,
        kind: 'observe',
        action: 'task is pending; observe readiness and report to the operator — actual dispatch requires operator policy or human gate',
        safe_to_auto_apply: false,
        requires_human_gate: false,
        evidence: ['task state is pending', 'no ledger mismatch', 'no secret-like redaction'],
      };
    case 'running_active':
      return {
        classification,
        kind: 'observe',
        action: 'task is already running; observe progress and report on the next tick',
        safe_to_auto_apply: false,
        requires_human_gate: false,
        evidence: ['task state is running'],
      };
    case 'blocked_waiting_on_dependency':
      return {
        classification,
        kind: 'observe',
        action: 'task is blocked or in review; observe dependency/review state and wait before any dispatch decision',
        safe_to_auto_apply: false,
        requires_human_gate: false,
        evidence: ['task state is blocked or review'],
      };
    case 'completed_done':
      return {
        classification,
        kind: 'report',
        action: 'task is completed; report status and take no dispatch action',
        safe_to_auto_apply: false,
        requires_human_gate: false,
        evidence: ['task state is completed'],
      };
    case 'archived_or_terminal':
      return {
        classification,
        kind: 'report',
        action: 'task is archived or terminal; report status and take no dispatch action',
        safe_to_auto_apply: false,
        requires_human_gate: false,
        evidence: ['task state is archived'],
      };
    case 'linear_required_label_missing':
      return {
        classification,
        kind: 'human_gate',
        action: 'secret-like Linear title redacted; report to operator and do not suggest dispatch without human/external review and required label confirmation',
        safe_to_auto_apply: false,
        requires_human_gate: true,
        evidence: ['title contains [title redacted]', 'external label/human review required'],
      };
    case 'ledger_mismatch_orphaned_task':
      return {
        classification,
        kind: 'investigate',
        action: 'task source_identifier is not present or mismatched in the issue-run ledger; investigate ledger/materialization state and report before any dispatch decision',
        safe_to_auto_apply: false,
        requires_human_gate: true,
        evidence: ['source_identifier missing or mismatched in ledger', 'risk of orphan/double-dispatch'],
      };
    case 'degraded_kanban_unavailable':
      return {
        classification,
        kind: 'investigate',
        action: 'Kanban snapshot unavailable; investigate backend reachability and report — do not suggest dispatch until the Kanban backend is reachable again',
        safe_to_auto_apply: false,
        requires_human_gate: true,
        evidence: ['snapshot mode is unavailable'],
      };
    case 'unknown_unclassified':
      return {
        classification,
        kind: 'investigate',
        action: 'task state is unrecognized; investigate and classify it before any dispatch decision',
        safe_to_auto_apply: false,
        requires_human_gate: true,
        evidence: ['task state is not recognized by the classifier'],
      };
  }
}

function classifyTask(
  task: SymphonyKanbanTaskSnapshot,
  knownLedgerIssues: ReadonlyMap<string, { readonly issue_identifier: string }> | null,
): KanbanLivenessTaskClassification {
  const sourceIdentifier = task.source_identifier;

  if (sourceIdentifier !== null
    && knownLedgerIssues !== null
    && !knownLedgerIssues.has(sourceIdentifier)
    && task.state !== 'completed'
    && task.state !== 'archived') {
    return {
      task_id: task.id,
      title: task.title,
      state: task.state,
      classification: 'ledger_mismatch_orphaned_task',
      computable: false,
      source_identifier: sourceIdentifier,
      reason: `task source_identifier ${sourceIdentifier} is not present in the issue-run ledger`,
    };
  }

  const ledgerEntry = sourceIdentifier !== null && knownLedgerIssues !== null
    ? knownLedgerIssues.get(sourceIdentifier)
    : undefined;
  if (ledgerEntry !== undefined
    && ledgerEntry.issue_identifier !== sourceIdentifier) {
    return {
      task_id: task.id,
      title: task.title,
      state: task.state,
      classification: 'ledger_mismatch_orphaned_task',
      computable: false,
      source_identifier: sourceIdentifier,
      reason: `task source_identifier ${String(sourceIdentifier)} does not match ledger identifier ${ledgerEntry.issue_identifier}`,
    };
  }

  if (task.title.includes('[title redacted]')) {
    // Title redaction means the original Linear title was secret-like; treat it
    // as an external/human gate rather than auto-dispatching.
    return {
      task_id: task.id,
      title: task.title,
      state: task.state,
      classification: 'linear_required_label_missing',
      computable: false,
      source_identifier: sourceIdentifier,
      reason: 'secret-like Linear title redacted; requires human/external review before dispatch',
    };
  }

  switch (task.state) {
    case 'pending':
      return {
        task_id: task.id,
        title: task.title,
        state: task.state,
        classification: 'ready_to_dispatch',
        computable: true,
        source_identifier: sourceIdentifier,
        reason: 'task is pending and has no known blockers',
      };
    case 'running':
      return {
        task_id: task.id,
        title: task.title,
        state: task.state,
        classification: 'running_active',
        computable: true,
        source_identifier: sourceIdentifier,
        reason: 'task is already active',
      };
    case 'blocked':
      return {
        task_id: task.id,
        title: task.title,
        state: task.state,
        classification: 'blocked_waiting_on_dependency',
        computable: true,
        source_identifier: sourceIdentifier,
        reason: 'task is blocked by dependency or external gate',
      };
    case 'review':
      return {
        task_id: task.id,
        title: task.title,
        state: task.state,
        classification: 'blocked_waiting_on_dependency',
        computable: true,
        source_identifier: sourceIdentifier,
        reason: 'task is in review and waiting on external review',
      };
    case 'completed':
      return {
        task_id: task.id,
        title: task.title,
        state: task.state,
        classification: 'completed_done',
        computable: true,
        source_identifier: sourceIdentifier,
        reason: 'task is completed',
      };
    case 'archived':
      return {
        task_id: task.id,
        title: task.title,
        state: task.state,
        classification: 'archived_or_terminal',
        computable: true,
        source_identifier: sourceIdentifier,
        reason: 'task is archived or terminal',
      };
    default:
      return {
        task_id: task.id,
        title: task.title,
        state: task.state,
        classification: 'unknown_unclassified',
        computable: false,
        source_identifier: sourceIdentifier,
        reason: `task state ${task.state} is not recognized by the classifier`,
      };
  }
}

function buildKnownLedgerIssueMap(ledger: IssueRunLedger): ReadonlyMap<string, { readonly issue_identifier: string }> {
  const result = new Map<string, { readonly issue_identifier: string }>();
  const events = [...ledger.snapshot().events].reverse();
  for (const event of events) {
    if (!isIssueMutationEvent(event)) {
      continue;
    }
    const key = event.issue_identifier;
    if (result.has(key)) {
      continue;
    }
    result.set(key, { issue_identifier: event.issue_identifier });
  }
  return result;
}

function isIssueMutationEvent(event: IssueRunLedgerEvent): boolean {
  return event.kind === 'mutation_recorded';
}

function buildInventory(tasks: readonly KanbanLivenessTaskClassification[]): KanbanLivenessComputabilityInventory {
  let computable = 0;
  let degradedOrUnknown = 0;
  const byClassification: Partial<Record<KanbanLivenessClassification, number>> = {};

  for (const task of tasks) {
    byClassification[task.classification] = (byClassification[task.classification] ?? 0) + 1;
    if (task.computable) {
      computable += 1;
    } else {
      degradedOrUnknown += 1;
    }
  }

  return {
    total: tasks.length,
    computable,
    degraded_or_unknown: degradedOrUnknown,
    by_classification: byClassification,
  };
}

export function isBlockedByHumanOrExternalGate(classification: KanbanLivenessClassification): boolean {
  return HUMAN_OR_EXTERNAL_GATES.includes(classification);
}

export function isComputableClassification(classification: KanbanLivenessClassification): boolean {
  return !HUMAN_OR_EXTERNAL_GATES.includes(classification);
}
