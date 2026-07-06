#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  buildCodexIssueRunOperatorConfirmation,
  CodexIssueRunError,
  runCodexIssueRunInEphemeralGitWorktree,
  type BuildCodexIssueRunOperatorConfirmationInput,
} from '../codex-issue-run.js';
import { formatStructuredLogLine } from '../observability.js';
import type { CodexRunnerConfig, WorkflowVariables } from '../codex-runner.js';
import { getEffectiveConfig, loadWorkflow, type EffectiveConfig } from '../workflow.js';
import { isDirectCliExecution } from './direct-execution.js';

export type TextWriter = (chunk: string) => void;

const execFileAsync = promisify(execFile);

interface IssueRunCliFlags {
  readonly sourceRepo: string;
  readonly receiptDir?: string;
  readonly tempRoot?: string;
  readonly artifactRoot?: string;
  readonly runId?: string;
  readonly issue: string;
  readonly title: string;
  readonly team?: string;
  readonly issueUrl?: string;
  readonly codexCommand?: string;
  readonly schemaSource: string;
  readonly approvalMode: CodexRunnerConfig['approval']['mode'];
  readonly sandboxMode: string;
  readonly hooksWillRun: boolean;
  readonly allowLiveCodexOpenaiCommand: boolean;
  readonly confirmationDigest?: string;
  readonly yes: boolean;
  readonly check: boolean;
  readonly printConfirmation: boolean;
  readonly workflow?: string;
}

interface IssueRunCliConfirmationGate {
  readonly confirmation_digest_algorithm: 'sha256-json-v1';
  readonly confirmation_digest: string;
  readonly live_command_detected: boolean;
  readonly live_command_default_blocked: boolean;
  readonly live_command_override_flag: '--allow-live-codex-openai-command';
  readonly confirmation_digest_flag: '--confirmation-digest';
  readonly temp_root: string | null;
  readonly receipt_path_deterministic: boolean;
  readonly required_for_live_execution: readonly string[];
}

type IssueRunCliConfirmationPacket = ReturnType<typeof buildCodexIssueRunOperatorConfirmation> & {
  readonly operator_confirmation: IssueRunCliConfirmationGate;
};

interface IssueRunCliContext {
  readonly runnerConfig: CodexRunnerConfig;
  readonly workflowVariables: WorkflowVariables;
  readonly promptTemplate: string;
}

interface IssueRunReadinessCheck {
  readonly effect: 'check_only';
  readonly ok: boolean;
  readonly checks: {
    readonly source_repo_git: boolean;
    readonly receipt_dir_writable: boolean;
    readonly temp_root_writable: boolean;
    readonly codex_would_spawn: false;
    readonly live_codex_or_openai: boolean;
    readonly live_command_override: boolean;
    readonly confirmation_digest_matches: boolean;
    readonly receipt_path_deterministic: boolean;
    readonly approval_mode_fail_closed: boolean;
    readonly derived_receipt_path_safe: boolean;
  };
}

const BOOLEAN_FLAGS = new Set(['--yes', '--check', '--print-confirmation', '--allow-live-codex-openai-command']);
const VALUE_FLAGS = new Set([
  '--source-repo',
  '--receipt-dir',
  '--temp-root',
  '--artifact-root',
  '--run-id',
  '--issue',
  '--title',
  '--team',
  '--issue-url',
  '--codex-command',
  '--schema-source',
  '--approval-mode',
  '--sandbox-mode',
  '--hooks-will-run',
  '--confirmation-digest',
  '--workflow',
]);

export async function runCodexIssueRunCli(
  argv: readonly string[],
  stdout: TextWriter = (chunk) => process.stdout.write(chunk),
  stderr: TextWriter = (chunk) => process.stderr.write(chunk),
): Promise<number> {
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      stdout(usage());
      return 0;
    }
    const flags = parseIssueRunFlags(argv);
    if (!flags.yes && !flags.check && !flags.printConfirmation) {
      throw new Error('symphony-codex-issue-run execution requires --yes, --check, or --print-confirmation.');
    }
    const context = await resolveCliContext(flags);
    if (flags.printConfirmation) {
      const packet = buildCliConfirmationPacket(flags, context);
      stdout(`${JSON.stringify(packet, null, 2)}\n`);
      return 0;
    }
    if (flags.check) {
      const check = await runReadinessCheck(flags, context);
      stdout(`${JSON.stringify(check, null, 2)}\n`);
      return check.ok ? 0 : 1;
    }
    const check = await runReadinessCheck(flags, context);
    if (!check.ok) {
      stdout(`${JSON.stringify(check, null, 2)}\n`);
      return 1;
    }
    const outcome = await runConfirmedIssueRun(flags, context);
    stdout(`${JSON.stringify(outcome, null, 2)}\n`);
    return outcome.status === 'pass' ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof CodexIssueRunError ? error.code : 'codex_issue_run_cli_error';
    stderr(`${formatStructuredLogLine({ level: 'error', event: 'codex_issue_run_cli', outcome: 'failed', reason: message, code })}\n`);
    return 1;
  }
}

function buildCliConfirmationPacket(
  flags: IssueRunCliFlags,
  context: IssueRunCliContext,
): IssueRunCliConfirmationPacket {
  const basePacket = buildCliConfirmationDigestBase(flags, context);
  return {
    ...basePacket,
    operator_confirmation: {
      ...basePacket.operator_confirmation,
      confirmation_digest_algorithm: 'sha256-json-v1',
      confirmation_digest: digestJson(basePacket),
    },
  };
}

function buildCliConfirmationDigestBase(flags: IssueRunCliFlags, context: IssueRunCliContext) {
  return {
    ...buildCodexIssueRunOperatorConfirmation(confirmInputFromFlags(flags, context)),
    operator_confirmation: {
      live_command_detected: isLiveCodexOrOpenaiCommand(context.runnerConfig.codex.command),
      live_command_default_blocked: true,
      live_command_override_flag: '--allow-live-codex-openai-command' as const,
      confirmation_digest_flag: '--confirmation-digest' as const,
      temp_root: flags.tempRoot === undefined ? null : resolve(flags.tempRoot),
      receipt_path_deterministic: isReceiptPathDeterministic(flags),
      required_for_live_execution: [
        '--allow-live-codex-openai-command',
        '--confirmation-digest',
        '<sha256 digest printed by --print-confirmation for the exact same inputs>',
      ] as const,
    },
  };
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function resolveCliContext(flags: IssueRunCliFlags): Promise<IssueRunCliContext> {
  const workflow = flags.workflow === undefined ? undefined : await loadWorkflow(flags.workflow);
  const effectiveConfig: EffectiveConfig | undefined = workflow === undefined ? undefined : getEffectiveConfig(workflow);
  return {
    runnerConfig: runnerConfigFromFlags(flags, effectiveConfig),
    workflowVariables: {},
    promptTemplate: workflow?.prompt_template ?? 'Issue {{issue.identifier}}: {{issue.title}}',
  };
}

async function runConfirmedIssueRun(flags: IssueRunCliFlags, context: IssueRunCliContext) {
  return runCodexIssueRunInEphemeralGitWorktree({
    sourceRepoPath: flags.sourceRepo,
    tempRoot: requiredConfiguredFlag(flags.tempRoot, '--temp-root'),
    receiptDir: await prepareReceiptDir(flags),
    issue: issueFromFlags(flags),
    workflow: context.workflowVariables,
    promptTemplate: context.promptTemplate,
    runnerConfig: context.runnerConfig,
  });
}

function confirmInputFromFlags(
  flags: IssueRunCliFlags,
  context: IssueRunCliContext,
): BuildCodexIssueRunOperatorConfirmationInput {
  return {
    workspacePath: flags.sourceRepo,
    receiptDir: resolveReceiptDir(flags),
    issue: issueFromFlags(flags),
    workflow: context.workflowVariables,
    promptTemplate: context.promptTemplate,
    runnerConfig: context.runnerConfig,
    hooksWillRun: flags.hooksWillRun,
  };
}

function issueFromFlags(flags: IssueRunCliFlags) {
  return {
    identifier: flags.issue,
    title: flags.title,
    ...(flags.team === undefined ? {} : { team_key: flags.team }),
    ...(flags.issueUrl === undefined ? {} : { url: flags.issueUrl }),
  };
}

function runnerConfigFromFlags(flags: IssueRunCliFlags, effectiveConfig?: EffectiveConfig): CodexRunnerConfig {
  const command = flags.codexCommand ?? effectiveConfig?.codex.command;
  if (command === undefined || command.trim().length === 0) {
    throw new Error('Missing required flag --codex-command or workflow codex.command');
  }
  return {
    codex: {
      command,
      readTimeoutMs: effectiveConfig?.codex.readTimeoutMs ?? 1_000,
      turnTimeoutMs: effectiveConfig?.codex.turnTimeoutMs ?? 1_000,
    },
    protocol: { schemaSource: flags.schemaSource },
    approval: { mode: flags.approvalMode },
    sandbox: { mode: flags.sandboxMode },
    tools: { linearGraphql: { enabled: false } },
  };
}

async function runReadinessCheck(flags: IssueRunCliFlags, context: IssueRunCliContext): Promise<IssueRunReadinessCheck> {
  const receiptPath = resolveReceiptCheckPath(flags);
  const tempRoot = requiredConfiguredFlag(flags.tempRoot, '--temp-root');
  const sourceRepoGit = await isGitWorkTree(flags.sourceRepo);
  const receiptDirWritable = flags.receiptDir === undefined
    ? await isWritableOrCreatablePath(receiptPath)
    : await isWritablePath(receiptPath);
  const tempRootWritable = await isWritablePath(tempRoot);
  const liveCodexOrOpenai = isLiveCodexOrOpenaiCommand(context.runnerConfig.codex.command);
  const receiptPathDeterministic = isReceiptPathDeterministic(flags);
  const approvalModeFailClosed = flags.approvalMode === 'fail';
  const derivedReceiptPathSafe = isDerivedReceiptPathSafe(flags);
  const shouldCompareConfirmationDigest = liveCodexOrOpenai
    && flags.allowLiveCodexOpenaiCommand
    && flags.confirmationDigest !== undefined
    && receiptPathDeterministic
    && approvalModeFailClosed
    && derivedReceiptPathSafe;
  const confirmationDigestMatches = shouldCompareConfirmationDigest
    ? flags.confirmationDigest === digestJson(buildCliConfirmationDigestBase(flags, context))
    : false;
  const liveCommandGateOk = !liveCodexOrOpenai
    || (flags.allowLiveCodexOpenaiCommand && receiptPathDeterministic && confirmationDigestMatches);
  return {
    effect: 'check_only',
    ok: sourceRepoGit && receiptDirWritable && tempRootWritable && liveCommandGateOk && approvalModeFailClosed && derivedReceiptPathSafe,
    checks: {
      source_repo_git: sourceRepoGit,
      receipt_dir_writable: receiptDirWritable,
      temp_root_writable: tempRootWritable,
      codex_would_spawn: false,
      live_codex_or_openai: liveCodexOrOpenai,
      live_command_override: flags.allowLiveCodexOpenaiCommand,
      confirmation_digest_matches: confirmationDigestMatches,
      receipt_path_deterministic: receiptPathDeterministic,
      approval_mode_fail_closed: approvalModeFailClosed,
      derived_receipt_path_safe: derivedReceiptPathSafe,
    },
  };
}

function isLiveCodexOrOpenaiCommand(command: string): boolean {
  return /(?:^|[^a-z0-9])(?:codex|openai)(?:[^a-z0-9]|$)/i.test(command);
}

async function isGitWorkTree(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function isWritablePath(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function isWritableOrCreatablePath(path: string): Promise<boolean> {
  let cursor = resolve(path);
  let previous = '';
  while (cursor !== previous) {
    try {
      await access(cursor, constants.F_OK);
      return await isWritablePath(cursor);
    } catch {
      previous = cursor;
      cursor = dirname(cursor);
    }
  }
  return false;
}

function resolveReceiptDir(flags: IssueRunCliFlags): string {
  if (flags.receiptDir !== undefined) {
    return resolve(flags.receiptDir);
  }
  const artifactRoot = resolve(defaultArtifactRoot(flags));
  const runId = safePathSegment(flags.runId ?? timestampRunId(new Date()), '--run-id');
  const issue = safePathSegment(flags.issue, '--issue');
  return join(artifactRoot, `${runId}-${issue}`);
}

function resolveReceiptCheckPath(flags: IssueRunCliFlags): string {
  if (flags.receiptDir !== undefined) {
    return resolve(flags.receiptDir);
  }
  return resolve(defaultArtifactRoot(flags));
}

async function prepareReceiptDir(flags: IssueRunCliFlags): Promise<string> {
  if (flags.receiptDir !== undefined) {
    return resolve(flags.receiptDir);
  }
  const artifactRoot = resolve(defaultArtifactRoot(flags));
  await mkdir(artifactRoot, { recursive: true });
  const receiptDir = resolveReceiptDir(flags);
  await mkdir(receiptDir, { recursive: false });
  return receiptDir;
}

function defaultArtifactRoot(flags: IssueRunCliFlags): string {
  return flags.artifactRoot ?? join(homedir(), '.local', 'state', 'symphony-ts', 'operator-runs');
}

function safePathSegment(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes('..')) {
    throw new Error(`Unsafe ${field} path segment: ${value}`);
  }
  return value;
}

function isDerivedReceiptPathSafe(flags: IssueRunCliFlags): boolean {
  if (flags.receiptDir !== undefined) return true;
  try {
    safePathSegment(flags.runId ?? timestampRunId(new Date()), '--run-id');
    safePathSegment(flags.issue, '--issue');
    return true;
  } catch {
    return false;
  }
}

function isReceiptPathDeterministic(flags: IssueRunCliFlags): boolean {
  return flags.receiptDir !== undefined || flags.runId !== undefined;
}

function timestampRunId(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

function requiredConfiguredFlag(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required flag ${flag}`);
  }
  return value;
}

function parseIssueRunFlags(argv: readonly string[]): IssueRunCliFlags {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) break;
    if (!flag.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${flag}`);
    }
    if (BOOLEAN_FLAGS.has(flag)) {
      booleans.add(flag);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
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
    sourceRepo: requiredFlag(values, '--source-repo'),
    ...optionalFlag(values, '--receipt-dir', 'receiptDir'),
    ...optionalFlag(values, '--temp-root', 'tempRoot'),
    ...optionalFlag(values, '--artifact-root', 'artifactRoot'),
    ...optionalFlag(values, '--run-id', 'runId'),
    issue: requiredFlag(values, '--issue'),
    title: requiredFlag(values, '--title'),
    ...optionalFlag(values, '--team', 'team'),
    ...optionalFlag(values, '--issue-url', 'issueUrl'),
    ...optionalFlag(values, '--codex-command', 'codexCommand'),
    schemaSource: requiredFlag(values, '--schema-source'),
    approvalMode: parseApprovalMode(requiredFlag(values, '--approval-mode')),
    sandboxMode: requiredFlag(values, '--sandbox-mode'),
    hooksWillRun: parseBooleanFlag(requiredFlag(values, '--hooks-will-run'), '--hooks-will-run'),
    allowLiveCodexOpenaiCommand: booleans.has('--allow-live-codex-openai-command'),
    ...optionalFlag(values, '--confirmation-digest', 'confirmationDigest'),
    yes: booleans.has('--yes'),
    check: booleans.has('--check'),
    printConfirmation: booleans.has('--print-confirmation'),
    ...optionalFlag(values, '--workflow', 'workflow'),
  };
}

function requiredFlag(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required flag ${flag}`);
  }
  return value;
}

function optionalFlag<
  TKey extends 'receiptDir' | 'tempRoot' | 'artifactRoot' | 'runId' | 'team' | 'issueUrl' | 'codexCommand' | 'confirmationDigest' | 'workflow',
>(
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
    'Usage: symphony-codex-issue-run --source-repo <path> --issue <id> --title <title> (--codex-command <command>|--workflow WORKFLOW.md) --schema-source <source> --approval-mode fail --sandbox-mode <mode> --hooks-will-run true|false (--check|--print-confirmation|--yes)',
    '',
    'Runs one local operator-confirmed issue-run only when --yes is present. --check and --print-confirmation are no-side-effect modes.',
    'Commands that look like live Codex/OpenAI fail closed unless --allow-live-codex-openai-command and a matching --confirmation-digest from --print-confirmation are both provided.',
    'Use --receipt-dir <path> for an exact receipt directory, or --artifact-root <path> [--run-id <safe-id>] to derive <run-id>-<issue>.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const exitCode = await runCodexIssueRunCli(process.argv.slice(2));
  process.exit(exitCode);
}

if (isDirectCliExecution(import.meta.url)) {
  void main();
}
