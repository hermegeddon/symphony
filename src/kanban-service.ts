import type { KanbanClient, KanbanTaskSummary } from './kanban-types.js';
import type { KanbanBackendConfig } from './workflow.js';

export type SymphonyKanbanTaskState =
  | 'pending'
  | 'review'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'archived'
  | 'unknown';

export interface SymphonyKanbanTaskSnapshot {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly state: SymphonyKanbanTaskState;
  readonly assignee: string | null;
  readonly source_identifier: string | null;
  readonly provenance: {
    readonly workflow_id: string | null;
    readonly kanban_board: string | null;
    readonly ledger_path: string | null;
  };
}

export interface SymphonyKanbanTaskCounts {
  readonly total: number;
  readonly pending: number;
  readonly review: number;
  readonly running: number;
  readonly blocked: number;
  readonly completed: number;
  readonly archived: number;
  readonly unknown: number;
}

export interface KanbanProvenanceWarning {
  readonly kind: 'conflict' | 'degraded' | 'unavailable';
  readonly message: string;
}

export interface AvailableSymphonyKanbanSnapshot {
  readonly backend: 'hermes_kanban';
  readonly mode: 'available';
  readonly board: string;
  readonly dispatch: KanbanBackendConfig['dispatch'];
  readonly counts: SymphonyKanbanTaskCounts;
  readonly tasks: readonly SymphonyKanbanTaskSnapshot[];
  readonly provenance_warnings: readonly KanbanProvenanceWarning[];
}

export interface UnavailableSymphonyKanbanSnapshot {
  readonly backend: 'hermes_kanban';
  readonly mode: 'unavailable';
  readonly board: string;
  readonly dispatch: KanbanBackendConfig['dispatch'];
  readonly counts: SymphonyKanbanTaskCounts;
  readonly tasks: readonly [];
  readonly error: string;
  readonly provenance_warnings: readonly KanbanProvenanceWarning[];
}

export type SymphonyKanbanSnapshot = AvailableSymphonyKanbanSnapshot | UnavailableSymphonyKanbanSnapshot;

export interface KanbanSymphonyService {
  snapshot(): Promise<SymphonyKanbanSnapshot>;
}

export interface CreateKanbanServiceFacadeInput {
  readonly config: KanbanBackendConfig;
  readonly client: Pick<KanbanClient, 'listTasks'>;
}

export function createKanbanServiceFacade(input: CreateKanbanServiceFacadeInput): KanbanSymphonyService {
  return {
    snapshot: async (): Promise<SymphonyKanbanSnapshot> => {
      const warnings: KanbanProvenanceWarning[] = [];
      try {
        const tasks = await input.client.listTasks({ archived: false, sort: 'status' });
        const snapshots = tasks.map((task) => toTaskSnapshot(task, input.config));
        return {
          backend: 'hermes_kanban',
          mode: 'available',
          board: input.config.board,
          dispatch: input.config.dispatch,
          counts: countTasks(snapshots),
          tasks: snapshots,
          provenance_warnings: warnings,
        };
      } catch (error) {
        const diagnosticOptions = { localPaths: [input.config.artifactRoot] };
        warnings.push({
          kind: 'unavailable',
          message: redactDiagnostic(error instanceof Error ? error.message : String(error), diagnosticOptions),
        });
        return {
          backend: 'hermes_kanban',
          mode: 'unavailable',
          board: input.config.board,
          dispatch: input.config.dispatch,
          counts: emptyCounts(),
          tasks: [],
          error: redactDiagnostic(errorMessage(error), diagnosticOptions),
          provenance_warnings: warnings,
        };
      }
    },
  };
}

export function mapKanbanStatusToSymphonyState(status: string): SymphonyKanbanTaskState {
  switch (status.toLowerCase()) {
    case 'triage':
    case 'todo':
    case 'ready':
    case 'scheduled':
      return 'pending';
    case 'review':
      return 'review';
    case 'running':
      return 'running';
    case 'blocked':
      return 'blocked';
    case 'done':
      return 'completed';
    case 'archived':
      return 'archived';
    default:
      return 'unknown';
  }
}

function toTaskSnapshot(task: KanbanTaskSummary, config: KanbanBackendConfig): SymphonyKanbanTaskSnapshot {
  return {
    id: task.id,
    title: safeRenderTaskTitle(task.title, task.id),
    status: task.status,
    state: mapKanbanStatusToSymphonyState(task.status),
    assignee: task.assignee,
    source_identifier: task.source_identifier ?? null,
    provenance: {
      workflow_id: null,
      kanban_board: config.board,
      ledger_path: null,
    },
  };
}

type MutableSymphonyKanbanTaskCounts = {
  -readonly [Key in keyof SymphonyKanbanTaskCounts]: SymphonyKanbanTaskCounts[Key];
};

function countTasks(tasks: readonly SymphonyKanbanTaskSnapshot[]): SymphonyKanbanTaskCounts {
  const counts = emptyCountsMutable();
  for (const task of tasks) {
    counts.total += 1;
    counts[task.state] += 1;
  }
  return counts;
}

function emptyCounts(): SymphonyKanbanTaskCounts {
  return emptyCountsMutable();
}

function emptyCountsMutable(): MutableSymphonyKanbanTaskCounts {
  return {
    total: 0,
    pending: 0,
    review: 0,
    running: 0,
    blocked: 0,
    completed: 0,
    archived: 0,
    unknown: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactDiagnostic(value: string, options?: { readonly localPaths?: readonly string[] }): string {
  return redactReceiptText(value, options);
}

export function redactReceiptText(value: string, options?: { readonly localPaths?: readonly string[] }): string {
  let redacted = value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)[A-Z0-9_]*\s*[:=]\s*["']?)([^"'\s,}]+)/gi, '$1[REDACTED]')
    .replace(/(--(?:api[-_]?key|token|secret|password)\s+)([^\s]+)/gi, '$1[REDACTED]')
    .replace(/\bsk[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bsess_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\blin_(?:api|oauth)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
  redacted = redactAbsoluteLocalPaths(redacted);
  if (options?.localPaths !== undefined) {
    for (const localPath of options.localPaths) {
      redacted = redactLocalPath(redacted, localPath);
    }
  }
  return redacted;
}

function redactAbsoluteLocalPaths(value: string): string {
  return value.replace(/(?<![A-Za-z0-9+.-])(?:\/[A-Za-z0-9_.-]+){2,}/g, '[REDACTED_PATH]');
}

function redactLocalPath(value: string, localPath: string): string {
  if (localPath === '') {
    return value;
  }
  const normalized = localPath.replace(/\/$/, '');
  if (normalized.length < 2) {
    return value;
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9+.-])${escaped}(?:$|[^A-Za-z0-9_.-])`, 'g');
  return value.replace(pattern, (match) => match.replace(normalized, '[REDACTED_PATH]'));
}

export function safeRenderTaskTitle(title: string, id: string): string {
  const redacted = redactReceiptText(title);
  if (redacted !== title) {
    return `${id} [title redacted]`;
  }
  return title;
}
