import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Issue } from '../src/domain.js';
import { CodexAppServerRunner, type CodexRuntimeEvent } from '../src/codex-runner.js';
import {
  SymphonyOrchestrator,
  type OrchestratorAgentRunner,
  type OrchestratorClock,
  type OrchestratorIssueTracker,
  type OrchestratorWorkspaceManager,
  type RunCompletion,
} from '../src/orchestrator.js';
import type { WorkflowDefinition } from '../src/workflow.js';
import { WorkspaceManager, type PreparedWorkspace } from '../src/workspace.js';

class FakeClock implements OrchestratorClock {
  public nowMs = 0;
  private nextHandle = 1;
  private readonly callbacks = new Map<number, () => void>();

  public now(): Date {
    return new Date(this.nowMs);
  }

  public setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout {
    void delayMs;
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.set(handle, callback);
    return handle as unknown as NodeJS.Timeout;
  }

  public clearTimeout(handle: NodeJS.Timeout): void {
    this.callbacks.delete(Number(handle));
  }
}

class FakeLinearTracker implements OrchestratorIssueTracker {
  public candidates: readonly Issue[] = [];
  public stateById = new Map<string, Issue>();
  public readonly calls: string[] = [];

  public fetch_candidate_issues(): Promise<readonly Issue[]> {
    this.calls.push('fetch_candidate_issues');
    return Promise.resolve(this.candidates);
  }

  public fetch_terminal_issues(): Promise<readonly Issue[]> {
    this.calls.push('fetch_terminal_issues');
    return Promise.resolve([]);
  }

  public fetch_issue_states_by_ids(issueIds: readonly string[]): Promise<readonly Issue[]> {
    this.calls.push(`fetch_issue_states_by_ids:${issueIds.join(',')}`);
    return Promise.resolve(issueIds.flatMap((id) => {
      const issue = this.stateById.get(id);
      return issue === undefined ? [] : [issue];
    }));
  }
}

class WorkspaceManagerAdapter implements OrchestratorWorkspaceManager {
  public readonly prepared = new Map<string, PreparedWorkspace>();

  public constructor(private readonly manager: WorkspaceManager) {}

  public async prepareWorkspace(issue: Issue): Promise<{ readonly workspacePath: string }> {
    const workspace = await this.manager.prepareWorkspace(issue);
    await this.manager.runBeforeRunHook(workspace);
    this.prepared.set(issue.id, workspace);
    return { workspacePath: workspace.workspacePath };
  }

  public async runAfterRunHook(issue: Issue): Promise<void> {
    const workspace = this.prepared.get(issue.id);
    if (workspace !== undefined) {
      await this.manager.runAfterRunHook(workspace);
    }
  }

  public async cleanupTerminalWorkspace(issue: Issue): Promise<void> {
    const workspace = this.prepared.get(issue.id);
    if (workspace !== undefined) {
      await this.manager.cleanupTerminalWorkspace(workspace);
    }
  }
}

class FakeCodexOrchestratorRunner implements OrchestratorAgentRunner {
  public readonly events: CodexRuntimeEvent[] = [];
  public readonly completions: Promise<RunCompletion>[] = [];

  public constructor(private readonly codexRunner: CodexAppServerRunner) {}

  public runIssue(input: {
    readonly issue: Issue;
    readonly workspacePath: string;
    readonly promptTemplate: string;
    readonly retryAttempt: number | null;
  }): { readonly completion: Promise<RunCompletion>; readonly cancel: (reason: string) => Promise<void> } {
    const startedAt = Date.now();
    const completion = this.codexRunner.runIssue({
      workspacePath: input.workspacePath,
      issue: {
        identifier: input.issue.identifier,
        title: input.issue.title,
        ...(input.issue.description === null ? {} : { description: input.issue.description }),
      },
      workflow: { retryAttempt: input.retryAttempt },
      promptTemplate: input.promptTemplate,
      onEvent: (event) => this.events.push(event),
    }).then(() => ({ ok: true, totalTokens: 1, inputTokens: 1, outputTokens: 0 } satisfies RunCompletion), (error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      totalTokens: Math.max(0, Date.now() - startedAt),
    } satisfies RunCompletion));
    this.completions.push(completion);
    return { completion, cancel: () => Promise.resolve() };
  }
}

function issue(input: { readonly id: string; readonly identifier: string; readonly state?: string; readonly blockers?: Issue['blocked_by'] }): Issue {
  return {
    id: input.id,
    identifier: input.identifier,
    title: `Title ${input.identifier}`,
    description: 'Conformance fixture issue.',
    priority: 1,
    state: input.state ?? 'Todo',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: input.blockers ?? [],
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: null,
  };
}

async function makeFakeCodexServer(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'symphony-conformance-codex-'));
  const serverPath = join(dir, 'fake-codex-app-server.mjs');
  await writeFile(serverPath, script, 'utf8');
  return serverPath;
}

const completingFakeCodexServer = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const logPath = process.env.FAKE_CODEX_LOG;
const log = (entry) => appendFileSync(logPath, JSON.stringify(entry) + '\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
log({ event: 'server_started', cwd: process.cwd() });
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  log({ event: 'client_message', message });
  if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread_conformance' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn_conformance' } } });
    send({ method: 'token/usage', params: { usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } });
    send({ method: 'turn/completed', params: { thread: { id: 'thread_conformance' }, turn: { id: 'turn_conformance' } } });
  }
});
`;

describe('SPEC.md conformance fixture stack', () => {
  it('dispatches one eligible fake Linear issue through workspace hooks and a fake Codex app-server without live APIs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-conformance-workspaces-'));
    const fakeCodexLog = join(root, 'fake-codex.log');
    const fakeCodexServer = await makeFakeCodexServer(completingFakeCodexServer);
    const workflow: WorkflowDefinition = {
      config: {
        tracker: { kind: 'linear', api_key: 'fake-token', project_slug: 'CORE' },
        workspace: { root },
        hooks: {
          after_create: 'printf after_create >> hook-order.log',
          before_run: 'printf ,before_run >> hook-order.log',
        },
        agent: { max_concurrent_agents: 1 },
        codex: { command: `node ${JSON.stringify(fakeCodexServer)}` },
      },
      prompt_template: 'Work on {{ issue.identifier }}: {{ issue.title }}',
      workflow_path: join(root, 'WORKFLOW.md'),
    };
    const tracker = new FakeLinearTracker();
    const clock = new FakeClock();
    const workspaceManager = new WorkspaceManagerAdapter(new WorkspaceManager({
      root,
      hooks: { after_create: 'printf after_create >> hook-order.log', before_run: 'printf ,before_run >> hook-order.log', after_run: 'printf ,after_run >> hook-order.log' },
    }));
    const runner = new FakeCodexOrchestratorRunner(new CodexAppServerRunner({
      codex: { command: `node ${JSON.stringify(fakeCodexServer)}`, readTimeoutMs: 1_000, turnTimeoutMs: 1_000 },
      protocol: { schemaSource: 'fake-jsonl-v1 conformance fixture' },
      approval: { mode: 'auto_approve' },
      sandbox: { mode: 'workspace_write' },
      tools: { linearGraphql: { enabled: false } },
      env: { FAKE_CODEX_LOG: fakeCodexLog },
    }));
    tracker.candidates = [issue({ id: 'core-1', identifier: 'CORE-1' })];
    const orchestrator = new SymphonyOrchestrator({ workflow, tracker, workspaceManager, runner, clock });

    await orchestrator.tick();
    await Promise.all(runner.completions);
    await orchestrator.drain();

    const workspace = workspaceManager.prepared.get('core-1');
    expect(workspace?.workspacePath).toBe(join(root, 'CORE-1'));
    await expect(readFile(join(root, 'CORE-1', 'hook-order.log'), 'utf8')).resolves.toBe('after_create,before_run,after_run');
    const fakeCodexLines = (await readFile(fakeCodexLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { event: string; cwd?: string; message?: { method?: string; params?: Record<string, unknown> } });
    expect(fakeCodexLines).toContainEqual(expect.objectContaining({ event: 'server_started', cwd: join(root, 'CORE-1') }));
    expect(fakeCodexLines.find((line) => line.message?.method === 'turn/start')?.message?.params).toMatchObject({ cwd: join(root, 'CORE-1') });
    expect(runner.events).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'token_usage' }), expect.objectContaining({ event: 'turn_completed' })]));
    expect(orchestrator.snapshot().completed).toEqual(['core-1']);
  });

  it('keeps invalid config reloads out of dispatch preflight while retaining the last-known-good workflow object', async () => {
    const tracker = new FakeLinearTracker();
    const clock = new FakeClock();
    const root = await mkdtemp(join(tmpdir(), 'symphony-conformance-reload-'));
    const lastKnownGood: WorkflowDefinition = {
      config: { tracker: { kind: 'linear', api_key: 'fake-token', project_slug: 'CORE' }, workspace: { root }, codex: { command: 'fake-codex' } },
      prompt_template: 'Work on {{ issue.identifier }}',
      workflow_path: join(root, 'WORKFLOW.md'),
    };
    const invalidReload: WorkflowDefinition = {
      ...lastKnownGood,
      config: { tracker: { kind: 'linear', api_key: 'fake-token', project_slug: 'CORE' }, polling: { interval_ms: 0 }, codex: { command: 'fake-codex' } },
    };
    const runner = new FakeCodexOrchestratorRunner(new CodexAppServerRunner({
      codex: { command: 'node -e "process.exit(0)"', readTimeoutMs: 10, turnTimeoutMs: 10 },
      protocol: { schemaSource: 'unused' },
      approval: { mode: 'auto_approve' },
      sandbox: { mode: 'workspace_write' },
      tools: { linearGraphql: { enabled: false } },
    }));
    const orchestrator = new SymphonyOrchestrator({
      workflow: lastKnownGood,
      tracker,
      workspaceManager: { prepareWorkspace: () => Promise.resolve({ workspacePath: root }), runAfterRunHook: () => Promise.resolve(), cleanupTerminalWorkspace: () => Promise.resolve() },
      runner,
      clock,
    });
    tracker.candidates = [];

    expect(() => new SymphonyOrchestrator({
      workflow: invalidReload,
      tracker,
      workspaceManager: { prepareWorkspace: () => Promise.resolve({ workspacePath: root }), runAfterRunHook: () => Promise.resolve(), cleanupTerminalWorkspace: () => Promise.resolve() },
      runner,
      clock,
    })).toThrow(/polling.interval_ms/);
    await orchestrator.tick();

    expect(orchestrator.snapshot().last_preflight_errors).toEqual([]);
    expect(tracker.calls).toContain('fetch_candidate_issues');
  });
});
