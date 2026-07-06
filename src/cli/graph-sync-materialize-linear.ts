#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { GraphSyncReadOnlyDiffReceipt } from '../graph-sync-ledger.js';
import {
  applyGraphSyncMissingLinearBlockingRelations,
  type GraphSyncLiveLinearBlockingRelationApplyReceipt,
  type LinearRelationMutationClient,
} from '../graph-sync-materializer.js';
import { LinearIssueMutationClient } from '../tracker.js';
import { isDirectCliExecution } from './direct-execution.js';

export type GraphSyncLinearApplyTextWriter = (chunk: string) => void;

export interface GraphSyncLinearApplyClientFactoryContext {
  readonly apiKey: string;
}

export interface SymphonyGraphSyncLinearApplyCliOptions {
  readonly stdout?: GraphSyncLinearApplyTextWriter;
  readonly stderr?: GraphSyncLinearApplyTextWriter;
  readonly processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly linearClientFactory?: (
    context: GraphSyncLinearApplyClientFactoryContext,
  ) => Pick<LinearRelationMutationClient, 'createIssueRelation' | 'hasIssueRelation'>;
}

export interface GraphSyncLiveLinearBlockingRelationApplyArtifactSummary {
  readonly ok: boolean;
  readonly effect: 'graph_sync_live_linear_blocking_relation_apply_artifact';
  readonly mode: 'kanban_authoritative_apply';
  readonly input_path: string;
  readonly receipt_path: string;
  readonly approved_scope: string;
  readonly max_created_relations: number;
  readonly summary: GraphSyncLiveLinearBlockingRelationApplyReceipt['summary'];
  readonly created_relations: readonly GraphSyncLiveLinearBlockingRelationApplyReceipt['created_relations'][number][];
  readonly skipped_relations: readonly GraphSyncLiveLinearBlockingRelationApplyReceipt['skipped_relations'][number][];
  readonly actions: readonly string[];
  readonly non_actions: readonly string[];
}

interface ParsedGraphSyncLinearApplyFlags {
  readonly help: boolean;
  readonly allowLiveLinearApply: boolean;
  readonly mode?: 'kanban_authoritative_apply';
  readonly inputPath?: string;
  readonly outputPath?: string;
  readonly approvedScope?: string;
  readonly maxCreated?: number;
}

export async function runSymphonyGraphSyncLinearApplyCli(
  argv: readonly string[],
  options: SymphonyGraphSyncLinearApplyCliOptions = {},
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
    if (flags.mode !== 'kanban_authoritative_apply') {
      throw new Error('symphony-graph-sync-materialize-linear only supports --mode kanban_authoritative_apply');
    }
    const inputPath = requireFlag(flags.inputPath, '--input');
    const outputPath = requireFlag(flags.outputPath, '--output');
    if (!flags.allowLiveLinearApply) {
      throw new Error('--allow-live-linear-apply is required for live Linear relation writes');
    }
    const approvedScope = requireFlag(flags.approvedScope, '--approved-scope');
    const apiKey = env['LINEAR_API_KEY'];
    if (apiKey === undefined || apiKey.trim() === '') {
      throw new Error('LINEAR_API_KEY environment variable is required for live Linear relation writes');
    }
    const maxCreated = flags.maxCreated ?? 1;
    const sourceReceipt = JSON.parse(await readFile(inputPath, 'utf8')) as GraphSyncReadOnlyDiffReceipt;
    const linearClient = options.linearClientFactory?.({ apiKey })
      ?? new LinearIssueMutationClient({ apiKey });
    const receipt = await applyGraphSyncMissingLinearBlockingRelations({
      boundary: 'live_apply',
      receipt: sourceReceipt,
      linearClient,
      approvedScope,
      maxCreatedRelations: maxCreated,
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    stdout(`${JSON.stringify(buildArtifactSummary({
      inputPath,
      outputPath,
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
  readonly receipt: GraphSyncLiveLinearBlockingRelationApplyReceipt;
}): GraphSyncLiveLinearBlockingRelationApplyArtifactSummary {
  return {
    ok: input.receipt.ok,
    effect: 'graph_sync_live_linear_blocking_relation_apply_artifact',
    mode: input.receipt.mode,
    input_path: input.inputPath,
    receipt_path: input.outputPath,
    approved_scope: input.receipt.approved_scope,
    max_created_relations: input.receipt.safety.max_created_relations,
    summary: input.receipt.summary,
    created_relations: input.receipt.created_relations,
    skipped_relations: input.receipt.skipped_relations,
    actions: input.receipt.actions,
    non_actions: input.receipt.non_actions,
  };
}

function parseFlags(argv: readonly string[]): ParsedGraphSyncLinearApplyFlags {
  let help = false;
  let allowLiveLinearApply = false;
  let mode: 'kanban_authoritative_apply' | undefined;
  let inputPath: string | undefined;
  let outputPath: string | undefined;
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
    if (arg === '--allow-live-linear-apply') {
      allowLiveLinearApply = true;
      continue;
    }
    if (arg === '--mode') {
      const value = readFlagValue(argv, index, arg);
      if (value !== 'kanban_authoritative_apply') {
        throw new Error('symphony-graph-sync-materialize-linear only supports --mode kanban_authoritative_apply');
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
    allowLiveLinearApply,
    ...(mode === undefined ? {} : { mode }),
    ...(inputPath === undefined ? {} : { inputPath }),
    ...(outputPath === undefined ? {} : { outputPath }),
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
    'Usage: symphony-graph-sync-materialize-linear --mode kanban_authoritative_apply --input read-only-receipt.json --output linear-apply-receipt.json --approved-scope TEXT --allow-live-linear-apply',
    '',
    'Apply Kanban-authoritative missing Linear blocking relations from a local GraphSync read-only diff receipt.',
    'This command writes live Linear issue relations only when LINEAR_API_KEY is present in the environment and the explicit live-apply flag is present.',
    'It does not accept API keys as CLI arguments, mutate Hermes Kanban links, move Linear issue states, edit services/timers, or dispatch workers.',
    '',
    'Options:',
    '  --mode kanban_authoritative_apply  Required; the only supported apply mode',
    '  --input PATH                       Local graph-sync read_only_diff receipt JSON',
    '  --output PATH                      Local live-apply receipt artifact path to write',
    '  --approved-scope TEXT              Human-reviewed exact scope for this apply run',
    '  --max-created N                    Maximum Linear relations this run may create (default: 1)',
    '  --allow-live-linear-apply          Required noisy live Linear mutation flag',
    '  --help, -h                         Show this help text',
    '',
  ].join('\n');
}

if (isDirectCliExecution(import.meta.url)) {
  process.exitCode = await runSymphonyGraphSyncLinearApplyCli(process.argv.slice(2));
}
