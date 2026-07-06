import type { CreateKanbanTaskInput, KanbanClient, KanbanTaskRef, KanbanWorkspaceSpec } from './kanban-types.js';

export type KanbanGraphNodeKind =
  | 'anchor'
  | 'implementation'
  | 'verification'
  | 'documentation'
  | 'review'
  | 'human_gate';

export interface KanbanGraphWorkflowContext {
  readonly id: string;
  readonly board: string;
  readonly title?: string;
  readonly planPath?: string;
  readonly provenance?: readonly KanbanGraphProvenanceLine[];
  readonly artifactRoot: string;
  readonly nonAuthorizations: readonly string[];
  readonly repo?: {
    readonly root: string;
    readonly baseRef: string;
  };
}

export interface KanbanGraphRepoMutationPolicy {
  readonly worktreePath: string;
}

export interface KanbanGraphProvenanceLine {
  readonly label: string;
  readonly value: string;
}

export interface KanbanGraphNode {
  readonly key: string;
  readonly kind: KanbanGraphNodeKind;
  readonly title: string;
  readonly goal: string;
  readonly parentKeys?: readonly string[];
  readonly assignee?: string | null;
  readonly acceptanceCriteria: readonly string[];
  readonly expectedArtifacts?: readonly string[];
  readonly repoMutation?: boolean | KanbanGraphRepoMutationPolicy;
  readonly externalAction?: boolean;
  readonly humanGate?: boolean;
  readonly workspace?: KanbanWorkspaceSpec;
  readonly branch?: string;
  readonly tenant?: string;
  readonly priority?: number;
  readonly createdBy?: string;
  readonly skills?: readonly string[];
  readonly maxRuntime?: string;
  readonly maxRetries?: number;
  readonly initialStatus?: 'blocked';
}

export interface MaterializeKanbanTaskGraphInput {
  readonly client: Pick<KanbanClient, 'createTask'>;
  readonly workflow: KanbanGraphWorkflowContext;
  readonly nodes: readonly KanbanGraphNode[];
  readonly defaultAssignee?: string | null;
}

export interface MaterializedKanbanTask {
  readonly key: string;
  readonly taskId: string;
}

export interface MaterializeKanbanTaskGraphResult {
  readonly createdTasks: readonly MaterializedKanbanTask[];
}

export class KanbanGraphMaterializationError extends Error {
  public readonly field: string;

  public constructor(field: string, message: string) {
    super(message);
    this.name = 'KanbanGraphMaterializationError';
    this.field = field;
  }
}

export async function materializeKanbanTaskGraph(input: MaterializeKanbanTaskGraphInput): Promise<MaterializeKanbanTaskGraphResult> {
  validateWorkflow(input.workflow);
  validateGraph(input.nodes);
  validateNodeSafety(input.nodes);
  const orderedNodes = topologicalOrder(input.nodes);
  const taskIdsByKey = new Map<string, string>();
  const createdTasks: MaterializedKanbanTask[] = [];

  for (const node of orderedNodes) {
    const parentIds = (node.parentKeys ?? []).map((key) => {
      const parentId = taskIdsByKey.get(key);
      if (parentId === undefined) {
        throw new KanbanGraphMaterializationError(`nodes.${node.key}.parentKeys`, `Parent ${key} has not been materialized`);
      }
      return parentId;
    });
    const ref = await input.client.createTask(createTaskInput(input.workflow, node, parentIds, input.defaultAssignee ?? null));
    taskIdsByKey.set(node.key, ref.id);
    createdTasks.push({ key: node.key, taskId: ref.id });
  }

  return { createdTasks };
}

function createTaskInput(
  workflow: KanbanGraphWorkflowContext,
  node: KanbanGraphNode,
  parentIds: readonly string[],
  defaultAssignee: string | null,
): CreateKanbanTaskInput {
  const repoMutation = repoMutationPolicy(node.repoMutation);
  const initialStatus = node.initialStatus ?? (isHumanGate(node) ? 'blocked' : undefined);
  return {
    title: node.title,
    body: renderKanbanTaskBody(workflow, node),
    assignee: effectiveAssignee(node, defaultAssignee),
    parentIds,
    workspace: workspaceForNode(node, repoMutation),
    idempotencyKey: `${workflow.id}:${node.key}`,
    createdBy: node.createdBy ?? 'symphony-ts',
    ...(node.branch === undefined ? {} : { branch: node.branch }),
    ...(node.tenant === undefined ? {} : { tenant: node.tenant }),
    ...(node.priority === undefined ? {} : { priority: node.priority }),
    ...(node.skills === undefined ? {} : { skills: node.skills }),
    ...(node.maxRuntime === undefined ? {} : { maxRuntime: node.maxRuntime }),
    ...(node.maxRetries === undefined ? {} : { maxRetries: node.maxRetries }),
    ...(initialStatus === undefined ? {} : { initialStatus }),
  };
}

function renderKanbanTaskBody(workflow: KanbanGraphWorkflowContext, node: KanbanGraphNode): string {
  const repoMutation = repoMutationPolicy(node.repoMutation);
  const lines: string[] = [];
  lines.push(`# ${node.title}`);
  lines.push('');
  lines.push('## Symphony provenance');
  lines.push(`Workflow: ${workflow.id}`);
  lines.push(`Board: ${workflow.board}`);
  if (workflow.title !== undefined && workflow.title.trim() !== '') {
    lines.push(`Workflow title: ${workflow.title}`);
  }
  if (workflow.planPath !== undefined && workflow.planPath.trim() !== '') {
    lines.push(`Plan: ${workflow.planPath}`);
  }
  for (const provenance of workflow.provenance ?? []) {
    lines.push(`${provenance.label}: ${provenance.value}`);
  }
  lines.push(`Node key: ${node.key}`);
  lines.push(`Node kind: ${node.kind}`);
  lines.push(`Artifact root: ${workflow.artifactRoot}`);
  lines.push('');
  lines.push('## Goal');
  lines.push(node.goal);
  lines.push('');
  if (workflow.repo !== undefined || repoMutation !== null) {
    lines.push('## Repository/workspace scope');
    if (workflow.repo !== undefined) {
      lines.push(`Repo root: ${workflow.repo.root}`);
      lines.push(`Base ref: ${workflow.repo.baseRef}`);
    }
    if (repoMutation !== null) {
      lines.push(`Worktree path: ${repoMutation.worktreePath}`);
    } else {
      lines.push('Repo mutation: not authorized for this card.');
    }
    lines.push('');
  }
  lines.push('## Acceptance criteria');
  for (const criterion of node.acceptanceCriteria) {
    lines.push(`- ${criterion}`);
  }
  lines.push('');
  lines.push('## Expected artifacts');
  const expectedArtifacts = node.expectedArtifacts ?? ['Kanban comment with concise completion summary and verification evidence.'];
  for (const artifact of expectedArtifacts) {
    lines.push(`- ${artifact}`);
  }
  lines.push('');
  lines.push('## Safety / non-authorizations');
  for (const boundary of workflow.nonAuthorizations) {
    lines.push(`- ${boundary}`);
  }
  if (node.externalAction === true) {
    lines.push('- This card represents an external-action boundary; do not execute it until the human gate is explicitly approved.');
  }
  if (isHumanGate(node)) {
    lines.push('- Human gate cards are intentionally unassigned/blocked at creation time.');
  }
  lines.push('');
  lines.push('## Review handoff');
  if (node.kind === 'review') {
    lines.push('Inspect board-scope safety, secret handling, CLI boundary correctness, double-dispatch risk, and documentation accuracy. Return PASS/BLOCK with evidence.');
  } else {
    lines.push('Before marking done, leave evidence with verification commands, changed files, and any deferred gates.');
  }
  return redactDurableTaskText(lines.join('\n'));
}

function validateWorkflow(workflow: KanbanGraphWorkflowContext): void {
  if (workflow.id.trim() === '') {
    throw new KanbanGraphMaterializationError('workflow.id', 'Workflow id is required for stable idempotency keys');
  }
  if (workflow.board.trim() === '') {
    throw new KanbanGraphMaterializationError('workflow.board', 'Kanban board is required');
  }
  if (workflow.artifactRoot.trim() === '') {
    throw new KanbanGraphMaterializationError('workflow.artifactRoot', 'Artifact root is required');
  }
}

function validateGraph(nodes: readonly KanbanGraphNode[]): void {
  if (nodes.length === 0) {
    throw new KanbanGraphMaterializationError('nodes', 'At least one Kanban graph node is required');
  }
  const keys = new Set<string>();
  for (const node of nodes) {
    if (node.key.trim() === '') {
      throw new KanbanGraphMaterializationError('nodes.key', 'Node key is required');
    }
    if (keys.has(node.key)) {
      throw new KanbanGraphMaterializationError(`nodes.${node.key}.key`, `Duplicate node key ${node.key}`);
    }
    keys.add(node.key);
    if (node.title.trim() === '') {
      throw new KanbanGraphMaterializationError(`nodes.${node.key}.title`, 'Node title is required');
    }
    if (node.goal.trim() === '') {
      throw new KanbanGraphMaterializationError(`nodes.${node.key}.goal`, 'Node goal is required');
    }
    if (node.acceptanceCriteria.length === 0) {
      throw new KanbanGraphMaterializationError(`nodes.${node.key}.acceptanceCriteria`, 'Acceptance criteria are required');
    }
  }
  for (const node of nodes) {
    for (const parentKey of node.parentKeys ?? []) {
      if (!keys.has(parentKey)) {
        throw new KanbanGraphMaterializationError(`nodes.${node.key}.parentKeys`, `Unknown parent key ${parentKey}`);
      }
    }
  }
}

function validateNodeSafety(nodes: readonly KanbanGraphNode[]): void {
  for (const node of nodes) {
    if (node.externalAction === true && (!isHumanGate(node) || node.assignee !== null)) {
      throw new KanbanGraphMaterializationError(
        `nodes.${node.key}.externalAction`,
        'External-action nodes must be explicit unassigned human gates',
      );
    }

    const repoMutation = repoMutationPolicy(node.repoMutation);
    if (node.repoMutation === true) {
      throw new KanbanGraphMaterializationError(
        `nodes.${node.key}.repoMutation.worktreePath`,
        'Repo-mutating cards require an explicit worktree path',
      );
    }
    if (repoMutation !== null) {
      if (!repoMutation.worktreePath.startsWith('/')) {
        throw new KanbanGraphMaterializationError(`nodes.${node.key}.repoMutation.worktreePath`, 'Repo worktree path must be absolute');
      }
      if (!hasReviewChild(nodes, node.key)) {
        throw new KanbanGraphMaterializationError(`nodes.${node.key}.review`, 'Repo-mutating cards require an explicit review child');
      }
    }
  }
}

function topologicalOrder(nodes: readonly KanbanGraphNode[]): readonly KanbanGraphNode[] {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const ordered: KanbanGraphNode[] = [];
  const permanent = new Set<string>();
  const temporary = new Set<string>();

  const visit = (node: KanbanGraphNode): void => {
    if (permanent.has(node.key)) {
      return;
    }
    if (temporary.has(node.key)) {
      throw new KanbanGraphMaterializationError(`nodes.${node.key}.parentKeys`, 'Kanban graph contains a dependency cycle');
    }
    temporary.add(node.key);
    for (const parentKey of node.parentKeys ?? []) {
      const parent = byKey.get(parentKey);
      if (parent === undefined) {
        throw new KanbanGraphMaterializationError(`nodes.${node.key}.parentKeys`, `Unknown parent key ${parentKey}`);
      }
      visit(parent);
    }
    temporary.delete(node.key);
    permanent.add(node.key);
    ordered.push(node);
  };

  for (const node of nodes) {
    visit(node);
  }

  return ordered;
}

function hasReviewChild(nodes: readonly KanbanGraphNode[], key: string): boolean {
  return nodes.some((node) => node.kind === 'review' && (node.parentKeys ?? []).includes(key));
}

function repoMutationPolicy(value: KanbanGraphNode['repoMutation']): KanbanGraphRepoMutationPolicy | null {
  if (value === undefined || value === false) {
    return null;
  }
  if (value === true) {
    return null;
  }
  return value;
}

function isHumanGate(node: KanbanGraphNode): boolean {
  return node.kind === 'human_gate' || node.humanGate === true;
}

function effectiveAssignee(node: KanbanGraphNode, defaultAssignee: string | null): string | null {
  if (isHumanGate(node)) {
    return null;
  }
  return node.assignee === undefined ? defaultAssignee : node.assignee;
}

function workspaceForNode(node: KanbanGraphNode, repoMutation: KanbanGraphRepoMutationPolicy | null): KanbanWorkspaceSpec {
  if (repoMutation !== null) {
    return `worktree:${repoMutation.worktreePath}`;
  }
  return node.workspace ?? 'scratch';
}

function redactDurableTaskText(value: string): string {
  return value
    .replace(/\b(?:sk|lin_api)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/gi, '$1=[REDACTED]');
}

export type KanbanGraphCreateTaskResult = KanbanTaskRef;
