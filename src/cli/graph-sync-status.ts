#!/usr/bin/env node
import { join, resolve } from 'node:path';

import { evaluateGraphSyncStatus, type GraphSyncWatchdogStatus } from '../graph-sync-status.js';
import { isDirectCliExecution } from './direct-execution.js';

export type GraphSyncStatusTextWriter = (chunk: string) => void;

export interface GraphSyncStatusCliOptions {
  readonly stdout?: GraphSyncStatusTextWriter | undefined;
  readonly stderr?: GraphSyncStatusTextWriter | undefined;
  readonly now?: Date | undefined;
}

interface ParsedGraphSyncStatusFlags {
  readonly help: boolean;
  readonly serviceRoot?: string | undefined;
  readonly lastRunPath?: string | undefined;
  readonly maxAgeMs?: number | undefined;
}

export async function runSymphonyGraphSyncStatusCli(
  argv: readonly string[],
  options: GraphSyncStatusCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = options.stderr ?? ((chunk: string) => process.stderr.write(chunk));

  try {
    const flags = parseFlags(argv);
    if (flags.help) {
      stdout(usage());
      return 0;
    }
    const lastRunPath = resolveLastRunPath(flags);
    const artifact = await evaluateGraphSyncStatus({
      lastRunPath,
      ...(flags.maxAgeMs === undefined ? {} : { maxAgeMs: flags.maxAgeMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    stdout(`${JSON.stringify(artifact, null, 2)}\n`);
    return exitCodeForStatus(artifact.status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`${JSON.stringify({ ok: false, status: 'BLOCK', error: redactForCli(message) }, null, 2)}\n`);
    return 1;
  }
}

function parseFlags(argv: readonly string[]): ParsedGraphSyncStatusFlags {
  let help = false;
  let serviceRoot: string | undefined;
  let lastRunPath: string | undefined;
  let maxAgeMs: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--service-root') {
      serviceRoot = resolve(readFlagValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--last-run') {
      lastRunPath = resolve(readFlagValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--max-age-ms') {
      maxAgeMs = parsePositiveInteger(readFlagValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    help,
    ...(serviceRoot === undefined ? {} : { serviceRoot }),
    ...(lastRunPath === undefined ? {} : { lastRunPath }),
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
  };
}

function resolveLastRunPath(flags: ParsedGraphSyncStatusFlags): string {
  if (flags.lastRunPath !== undefined && flags.serviceRoot !== undefined) {
    throw new Error('Use only one of --last-run or --service-root');
  }
  if (flags.lastRunPath !== undefined) {
    return flags.lastRunPath;
  }
  if (flags.serviceRoot !== undefined) {
    return join(flags.serviceRoot, 'last-run.json');
  }
  throw new Error('--service-root or --last-run is required');
}

function exitCodeForStatus(status: GraphSyncWatchdogStatus): number {
  if (status === 'PASS') {
    return 0;
  }
  if (status === 'REVIEW') {
    return 2;
  }
  return 3;
}

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function redactForCli(value: string): string {
  return value
    .replace(/lin_api_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]');
}

function usage(): string {
  return [
    'Usage: symphony-graph-sync-status --service-root DIR [--max-age-ms N]',
    '',
    'Read the latest recurring GraphSync read-only snapshot wrapper and emit a local status/watchdog artifact.',
    'This command does not mutate Linear, Kanban, services/timers, or dispatch workers.',
    '',
    'Options:',
    '  --service-root DIR  Recurring GraphSync service root containing last-run.json',
    '  --last-run PATH     Explicit last-run.json path instead of --service-root',
    '  --max-age-ms N      Mark the latest run BLOCK/stale when older than N milliseconds',
    '  --help, -h          Show this help text',
    '',
  ].join('\n');
}

if (isDirectCliExecution(import.meta.url)) {
  process.exitCode = await runSymphonyGraphSyncStatusCli(process.argv.slice(2));
}
