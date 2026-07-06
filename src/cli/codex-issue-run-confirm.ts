#!/usr/bin/env node

import {
  buildCodexIssueRunOperatorConfirmation,
  CodexIssueRunError,
  type BuildCodexIssueRunOperatorConfirmationInput,
} from '../codex-issue-run.js';
import { formatStructuredLogLine } from '../observability.js';
import type { CodexRunnerConfig } from '../codex-runner.js';
import { isDirectCliExecution } from './direct-execution.js';

export type TextWriter = (chunk: string) => void;

interface ConfirmCliFlags {
  readonly workspace: string;
  readonly receiptDir: string;
  readonly issue: string;
  readonly title: string;
  readonly team?: string;
  readonly issueUrl?: string;
  readonly codexCommand: string;
  readonly schemaSource: string;
  readonly approvalMode: CodexRunnerConfig['approval']['mode'];
  readonly sandboxMode: string;
  readonly hooksWillRun: boolean;
}

export function runCodexIssueRunConfirmCli(
  argv: readonly string[],
  stdout: TextWriter = (chunk) => process.stdout.write(chunk),
  stderr: TextWriter = (chunk) => process.stderr.write(chunk),
): number {
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      stdout(usage());
      return 0;
    }
    const flags = parseConfirmFlags(argv);
    const packet = buildCodexIssueRunOperatorConfirmation(confirmInputFromFlags(flags));
    stdout(`${JSON.stringify(packet, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof CodexIssueRunError ? error.code : 'confirm_cli_error';
    stderr(`${formatStructuredLogLine({ level: 'error', event: 'codex_issue_run_confirm', outcome: 'failed', reason: message, code })}\n`);
    return 1;
  }
}

function confirmInputFromFlags(flags: ConfirmCliFlags): BuildCodexIssueRunOperatorConfirmationInput {
  return {
    workspacePath: flags.workspace,
    receiptDir: flags.receiptDir,
    issue: {
      identifier: flags.issue,
      title: flags.title,
      ...(flags.team === undefined ? {} : { team_key: flags.team }),
      ...(flags.issueUrl === undefined ? {} : { url: flags.issueUrl }),
    },
    workflow: {},
    promptTemplate: '',
    runnerConfig: {
      codex: { command: flags.codexCommand, readTimeoutMs: 1_000, turnTimeoutMs: 1_000 },
      protocol: { schemaSource: flags.schemaSource },
      approval: { mode: flags.approvalMode },
      sandbox: { mode: flags.sandboxMode },
      tools: { linearGraphql: { enabled: false } },
    },
    hooksWillRun: flags.hooksWillRun,
  };
}

const ALLOWED_CONFIRM_FLAGS = new Set([
  '--workspace',
  '--receipt-dir',
  '--issue',
  '--title',
  '--team',
  '--issue-url',
  '--codex-command',
  '--schema-source',
  '--approval-mode',
  '--sandbox-mode',
  '--hooks-will-run',
]);

function parseConfirmFlags(argv: readonly string[]): ConfirmCliFlags {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) break;
    if (!flag.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${flag}`);
    }
    if (!ALLOWED_CONFIRM_FLAGS.has(flag)) {
      throw new Error(`Unsupported flag ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}`);
    }
    values.set(flag, value);
    index += 1;
  }

  return {
    workspace: requiredFlag(values, '--workspace'),
    receiptDir: requiredFlag(values, '--receipt-dir'),
    issue: requiredFlag(values, '--issue'),
    title: requiredFlag(values, '--title'),
    ...optionalFlag(values, '--team', 'team'),
    ...optionalFlag(values, '--issue-url', 'issueUrl'),
    codexCommand: requiredFlag(values, '--codex-command'),
    schemaSource: requiredFlag(values, '--schema-source'),
    approvalMode: parseApprovalMode(requiredFlag(values, '--approval-mode')),
    sandboxMode: requiredFlag(values, '--sandbox-mode'),
    hooksWillRun: parseBooleanFlag(requiredFlag(values, '--hooks-will-run'), '--hooks-will-run'),
  };
}

function requiredFlag(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required flag ${flag}`);
  }
  return value;
}

function optionalFlag<TKey extends 'team' | 'issueUrl'>(
  values: ReadonlyMap<string, string>,
  flag: string,
  key: TKey,
): Partial<Record<TKey, string>> {
  const value = values.get(flag);
  if (value === undefined || value.trim().length === 0) return {};
  return { [key]: value } as Partial<Record<TKey, string>>;
}

function parseApprovalMode(value: string): CodexRunnerConfig['approval']['mode'] {
  if (value === 'fail' || value === 'auto_approve') return value;
  throw new Error(`Unsupported approval mode: ${value}`);
}

function parseBooleanFlag(value: string, flag: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Expected ${flag} to be true or false.`);
}

function usage(): string {
  return [
    'Usage: symphony-codex-issue-run-confirm --workspace <path> --receipt-dir <path> --issue <id> --title <title> --codex-command <command> --schema-source <source> --approval-mode fail --sandbox-mode <mode> --hooks-will-run true|false',
    '',
    'Prints a local operator-confirmation packet only. It does not start Codex, write receipts, create branches, mutate Linear, push, deploy, or restart services.',
    '',
  ].join('\n');
}

function main(): void {
  const exitCode = runCodexIssueRunConfirmCli(process.argv.slice(2));
  process.exit(exitCode);
}

if (isDirectCliExecution(import.meta.url)) {
  main();
}
