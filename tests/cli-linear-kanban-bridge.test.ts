import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runSymphonyLinearKanbanBridgeCli, startSymphonyLinearKanbanBridgeCli } from '../src/cli/linear-kanban-bridge.js';
import type { Issue } from '../src/domain.js';
import type { KanbanClient, KanbanTaskRef, KanbanTaskSummary } from '../src/kanban-types.js';
import type { CreateKanbanTaskInput } from '../src/kanban-types.js';
import type { LinearKanbanBridgeTracker } from '../src/linear-kanban-bridge.js';
import type { LinearIssueMutationClient } from '../src/tracker.js';

const issue: Issue = {
  id: 'issue-1',
  identifier: 'HER-8',
  title: 'Bridge CLI test',
  description: 'Create a Kanban task from Linear.',
  priority: 3,
  state: 'Todo',
  branch_name: null,
  url: 'https://linear.app/hermegeddon/issue/HER-8/bridge-cli-test',
  labels: [],
  blocked_by: [],
  created_at: null,
  updated_at: null,
};

function fakeKanbanClient(): {
  readonly client: KanbanClient;
  readonly createInputs: CreateKanbanTaskInput[];
  readonly blockInputs: { readonly id: string; readonly reason: string }[];
} {
  const tasks = new Map<string, KanbanTaskSummary>();
  const createInputs: CreateKanbanTaskInput[] = [];
  const blockInputs: { readonly id: string; readonly reason: string }[] = [];
  const client: KanbanClient = {
    boardsList: () => Promise.resolve([]),
    boardShow: () => Promise.resolve({ slug: 'testflight', name: 'Testflight', archived: false }),
    createBoard: () => Promise.resolve({ slug: 'testflight', name: 'Testflight', archived: false }),
    init: () => Promise.resolve(),
    createTask: (input): Promise<KanbanTaskRef> => {
      createInputs.push(input);
      const id = 't_cli0001';
      tasks.set(id, { id, title: input.title, status: 'ready', assignee: input.assignee ?? null });
      return Promise.resolve({ id });
    },
    showTask: (id) => Promise.resolve({
      ...(tasks.get(id) ?? { id, title: 'unknown', status: 'ready', assignee: null }),
      body: null,
      parents: [],
      children: [],
      parentLinks: [],
      childLinks: [],
      comments: [],
      raw: {},
    }),
    listTasks: () => Promise.resolve([...tasks.values()]),
    createTaskLink: () => Promise.resolve({
      parentTaskId: 'parent',
      childTaskId: 'child',
      kind: 'blocks',
      blocking: true,
      requiredParentStatuses: ['done'],
      source: null,
      createdBy: null,
      metadata: {},
    }),
    deleteTaskLink: () => Promise.resolve(),
    linkTasks: () => Promise.resolve(),
    commentTask: () => Promise.resolve(),
    blockTask: (id, reason) => {
      blockInputs.push({ id, reason });
      const task = tasks.get(id);
      if (task !== undefined) {
        tasks.set(id, { ...task, status: 'blocked' });
      }
      return Promise.resolve();
    },
    unblockTask: () => Promise.resolve(),
    dispatchDryRun: () => Promise.resolve({ spawned: [], autoAssignedDefault: [], skippedNonspawnable: [] }),
    assigneesList: () => Promise.resolve([]),
  };
  return { client, createInputs, blockInputs };
}

describe('symphony-linear-kanban-bridge CLI', () => {
  it('runs one bridge tick from a Kanban workflow using injected clients and writes a JSON receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-kanban-bridge-cli-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    const ledgerPath = join(root, 'bridge-ledger.json');
    const artifactRoot = join(root, 'artifacts');
    await writeFile(workflowPath, `---
backend:
  kind: hermes_kanban
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  team_key: HER
  required_labels: [Symphony-Required]
  active_states: [Todo, In Progress]
  allow_broad_dispatch: true
  max_issues_per_poll: 5
  mutations:
    enabled: true
    start_state_id: state-in-progress
    completed_state_id: state-done
    comment_marker: symphony-linear-kanban-bridge
kanban:
  hermes_command: /safe/bin/hermes
  hermes_home: ./hermes-home
  board: testflight
  dispatch: allow_gateway_dispatch
  default_assignee: default
  artifact_root: ${JSON.stringify(artifactRoot)}
  workspace:
    kind: scratch
service:
  state_path: ${JSON.stringify(ledgerPath)}
polling:
  interval_ms: 60000
---
Bridge prompt
`, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const { client: kanbanClient, createInputs } = fakeKanbanClient();
    const stateInputs: { issueId: string; stateId: string }[] = [];
    const commentInputs: { issueId: string; body: string }[] = [];

    const exitCode = await runSymphonyLinearKanbanBridgeCli(['--once', '--workflow', workflowPath], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      processEnv: { LINEAR_API_KEY: 'test-linear-token', PATH: '/safe/bin:/usr/bin' },
      trackerFactory: ({ config }) => {
        expect(config.tracker.requiredLabels).toEqual(['symphony-required']);
        expect(config.tracker.teamKey).toBe('HER');
        return { fetch_candidate_issues: vi.fn(() => Promise.resolve([{ ...issue, labels: ['symphony-required'] }])) };
      },
      kanbanClientFactory: () => kanbanClient,
      mutationClientFactory: () => ({
        createComment: (input: { issueId: string; body: string }) => {
          commentInputs.push(input);
          return Promise.resolve({ comment_id: 'comment-1', comment_url: 'https://linear.app/comment/comment-1' });
        },
        updateIssueState: (input: { issueId: string; stateId: string }) => {
          stateInputs.push(input);
          return Promise.resolve();
        },
      } as unknown as LinearIssueMutationClient),
      now: new Date('2026-06-24T13:00:00.000Z'),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const receipt = JSON.parse(stdout.join('')) as {
      readonly ok: boolean;
      readonly effect: string;
      readonly materialized: readonly { readonly issue_identifier: string; readonly task_id: string; readonly created: boolean }[];
    };
    expect(receipt).toMatchObject({
      ok: true,
      effect: 'linear_kanban_bridge_tick',
      materialized: [{ issue_identifier: 'HER-8', task_id: 't_cli0001', created: true }],
    });
    expect(createInputs).toHaveLength(1);
    expect(createInputs[0]).toMatchObject({
      title: 'HER-8: Bridge CLI test',
      assignee: 'default',
      workspace: 'scratch',
      idempotencyKey: 'symphony-linear-kanban-bridge:symphony-linear-kanban-bridge:issue-1',
    });
    expect(stateInputs).toEqual([{ issueId: 'issue-1', stateId: 'state-in-progress' }]);
    expect(commentInputs[0]?.body).toContain('Kanban task: t_cli0001');
  });

  it('propagates workflow no-worker dispatch policy and exact canary selector into the bridge receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-kanban-bridge-cli-no-worker-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    const ledgerPath = join(root, 'bridge-ledger.json');
    const artifactRoot = join(root, 'artifacts');
    await writeFile(workflowPath, `---
backend:
  kind: hermes_kanban
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  team_key: HER
  require_canary: true
  canary_issue_identifier: HER-23
  active_states: [Todo]
  max_issues_per_poll: 1
  mutations:
    enabled: true
    start_state_id: state-in-progress
    comment_marker: symphony-linear-kanban-bridge
kanban:
  hermes_command: /safe/bin/hermes
  hermes_home: ./hermes-home
  board: linear
  dispatch: dry_run
  dispatch_policy: no_worker
  default_assignee: default
  artifact_root: ${JSON.stringify(artifactRoot)}
  workspace:
    kind: scratch
service:
  state_path: ${JSON.stringify(ledgerPath)}
---
Bridge prompt
`, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const { client: kanbanClient, createInputs, blockInputs } = fakeKanbanClient();
    const selectorScope = {
      kind: 'team_key' as const,
      value: 'HER',
      required_labels: [] as readonly string[],
      canary_labels: [] as readonly string[],
      canary_issue_identifier: 'HER-23',
      active_states: ['Todo'] as readonly string[],
      max_issues_per_poll: 1,
    } satisfies ReturnType<NonNullable<LinearKanbanBridgeTracker['selectorScopeForReceipt']>> & {
      readonly canary_issue_identifier: string;
      readonly canary_labels: readonly string[];
    };

    const exitCode = await runSymphonyLinearKanbanBridgeCli(['--once', '--workflow', workflowPath], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      processEnv: { LINEAR_API_KEY: ['test', 'linear', 'token'].join('-'), PATH: '/safe/bin:/usr/bin' },
      trackerFactory: ({ config }) => {
        expect(config.tracker.canaryIssueIdentifier).toBe('HER-23');
        expect(config.tracker.requireCanary).toBe(true);
        expect((config.kanban as { readonly dispatchPolicy?: string } | null)?.dispatchPolicy).toBe('no_worker');
        return {
          fetch_candidate_issues: vi.fn(() => Promise.resolve([{ ...issue, id: 'issue-her-23', identifier: 'HER-23' }])),
          selectorScopeForReceipt: () => selectorScope,
        };
      },
      kanbanClientFactory: () => kanbanClient,
      mutationClientFactory: () => ({
        createComment: () => Promise.resolve({ comment_id: 'comment-1', comment_url: 'https://linear.app/comment/comment-1' }),
        updateIssueState: () => Promise.resolve(),
      } as unknown as LinearIssueMutationClient),
      now: new Date('2026-06-24T13:05:00.000Z'),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(createInputs).toHaveLength(1);
    expect(createInputs[0]).toMatchObject({
      title: 'HER-23: Bridge CLI test',
      assignee: null,
      workspace: 'scratch',
    });
    expect(createInputs[0]?.body).toContain('Dispatch policy: no_worker');
    expect(blockInputs).toHaveLength(1);
    expect(blockInputs[0]?.id).toBe('t_cli0001');
    expect(blockInputs[0]?.reason).toContain('no-worker policy');
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      ok: true,
      board: 'linear',
      dispatch_policy: 'no_worker',
      selector_scope: {
        kind: 'team_key',
        value: 'HER',
        canary_issue_identifier: 'HER-23',
        canary_labels: [],
        active_states: ['Todo'],
        max_issues_per_poll: 1,
      },
      materialized: [{
        issue_identifier: 'HER-23',
        created: true,
        dispatch_policy: 'no_worker',
        requested_assignee: null,
        sticky_block_applied: true,
      }],
    });
  });

  it('allows the bridge CLI to run an explicitly gated all-approved-projects workflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-kanban-bridge-cli-all-linear-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    const ledgerPath = join(root, 'bridge-ledger.json');
    const artifactRoot = join(root, 'artifacts');
    await writeFile(workflowPath, `---
backend:
  kind: hermes_kanban
tracker:
  kind: linear
  api_key: test-linear-token
  all_approved_projects: true
  active_states: [Todo]
  allow_broad_dispatch: true
  max_issues_per_poll: 1
  mutations:
    enabled: true
kanban:
  hermes_command: /safe/bin/hermes
  hermes_home: ./hermes-home
  board: linear
  dispatch: allow_gateway_dispatch
  default_assignee: default
  artifact_root: ${JSON.stringify(artifactRoot)}
  workspace:
    kind: scratch
service:
  state_path: ${JSON.stringify(ledgerPath)}
---
Bridge prompt
`, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const { client: kanbanClient } = fakeKanbanClient();

    const exitCode = await runSymphonyLinearKanbanBridgeCli(['--once', '--workflow', workflowPath], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      processEnv: { PATH: '/safe/bin:/usr/bin' },
      trackerFactory: ({ config }) => {
        expect(config.tracker.projectSlug).toBeNull();
        expect(config.tracker.teamKey).toBeNull();
        expect(config.tracker.allApprovedProjects).toBe(true);
        expect(config.tracker.maxIssuesPerPoll).toBe(1);
        return { fetch_candidate_issues: vi.fn(() => Promise.resolve([issue])) };
      },
      kanbanClientFactory: () => kanbanClient,
      mutationClientFactory: () => ({
        createComment: () => Promise.resolve({ comment_id: 'comment-1', comment_url: 'https://linear.app/comment/comment-1' }),
        updateIssueState: () => Promise.resolve(),
      } as unknown as LinearIssueMutationClient),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      ok: true,
      board: 'linear',
      candidates: 1,
      materialized: [{ issue_identifier: 'HER-8', created: true }],
    });
  });

  it('starts long-running polling mode with an immediate tick until stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-kanban-bridge-cli-loop-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    const ledgerPath = join(root, 'bridge-ledger.json');
    const artifactRoot = join(root, 'artifacts');
    await writeFile(workflowPath, `---
backend:
  kind: hermes_kanban
tracker:
  kind: linear
  api_key: test-linear-token
  team_key: HER
  active_states: [Todo, In Progress]
  allow_broad_dispatch: true
  mutations:
    enabled: true
    start_state_id: state-in-progress
    completed_state_id: state-done
kanban:
  hermes_command: /safe/bin/hermes
  hermes_home: ./hermes-home
  board: testflight
  dispatch: allow_gateway_dispatch
  default_assignee: default
  artifact_root: ${JSON.stringify(artifactRoot)}
  workspace:
    kind: scratch
service:
  state_path: ${JSON.stringify(ledgerPath)}
polling:
  interval_ms: 60000
---
Bridge prompt
`, 'utf8');
    const { client: kanbanClient, createInputs } = fakeKanbanClient();
    const logs: string[] = [];
    const runtime = await startSymphonyLinearKanbanBridgeCli(['--workflow', workflowPath], {
      log: (line) => logs.push(line),
      processEnv: { PATH: '/safe/bin:/usr/bin' },
      trackerFactory: () => ({ fetch_candidate_issues: vi.fn(() => Promise.resolve([issue])) }),
      kanbanClientFactory: () => kanbanClient,
      mutationClientFactory: () => ({
        createComment: () => Promise.resolve({ comment_id: 'comment-1', comment_url: 'https://linear.app/comment/comment-1' }),
        updateIssueState: () => Promise.resolve(),
      } as unknown as LinearIssueMutationClient),
      now: new Date('2026-06-24T13:30:00.000Z'),
    });

    try {
      expect(runtime.stopped).toBe(false);
      expect(createInputs).toHaveLength(1);
      expect(runtime.lastReceipt).toMatchObject({ ok: true, candidates: 1 });
      expect(logs.join('\n')).toContain('event=linear_kanban_bridge outcome=tick_completed candidates=1');
    } finally {
      await runtime.stop('test');
    }
    expect(runtime.stopped).toBe(true);
  });
});
