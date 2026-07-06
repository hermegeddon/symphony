import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface CodexPatchPromotionVerificationCommand {
  readonly name?: string;
  readonly command: string;
  readonly args?: readonly string[];
}

export interface PromoteCodexIssueRunPatchInput {
  readonly sourceRepoPath: string;
  readonly patchPath: string;
  readonly receiptDir: string;
  readonly branchName: string;
  readonly commitMessage: string;
  readonly verificationCommands: readonly CodexPatchPromotionVerificationCommand[];
  readonly tempRoot?: string;
  readonly baseRef?: string;
  readonly gitCommand?: string;
}

export interface CodexPatchPromotionVerificationResult {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly ok: boolean;
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CodexPatchPromotionArtifacts {
  readonly outcome: string;
  readonly patch: string;
  readonly status: string;
  readonly summary: string;
  readonly manifest: string;
}

export interface CodexPatchPromotionOutcome {
  readonly status: 'pass' | 'fail';
  readonly source_repo_path: string;
  readonly patch_path: string;
  readonly receipt_dir: string;
  readonly branch_name: string;
  readonly base_ref: string;
  readonly worktree_path: string;
  readonly commit_sha: string | null;
  readonly verification: readonly CodexPatchPromotionVerificationResult[];
  readonly artifacts: CodexPatchPromotionArtifacts;
  readonly non_actions: {
    readonly git_push_authorized: false;
    readonly pull_request_created: false;
    readonly linear_mutation_authorized: false;
    readonly deploy_authorized: false;
    readonly service_restart_authorized: false;
    readonly broad_dispatch_authorized: false;
  };
}

export class CodexPatchPromotionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CodexPatchPromotionError';
  }
}

interface CommandResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export async function promoteCodexIssueRunPatch(
  input: PromoteCodexIssueRunPatchInput,
): Promise<CodexPatchPromotionOutcome> {
  validatePromotionInput(input);
  const sourceRepoPath = resolve(input.sourceRepoPath);
  const patchPath = resolve(input.patchPath);
  const receiptDir = resolve(input.receiptDir);
  const baseRef = input.baseRef ?? 'HEAD';
  const gitCommand = input.gitCommand ?? 'git';

  await assertReadablePatch(patchPath);
  await assertGitWorkTree({ gitCommand, sourceRepoPath });
  await assertCleanSourceRepo({ gitCommand, sourceRepoPath });
  const baseCommit = (await runGitCaptureCommand({
    gitCommand,
    cwd: sourceRepoPath,
    args: ['rev-parse', baseRef],
    errorCode: 'promotion_base_ref_read_failed',
    errorMessage: 'Failed to resolve promotion base ref before branch creation.',
  })).trim();

  const tempRoot = resolve(input.tempRoot ?? join(sourceRepoPath, '..'));
  const worktreePath = join(tempRoot, codexPatchPromotionWorktreeDirectoryName(input.branchName));
  await assertLocalBranchDoesNotExist({ gitCommand, sourceRepoPath, branchName: input.branchName });
  await assertPathDoesNotExist(worktreePath, 'promotion_worktree_exists', 'Promotion worktree path already exists.');
  await mkdir(tempRoot, { recursive: true });
  await mkdir(receiptDir, { recursive: true });

  await runGitCommand({
    gitCommand,
    cwd: sourceRepoPath,
    args: ['worktree', 'add', '-b', input.branchName, worktreePath, baseRef],
    errorCode: 'promotion_worktree_create_failed',
    errorMessage: 'Failed to create local promotion worktree and branch.',
  });
  await runGitCommand({
    gitCommand,
    cwd: worktreePath,
    args: ['apply', '--3way', '--index', patchPath],
    errorCode: 'promotion_patch_apply_failed',
    errorMessage: 'Failed to apply Codex issue-run patch to promotion worktree.',
  });

  const verification = await runVerificationCommands(input.verificationCommands, worktreePath);
  const verificationOk = verification.every((result) => result.ok);
  const commitSha = verificationOk
    ? await commitPromotion({ gitCommand, worktreePath, commitMessage: input.commitMessage })
    : null;
  const artifacts = await writePromotionArtifacts({
    receiptDir,
    sourceRepoPath,
    patchPath,
    branchName: input.branchName,
    baseRef,
    baseCommit,
    worktreePath,
    commitSha,
    verification,
    gitCommand,
  });
  return {
    status: verificationOk && commitSha !== null ? 'pass' : 'fail',
    source_repo_path: sourceRepoPath,
    patch_path: patchPath,
    receipt_dir: receiptDir,
    branch_name: input.branchName,
    base_ref: baseRef,
    worktree_path: worktreePath,
    commit_sha: commitSha,
    verification,
    artifacts,
    non_actions: promotionNonActions(),
  };
}

export function codexPatchPromotionWorktreeDirectoryName(branchName: string): string {
  return `symphony-promotion-${safeWorktreeName(branchName)}`;
}

export function isSafeCodexPatchPromotionBranchName(branchName: string): boolean {
  const value = branchName.trim();
  if (value.length === 0 || value !== branchName) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false;
  if (value.includes('..') || value.includes('//') || value.includes('@{')) return false;
  if (value.endsWith('.lock')) return false;
  return value.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

function validatePromotionInput(input: PromoteCodexIssueRunPatchInput): void {
  if (input.branchName.trim().length === 0) {
    throw new CodexPatchPromotionError('missing_branch_name', 'Patch promotion requires an explicit local branch name.');
  }
  if (!isSafeCodexPatchPromotionBranchName(input.branchName)) {
    throw new CodexPatchPromotionError('unsafe_branch_name', 'Patch promotion branch name is unsafe for local worktree creation.', { branch_name: input.branchName });
  }
  if (input.commitMessage.trim().length === 0) {
    throw new CodexPatchPromotionError('missing_commit_message', 'Patch promotion requires an explicit commit message.');
  }
  if (!Array.isArray(input.verificationCommands) || input.verificationCommands.length === 0) {
    throw new CodexPatchPromotionError('missing_verification_commands', 'Patch promotion requires at least one local verification command before commit.');
  }
  const verificationCommands: readonly unknown[] = input.verificationCommands;
  for (const command of verificationCommands) {
    if (command === null || typeof command !== 'object') {
      throw new CodexPatchPromotionError('missing_verification_command', 'Verification command entries require a non-empty command.');
    }
    const record = command as { readonly command?: unknown; readonly args?: unknown };
    if (typeof record.command !== 'string' || record.command.trim().length === 0) {
      throw new CodexPatchPromotionError('missing_verification_command', 'Verification command entries require a non-empty command.');
    }
    if (record.args !== undefined && !isStringArray(record.args)) {
      throw new CodexPatchPromotionError('invalid_verification_command_args', 'Verification command args must be strings.');
    }
  }
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

async function assertReadablePatch(patchPath: string): Promise<void> {
  try {
    await readFile(patchPath);
  } catch (error) {
    throw new CodexPatchPromotionError('patch_not_readable', 'Patch artifact is not readable.', { patch_path: patchPath, error: String(error) });
  }
}

async function assertGitWorkTree(input: { readonly gitCommand: string; readonly sourceRepoPath: string }): Promise<void> {
  const result = await executeCommand(input.gitCommand, ['-C', input.sourceRepoPath, 'rev-parse', '--is-inside-work-tree'], input.sourceRepoPath);
  if (!result.ok || result.stdout.trim() !== 'true') {
    throw new CodexPatchPromotionError('source_repo_not_git', 'Patch promotion source repo must be a git worktree.', commandDetails(input.gitCommand, ['-C', input.sourceRepoPath, 'rev-parse', '--is-inside-work-tree'], input.sourceRepoPath, result));
  }
}

async function assertCleanSourceRepo(input: { readonly gitCommand: string; readonly sourceRepoPath: string }): Promise<void> {
  const status = await runGitCaptureCommand({
    gitCommand: input.gitCommand,
    cwd: input.sourceRepoPath,
    args: ['status', '--porcelain=v1'],
    errorCode: 'source_status_failed',
    errorMessage: 'Failed to inspect source repo cleanliness before promotion.',
  });
  if (status.length > 0) {
    throw new CodexPatchPromotionError('source_repo_not_clean', 'Patch promotion requires a clean source repo before creating a promotion worktree.', { status });
  }
}

async function assertLocalBranchDoesNotExist(input: {
  readonly gitCommand: string;
  readonly sourceRepoPath: string;
  readonly branchName: string;
}): Promise<void> {
  const result = await executeCommand(input.gitCommand, ['-C', input.sourceRepoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${input.branchName}`], input.sourceRepoPath);
  if (result.ok) {
    throw new CodexPatchPromotionError('promotion_branch_exists', 'Patch promotion branch already exists.', { branch_name: input.branchName });
  }
  if (result.exitCode !== 1) {
    throw new CodexPatchPromotionError('promotion_branch_check_failed', 'Failed to inspect existing local promotion branch.', commandDetails(input.gitCommand, ['-C', input.sourceRepoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${input.branchName}`], input.sourceRepoPath, result));
  }
}

async function assertPathDoesNotExist(path: string, code: string, message: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (hasFileErrorCode(error, 'ENOENT')) return;
    throw new CodexPatchPromotionError('promotion_worktree_check_failed', 'Failed to inspect promotion worktree path before creation.', { path, error: String(error) });
  }
  throw new CodexPatchPromotionError(code, message, { path });
}

function hasFileErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { readonly code?: unknown }).code === code;
}

async function runVerificationCommands(
  commands: readonly CodexPatchPromotionVerificationCommand[],
  cwd: string,
): Promise<CodexPatchPromotionVerificationResult[]> {
  const results: CodexPatchPromotionVerificationResult[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    if (command === undefined) continue;
    const args = command.args ?? [];
    const result = await executeCommand(command.command, args, cwd);
    results.push({
      name: command.name ?? `verification-${String(index + 1)}`,
      command: redactForArtifact(command.command),
      args: args.map((arg) => redactForArtifact(arg)),
      ok: result.ok,
      exit_code: result.exitCode,
      stdout: redactForArtifact(result.stdout),
      stderr: redactForArtifact(result.stderr),
    });
    if (!result.ok) break;
  }
  return results;
}

async function commitPromotion(input: {
  readonly gitCommand: string;
  readonly worktreePath: string;
  readonly commitMessage: string;
}): Promise<string> {
  await runGitCommand({
    gitCommand: input.gitCommand,
    cwd: input.worktreePath,
    args: ['commit', '-m', input.commitMessage],
    errorCode: 'promotion_commit_failed',
    errorMessage: 'Failed to create local promotion commit after verification passed.',
  });
  return (await runGitCaptureCommand({
    gitCommand: input.gitCommand,
    cwd: input.worktreePath,
    args: ['rev-parse', 'HEAD'],
    errorCode: 'promotion_commit_read_failed',
    errorMessage: 'Failed to read promotion commit SHA.',
  })).trim();
}

async function writePromotionArtifacts(input: {
  readonly receiptDir: string;
  readonly sourceRepoPath: string;
  readonly patchPath: string;
  readonly branchName: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly worktreePath: string;
  readonly commitSha: string | null;
  readonly verification: readonly CodexPatchPromotionVerificationResult[];
  readonly gitCommand: string;
}): Promise<CodexPatchPromotionArtifacts> {
  const artifacts: CodexPatchPromotionArtifacts = {
    outcome: join(input.receiptDir, 'codex-patch-promotion-outcome.json'),
    patch: join(input.receiptDir, 'codex-patch-promotion.patch'),
    status: join(input.receiptDir, 'codex-patch-promotion-status.txt'),
    summary: join(input.receiptDir, 'codex-patch-promotion-summary.md'),
    manifest: join(input.receiptDir, 'artifact-manifest.json'),
  };
  const patch = input.commitSha === null
    ? await runGitCaptureCommand({
        gitCommand: input.gitCommand,
        cwd: input.worktreePath,
        args: ['diff', '--binary'],
        errorCode: 'promotion_patch_capture_failed',
        errorMessage: 'Failed to capture uncommitted promotion patch.',
      })
    : await runGitCaptureCommand({
        gitCommand: input.gitCommand,
        cwd: input.worktreePath,
        args: ['diff', '--binary', `${input.baseCommit}..HEAD`],
        errorCode: 'promotion_patch_capture_failed',
        errorMessage: 'Failed to capture committed promotion patch.',
      });
  const status = await runGitCaptureCommand({
    gitCommand: input.gitCommand,
    cwd: input.worktreePath,
    args: ['status', '--short'],
    errorCode: 'promotion_status_capture_failed',
    errorMessage: 'Failed to capture promotion worktree status.',
  });
  const outcome = {
    status: input.commitSha === null ? 'fail' : 'pass',
    source_repo_path: input.sourceRepoPath,
    patch_path: input.patchPath,
    receipt_dir: input.receiptDir,
    branch_name: input.branchName,
    base_ref: input.baseRef,
    worktree_path: input.worktreePath,
    commit_sha: input.commitSha,
    verification: input.verification,
    artifacts,
    non_actions: promotionNonActions(),
  } satisfies CodexPatchPromotionOutcome;

  await writeJson(artifacts.outcome, outcome);
  await writeFile(artifacts.patch, patch, 'utf8');
  await writeFile(artifacts.status, status, 'utf8');
  await writeFile(artifacts.summary, promotionSummary(outcome), 'utf8');
  await writeJson(artifacts.manifest, await artifactManifest(withoutManifestArtifact({ ...artifacts })));
  return artifacts;
}

function promotionSummary(outcome: CodexPatchPromotionOutcome): string {
  return [
    `# ${outcome.branch_name} Codex patch promotion`,
    '',
    `- Outcome: ${outcome.status}`,
    `- Source repo: ${outcome.source_repo_path}`,
    `- Patch artifact: ${outcome.patch_path}`,
    `- Base ref: ${outcome.base_ref}`,
    `- Branch: ${outcome.branch_name}`,
    `- Worktree: ${outcome.worktree_path}`,
    `- Commit SHA: ${outcome.commit_sha ?? 'none'}`,
    `- Verification commands: ${String(outcome.verification.length)}`,
    '',
    '## Non-authorizations',
    '',
    'No git push, PR creation, Linear mutation, deployment, service restart, or broad dispatch is authorized.',
    '',
  ].join('\n');
}

async function runGitCommand(input: {
  readonly gitCommand: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly errorCode: string;
  readonly errorMessage: string;
}): Promise<void> {
  const result = await executeCommand(input.gitCommand, input.args, input.cwd);
  if (!result.ok) {
    throw new CodexPatchPromotionError(input.errorCode, input.errorMessage, commandDetails(input.gitCommand, input.args, input.cwd, result));
  }
}

async function runGitCaptureCommand(input: {
  readonly gitCommand: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly errorCode: string;
  readonly errorMessage: string;
}): Promise<string> {
  const result = await executeCommand(input.gitCommand, input.args, input.cwd);
  if (!result.ok) {
    throw new CodexPatchPromotionError(input.errorCode, input.errorMessage, commandDetails(input.gitCommand, input.args, input.cwd, result));
  }
  return result.stdout;
}

async function executeCommand(command: string, args: readonly string[], cwd: string): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolvePromise) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (error) => {
      resolvePromise({ ok: false, exitCode: null, stdout: '', stderr: String(error) });
    });
    child.on('close', (exitCode) => {
      resolvePromise({
        ok: exitCode === 0,
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function promotionNonActions(): CodexPatchPromotionOutcome['non_actions'] {
  return {
    git_push_authorized: false,
    pull_request_created: false,
    linear_mutation_authorized: false,
    deploy_authorized: false,
    service_restart_authorized: false,
    broad_dispatch_authorized: false,
  };
}

function safeWorktreeName(branchName: string): string {
  return branchName.replaceAll(/[^A-Za-z0-9._-]/g, '_');
}

function commandDetails(command: string, args: readonly string[], cwd: string, result: CommandResult) {
  return {
    command: redactForArtifact(command),
    args: args.map((arg) => redactForArtifact(arg)),
    cwd: redactForArtifact(cwd),
    exit_code: result.exitCode,
    stdout: redactForArtifact(result.stdout),
    stderr: redactForArtifact(result.stderr),
  };
}

function redactForArtifact(value: string): string {
  return value
    .replaceAll(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_OPENAI_KEY]')
    .replaceAll(/lin_api_[A-Za-z0-9_-]{20,}/g, '[REDACTED_LINEAR_TOKEN]')
    .replaceAll(/Bearer\s+[A-Za-z0-9._~+/-]{12,}/gi, 'Bearer [REDACTED]');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function withoutManifestArtifact(artifacts: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(artifacts).filter(([name]) => name !== 'manifest'));
}

async function artifactManifest(artifacts: Readonly<Record<string, string>>): Promise<Record<string, unknown>> {
  const entries: Record<string, unknown> = {};
  for (const [name, artifactPath] of Object.entries(artifacts)) {
    entries[name] = {
      path: artifactPath,
      sha256: await sha256File(artifactPath),
    };
  }
  return { artifacts: entries };
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
