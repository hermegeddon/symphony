import { homedir } from 'node:os';

import { materializeKanbanTaskGraph, type KanbanGraphNode } from './kanban-graph-materializer.js';
import type { LinearKanbanCanaryScope } from './linear-kanban-canary.js';
import type {
  KanbanBoard,
  KanbanClient,
  KanbanDispatchDryRun,
  KanbanTaskDetail,
} from './kanban-types.js';

export const KANBAN_CANARY_TASK_KEYS = ['K0', 'K1', 'K2'] as const;
export type KanbanCanaryTaskKey = typeof KANBAN_CANARY_TASK_KEYS[number];
export type KanbanCanaryMode = 'readback-only' | 'materialize-if-missing';
export type KanbanCanaryEffect = 'readback_only' | 'materialize_if_missing';

export interface KanbanCanaryBoardScope {
  readonly board: string;
}

export interface KanbanCanaryCommandContext {
  readonly argv?: readonly string[] | undefined;
}

export interface KanbanCanaryOperatorInput {
  readonly client: Pick<KanbanClient, 'boardShow' | 'listTasks' | 'createTask' | 'showTask' | 'dispatchDryRun'>;
  readonly mode: KanbanCanaryMode;
  readonly workflowId: string;
  readonly artifactRoot: string;
  readonly linear: LinearKanbanCanaryScope;
  readonly kanban: KanbanCanaryBoardScope;
  readonly existingTaskIds?: Partial<Record<KanbanCanaryTaskKey, string>> | undefined;
  readonly command?: KanbanCanaryCommandContext | undefined;
}

export interface KanbanCanaryBodyChecks {
  readonly workflow_id: boolean;
  readonly linear_issue: boolean;
  readonly do_not_dispatch: boolean;
  readonly no_repo_mutation: boolean;
  readonly no_push_pr_publish_deploy: boolean;
  readonly no_service_restart: boolean;
  readonly artifact_root: boolean;
  readonly node_key: boolean;
}

export interface KanbanCanaryTaskChecks {
  readonly blocked: boolean;
  readonly unassigned: boolean;
  readonly body_complete: boolean;
}

export interface KanbanCanaryTaskReceipt {
  readonly key: KanbanCanaryTaskKey;
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly assignee: string | null;
  readonly parent_ids: readonly string[];
  readonly child_ids: readonly string[];
  readonly checks: KanbanCanaryTaskChecks;
  readonly body_checks: KanbanCanaryBodyChecks;
}

export interface KanbanCanaryTopologyReceipt {
  readonly parent_key: KanbanCanaryTaskKey;
  readonly parent_id: string | null;
  readonly child_key: KanbanCanaryTaskKey;
  readonly child_id: string | null;
  readonly present: boolean;
}

export interface KanbanCanaryValidationReceipt {
  readonly all_expected_tasks_present: boolean;
  readonly all_blocked: boolean;
  readonly all_unassigned: boolean;
  readonly body_provenance_and_safety: boolean;
  readonly topology: boolean;
  readonly dry_run_no_spawn: boolean;
  readonly dry_run_no_default_auto_assignment: boolean;
}

export interface KanbanCanaryErrorReceipt {
  readonly code: string;
  readonly message: string;
  readonly task_key?: KanbanCanaryTaskKey | undefined;
  readonly task_id?: string | undefined;
}

export interface KanbanCanaryCreatedTaskReceipt {
  readonly key: KanbanCanaryTaskKey;
  readonly id: string;
}

export interface KanbanCanaryHashArtifactReceipt {
  readonly path: string;
  readonly sha256: string;
  readonly bytes?: number | undefined;
}

export interface KanbanCanaryHashManifestReceipt {
  readonly algorithm: 'sha256';
  readonly hash_scope: 'artifact_bytes' | 'receipt_without_hash_manifest';
  readonly artifacts: readonly KanbanCanaryHashArtifactReceipt[];
}

export interface KanbanCanaryArtifactsReceipt {
  readonly artifact_root: string;
  readonly receipt_path?: string | undefined;
  readonly manifest_path?: string | undefined;
}

export interface KanbanCanaryOperatorReceipt {
  readonly ok: boolean;
  readonly status: 'PASS' | 'BLOCK';
  readonly effect: KanbanCanaryEffect;
  readonly mode: KanbanCanaryMode;
  readonly workflow_id: string;
  readonly command: {
    readonly argv_redacted: readonly string[];
    readonly shell_redacted: string;
  };
  readonly linear: {
    readonly team_key: string;
    readonly team_name?: string | undefined;
    readonly project_id: string;
    readonly project_name: string;
    readonly project_url?: string | undefined;
    readonly issue_identifier: string;
    readonly issue_title: string;
    readonly issue_url?: string | undefined;
  };
  readonly kanban: {
    readonly board: string;
    readonly board_name: string | null;
    readonly task_ids: Partial<Record<KanbanCanaryTaskKey, string>>;
    readonly tasks: readonly KanbanCanaryTaskReceipt[];
    readonly topology: readonly KanbanCanaryTopologyReceipt[];
    readonly dry_run: {
      readonly max: 1;
      readonly spawned: readonly string[];
      readonly auto_assigned_default: readonly string[];
      readonly skipped_nonspawnable: KanbanDispatchDryRun['skippedNonspawnable'];
    };
  };
  readonly validations: KanbanCanaryValidationReceipt;
  readonly created: readonly KanbanCanaryCreatedTaskReceipt[];
  readonly errors: readonly KanbanCanaryErrorReceipt[];
  readonly artifacts: KanbanCanaryArtifactsReceipt;
  readonly hash_manifest: KanbanCanaryHashManifestReceipt;
  readonly non_authorizations: readonly string[];
  readonly non_actions: {
    readonly git_push: false;
    readonly pull_request: false;
    readonly npm_publish: false;
    readonly deploy: false;
    readonly service_restart: false;
    readonly linear_mutation: false;
    readonly real_worker_gateway_dispatch: false;
  };
}

interface DiscoveryResult {
  readonly ids: Partial<Record<KanbanCanaryTaskKey, string>>;
  readonly errors: readonly KanbanCanaryErrorReceipt[];
}

interface ReadTasksResult {
  readonly details: Partial<Record<KanbanCanaryTaskKey, KanbanTaskDetail>>;
  readonly errors: readonly KanbanCanaryErrorReceipt[];
}

const DEFAULT_NON_AUTHORIZATIONS = [
  'Do not dispatch workers.',
  'Do not start or restart Hermes gateway, Kanban daemon, Symphony service, or systemd units.',
  'Do not mutate repository files.',
  'Do not push, PR, publish, deploy, expose services, or edit public state.',
  'Do not write raw secrets, request bodies, tokens, or auth headers into tasks, comments, receipts, fixtures, or docs.',
  'Do not mutate Linear beyond the separately approved canary issue creation.',
] as const;

export async function runKanbanCanaryOperator(input: KanbanCanaryOperatorInput): Promise<KanbanCanaryOperatorReceipt> {
  validateInput(input);
  const board = await input.client.boardShow(input.kanban.board);
  const errors: KanbanCanaryErrorReceipt[] = [];
  validateBoard(input.kanban.board, board, errors);

  const initialDiscovery = input.existingTaskIds === undefined
    ? await discoverExistingTaskIds(input)
    : { ids: cleanTaskIds(input.existingTaskIds), errors: [] } satisfies DiscoveryResult;
  errors.push(...initialDiscovery.errors);

  const ids = { ...initialDiscovery.ids };
  const created: KanbanCanaryCreatedTaskReceipt[] = [];

  if (!hasAllTaskIds(ids)) {
    if (input.mode === 'materialize-if-missing') {
      const materialized = await materializeMissingTasks(input, ids);
      Object.assign(ids, materialized.ids);
      created.push(...materialized.created);
      errors.push(...materialized.errors);
    } else {
      for (const key of KANBAN_CANARY_TASK_KEYS) {
        if (ids[key] === undefined) {
          errors.push({
            code: 'kanban_no_worker_task_missing',
            message: `Expected no-worker canary task ${key} is missing`,
            task_key: key,
          });
        }
      }
    }
  }

  const readTasks = await readExpectedTasks(input, ids);
  errors.push(...readTasks.errors);

  const taskReceipts = buildTaskReceipts(input, readTasks.details);
  const topology = buildTopology(taskReceipts);
  const dryRun = await input.client.dispatchDryRun({ max: 1 });
  errors.push(...validateTaskReceipts(taskReceipts));
  errors.push(...validateTopology(taskReceipts, topology));
  errors.push(...validateDryRun(dryRun));

  return buildReceipt({
    input,
    board,
    ids,
    tasks: taskReceipts,
    topology,
    dryRun,
    created,
    errors,
  });
}

export function noWorkerCanaryNonAuthorizations(): readonly string[] {
  return DEFAULT_NON_AUTHORIZATIONS;
}

function validateInput(input: KanbanCanaryOperatorInput): void {
  requireNonEmpty('mode', input.mode);
  requireNonEmpty('workflowId', input.workflowId);
  requireNonEmpty('artifactRoot', input.artifactRoot);
  requireNonEmpty('kanban.board', input.kanban.board);
  requireNonEmpty('linear.teamKey', input.linear.teamKey);
  requireNonEmpty('linear.projectId', input.linear.projectId);
  requireNonEmpty('linear.projectName', input.linear.projectName);
  requireNonEmpty('linear.issueIdentifier', input.linear.issueIdentifier);
  requireNonEmpty('linear.issueTitle', input.linear.issueTitle);
}

function validateBoard(expectedSlug: string, board: KanbanBoard, errors: KanbanCanaryErrorReceipt[]): void {
  if (board.slug !== expectedSlug) {
    errors.push({
      code: 'kanban_board_mismatch',
      message: `Expected Kanban board ${expectedSlug} but read back ${board.slug}`,
    });
  }
  if (board.archived) {
    errors.push({
      code: 'kanban_board_archived',
      message: `Kanban board ${expectedSlug} is archived`,
    });
  }
}

function requireNonEmpty(field: string, value: string): void {
  if (value.trim() === '') {
    throw new Error(`${field} is required`);
  }
}

function cleanTaskIds(ids: Partial<Record<KanbanCanaryTaskKey, string>>): Partial<Record<KanbanCanaryTaskKey, string>> {
  const cleaned: Partial<Record<KanbanCanaryTaskKey, string>> = {};
  for (const key of KANBAN_CANARY_TASK_KEYS) {
    const value = ids[key];
    if (value !== undefined && value.trim() !== '') {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

async function discoverExistingTaskIds(input: KanbanCanaryOperatorInput): Promise<DiscoveryResult> {
  const ids: Partial<Record<KanbanCanaryTaskKey, string>> = {};
  const errors: KanbanCanaryErrorReceipt[] = [];
  const summaries = await input.client.listTasks({});
  for (const summary of summaries) {
    let detail: KanbanTaskDetail;
    try {
      detail = await input.client.showTask(summary.id);
    } catch (error) {
      errors.push({
        code: 'kanban_no_worker_task_read_failed',
        message: `Unable to read Kanban task ${summary.id}: ${errorMessage(error)}`,
        task_id: summary.id,
      });
      continue;
    }
    const key = identifyExpectedTask(input, detail);
    if (key === null) {
      continue;
    }
    const existing = ids[key];
    if (existing !== undefined && existing !== detail.id) {
      errors.push({
        code: 'kanban_no_worker_duplicate_task_key',
        message: `Multiple tasks match workflow ${input.workflowId} key ${key}: ${existing} and ${detail.id}`,
        task_key: key,
        task_id: detail.id,
      });
      continue;
    }
    ids[key] = detail.id;
  }
  return { ids, errors };
}

function identifyExpectedTask(input: KanbanCanaryOperatorInput, detail: KanbanTaskDetail): KanbanCanaryTaskKey | null {
  const body = detail.body ?? '';
  if (!body.includes(input.workflowId) || !body.includes(`Linear issue: ${input.linear.issueIdentifier}`)) {
    return null;
  }
  for (const key of KANBAN_CANARY_TASK_KEYS) {
    if (body.includes(`Node key: ${key}`)) {
      return key;
    }
  }
  return null;
}

async function materializeMissingTasks(
  input: KanbanCanaryOperatorInput,
  existingIds: Partial<Record<KanbanCanaryTaskKey, string>>,
): Promise<{
  readonly ids: Partial<Record<KanbanCanaryTaskKey, string>>;
  readonly created: readonly KanbanCanaryCreatedTaskReceipt[];
  readonly errors: readonly KanbanCanaryErrorReceipt[];
}> {
  if (!hasAnyTaskId(existingIds)) {
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
    const ids: Partial<Record<KanbanCanaryTaskKey, string>> = {};
    const created = materialized.createdTasks.map((task) => {
      const key = parseTaskKey(task.key);
      ids[key] = task.taskId;
      return { key, id: task.taskId } satisfies KanbanCanaryCreatedTaskReceipt;
    });
    return { ids, created, errors: [] };
  }

  const ids = { ...existingIds };
  const created: KanbanCanaryCreatedTaskReceipt[] = [];
  const errors: KanbanCanaryErrorReceipt[] = [];
  const nodes = buildNoWorkerCanaryNodes(input.linear);
  for (const node of nodes) {
    const key = parseTaskKey(node.key);
    if (ids[key] !== undefined) {
      continue;
    }
    const parentIds: string[] = [];
    for (const parentKeyValue of node.parentKeys ?? []) {
      const parentKey = parseTaskKey(parentKeyValue);
      const parentId = ids[parentKey];
      if (parentId === undefined) {
        errors.push({
          code: 'kanban_no_worker_materialize_missing_parent',
          message: `Cannot materialize ${key}; parent ${parentKey} is missing`,
          task_key: key,
        });
      } else {
        parentIds.push(parentId);
      }
    }
    if (errors.some((error) => error.task_key === key && error.code === 'kanban_no_worker_materialize_missing_parent')) {
      continue;
    }
    const ref = await input.client.createTask({
      title: node.title,
      body: renderCanaryTaskBody(input, node),
      assignee: null,
      parentIds,
      workspace: 'scratch',
      idempotencyKey: `${input.workflowId}:${key}`,
      createdBy: 'symphony-ts',
      initialStatus: 'blocked',
    });
    ids[key] = ref.id;
    created.push({ key, id: ref.id });
  }
  return { ids, created, errors };
}

function hasAllTaskIds(ids: Partial<Record<KanbanCanaryTaskKey, string>>): ids is Record<KanbanCanaryTaskKey, string> {
  return KANBAN_CANARY_TASK_KEYS.every((key) => ids[key] !== undefined);
}

function hasAnyTaskId(ids: Partial<Record<KanbanCanaryTaskKey, string>>): boolean {
  return KANBAN_CANARY_TASK_KEYS.some((key) => ids[key] !== undefined);
}

async function readExpectedTasks(
  input: KanbanCanaryOperatorInput,
  ids: Partial<Record<KanbanCanaryTaskKey, string>>,
): Promise<ReadTasksResult> {
  const details: Partial<Record<KanbanCanaryTaskKey, KanbanTaskDetail>> = {};
  const errors: KanbanCanaryErrorReceipt[] = [];
  for (const key of KANBAN_CANARY_TASK_KEYS) {
    const id = ids[key];
    if (id === undefined) {
      continue;
    }
    try {
      details[key] = await input.client.showTask(id);
    } catch (error) {
      errors.push({
        code: 'kanban_no_worker_task_read_failed',
        message: `Unable to read expected Kanban task ${key}/${id}: ${errorMessage(error)}`,
        task_key: key,
        task_id: id,
      });
    }
  }
  return { details, errors };
}

function buildTaskReceipts(
  input: KanbanCanaryOperatorInput,
  details: Partial<Record<KanbanCanaryTaskKey, KanbanTaskDetail>>,
): readonly KanbanCanaryTaskReceipt[] {
  const receipts: KanbanCanaryTaskReceipt[] = [];
  for (const key of KANBAN_CANARY_TASK_KEYS) {
    const detail = details[key];
    if (detail === undefined) {
      continue;
    }
    const checks = bodyChecks(detail.body ?? '', input.workflowId, input.linear.issueIdentifier, input.artifactRoot, key);
    const bodyComplete = Object.values(checks).every((value) => value);
    receipts.push({
      key,
      id: detail.id,
      title: detail.title,
      status: detail.status,
      assignee: detail.assignee,
      parent_ids: detail.parents.map((parent) => parent.id),
      child_ids: detail.children.map((child) => child.id),
      checks: {
        blocked: detail.status === 'blocked',
        unassigned: detail.assignee === null,
        body_complete: bodyComplete,
      },
      body_checks: checks,
    });
  }
  return receipts;
}

function buildTopology(tasks: readonly KanbanCanaryTaskReceipt[]): readonly KanbanCanaryTopologyReceipt[] {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const k0 = byKey.get('K0');
  const k1 = byKey.get('K1');
  const k2 = byKey.get('K2');
  return [
    {
      parent_key: 'K0',
      parent_id: k0?.id ?? null,
      child_key: 'K1',
      child_id: k1?.id ?? null,
      present: k0 !== undefined && k1 !== undefined && sameStringList(k1.parent_ids, [k0.id]),
    },
    {
      parent_key: 'K1',
      parent_id: k1?.id ?? null,
      child_key: 'K2',
      child_id: k2?.id ?? null,
      present: k1 !== undefined && k2 !== undefined && sameStringList(k2.parent_ids, [k1.id]),
    },
  ];
}

function validateTaskReceipts(tasks: readonly KanbanCanaryTaskReceipt[]): readonly KanbanCanaryErrorReceipt[] {
  const errors: KanbanCanaryErrorReceipt[] = [];
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  for (const key of KANBAN_CANARY_TASK_KEYS) {
    const task = byKey.get(key);
    if (task === undefined) {
      errors.push({
        code: 'kanban_no_worker_task_missing',
        message: `Expected no-worker canary task ${key} is missing`,
        task_key: key,
      });
      continue;
    }
    if (!task.checks.blocked) {
      errors.push({
        code: 'kanban_no_worker_card_not_blocked',
        message: `No-worker canary task ${task.id} is ${task.status}; expected blocked`,
        task_key: key,
        task_id: task.id,
      });
    }
    if (!task.checks.unassigned) {
      errors.push({
        code: 'kanban_no_worker_card_assigned',
        message: `No-worker canary task ${task.id} is assigned to ${task.assignee ?? 'null'}; expected unassigned`,
        task_key: key,
        task_id: task.id,
      });
    }
    if (!task.checks.body_complete) {
      errors.push({
        code: 'kanban_no_worker_body_incomplete',
        message: `No-worker canary task ${task.id} is missing required provenance, safety, or artifact-root text`,
        task_key: key,
        task_id: task.id,
      });
    }
  }
  const k0 = byKey.get('K0');
  if (k0 !== undefined && k0.parent_ids.length !== 0) {
    errors.push({
      code: 'kanban_no_worker_topology_mismatch',
      message: `No-worker canary anchor ${k0.id} has unexpected parents`,
      task_key: 'K0',
      task_id: k0.id,
    });
  }
  return errors;
}

function validateTopology(
  tasks: readonly KanbanCanaryTaskReceipt[],
  topology: readonly KanbanCanaryTopologyReceipt[],
): readonly KanbanCanaryErrorReceipt[] {
  const errors: KanbanCanaryErrorReceipt[] = [];
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  for (const edge of topology) {
    if (!edge.present) {
      const child = byKey.get(edge.child_key);
      errors.push({
        code: 'kanban_no_worker_topology_mismatch',
        message: `Expected ${edge.parent_key} -> ${edge.child_key} parent topology is absent`,
        task_key: edge.child_key,
        ...(child === undefined ? {} : { task_id: child.id }),
      });
    }
  }
  return errors;
}

function validateDryRun(dryRun: KanbanDispatchDryRun): readonly KanbanCanaryErrorReceipt[] {
  const errors: KanbanCanaryErrorReceipt[] = [];
  if (dryRun.spawned.length > 0) {
    errors.push({
      code: 'kanban_no_worker_dispatch_spawned',
      message: `Kanban dry-run would spawn ${String(dryRun.spawned.length)} task(s): ${dryRun.spawned.join(', ')}`,
    });
  }
  if (dryRun.autoAssignedDefault.length > 0) {
    errors.push({
      code: 'kanban_no_worker_dispatch_auto_assigned_default',
      message: `Kanban dry-run would default-auto-assign ${String(dryRun.autoAssignedDefault.length)} task(s): ${dryRun.autoAssignedDefault.join(', ')}`,
    });
  }
  return errors;
}

function buildReceipt(input: {
  readonly input: KanbanCanaryOperatorInput;
  readonly board: KanbanBoard;
  readonly ids: Partial<Record<KanbanCanaryTaskKey, string>>;
  readonly tasks: readonly KanbanCanaryTaskReceipt[];
  readonly topology: readonly KanbanCanaryTopologyReceipt[];
  readonly dryRun: KanbanDispatchDryRun;
  readonly created: readonly KanbanCanaryCreatedTaskReceipt[];
  readonly errors: readonly KanbanCanaryErrorReceipt[];
}): KanbanCanaryOperatorReceipt {
  const validations = buildValidations(input.tasks, input.topology, input.dryRun);
  const ok = input.errors.length === 0 && Object.values(validations).every((value) => value);
  const argvRedacted = (input.input.command?.argv ?? []).map(redactReceiptText);
  return {
    ok,
    status: ok ? 'PASS' : 'BLOCK',
    effect: effectForMode(input.input.mode),
    mode: input.input.mode,
    workflow_id: input.input.workflowId,
    command: {
      argv_redacted: argvRedacted,
      shell_redacted: argvRedacted.map(shellQuote).join(' '),
    },
    linear: {
      team_key: input.input.linear.teamKey,
      ...(input.input.linear.teamName === undefined ? {} : { team_name: input.input.linear.teamName }),
      project_id: input.input.linear.projectId,
      project_name: input.input.linear.projectName,
      ...(input.input.linear.projectUrl === undefined ? {} : { project_url: input.input.linear.projectUrl }),
      issue_identifier: input.input.linear.issueIdentifier,
      issue_title: input.input.linear.issueTitle,
      ...(input.input.linear.issueUrl === undefined ? {} : { issue_url: input.input.linear.issueUrl }),
    },
    kanban: {
      board: input.input.kanban.board,
      board_name: input.board.name,
      task_ids: cleanTaskIds(input.ids),
      tasks: input.tasks,
      topology: input.topology,
      dry_run: {
        max: 1,
        spawned: input.dryRun.spawned,
        auto_assigned_default: input.dryRun.autoAssignedDefault,
        skipped_nonspawnable: input.dryRun.skippedNonspawnable,
      },
    },
    validations,
    created: input.created,
    errors: input.errors,
    artifacts: {
      artifact_root: input.input.artifactRoot,
    },
    hash_manifest: {
      algorithm: 'sha256',
      hash_scope: 'artifact_bytes',
      artifacts: [],
    },
    non_authorizations: DEFAULT_NON_AUTHORIZATIONS,
    non_actions: {
      git_push: false,
      pull_request: false,
      npm_publish: false,
      deploy: false,
      service_restart: false,
      linear_mutation: false,
      real_worker_gateway_dispatch: false,
    },
  };
}

function buildValidations(
  tasks: readonly KanbanCanaryTaskReceipt[],
  topology: readonly KanbanCanaryTopologyReceipt[],
  dryRun: KanbanDispatchDryRun,
): KanbanCanaryValidationReceipt {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const allExpectedTasksPresent = KANBAN_CANARY_TASK_KEYS.every((key) => byKey.has(key));
  return {
    all_expected_tasks_present: allExpectedTasksPresent,
    all_blocked: allExpectedTasksPresent && tasks.every((task) => task.checks.blocked),
    all_unassigned: allExpectedTasksPresent && tasks.every((task) => task.checks.unassigned),
    body_provenance_and_safety: allExpectedTasksPresent && tasks.every((task) => task.checks.body_complete),
    topology: allExpectedTasksPresent && topology.every((edge) => edge.present) && (byKey.get('K0')?.parent_ids.length ?? -1) === 0,
    dry_run_no_spawn: dryRun.spawned.length === 0,
    dry_run_no_default_auto_assignment: dryRun.autoAssignedDefault.length === 0,
  };
}

function bodyChecks(
  body: string,
  workflowId: string,
  issueIdentifier: string,
  artifactRoot: string,
  key: KanbanCanaryTaskKey,
): KanbanCanaryBodyChecks {
  return {
    workflow_id: body.includes(workflowId),
    linear_issue: body.includes(`Linear issue: ${issueIdentifier}`),
    do_not_dispatch: body.includes('Do not dispatch workers.'),
    no_repo_mutation: body.includes('Do not mutate repository files.'),
    no_push_pr_publish_deploy: body.includes('Do not push, PR, publish, deploy, expose services, or edit public state.'),
    no_service_restart: body.includes('Do not start or restart Hermes gateway, Kanban daemon, Symphony service, or systemd units.'),
    artifact_root: artifactRootTextCandidates(artifactRoot).some((candidate) => body.includes(`Artifact root: ${candidate}`)),
    node_key: body.includes(`Node key: ${key}`),
  };
}

function artifactRootTextCandidates(artifactRoot: string): readonly string[] {
  const trimmedRoot = trimTrailingSlashes(artifactRoot.trim());
  const candidates = new Set<string>([artifactRoot, trimmedRoot]);
  const home = trimTrailingSlashes(homedir());
  if (trimmedRoot.startsWith(`${home}/`)) {
    candidates.add(`~/${trimmedRoot.slice(home.length + 1)}`);
  }
  if (trimmedRoot.startsWith('~/')) {
    candidates.add(`${home}/${trimmedRoot.slice(2)}`);
  }
  return [...candidates].filter((candidate) => candidate.trim() !== '');
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function effectForMode(mode: KanbanCanaryMode): KanbanCanaryEffect {
  return mode === 'readback-only' ? 'readback_only' : 'materialize_if_missing';
}

function sameStringList(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function parseTaskKey(value: string): KanbanCanaryTaskKey {
  if (isTaskKey(value)) {
    return value;
  }
  throw new Error(`Unexpected Kanban canary task key: ${value}`);
}

export function isTaskKey(value: string): value is KanbanCanaryTaskKey {
  return (KANBAN_CANARY_TASK_KEYS as readonly string[]).includes(value);
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

function renderCanaryTaskBody(input: KanbanCanaryOperatorInput, node: KanbanGraphNode): string {
  const lines: string[] = [];
  lines.push(`# ${node.title}`);
  lines.push('');
  lines.push('## Symphony provenance');
  lines.push(`Workflow: ${input.workflowId}`);
  lines.push(`Board: ${input.kanban.board}`);
  lines.push(`Workflow title: ${input.linear.projectName} Linear → Hermes Kanban no-worker canary`);
  for (const provenance of linearProvenance(input.linear)) {
    lines.push(`${provenance.label}: ${provenance.value}`);
  }
  lines.push(`Node key: ${node.key}`);
  lines.push(`Node kind: ${node.kind}`);
  lines.push(`Artifact root: ${input.artifactRoot}`);
  lines.push('');
  lines.push('## Goal');
  lines.push(node.goal);
  lines.push('');
  lines.push('## Acceptance criteria');
  for (const criterion of node.acceptanceCriteria) {
    lines.push(`- ${criterion}`);
  }
  lines.push('');
  lines.push('## Expected artifacts');
  for (const artifact of node.expectedArtifacts ?? ['Kanban comment with concise completion summary and verification evidence.']) {
    lines.push(`- ${artifact}`);
  }
  lines.push('');
  lines.push('## Safety / non-authorizations');
  for (const boundary of DEFAULT_NON_AUTHORIZATIONS) {
    lines.push(`- ${boundary}`);
  }
  if (node.humanGate === true || node.kind === 'human_gate') {
    lines.push('- Human gate cards are intentionally unassigned/blocked at creation time.');
  }
  lines.push('');
  lines.push('## Review handoff');
  lines.push('Before marking done, leave evidence with verification commands, changed files, and any deferred gates.');
  return redactReceiptText(lines.join('\n'));
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

export function redactReceiptText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)[A-Z0-9_]*\s*[:=]\s*["']?)([^"'\s,}]+)/gi, '$1[REDACTED]')
    .replace(/(--(?:api[-_]?key|token|secret|password)\s+)([^\s]+)/gi, '$1[REDACTED]')
    .replace(/\bsk[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bsess_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\blin_(?:api|oauth)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
