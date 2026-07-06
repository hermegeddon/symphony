#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  CodexPatchPromotionError,
  codexPatchPromotionWorktreeDirectoryName,
  isSafeCodexPatchPromotionBranchName,
  promoteCodexIssueRunPatch,
  type CodexPatchPromotionVerificationCommand,
} from '../codex-patch-promotion.js';
import { formatStructuredLogLine } from '../observability.js';
import { isDirectCliExecution } from './direct-execution.js';

export type TextWriter = (chunk: string) => void;

const execFileAsync = promisify(execFile);

interface PatchPromotionCliFlags {
  readonly sourceRepo: string;
  readonly patchPath: string;
  readonly receiptDir: string;
  readonly tempRoot: string;
  readonly branchName: string;
  readonly commitMessage: string;
  readonly verificationCommands: readonly CodexPatchPromotionVerificationCommand[];
  readonly baseRef?: string;
  readonly yes: boolean;
  readonly check: boolean;
}

interface PatchPromotionReadinessCheck {
  readonly effect: 'check_only';
  readonly ok: boolean;
  readonly checks: {
    readonly source_repo_git: boolean;
    readonly source_repo_clean: boolean;
    readonly patch_readable: boolean;
    readonly receipt_dir_writable: boolean;
    readonly temp_root_writable: boolean;
    readonly branch_name_safe: boolean;
    readonly branch_available: boolean;
    readonly promotion_worktree_available: boolean;
    readonly verification_commands_present: boolean;
    readonly promotion_would_apply_patch: false;
    readonly promotion_would_commit: false;
  };
}

const BOOLEAN_FLAGS = new Set(['--yes', '--check']);
const VALUE_FLAGS = new Set([
  '--source-repo',
  '--patch-path',
  '--receipt-dir',
  '--temp-root',
  '--branch-name',
  '--commit-message',
  '--verification-command-json',
  '--base-ref',
]);

export async function runCodexPatchPromotionCli(
  argv: readonly string[],
  stdout: TextWriter = (chunk) => process.stdout.write(chunk),
  stderr: TextWriter = (chunk) => process.stderr.write(chunk),
): Promise<number> {
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      stdout(usage());
      return 0;
    }
    const flags = parsePatchPromotionFlags(argv);
    if (!flags.yes && !flags.check) {
      throw new Error('symphony-codex-promote-patch execution requires --yes or --check.');
    }
    const check = await runPatchPromotionReadinessCheck(flags);
    if (flags.check) {
      stdout(`${JSON.stringify(check, null, 2)}\n`);
      return check.ok ? 0 : 1;
    }
    if (!check.ok) {
      stdout(`${JSON.stringify(check, null, 2)}\n`);
      return 1;
    }
    const outcome = await promoteCodexIssueRunPatch({
      sourceRepoPath: flags.sourceRepo,
      patchPath: flags.patchPath,
      receiptDir: flags.receiptDir,
      tempRoot: flags.tempRoot,
      branchName: flags.branchName,
      commitMessage: flags.commitMessage,
      verificationCommands: flags.verificationCommands,
      ...(flags.baseRef === undefined ? {} : { baseRef: flags.baseRef }),
    });
    stdout(`${JSON.stringify(outcome, null, 2)}\n`);
    return outcome.status === 'pass' ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof CodexPatchPromotionError ? error.code : 'codex_patch_promotion_cli_error';
    stderr(`${formatStructuredLogLine({ level: 'error', event: 'codex_patch_promotion_cli', outcome: 'failed', reason: message, code })}\n`);
    return 1;
  }
}

async function runPatchPromotionReadinessCheck(flags: PatchPromotionCliFlags): Promise<PatchPromotionReadinessCheck> {
  const sourceRepoGit = await isGitWorkTree(flags.sourceRepo);
  const sourceRepoClean = sourceRepoGit ? await isCleanGitWorkTree(flags.sourceRepo) : false;
  const patchReadable = await isReadablePath(flags.patchPath);
  const receiptDirWritable = await isWritableOrCreatableDirectoryPath(flags.receiptDir);
  const tempRootWritable = await isWritableDirectoryPath(flags.tempRoot);
  const branchNameSafe = isSafeCodexPatchPromotionBranchName(flags.branchName);
  const branchAvailable = sourceRepoGit && branchNameSafe ? await isLocalBranchAvailable(flags.sourceRepo, flags.branchName) : false;
  const promotionWorktreeAvailable = await pathDoesNotExist(join(flags.tempRoot, codexPatchPromotionWorktreeDirectoryName(flags.branchName)));
  const verificationCommandsPresent = flags.verificationCommands.length > 0;
  return {
    effect: 'check_only',
    ok: sourceRepoGit
      && sourceRepoClean
      && patchReadable
      && receiptDirWritable
      && tempRootWritable
      && branchNameSafe
      && branchAvailable
      && promotionWorktreeAvailable
      && verificationCommandsPresent,
    checks: {
      source_repo_git: sourceRepoGit,
      source_repo_clean: sourceRepoClean,
      patch_readable: patchReadable,
      receipt_dir_writable: receiptDirWritable,
      temp_root_writable: tempRootWritable,
      branch_name_safe: branchNameSafe,
      branch_available: branchAvailable,
      promotion_worktree_available: promotionWorktreeAvailable,
      verification_commands_present: verificationCommandsPresent,
      promotion_would_apply_patch: false,
      promotion_would_commit: false,
    },
  };
}

async function isGitWorkTree(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function isCleanGitWorkTree(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'status', '--porcelain=v1']);
    return stdout.length === 0;
  } catch {
    return false;
  }
}

async function isLocalBranchAvailable(path: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`]);
    return false;
  } catch (error) {
    const maybeExit = error as { readonly code?: unknown };
    return maybeExit.code === 1;
  }
}

async function pathDoesNotExist(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return false;
  } catch (error) {
    return hasErrorCode(error, 'ENOENT');
  }
}

async function isReadablePath(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function isWritableDirectoryPath(path: string): Promise<boolean> {
  try {
    const pathStat = await stat(path);
    if (!pathStat.isDirectory()) return false;
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function isWritableOrCreatableDirectoryPath(path: string): Promise<boolean> {
  let cursor = resolve(path);
  let previous = '';
  while (cursor !== previous) {
    try {
      const cursorStat = await stat(cursor);
      if (!cursorStat.isDirectory()) return false;
      return await isWritableDirectoryPath(cursor);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) return false;
      previous = cursor;
      cursor = dirname(cursor);
    }
  }
  return false;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { readonly code?: unknown }).code === code;
}

function parsePatchPromotionFlags(argv: readonly string[]): PatchPromotionCliFlags {
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
    sourceRepo: resolve(requiredFlag(values, '--source-repo')),
    patchPath: resolve(requiredFlag(values, '--patch-path')),
    receiptDir: resolve(requiredFlag(values, '--receipt-dir')),
    tempRoot: resolve(requiredFlag(values, '--temp-root')),
    branchName: requiredFlag(values, '--branch-name'),
    commitMessage: requiredFlag(values, '--commit-message'),
    verificationCommands: parseVerificationCommands(requiredFlag(values, '--verification-command-json')),
    ...optionalFlag(values, '--base-ref', 'baseRef'),
    yes: booleans.has('--yes'),
    check: booleans.has('--check'),
  };
}

function parseVerificationCommands(value: string): readonly CodexPatchPromotionVerificationCommand[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('--verification-command-json must be a JSON array.');
  }
  return parsed.map((entry, index) => parseVerificationCommandEntry(entry, index));
}

function parseVerificationCommandEntry(entry: unknown, index: number): CodexPatchPromotionVerificationCommand {
  if (entry === null || typeof entry !== 'object') {
    throw new Error(`Verification command ${String(index + 1)} must be an object.`);
  }
  const record = entry as Record<string, unknown>;
  const command = record['command'];
  const rawArgs = record['args'];
  const rawName = record['name'];
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error(`Verification command ${String(index + 1)} requires a non-empty command string.`);
  }
  if (rawArgs !== undefined && !isStringArray(rawArgs)) {
    throw new Error(`Verification command ${String(index + 1)} args must be an array of strings.`);
  }
  if (rawName !== undefined && typeof rawName !== 'string') {
    throw new Error(`Verification command ${String(index + 1)} name must be a string.`);
  }
  const args: readonly string[] = isStringArray(rawArgs) ? rawArgs : [];
  const name: string | undefined = typeof rawName === 'string' ? rawName : undefined;
  return {
    ...(name === undefined ? {} : { name }),
    command,
    args,
  };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function requiredFlag(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required flag ${flag}`);
  }
  return value;
}

function optionalFlag<TKey extends 'baseRef'>(
  values: ReadonlyMap<string, string>,
  flag: string,
  key: TKey,
): Partial<Record<TKey, string>> {
  const value = values.get(flag);
  if (value === undefined || value.trim().length === 0) return {};
  return { [key]: value } as Partial<Record<TKey, string>>;
}

function usage(): string {
  return [
    'Usage: symphony-codex-promote-patch --source-repo <path> --patch-path <codex-issue-run-worktree.patch> --receipt-dir <path> --temp-root <path> --branch-name <local-branch> --commit-message <message> --verification-command-json <json-array> (--check|--yes)',
    '',
    'Promotes one existing Codex issue-run patch into a fresh local branch/worktree and commits only after local verification passes.',
    '--check is no-side-effect: it does not apply the patch, create a branch, commit, push, create PRs, mutate Linear, deploy, restart services, or broad-dispatch.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const exitCode = await runCodexPatchPromotionCli(process.argv.slice(2));
  process.exit(exitCode);
}

if (isDirectCliExecution(import.meta.url)) {
  void main();
}
