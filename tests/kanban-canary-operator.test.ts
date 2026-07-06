import { mkdtemp, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  runKanbanCanaryOperator,
  type KanbanCanaryOperatorInput,
  type KanbanCanaryTaskKey,
} from '../src/kanban-canary-operator.js';
import { runSymphonyKanbanCanaryCli } from '../src/cli/kanban-canary.js';
import type {
  CreateKanbanTaskInput,
  KanbanBoard,
  KanbanClient,
  KanbanDispatchDryRun,
  KanbanTaskDetail,
  KanbanTaskRef,
  KanbanTaskSummary,
} from '../src/kanban-types.js';

class FakeKanbanCanaryClient implements Pick<KanbanClient, 'boardShow' | 'listTasks' | 'createTask' | 'showTask' | 'dispatchDryRun'> {
  public readonly createCalls: CreateKanbanTaskInput[] = [];
  public dryRun: KanbanDispatchDryRun = { spawned: [], autoAssignedDefault: [], skippedNonspawnable: [] };
  private readonly details = new Map<string, KanbanTaskDetail>();
  private readonly idsByIdempotencyKey = new Map<string, string>();

  public boardShow(slug: string): Promise<KanbanBoard> {
    return Promise.resolve({ slug, name: 'Testflight', archived: false, taskCount: this.details.size });
  }

  public listTasks(): Promise<readonly KanbanTaskSummary[]> {
    return Promise.resolve([...this.details.values()].map(taskSummary));
  }

  public createTask(input: CreateKanbanTaskInput): Promise<KanbanTaskRef> {
    this.createCalls.push(input);
    const idempotencyKey = input.idempotencyKey ?? input.title;
    const id = this.idsByIdempotencyKey.get(idempotencyKey) ?? `t_created_${String(this.details.size + 1).padStart(2, '0')}`;
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
    this.putTask(detail);
    return Promise.resolve({ id });
  }

  public showTask(id: string): Promise<KanbanTaskDetail> {
    const detail = this.details.get(id);
    if (detail === undefined) {
      return Promise.reject(new Error(`missing task ${id}`));
    }
    return Promise.resolve(detail);
  }

  public dispatchDryRun(): Promise<KanbanDispatchDryRun> {
    return Promise.resolve(this.dryRun);
  }

  public seedGraph(overrides: Partial<Record<KanbanCanaryTaskKey, Partial<KanbanTaskDetail>>> = {}): Record<KanbanCanaryTaskKey, string> {
    const ids: Record<KanbanCanaryTaskKey, string> = {
      K0: 't_k0',
      K1: 't_k1',
      K2: 't_k2',
    };
    const k0 = this.makeTask('K0', ids.K0, 'Testflight canary anchor', [], overrides.K0);
    this.putTask(k0);
    const k1 = this.makeTask('K1', ids.K1, 'Testflight materialization readback smoke', [k0], overrides.K1);
    this.putTask(k1);
    const k2 = this.makeTask('K2', ids.K2, 'Human gate: approve any worker/gateway pilot', [k1], overrides.K2);
    this.putTask(k2);
    return ids;
  }

  private makeTask(
    key: KanbanCanaryTaskKey,
    id: string,
    title: string,
    parents: readonly KanbanTaskDetail[],
    override: Partial<KanbanTaskDetail> | undefined,
  ): KanbanTaskDetail {
    const base: KanbanTaskDetail = {
      id,
      title,
      status: 'blocked',
      assignee: null,
      body: bodyFor(key),
      parents: parents.map(taskSummary),
      children: [],
      parentLinks: [],
      childLinks: [],
      comments: [],
      raw: { nodeKey: key },
    };
    return {
      ...base,
      ...override,
      parents: override?.parents ?? base.parents,
      children: override?.children ?? base.children,
      parentLinks: override?.parentLinks ?? base.parentLinks,
      childLinks: override?.childLinks ?? base.childLinks,
      comments: override?.comments ?? base.comments,
      raw: override?.raw ?? base.raw,
    };
  }

  private putTask(detail: KanbanTaskDetail): void {
    this.details.set(detail.id, detail);
    for (const parent of detail.parents) {
      const parentDetail = this.details.get(parent.id);
      if (parentDetail !== undefined && !parentDetail.children.some((child) => child.id === detail.id)) {
        this.details.set(parent.id, { ...parentDetail, children: [...parentDetail.children, taskSummary(detail)] });
      }
    }
  }
}

function taskSummary(task: KanbanTaskDetail): KanbanTaskSummary {
  return { id: task.id, title: task.title, status: task.status, assignee: task.assignee };
}

function bodyFor(key: KanbanCanaryTaskKey): string {
  return [
    `# ${key}`,
    'Workflow: symphony-testflight-linear-kanban-canary-2026-06-23',
    'Board: testflight',
    'Linear team: HER',
    'Linear project: Testflight',
    'Linear issue: HER-6',
    `Node key: ${key}`,
    'Artifact root: /home/symphony-user/.hermes/artifacts/symphony/testflight',
    'Do not dispatch workers.',
    'Do not mutate repository files.',
    'Do not push, PR, publish, deploy, expose services, or edit public state.',
    'Do not start or restart Hermes gateway, Kanban daemon, Symphony service, or systemd units.',
  ].join('\n');
}

const taskIds: Record<KanbanCanaryTaskKey, string> = { K0: 't_k0', K1: 't_k1', K2: 't_k2' };

const baseInput = {
  mode: 'readback-only',
  workflowId: 'symphony-testflight-linear-kanban-canary-2026-06-23',
  artifactRoot: '/home/symphony-user/.hermes/artifacts/symphony/testflight',
  command: {
    argv: ['symphony-kanban-canary', '--mode', 'readback-only', '--linear-issue-identifier', 'HER-6'],
  },
  linear: {
    teamKey: 'HER',
    teamName: 'Hermegeddon',
    projectId: 'testflight-project-id',
    projectName: 'Testflight',
    projectUrl: 'https://linear.app/hermegeddon/project/testflight',
    issueIdentifier: 'HER-6',
    issueTitle: 'Testflight canary: Symphony Kanban materialization smoke',
    issueUrl: 'https://linear.app/hermegeddon/issue/HER-6/testflight-canary',
  },
  kanban: {
    board: 'testflight',
  },
  existingTaskIds: taskIds,
} as const satisfies Omit<KanbanCanaryOperatorInput, 'client'>;

function inputFor(client: FakeKanbanCanaryClient, overrides: Partial<Omit<KanbanCanaryOperatorInput, 'client'>> = {}): KanbanCanaryOperatorInput {
  return {
    ...baseInput,
    client,
    ...overrides,
  };
}

describe('Symphony Kanban no-worker canary operator', () => {
  it('succeeds in readback-only mode against an already-materialized fake graph', async () => {
    const client = new FakeKanbanCanaryClient();
    client.seedGraph();

    const receipt = await runKanbanCanaryOperator(inputFor(client));

    expect(receipt.ok).toBe(true);
    expect(receipt.status).toBe('PASS');
    expect(receipt.effect).toBe('readback_only');
    expect(receipt.kanban.task_ids).toEqual(taskIds);
    expect(receipt.kanban.tasks.map((task) => ({ key: task.key, blocked: task.checks.blocked, unassigned: task.checks.unassigned }))).toEqual([
      { key: 'K0', blocked: true, unassigned: true },
      { key: 'K1', blocked: true, unassigned: true },
      { key: 'K2', blocked: true, unassigned: true },
    ]);
    expect(receipt.kanban.topology).toEqual([
      { parent_key: 'K0', parent_id: 't_k0', child_key: 'K1', child_id: 't_k1', present: true },
      { parent_key: 'K1', parent_id: 't_k1', child_key: 'K2', child_id: 't_k2', present: true },
    ]);
    expect(receipt.kanban.dry_run.spawned).toEqual([]);
    expect(receipt.kanban.dry_run.auto_assigned_default).toEqual([]);
    expect(receipt.hash_manifest.algorithm).toBe('sha256');
    expect(client.createCalls).toEqual([]);
  });

  it('materialize-if-missing creates a missing graph exactly once and reuses it on the next run', async () => {
    const client = new FakeKanbanCanaryClient();
    const materializeInput = inputFor(client, { mode: 'materialize-if-missing', existingTaskIds: undefined });

    const first = await runKanbanCanaryOperator(materializeInput);
    const second = await runKanbanCanaryOperator(materializeInput);

    expect(first.ok).toBe(true);
    expect(first.effect).toBe('materialize_if_missing');
    expect(first.created.map((task) => task.key)).toEqual(['K0', 'K1', 'K2']);
    expect(second.ok).toBe(true);
    expect(second.created).toEqual([]);
    expect(client.createCalls.map((call) => call.idempotencyKey)).toEqual([
      'symphony-testflight-linear-kanban-canary-2026-06-23:K0',
      'symphony-testflight-linear-kanban-canary-2026-06-23:K1',
      'symphony-testflight-linear-kanban-canary-2026-06-23:K2',
    ]);
  });

  it('does not duplicate an existing graph in materialize-if-missing mode', async () => {
    const client = new FakeKanbanCanaryClient();
    client.seedGraph();

    const receipt = await runKanbanCanaryOperator(inputFor(client, { mode: 'materialize-if-missing', existingTaskIds: undefined }));

    expect(receipt.ok).toBe(true);
    expect(receipt.created).toEqual([]);
    expect(client.createCalls).toEqual([]);
  });

  it('fails closed when any card is not blocked', async () => {
    const client = new FakeKanbanCanaryClient();
    client.seedGraph({ K1: { status: 'ready' } });

    const receipt = await runKanbanCanaryOperator(inputFor(client));

    expect(receipt.ok).toBe(false);
    expect(receipt.status).toBe('BLOCK');
    expect(receipt.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'kanban_no_worker_card_not_blocked', task_id: 't_k1' })]));
  });

  it('fails closed when any card is assigned', async () => {
    const client = new FakeKanbanCanaryClient();
    client.seedGraph({ K2: { assignee: 'default' } });

    const receipt = await runKanbanCanaryOperator(inputFor(client));

    expect(receipt.ok).toBe(false);
    expect(receipt.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'kanban_no_worker_card_assigned', task_id: 't_k2' })]));
  });

  it('fails closed when body safety or provenance text is missing', async () => {
    const client = new FakeKanbanCanaryClient();
    client.seedGraph({ K0: { body: 'Workflow: symphony-testflight-linear-kanban-canary-2026-06-23\nLinear issue: HER-6' } });

    const receipt = await runKanbanCanaryOperator(inputFor(client));

    expect(receipt.ok).toBe(false);
    expect(receipt.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'kanban_no_worker_body_incomplete', task_id: 't_k0' })]));
    expect(receipt.kanban.tasks[0]?.body_checks).toMatchObject({ do_not_dispatch: false, no_repo_mutation: false, artifact_root: false });
  });

  it('accepts an existing card body that spells the approved artifact root with home shorthand', async () => {
    const client = new FakeKanbanCanaryClient();
    const shorthandBody = (key: KanbanCanaryTaskKey): string => bodyFor(key).replace(
      '/home/symphony-user/.hermes/artifacts/symphony/testflight',
      '~/.hermes/artifacts/symphony/testflight',
    );
    client.seedGraph({
      K0: { body: shorthandBody('K0') },
      K1: { body: shorthandBody('K1') },
      K2: { body: shorthandBody('K2') },
    });

    const receipt = await runKanbanCanaryOperator(inputFor(client, {
      artifactRoot: `${homedir()}/.hermes/artifacts/symphony/testflight`,
    }));

    expect(receipt.ok).toBe(true);
    expect(receipt.kanban.tasks.map((task) => task.body_checks.artifact_root)).toEqual([true, true, true]);
  });

  it('fails closed when the expected K0 -> K1 -> K2 topology is absent', async () => {
    const client = new FakeKanbanCanaryClient();
    client.seedGraph({ K2: { parents: [{ id: 't_k0', title: 'Testflight canary anchor', status: 'blocked', assignee: null }] } });

    const receipt = await runKanbanCanaryOperator(inputFor(client));

    expect(receipt.ok).toBe(false);
    expect(receipt.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'kanban_no_worker_topology_mismatch' })]));
    expect(receipt.kanban.topology[1]).toMatchObject({ parent_key: 'K1', child_key: 'K2', present: false });
  });

  it('fails closed when dry-run would spawn or default-auto-assign work', async () => {
    const client = new FakeKanbanCanaryClient();
    client.seedGraph();
    client.dryRun = { spawned: ['t_k0'], autoAssignedDefault: ['t_k1'], skippedNonspawnable: [] };

    const receipt = await runKanbanCanaryOperator(inputFor(client));

    expect(receipt.ok).toBe(false);
    expect(receipt.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'kanban_no_worker_dispatch_spawned' }),
      expect.objectContaining({ code: 'kanban_no_worker_dispatch_auto_assigned_default' }),
    ]));
  });

  it('CLI prints receipt JSON and writes a receipt plus hash manifest without requiring live credentials', async () => {
    const client = new FakeKanbanCanaryClient();
    client.seedGraph();
    const root = await mkdtemp(join(tmpdir(), 'symphony-kanban-canary-'));
    const receiptPath = join(root, 'receipt.json');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runSymphonyKanbanCanaryCli([
      '--mode', 'readback-only',
      '--board', 'testflight',
      '--workflow-id', 'symphony-testflight-linear-kanban-canary-2026-06-23',
      '--artifact-root', '/home/symphony-user/.hermes/artifacts/symphony/testflight',
      '--linear-team-key', 'HER',
      '--linear-project-id', 'testflight-project-id',
      '--linear-project-name', 'Testflight',
      '--linear-issue-identifier', 'HER-6',
      '--linear-issue-title', 'Testflight canary: Symphony Kanban materialization smoke',
      '--task-id', 'K0=t_k0',
      '--task-id', 'K1=t_k1',
      '--task-id', 'K2=t_k2',
      '--receipt-path', receiptPath,
    ], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      clientFactory: () => client,
      processArgv: ['symphony-kanban-canary'],
      processEnv: { HERMES_HOME: '/home/symphony-user/.hermes', PATH: '/safe/bin:/usr/bin' },
    });

    expect(exitCode).toBe(0);
    expect(stderr.join('')).toBe('');
    const printed = JSON.parse(stdout.join('')) as {
      readonly ok: boolean;
      readonly status: string;
      readonly command: { readonly argv_redacted: readonly string[] };
      readonly artifacts: { readonly receipt_path: string; readonly manifest_path: string };
      readonly hash_manifest: { readonly artifacts: readonly { readonly path: string; readonly sha256: string }[] };
    };
    expect(printed).toMatchObject({
      ok: true,
      status: 'PASS',
      effect: 'readback_only',
      linear: { team_key: 'HER', project_name: 'Testflight', issue_identifier: 'HER-6' },
      non_actions: {
        git_push: false,
        pull_request: false,
        npm_publish: false,
        deploy: false,
        service_restart: false,
        linear_mutation: false,
        real_worker_gateway_dispatch: false,
      },
    });
    expect(printed.command.argv_redacted).toContain('--linear-issue-identifier');
    expect(printed.artifacts.receipt_path).toBe(receiptPath);
    expect(printed.artifacts.manifest_path).toBe(`${receiptPath}.manifest.json`);
    expect(printed.hash_manifest.artifacts.some((artifact) => artifact.path === receiptPath && /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true);

    const saved = JSON.parse(await readFile(receiptPath, 'utf8')) as { readonly ok: boolean; readonly status: string };
    const manifest = JSON.parse(await readFile(`${receiptPath}.manifest.json`, 'utf8')) as { readonly artifacts: readonly { readonly path: string }[] };
    expect(saved).toMatchObject({ ok: true, status: 'PASS' });
    expect(manifest.artifacts.map((artifact) => artifact.path)).toContain(receiptPath);
  });
});
