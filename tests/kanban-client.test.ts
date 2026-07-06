import { describe, expect, it } from 'vitest';

import {
  HermesKanbanCliClient,
  KanbanClientError,
  type KanbanCommandExecutor,
  type KanbanCommandInvocation,
} from '../src/kanban-client.js';

function fakeLinearApiKey(): string {
  return ['lin', '_api_should_not_leak_123456'].join('');
}

function recordingExecutor(stdout: string, overrides: Partial<{ readonly stderr: string; readonly exitCode: number }> = {}) {
  const calls: KanbanCommandInvocation[] = [];
  const executor: KanbanCommandExecutor = (invocation) => {
    calls.push(invocation);
    return Promise.resolve({
      stdout,
      stderr: overrides.stderr ?? '',
      exitCode: overrides.exitCode ?? 0,
    });
  };
  return { calls, executor };
}

describe('HermesKanbanCliClient', () => {
  it('builds exact create argv/env through the narrow CLI seam and parses task_id output', async () => {
    const { calls, executor } = recordingExecutor(JSON.stringify({ task_id: 't_1234abcd' }));
    const client = new HermesKanbanCliClient({
      command: '/safe/bin/hermes',
      board: 'symphony-test',
      hermesHome: '/tmp/hermes-home',
      path: '/safe/bin:/usr/bin',
      executor,
      processEnv: {
        PATH: '/unsafe/bin',
        LINEAR_API_KEY: fakeLinearApiKey(),
        HERMES_HOME: '/real-home',
        HOME: '/home/user',
      },
    });

    await expect(client.createTask({
      title: 'K1 Kanban CLI client seam',
      body: 'Acceptance: build the typed seam without touching live boards.',
      assignee: 'backend-eng',
      parentIds: ['t_parent0001'],
      workspace: 'worktree:/tmp/symphony-wt',
      idempotencyKey: 'wf-001:K1',
    })).resolves.toEqual({ id: 't_1234abcd' });

    expect(calls).toEqual([
      {
        command: '/safe/bin/hermes',
        args: [
          'kanban',
          '--board',
          'symphony-test',
          'create',
          'K1 Kanban CLI client seam',
          '--body',
          'Acceptance: build the typed seam without touching live boards.',
          '--assignee',
          'backend-eng',
          '--parent',
          't_parent0001',
          '--workspace',
          'worktree:/tmp/symphony-wt',
          '--idempotency-key',
          'wf-001:K1',
          '--json',
        ],
        env: {
          HERMES_HOME: '/tmp/hermes-home',
          HERMES_KANBAN_BOARD: 'symphony-test',
          PATH: '/safe/bin:/usr/bin',
        },
      },
    ]);
  });

  it('omits assignee argv entirely when createTask receives assignee null', async () => {
    const { calls, executor } = recordingExecutor(JSON.stringify({ task_id: 't_unassigned' }));
    const client = new HermesKanbanCliClient({
      command: '/safe/bin/hermes',
      board: 'symphony-test',
      hermesHome: '/tmp/hermes-home',
      path: '/safe/bin:/usr/bin',
      executor,
    });

    await expect(client.createTask({
      title: 'K2 no-worker parking candidate',
      body: 'Acceptance: the task is explicitly unassigned through omitted assignee argv.',
      assignee: null,
      workspace: 'scratch',
    })).resolves.toEqual({ id: 't_unassigned' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      'kanban',
      '--board',
      'symphony-test',
      'create',
      'K2 no-worker parking candidate',
      '--body',
      'Acceptance: the task is explicitly unassigned through omitted assignee argv.',
      '--workspace',
      'scratch',
      '--json',
    ]);
    expect(calls[0]?.args).not.toContain('--assignee');
    expect(calls[0]?.args).not.toContain('null');
  });

  it('accepts id output on idempotent create paths without requiring task_id', async () => {
    const { executor } = recordingExecutor(JSON.stringify({ id: 't_existing1' }));
    const client = new HermesKanbanCliClient({
      command: 'hermes',
      board: 'symphony-test',
      hermesHome: '/tmp/hermes-home',
      executor,
    });

    await expect(client.createTask({ title: 'Already exists' })).resolves.toEqual({ id: 't_existing1' });
  });

  it('inherits PATH from the supplied process environment when no explicit safe path is provided', async () => {
    const { calls, executor } = recordingExecutor(JSON.stringify({ boards: [] }));
    const client = new HermesKanbanCliClient({
      command: 'hermes',
      board: 'symphony-test',
      hermesHome: '/tmp/hermes-home',
      processEnv: {
        PATH: '/home/user/.local/bin:/usr/bin',
        LINEAR_API_KEY: fakeLinearApiKey(),
      },
      executor,
    });

    await expect(client.boardsList()).resolves.toEqual([]);

    expect(calls[0]?.env).toEqual({
      HERMES_HOME: '/tmp/hermes-home',
      HERMES_KANBAN_BOARD: 'symphony-test',
      PATH: '/home/user/.local/bin:/usr/bin',
    });
  });

  it('returns typed bounded redacted diagnostics for non-zero exit and malformed JSON', async () => {
    const stderr = `diagnostic token lin_api_${'a'.repeat(80)} ${'e'.repeat(900)}`;
    const stdout = `plain output with sk-${'b'.repeat(80)} and ${'o'.repeat(900)}`;
    const { executor } = recordingExecutor(stdout, { stderr, exitCode: 7 });
    const client = new HermesKanbanCliClient({
      command: 'hermes',
      board: 'symphony-test',
      hermesHome: '/tmp/hermes-home',
      executor,
    });

    await expect(client.boardsList()).rejects.toBeInstanceOf(KanbanClientError);
    await expect(client.boardsList()).rejects.toMatchObject({
      operation: 'boardsList',
      exitCode: 7,
    });

    try {
      await client.boardsList();
      throw new Error('expected boardsList to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(KanbanClientError);
      const clientError = error as KanbanClientError;
      expect(clientError.stdoutTail.length).toBeLessThanOrEqual(512);
      expect(clientError.stderrTail.length).toBeLessThanOrEqual(512);
      expect(clientError.stdoutTail).toContain('[REDACTED]');
      expect(clientError.stderrTail).toContain('[REDACTED]');
      expect(clientError.stdoutTail).not.toContain(`sk-${'b'.repeat(80)}`);
      expect(clientError.stderrTail).not.toContain('lin_api_');
    }

    const malformed = new HermesKanbanCliClient({
      command: 'hermes',
      board: 'symphony-test',
      hermesHome: '/tmp/hermes-home',
      executor: recordingExecutor('{not json').executor,
    });
    await expect(malformed.boardsList()).rejects.toMatchObject({
      operation: 'boardsList',
      exitCode: null,
    });
  });

  it('parses minimal board/task/list/show/dispatch JSON shapes with version-tolerant required fields', async () => {
    const outputs = [
      JSON.stringify({ boards: [{ slug: 'symphony-test', name: 'Symphony Test', archived: false }] }),
      JSON.stringify({ boards: [{ slug: 'symphony-test', name: 'Symphony Test', archived: false }] }),
      JSON.stringify({ tasks: [{ id: 't_1', title: 'Task 1', status: 'ready', assignee: 'default' }] }),
      JSON.stringify({ task: { id: 't_1', title: 'Task 1', status: 'ready', assignee: 'default' }, parents: [], children: [] }),
      JSON.stringify({ spawned: [], skipped_nonspawnable: [{ task_id: 't_1', reason: 'missing profile' }] }),
    ];
    const calls: KanbanCommandInvocation[] = [];
    const executor: KanbanCommandExecutor = (invocation) => {
      calls.push(invocation);
      const stdout = outputs.shift();
      if (stdout === undefined) {
        throw new Error('unexpected command call');
      }
      return Promise.resolve({ stdout, stderr: '', exitCode: 0 });
    };
    const client = new HermesKanbanCliClient({
      command: 'hermes',
      board: 'symphony-test',
      hermesHome: '/tmp/hermes-home',
      executor,
    });

    await expect(client.boardsList()).resolves.toEqual([{ slug: 'symphony-test', name: 'Symphony Test', archived: false }]);
    await expect(client.boardShow('symphony-test')).resolves.toEqual({ slug: 'symphony-test', name: 'Symphony Test', archived: false });
    await expect(client.listTasks({ status: 'ready' })).resolves.toEqual([{ id: 't_1', title: 'Task 1', status: 'ready', assignee: 'default' }]);
    await expect(client.showTask('t_1')).resolves.toMatchObject({ id: 't_1', title: 'Task 1', status: 'ready', parents: [], children: [] });
    await expect(client.dispatchDryRun({ max: 1 })).resolves.toEqual({
      spawned: [],
      autoAssignedDefault: [],
      skippedNonspawnable: [{ taskId: 't_1', reason: 'missing profile' }],
    });

    expect(calls.map((call) => call.args)).toEqual([
      ['kanban', '--board', 'symphony-test', 'boards', 'list', '--json'],
      ['kanban', '--board', 'symphony-test', 'boards', 'list', '--json'],
      ['kanban', '--board', 'symphony-test', 'list', '--status', 'ready', '--json'],
      ['kanban', '--board', 'symphony-test', 'show', 't_1', '--json'],
      ['kanban', '--board', 'symphony-test', 'dispatch', '--dry-run', '--max', '1', '--json'],
    ]);
  });

  it('creates unlinks and reads back typed blocking task links through the CLI seam', async () => {
    const outputs = [
      JSON.stringify({
        edge: {
          parent_task_id: 't_parent',
          child_task_id: 't_child',
          kind: 'blocks',
          blocking: true,
          required_parent_statuses: ['done'],
          source: 'symphony-graph-sync',
          created_by: 'symphony-ts',
          metadata: { linear_relation_id: 'rel_blocks_A_B' },
        },
      }),
      JSON.stringify({ ok: true }),
      JSON.stringify({
        task: { id: 't_child', title: 'Child task', status: 'blocked', assignee: null },
        parents: [{ id: 't_parent', title: 'Parent task', status: 'done', assignee: null }],
        children: [],
        parent_links: [
          {
            parent_task_id: 't_parent',
            child_task_id: 't_child',
            kind: 'blocks',
            blocking: true,
            required_parent_statuses: ['done'],
            source: 'symphony-graph-sync',
            created_by: 'symphony-ts',
            metadata: { linear_relation_id: 'rel_blocks_A_B' },
          },
        ],
        child_links: [],
      }),
    ];
    const calls: KanbanCommandInvocation[] = [];
    const executor: KanbanCommandExecutor = (invocation) => {
      calls.push(invocation);
      const stdout = outputs.shift();
      if (stdout === undefined) {
        throw new Error('unexpected command call');
      }
      return Promise.resolve({ stdout, stderr: '', exitCode: 0 });
    };
    const client = new HermesKanbanCliClient({
      command: 'hermes',
      board: 'symphony-test',
      hermesHome: '/tmp/hermes-home',
      executor,
    });

    await expect(client.createTaskLink({
      parentId: 't_parent',
      childId: 't_child',
      kind: 'blocks',
      blocking: true,
      requiredParentStatuses: ['done'],
      source: 'symphony-graph-sync',
      createdBy: 'symphony-ts',
      metadata: { linear_relation_id: 'rel_blocks_A_B' },
    })).resolves.toEqual({
      parentTaskId: 't_parent',
      childTaskId: 't_child',
      kind: 'blocks',
      blocking: true,
      requiredParentStatuses: ['done'],
      source: 'symphony-graph-sync',
      createdBy: 'symphony-ts',
      metadata: { linear_relation_id: 'rel_blocks_A_B' },
    });
    await expect(client.deleteTaskLink({
      parentId: 't_parent',
      childId: 't_child',
      kind: 'blocks',
    })).resolves.toBeUndefined();
    await expect(client.showTask('t_child')).resolves.toMatchObject({
      id: 't_child',
      parentLinks: [
        {
          parentTaskId: 't_parent',
          childTaskId: 't_child',
          kind: 'blocks',
          blocking: true,
          requiredParentStatuses: ['done'],
          source: 'symphony-graph-sync',
          createdBy: 'symphony-ts',
          metadata: { linear_relation_id: 'rel_blocks_A_B' },
        },
      ],
      childLinks: [],
    });

    expect(calls.map((call) => call.args)).toEqual([
      [
        'kanban',
        '--board',
        'symphony-test',
        'link',
        '--parent-board',
        'symphony-test',
        '--parent',
        't_parent',
        '--child-board',
        'symphony-test',
        '--child',
        't_child',
        '--kind',
        'blocks',
        '--blocking',
        '--required-parent-statuses',
        'done',
        '--source',
        'symphony-graph-sync',
        '--created-by',
        'symphony-ts',
        '--metadata',
        '{"linear_relation_id":"rel_blocks_A_B"}',
        '--json',
      ],
      [
        'kanban',
        '--board',
        'symphony-test',
        'unlink',
        '--parent-board',
        'symphony-test',
        '--parent',
        't_parent',
        '--child-board',
        'symphony-test',
        '--child',
        't_child',
        '--kind',
        'blocks',
        '--json',
      ],
      ['kanban', '--board', 'symphony-test', 'show', 't_child', '--json'],
    ]);
  });

  it('rejects overlarge task bodies before invoking the CLI', async () => {
    const { calls, executor } = recordingExecutor(JSON.stringify({ task_id: 't_never' }));
    const client = new HermesKanbanCliClient({
      command: 'hermes',
      board: 'symphony-test',
      hermesHome: '/tmp/hermes-home',
      maxTaskBodyBytes: 16,
      executor,
    });

    await expect(client.createTask({ title: 'Too large', body: 'this body is too large' })).rejects.toMatchObject({
      operation: 'createTask',
      exitCode: null,
    });
    expect(calls).toEqual([]);
  });
});
