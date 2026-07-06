import { materializeKanbanTaskGraph, type KanbanGraphNode } from './kanban-graph-materializer.js';
import type { KanbanBoard, KanbanClient, KanbanDispatchDryRun } from './kanban-types.js';

export interface LinearKanbanCanaryScope {
  readonly teamKey: string;
  readonly teamName?: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectUrl?: string;
  readonly issueIdentifier: string;
  readonly issueTitle: string;
  readonly issueUrl?: string;
}

export interface LinearKanbanCanaryBoardScope {
  readonly board: string;
}

export interface NoWorkerLinearKanbanCanaryInput {
  readonly client: Pick<KanbanClient, 'boardShow' | 'createTask' | 'showTask' | 'dispatchDryRun'>;
  readonly workflowId: string;
  readonly artifactRoot: string;
  readonly linear: LinearKanbanCanaryScope;
  readonly kanban: LinearKanbanCanaryBoardScope;
}

export interface NoWorkerLinearKanbanCanaryTaskReceipt {
  readonly key: string;
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly assignee: string | null;
  readonly parentIds: readonly string[];
  readonly childIds: readonly string[];
  readonly bodyChecks: {
    readonly workflow: boolean;
    readonly linearIssue: boolean;
    readonly doNotDispatch: boolean;
    readonly noRepoMutation: boolean;
  };
}

export interface NoWorkerLinearKanbanCanaryReceipt {
  readonly ok: true;
  readonly effect: 'no_worker_materialization';
  readonly workflowId: string;
  readonly linear: {
    readonly teamKey: string;
    readonly projectId: string;
    readonly projectName: string;
    readonly issueIdentifier: string;
    readonly issueTitle: string;
  };
  readonly kanban: {
    readonly board: string;
    readonly boardName: string | null;
    readonly tasks: readonly NoWorkerLinearKanbanCanaryTaskReceipt[];
    readonly dryRun: {
      readonly spawned: readonly string[];
      readonly autoAssignedDefault: readonly string[];
      readonly skippedNonspawnable: KanbanDispatchDryRun['skippedNonspawnable'];
    };
  };
}

export class NoWorkerLinearKanbanCanaryError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'NoWorkerLinearKanbanCanaryError';
    this.code = code;
  }
}

const DEFAULT_NON_AUTHORIZATIONS = [
  'Do not dispatch workers.',
  'Do not start or restart Hermes gateway, Kanban daemon, Symphony service, or systemd units.',
  'Do not mutate repository files.',
  'Do not push, PR, publish, deploy, expose services, or edit public state.',
  'Do not write raw secrets, request bodies, tokens, or auth headers into tasks, comments, receipts, fixtures, or docs.',
  'Do not mutate Linear beyond the separately approved canary issue creation.',
] as const;

export async function runNoWorkerLinearKanbanCanary(input: NoWorkerLinearKanbanCanaryInput): Promise<NoWorkerLinearKanbanCanaryReceipt> {
  validateInput(input);
  const board = await input.client.boardShow(input.kanban.board);
  validateBoard(input.kanban.board, board);

  const materialized = await materializeKanbanTaskGraph({
    client: input.client,
    workflow: {
      id: input.workflowId,
      board: input.kanban.board,
      title: `${input.linear.projectName} Linear → Hermes Kanban no-worker canary`,
      artifactRoot: input.artifactRoot,
      provenance: linearProvenance(input.linear),
      nonAuthorizations: DEFAULT_NON_AUTHORIZATIONS,
    },
    nodes: buildNoWorkerCanaryNodes(input.linear),
    defaultAssignee: null,
  });

  const tasks = await Promise.all(materialized.createdTasks.map(async (task) => {
    const detail = await input.client.showTask(task.taskId);
    return {
      key: task.key,
      id: detail.id,
      title: detail.title,
      status: detail.status,
      assignee: detail.assignee,
      parentIds: detail.parents.map((parent) => parent.id),
      childIds: detail.children.map((child) => child.id),
      bodyChecks: bodyChecks(detail.body ?? '', input.workflowId, input.linear.issueIdentifier),
    } satisfies NoWorkerLinearKanbanCanaryTaskReceipt;
  }));

  const unsafeTask = tasks.find((task) => task.status !== 'blocked' || task.assignee !== null);
  if (unsafeTask !== undefined) {
    throw new NoWorkerLinearKanbanCanaryError(
      'kanban_no_worker_card_runnable',
      `No-worker canary task ${unsafeTask.id} is ${unsafeTask.status} with assignee ${unsafeTask.assignee ?? 'null'}`,
    );
  }

  const incompleteReadbackTask = tasks.find((task) => !hasCompleteBodyChecks(task));
  if (incompleteReadbackTask !== undefined) {
    throw new NoWorkerLinearKanbanCanaryError(
      'kanban_no_worker_readback_incomplete',
      `No-worker canary task ${incompleteReadbackTask.id} is missing required provenance or safety text`,
    );
  }

  const topologyMismatchTask = findTopologyMismatch(tasks);
  if (topologyMismatchTask !== undefined) {
    throw new NoWorkerLinearKanbanCanaryError(
      'kanban_no_worker_topology_mismatch',
      `No-worker canary task ${topologyMismatchTask.id} has unexpected parent links`,
    );
  }

  const dryRun = await input.client.dispatchDryRun({ max: 1 });
  if (dryRun.spawned.length > 0 || dryRun.autoAssignedDefault.length > 0) {
    throw new NoWorkerLinearKanbanCanaryError(
      'kanban_no_worker_dispatch_runnable',
      `No-worker canary dry-run would spawn ${String(dryRun.spawned.length)} task(s) and auto-assign ${String(dryRun.autoAssignedDefault.length)} task(s)`,
    );
  }

  return {
    ok: true,
    effect: 'no_worker_materialization',
    workflowId: input.workflowId,
    linear: {
      teamKey: input.linear.teamKey,
      projectId: input.linear.projectId,
      projectName: input.linear.projectName,
      issueIdentifier: input.linear.issueIdentifier,
      issueTitle: input.linear.issueTitle,
    },
    kanban: {
      board: board.slug,
      boardName: board.name,
      tasks,
      dryRun: {
        spawned: dryRun.spawned,
        autoAssignedDefault: dryRun.autoAssignedDefault,
        skippedNonspawnable: dryRun.skippedNonspawnable,
      },
    },
  };
}

function hasCompleteBodyChecks(task: NoWorkerLinearKanbanCanaryTaskReceipt): boolean {
  return task.bodyChecks.workflow && task.bodyChecks.linearIssue && task.bodyChecks.doNotDispatch && task.bodyChecks.noRepoMutation;
}

function findTopologyMismatch(tasks: readonly NoWorkerLinearKanbanCanaryTaskReceipt[]): NoWorkerLinearKanbanCanaryTaskReceipt | undefined {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const anchor = byKey.get('K0');
  const smoke = byKey.get('K1');
  const humanGate = byKey.get('K2');

  if (anchor === undefined || smoke === undefined || humanGate === undefined) {
    return tasks[0];
  }

  const expectations: readonly [NoWorkerLinearKanbanCanaryTaskReceipt, readonly string[]][] = [
    [anchor, []],
    [smoke, [anchor.id]],
    [humanGate, [smoke.id]],
  ];

  return expectations.find(([task, expectedParentIds]) => !sameStringList(task.parentIds, expectedParentIds))?.[0];
}

function sameStringList(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function buildNoWorkerCanaryNodes(linear: LinearKanbanCanaryScope): readonly KanbanGraphNode[] {
  return [
    {
      key: 'K0',
      kind: 'anchor',
      title: 'Testflight canary anchor',
      goal: `Anchor the ${linear.projectName} Linear project / Hermes Kanban board canary and record provenance for the no-worker materialization smoke.`,
      assignee: null,
      initialStatus: 'blocked',
      workspace: 'scratch',
      acceptanceCriteria: [
        `Linear project is \`${linear.projectName}\` under team \`${linear.teamKey}\`.`,
        `Linear canary issue is \`${linear.issueIdentifier}\`.`,
        'No worker dispatch is authorized.',
      ],
      expectedArtifacts: ['Kanban readback receipt showing task id, status, parent ids, idempotency key, and safety text presence.'],
    },
    {
      key: 'K1',
      kind: 'verification',
      title: 'Testflight materialization readback smoke',
      goal: 'Verify that the materialized Kanban graph can be read back with correct parent linkage, idempotency keys, safety text, and artifact expectations.',
      parentKeys: ['K0'],
      assignee: null,
      initialStatus: 'blocked',
      workspace: 'scratch',
      acceptanceCriteria: [
        'K0 and K1 exist on the target Kanban board.',
        'K1 has K0 as parent.',
        'Task bodies include Symphony provenance and non-authorizations.',
        '`dispatch --dry-run --max 1 --json` reports no spawned workers and no default auto-assignment.',
      ],
      expectedArtifacts: ['Readback summary for all materialized tasks.', 'Dry-run dispatch JSON receipt with empty `spawned` and `auto_assigned_default` lists.'],
    },
    {
      key: 'K2',
      kind: 'human_gate',
      title: 'Human gate: approve any worker/gateway pilot',
      goal: 'Block further live execution until the operator explicitly approves worker dispatch, gateway reliance, service restart, or Linear mutation beyond the canary setup.',
      parentKeys: ['K1'],
      assignee: null,
      humanGate: true,
      initialStatus: 'blocked',
      workspace: 'scratch',
      acceptanceCriteria: ['Gate is blocked/unassigned.', 'No worker has been spawned.', 'Next-step options are documented.'],
      expectedArtifacts: ['Human approval note before any future worker/gateway pilot.'],
    },
  ];
}

function linearProvenance(linear: LinearKanbanCanaryScope): readonly { readonly label: string; readonly value: string }[] {
  return [
    { label: 'Linear team', value: linear.teamName === undefined ? linear.teamKey : `${linear.teamKey} (${linear.teamName})` },
    { label: 'Linear project', value: linear.projectName },
    { label: 'Linear project ID', value: linear.projectId },
    ...(linear.projectUrl === undefined ? [] : [{ label: 'Linear project URL', value: linear.projectUrl }]),
    { label: 'Linear issue', value: linear.issueIdentifier },
    { label: 'Linear issue title', value: linear.issueTitle },
    ...(linear.issueUrl === undefined ? [] : [{ label: 'Linear issue URL', value: linear.issueUrl }]),
  ];
}

function bodyChecks(body: string, workflowId: string, issueIdentifier: string): NoWorkerLinearKanbanCanaryTaskReceipt['bodyChecks'] {
  return {
    workflow: body.includes(workflowId),
    linearIssue: body.includes(`Linear issue: ${issueIdentifier}`),
    doNotDispatch: body.includes('Do not dispatch workers.'),
    noRepoMutation: body.includes('Do not mutate repository files.'),
  };
}

function validateInput(input: NoWorkerLinearKanbanCanaryInput): void {
  requireNonEmpty('workflowId', input.workflowId);
  requireNonEmpty('artifactRoot', input.artifactRoot);
  requireNonEmpty('linear.teamKey', input.linear.teamKey);
  requireNonEmpty('linear.projectId', input.linear.projectId);
  requireNonEmpty('linear.projectName', input.linear.projectName);
  requireNonEmpty('linear.issueIdentifier', input.linear.issueIdentifier);
  requireNonEmpty('linear.issueTitle', input.linear.issueTitle);
  requireNonEmpty('kanban.board', input.kanban.board);
}

function validateBoard(expectedSlug: string, board: KanbanBoard): void {
  if (board.slug !== expectedSlug) {
    throw new NoWorkerLinearKanbanCanaryError('kanban_board_mismatch', `Expected Kanban board ${expectedSlug} but read back ${board.slug}`);
  }
  if (board.archived) {
    throw new NoWorkerLinearKanbanCanaryError('kanban_board_archived', `Kanban board ${expectedSlug} is archived`);
  }
}

function requireNonEmpty(field: string, value: string): void {
  if (value.trim() === '') {
    throw new NoWorkerLinearKanbanCanaryError('invalid_canary_input', `${field} is required`);
  }
}
