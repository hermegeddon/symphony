export interface IssueBlockerRef {
  readonly id: string | null;
  readonly identifier: string | null;
  readonly state: string | null;
}

export interface LinearIssueTeamRef {
  readonly key: string | null;
  readonly name: string | null;
}

export interface LinearIssueProjectRef {
  readonly id: string | null;
  readonly name: string | null;
  readonly slug_id: string | null;
  readonly url: string | null;
}

export type LinearIssueRelationType = 'blocks' | 'duplicate' | 'related' | 'similar';

export type LinearIssueRelationObservationSource = 'relations' | 'inverseRelations';

export interface LinearIssueRelationEndpointRef {
  readonly id: string | null;
  readonly identifier: string | null;
  readonly state: string | null;
}

export interface LinearIssueRelationRef {
  readonly id: string;
  readonly type: LinearIssueRelationType;
  readonly observed_from: LinearIssueRelationObservationSource;
  readonly issue: LinearIssueRelationEndpointRef;
  readonly related_issue: LinearIssueRelationEndpointRef;
  readonly created_at: Date | null;
  readonly updated_at: Date | null;
  readonly archived_at: Date | null;
}

export interface Issue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly priority: number | null;
  readonly state: string;
  readonly branch_name: string | null;
  readonly url: string | null;
  readonly labels: readonly string[];
  readonly blocked_by: readonly IssueBlockerRef[];
  readonly linear_relations?: readonly LinearIssueRelationRef[];
  readonly created_at: Date | null;
  readonly updated_at: Date | null;
  readonly team?: LinearIssueTeamRef;
  readonly project?: LinearIssueProjectRef | null;
}

export interface WorkflowDefinition {
  readonly config: Readonly<Record<string, unknown>>;
  readonly prompt_template: string;
}

export interface Workspace {
  readonly path: string;
  readonly workspace_key: string;
  readonly created_now: boolean;
}

export type RunAttemptStatus =
  | 'PreparingWorkspace'
  | 'BuildingPrompt'
  | 'LaunchingAgentProcess'
  | 'InitializingSession'
  | 'StreamingTurn'
  | 'Finishing'
  | 'Succeeded'
  | 'Failed'
  | 'TimedOut'
  | 'Stalled'
  | 'CanceledByReconciliation';

export interface RunAttempt {
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly attempt: number | null;
  readonly workspace_path: string;
  readonly started_at: Date;
  readonly status: RunAttemptStatus;
  readonly error?: string;
}

export type CodexEventName = string;

export interface LiveSession {
  readonly session_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly codex_app_server_pid: string | null;
  readonly last_codex_event: CodexEventName | null;
  readonly last_codex_timestamp: Date | null;
  readonly last_codex_message: string | null;
  readonly codex_input_tokens: number;
  readonly codex_output_tokens: number;
  readonly codex_total_tokens: number;
  readonly last_reported_input_tokens: number;
  readonly last_reported_output_tokens: number;
  readonly last_reported_total_tokens: number;
  readonly turn_count: number;
}

export interface RetryEntry {
  readonly issue_id: string;
  readonly identifier: string;
  readonly attempt: number;
  readonly due_at_ms: number;
  readonly timer_handle: NodeJS.Timeout | null;
  readonly error: string | null;
}

export interface RunningIssueEntry {
  readonly issue: Issue;
  readonly identifier: string;
  readonly run_id: string;
  readonly workspace_path: string;
  readonly started_at: Date;
  readonly retry_attempt: number | null;
  readonly session: LiveSession | null;
}

export interface CodexTokenTotals {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly seconds_running: number;
}

export interface CodexRateLimitSnapshot {
  readonly at: string;
  readonly payload: unknown;
}

export interface OrchestratorRuntimeState {
  readonly poll_interval_ms: number;
  readonly max_concurrent_agents: number;
  readonly running: Map<string, RunningIssueEntry>;
  readonly claimed: Set<string>;
  readonly retry_attempts: Map<string, RetryEntry>;
  readonly completed: Set<string>;
  readonly codex_totals: CodexTokenTotals;
  readonly codex_rate_limits: CodexRateLimitSnapshot | null;
}

export function sanitizeWorkspaceKeyFromIssue(identifier: string): string {
  return Array.from(identifier)
    .map((character) => (isAllowedWorkspaceKeyCharacter(character) ? character : '_'))
    .join('');
}

function isAllowedWorkspaceKeyCharacter(character: string): boolean {
  if (character.length !== 1) {
    return false;
  }
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }
  const isDigit = codePoint >= 48 && codePoint <= 57;
  const isUpperAlpha = codePoint >= 65 && codePoint <= 90;
  const isLowerAlpha = codePoint >= 97 && codePoint <= 122;
  return isDigit || isUpperAlpha || isLowerAlpha || character === '.' || character === '_' || character === '-';
}

export function normalizeIssueStateName(state: string): string {
  return state.toLowerCase();
}

export function toSessionId(threadId: string, turnId: string): string {
  return `${threadId}-${turnId}`;
}

export function createEmptyOrchestratorRuntimeState(input: {
  readonly poll_interval_ms: number;
  readonly max_concurrent_agents: number;
}): OrchestratorRuntimeState {
  return {
    poll_interval_ms: input.poll_interval_ms,
    max_concurrent_agents: input.max_concurrent_agents,
    running: new Map<string, RunningIssueEntry>(),
    claimed: new Set<string>(),
    retry_attempts: new Map<string, RetryEntry>(),
    completed: new Set<string>(),
    codex_totals: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: 0,
    },
    codex_rate_limits: null,
  };
}
