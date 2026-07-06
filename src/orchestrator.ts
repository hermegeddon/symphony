import type { CodexRateLimitSnapshot, Issue, LiveSession, RetryEntry, RunningIssueEntry } from './domain.js';
import type { IssueRunLedger } from './issue-run-ledger.js';
import type { CodexRuntimeEvent, JsonObject, JsonValue } from './codex-runner.js';
import { normalizeIssueStateName } from './domain.js';
import { formatStructuredLogLine, type StructuredLogEntry } from './observability.js';
import {
  getEffectiveConfig,
  validateDispatchPreflight,
  type DispatchPreflightError,
  type EffectiveConfig,
  type WorkflowDefinition,
} from './workflow.js';

export interface OrchestratorClock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout): void;
}

export interface OrchestratorIssueTracker {
  fetch_candidate_issues(): Promise<readonly Issue[]>;
  fetch_terminal_issues(): Promise<readonly Issue[]>;
  fetch_issue_states_by_ids(issueIds: readonly string[]): Promise<readonly Issue[]>;
}

export interface OrchestratorWorkspaceManager {
  prepareWorkspace(issue: Issue): Promise<{ readonly workspacePath: string }>;
  runAfterRunHook(issue: Issue): Promise<void>;
  cleanupTerminalWorkspace(issue: Issue): Promise<void>;
}

export interface RunCompletion {
  readonly ok: boolean;
  readonly error?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface OrchestratorAgentRunner {
  runIssue(input: {
    readonly issue: Issue;
    readonly workspacePath: string;
    readonly promptTemplate: string;
    readonly retryAttempt: number | null;
    readonly onEvent?: (event: CodexRuntimeEvent) => void;
  }): { readonly completion: Promise<RunCompletion>; readonly cancel: (reason: string) => Promise<void> };
}

export interface OrchestratorRuntimeDependencies {
  readonly tracker: OrchestratorIssueTracker;
  readonly workspaceManager: OrchestratorWorkspaceManager;
  readonly runner: OrchestratorAgentRunner;
  readonly issueLedger?: IssueRunLedger;
  readonly lifecycleNotifier?: OrchestratorIssueLifecycleNotifier;
}

export interface OrchestratorLifecycleStartedInput {
  readonly issue: Issue;
  readonly runId: string;
  readonly attempt: number;
  readonly workspacePath: string;
}

export interface OrchestratorLifecycleCompletionInput {
  readonly issue: Issue;
  readonly runId: string;
  readonly completion: RunCompletion;
}

export interface OrchestratorIssueLifecycleNotifier {
  onIssueStarted?(input: OrchestratorLifecycleStartedInput): void | Promise<void>;
  onIssueCompleted?(input: OrchestratorLifecycleCompletionInput): void | Promise<void>;
  onIssueCanceled?(input: { readonly issue: Issue; readonly runId: string; readonly reason: string }): void | Promise<void>;
}

export interface OrchestratorLedgerSnapshot {
  readonly path: string;
  readonly completed_issue_count: number;
}

export interface OrchestratorSnapshot {
  readonly poll_interval_ms: number;
  readonly max_concurrent_agents: number;
  readonly running: readonly OrchestratorRunningSnapshot[];
  readonly claimed: readonly string[];
  readonly retry_attempts: readonly OrchestratorRetrySnapshot[];
  readonly retrying: readonly OrchestratorRetrySnapshot[];
  readonly completed: readonly string[];
  readonly codex_totals: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
    readonly seconds_running: number;
  };
  readonly codex_rate_limits: CodexRateLimitSnapshot | null;
  readonly rate_limits: CodexRateLimitSnapshot | null;
  readonly ledger: OrchestratorLedgerSnapshot | null;
  readonly error_modes: readonly ['timeout', 'unavailable'];
  readonly last_preflight_errors: readonly DispatchPreflightError[];
}

export interface OrchestratorRunningSnapshot {
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly identifier: string;
  readonly run_id: string;
  readonly state: string;
  readonly session_id: string | null;
  readonly turn_count: number;
  readonly last_event: string | null;
  readonly last_message: string | null;
  readonly started_at: string;
  readonly last_event_at: string | null;
  readonly tokens: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
  };
}

export interface OrchestratorRetrySnapshot {
  readonly issue_id: string;
  readonly identifier: string;
  readonly attempt: number;
  readonly due_at_ms: number;
  readonly timer_handle: number | null;
  readonly error: string | null;
}

interface RunningHandle {
  readonly cancel: (reason: string) => Promise<void>;
}

interface RuntimeTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

interface MutableRuntimeState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, RunningIssueEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  failed: Set<string>;
  completed: Set<string>;
  codex_totals: RuntimeTotals;
  codex_rate_limits: CodexRateLimitSnapshot | null;
}

export class SymphonyOrchestrator {
  private tracker: OrchestratorIssueTracker;
  private workspaceManager: OrchestratorWorkspaceManager;
  private runner: OrchestratorAgentRunner;
  private readonly clock: OrchestratorClock;
  private workflow: WorkflowDefinition;
  private readonly log: (line: string) => void;
  private readonly handles = new Map<string, RunningHandle>();
  private readonly workspaceManagersByIssueId = new Map<string, OrchestratorWorkspaceManager>();
  private issueLedger: IssueRunLedger | null;
  private lifecycleNotifier: OrchestratorIssueLifecycleNotifier | null;
  private state: MutableRuntimeState;
  private lastPreflightErrors: readonly DispatchPreflightError[] = [];
  private mutationChain: Promise<void> = Promise.resolve();

  public constructor(input: {
    readonly workflow: WorkflowDefinition;
    readonly tracker: OrchestratorIssueTracker;
    readonly workspaceManager: OrchestratorWorkspaceManager;
    readonly runner: OrchestratorAgentRunner;
    readonly issueLedger?: IssueRunLedger;
    readonly lifecycleNotifier?: OrchestratorIssueLifecycleNotifier;
    readonly clock?: OrchestratorClock;
    readonly log?: (line: string) => void;
  }) {
    this.workflow = input.workflow;
    this.tracker = input.tracker;
    this.workspaceManager = input.workspaceManager;
    this.runner = input.runner;
    this.clock = input.clock ?? realClock;
    this.log = input.log ?? (() => undefined);
    this.issueLedger = input.issueLedger ?? null;
    this.lifecycleNotifier = input.lifecycleNotifier ?? null;
    const config = getEffectiveConfig(input.workflow);
    this.state = this.emptyState(config);
    this.recoverLedgerState();
  }

  public async tick(): Promise<void> {
    await this.serialize(async () => {
      await this.reconcileRunning();
      const preflightErrors = validateDispatchPreflight(this.workflow);
      this.lastPreflightErrors = preflightErrors;
      if (preflightErrors.length > 0) {
        this.writeLog({
          level: 'error',
          event: 'dispatch_validation',
          outcome: 'failed',
          reason: preflightErrors.map((error) => `${error.code} ${error.field}`).join('; '),
        });
        return;
      }
      const config = getEffectiveConfig(this.workflow);
      this.applyConfig(config);
      const candidates = await this.tracker.fetch_candidate_issues();
      await this.dispatchFromCandidates(candidates, config, null);
    });
  }

  public async startupCleanup(): Promise<void> {
    try {
      const terminalIssues = await this.tracker.fetch_terminal_issues();
      for (const issue of terminalIssues) {
        await this.workspaceManager.cleanupTerminalWorkspace(issue);
      }
    } catch {
      // Spec-defined policy: startup cleanup failures are warnings and do not block startup.
    }
  }

  public queueFailureRetry(issue: Issue, attempt: number, error: string): void {
    this.scheduleFailureRetry(issue, attempt, error);
  }

  public updateWorkflow(workflow: WorkflowDefinition): void {
    this.updateWorkflowRuntime({ workflow });
  }

  public updateWorkflowRuntime(input: {
    readonly workflow: WorkflowDefinition;
    readonly tracker?: OrchestratorIssueTracker;
    readonly workspaceManager?: OrchestratorWorkspaceManager;
    readonly runner?: OrchestratorAgentRunner;
    readonly issueLedger?: IssueRunLedger;
    readonly lifecycleNotifier?: OrchestratorIssueLifecycleNotifier;
  }): void {
    const config = getEffectiveConfig(input.workflow);
    this.workflow = input.workflow;
    if (input.tracker !== undefined) {
      this.tracker = input.tracker;
    }
    if (input.workspaceManager !== undefined) {
      this.workspaceManager = input.workspaceManager;
    }
    if (input.runner !== undefined) {
      this.runner = input.runner;
    }
    if (input.issueLedger !== undefined) {
      this.issueLedger = input.issueLedger;
      this.recoverLedgerState();
    }
    if (input.lifecycleNotifier !== undefined) {
      this.lifecycleNotifier = input.lifecycleNotifier;
    }
    this.applyConfig(config);
  }

  public async drain(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await this.mutationChain;
  }

  public snapshot(): OrchestratorSnapshot {
    const retrying = [...this.state.retry_attempts.values()].map((entry) => ({
      issue_id: entry.issue_id,
      identifier: entry.identifier,
      attempt: entry.attempt,
      due_at_ms: entry.due_at_ms,
      timer_handle: entry.timer_handle === null ? null : Number(entry.timer_handle),
      error: entry.error,
    }));
    const activeRuntimeSeconds = [...this.state.running.values()].reduce(
      (total, entry) => total + Math.max(0, Math.floor((this.clock.now().getTime() - entry.started_at.getTime()) / 1000)),
      0,
    );
    return {
      poll_interval_ms: this.state.poll_interval_ms,
      max_concurrent_agents: this.state.max_concurrent_agents,
      running: [...this.state.running.values()].map((entry) => runningSnapshot(entry)),
      claimed: [...this.state.claimed],
      retry_attempts: retrying,
      retrying,
      completed: [...this.state.completed],
      codex_totals: {
        ...this.state.codex_totals,
        seconds_running: this.state.codex_totals.seconds_running + activeRuntimeSeconds,
      },
      codex_rate_limits: this.state.codex_rate_limits,
      rate_limits: this.state.codex_rate_limits,
      ledger: this.issueLedger === null ? null : {
        path: this.issueLedger.path,
        completed_issue_count: this.issueLedger.completedIssueIds().length,
      },
      error_modes: ['timeout', 'unavailable'],
      last_preflight_errors: this.lastPreflightErrors,
    };
  }

  private async serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.mutationChain.then(operation, operation);
    this.mutationChain = next.catch(() => undefined);
    await next;
  }

  private emptyState(config: EffectiveConfig): MutableRuntimeState {
    return {
      poll_interval_ms: config.polling.intervalMs,
      max_concurrent_agents: config.agent.maxConcurrentAgents,
      running: new Map<string, RunningIssueEntry>(),
      claimed: new Set<string>(),
      retry_attempts: new Map<string, RetryEntry>(),
      failed: new Set<string>(),
      completed: new Set<string>(),
      codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
      codex_rate_limits: null,
    };
  }

  private recoverLedgerState(): void {
    if (this.issueLedger === null) {
      return;
    }
    const interrupted = this.issueLedger.recoverInterruptedRuns(this.clock.now());
    for (const issueId of this.issueLedger.completedIssueIds()) {
      this.state.completed.add(issueId);
    }
    if (interrupted.length > 0) {
      this.writeLog({
        level: 'warn',
        event: 'ledger_recovery',
        outcome: 'completed',
        reason: `marked ${String(interrupted.length)} running issue(s) interrupted after restart`,
      });
    }
  }

  private applyConfig(config: EffectiveConfig): void {
    this.state.poll_interval_ms = config.polling.intervalMs;
    this.state.max_concurrent_agents = config.agent.maxConcurrentAgents;
  }

  private async reconcileRunning(): Promise<void> {
    const runningEntries = [...this.state.running.values()];
    const config = getEffectiveConfig(this.workflow);
    if (config.codex.stallTimeoutMs > 0) {
      for (const entry of runningEntries) {
        const referenceTime = entry.session?.last_codex_timestamp ?? entry.started_at;
        if (this.clock.now().getTime() - referenceTime.getTime() > config.codex.stallTimeoutMs) {
          await this.cancelRunning(entry.issue.id, 'stalled');
          const attempt = (entry.retry_attempt ?? 0) + 1;
          this.scheduleFailureRetry(entry.issue, attempt, 'stalled');
        }
      }
    }

    const remainingIds = [...this.state.running.keys()];
    let refreshedIssues: readonly Issue[];
    try {
      refreshedIssues = await this.tracker.fetch_issue_states_by_ids(remainingIds);
    } catch {
      return;
    }

    const byId = new Map(refreshedIssues.map((issue) => [issue.id, issue]));
    for (const [issueId, entry] of [...this.state.running.entries()]) {
      const refreshed = byId.get(issueId);
      if (refreshed === undefined) {
        continue;
      }
      if (isTerminalState(refreshed.state, config)) {
        const workspaceManager = this.workspaceManagersByIssueId.get(issueId) ?? this.workspaceManager;
        await this.cancelRunning(issueId, 'terminal-state');
        await workspaceManager.cleanupTerminalWorkspace(refreshed);
      } else if (isActiveState(refreshed.state, config)) {
        this.state.running.set(issueId, { ...entry, issue: refreshed });
      } else {
        await this.cancelRunning(issueId, 'inactive-state');
      }
    }
  }

  private async dispatchFromCandidates(candidates: readonly Issue[], config: EffectiveConfig, onlyIssueId: string | null): Promise<void> {
    const sorted = [...candidates].sort(compareIssuesForDispatch);
    for (const issue of sorted) {
      if (onlyIssueId !== null && issue.id !== onlyIssueId) {
        continue;
      }
      if (!this.isIssueEligible(issue, config)) {
        continue;
      }
      await this.dispatchIssue(issue);
      if (availableGlobalSlots(this.state) <= 0) {
        break;
      }
    }
  }

  private isIssueEligible(issue: Issue, config: EffectiveConfig): boolean {
    if (!hasRequiredIssueFields(issue)) {
      return false;
    }
    if (!isActiveState(issue.state, config) || isTerminalState(issue.state, config)) {
      return false;
    }
    if (this.state.completed.has(issue.id)) {
      const retryEntry = this.state.retry_attempts.get(issue.id);
      return this.issueLedger === null && retryEntry?.error === null;
    }
    if (this.state.failed.has(issue.id)) {
      return false;
    }
    if (this.state.running.has(issue.id) || this.state.claimed.has(issue.id)) {
      return false;
    }
    if (availableGlobalSlots(this.state) <= 0) {
      return false;
    }
    if (!this.hasStateSlot(issue.state, config)) {
      return false;
    }
    if (normalizeIssueStateName(issue.state) === 'todo' && issue.blocked_by.some((blocker) => !isTerminalState(blocker.state, config))) {
      return false;
    }
    return true;
  }

  private hasStateSlot(state: string, config: EffectiveConfig): boolean {
    const normalizedState = normalizeIssueStateName(state);
    const stateLimit = config.agent.maxConcurrentAgentsByState[normalizedState] ?? config.agent.maxConcurrentAgents;
    const runningInState = [...this.state.running.values()].filter(
      (entry) => normalizeIssueStateName(entry.issue.state) === normalizedState,
    ).length;
    return runningInState < stateLimit;
  }

  private async dispatchIssue(issue: Issue): Promise<void> {
    this.state.claimed.add(issue.id);
    const retryEntry = this.state.retry_attempts.get(issue.id);
    const workspaceManager = this.workspaceManager;
    const runner = this.runner;
    if (retryEntry?.timer_handle !== null && retryEntry?.timer_handle !== undefined) {
      this.clock.clearTimeout(retryEntry.timer_handle);
    }
    this.state.retry_attempts.delete(issue.id);

    let workspace: { readonly workspacePath: string };
    try {
      workspace = await workspaceManager.prepareWorkspace(issue);
    } catch (error) {
      this.scheduleDispatchFailureRetry(issue, error, retryEntry?.attempt ?? 0)
      return;
    }

    const startedAt = this.clock.now();
    const runId = this.issueLedger?.createRunId(issue) ?? `${issue.identifier}-${startedAt.getTime().toString(36)}`;
    const runAttempt = retryEntry?.attempt ?? 0;
    try {
      this.issueLedger?.recordRunStarted({
        issue,
        runId,
        attempt: runAttempt,
        workspacePath: workspace.workspacePath,
        at: startedAt,
      });
      await this.notifyIssueStarted({ issue, runId, attempt: runAttempt, workspacePath: workspace.workspacePath });
    } catch (error) {
      await this.runAfterRunHookWithManager(workspaceManager, issue);
      this.scheduleDispatchFailureRetry(issue, error, retryEntry?.attempt ?? 0);
      return;
    }
    let runHandle: { readonly completion: Promise<RunCompletion>; readonly cancel: (reason: string) => Promise<void> };
    try {
      runHandle = runner.runIssue({
        issue,
        workspacePath: workspace.workspacePath,
        promptTemplate: this.workflow.prompt_template,
        retryAttempt: retryEntry?.attempt ?? null,
        onEvent: (event) => {
          this.handleCodexEvent(issue.id, event);
        },
      });
    } catch (error) {
      await this.runAfterRunHookWithManager(workspaceManager, issue);
      this.scheduleDispatchFailureRetry(issue, error, retryEntry?.attempt ?? 0);
      return;
    }

    this.state.running.set(issue.id, {
      issue,
      identifier: issue.identifier,
      run_id: runId,
      workspace_path: workspace.workspacePath,
      started_at: startedAt,
      retry_attempt: retryEntry?.attempt ?? null,
      session: null,
    });
    this.workspaceManagersByIssueId.set(issue.id, workspaceManager);
    this.handles.set(issue.id, { cancel: runHandle.cancel });
    void runHandle.completion.then(
      (completion) => {
        void this.serialize(() => {
          return this.handleRunCompletion(issue, startedAt, completion);
        });
      },
      (error: unknown) => {
        void this.serialize(() => {
          return this.handleRunCompletion(issue, startedAt, { ok: false, error: errorMessage(error) });
        });
      },
    );
  }

  private handleCodexEvent(issueId: string, event: CodexRuntimeEvent): void {
    const entry = this.state.running.get(issueId);
    if (entry === undefined) {
      return;
    }

    if (event.event === 'rate_limit_update') {
      this.state.codex_rate_limits = { at: event.timestamp, payload: event.payload ?? null };
    }

    const previousSession = entry.session;
    const sessionId = event.session_id ?? previousSession?.session_id;
    if (sessionId === undefined) {
      return;
    }

    const absoluteTokens = extractAbsoluteTokenTotals(event.usage) ?? extractAbsoluteTokenTotals(event.payload);
    const previousInput = previousSession?.codex_input_tokens ?? 0;
    const previousOutput = previousSession?.codex_output_tokens ?? 0;
    const previousTotal = previousSession?.codex_total_tokens ?? 0;
    const nextInput = absoluteTokens?.input_tokens ?? previousInput;
    const nextOutput = absoluteTokens?.output_tokens ?? previousOutput;
    const nextTotal = absoluteTokens?.total_tokens ?? previousTotal;

    this.state.codex_totals.input_tokens += Math.max(0, nextInput - (previousSession?.last_reported_input_tokens ?? 0));
    this.state.codex_totals.output_tokens += Math.max(0, nextOutput - (previousSession?.last_reported_output_tokens ?? 0));
    this.state.codex_totals.total_tokens += Math.max(0, nextTotal - (previousSession?.last_reported_total_tokens ?? 0));

    const sessionChanged = previousSession?.session_id !== sessionId;
    const nextSession: LiveSession = {
      session_id: sessionId,
      thread_id: event.thread_id ?? previousSession?.thread_id ?? '',
      turn_id: event.turn_id ?? previousSession?.turn_id ?? '',
      codex_app_server_pid: event.codex_app_server_pid === undefined ? previousSession?.codex_app_server_pid ?? null : String(event.codex_app_server_pid),
      last_codex_event: event.event,
      last_codex_timestamp: new Date(event.timestamp),
      last_codex_message: conciseEventMessage(event.payload),
      codex_input_tokens: nextInput,
      codex_output_tokens: nextOutput,
      codex_total_tokens: nextTotal,
      last_reported_input_tokens: nextInput,
      last_reported_output_tokens: nextOutput,
      last_reported_total_tokens: nextTotal,
      turn_count: sessionChanged ? (previousSession?.turn_count ?? 0) + 1 : previousSession.turn_count,
    };
    this.state.running.set(issueId, { ...entry, session: nextSession });
  }

  private scheduleDispatchFailureRetry(issue: Issue, error: unknown, previousAttempt: number): void {
    const attempt = previousAttempt + 1;
    const reason = errorMessage(error);
    this.writeLog({ level: 'warn', event: 'dispatch', outcome: 'retrying', issue_id: issue.id, issue_identifier: issue.identifier, reason });
    this.scheduleFailureRetry(issue, attempt, reason);
  }

  private async handleRunCompletion(issue: Issue, startedAt: Date, completion: RunCompletion): Promise<void> {
    const runningEntry = this.state.running.get(issue.id);
    if (runningEntry === undefined) {
      return;
    }
    const workspaceManager = this.workspaceManagersByIssueId.get(issue.id) ?? this.workspaceManager;
    this.state.running.delete(issue.id);
    this.handles.delete(issue.id);
    this.workspaceManagersByIssueId.delete(issue.id);
    await this.runAfterRunHookWithManager(workspaceManager, issue);
    this.state.codex_totals.input_tokens += completion.inputTokens ?? 0;
    this.state.codex_totals.output_tokens += completion.outputTokens ?? 0;
    this.state.codex_totals.total_tokens += completion.totalTokens ?? 0;
    this.state.codex_totals.seconds_running += Math.max(0, Math.floor((this.clock.now().getTime() - startedAt.getTime()) / 1000));
    try {
      this.issueLedger?.recordRunCompleted({
        issue,
        runId: runningEntry.run_id,
        ok: completion.ok,
        error: completion.ok ? null : completion.error ?? 'worker failed',
        at: this.clock.now(),
      });
    } catch (error) {
      this.state.completed.delete(issue.id);
      const attempt = (runningEntry.retry_attempt ?? 0) + 1;
      this.scheduleFailureRetry(issue, attempt, errorMessage(error));
      return;
    }
    await this.notifyIssueCompleted({ issue, runId: runningEntry.run_id, completion });
    if (completion.ok) {
      const config = getEffectiveConfig(this.workflow);
      this.state.completed.add(issue.id);
      if (config.agent.successContinuationDelayMs > 0) {
        this.scheduleRetry(issue, 1, null, config.agent.successContinuationDelayMs);
      } else {
        this.releaseClaim(issue.id);
      }
    } else {
      this.state.completed.delete(issue.id);
      const attempt = (runningEntry.retry_attempt ?? 0) + 1;
      const reason = completion.error ?? 'worker failed';
      this.writeLog({
        level: 'warn',
        event: 'agent_session',
        outcome: 'retrying',
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        ...(runningEntry.session === null ? {} : { session_id: runningEntry.session.session_id }),
        reason,
      });
      this.scheduleFailureRetry(issue, attempt, reason);
    }
  }

  private scheduleFailureRetry(issue: Issue, attempt: number, reason: string): void {
    const config = getEffectiveConfig(this.workflow);
    if (attempt > config.agent.maxFailureRetries) {
      this.openRetryCircuit(issue, attempt, reason, config.agent.maxFailureRetries);
      return;
    }
    this.scheduleRetry(issue, attempt, reason, this.failureDelayMs(attempt));
  }

  private openRetryCircuit(issue: Issue, attempt: number, reason: string, maxFailureRetries: number): void {
    const existing = this.state.retry_attempts.get(issue.id);
    if (existing?.timer_handle !== null && existing?.timer_handle !== undefined) {
      this.clock.clearTimeout(existing.timer_handle);
    }
    this.state.retry_attempts.delete(issue.id);
    this.state.claimed.delete(issue.id);
    this.state.failed.add(issue.id);
    this.writeLog({
      level: 'error',
      event: 'dispatch',
      outcome: 'retry_circuit_open',
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      reason,
      max_failure_retries: maxFailureRetries,
      retry_attempt: attempt,
    });
  }

  private scheduleRetry(issue: Issue, attempt: number, error: string | null, delayMs: number): void {
    const existing = this.state.retry_attempts.get(issue.id);
    if (existing?.timer_handle !== null && existing?.timer_handle !== undefined) {
      this.clock.clearTimeout(existing.timer_handle);
    }
    this.state.claimed.add(issue.id);
    const dueAtMs = this.clock.now().getTime() + delayMs;
    const timerHandle = this.clock.setTimeout(() => {
      void this.handleRetryTimer(issue.id);
    }, delayMs);
    this.state.retry_attempts.set(issue.id, {
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt,
      due_at_ms: dueAtMs,
      timer_handle: timerHandle,
      error,
    });
  }

  private async handleRetryTimer(issueId: string): Promise<void> {
    await this.serialize(async () => {
      const retryEntry = this.state.retry_attempts.get(issueId);
      if (retryEntry === undefined) {
        return;
      }
      const config = getEffectiveConfig(this.workflow);
      const candidates = await this.tracker.fetch_candidate_issues();
      const issue = candidates.find((candidate) => candidate.id === issueId);
      if (issue === undefined || !isActiveState(issue.state, config)) {
        this.releaseClaim(issueId);
        return;
      }
      this.state.claimed.delete(issueId);
      if (this.isIssueEligible(issue, config)) {
        await this.dispatchIssue(issue);
      } else {
        this.state.claimed.add(issueId);
        this.scheduleRetry(issue, retryEntry.attempt + 1, 'no available orchestrator slots', this.failureDelayMs(retryEntry.attempt + 1));
      }
    });
  }

  private releaseClaim(issueId: string): void {
    const retryEntry = this.state.retry_attempts.get(issueId);
    if (retryEntry?.timer_handle !== null && retryEntry?.timer_handle !== undefined) {
      this.clock.clearTimeout(retryEntry.timer_handle);
    }
    this.state.retry_attempts.delete(issueId);
    this.state.claimed.delete(issueId);
  }

  private async cancelRunning(issueId: string, reason: string): Promise<void> {
    const running = this.state.running.get(issueId);
    if (running === undefined) {
      return;
    }
    const handle = this.handles.get(issueId);
    const workspaceManager = this.workspaceManagersByIssueId.get(issueId) ?? this.workspaceManager;
    this.state.running.delete(issueId);
    this.handles.delete(issueId);
    this.workspaceManagersByIssueId.delete(issueId);
    this.state.claimed.delete(issueId);
    if (handle !== undefined) {
      await handle.cancel(reason);
    }
    try {
      this.issueLedger?.recordRunCanceled({ issue: running.issue, runId: running.run_id, reason, at: this.clock.now() });
    } catch {
      // Ledger cancellation receipts are best-effort after the run has already been canceled.
    }
    await this.notifyIssueCanceled(running.issue, running.run_id, reason);
    await this.runAfterRunHookWithManager(workspaceManager, running.issue);
  }

  private async runAfterRunHook(issue: Issue): Promise<void> {
    await this.runAfterRunHookWithManager(this.workspaceManager, issue);
  }

  private async notifyIssueStarted(input: OrchestratorLifecycleStartedInput): Promise<void> {
    try {
      await this.lifecycleNotifier?.onIssueStarted?.(input);
    } catch (error) {
      this.writeLog({ level: 'warn', event: 'linear_mutation', outcome: 'failed', issue_id: input.issue.id, issue_identifier: input.issue.identifier, reason: errorMessage(error) });
    }
  }

  private async notifyIssueCompleted(input: OrchestratorLifecycleCompletionInput): Promise<void> {
    try {
      await this.lifecycleNotifier?.onIssueCompleted?.(input);
    } catch (error) {
      this.writeLog({ level: 'warn', event: 'linear_mutation', outcome: 'failed', issue_id: input.issue.id, issue_identifier: input.issue.identifier, reason: errorMessage(error) });
    }
  }

  private async notifyIssueCanceled(issue: Issue, runId: string, reason: string): Promise<void> {
    try {
      await this.lifecycleNotifier?.onIssueCanceled?.({ issue, runId, reason });
    } catch (error) {
      this.writeLog({ level: 'warn', event: 'linear_mutation', outcome: 'failed', issue_id: issue.id, issue_identifier: issue.identifier, reason: errorMessage(error) });
    }
  }

  private async runAfterRunHookWithManager(workspaceManager: OrchestratorWorkspaceManager, issue: Issue): Promise<void> {
    try {
      await workspaceManager.runAfterRunHook(issue);
    } catch {
      // Spec-defined policy: after_run hook failures are warnings/nonfatal to the orchestrator.
    }
  }

  private failureDelayMs(attempt: number): number {
    const config = getEffectiveConfig(this.workflow);
    return Math.min(10000 * 2 ** (attempt - 1), config.agent.maxRetryBackoffMs);
  }

  private writeLog(entry: StructuredLogEntry): void {
    try {
      this.log(formatStructuredLogLine(entry));
    } catch {
      // Logging sink failures are intentionally nonfatal to preserve orchestration.
    }
  }
}

const realClock: OrchestratorClock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};

function runningSnapshot(entry: RunningIssueEntry): OrchestratorRunningSnapshot {
  return {
    issue_id: entry.issue.id,
    issue_identifier: entry.identifier,
    identifier: entry.identifier,
    run_id: entry.run_id,
    state: entry.issue.state,
    session_id: entry.session?.session_id ?? null,
    turn_count: entry.session?.turn_count ?? 0,
    last_event: entry.session?.last_codex_event ?? null,
    last_message: entry.session?.last_codex_message ?? null,
    started_at: entry.started_at.toISOString(),
    last_event_at: entry.session?.last_codex_timestamp?.toISOString() ?? null,
    tokens: {
      input_tokens: entry.session?.codex_input_tokens ?? 0,
      output_tokens: entry.session?.codex_output_tokens ?? 0,
      total_tokens: entry.session?.codex_total_tokens ?? 0,
    },
  };
}

function extractAbsoluteTokenTotals(value: JsonValue | JsonObject | undefined): { readonly input_tokens?: number; readonly output_tokens?: number; readonly total_tokens?: number } | null {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const source = selectTokenSource(value);
  const inputTokens = numericField(source, ['input_tokens', 'inputTokens', 'input', 'prompt_tokens', 'promptTokens']);
  const outputTokens = numericField(source, ['output_tokens', 'outputTokens', 'output', 'completion_tokens', 'completionTokens']);
  const totalTokens = numericField(source, ['total_tokens', 'totalTokens', 'total']);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return null;
  }
  return {
    ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
    ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
    ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
  };
}

function selectTokenSource(source: JsonObject): JsonObject {
  const totalTokenUsage = source['total_token_usage'];
  if (isJsonObject(totalTokenUsage)) {
    return totalTokenUsage;
  }
  const threadTokenUsage = source['thread_token_usage'];
  if (isJsonObject(threadTokenUsage)) {
    return threadTokenUsage;
  }
  return source;
}

function numericField(source: JsonObject, fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const value = source[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function conciseEventMessage(payload: JsonValue | undefined): string | null {
  if (!isJsonObject(payload)) {
    return null;
  }
  const message = payload['message'];
  if (typeof message !== 'string') {
    return null;
  }
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasRequiredIssueFields(issue: Issue): boolean {
  return issue.id.trim() !== '' && issue.identifier.trim() !== '' && issue.title.trim() !== '' && issue.state.trim() !== '';
}

function isActiveState(state: string | null, config: EffectiveConfig): boolean {
  if (state === null) {
    return false;
  }
  const normalized = normalizeIssueStateName(state);
  return config.tracker.activeStates.some((activeState) => normalizeIssueStateName(activeState) === normalized);
}

function isTerminalState(state: string | null, config: EffectiveConfig): boolean {
  if (state === null) {
    return false;
  }
  const normalized = normalizeIssueStateName(state);
  return config.tracker.terminalStates.some((terminalState) => normalizeIssueStateName(terminalState) === normalized);
}

function availableGlobalSlots(state: MutableRuntimeState): number {
  return Math.max(state.max_concurrent_agents - state.running.size, 0);
}

function compareIssuesForDispatch(left: Issue, right: Issue): number {
  const priorityComparison = sortablePriority(left.priority) - sortablePriority(right.priority);
  if (priorityComparison !== 0) {
    return priorityComparison;
  }
  const createdComparison = sortableCreatedAt(left.created_at) - sortableCreatedAt(right.created_at);
  if (createdComparison !== 0) {
    return createdComparison;
  }
  return left.identifier.localeCompare(right.identifier);
}

function sortablePriority(priority: number | null): number {
  return priority ?? Number.MAX_SAFE_INTEGER;
}

function sortableCreatedAt(createdAt: Date | null): number {
  return createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
