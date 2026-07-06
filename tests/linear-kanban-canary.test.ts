import { describe, expect, it } from 'vitest';

import { runNoWorkerLinearKanbanCanary, NoWorkerLinearKanbanCanaryError } from '../src/linear-kanban-canary.js';
import type {
  CreateKanbanTaskInput,
  KanbanBoard,
  KanbanClient,
  KanbanDispatchDryRun,
  KanbanTaskDetail,
  KanbanTaskRef,
  KanbanTaskSummary,
} from '../src/kanban-types.js';

class FakeKanbanClient implements Pick<KanbanClient, 'boardShow' | 'createTask' | 'showTask' | 'dispatchDryRun'> {
  public readonly createCalls: CreateKanbanTaskInput[] = [];
  public dryRun: KanbanDispatchDryRun = { spawned: [], autoAssignedDefault: [], skippedNonspawnable: [] };
  public detailOverride: ((detail: KanbanTaskDetail) => KanbanTaskDetail) | null = null;
  private readonly details = new Map<string, KanbanTaskDetail>();
  private readonly idsByIdempotencyKey = new Map<string, string>();

  public boardShow(slug: string): Promise<KanbanBoard> {
    return Promise.resolve({ slug, name: 'Testflight', archived: false, taskCount: this.details.size });
  }

  public createTask(input: CreateKanbanTaskInput): Promise<KanbanTaskRef> {
    this.createCalls.push(input);
    const idempotencyKey = input.idempotencyKey ?? input.title;
    const id = this.idsByIdempotencyKey.get(idempotencyKey) ?? `t_${String(this.details.size + 1).padStart(4, '0')}`;
    this.idsByIdempotencyKey.set(idempotencyKey, id);
    const parentSummaries = (input.parentIds ?? []).map((parentId) => {
      const parent = this.details.get(parentId);
      if (parent === undefined) {
        throw new Error(`missing parent ${parentId}`);
      }
      return taskSummary(parent);
    });
    const detail: KanbanTaskDetail = {
      id,
      title: input.title,
      status: input.initialStatus ?? (parentSummaries.length > 0 ? 'todo' : 'ready'),
      assignee: input.assignee ?? null,
      body: input.body ?? null,
      parents: parentSummaries,
      children: [],
      parentLinks: [],
      childLinks: [],
      comments: [],
      raw: { idempotencyKey },
    };
    for (const parent of parentSummaries) {
      const parentDetail = this.details.get(parent.id);
      if (parentDetail !== undefined) {
        this.details.set(parent.id, { ...parentDetail, children: [...parentDetail.children, taskSummary(detail)] });
      }
    }
    this.details.set(id, detail);
    return Promise.resolve({ id });
  }

  public showTask(id: string): Promise<KanbanTaskDetail> {
    const detail = this.details.get(id);
    if (detail === undefined) {
      return Promise.reject(new Error(`missing task ${id}`));
    }
    return Promise.resolve(this.detailOverride === null ? detail : this.detailOverride(detail));
  }

  public dispatchDryRun(): Promise<KanbanDispatchDryRun> {
    return Promise.resolve(this.dryRun);
  }
}

function taskSummary(task: KanbanTaskDetail): KanbanTaskSummary {
  return { id: task.id, title: task.title, status: task.status, assignee: task.assignee };
}

const baseInput = {
  workflowId: 'symphony-testflight-linear-kanban-canary-2026-06-23',
  artifactRoot: '~/.hermes/artifacts/symphony/testflight/linear-kanban-canary-2026-06-23',
  linear: {
    teamKey: 'HER',
    teamName: 'Hermegeddon',
    projectId: '0c73139f-9bee-4d07-8d1a-c561fe20cb36',
    projectName: 'Testflight',
    projectUrl: 'https://linear.app/hermegeddon/project/testflight-2a5d92446e9d',
    issueIdentifier: 'HER-6',
    issueTitle: 'Testflight canary: Symphony Kanban materialization smoke',
    issueUrl: 'https://linear.app/hermegeddon/issue/HER-6/testflight-canary-symphony-kanban-materialization-smoke',
  },
  kanban: {
    board: 'testflight',
  },
} as const;

describe('Linear Project to Hermes Kanban no-worker canary', () => {
  it('materializes the Testflight canary as a blocked no-worker graph and verifies dry-run cannot spawn', async () => {
    const client = new FakeKanbanClient();

    const receipt = await runNoWorkerLinearKanbanCanary({ ...baseInput, client });

    expect(receipt.ok).toBe(true);
    expect(receipt.effect).toBe('no_worker_materialization');
    expect(receipt.linear.issueIdentifier).toBe('HER-6');
    expect(receipt.kanban.board).toBe('testflight');
    expect(receipt.kanban.dryRun.spawned).toEqual([]);
    expect(receipt.kanban.dryRun.autoAssignedDefault).toEqual([]);
    expect(receipt.kanban.tasks.map((task) => ({ key: task.key, title: task.title, status: task.status, assignee: task.assignee, parentIds: task.parentIds }))).toEqual([
      { key: 'K0', title: 'Testflight canary anchor', status: 'blocked', assignee: null, parentIds: [] },
      { key: 'K1', title: 'Testflight materialization readback smoke', status: 'blocked', assignee: null, parentIds: ['t_0001'] },
      { key: 'K2', title: 'Human gate: approve any worker/gateway pilot', status: 'blocked', assignee: null, parentIds: ['t_0002'] },
    ]);
    expect(client.createCalls.map((call) => ({ title: call.title, assignee: call.assignee, initialStatus: call.initialStatus, idempotencyKey: call.idempotencyKey }))).toEqual([
      {
        title: 'Testflight canary anchor',
        assignee: null,
        initialStatus: 'blocked',
        idempotencyKey: 'symphony-testflight-linear-kanban-canary-2026-06-23:K0',
      },
      {
        title: 'Testflight materialization readback smoke',
        assignee: null,
        initialStatus: 'blocked',
        idempotencyKey: 'symphony-testflight-linear-kanban-canary-2026-06-23:K1',
      },
      {
        title: 'Human gate: approve any worker/gateway pilot',
        assignee: null,
        initialStatus: 'blocked',
        idempotencyKey: 'symphony-testflight-linear-kanban-canary-2026-06-23:K2',
      },
    ]);
    expect(client.createCalls[0]?.body).toContain('Linear issue: HER-6');
    expect(client.createCalls[0]?.body).toContain('Do not dispatch workers.');
    expect(client.createCalls[0]?.body).toContain('Do not mutate repository files.');
  });

  it('fails closed when Kanban dry-run reveals default auto-assignment would make the canary spawnable', async () => {
    const client = new FakeKanbanClient();
    client.dryRun = {
      spawned: ['t_0001'],
      autoAssignedDefault: ['t_0001'],
      skippedNonspawnable: [],
    };

    await expect(runNoWorkerLinearKanbanCanary({ ...baseInput, client })).rejects.toMatchObject({
      code: 'kanban_no_worker_dispatch_runnable',
    });
    await expect(runNoWorkerLinearKanbanCanary({ ...baseInput, client })).rejects.toBeInstanceOf(NoWorkerLinearKanbanCanaryError);
  });

  it('fails closed when task readback omits required provenance or safety text', async () => {
    const client = new FakeKanbanClient();
    client.detailOverride = (detail) => ({ ...detail, body: 'missing provenance and safety text' });

    await expect(runNoWorkerLinearKanbanCanary({ ...baseInput, client })).rejects.toMatchObject({
      code: 'kanban_no_worker_readback_incomplete',
    });
  });

  it('fails closed when task readback omits expected parent links', async () => {
    const client = new FakeKanbanClient();
    client.detailOverride = (detail) => detail.title === 'Testflight canary anchor' ? detail : { ...detail, parents: [] };

    await expect(runNoWorkerLinearKanbanCanary({ ...baseInput, client })).rejects.toMatchObject({
      code: 'kanban_no_worker_topology_mismatch',
    });
  });
});
