export type KanbanTaskStatus =
  | 'triage'
  | 'todo'
  | 'ready'
  | 'review'
  | 'running'
  | 'blocked'
  | 'scheduled'
  | 'done'
  | 'archived';

export type KanbanWorkspaceSpec = 'scratch' | 'worktree' | `worktree:${string}` | `dir:${string}`;

export type KanbanTaskLinkKind =
  | 'blocks'
  | 'depends_on'
  | 'depends_on_decision'
  | 'derived_from_research'
  | 'feeds'
  | 'informed_by'
  | 'related'
  | 'supersedes';

export interface KanbanBoard {
  readonly slug: string;
  readonly name: string | null;
  readonly archived: boolean;
  readonly taskCount?: number;
}

export interface CreateKanbanTaskInput {
  readonly title: string;
  readonly body?: string;
  readonly assignee?: string | null;
  readonly parentIds?: readonly string[];
  readonly workspace?: KanbanWorkspaceSpec;
  readonly branch?: string;
  readonly tenant?: string;
  readonly priority?: number;
  readonly idempotencyKey?: string;
  readonly createdBy?: string;
  readonly skills?: readonly string[];
  readonly maxRuntime?: string;
  readonly maxRetries?: number;
  readonly goal?: boolean;
  readonly goalMaxTurns?: number;
  readonly initialStatus?: 'blocked' | 'running';
}

export interface KanbanTaskRef {
  readonly id: string;
}

export interface ListKanbanTasksInput {
  readonly status?: KanbanTaskStatus;
  readonly assignee?: string;
  readonly tenant?: string;
  readonly archived?: boolean;
  readonly sort?: 'assignee' | 'created' | 'created-desc' | 'priority' | 'priority-desc' | 'status' | 'title' | 'updated';
}

export interface KanbanTaskSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly assignee: string | null;
  readonly source_identifier?: string | null;
}

export interface KanbanTaskDetail extends KanbanTaskSummary {
  readonly body: string | null;
  readonly parents: readonly KanbanTaskSummary[];
  readonly children: readonly KanbanTaskSummary[];
  readonly parentLinks: readonly KanbanTaskLink[];
  readonly childLinks: readonly KanbanTaskLink[];
  readonly comments: readonly KanbanComment[];
  readonly raw: unknown;
}

export interface CreateKanbanTaskLinkInput {
  readonly parentId: string;
  readonly childId: string;
  readonly kind?: KanbanTaskLinkKind;
  readonly blocking?: boolean;
  readonly requiredParentStatuses?: readonly string[];
  readonly source?: string;
  readonly createdBy?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface DeleteKanbanTaskLinkInput {
  readonly parentId: string;
  readonly childId: string;
  readonly kind?: KanbanTaskLinkKind;
}

export interface KanbanTaskLink {
  readonly parentTaskId: string;
  readonly childTaskId: string;
  readonly kind: KanbanTaskLinkKind;
  readonly blocking: boolean;
  readonly requiredParentStatuses: readonly string[];
  readonly source: string | null;
  readonly createdBy: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface KanbanComment {
  readonly id: string | null;
  readonly body: string;
  readonly author: string | null;
  readonly createdAt: string | null;
}

export interface KanbanAssignee {
  readonly name: string;
  readonly onDisk: boolean | null;
  readonly taskCount?: number;
}

export interface DispatchProbeInput {
  readonly max?: number;
  readonly failureLimit?: number;
}

export interface KanbanDispatchSkippedTask {
  readonly taskId: string | null;
  readonly reason: string;
}

export interface KanbanDispatchDryRun {
  readonly spawned: readonly string[];
  readonly autoAssignedDefault: readonly string[];
  readonly skippedNonspawnable: readonly KanbanDispatchSkippedTask[];
}

export interface CreateKanbanBoardInput {
  readonly slug: string;
  readonly name?: string;
  readonly description?: string;
  readonly defaultWorkdir?: string;
}

export interface KanbanClient {
  boardsList(): Promise<readonly KanbanBoard[]>;
  boardShow(slug: string): Promise<KanbanBoard>;
  createBoard(input: CreateKanbanBoardInput): Promise<KanbanBoard>;
  init(): Promise<void>;
  createTask(input: CreateKanbanTaskInput): Promise<KanbanTaskRef>;
  showTask(id: string): Promise<KanbanTaskDetail>;
  listTasks(input: ListKanbanTasksInput): Promise<readonly KanbanTaskSummary[]>;
  createTaskLink(input: CreateKanbanTaskLinkInput): Promise<KanbanTaskLink>;
  deleteTaskLink(input: DeleteKanbanTaskLinkInput): Promise<void>;
  linkTasks(parentId: string, childId: string): Promise<void>;
  commentTask(id: string, body: string): Promise<void>;
  blockTask(id: string, reason: string): Promise<void>;
  unblockTask(id: string, reason?: string): Promise<void>;
  dispatchDryRun(input: DispatchProbeInput): Promise<KanbanDispatchDryRun>;
  assigneesList(): Promise<readonly KanbanAssignee[]>;
}
