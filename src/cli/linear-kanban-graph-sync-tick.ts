#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { CaptureGraphSyncReadOnlySnapshotResult } from '../graph-sync-live-snapshot.js';
import {
  runRecurringLinearKanbanGraphSyncCanary,
  type LinearKanbanGraphSyncDispatchRelianceProbe,
  type LinearKanbanGraphSyncDispatchRelianceProbeReceipt,
  type LinearKanbanGraphSyncRecurringCanaryReceipt,
  type LinearKanbanGraphSyncRecurringTickStatus,
} from '../linear-kanban-graph-sync-tick.js';
import { createGraphSyncRecurringStateManager } from '../graph-sync-recurring-state.js';
import type { LinearKanbanBridgeTickReceipt } from '../linear-kanban-bridge.js';
import {
  ConfigValidationError,
  getEffectiveConfig,
  loadWorkflow,
  type EffectiveConfig,
} from '../workflow.js';
import { isDirectCliExecution } from './direct-execution.js';

export type LinearKanbanGraphSyncTickTextWriter = (chunk: string) => void;

export interface LinearKanbanGraphSyncTickCliOptions {
  readonly stdout?: LinearKanbanGraphSyncTickTextWriter;
  readonly stderr?: LinearKanbanGraphSyncTickTextWriter;
  readonly processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly now?: Date;
  readonly lifecycleTickFactory?: (
    config: EffectiveConfig,
    env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  ) => (() => Promise<LinearKanbanBridgeTickReceipt>);
  readonly graphSyncSnapshotFactory?: (
    config: EffectiveConfig,
    env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  ) => (() => Promise<CaptureGraphSyncReadOnlySnapshotResult>);
}

interface ParsedLinearKanbanGraphSyncTickFlags {
  readonly help: boolean;
  readonly workflowPath?: string | undefined;
  readonly mode?: 'fake_local_readonly';
  readonly artifactRoot?: string | undefined;
}

interface LinearKanbanGraphSyncTickCliArtifact {
  readonly ok: boolean;
  readonly effect: 'linear_kanban_graph_sync_tick_cli';
  readonly status: LinearKanbanGraphSyncRecurringTickStatus;
  readonly workflow_id: string;
  readonly run_id: string;
  readonly generated_at: string;
  readonly artifact_root: string;
  readonly receipt_path: string;
  readonly tick_receipt_path: string;
  readonly status_path: string;
  readonly summary_path: string;
  readonly lifecycle_mutations_attempted: false;
  readonly kanban_mutations_attempted: false;
  readonly linear_mutations_attempted: false;
  readonly dispatch_reliance_attempted: boolean;
  readonly dispatch_reliance_suppressed: boolean;
  readonly dispatch_reliance_decision: 'allowed' | 'deferred' | 'blocked';
  readonly error?: string;
  readonly non_actions: readonly string[];
}

export async function runSymphonyLinearKanbanGraphSyncTickCli(
  argv: readonly string[],
  options: LinearKanbanGraphSyncTickCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = options.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const env = options.processEnv ?? process.env;

  try {
    const flags = parseFlags(argv);
    if (flags.help) {
      stdout(usage());
      return 0;
    }

    if (flags.mode !== 'fake_local_readonly') {
      throw new Error('symphony-linear-kanban-graph-sync-tick only supports --mode fake_local_readonly in Swarm 1');
    }
    const workflowPath = requireFlag(flags.workflowPath, '--workflow');
    const artifactRoot = requireFlag(flags.artifactRoot, '--artifact-root');

    const workflow = await loadWorkflow(workflowPath);
    const config = getEffectiveConfig(workflow, { env });
    validateFakeLocalReadonlyConfig(config);

    const runId = generateRunId();
    const now = options.now ?? new Date();

    const runLifecycleTick = options.lifecycleTickFactory?.(config, env) ?? fakeLocalLifecycleTick();
    const captureGraphSyncSnapshot = options.graphSyncSnapshotFactory?.(config, env)
      ?? fakeLocalGraphSyncSnapshot();

    const workflowId = workflowIdFromConfig(workflow.workflow_path);
    const resolvedArtifactRoot = resolve(artifactRoot);
    const stateManager = createGraphSyncRecurringStateManager({
      artifactRoot: resolvedArtifactRoot,
      workflowId,
      freshnessTtlMs: 300000,
    });

    const receipt = await runRecurringLinearKanbanGraphSyncCanary({
      workflowId,
      runId,
      artifactRoot: resolvedArtifactRoot,
      runLifecycleTick,
      captureGraphSyncSnapshot,
      dispatchRelianceProbe: fakeLocalDispatchRelianceProbe,
      now,
      stateManager,
    });

    const runDirectory = dirname(receipt.artifacts.tick_receipt_path);
    const receiptPath = join(runDirectory, 'receipt.json');
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

    stdout(`${JSON.stringify(buildCliArtifact(receipt, receiptPath), null, 2)}\n`);
    return statusToExitCode(receipt.status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`${JSON.stringify({ ok: false, status: 'BLOCK', error: redactForCli(message) }, null, 2)}\n`);
    return 1;
  }
}

function buildCliArtifact(
  receipt: LinearKanbanGraphSyncRecurringCanaryReceipt,
  receiptPath: string,
): LinearKanbanGraphSyncTickCliArtifact {
  return {
    ok: receipt.ok,
    effect: 'linear_kanban_graph_sync_tick_cli',
    status: receipt.status,
    workflow_id: receipt.workflow_id,
    run_id: receipt.run_id,
    generated_at: receipt.generated_at,
    artifact_root: receipt.artifact_root,
    receipt_path: receiptPath,
    tick_receipt_path: receipt.artifacts.tick_receipt_path,
    status_path: receipt.artifacts.status_path,
    summary_path: receipt.artifacts.summary_path,
    lifecycle_mutations_attempted: false,
    kanban_mutations_attempted: false,
    linear_mutations_attempted: false,
    dispatch_reliance_attempted: receipt.dispatch_probe?.dispatch_reliance_attempted ?? false,
    dispatch_reliance_suppressed: receipt.dispatch_reliance_suppressed,
    dispatch_reliance_decision: receipt.dispatch_reliance_decision,
    non_actions: receipt.non_actions,
  };
}

function statusToExitCode(status: LinearKanbanGraphSyncRecurringTickStatus): number {
  if (status === 'PASS') {
    return 0;
  }
  if (status === 'REVIEW') {
    return 2;
  }
  return 3;
}

function workflowIdFromConfig(workflowPath: string): string {
  return `symphony-linear-kanban-graph-sync-tick-${resolve(workflowPath)}`;
}

function validateFakeLocalReadonlyConfig(config: EffectiveConfig): void {
  if (config.graphSync.enabled && config.graphSync.dispatchReliance.enabled) {
    throw new ConfigValidationError(
      'graph_sync.dispatch_reliance.enabled',
      'dispatch reliance is not supported in Swarm 1 fake/local-readonly mode',
    );
  }
}

function fakeLocalLifecycleTick(): () => Promise<LinearKanbanBridgeTickReceipt> {
  return () => Promise.resolve({
    ok: true,
    effect: 'linear_kanban_bridge_tick',
    workflow_id: 'fake-local-lifecycle',
    board: 'linear',
    artifact_root: '/tmp/symphony-fake-local-lifecycle',
    dispatch_policy: 'no_worker',
    candidates: 0,
    materialized: [],
    skipped: [],
    completed: [],
    provenance_warnings: [],
  });
}

function fakeLocalGraphSyncSnapshot(): () => Promise<CaptureGraphSyncReadOnlySnapshotResult> {
  const now = new Date();
  const generatedAt = now.toISOString();
  const completedAt = generatedAt;
  const runId = 'fake-local-graph-sync-run';
  const workflowId = 'fake-local-graph-sync';
  const scope = { tracker: 'linear', selector: 'all_approved_projects', kanbanBoard: 'linear' };
  const receipt: import('../graph-sync-ledger.js').GraphSyncReadOnlyDiffReceipt = {
    ok: true,
    effect: 'graph_sync_read_only_diff',
    workflow_id: workflowId,
    run_id: runId,
    generated_at: generatedAt,
    completed_at: completedAt,
    mode: 'read_only_diff',
    suppressed_writes: true,
    ledger: {
      version: 1,
      generated_by: 'symphony-linear-kanban-bridge',
      workflow_id: workflowId,
      generated_at: generatedAt,
      scope,
      nodes: {},
      edges: {},
      conflicts: {},
      semantic_events: {},
      runs: [{
        run_id: runId,
        started_at: generatedAt,
        completed_at: completedAt,
        mode: 'read_only_diff',
        suppressed_writes: true,
        edges_seen: 0,
        conflicts_seen: 0,
      }],
    },
    diff: {
      matched_edges: [],
      missing_kanban_edges: [],
      missing_linear_relations: [],
      endpoint_policies: [],
      cycles: [],
    },
    summary: {
      linear_edges_seen: 0,
      kanban_edges_seen: 0,
      matched_edges: 0,
      missing_kanban_edges: 0,
      missing_linear_relations: 0,
      endpoint_policies: 0,
      cycles_detected: 0,
      conflicts: 0,
      semantic_events: 0,
    },
    proposed_operations: [],
    non_actions: [
      'did_not_create_update_delete_linear_relations',
      'did_not_create_update_delete_kanban_links',
    ],
  };

  return () => Promise.resolve({
    ok: true,
    effect: 'graph_sync_read_only_snapshot_capture',
    status: 'PASS',
    workflow_id: workflowId,
    run_id: runId,
    generated_at: generatedAt,
    completed_at: completedAt,
    mode: 'read_only_snapshot',
    suppressed_writes: true,
    snapshot: {
      runId,
      scope,
      completeness: {
        linear_issues: 'complete',
        linear_relations: 'complete',
        linear_inverse_relations: 'complete',
        dependency_closure: 'complete',
        kanban_tasks: 'complete',
        kanban_links: 'complete',
        max_nodes_reached: false,
        max_depth_reached: false,
        max_pages_reached: false,
        inaccessible_or_deleted_endpoint_count: 0,
        archived_endpoint_count: 0,
        reader_errors: [],
        rate_limited: false,
        apply_eligible: true,
      },
      issues: [],
      kanbanTasks: [],
      nodeMappings: [],
      non_actions: [
        'did_not_create_update_delete_linear_relations',
        'did_not_create_update_delete_kanban_links',
      ],
    },
    receipt,
    checkpoint: null,
    checkpoint_state_path: 'memory',
    summary: {
      linear_issues_read: 0,
      kanban_tasks_read: 0,
      mappings_resolved: 0,
      linear_edges_seen: 0,
      kanban_edges_seen: 0,
      matched_edges: 0,
      missing_kanban_edges: 0,
      missing_linear_relations: 0,
      endpoint_policies: 0,
      cycles_detected: 0,
      proposed_operations: 0,
    },
    non_actions: [
      'did_not_create_update_delete_linear_relations',
      'did_not_create_update_delete_kanban_links',
      'did_not_edit_restart_or_disable_services_or_timers',
      'did_not_dispatch_workers_or_gateway',
      'did_not_push_publish_deploy_or_open_pr',
    ],
  });
}

const fakeLocalDispatchRelianceProbe: LinearKanbanGraphSyncDispatchRelianceProbe = (
): Promise<LinearKanbanGraphSyncDispatchRelianceProbeReceipt> => Promise.resolve({
  ok: true,
  effect: 'linear_kanban_graph_sync_dispatch_reliance_probe',
  dispatch_reliance_attempted: true,
  notes: ['fake-local probe: would inspect gateway dispatch readiness if dependency readiness allowed it'],
});

function generateRunId(): string {
  const now = new Date();
  const date = now.toISOString().replaceAll(/[:.]/g, '-').slice(0, 19);
  const random = Math.random().toString(36).slice(2, 10);
  return `graphsync-tick-${date}-${random}`;
}

function parseFlags(argv: readonly string[]): ParsedLinearKanbanGraphSyncTickFlags {
  let help = false;
  let mode: 'fake_local_readonly' | undefined;
  let workflowPath: string | undefined;
  let artifactRoot: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--mode') {
      const value = readFlagValue(argv, index, arg);
      if (value !== 'fake_local_readonly') {
        throw new Error('symphony-linear-kanban-graph-sync-tick only supports --mode fake_local_readonly in Swarm 1');
      }
      mode = value;
      index += 1;
      continue;
    }
    if (arg === '--workflow') {
      workflowPath = resolveWorkflowPath(readFlagValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--artifact-root') {
      artifactRoot = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    help,
    ...(mode === undefined ? {} : { mode }),
    ...(workflowPath === undefined ? {} : { workflowPath }),
    ...(artifactRoot === undefined ? {} : { artifactRoot }),
  };
}

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function requireFlag(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new Error(`${flag} is required`);
  }
  return value;
}

function resolveWorkflowPath(value: string): string {
  return resolve(value);
}

function redactForCli(value: string): string {
  return value
    .replace(/lin_api_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]');
}

function usage(): string {
  return [
    'Usage: symphony-linear-kanban-graph-sync-tick --mode fake_local_readonly --workflow WORKFLOW.md --artifact-root ARTIFACT_ROOT',
    '',
    'Run one fake/local-readonly lifecycle + GraphSync recurring tick and write receipt/status/summary artifacts.',
    'This command does not mutate Linear relations, Kanban links, services/timers, or dispatch workers in Swarm 1.',
    '',
    'Options:',
    '  --mode fake_local_readonly  Required; the only supported mode in Swarm 1',
    '  --workflow PATH             Private Symphony workflow file to load',
    '  --artifact-root PATH        Local artifact root for this tick run',
    '  --help, -h                  Show this help text',
    '',
  ].join('\n');
}

if (isDirectCliExecution(import.meta.url)) {
  process.exitCode = await runSymphonyLinearKanbanGraphSyncTickCli(process.argv.slice(2));
}
