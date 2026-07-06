import { describe, expect, it } from 'vitest';

import { KanbanGraphMaterializationError, materializeKanbanTaskGraph } from '../src/kanban-graph-materializer.js';
import type { CreateKanbanTaskInput, KanbanClient, KanbanTaskRef } from '../src/kanban-types.js';

function fakeCreateClient() {
  const calls: CreateKanbanTaskInput[] = [];
  const idsByTitle = new Map<string, string>();
  const client: Pick<KanbanClient, 'createTask'> = {
    createTask: (input): Promise<KanbanTaskRef> => {
      calls.push(input);
      const id = idsByTitle.get(input.title) ?? `t_${input.title.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8)}`;
      idsByTitle.set(input.title, id);
      return Promise.resolve({ id });
    },
  };
  return { calls, client };
}

describe('Kanban task graph materializer', () => {
  it('creates a dependency-gated graph in parent-first order with parent ids at creation time', async () => {
    const { calls, client } = fakeCreateClient();

    const result = await materializeKanbanTaskGraph({
      client,
      workflow: {
        id: 'wf-kanban-001',
        board: 'symphony-test',
        title: 'Kanban-backed Symphony milestone',
        planPath: '/repo/private-plans/kanban-plan.md',
        artifactRoot: '/tmp/artifacts/symphony-test',
        nonAuthorizations: ['No push, PR, publish, deploy, service restart, credential mutation, or real-board dispatch.'],
        repo: { root: '/repo', baseRef: 'd89d4ac' },
      },
      defaultAssignee: 'default',
      nodes: [
        {
          key: 'K0',
          kind: 'anchor',
          title: 'K0 plan/status anchor',
          goal: 'Keep the implementation contract visible.',
          assignee: null,
          acceptanceCriteria: ['All downstream work preserves the plan authority boundary.'],
        },
        {
          key: 'K1',
          kind: 'implementation',
          title: 'K1 implement materializer',
          goal: 'Implement the typed Kanban materializer.',
          parentKeys: ['K0'],
          assignee: 'backend-eng',
          repoMutation: { worktreePath: '/tmp/worktrees/k1' },
          acceptanceCriteria: ['Tests cover call order and safety gates.'],
          expectedArtifacts: ['test output summary', 'changed file list'],
        },
        {
          key: 'K2',
          kind: 'review',
          title: 'K2 independent review',
          goal: 'Review safety/schema/CLI boundary correctness.',
          parentKeys: ['K1'],
          assignee: 'reviewer',
          acceptanceCriteria: ['Return PASS/BLOCK with evidence.'],
        },
      ],
    });

    expect(result.createdTasks).toEqual([
      { key: 'K0', taskId: 't_k0planst' },
      { key: 'K1', taskId: 't_k1implem' },
      { key: 'K2', taskId: 't_k2indepe' },
    ]);
    expect(calls.map((call) => ({ title: call.title, assignee: call.assignee, parentIds: call.parentIds, workspace: call.workspace, idempotencyKey: call.idempotencyKey }))).toEqual([
      { title: 'K0 plan/status anchor', assignee: null, parentIds: [], workspace: 'scratch', idempotencyKey: 'wf-kanban-001:K0' },
      { title: 'K1 implement materializer', assignee: 'backend-eng', parentIds: ['t_k0planst'], workspace: 'worktree:/tmp/worktrees/k1', idempotencyKey: 'wf-kanban-001:K1' },
      { title: 'K2 independent review', assignee: 'reviewer', parentIds: ['t_k1implem'], workspace: 'scratch', idempotencyKey: 'wf-kanban-001:K2' },
    ]);
    expect(calls[1]?.body).toContain('Board: symphony-test');
    expect(calls[1]?.body).toContain('Plan: /repo/private-plans/kanban-plan.md');
    expect(calls[1]?.body).toContain('Repo root: /repo');
    expect(calls[1]?.body).toContain('Base ref: d89d4ac');
    expect(calls[1]?.body).toContain('Worktree path: /tmp/worktrees/k1');
    expect(calls[1]?.body).toContain('Acceptance criteria');
    expect(calls[1]?.body).toContain('Expected artifacts');
    expect(calls[1]?.body).toContain('No push, PR, publish, deploy');
  });

  it('keeps absolute local paths inside Kanban task bodies and redacts them if ever forwarded to Linear', async () => {
    const { calls, client } = fakeCreateClient();

    await materializeKanbanTaskGraph({
      client,
      workflow: {
        id: 'wf-kanban-privacy',
        board: 'symphony-test',
        artifactRoot: '/home/symphony-user/.hermes/artifacts/symphony-test',
        nonAuthorizations: ['No push, PR, publish, deploy, service restart, credential mutation, or real-board dispatch.'],
        repo: { root: '/home/symphony-user/dev/symphony-ts', baseRef: 'HEAD' },
      },
      defaultAssignee: 'backend-eng',
      nodes: [
        {
          key: 'PRIV',
          kind: 'implementation',
          title: 'Privacy interlock test',
          goal: 'Verify local paths remain inside Kanban and never leak to Linear.',
          assignee: 'backend-eng',
          repoMutation: { worktreePath: '/tmp/worktrees/priv' },
          acceptanceCriteria: ['Kanban body contains local paths for worker context.', 'Linear-visible rendering of the same text redacts those paths.'],
        },
        {
          key: 'PRIV-REVIEW',
          kind: 'review',
          title: 'Privacy interlock review',
          goal: 'Verify the privacy boundary.',
          parentKeys: ['PRIV'],
          assignee: 'reviewer',
          acceptanceCriteria: ['Confirm local paths do not leak to Linear.'],
        },
      ],
    });

    const body = calls[0]?.body ?? '';
    expect(body).toContain('Artifact root: /home/symphony-user/.hermes/artifacts/symphony-test');
    expect(body).toContain('Repo root: /home/symphony-user/dev/symphony-ts');
    expect(body).toContain('Worktree path: /tmp/worktrees/priv');
    const { sanitizeLinearCommentBody } = await import('../src/linear-lifecycle-notifier.js');
    const linearSafe = sanitizeLinearCommentBody(body);
    expect(linearSafe).not.toContain('/home/symphony-user/.hermes/artifacts/symphony-test');
    expect(linearSafe).not.toContain('/home/symphony-user/dev/symphony-ts');
    expect(linearSafe).not.toContain('/tmp/worktrees/priv');
    expect(linearSafe).toContain('[REDACTED');
  });

  it('can create a non-human anchor as blocked so no-worker canaries avoid default auto-assignment', async () => {
    const { calls, client } = fakeCreateClient();

    await expect(materializeKanbanTaskGraph({
      client,
      workflow: {
        id: 'wf-blocked-anchor',
        board: 'symphony-test',
        artifactRoot: '/tmp/artifacts/blocked-anchor',
        nonAuthorizations: ['No worker dispatch.'],
      },
      nodes: [
        {
          key: 'K0',
          kind: 'anchor',
          title: 'Blocked no-worker anchor',
          goal: 'Remain blocked unless a worker pilot is approved.',
          assignee: null,
          initialStatus: 'blocked',
          acceptanceCriteria: ['Dry-run must not auto-assign this anchor to a default worker.'],
        },
      ],
    })).resolves.toEqual({ createdTasks: [{ key: 'K0', taskId: 't_blockedn' }] });

    expect(calls[0]).toMatchObject({
      title: 'Blocked no-worker anchor',
      assignee: null,
      initialStatus: 'blocked',
      idempotencyKey: 'wf-blocked-anchor:K0',
    });
  });

  it('uses stable idempotency keys so repeated materialization returns the existing task ids', async () => {
    const { calls, client } = fakeCreateClient();
    const input = {
      client,
      workflow: {
        id: 'wf-repeat',
        board: 'symphony-test',
        artifactRoot: '/tmp/artifacts/repeat',
        nonAuthorizations: ['Local test only.'],
      },
      nodes: [
        { key: 'K0', kind: 'anchor' as const, title: 'K0 repeat anchor', goal: 'Anchor', assignee: null, acceptanceCriteria: ['Exists once.'] },
      ],
    };

    await expect(materializeKanbanTaskGraph(input)).resolves.toEqual({
      createdTasks: [{ key: 'K0', taskId: 't_k0repeat' }],
    });
    await expect(materializeKanbanTaskGraph(input)).resolves.toEqual({
      createdTasks: [{ key: 'K0', taskId: 't_k0repeat' }],
    });

    expect(calls.map((call) => call.idempotencyKey)).toEqual(['wf-repeat:K0', 'wf-repeat:K0']);
  });

  it('refuses external-action nodes unless they are explicit unassigned human gates', async () => {
    const { calls, client } = fakeCreateClient();

    await expect(materializeKanbanTaskGraph({
      client,
      workflow: {
        id: 'wf-external',
        board: 'symphony-test',
        artifactRoot: '/tmp/artifacts/external',
        nonAuthorizations: ['No external actions.'],
      },
      nodes: [
        {
          key: 'PUSH',
          kind: 'implementation',
          title: 'Push branch',
          goal: 'Push code externally.',
          assignee: 'backend-eng',
          externalAction: true,
          acceptanceCriteria: ['Should be gated.'],
        },
      ],
    })).rejects.toBeInstanceOf(KanbanGraphMaterializationError);
    expect(calls).toEqual([]);

    await expect(materializeKanbanTaskGraph({
      client,
      workflow: {
        id: 'wf-external-gate',
        board: 'symphony-test',
        artifactRoot: '/tmp/artifacts/external',
        nonAuthorizations: ['No external actions without this human gate being approved.'],
      },
      nodes: [
        {
          key: 'GATE',
          kind: 'human_gate',
          title: 'Human approval: push branch',
          goal: 'Wait for explicit human approval.',
          assignee: null,
          externalAction: true,
          humanGate: true,
          acceptanceCriteria: ['Remain unassigned until the operator approves the exact external action.'],
        },
      ],
    })).resolves.toEqual({ createdTasks: [{ key: 'GATE', taskId: 't_humanapp' }] });
    expect(calls[calls.length - 1]?.assignee).toBeNull();
  });

  it('fails before creating repo-mutating cards without an explicit worktree path and review child', async () => {
    const { calls, client } = fakeCreateClient();
    const baseWorkflow = {
      id: 'wf-repo-safety',
      board: 'symphony-test',
      artifactRoot: '/tmp/artifacts/repo',
      nonAuthorizations: ['Local repo edits only; no push.'],
      repo: { root: '/repo', baseRef: 'HEAD' },
    };

    await expect(materializeKanbanTaskGraph({
      client,
      workflow: baseWorkflow,
      nodes: [
        {
          key: 'K1',
          kind: 'implementation',
          title: 'Mutate repo without worktree',
          goal: 'Unsafe edit.',
          assignee: 'backend-eng',
          repoMutation: true,
          acceptanceCriteria: ['Should fail.'],
        },
      ],
    })).rejects.toMatchObject({ field: 'nodes.K1.repoMutation.worktreePath' });

    await expect(materializeKanbanTaskGraph({
      client,
      workflow: baseWorkflow,
      nodes: [
        {
          key: 'K1',
          kind: 'implementation',
          title: 'Mutate repo without review child',
          goal: 'Unsafe edit.',
          assignee: 'backend-eng',
          repoMutation: { worktreePath: '/tmp/worktrees/k1' },
          acceptanceCriteria: ['Should fail.'],
        },
      ],
    })).rejects.toMatchObject({ field: 'nodes.K1.review' });

    expect(calls).toEqual([]);
  });
});
