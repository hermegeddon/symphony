#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { GraphSyncReadOnlyDiffReceipt } from '../graph-sync-ledger.js';
import {
  applyGraphSyncMissingKanbanBlockingEdges,
  type GraphSyncLiveKanbanBlockingEdgeApplyReceipt,
} from '../graph-sync-materializer.js';
import { HermesKanbanCliClient } from '../kanban-client.js';
import type { KanbanClient } from '../kanban-types.js';
import { isDirectCliExecution } from './direct-execution.js';

export type GraphSyncKanbanApplyTextWriter = (chunk: string) => void;

export interface GraphSyncKanbanApplyClientFactoryContext {
  readonly command: string;
  readonly board: string;
  readonly hermesHome: string;
  readonly path: string;
}

export interface SymphonyGraphSyncKanbanApplyCliOptions {
  readonly stdout?: GraphSyncKanbanApplyTextWriter;
  readonly stderr?: GraphSyncKanbanApplyTextWriter;
  readonly processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly kanbanClientFactory?: (
    context: GraphSyncKanbanApplyClientFactoryContext,
  ) => Pick<KanbanClient, 'createTaskLink' | 'showTask'>;
}

export interface GraphSyncLiveKanbanBlockingEdgeApplyArtifactSummary {
  readonly ok: boolean;
  readonly effect: 'graph_sync_live_kanban_blocking_edge_apply_artifact';
  readonly mode: 'linear_authoritative_apply';
  readonly board: string;
  readonly input_path: string;
  readonly receipt_path: string;
  readonly approved_scope: string;
  readonly max_created_links: number;
  readonly summary: GraphSyncLiveKanbanBlockingEdgeApplyReceipt['summary'];
  readonly created_links: readonly GraphSyncLiveKanbanBlockingEdgeApplyReceipt['created_links'][number][];
  readonly skipped_edges: readonly GraphSyncLiveKanbanBlockingEdgeApplyReceipt['skipped_edges'][number][];
  readonly actions: readonly string[];
  readonly non_actions: readonly string[];
}

interface ParsedGraphSyncKanbanApplyFlags {
  readonly help: boolean;
  readonly allowLiveKanbanApply: boolean;
  readonly mode?: 'linear_authoritative_apply';
  readonly inputPath?: string;
  readonly outputPath?: string;
  readonly board?: string;
  readonly hermesCommand?: string;
  readonly hermesHome?: string;
  readonly approvedScope?: string;
  readonly maxCreated?: number;
}

const DEFAULT_SAFE_PATH = '/usr/local/bin:/usr/bin:/bin';

export async function runSymphonyGraphSyncKanbanApplyCli(
  argv: readonly string[],
  options: SymphonyGraphSyncKanbanApplyCliOptions = {},
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
    if (flags.mode !== 'linear_authoritative_apply') {
      throw new Error('symphony-graph-sync-materialize-kanban only supports --mode linear_authoritative_apply');
    }
    const inputPath = requireFlag(flags.inputPath, '--input');
    const outputPath = requireFlag(flags.outputPath, '--output');
    const board = requireFlag(flags.board, '--board');
    const hermesCommand = requireFlag(flags.hermesCommand, '--hermes-command');
    const hermesHome = requireFlag(flags.hermesHome, '--hermes-home');
    if (!flags.allowLiveKanbanApply) {
      throw new Error('--allow-live-kanban-apply is required for live/shared Hermes Kanban link writes');
    }
    const approvedScope = requireFlag(flags.approvedScope, '--approved-scope');
    const maxCreated = flags.maxCreated ?? 1;
    const sourceReceipt = JSON.parse(await readFile(inputPath, 'utf8')) as GraphSyncReadOnlyDiffReceipt;
    const path = env['PATH'] ?? DEFAULT_SAFE_PATH;
    const kanbanClient = options.kanbanClientFactory?.({ command: hermesCommand, board, hermesHome, path })
      ?? new HermesKanbanCliClient({ command: hermesCommand, board, hermesHome, path });
    const receipt = await applyGraphSyncMissingKanbanBlockingEdges({
      boundary: 'live_apply',
      receipt: sourceReceipt,
      kanbanClient,
      approvedScope,
      maxCreatedLinks: maxCreated,
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    stdout(`${JSON.stringify(buildArtifactSummary({
      inputPath,
      outputPath,
      board,
      receipt,
    }), null, 2)}\n`);
    return receipt.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`${JSON.stringify({ ok: false, status: 'BLOCK', error: redactForCli(message) }, null, 2)}\n`);
    return 1;
  }
}

function buildArtifactSummary(input: {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly board: string;
  readonly receipt: GraphSyncLiveKanbanBlockingEdgeApplyReceipt;
}): GraphSyncLiveKanbanBlockingEdgeApplyArtifactSummary {
  return {
    ok: input.receipt.ok,
    effect: 'graph_sync_live_kanban_blocking_edge_apply_artifact',
    mode: input.receipt.mode,
    board: input.board,
    input_path: input.inputPath,
    receipt_path: input.outputPath,
    approved_scope: input.receipt.approved_scope,
    max_created_links: input.receipt.safety.max_created_links,
    summary: input.receipt.summary,
    created_links: input.receipt.created_links,
    skipped_edges: input.receipt.skipped_edges,
    actions: input.receipt.actions,
    non_actions: input.receipt.non_actions,
  };
}

function parseFlags(argv: readonly string[]): ParsedGraphSyncKanbanApplyFlags {
  let help = false;
  let allowLiveKanbanApply = false;
  let mode: 'linear_authoritative_apply' | undefined;
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let board: string | undefined;
  let hermesCommand: string | undefined;
  let hermesHome: string | undefined;
  let approvedScope: string | undefined;
  let maxCreated: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--allow-live-kanban-apply') {
      allowLiveKanbanApply = true;
      continue;
    }
    if (arg === '--mode') {
      const value = readFlagValue(argv, index, arg);
      if (value !== 'linear_authoritative_apply') {
        throw new Error('symphony-graph-sync-materialize-kanban only supports --mode linear_authoritative_apply');
      }
      mode = value;
      index += 1;
      continue;
    }
    if (arg === '--input') {
      inputPath = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--output') {
      outputPath = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--board') {
      board = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--hermes-command') {
      hermesCommand = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--hermes-home') {
      hermesHome = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--approved-scope') {
      approvedScope = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--max-created') {
      maxCreated = parsePositiveInteger(readFlagValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    help,
    allowLiveKanbanApply,
    ...(mode === undefined ? {} : { mode }),
    ...(inputPath === undefined ? {} : { inputPath }),
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(board === undefined ? {} : { board }),
    ...(hermesCommand === undefined ? {} : { hermesCommand }),
    ...(hermesHome === undefined ? {} : { hermesHome }),
    ...(approvedScope === undefined ? {} : { approvedScope }),
    ...(maxCreated === undefined ? {} : { maxCreated }),
  };
}

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
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

function redactForCli(value: string): string {
  return value
    .replace(/lin_api_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]');
}

function usage(): string {
  return [
    'Usage: symphony-graph-sync-materialize-kanban --mode linear_authoritative_apply --input read-only-receipt.json --output apply-receipt.json --board BOARD --hermes-command HERMES --hermes-home HERMES_HOME --approved-scope TEXT --allow-live-kanban-apply',
    '',
    'Apply Linear-authoritative missing Kanban blocking edges from a local GraphSync read-only diff receipt.',
    'This command writes live/shared Hermes Kanban task links only when the explicit live-apply flag is present.',
    'It does not query Linear, create/update/delete Linear relations, edit services/timers, dispatch workers, or expose MCP apply behavior.',
    '',
    'Options:',
    '  --mode linear_authoritative_apply  Required; the only supported apply mode',
    '  --input PATH                       Local graph-sync read_only_diff receipt JSON',
    '  --output PATH                      Local live-apply receipt artifact path to write',
    '  --board SLUG                       Exact Hermes Kanban board slug to mutate',
    '  --hermes-command PATH              Hermes CLI command path',
    '  --hermes-home PATH                 Hermes home/profile root for the CLI subprocess',
    '  --approved-scope TEXT              Human-reviewed exact scope for this apply run',
    '  --max-created N                    Maximum links this run may create (default: 1)',
    '  --allow-live-kanban-apply          Required noisy live mutation flag',
    '  --help, -h                         Show this help text',
    '',
  ].join('\n');
}

if (isDirectCliExecution(import.meta.url)) {
  process.exitCode = await runSymphonyGraphSyncKanbanApplyCli(process.argv.slice(2));
}
