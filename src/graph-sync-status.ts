import { readFile } from 'node:fs/promises';

export type GraphSyncWatchdogStatus = 'PASS' | 'REVIEW' | 'BLOCK';

export interface GraphSyncWatchdogSummary {
  readonly linear_issues_read: number;
  readonly kanban_tasks_read: number;
  readonly mappings_resolved: number;
  readonly linear_edges_seen: number;
  readonly kanban_edges_seen: number;
  readonly matched_edges: number;
  readonly missing_kanban_edges: number;
  readonly missing_linear_relations: number;
  readonly endpoint_policies: number;
  readonly cycles_detected: number;
  readonly proposed_operations: number;
}

export interface GraphSyncStatusWatchdogInput {
  readonly lastRunPath: string;
  readonly now?: Date | undefined;
  readonly maxAgeMs?: number | undefined;
}

export interface GraphSyncStatusWatchdogArtifact {
  readonly ok: boolean;
  readonly effect: 'graph_sync_status_watchdog';
  readonly status: GraphSyncWatchdogStatus;
  readonly last_run: {
    readonly path: string;
    readonly exists: boolean;
    readonly ok: boolean | null;
    readonly wrapper_status: string | null;
    readonly cli_exit_code: number | null;
    readonly run_dir: string | null;
    readonly completed_at: string | null;
    readonly age_ms: number | null;
    readonly max_age_ms: number;
    readonly stale: boolean;
    readonly stale_reason: string | null;
    readonly suppressed_writes: boolean | null;
  };
  readonly summary: GraphSyncWatchdogSummary | null;
  readonly warnings: readonly string[];
  readonly non_actions: readonly string[];
}

interface LastRunWrapper {
  readonly ok?: unknown;
  readonly status?: unknown;
  readonly cli_exit_code?: unknown;
  readonly run_dir?: unknown;
  readonly completed_at?: unknown;
  readonly suppressed_writes?: unknown;
  readonly summary?: unknown;
  readonly non_actions?: unknown;
}

const DEFAULT_MAX_AGE_MS = 900000;
const STATUS_NON_ACTIONS = [
  'did_not_create_update_delete_linear_relations',
  'did_not_create_update_delete_kanban_links',
  'did_not_dispatch_workers_or_gateway',
  'did_not_edit_restart_or_disable_services_or_timers',
  'did_not_push_publish_deploy_or_open_pr',
] as const;

export async function evaluateGraphSyncStatus(
  input: GraphSyncStatusWatchdogInput,
): Promise<GraphSyncStatusWatchdogArtifact> {
  const now = input.now ?? new Date();
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  let raw: string;
  try {
    raw = await readFile(input.lastRunPath, 'utf8');
  } catch (error) {
    const reason = isNotFoundError(error) ? 'last-run.json does not exist' : 'last-run.json could not be read';
    return blockedStatusArtifact(input.lastRunPath, maxAgeMs, false, reason);
  }

  let wrapper: LastRunWrapper;
  try {
    wrapper = JSON.parse(raw) as LastRunWrapper;
  } catch {
    return blockedStatusArtifact(input.lastRunPath, maxAgeMs, true, 'last-run.json could not be parsed');
  }
  const summary = normalizeSummary(wrapper.summary);
  const completedAt = typeof wrapper.completed_at === 'string' ? wrapper.completed_at : null;
  const ageMs = completedAt === null ? null : now.getTime() - Date.parse(completedAt);
  const staleReason = staleReasonFor(completedAt, ageMs, maxAgeMs);
  const warnings: string[] = [];
  const wrapperStatus = typeof wrapper.status === 'string' ? wrapper.status : null;
  const suppressedWrites = typeof wrapper.suppressed_writes === 'boolean' ? wrapper.suppressed_writes : null;
  const cliExitCode = typeof wrapper.cli_exit_code === 'number' ? wrapper.cli_exit_code : null;
  const wrapperOk = typeof wrapper.ok === 'boolean' ? wrapper.ok : null;

  if (staleReason !== null) {
    warnings.push(staleReason);
  }
  if (suppressedWrites !== true) {
    warnings.push('suppressed_writes was not true');
  }
  if (cliExitCode !== 0) {
    warnings.push('last GraphSync run exit code was nonzero or missing');
  }
  if (summary !== null) {
    if (summary.proposed_operations > 0) {
      warnings.push('GraphSync proposed operations require operator review');
    }
    if (summary.cycles_detected > 0) {
      warnings.push('GraphSync detected dependency cycles');
    }
    if (summary.missing_kanban_edges > 0) {
      warnings.push('GraphSync observed missing Kanban edges');
    }
    if (summary.missing_linear_relations > 0) {
      warnings.push('GraphSync observed missing Linear relations');
    }
  }

  const status = classifyStatus({ wrapperStatus, wrapperOk, cliExitCode, stale: staleReason !== null, suppressedWrites });
  return {
    ok: status !== 'BLOCK',
    effect: 'graph_sync_status_watchdog',
    status,
    last_run: {
      path: input.lastRunPath,
      exists: true,
      ok: wrapperOk,
      wrapper_status: wrapperStatus,
      cli_exit_code: cliExitCode,
      run_dir: typeof wrapper.run_dir === 'string' ? wrapper.run_dir : null,
      completed_at: completedAt,
      age_ms: ageMs,
      max_age_ms: maxAgeMs,
      stale: staleReason !== null,
      stale_reason: staleReason,
      suppressed_writes: suppressedWrites,
    },
    summary,
    warnings,
    non_actions: mergeNonActions(wrapper.non_actions),
  };
}

function blockedStatusArtifact(
  path: string,
  maxAgeMs: number,
  exists: boolean,
  reason: string,
): GraphSyncStatusWatchdogArtifact {
  return {
    ok: false,
    effect: 'graph_sync_status_watchdog',
    status: 'BLOCK',
    last_run: {
      path,
      exists,
      ok: null,
      wrapper_status: null,
      cli_exit_code: null,
      run_dir: null,
      completed_at: null,
      age_ms: null,
      max_age_ms: maxAgeMs,
      stale: true,
      stale_reason: reason,
      suppressed_writes: null,
    },
    summary: null,
    warnings: [reason],
    non_actions: mergeNonActions(null),
  };
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { readonly code?: unknown }).code === 'ENOENT';
}

function classifyStatus(input: {
  readonly wrapperStatus: string | null;
  readonly wrapperOk: boolean | null;
  readonly cliExitCode: number | null;
  readonly stale: boolean;
  readonly suppressedWrites: boolean | null;
}): GraphSyncWatchdogStatus {
  if (input.wrapperStatus === 'BLOCK' || input.wrapperOk === false || input.cliExitCode !== 0 || input.stale || input.suppressedWrites !== true) {
    return 'BLOCK';
  }
  if (input.wrapperStatus === 'REVIEW') {
    return 'REVIEW';
  }
  return 'PASS';
}

function staleReasonFor(completedAt: string | null, ageMs: number | null, maxAgeMs: number): string | null {
  if (completedAt === null || ageMs === null || !Number.isFinite(ageMs)) {
    return 'last GraphSync run is missing completed_at';
  }
  if (ageMs < 0) {
    return `last GraphSync run completed_at ${completedAt} is in the future`;
  }
  if (ageMs > maxAgeMs) {
    return `last GraphSync run age ${String(ageMs)}ms exceeds max_age_ms ${String(maxAgeMs)}`;
  }
  return null;
}

function normalizeSummary(value: unknown): GraphSyncWatchdogSummary | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    linear_issues_read: numberField(record, 'linear_issues_read'),
    kanban_tasks_read: numberField(record, 'kanban_tasks_read'),
    mappings_resolved: numberField(record, 'mappings_resolved'),
    linear_edges_seen: numberField(record, 'linear_edges_seen'),
    kanban_edges_seen: numberField(record, 'kanban_edges_seen'),
    matched_edges: numberField(record, 'matched_edges'),
    missing_kanban_edges: numberField(record, 'missing_kanban_edges'),
    missing_linear_relations: numberField(record, 'missing_linear_relations'),
    endpoint_policies: numberField(record, 'endpoint_policies'),
    cycles_detected: numberField(record, 'cycles_detected'),
    proposed_operations: numberField(record, 'proposed_operations'),
  };
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function mergeNonActions(value: unknown): readonly string[] {
  const fromWrapper = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return Array.from(new Set([...fromWrapper, ...STATUS_NON_ACTIONS]));
}
