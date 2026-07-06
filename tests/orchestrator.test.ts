import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Issue } from '../src/domain.js';
import {
  SymphonyOrchestrator,
  type OrchestratorAgentRunner,
  type OrchestratorClock,
  type OrchestratorIssueTracker,
  type OrchestratorWorkspaceManager,
  type RunCompletion,
} from '../src/orchestrator.js';
import { JsonFileIssueRunLedger } from '../src/issue-run-ledger.js';
import type { WorkflowDefinition } from '../src/workflow.js';

const workflow: WorkflowDefinition = {
  config: {
    tracker: { kind: 'linear', api_key: 'test-token', project_slug: 'CORE' },
    polling: { interval_ms: 5000 },
    workspace: { root: '/tmp/symphony-test-workspaces' },
    agent: { max_concurrent_agents: 2, max_concurrent_agents_by_state: { Todo: 1 } },
    codex: { command: 'fake-codex', stall_timeout_ms: 10000 },
  },
  prompt_template: 'Work on {{ issue.identifier }}',
  workflow_path: '/repo/WORKFLOW.md',
};

function issue(input: {
  readonly id: string;
  readonly identifier: string;
  readonly title?: string;
  readonly state?: string;
  readonly priority?: number | null;
  readonly createdAt?: string | null;
  readonly blockers?: readonly { readonly id: string | null; readonly identifier: string | null; readonly state: string | null }[];
}): Issue {
  return {
    id: input.id,
    identifier: input.identifier,
    title: input.title ?? `Title ${input.identifier}`,
    description: null,
    priority: input.priority ?? null,
    state: input.state ?? 'Todo',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: input.blockers ?? [],
    created_at: input.createdAt === null ? null : new Date(input.createdAt ?? '2026-01-01T00:00:00.000Z'),
    updated_at: null,
  };
}

class FakeClock implements OrchestratorClock {
  public nowMs = 0;
  public readonly delays: number[] = [];
  private nextHandle = 1;
  private readonly callbacks = new Map<number, () => void>();

  public now(): Date {
    return new Date(this.nowMs);
  }

  public setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.delays.push(delayMs);
    this.callbacks.set(handle, callback);
    return handle as unknown as NodeJS.Timeout;
  }

  public clearTimeout(handle: NodeJS.Timeout): void {
    this.callbacks.delete(Number(handle));
  }

  public fire(handle: number): void {
    const callback = this.callbacks.get(handle);
    if (callback !== undefined) {
      this.callbacks.delete(handle);
      callback();
    }
  }
}

class FakeTracker implements OrchestratorIssueTracker {
  public candidates: readonly Issue[] = [];
  public terminalIssues: readonly Issue[] = [];
  public statesById = new Map<string, Issue>();
  public failStateRefresh = false;
  public readonly calls: string[] = [];

  public fetch_candidate_issues(): Promise<readonly Issue[]> {
    this.calls.push('fetch_candidate_issues');
    return Promise.resolve(this.candidates);
  }

  public fetch_terminal_issues(): Promise<readonly Issue[]> {
    this.calls.push('fetch_terminal_issues');
    return Promise.resolve(this.terminalIssues);
  }

  public fetch_issue_states_by_ids(issueIds: readonly string[]): Promise<readonly Issue[]> {
    this.calls.push(`fetch_issue_states_by_ids:${issueIds.join(',')}`);
    if (this.failStateRefresh) {
      return Promise.reject(new Error('state refresh failed'));
    }
    return Promise.resolve(issueIds.flatMap((id) => {
      const found = this.statesById.get(id);
      return found === undefined ? [] : [found];
    }));
  }
}

class FakeWorkspaceManager implements OrchestratorWorkspaceManager {
  public readonly prepared: string[] = [];
  public readonly cleaned: string[] = [];
  public readonly afterRun: string[] = [];
  public failPrepareFor: string | null = null;

  public prepareWorkspace(issueToPrepare: Issue): Promise<{ readonly workspacePath: string }> {
    this.prepared.push(issueToPrepare.identifier);
    if (this.failPrepareFor === issueToPrepare.identifier) {
      return Promise.reject(new Error('prepare failed'));
    }
    return Promise.resolve({ workspacePath: `/tmp/symphony-test-workspaces/${issueToPrepare.identifier}` });
  }

  public cleanupTerminalWorkspace(issueToClean: Issue): Promise<void> {
    this.cleaned.push(issueToClean.identifier);
    return Promise.resolve();
  }

  public runAfterRunHook(issueAfterRun: Issue): Promise<void> {
    this.afterRun.push(issueAfterRun.identifier);
    return Promise.resolve();
  }
}

class ControlledRunner implements OrchestratorAgentRunner {
  public readonly started: Issue[] = [];
  public readonly cancelled: string[] = [];
  public throwFor: string | null = null;
  private readonly pending: { readonly issue: Issue; readonly resolve: (completion: RunCompletion) => void; readonly reject: (error: Error) => void; readonly onEvent: NonNullable<Parameters<OrchestratorAgentRunner['runIssue']>[0]['onEvent']> | undefined }[] = [];

  public runIssue(input: Parameters<OrchestratorAgentRunner['runIssue']>[0]): { readonly completion: Promise<RunCompletion>; readonly cancel: (reason: string) => Promise<void> } {
    this.started.push(input.issue);
    if (this.throwFor === input.issue.identifier) {
      throw new Error('runner launch failed');
    }
    const completion = new Promise<RunCompletion>((resolve, reject) => {
      this.pending.push({ issue: input.issue, resolve, reject, onEvent: input.onEvent });
    });
    return {
      completion,
      cancel: (reason: string): Promise<void> => {
        this.cancelled.push(`${input.issue.identifier}:${reason}`);
        return Promise.resolve();
      },
    };
  }

  public emit(identifier: string, event: Parameters<NonNullable<Parameters<OrchestratorAgentRunner['runIssue']>[0]['onEvent']>>[0]): void {
    const pending = this.pending.find((entry) => entry.issue.identifier === identifier);
    if (pending === undefined) {
      throw new Error(`No pending run for ${identifier}`);
    }
    pending.onEvent?.(event);
  }

  public finish(identifier: string, completion: RunCompletion): void {
    const pending = this.pending.find((entry) => entry.issue.identifier === identifier);
    if (pending === undefined) {
      throw new Error(`No pending run for ${identifier}`);
    }
    pending.resolve(completion);
  }

  public reject(identifier: string, error: Error): void {
    const pending = this.pending.find((entry) => entry.issue.identifier === identifier);
    if (pending === undefined) {
      throw new Error(`No pending run for ${identifier}`);
    }
    pending.reject(error);
  }
}


describe('SymphonyOrchestrator scheduler', () => {
  it('reconciles, validates, sorts, filters, and dispatches eligible issues in deterministic order', async () => {
    const tracker = new FakeTracker();
    const workspaces = new FakeWorkspaceManager();
    const runner = new ControlledRunner();
    const clock = new FakeClock();
    tracker.candidates = [
      issue({ id: 'blocked', identifier: 'CORE-9', priority: 1, createdAt: '2026-01-01T00:00:00.000Z', blockers: [{ id: 'dep', identifier: 'CORE-0', state: 'Todo' }] }),
      issue({ id: 'b', identifier: 'CORE-2', priority: 2, createdAt: '2026-01-01T00:00:00.000Z' }),
      issue({ id: 'c', identifier: 'CORE-3', priority: 1, createdAt: '2025-12-31T00:00:00.000Z' }),
      issue({ id: 'a', identifier: 'CORE-1', priority: 1, createdAt: '2026-01-02T00:00:00.000Z', state: 'In Progress' }),
      { ...issue({ id: 'missing-title', identifier: 'CORE-X' }), title: '' },
    ];
    const orchestrator = new SymphonyOrchestrator({ workflow, tracker, workspaceManager: workspaces, runner, clock });

    await orchestrator.tick();

    expect(tracker.calls).toEqual(['fetch_issue_states_by_ids:', 'fetch_candidate_issues']);
    expect(runner.started.map((startedIssue) => startedIssue.identifier)).toEqual(['CORE-3', 'CORE-1']);
    expect(workspaces.prepared).toEqual(['CORE-3', 'CORE-1']);
    expect(orchestrator.snapshot().claimed).toEqual(['c', 'a']);
  });

  it('keeps in-flight workspace ownership stable across runtime dependency reloads', async () => {
    const tracker = new FakeTracker();
    const originalWorkspaces = new FakeWorkspaceManager();
    const originalRunner = new ControlledRunner();
    const clock = new FakeClock();
    const completesNormally = issue({ id: 'complete', identifier: 'CORE-10', state: 'Todo' });
    const becomesTerminal = issue({ id: 'terminal', identifier: 'CORE-11', state: 'In Progress' });
    tracker.candidates = [completesNormally, becomesTerminal];
    const orchestrator = new SymphonyOrchestrator({ workflow, tracker, workspaceManager: originalWorkspaces, runner: originalRunner, clock });

    await orchestrator.tick();

    expect(originalWorkspaces.prepared).toEqual(expect.arrayContaining(['CORE-10', 'CORE-11']));
    const reloadedTracker = new FakeTracker();
    const reloadedWorkspaces = new FakeWorkspaceManager();
    const reloadedRunner = new ControlledRunner();
    orchestrator.updateWorkflowRuntime({
      workflow: { ...workflow, prompt_template: 'Reloaded prompt' },
      tracker: reloadedTracker,
      workspaceManager: reloadedWorkspaces,
      runner: reloadedRunner,
    });

    originalRunner.finish('CORE-10', { ok: true });
    await orchestrator.drain();

    expect(originalWorkspaces.afterRun).toContain('CORE-10');
    expect(reloadedWorkspaces.afterRun).not.toContain('CORE-10');

    reloadedTracker.statesById.set('terminal', { ...becomesTerminal, state: 'Done' });
    reloadedTracker.candidates = [issue({ id: 'new', identifier: 'CORE-12', state: 'In Progress' })];
    await orchestrator.tick();

    expect(originalRunner.cancelled).toContain('CORE-11:terminal-state');
    expect(originalWorkspaces.afterRun).toContain('CORE-11');
    expect(originalWorkspaces.cleaned).toContain('CORE-11');
    expect(reloadedWorkspaces.afterRun).not.toContain('CORE-11');
    expect(reloadedWorkspaces.cleaned).not.toContain('CORE-11');
    expect(reloadedWorkspaces.prepared).toContain('CORE-12');
    expect(reloadedRunner.started.map((startedIssue) => startedIssue.identifier)).toContain('CORE-12');
  });

  it('skips dispatch after validation errors while still reconciling first and logging operator-visible errors', async () => {
    const tracker = new FakeTracker();
    const logs: string[] = [];
    const orchestrator = new SymphonyOrchestrator({
      workflow: { ...workflow, config: { tracker: { kind: 'linear' } }, prompt_template: workflow.prompt_template, workflow_path: workflow.workflow_path },
      tracker,
      workspaceManager: new FakeWorkspaceManager(),
      runner: new ControlledRunner(),
      clock: new FakeClock(),
      log: (line) => logs.push(line),
    });

    await orchestrator.tick();

    expect(tracker.calls).toEqual(['fetch_issue_states_by_ids:']);
    expect(orchestrator.snapshot().last_preflight_errors.map((error) => error.code)).toContain('missing_tracker_api_key');
    expect(logs).toEqual(expect.arrayContaining([
      expect.stringContaining('level=error event=dispatch_validation outcome=failed'),
    ]));
  });

  it('converts workspace, launch, and completion promise failures into retry state instead of leaked claims', async () => {
    const tracker = new FakeTracker();
    const workspaces = new FakeWorkspaceManager();
    const runner = new ControlledRunner();
    const clock = new FakeClock();
    const logs: string[] = [];
    const orchestrator = new SymphonyOrchestrator({ workflow, tracker, workspaceManager: workspaces, runner, clock, log: (line) => logs.push(line) });

    workspaces.failPrepareFor = 'CORE-1';
    tracker.candidates = [issue({ id: 'prepare', identifier: 'CORE-1' })];
    await orchestrator.tick();

    expect(orchestrator.snapshot().running).toEqual([]);
    expect(orchestrator.snapshot().retry_attempts).toMatchObject([{ issue_id: 'prepare', identifier: 'CORE-1', attempt: 1, error: 'prepare failed' }]);
    expect(logs).toContain('level=warn event=dispatch outcome=retrying issue_id=prepare issue_identifier=CORE-1 reason="prepare failed"');

    workspaces.failPrepareFor = null;
    runner.throwFor = 'CORE-2';
    tracker.candidates = [issue({ id: 'launch', identifier: 'CORE-2' })];
    await orchestrator.tick();

    expect(orchestrator.snapshot().running).toEqual([]);
    expect(workspaces.afterRun).toContain('CORE-2');
    expect(orchestrator.snapshot().retry_attempts).toEqual(
      expect.arrayContaining([expect.objectContaining({ issue_id: 'launch', identifier: 'CORE-2', attempt: 1, error: 'runner launch failed' })]),
    );

    runner.throwFor = null;
    tracker.candidates = [issue({ id: 'reject', identifier: 'CORE-3', state: 'In Progress' })];
    await orchestrator.tick();
    runner.reject('CORE-3', new Error('completion rejected'));
    await orchestrator.drain();

    expect(orchestrator.snapshot().running).toEqual([]);
    expect(orchestrator.snapshot().retry_attempts).toEqual(
      expect.arrayContaining([expect.objectContaining({ issue_id: 'reject', identifier: 'CORE-3', attempt: 1, error: 'completion rejected' })]),
    );
    expect(logs).toContain('level=warn event=agent_session outcome=retrying issue_id=reject issue_identifier=CORE-3 reason="completion rejected"');
  });

  it('preserves retry attempt counters when a retried running issue stalls', async () => {
    const tracker = new FakeTracker();
    const runner = new ControlledRunner();
    const clock = new FakeClock();
    const orchestrator = new SymphonyOrchestrator({ workflow, tracker, workspaceManager: new FakeWorkspaceManager(), runner, clock });
    const retriedIssue = issue({ id: 'retry-stall', identifier: 'CORE-11', state: 'In Progress' });

    orchestrator.queueFailureRetry(retriedIssue, 2, 'prior failure');
    tracker.candidates = [retriedIssue];
    const retryHandle = orchestrator.snapshot().retry_attempts[0]?.timer_handle;
    if (typeof retryHandle === 'number') {
      clock.fire(retryHandle);
    }
    await orchestrator.drain();

    clock.nowMs = 10001;
    tracker.statesById.set('retry-stall', retriedIssue);
    await orchestrator.tick();

    expect(runner.cancelled).toEqual(['CORE-11:stalled']);
    expect(orchestrator.snapshot().retry_attempts).toMatchObject([
      { issue_id: 'retry-stall', identifier: 'CORE-11', attempt: 3, error: 'stalled' },
    ]);
  });

  it('preserves retry attempt counters when a retried dispatch fails again', async () => {
    const tracker = new FakeTracker();
    const workspaces = new FakeWorkspaceManager();
    const runner = new ControlledRunner();
    const clock = new FakeClock();
    const orchestrator = new SymphonyOrchestrator({ workflow, tracker, workspaceManager: workspaces, runner, clock });
    const retriedIssue = issue({ id: 'retry-fail', identifier: 'CORE-10' });

    orchestrator.queueFailureRetry(retriedIssue, 2, 'prior failure');
    workspaces.failPrepareFor = 'CORE-10';
    tracker.candidates = [retriedIssue];
    const retryHandle = orchestrator.snapshot().retry_attempts[0]?.timer_handle;
    if (typeof retryHandle === 'number') {
      clock.fire(retryHandle);
    }
    await orchestrator.drain();

    expect(orchestrator.snapshot().retry_attempts).toMatchObject([
      { issue_id: 'retry-fail', identifier: 'CORE-10', attempt: 3, error: 'prepare failed', due_at_ms: 40000 },
    ]);
  });

  it('opens the retry circuit after the configured failure retry limit and suppresses redispatch', async () => {
    const tracker = new FakeTracker();
    const workspaces = new FakeWorkspaceManager();
    const runner = new ControlledRunner();
    const clock = new FakeClock();
    const logs: string[] = [];
    const circuitWorkflow: WorkflowDefinition = {
      ...workflow,
      config: {
        ...workflow.config,
        agent: {
          max_concurrent_agents: 2,
          max_concurrent_agents_by_state: { Todo: 1 },
          max_failure_retries: 2,
        },
      },
    };
    const circuitIssue = issue({ id: 'circuit', identifier: 'CORE-CB' });
    tracker.candidates = [circuitIssue];
    workspaces.failPrepareFor = 'CORE-CB';
    const orchestrator = new SymphonyOrchestrator({
      workflow: circuitWorkflow,
      tracker,
      workspaceManager: workspaces,
      runner,
      clock,
      log: (line) => logs.push(line),
    });

    await orchestrator.tick();
    for (let retry = 0; retry < 2; retry += 1) {
      const retryHandle = orchestrator.snapshot().retry_attempts[0]?.timer_handle;
      expect(retryHandle).toBeTypeOf('number');
      if (typeof retryHandle === 'number') {
        clock.fire(retryHandle);
      }
      await orchestrator.drain();
    }

    expect(workspaces.prepared).toEqual(['CORE-CB', 'CORE-CB', 'CORE-CB']);
    expect(orchestrator.snapshot().retry_attempts).toEqual([]);
    expect(orchestrator.snapshot().claimed).not.toContain('circuit');
    expect(logs).toContain('level=error event=dispatch outcome=retry_circuit_open issue_id=circuit issue_identifier=CORE-CB reason="prepare failed" max_failure_retries=2 retry_attempt=3');

    await orchestrator.tick();

    expect(workspaces.prepared).toEqual(['CORE-CB', 'CORE-CB', 'CORE-CB']);
  });

  it('schedules clean-exit continuation retries after 1000ms and failure retries with capped exponential backoff', async () => {
    const tracker = new FakeTracker();
    const runner = new ControlledRunner();
    const clock = new FakeClock();
    const workspaces = new FakeWorkspaceManager();
    tracker.candidates = [issue({ id: 'a', identifier: 'CORE-1' })];
    const orchestrator = new SymphonyOrchestrator({ workflow, tracker, workspaceManager: workspaces, runner, clock });

    await orchestrator.tick();
    runner.finish('CORE-1', { ok: true, inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    await orchestrator.drain();

    expect(clock.delays).toEqual([1000]);
    expect(workspaces.afterRun).toContain('CORE-1');
    expect(orchestrator.snapshot().running).toEqual([]);
    expect(orchestrator.snapshot().retry_attempts).toMatchObject([{ attempt: 1, due_at_ms: 1000, error: null, identifier: 'CORE-1', issue_id: 'a' }]);
    expect(orchestrator.snapshot().codex_totals).toMatchObject({ input_tokens: 3, output_tokens: 4, total_tokens: 7 });

    tracker.candidates = [issue({ id: 'b', identifier: 'CORE-2' })];
    await orchestrator.tick();
    runner.finish('CORE-2', { ok: false, error: 'boom' });
    await orchestrator.drain();

    expect(clock.delays[clock.delays.length - 1]).toBe(10000);
    expect(workspaces.afterRun).toContain('CORE-2');
    const retrySnapshots = orchestrator.snapshot().retry_attempts;
    expect(retrySnapshots[retrySnapshots.length - 1]).toMatchObject({ issue_id: 'b', attempt: 1, error: 'boom' });
  });

  it('can disable clean-exit continuation retries and suppress in-process redispatch of completed issues', async () => {
    const tracker = new FakeTracker();
    const runner = new ControlledRunner();
    const clock = new FakeClock();
    const workspaces = new FakeWorkspaceManager();
    const noContinuationWorkflow: WorkflowDefinition = {
      ...workflow,
      config: {
        ...workflow.config,
        agent: {
          max_concurrent_agents: 2,
          max_concurrent_agents_by_state: { Todo: 1 },
          success_continuation_delay_ms: 0,
        },
      },
    };
    tracker.candidates = [issue({ id: 'a', identifier: 'CORE-1' })];
    const orchestrator = new SymphonyOrchestrator({ workflow: noContinuationWorkflow, tracker, workspaceManager: workspaces, runner, clock });

    await orchestrator.tick();
    runner.finish('CORE-1', { ok: true });
    await orchestrator.drain();
    await orchestrator.tick();

    expect(clock.delays).toEqual([]);
    expect(workspaces.afterRun).toContain('CORE-1');
    expect(orchestrator.snapshot().running).toEqual([]);
    expect(orchestrator.snapshot().retry_attempts).toEqual([]);
    expect(orchestrator.snapshot().claimed).toEqual([]);
    expect(orchestrator.snapshot().completed).toEqual(['a']);
    expect(runner.started.map((startedIssue) => startedIssue.identifier)).toEqual(['CORE-1']);
  });

  it('runs after_run hook when reconciliation cancels a stalled, terminal, or inactive run', async () => {
    const tracker = new FakeTracker();
    const runner = new ControlledRunner();
    const clock = new FakeClock();
    const workspaces = new FakeWorkspaceManager();
    const orchestrator = new SymphonyOrchestrator({ workflow, tracker, workspaceManager: workspaces, runner, clock });

    tracker.candidates = [issue({ id: 'stall-after', identifier: 'CORE-A' })];
    await orchestrator.tick();
    clock.nowMs = 10001;
    await orchestrator.tick();

    tracker.candidates = [issue({ id: 'done-after', identifier: 'CORE-B', state: 'In Progress' })];
    await orchestrator.tick();
    tracker.statesById.set('done-after', issue({ id: 'done-after', identifier: 'CORE-B', state: 'Done' }));
    await orchestrator.tick();

    tracker.candidates = [issue({ id: 'inactive-after', identifier: 'CORE-C', state: 'In Progress' })];
    await orchestrator.tick();
    tracker.statesById.set('inactive-after', issue({ id: 'inactive-after', identifier: 'CORE-C', state: 'Human Review' }));
    await orchestrator.tick();

    expect(workspaces.afterRun).toEqual(expect.arrayContaining(['CORE-A', 'CORE-B', 'CORE-C']));
  });

  it('handles retry timers by re-fetching active candidates, dispatching when eligible, and requeueing when slots are full', async () => {
    const tracker = new FakeTracker();
    const runner = new ControlledRunner();
    const clock = new FakeClock();
    const orchestrator = new SymphonyOrchestrator({ workflow, tracker, workspaceManager: new FakeWorkspaceManager(), runner, clock });
    const retryIssue = issue({ id: 'retry', identifier: 'CORE-7' });

    orchestrator.queueFailureRetry(retryIssue, 2, 'previous failure');
    tracker.candidates = [retryIssue];
    const handle = orchestrator.snapshot().retry_attempts[0]?.timer_handle;
    expect(handle).toBeTypeOf('number');
    if (typeof handle === 'number') {
      clock.fire(handle);
    }
    await orchestrator.drain();

    expect(runner.started.map((startedIssue) => startedIssue.identifier)).toEqual(['CORE-7']);

    orchestrator.queueFailureRetry(issue({ id: 'queued', identifier: 'CORE-8' }), 3, 'again');
    tracker.candidates = [issue({ id: 'queued', identifier: 'CORE-8' })];
    const retryHandle = orchestrator.snapshot().retry_attempts.find((entry) => entry.issue_id === 'queued')?.timer_handle;
    if (typeof retryHandle === 'number') {
      clock.fire(retryHandle);
    }
    await orchestrator.drain();

    expect(orchestrator.snapshot().retry_attempts.find((entry) => entry.issue_id === 'queued')).toMatchObject({
      attempt: 4,
      error: 'no available orchestrator slots',
    });
  });

  it('reconciles stalls, terminal states, inactive states, and failed tracker refreshes per spec', async () => {
    const tracker = new FakeTracker();
    const runner = new ControlledRunner();
    const clock = new FakeClock();
    const workspaces = new FakeWorkspaceManager();
    tracker.candidates = [issue({ id: 'stall', identifier: 'CORE-1' })];
    const orchestrator = new SymphonyOrchestrator({ workflow, tracker, workspaceManager: workspaces, runner, clock });

    await orchestrator.tick();
    clock.nowMs = 10001;
    tracker.statesById.set('done', issue({ id: 'done', identifier: 'CORE-2', state: 'Done' }));
    await orchestrator.tick();

    expect(runner.cancelled).toEqual(['CORE-1:stalled']);
    expect(orchestrator.snapshot().retry_attempts.map((entry) => entry.identifier)).toContain('CORE-1');

    tracker.candidates = [issue({ id: 'done', identifier: 'CORE-2', state: 'In Progress' })];
    await orchestrator.tick();
    tracker.statesById.set('done', issue({ id: 'done', identifier: 'CORE-2', state: 'Done' }));
    await orchestrator.tick();

    expect(runner.cancelled).toContain('CORE-2:terminal-state');
    expect(workspaces.cleaned).toEqual(['CORE-2']);

    tracker.candidates = [issue({ id: 'review', identifier: 'CORE-3', state: 'In Progress' })];
    await orchestrator.tick();
    tracker.statesById.set('review', issue({ id: 'review', identifier: 'CORE-3', state: 'Human Review' }));
    await orchestrator.tick();

    expect(runner.cancelled).toContain('CORE-3:inactive-state');
    expect(workspaces.cleaned).not.toContain('CORE-3');

    tracker.candidates = [issue({ id: 'kept', identifier: 'CORE-4', state: 'In Progress' })];
    await orchestrator.tick();
    tracker.failStateRefresh = true;
    await orchestrator.tick();

    expect(orchestrator.snapshot().running.map((entry) => entry.identifier)).toContain('CORE-4');
  });

  it('cleans terminal workspaces during startup cleanup and releases retry claims when the issue disappears', async () => {
    const tracker = new FakeTracker();
    const workspaces = new FakeWorkspaceManager();
    const clock = new FakeClock();
    const orchestrator = new SymphonyOrchestrator({ workflow, tracker, workspaceManager: workspaces, runner: new ControlledRunner(), clock });
    tracker.terminalIssues = [issue({ id: 'done', identifier: 'CORE-1', state: 'Done' })];

    await orchestrator.startupCleanup();

    expect(workspaces.cleaned).toEqual(['CORE-1']);

    orchestrator.queueFailureRetry(issue({ id: 'missing', identifier: 'CORE-404' }), 1, 'gone');
    tracker.candidates = [];
    const handle = orchestrator.snapshot().retry_attempts[0]?.timer_handle;
    if (typeof handle === 'number') {
      clock.fire(handle);
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(orchestrator.snapshot().claimed).not.toContain('missing');
    expect(orchestrator.snapshot().retry_attempts).toEqual([]);
  });

  it('exposes Section 13 runtime snapshot rows with session metrics, latest rate limits, live runtime totals, and recommended error modes', async () => {
    const tracker = new FakeTracker();
    const runner = new ControlledRunner();
    const clock = new FakeClock();
    tracker.candidates = [issue({ id: 'run', identifier: 'CORE-13', state: 'In Progress' })];
    const orchestrator = new SymphonyOrchestrator({ workflow, tracker, workspaceManager: new FakeWorkspaceManager(), runner, clock });

    await orchestrator.tick();
    runner.emit('CORE-13', {
      event: 'session_started',
      timestamp: '2026-01-01T00:00:02.000Z',
      codex_app_server_pid: 4242,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
    });
    runner.emit('CORE-13', {
      event: 'token_usage',
      timestamp: '2026-01-01T00:00:03.000Z',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
    runner.emit('CORE-13', {
      event: 'rate_limit_update',
      timestamp: '2026-01-01T00:00:04.000Z',
      session_id: 'thread-1-turn-1',
      payload: { reset_at: '2030-01-01T00:00:00Z' },
    });
    clock.nowMs = 2500;

    const snapshot = orchestrator.snapshot();

    expect(snapshot.error_modes).toEqual(['timeout', 'unavailable']);
    expect(snapshot.running).toEqual([
      expect.objectContaining({
        issue_id: 'run',
        issue_identifier: 'CORE-13',
        session_id: 'thread-1-turn-1',
        turn_count: 1,
        last_event: 'rate_limit_update',
        started_at: '1970-01-01T00:00:00.000Z',
        last_event_at: '2026-01-01T00:00:04.000Z',
        tokens: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    ]);
    expect(snapshot.retrying).toEqual([]);
    expect(snapshot.codex_totals).toMatchObject({ input_tokens: 10, output_tokens: 5, total_tokens: 15, seconds_running: 2 });
    expect(snapshot.rate_limits).toEqual({ at: '2026-01-01T00:00:04.000Z', payload: { reset_at: '2030-01-01T00:00:00Z' } });
  });

  it('does not redispatch issues completed in the durable ledger after service restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-orchestrator-ledger-'));
    const ledgerPath = join(root, 'issue-ledger.json');
    const tracker = new FakeTracker();
    const runner = new ControlledRunner();
    const ledger = new JsonFileIssueRunLedger(ledgerPath);
    const durableIssue = issue({ id: 'durable', identifier: 'CORE-LEDGER', state: 'Todo' });
    tracker.candidates = [durableIssue];
    const orchestrator = new SymphonyOrchestrator({
      workflow,
      tracker,
      workspaceManager: new FakeWorkspaceManager(),
      runner,
      clock: new FakeClock(),
      issueLedger: ledger,
    });

    await orchestrator.tick();
    runner.finish('CORE-LEDGER', { ok: true });
    await orchestrator.drain();

    const restartedTracker = new FakeTracker();
    restartedTracker.candidates = [durableIssue];
    const restartedRunner = new ControlledRunner();
    const restarted = new SymphonyOrchestrator({
      workflow,
      tracker: restartedTracker,
      workspaceManager: new FakeWorkspaceManager(),
      runner: restartedRunner,
      clock: new FakeClock(),
      issueLedger: new JsonFileIssueRunLedger(ledgerPath),
    });

    await restarted.tick();

    expect(restarted.snapshot().completed).toContain('durable');
    expect(restarted.snapshot().ledger).toMatchObject({ path: ledgerPath, completed_issue_count: 1 });
    expect(restartedRunner.started).toEqual([]);
  });
});
