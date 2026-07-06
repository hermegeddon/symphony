#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { captureGraphSyncReadOnlySnapshot } from '../graph-sync-live-snapshot.js';
import type { CaptureGraphSyncReadOnlySnapshotResult } from '../graph-sync-live-snapshot.js';
import {
  createBridgeLedgerGraphSyncMappingReader,
  createEnrichedHermesKanbanGraphReader,
  createLinearTrackerGraphSyncLinearReader,
} from '../graph-sync-live-readers.js';
import type { GraphSyncScope } from '../graph-sync-ledger.js';
import { HermesKanbanCliClient } from '../kanban-client.js';
import type { KanbanTaskDetail } from '../kanban-types.js';
import type { Issue } from '../domain.js';
import {
  createFileSystemGraphSyncStateStorage,
  createInMemoryGraphSyncStateStorage,
} from '../graph-sync-state-storage.js';
import type { GraphSyncStateStorage } from '../graph-sync-state.js';
import { getEffectiveConfig, loadWorkflow, type EffectiveConfig, type KanbanBackendConfig } from '../workflow.js';
import { isDirectCliExecution } from './direct-execution.js';

export type GraphSyncSnapshotTextWriter = (chunk: string) => void;

export interface GraphSyncSnapshotCliOptions {
  readonly stdout?: GraphSyncSnapshotTextWriter;
  readonly stderr?: GraphSyncSnapshotTextWriter;
  readonly processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly now?: Date;
}

interface ParsedGraphSyncSnapshotFlags {
  readonly help: boolean;
  readonly mode?: 'read_only_snapshot';
  readonly workflowPath?: string;
  readonly outputPath?: string;
  readonly receiptOutputPath?: string;
  readonly summaryOutputPath?: string;
  readonly statusOutputPath?: string;
  readonly statePath?: string;
  readonly dryRunState: boolean;
  readonly statePathKind: 'memory' | 'injected';
}

export async function runSymphonyGraphSyncSnapshotCli(
  argv: readonly string[],
  options: GraphSyncSnapshotCliOptions = {},
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
    if (flags.mode !== 'read_only_snapshot') {
      throw new Error('symphony-graph-sync-snapshot only supports --mode read_only_snapshot');
    }
    const workflowPath = requireFlag(flags.workflowPath, '--workflow');
    const outputPath = requireFlag(flags.outputPath, '--output');
    const receiptOutputPath = requireFlag(flags.receiptOutputPath, '--receipt-output');

    const { config, kanban } = await loadSnapshotWorkflow(workflowPath, env);
    const scope = buildScope(config, kanban);
    const stateStorage = buildStateStorage(flags, kanban);
    const runId = generateRunId();
    const result = await captureGraphSyncReadOnlySnapshot({
      workflowId: config.tracker.kind ?? 'symphony-graph-sync-snapshot',
      runId,
      scope,
      stateStorage,
      linearReader: buildLinearReader(config),
      kanbanReader: buildKanbanReader(kanban, env),
      mappingReader: buildMappingReader(config),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    let hashes: GraphSyncSnapshotHashes | undefined;
    if (result.ok) {
      const snapshotPayload = `${JSON.stringify(result.snapshot, null, 2)}\n`;
      const receiptPayload = `${JSON.stringify(result.receipt, null, 2)}\n`;
      await mkdir(dirname(outputPath), { recursive: true });
      await mkdir(dirname(receiptOutputPath), { recursive: true });
      await writeArtifactAtomic(outputPath, snapshotPayload);
      await writeArtifactAtomic(receiptOutputPath, receiptPayload);
      hashes = {
        snapshot_sha256: sha256Hex(snapshotPayload),
        receipt_sha256: sha256Hex(receiptPayload),
      };
    }

    const artifact = buildSnapshotArtifact(result, outputPath, receiptOutputPath, flags, hashes);

    if (flags.summaryOutputPath !== undefined) {
      await mkdir(dirname(flags.summaryOutputPath), { recursive: true });
      await writeArtifactAtomic(flags.summaryOutputPath, renderSnapshotSummaryMarkdown(artifact));
    }
    if (flags.statusOutputPath !== undefined) {
      await mkdir(dirname(flags.statusOutputPath), { recursive: true });
      await writeArtifactAtomic(
        flags.statusOutputPath,
        `${JSON.stringify(buildSnapshotStatusArtifact(artifact), null, 2)}\n`,
      );
    }

    stdout(`${JSON.stringify(artifact, null, 2)}\n`);
    return result.ok ? (result.status === 'BLOCK' ? 1 : 0) : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`${JSON.stringify({ ok: false, status: 'BLOCK', error: redactForCli(message) }, null, 2)}\n`);
    return 1;
  }
}

function buildSnapshotArtifact(
  result: CaptureGraphSyncReadOnlySnapshotResult,
  outputPath: string,
  receiptOutputPath: string,
  flags: ParsedGraphSyncSnapshotFlags,
  hashes?: GraphSyncSnapshotHashes,
): GraphSyncSnapshotCliArtifact {
  if (!result.ok) {
    return {
      ok: false,
      effect: 'graph_sync_read_only_snapshot_artifact',
      status: 'BLOCK',
      mode: 'read_only_snapshot',
      suppressed_writes: true,
      snapshot_path: outputPath,
      receipt_path: receiptOutputPath,
      error: result.error,
      state: {
        checkpoint_state_path: flags.statePathKind,
        dry_run: flags.dryRunState,
        ...(flags.statePath === undefined ? {} : { state_path: flags.statePath }),
      },
      non_actions: result.non_actions,
    };
  }
  return {
    ok: true,
    effect: 'graph_sync_read_only_snapshot_artifact',
    status: result.status,
    mode: 'read_only_snapshot',
    suppressed_writes: true,
    workflow_id: result.workflow_id,
    run_id: result.run_id,
    generated_at: result.generated_at,
    completed_at: result.completed_at,
    snapshot_path: outputPath,
    receipt_path: receiptOutputPath,
    summary: result.summary,
    ...(hashes === undefined ? {} : { hashes }),
    state: {
      checkpoint_state_path: result.checkpoint_state_path,
      dry_run: flags.dryRunState,
      ...(flags.statePath === undefined ? {} : { state_path: flags.statePath }),
    },
    non_actions: result.non_actions,
  };
}

interface GraphSyncSnapshotCliArtifact {
  readonly ok: boolean;
  readonly effect: 'graph_sync_read_only_snapshot_artifact';
  readonly status: 'PASS' | 'REVIEW' | 'BLOCK';
  readonly mode: 'read_only_snapshot';
  readonly suppressed_writes: true;
  readonly workflow_id?: string | undefined;
  readonly run_id?: string | undefined;
  readonly generated_at?: string | undefined;
  readonly completed_at?: string | undefined;
  readonly snapshot_path: string;
  readonly receipt_path: string;
  readonly summary?: GraphSyncSnapshotSummaryFromResult;
  readonly hashes?: GraphSyncSnapshotHashes | undefined;
  readonly error?: string;
  readonly state?: {
    readonly checkpoint_state_path: 'memory' | 'injected';
    readonly dry_run: boolean;
    readonly state_path?: string;
  };
  readonly non_actions: readonly string[];
}

interface GraphSyncSnapshotHashes {
  readonly snapshot_sha256: string;
  readonly receipt_sha256: string;
}

interface GraphSyncSnapshotSummaryFromResult {
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

interface GraphSyncSnapshotStatusArtifact {
  readonly ok: boolean;
  readonly effect: 'graph_sync_read_only_snapshot_status';
  readonly status: 'PASS' | 'REVIEW' | 'BLOCK';
  readonly mode: 'read_only_snapshot';
  readonly workflow_id?: string | undefined;
  readonly run_id?: string | undefined;
  readonly generated_at?: string | undefined;
  readonly completed_at?: string | undefined;
  readonly snapshot_path: string;
  readonly receipt_path: string;
  readonly suppressed_writes: true;
  readonly summary: GraphSyncSnapshotSummaryFromResult;
  readonly non_actions: readonly string[];
}

function buildSnapshotStatusArtifact(
  artifact: GraphSyncSnapshotCliArtifact,
): GraphSyncSnapshotStatusArtifact {
  return {
    ok: artifact.ok,
    effect: 'graph_sync_read_only_snapshot_status',
    status: artifact.status,
    mode: 'read_only_snapshot',
    workflow_id: artifact.workflow_id,
    run_id: artifact.run_id,
    generated_at: artifact.generated_at,
    completed_at: artifact.completed_at,
    snapshot_path: artifact.snapshot_path,
    receipt_path: artifact.receipt_path,
    suppressed_writes: true,
    summary: artifact.summary ?? emptySummary(),
    non_actions: artifact.non_actions,
  };
}

function emptySummary(): GraphSyncSnapshotSummaryFromResult {
  return {
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
  };
}

function renderSnapshotSummaryMarkdown(artifact: GraphSyncSnapshotCliArtifact): string {
  const lines: string[] = [
    '# GraphSync read-only snapshot summary',
    '',
    `Operator status: \`${artifact.status}\``,
    '',
    'No Linear relation writes, Kanban link writes, service/timer changes, or MCP apply actions were performed.',
    '',
    '## Artifact provenance',
    '',
    `- Snapshot: \`${artifact.snapshot_path}\``,
    `- Receipt: \`${artifact.receipt_path}\``,
    `- Mode: \`${artifact.mode}\``,
    `- Suppressed writes: \`${String(artifact.suppressed_writes)}\``,
    '',
  ];

  if (artifact.state !== undefined) {
    lines.push('## Checkpoint state');
    lines.push('');
    lines.push(`- State path kind: \`${artifact.state.checkpoint_state_path}\``);
    lines.push(`- Dry run: \`${String(artifact.state.dry_run)}\``);
    if (artifact.state.state_path !== undefined) {
      lines.push(`- State path: \`${artifact.state.state_path}\``);
    }
    lines.push('');
  }

  if (artifact.error !== undefined) {
    lines.push('## Error');
    lines.push('');
    lines.push(`- ${artifact.error}`);
    lines.push('');
  } else if (artifact.summary !== undefined) {
    lines.push('## Counts');
    lines.push('');
    lines.push('| Metric | Count |');
    lines.push('|---|---:|');
    lines.push(`| Linear issues read | ${String(artifact.summary.linear_issues_read)} |`);
    lines.push(`| Kanban tasks read | ${String(artifact.summary.kanban_tasks_read)} |`);
    lines.push(`| Mappings resolved | ${String(artifact.summary.mappings_resolved)} |`);
    lines.push(`| Linear edges seen | ${String(artifact.summary.linear_edges_seen)} |`);
    lines.push(`| Kanban edges seen | ${String(artifact.summary.kanban_edges_seen)} |`);
    lines.push(`| Matched edges | ${String(artifact.summary.matched_edges)} |`);
    lines.push(`| Missing Kanban edges | ${String(artifact.summary.missing_kanban_edges)} |`);
    lines.push(`| Missing Linear relations | ${String(artifact.summary.missing_linear_relations)} |`);
    lines.push(`| Endpoint policies | ${String(artifact.summary.endpoint_policies)} |`);
    lines.push(`| Cycles detected | ${String(artifact.summary.cycles_detected)} |`);
    lines.push(`| Proposed operations | ${String(artifact.summary.proposed_operations)} |`);
    lines.push('');
  }

  lines.push('## Explicit non-actions');
  lines.push('');
  for (const nonAction of artifact.non_actions) {
    lines.push(`- ${nonAction}`);
  }
  lines.push('');

  return lines.join('\n');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function writeArtifactAtomic(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, filePath);
}

function buildStateStorage(
  flags: ParsedGraphSyncSnapshotFlags,
  kanban: KanbanBackendConfig,
): GraphSyncStateStorage {
  const effectiveStatePath = flags.statePath ?? defaultStatePath(kanban);
  if (effectiveStatePath.trim() === '') {
    return createInMemoryGraphSyncStateStorage();
  }
  return createFileSystemGraphSyncStateStorage({
    statePath: effectiveStatePath,
    dryRun: flags.dryRunState,
  });
}

function defaultStatePath(kanban: KanbanBackendConfig): string {
  return kanban.artifactRoot ? resolve(kanban.artifactRoot, 'graph-sync-state.json') : '';
}

async function loadSnapshotWorkflow(
  workflowPath: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<{ config: EffectiveConfig; kanban: KanbanBackendConfig }> {
  const workflow = await loadWorkflow(workflowPath);
  const config = getEffectiveConfig(workflow, { env });
  if (config.backend.kind !== 'hermes_kanban' || config.kanban === null) {
    throw new Error('symphony-graph-sync-snapshot requires backend.kind: hermes_kanban');
  }
  if (config.tracker.kind !== 'linear') {
    throw new Error('symphony-graph-sync-snapshot requires tracker.kind: linear');
  }
  return { config, kanban: config.kanban };
}

function buildScope(config: EffectiveConfig, kanban: KanbanBackendConfig): GraphSyncScope {
  return {
    tracker: config.tracker.kind ?? 'linear',
    selector_kind: config.tracker.projectSlug !== null ? 'project_slug' : config.tracker.teamKey !== null ? 'team_key' : 'all_approved_projects',
    project_slug: config.tracker.projectSlug ?? null,
    team_key: config.tracker.teamKey ?? null,
    all_approved_projects: config.tracker.allApprovedProjects,
    kanban_board: kanban.board,
    active_states: [...config.tracker.activeStates],
    terminal_states: [...config.tracker.terminalStates],
  };
}

function buildLinearReader(config: EffectiveConfig): { readIssuesWithRelations(scope: GraphSyncScope, mappings?: readonly { linearIssueId: string; kanbanTaskId: string }[]): Promise<readonly Issue[]> } {
  return createLinearTrackerGraphSyncLinearReader({ config });
}

function buildKanbanReader(
  kanban: KanbanBackendConfig,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): { readTaskDetails(taskIds: readonly string[]): Promise<readonly KanbanTaskDetail[]> } {
  const path = env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin';
  const client = new HermesKanbanCliClient({
    command: kanban.hermesCommand,
    board: kanban.board,
    hermesHome: kanban.hermesHome,
    path,
  });
  const inner = {
    readTaskDetails(taskIds: readonly string[]): Promise<readonly KanbanTaskDetail[]> {
      return Promise.all(taskIds.map((id) => client.showTask(id)));
    },
  };
  return createEnrichedHermesKanbanGraphReader({
    inner,
    board: kanban.board,
    crossBoardDbPath: join(kanban.hermesHome, 'kanban', 'cross_board_dependencies.db'),
  });
}

function buildMappingReader(config: EffectiveConfig): { readMappings(scope: GraphSyncScope): Promise<readonly { linearIssueId: string; kanbanTaskId: string }[]> } {
  if (config.service.statePath === null) {
    return {
      readMappings(): Promise<readonly { linearIssueId: string; kanbanTaskId: string }[]> {
        return Promise.reject(new Error('GraphSync mapping reader requires service.state_path'));
      },
    };
  }
  return createBridgeLedgerGraphSyncMappingReader(config.service.statePath);
}

function generateRunId(): string {
  const now = new Date();
  const date = now.toISOString().replaceAll(/[:.]/g, '-').slice(0, 19);
  const random = Math.random().toString(36).slice(2, 10);
  return `graphsync-snapshot-${date}-${random}`;
}

function parseFlags(argv: readonly string[]): ParsedGraphSyncSnapshotFlags {
  let help = false;
  let mode: 'read_only_snapshot' | undefined;
  let workflowPath: string | undefined;
  let outputPath: string | undefined;
  let receiptOutputPath: string | undefined;
  let summaryOutputPath: string | undefined;
  let statusOutputPath: string | undefined;
  let statePath: string | undefined;
  let dryRunState = false;

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
      if (value !== 'read_only_snapshot') {
        throw new Error('symphony-graph-sync-snapshot only supports --mode read_only_snapshot');
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
    if (arg === '--output') {
      outputPath = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--receipt-output') {
      receiptOutputPath = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--summary-output') {
      summaryOutputPath = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--status-output') {
      statusOutputPath = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--state-path') {
      statePath = readFlagValue(argv, index, arg);
      dryRunState = false;
      index += 1;
      continue;
    }
    if (arg === '--dry-run-state') {
      dryRunState = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    help,
    dryRunState: dryRunState || statePath === undefined,
    statePathKind: statePath === undefined ? 'memory' : 'injected' as const,
    ...(statePath === undefined ? {} : { statePath }),
    ...(mode === undefined ? {} : { mode }),
    ...(workflowPath === undefined ? {} : { workflowPath }),
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(receiptOutputPath === undefined ? {} : { receiptOutputPath }),
    ...(summaryOutputPath === undefined ? {} : { summaryOutputPath }),
    ...(statusOutputPath === undefined ? {} : { statusOutputPath }),
    ...(statePath === undefined ? {} : { statePath }),
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
    'Usage: symphony-graph-sync-snapshot --mode read_only_snapshot --workflow WORKFLOW.md --output snapshot.json --receipt-output receipt.json',
    '',
    'Capture a local read-only Linear ↔ Hermes Kanban graph snapshot and diff receipt.',
    'This command does not mutate Linear relations, Kanban links, services/timers, or MCP apply surfaces.',
    '',
    'Options:',
    '  --mode read_only_snapshot  Required; the only supported mode',
    '  --workflow PATH            Private Symphony workflow file to load',
    '  --output PATH              Observed snapshot JSON artifact path',
    '  --receipt-output PATH      GraphSync read-only diff receipt artifact path',
    '  --summary-output PATH      Optional local Markdown summary artifact path',
    '  --status-output PATH       Optional local status JSON artifact path',
    '  --state-path PATH          Optional local durable GraphSync checkpoint state path',
    '  --dry-run-state            Read durable state but never write it (default without --state-path)',
    '  --help, -h                 Show this help text',
    '',
  ].join('\n');
}

if (isDirectCliExecution(import.meta.url)) {
  process.exitCode = await runSymphonyGraphSyncSnapshotCli(process.argv.slice(2));
}
