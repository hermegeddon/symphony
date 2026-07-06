#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { HermesKanbanCliClient } from '../kanban-client.js';
import {
  KANBAN_CANARY_TASK_KEYS,
  isTaskKey,
  redactReceiptText,
  runKanbanCanaryOperator,
  type KanbanCanaryMode,
  type KanbanCanaryOperatorInput,
  type KanbanCanaryOperatorReceipt,
  type KanbanCanaryTaskKey,
} from '../kanban-canary-operator.js';
import type { KanbanClient } from '../kanban-types.js';
import { isDirectCliExecution } from './direct-execution.js';

export type TextWriter = (chunk: string) => void;

export interface KanbanCanaryCliClientContext {
  readonly hermesCommand: string;
  readonly board: string;
  readonly hermesHome: string;
  readonly path: string;
}

export interface SymphonyKanbanCanaryCliOptions {
  readonly stdout?: TextWriter;
  readonly stderr?: TextWriter;
  readonly processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly processArgv?: readonly string[];
  readonly clientFactory?: ((context: KanbanCanaryCliClientContext) => Pick<KanbanClient, 'boardShow' | 'listTasks' | 'createTask' | 'showTask' | 'dispatchDryRun'>) | undefined;
}

interface ParsedLinearKanbanMetadataFlags {
  readonly teamKey?: string | undefined;
  readonly teamName?: string | undefined;
  readonly projectId?: string | undefined;
  readonly projectName?: string | undefined;
  readonly projectUrl?: string | undefined;
  readonly issueIdentifier?: string | undefined;
  readonly issueTitle?: string | undefined;
  readonly issueUrl?: string | undefined;
}

type MutableLinearKanbanMetadataFlags = {
  -readonly [Key in keyof ParsedLinearKanbanMetadataFlags]: ParsedLinearKanbanMetadataFlags[Key];
};

interface ParsedKanbanCanaryFlags {
  readonly help: boolean;
  readonly mode?: KanbanCanaryMode | undefined;
  readonly board?: string | undefined;
  readonly workflowId?: string | undefined;
  readonly artifactRoot?: string | undefined;
  readonly hermesCommand?: string | undefined;
  readonly hermesHome?: string | undefined;
  readonly receiptPath?: string | undefined;
  readonly linear: ParsedLinearKanbanMetadataFlags;
  readonly taskIds: Partial<Record<KanbanCanaryTaskKey, string>>;
}

export async function runSymphonyKanbanCanaryCli(
  argv: readonly string[],
  options: SymphonyKanbanCanaryCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = options.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const env = options.processEnv ?? process.env;
  const processArgv = options.processArgv ?? ['symphony-kanban-canary'];

  try {
    const flags = parseFlags(argv);
    if (flags.help) {
      stdout(usage());
      return 0;
    }
    const input = buildOperatorInput(flags, argv, processArgv, env, options.clientFactory);
    let receipt = await runKanbanCanaryOperator(input);
    if (flags.receiptPath !== undefined) {
      receipt = await writeReceiptArtifacts(receipt, flags.receiptPath);
    }
    stdout(`${JSON.stringify(receipt, null, 2)}\n`);
    return receipt.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`${JSON.stringify({ ok: false, status: 'BLOCK', error: redactReceiptText(message) }, null, 2)}\n`);
    return 1;
  }
}

function buildOperatorInput(
  flags: ParsedKanbanCanaryFlags,
  argv: readonly string[],
  processArgv: readonly string[],
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  clientFactory: SymphonyKanbanCanaryCliOptions['clientFactory'],
): KanbanCanaryOperatorInput {
  const mode = requiredMode(flags.mode);
  const board = requiredString(flags.board, '--board');
  const workflowId = requiredString(flags.workflowId, '--workflow-id');
  const artifactRoot = requiredString(flags.artifactRoot, '--artifact-root');
  const hermesCommand = flags.hermesCommand ?? env['SYMPHONY_KANBAN_HERMES_COMMAND'] ?? 'hermes';
  const hermesHome = flags.hermesHome ?? env['HERMES_HOME'] ?? `${homedir()}/.hermes`;
  const path = env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin';
  const clientContext = { hermesCommand, board, hermesHome, path };
  const client = clientFactory?.(clientContext) ?? new HermesKanbanCliClient({
    command: hermesCommand,
    board,
    hermesHome,
    path,
  });
  const taskIds = Object.keys(flags.taskIds).length === 0 ? undefined : flags.taskIds;

  return {
    client,
    mode,
    workflowId,
    artifactRoot,
    command: { argv: [...processArgv, ...argv] },
    linear: {
      teamKey: requiredString(flags.linear.teamKey, '--linear-team-key'),
      ...(flags.linear.teamName === undefined ? {} : { teamName: flags.linear.teamName }),
      projectId: requiredString(flags.linear.projectId, '--linear-project-id'),
      projectName: requiredString(flags.linear.projectName, '--linear-project-name'),
      ...(flags.linear.projectUrl === undefined ? {} : { projectUrl: flags.linear.projectUrl }),
      issueIdentifier: requiredString(flags.linear.issueIdentifier, '--linear-issue-identifier'),
      issueTitle: requiredString(flags.linear.issueTitle, '--linear-issue-title'),
      ...(flags.linear.issueUrl === undefined ? {} : { issueUrl: flags.linear.issueUrl }),
    },
    kanban: { board },
    ...(taskIds === undefined ? {} : { existingTaskIds: taskIds }),
  };
}

function requiredMode(value: KanbanCanaryMode | undefined): KanbanCanaryMode {
  if (value === undefined) {
    throw new Error('--mode is required');
  }
  return value;
}

function requiredString(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${flag} is required`);
  }
  return value;
}

function parseFlags(argv: readonly string[]): ParsedKanbanCanaryFlags {
  let help = false;
  let mode: KanbanCanaryMode | undefined;
  let board: string | undefined;
  let workflowId: string | undefined;
  let artifactRoot: string | undefined;
  let hermesCommand: string | undefined;
  let hermesHome: string | undefined;
  let receiptPath: string | undefined;
  const taskIds: Partial<Record<KanbanCanaryTaskKey, string>> = {};
  const linear: MutableLinearKanbanMetadataFlags = {};

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
      mode = parseMode(value);
      index += 1;
      continue;
    }
    if (arg === '--board') {
      board = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--workflow-id') {
      workflowId = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--artifact-root') {
      artifactRoot = readFlagValue(argv, index, arg);
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
    if (arg === '--receipt-path') {
      receiptPath = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--linear-team-key') {
      linear.teamKey = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--linear-team-name') {
      linear.teamName = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--linear-project-id') {
      linear.projectId = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--linear-project-name') {
      linear.projectName = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--linear-project-url') {
      linear.projectUrl = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--linear-issue-identifier') {
      linear.issueIdentifier = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--linear-issue-title') {
      linear.issueTitle = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--linear-issue-url') {
      linear.issueUrl = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--task-id') {
      const value = readFlagValue(argv, index, arg);
      const parsed = parseTaskIdFlag(value);
      taskIds[parsed.key] = parsed.id;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    help,
    ...(mode === undefined ? {} : { mode }),
    ...(board === undefined ? {} : { board }),
    ...(workflowId === undefined ? {} : { workflowId }),
    ...(artifactRoot === undefined ? {} : { artifactRoot }),
    ...(hermesCommand === undefined ? {} : { hermesCommand }),
    ...(hermesHome === undefined ? {} : { hermesHome }),
    ...(receiptPath === undefined ? {} : { receiptPath }),
    linear,
    taskIds,
  };
}

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseMode(value: string): KanbanCanaryMode {
  if (value === 'readback-only' || value === 'materialize-if-missing') {
    return value;
  }
  throw new Error(`Unsupported --mode: ${value}`);
}

function parseTaskIdFlag(value: string): { readonly key: KanbanCanaryTaskKey; readonly id: string } {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('--task-id must have the form K0=t_xxx');
  }
  const key = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!isTaskKey(key)) {
    throw new Error(`--task-id key must be one of ${KANBAN_CANARY_TASK_KEYS.join(', ')}`);
  }
  return { key, id };
}

async function writeReceiptArtifacts(
  receipt: KanbanCanaryOperatorReceipt,
  receiptPath: string,
): Promise<KanbanCanaryOperatorReceipt> {
  const manifestPath = `${receiptPath}.manifest.json`;
  await mkdir(dirname(receiptPath), { recursive: true });
  const receiptForHash: KanbanCanaryOperatorReceipt = {
    ...receipt,
    artifacts: {
      ...receipt.artifacts,
      receipt_path: receiptPath,
      manifest_path: manifestPath,
    },
    hash_manifest: {
      algorithm: 'sha256',
      hash_scope: 'receipt_without_hash_manifest',
      artifacts: [],
    },
  };
  const canonicalReceiptJson = `${JSON.stringify(receiptForHash, null, 2)}\n`;
  const receiptHash = sha256Hex(canonicalReceiptJson);
  const finalReceipt: KanbanCanaryOperatorReceipt = {
    ...receiptForHash,
    hash_manifest: {
      algorithm: 'sha256',
      hash_scope: 'receipt_without_hash_manifest',
      artifacts: [
        {
          path: receiptPath,
          sha256: receiptHash,
          bytes: Buffer.byteLength(canonicalReceiptJson, 'utf8'),
        },
      ],
    },
  };
  const finalReceiptJson = `${JSON.stringify(finalReceipt, null, 2)}\n`;
  const manifest = {
    algorithm: 'sha256' as const,
    hash_scope: 'receipt_without_hash_manifest' as const,
    artifacts: finalReceipt.hash_manifest.artifacts,
  };
  await writeFile(receiptPath, finalReceiptJson, 'utf8');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return finalReceipt;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function usage(): string {
  return [
    'Usage: symphony-kanban-canary --mode <readback-only|materialize-if-missing> --board <slug> --workflow-id <id> --artifact-root <path> [options]',
    '',
    'Operator-facing Symphony → Hermes Kanban no-worker canary CLI.',
    'Modes:',
    '  readback-only             Re-read an existing K0 -> K1 -> K2 no-worker graph and fail closed if any invariant drifts.',
    '  materialize-if-missing    Create only missing approved no-worker cards, then validate entirely from readback.',
    '',
    'Required Linear metadata:',
    '  --linear-team-key <key>',
    '  --linear-project-id <id>',
    '  --linear-project-name <name>',
    '  --linear-issue-identifier <identifier>',
    '  --linear-issue-title <title>',
    '',
    'Optional:',
    '  --linear-team-name <name>',
    '  --linear-project-url <url>',
    '  --linear-issue-url <url>',
    '  --task-id K0=t_x --task-id K1=t_y --task-id K2=t_z',
    '  --receipt-path <path>',
    '  --hermes-command <command>     default: $SYMPHONY_KANBAN_HERMES_COMMAND or hermes',
    '  --hermes-home <path>           default: $HERMES_HOME or ~/.hermes',
    '',
    'The CLI never performs real worker/gateway dispatch. It only calls Hermes Kanban read/list/show/create for approved no-worker materialization and dispatch --dry-run --max 1 --json.',
    '',
  ].join('\n');
}

if (isDirectCliExecution(import.meta.url)) {
  void runSymphonyKanbanCanaryCli(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  });
}
