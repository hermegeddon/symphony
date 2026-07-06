import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Issue } from '../src/domain.js';
import { JsonFileIssueRunLedger } from '../src/issue-run-ledger.js';
import type { KanbanClient, CreateKanbanTaskInput, KanbanTaskRef, KanbanTaskSummary } from '../src/kanban-types.js';
import { runLinearKanbanBridgeOnce, type LinearKanbanBridgeTracker } from '../src/linear-kanban-bridge.js';
import type { LinearIssueMutationClient } from '../src/tracker.js';

function teamSelectorScope(value: string, requiredLabels: readonly string[] = ['symphony']): ReturnType<NonNullable<LinearKanbanBridgeTracker['selectorScopeForReceipt']>> {
  return {
    kind: 'team_key' as const,
    value,
    required_labels: requiredLabels,
    active_states: ['Todo'] as readonly string[],
    max_issues_per_poll: 50,
  };
}

const issue: Issue = {
  id: 'issue-1',
  identifier: 'HER-8',
  title: 'Try automatic Linear to Kanban bridge',
  description: 'Make a receipt and do not mutate the repo.',
  priority: 2,
  state: 'Todo',
  branch_name: 'janusz/her-8-bridge-test',
  url: 'https://linear.app/hermegeddon/issue/HER-8/try-automatic-linear-to-kanban-bridge',
  labels: ['symphony'],
  blocked_by: [],
  created_at: new Date('2026-06-24T12:00:00.000Z'),
  updated_at: new Date('2026-06-24T12:05:00.000Z'),
  team: { key: 'HER', name: 'Hermegeddon' },
  project: {
    id: 'project-1',
    name: 'Testflight',
    slug_id: '2a5d92446e9d',
    url: 'https://linear.app/hermegeddon/project/testflight',
  },
};

function fakeKanbanClient(): {
  readonly client: KanbanClient;
  readonly createTask: ReturnType<typeof vi.fn>;
  readonly blockTask: ReturnType<typeof vi.fn>;
  readonly createInputs: CreateKanbanTaskInput[];
  readonly blockInputs: { readonly id: string; readonly reason: string }[];
  readonly setTaskStatus: (id: string, status: string) => void;
} {
  const tasks = new Map<string, KanbanTaskSummary>();
  const createInputs: CreateKanbanTaskInput[] = [];
  const blockInputs: { readonly id: string; readonly reason: string }[] = [];
  const createTask = vi.fn((input: CreateKanbanTaskInput): Promise<KanbanTaskRef> => {
    createInputs.push(input);
    const id = input.idempotencyKey === 'symphony-linear-kanban-bridge:workflow-1:issue-1'
      ? 't_bridge001'
      : `t_${String(tasks.size + 1).padStart(8, '0')}`;
    tasks.set(id, { id, title: input.title, status: 'ready', assignee: input.assignee ?? null });
    return Promise.resolve({ id });
  });
  const blockTask = vi.fn((id: string, reason: string): Promise<void> => {
    blockInputs.push({ id, reason });
    const task = tasks.get(id);
    if (task !== undefined) {
      tasks.set(id, { ...task, status: 'blocked' });
    }
    return Promise.resolve();
  });
  const client: KanbanClient = {
    boardsList: () => Promise.resolve([]),
    boardShow: () => Promise.resolve({ slug: 'testflight', name: 'Testflight', archived: false }),
    createBoard: () => Promise.resolve({ slug: 'testflight', name: 'Testflight', archived: false }),
    init: () => Promise.resolve(),
    createTask,
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
    blockTask,
    unblockTask: () => Promise.resolve(),
    dispatchDryRun: () => Promise.resolve({ spawned: [], autoAssignedDefault: [], skippedNonspawnable: [] }),
    assigneesList: () => Promise.resolve([]),
  };
  const setTaskStatus = (id: string, status: string): void => {
    const task = tasks.get(id);
    if (task === undefined) {
      throw new Error(`missing fake Kanban task ${id}`);
    }
    tasks.set(id, { ...task, status });
  };
  return { client, createTask, blockTask, createInputs, blockInputs, setTaskStatus };
}

describe('Linear → Kanban bridge', () => {
  it('redacts secret-like issue titles before they reach Kanban task titles or snapshot surfaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-kanban-bridge-title-redaction-'));
    const ledgerPath = join(root, 'bridge-ledger.json');
    const secretLikeTitle = 'Issue about lin_api_1234567890abcdef token';
    const issueWithSecretTitle: Issue = { ...issue, id: 'issue-secret', identifier: 'HER-SECRET', title: secretLikeTitle, labels: ['symphony'] };
    const tracker = {
      fetch_candidate_issues: vi.fn(() => Promise.resolve([issueWithSecretTitle])),
      getRequiredLabels: () => ['symphony'],
      selectorScopeForReceipt: () => teamSelectorScope('HER'),
    };
    const { client: kanbanClient, createTask, createInputs } = fakeKanbanClient();
    const createComment = vi.fn(() => {
      return Promise.resolve({ comment_id: 'comment-start', comment_url: 'https://linear.app/comment/comment-start' });
    });
    const updateIssueState = vi.fn(() => Promise.resolve());
    const linearMutationClient = { createComment, updateIssueState } as unknown as LinearIssueMutationClient;

    const receipt = await runLinearKanbanBridgeOnce({
      workflowId: 'workflow-1',
      board: 'testflight',
      artifactRoot: root,
      tracker,
      kanbanClient,
      ledger: new JsonFileIssueRunLedger(ledgerPath),
      linearMutationClient,
      defaultAssignee: 'default',
      workspace: 'scratch',
      startStateId: 'state-in-progress',
      completedStateId: 'state-done',
      commentMarker: 'symphony-linear-kanban-bridge',
      now: new Date('2026-06-24T12:10:00.000Z'),
    });

    expect(receipt).toMatchObject({
      ok: true,
      materialized: [{ issue_identifier: 'HER-SECRET', created: true }],
    });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createInputs[0]?.title).toBe('HER-SECRET [title redacted]');
    expect(createInputs[0]?.title).not.toContain('lin_api_1234567890abcdef');
    expect(JSON.stringify(receipt)).not.toContain('lin_api_1234567890abcdef');
  });

  it('redacts diagnostic tokens inside bridge provenance warnings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-kanban-bridge-warning-redaction-'));
    const ledgerPath = join(root, 'bridge-ledger.json');
    const secretToken = 'lin_api_1234567890abcdef';
    const tracker = {
      fetch_candidate_issues: vi.fn(() => Promise.reject(new Error(`Linear fetch failed: ${secretToken}`))),
      getRequiredLabels: () => [],
      selectorScopeForReceipt: () => teamSelectorScope('HER'),
    };
    const { client: kanbanClient, createTask } = fakeKanbanClient();
    const linearMutationClient = {
      createComment: vi.fn(() => Promise.resolve({ comment_id: 'c', comment_url: 'https://linear.app/comment/c' })),
      updateIssueState: vi.fn(() => Promise.resolve()),
    } as unknown as LinearIssueMutationClient;

    const receipt = await runLinearKanbanBridgeOnce({
      workflowId: 'workflow-1',
      board: 'testflight',
      artifactRoot: root,
      tracker,
      kanbanClient,
      ledger: new JsonFileIssueRunLedger(ledgerPath),
      linearMutationClient,
      defaultAssignee: 'default',
      workspace: 'scratch',
      startStateId: null,
      completedStateId: null,
      commentMarker: 'symphony-linear-kanban-bridge',
      now: new Date('2026-06-24T12:10:00.000Z'),
    });

    expect(receipt).toMatchObject({
      ok: true,
      candidates: 0,
      materialized: [],
      skipped: [],
      completed: [],
    });
    expect(receipt.provenance_warnings).toHaveLength(1);
    expect(receipt.provenance_warnings[0]?.kind).toBe('unavailable');
    expect(receipt.provenance_warnings[0]?.message).toContain('fetch_candidate_issues unavailable:');
    expect(receipt.provenance_warnings[0]?.message).toContain('[REDACTED]');
    expect(receipt.provenance_warnings[0]?.message).not.toContain(secretToken);
    expect(JSON.stringify(receipt)).not.toContain(secretToken);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('parks no-worker bridge materializations unassigned and sticky-blocked with receipt evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-kanban-bridge-no-worker-'));
    const ledgerPath = join(root, 'bridge-ledger.json');
    const tracker = {
      fetch_candidate_issues: vi.fn(() => Promise.resolve([issue])),
      getRequiredLabels: () => ['symphony'],
      selectorScopeForReceipt: () => teamSelectorScope('HER'),
    };
    const { client: kanbanClient, createTask, blockTask, createInputs, blockInputs } = fakeKanbanClient();
    const linearMutationClient = {
      createComment: vi.fn(() => Promise.resolve({ comment_id: 'comment-start', comment_url: 'https://linear.app/comment/comment-start' })),
      updateIssueState: vi.fn(() => Promise.resolve()),
    } as unknown as LinearIssueMutationClient;
    const bridgeInput: Parameters<typeof runLinearKanbanBridgeOnce>[0] & { readonly dispatchPolicy: 'no_worker' } = {
      workflowId: 'workflow-1',
      board: 'testflight',
      artifactRoot: root,
      tracker,
      kanbanClient,
      ledger: new JsonFileIssueRunLedger(ledgerPath),
      linearMutationClient,
      defaultAssignee: 'default',
      dispatchPolicy: 'no_worker',
      workspace: 'scratch',
      startStateId: 'state-in-progress',
      completedStateId: 'state-done',
      commentMarker: 'symphony-linear-kanban-bridge',
      now: new Date('2026-06-24T12:10:00.000Z'),
    };

    const receipt = await runLinearKanbanBridgeOnce(bridgeInput);

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createInputs[0]).toMatchObject({
      title: 'HER-8: Try automatic Linear to Kanban bridge',
      assignee: null,
      workspace: 'scratch',
      idempotencyKey: 'symphony-linear-kanban-bridge:workflow-1:issue-1',
      createdBy: 'symphony-linear-kanban-bridge',
    });
    expect(createInputs[0]?.body).toContain('Dispatch policy: no_worker');
    expect(blockTask).toHaveBeenCalledTimes(1);
    expect(blockInputs[0]?.id).toBe('t_bridge001');
    expect(blockInputs[0]?.reason).toContain('no-worker');
    expect(receipt).toMatchObject({
      dispatch_policy: 'no_worker',
      materialized: [{
        issue_identifier: 'HER-8',
        task_id: 't_bridge001',
        created: true,
        dispatch_policy: 'no_worker',
        requested_assignee: null,
        sticky_block_applied: true,
      }],
    });
  });

  it('does not retroactively sticky-block already-materialized tasks when no-worker policy is enabled later', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-kanban-bridge-existing-no-worker-'));
    const ledgerPath = join(root, 'bridge-ledger.json');
    const ledger = new JsonFileIssueRunLedger(ledgerPath);
    ledger.recordMutation({
      issue,
      key: 'kanban:task:materialized',
      operation: 'kanban.createTask',
      at: new Date('2026-06-24T12:09:00.000Z'),
      details: {
        task_id: 't_existing_no_worker',
        board: 'testflight',
        idempotency_key: 'symphony-linear-kanban-bridge:workflow-1:issue-1',
        dispatch_policy: 'dispatchable',
        requested_assignee: 'default',
        sticky_block_applied: false,
      },
    });
    const tracker = {
      fetch_candidate_issues: vi.fn(() => Promise.resolve([issue])),
      getRequiredLabels: () => ['symphony'],
      selectorScopeForReceipt: () => teamSelectorScope('HER'),
    };
    const { client: kanbanClient, createTask, blockTask } = fakeKanbanClient();
    const linearMutationClient = {
      createComment: vi.fn(() => Promise.resolve({ comment_id: 'comment-start', comment_url: 'https://linear.app/comment/comment-start' })),
      updateIssueState: vi.fn(() => Promise.resolve()),
    } as unknown as LinearIssueMutationClient;

    const receipt = await runLinearKanbanBridgeOnce({
      workflowId: 'workflow-1',
      board: 'testflight',
      artifactRoot: root,
      tracker,
      kanbanClient,
      ledger,
      linearMutationClient,
      defaultAssignee: 'default',
      dispatchPolicy: 'no_worker',
      workspace: 'scratch',
      startStateId: null,
      completedStateId: null,
      commentMarker: 'symphony-linear-kanban-bridge',
      now: new Date('2026-06-24T12:10:00.000Z'),
    });

    expect(createTask).not.toHaveBeenCalled();
    expect(blockTask).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      dispatch_policy: 'no_worker',
      materialized: [{
        issue_identifier: 'HER-8',
        task_id: 't_existing_no_worker',
        created: false,
        dispatch_policy: 'no_worker',
        requested_assignee: null,
        sticky_block_applied: false,
      }],
    });
  });

  it('materializes eligible Linear issues as idempotent Kanban tasks and records Linear start mutations once across restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-kanban-bridge-'));
    const ledgerPath = join(root, 'bridge-ledger.json');
    const tracker = {
      fetch_candidate_issues: vi.fn(() => Promise.resolve([issue])),
      getRequiredLabels: () => ['symphony'],
      selectorScopeForReceipt: () => teamSelectorScope('HER'),
    };
    const { client: kanbanClient, createTask, createInputs } = fakeKanbanClient();
    const commentInputs: { issueId: string; body: string }[] = [];
    const stateInputs: { issueId: string; stateId: string }[] = [];
    const createComment = vi.fn((input: { issueId: string; body: string }) => {
      commentInputs.push(input);
      return Promise.resolve({ comment_id: 'comment-start', comment_url: 'https://linear.app/comment/comment-start' });
    });
    const updateIssueState = vi.fn((input: { issueId: string; stateId: string }) => {
      stateInputs.push(input);
      return Promise.resolve();
    });
    const linearMutationClient = { createComment, updateIssueState } as unknown as LinearIssueMutationClient;

    const first = await runLinearKanbanBridgeOnce({
      workflowId: 'workflow-1',
      board: 'testflight',
      artifactRoot: root,
      tracker,
      kanbanClient,
      ledger: new JsonFileIssueRunLedger(ledgerPath),
      linearMutationClient,
      defaultAssignee: 'default',
      workspace: 'scratch',
      startStateId: 'state-in-progress',
      completedStateId: 'state-done',
      commentMarker: 'symphony-linear-kanban-bridge',
      now: new Date('2026-06-24T12:10:00.000Z'),
    });

    const second = await runLinearKanbanBridgeOnce({
      workflowId: 'workflow-1',
      board: 'testflight',
      artifactRoot: root,
      tracker,
      kanbanClient,
      ledger: new JsonFileIssueRunLedger(ledgerPath),
      linearMutationClient,
      defaultAssignee: 'default',
      workspace: 'scratch',
      startStateId: 'state-in-progress',
      completedStateId: 'state-done',
      commentMarker: 'symphony-linear-kanban-bridge',
      now: new Date('2026-06-24T12:11:00.000Z'),
    });

    expect(first).toMatchObject({
      ok: true,
      selector_scope: { kind: 'team_key', value: 'HER', required_labels: ['symphony'], active_states: ['Todo'], max_issues_per_poll: 50 },
      materialized: [{ issue_identifier: 'HER-8', task_id: 't_bridge001', created: true }],
      skipped: [],
      completed: [],
      provenance_warnings: [],
    });
    expect(second).toMatchObject({
      ok: true,
      materialized: [{ issue_identifier: 'HER-8', task_id: 't_bridge001', created: false }],
      completed: [],
      provenance_warnings: [],
    });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'HER-8: Try automatic Linear to Kanban bridge',
      assignee: 'default',
      workspace: 'scratch',
      idempotencyKey: 'symphony-linear-kanban-bridge:workflow-1:issue-1',
      createdBy: 'symphony-linear-kanban-bridge',
    }));
    const body = createInputs[0]?.body ?? '';
    expect(body).toContain('Linear issue: HER-8');
    expect(body).toContain('Linear team: HER (Hermegeddon)');
    expect(body).toContain('Linear project: 2a5d92446e9d (Testflight)');
    expect(body).toContain('https://linear.app/hermegeddon/issue/HER-8/try-automatic-linear-to-kanban-bridge');
    expect(updateIssueState).toHaveBeenCalledTimes(1);
    expect(stateInputs).toEqual([{ issueId: 'issue-1', stateId: 'state-in-progress' }]);
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(commentInputs[0]).toMatchObject({ issueId: 'issue-1' });
    expect(commentInputs[0]?.body).toContain('Kanban task: t_bridge001');
    expect(commentInputs[0]?.body).not.toContain(root);
    expect(commentInputs[0]?.body).not.toMatch(/\/[A-Za-z0-9_.-]+/); // no absolute local path token
    expect(commentInputs[0]?.body).not.toContain('Artifact root');

    const ledgerSnapshot = new JsonFileIssueRunLedger(ledgerPath).snapshot();
    expect(ledgerSnapshot.runs[issue.id]).toMatchObject({
      issue_id: 'issue-1',
      issue_identifier: 'HER-8',
      status: 'mutation_only',
      run_id: null,
      last_error: null,
      mutation_keys: [
        'kanban:task:materialized',
        'linear:state:start:state-in-progress',
        'linear:comment:start',
      ],
    });
  });

  it('skips issues missing required labels and emits a fail-safe provenance receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-kanban-bridge-required-labels-'));
    const ledgerPath = join(root, 'bridge-ledger.json');
    const labeledIssue = { ...issue, labels: ['symphony', 'approved'] };
    const unlabeledIssue = { ...issue, id: 'issue-2', identifier: 'HER-9', labels: [] };
    const whitespaceLabelIssue = { ...issue, id: 'issue-3', identifier: 'HER-10', labels: ['  Symphony  ', ' Approved '] };
    const tracker = {
      fetch_candidate_issues: vi.fn(() => Promise.resolve([labeledIssue, unlabeledIssue, whitespaceLabelIssue])),
      getRequiredLabels: () => ['symphony', 'approved'],
      selectorScopeForReceipt: () => teamSelectorScope('HER', ['symphony', 'approved']),
    };
    const { client: kanbanClient, createTask } = fakeKanbanClient();
    const commentInputs: { issueId: string; body: string }[] = [];
    const stateInputs: { issueId: string; stateId: string }[] = [];
    const createComment = vi.fn((input: { issueId: string; body: string }) => {
      commentInputs.push(input);
      return Promise.resolve({ comment_id: 'comment-start', comment_url: 'https://linear.app/comment/comment-start' });
    });
    const updateIssueState = vi.fn((input: { issueId: string; stateId: string }) => {
      stateInputs.push(input);
      return Promise.resolve();
    });
    const linearMutationClient = { createComment, updateIssueState } as unknown as LinearIssueMutationClient;

    const receipt = await runLinearKanbanBridgeOnce({
      workflowId: 'workflow-1',
      board: 'testflight',
      artifactRoot: root,
      tracker,
      kanbanClient,
      ledger: new JsonFileIssueRunLedger(ledgerPath),
      linearMutationClient,
      defaultAssignee: 'default',
      workspace: 'scratch',
      startStateId: 'state-in-progress',
      completedStateId: 'state-done',
      commentMarker: 'symphony-linear-kanban-bridge',
      now: new Date('2026-06-24T12:10:00.000Z'),
    });

    expect(receipt).toMatchObject({
      ok: true,
      candidates: 3,
      materialized: [{ issue_identifier: 'HER-8' }, { issue_identifier: 'HER-10' }],
      skipped: [{ issue_identifier: 'HER-9', reason: 'linear_required_label_missing', missing_labels: ['symphony', 'approved'] }],
      completed: [],
      provenance_warnings: [],
    });
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(stateInputs).toEqual([{ issueId: 'issue-1', stateId: 'state-in-progress' }, { issueId: 'issue-3', stateId: 'state-in-progress' }]);
    expect(commentInputs).toHaveLength(2);
    const ledgerSnapshot = new JsonFileIssueRunLedger(ledgerPath).snapshot();
    expect(ledgerSnapshot.runs['issue-2']).toMatchObject({
      issue_id: 'issue-2',
      issue_identifier: 'HER-9',
      mutation_keys: ['linear:required_label_missing'],
    });
  });

  it('uses fetch_all_candidate_issues when provided so unlabeled issues are seen and skipped by the real client path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-kanban-bridge-real-client-path-'));
    const ledgerPath = join(root, 'bridge-ledger.json');
    const labeledIssue = { ...issue, labels: ['symphony', 'approved'] };
    const unlabeledIssue = { ...issue, id: 'issue-2', identifier: 'HER-9', labels: [] };
    const tracker = {
      fetch_candidate_issues: vi.fn(() => Promise.resolve([labeledIssue])),
      fetch_all_candidate_issues: vi.fn(() => Promise.resolve([labeledIssue, unlabeledIssue])),
      getRequiredLabels: () => ['symphony', 'approved'],
      selectorScopeForReceipt: () => teamSelectorScope('HER', ['symphony', 'approved']),
    };
    const { client: kanbanClient, createTask } = fakeKanbanClient();
    const commentInputs: { issueId: string; body: string }[] = [];
    const stateInputs: { issueId: string; stateId: string }[] = [];
    const createComment = vi.fn((input: { issueId: string; body: string }) => {
      commentInputs.push(input);
      return Promise.resolve({ comment_id: 'comment-start', comment_url: 'https://linear.app/comment/comment-start' });
    });
    const updateIssueState = vi.fn((input: { issueId: string; stateId: string }) => {
      stateInputs.push(input);
      return Promise.resolve();
    });
    const linearMutationClient = { createComment, updateIssueState } as unknown as LinearIssueMutationClient;

    const receipt = await runLinearKanbanBridgeOnce({
      workflowId: 'workflow-1',
      board: 'testflight',
      artifactRoot: root,
      tracker,
      kanbanClient,
      ledger: new JsonFileIssueRunLedger(ledgerPath),
      linearMutationClient,
      defaultAssignee: 'default',
      workspace: 'scratch',
      startStateId: 'state-in-progress',
      completedStateId: 'state-done',
      commentMarker: 'symphony-linear-kanban-bridge',
      now: new Date('2026-06-24T12:10:00.000Z'),
    });

    expect(receipt).toMatchObject({
      ok: true,
      candidates: 2,
      materialized: [{ issue_identifier: 'HER-8' }],
      skipped: [{ issue_identifier: 'HER-9', reason: 'linear_required_label_missing', missing_labels: ['symphony', 'approved'] }],
      completed: [],
      provenance_warnings: [],
    });
    expect(tracker.fetch_all_candidate_issues).toHaveBeenCalledTimes(1);
    expect(tracker.fetch_candidate_issues).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(stateInputs).toEqual([{ issueId: 'issue-1', stateId: 'state-in-progress' }]);
    expect(commentInputs).toHaveLength(1);
    const ledgerSnapshot = new JsonFileIssueRunLedger(ledgerPath).snapshot();
    expect(ledgerSnapshot.runs['issue-2']).toMatchObject({
      issue_id: 'issue-2',
      issue_identifier: 'HER-9',
      mutation_keys: ['linear:required_label_missing'],
    });
  });

  it('emits label-loss provenance and skips mutations when a materialized issue loses a required label', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-kanban-bridge-label-loss-'));
    const ledgerPath = join(root, 'bridge-ledger.json');
    const labeledIssue = { ...issue, labels: ['symphony', 'approved'] };
    const tracker = {
      fetch_candidate_issues: vi.fn()
        .mockResolvedValueOnce([labeledIssue])
        .mockResolvedValueOnce([]),
      getRequiredLabels: () => ['symphony', 'approved'],
      selectorScopeForReceipt: () => teamSelectorScope('HER', ['symphony', 'approved']),
    };
    const { client: kanbanClient, createTask } = fakeKanbanClient();
    const commentInputs: { issueId: string; body: string }[] = [];
    const stateInputs: { issueId: string; stateId: string }[] = [];
    const createComment = vi.fn((input: { issueId: string; body: string }) => {
      commentInputs.push(input);
      return Promise.resolve({ comment_id: 'comment-start', comment_url: 'https://linear.app/comment/comment-start' });
    });
    const updateIssueState = vi.fn((input: { issueId: string; stateId: string }) => {
      stateInputs.push(input);
      return Promise.resolve();
    });
    const linearMutationClient = { createComment, updateIssueState } as unknown as LinearIssueMutationClient;

    const first = await runLinearKanbanBridgeOnce({
      workflowId: 'workflow-1',
      board: 'testflight',
      artifactRoot: root,
      tracker,
      kanbanClient,
      ledger: new JsonFileIssueRunLedger(ledgerPath),
      linearMutationClient,
      defaultAssignee: 'default',
      workspace: 'scratch',
      startStateId: 'state-in-progress',
      completedStateId: 'state-done',
      commentMarker: 'symphony-linear-kanban-bridge',
      now: new Date('2026-06-24T12:10:00.000Z'),
    });

    const second = await runLinearKanbanBridgeOnce({
      workflowId: 'workflow-1',
      board: 'testflight',
      artifactRoot: root,
      tracker,
      kanbanClient,
      ledger: new JsonFileIssueRunLedger(ledgerPath),
      linearMutationClient,
      defaultAssignee: 'default',
      workspace: 'scratch',
      startStateId: 'state-in-progress',
      completedStateId: 'state-done',
      commentMarker: 'symphony-linear-kanban-bridge',
      now: new Date('2026-06-24T12:11:00.000Z'),
    });

    expect(first).toMatchObject({
      ok: true,
      candidates: 1,
      materialized: [{ issue_identifier: 'HER-8', task_id: 't_bridge001', created: true }],
      skipped: [],
      completed: [],
      provenance_warnings: [],
    });
    expect(second).toMatchObject({
      ok: true,
      candidates: 0,
      materialized: [],
      skipped: [{ issue_identifier: 'HER-8', reason: 'linear_required_label_missing', missing_labels: ['symphony', 'approved'] }],
      completed: [],
      provenance_warnings: [],
    });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(stateInputs).toEqual([{ issueId: 'issue-1', stateId: 'state-in-progress' }]);
    expect(commentInputs).toHaveLength(1);
    const ledgerSnapshot = new JsonFileIssueRunLedger(ledgerPath).snapshot();
    expect(ledgerSnapshot.runs['issue-1']).toMatchObject({
      issue_id: 'issue-1',
      issue_identifier: 'HER-8',
      mutation_keys: ['kanban:task:materialized', 'linear:state:start:state-in-progress', 'linear:comment:start', 'linear:required_label_missing'],
    });
  });

  it('syncs a completed Kanban task back to Linear exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-kanban-bridge-completion-'));
    const ledgerPath = join(root, 'bridge-ledger.json');
    const tracker = {
      fetch_candidate_issues: vi.fn(() => Promise.resolve([issue])),
      getRequiredLabels: () => ['symphony'],
      selectorScopeForReceipt: () => teamSelectorScope('HER'),
    };
    const { client: kanbanClient, setTaskStatus } = fakeKanbanClient();
    const commentInputs: { issueId: string; body: string }[] = [];
    const stateInputs: { issueId: string; stateId: string }[] = [];
    const createComment = vi.fn((input: { issueId: string; body: string }) => {
      commentInputs.push(input);
      const commentIndex = String(commentInputs.length);
      return Promise.resolve({ comment_id: `comment-${commentIndex}`, comment_url: `https://linear.app/comment/comment-${commentIndex}` });
    });
    const updateIssueState = vi.fn((input: { issueId: string; stateId: string }) => {
      stateInputs.push(input);
      return Promise.resolve();
    });
    const linearMutationClient = { createComment, updateIssueState } as unknown as LinearIssueMutationClient;

    await runLinearKanbanBridgeOnce({
      workflowId: 'workflow-1',
      board: 'testflight',
      artifactRoot: root,
      tracker,
      kanbanClient,
      ledger: new JsonFileIssueRunLedger(ledgerPath),
      linearMutationClient,
      defaultAssignee: 'default',
      workspace: 'scratch',
      startStateId: 'state-in-progress',
      completedStateId: 'state-done',
      commentMarker: 'symphony-linear-kanban-bridge',
      now: new Date('2026-06-24T12:10:00.000Z'),
    });
    setTaskStatus('t_bridge001', 'done');

    const completion = await runLinearKanbanBridgeOnce({
      workflowId: 'workflow-1',
      board: 'testflight',
      artifactRoot: root,
      tracker,
      kanbanClient,
      ledger: new JsonFileIssueRunLedger(ledgerPath),
      linearMutationClient,
      defaultAssignee: 'default',
      workspace: 'scratch',
      startStateId: 'state-in-progress',
      completedStateId: 'state-done',
      commentMarker: 'symphony-linear-kanban-bridge',
      now: new Date('2026-06-24T12:20:00.000Z'),
    });
    const repeated = await runLinearKanbanBridgeOnce({
      workflowId: 'workflow-1',
      board: 'testflight',
      artifactRoot: root,
      tracker,
      kanbanClient,
      ledger: new JsonFileIssueRunLedger(ledgerPath),
      linearMutationClient,
      defaultAssignee: 'default',
      workspace: 'scratch',
      startStateId: 'state-in-progress',
      completedStateId: 'state-done',
      commentMarker: 'symphony-linear-kanban-bridge',
      now: new Date('2026-06-24T12:21:00.000Z'),
    });

    expect(completion).toMatchObject({
      ok: true,
      completed: [{ issue_identifier: 'HER-8', task_id: 't_bridge001', task_status: 'done', completed: true }],
      provenance_warnings: [],
    });
    expect(repeated).toMatchObject({
      ok: true,
      completed: [{ issue_identifier: 'HER-8', task_id: 't_bridge001', task_status: 'done', completed: false }],
      provenance_warnings: [],
    });
    expect(stateInputs).toEqual([
      { issueId: 'issue-1', stateId: 'state-in-progress' },
      { issueId: 'issue-1', stateId: 'state-done' },
    ]);
    expect(commentInputs).toHaveLength(2);
    expect(commentInputs[1]?.body).toContain('Symphony observed Kanban task t_bridge001 completed.');
    expect(commentInputs[1]?.body).not.toContain(root);
    expect(commentInputs[1]?.body).not.toMatch(/\/[A-Za-z0-9_.-]+/); // no absolute local path token
    expect(commentInputs[1]?.body).not.toContain('Artifact root');
  });
});
