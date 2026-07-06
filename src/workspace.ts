import { constants as fsConstants } from 'node:fs';
import { access, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import type { WorkspaceSourceConfig } from './workflow.js';

export type WorkspaceHookName = 'after_create' | 'before_run' | 'after_run' | 'before_remove';

export interface WorkspaceHooksConfig {
  readonly after_create?: string;
  readonly before_run?: string;
  readonly after_run?: string;
  readonly before_remove?: string;
  readonly timeoutMs?: number;
}

export interface WorkspaceManagerConfig {
  readonly root: string;
  readonly hooks?: WorkspaceHooksConfig;
  readonly source?: WorkspaceSourceConfig;
  readonly logger?: WorkspaceHookLogger;
}

export interface WorkspaceIssue {
  readonly identifier: string;
}

export interface PreparedWorkspace {
  readonly workspaceKey: string;
  readonly workspaceRoot: string;
  readonly workspacePath: string;
  readonly createdNow: boolean;
}

export interface HookExecutionResult {
  readonly hook: WorkspaceHookName;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WorkspaceHookLogger {
  readonly hookStart?: (event: { readonly hook: WorkspaceHookName; readonly cwd: string }) => void;
  readonly hookFailure?: (event: HookExecutionResult) => void;
  readonly hookTimeout?: (event: HookExecutionResult) => void;
}

const defaultHookTimeoutMs = 60_000;
const allowedWorkspaceKeyCharacters = /[A-Za-z0-9._-]/g;
const execFileAsync = promisify(execFile);

export class WorkspacePathError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

export class WorkspaceMaterializationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'WorkspaceMaterializationError';
  }
}

export class HookExecutionError extends Error {
  public readonly result: HookExecutionResult;

  public constructor(message: string, result: HookExecutionResult) {
    super(message);
    this.name = 'HookExecutionError';
    this.result = result;
  }
}

export function sanitizeWorkspaceKey(identifier: string): string {
  return Array.from(identifier)
    .map((character) => (character.match(allowedWorkspaceKeyCharacters) ? character : '_'))
    .join('');
}

export async function isPathInsideDirectory(path: string, directory: string): Promise<boolean> {
  return isPathReallyInsideDirectory(path, directory);
}

async function resolveForContainment(path: string): Promise<string> {
  const absolutePath = resolve(path);
  const segments = absolutePath.split(sep).filter(Boolean);
  const prefix = absolutePath.startsWith(sep) ? sep : '';

  for (let index = segments.length; index >= 0; index -= 1) {
    const existingCandidate = prefix + segments.slice(0, index).join(sep);
    const candidate = existingCandidate === '' ? sep : existingCandidate;

    try {
      await access(candidate, fsConstants.F_OK);
      const resolvedExisting = await realpath(candidate);
      const remainder = segments.slice(index);
      return remainder.length === 0 ? resolvedExisting : resolve(resolvedExisting, ...remainder);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  return absolutePath;
}

export async function isPathReallyInsideDirectory(path: string, directory: string): Promise<boolean> {
  const normalizedDirectory = ensureTrailingSeparator(await resolveForContainment(directory));
  const normalizedPath = await resolveForContainment(path);
  const directoryWithoutSeparator = normalizedDirectory.slice(0, -1);
  return normalizedPath === directoryWithoutSeparator || normalizedPath.startsWith(normalizedDirectory);
}

export function assertAgentLaunchCwd(workspacePath: string, cwd: string): void {
  const normalizedWorkspacePath = resolve(workspacePath);
  const normalizedCwd = resolve(cwd);

  if (normalizedCwd !== normalizedWorkspacePath) {
    throw new WorkspacePathError(
      `Agent cwd must exactly equal workspace path: cwd=${normalizedCwd} workspace=${normalizedWorkspacePath}`,
    );
  }
}

export class WorkspaceManager {
  private readonly root: string;
  private readonly source: WorkspaceSourceConfig;
  private readonly hooks: WorkspaceHooksConfig;
  private readonly logger: WorkspaceHookLogger | undefined;

  public constructor(config: WorkspaceManagerConfig) {
    const normalizedRoot = resolve(config.root);
    if (!isAbsolute(normalizedRoot)) {
      throw new WorkspacePathError(`Workspace root must be absolute: ${config.root}`);
    }

    this.root = normalizedRoot;
    this.source = config.source ?? { kind: 'empty_directory' };
    this.hooks = config.hooks ?? {};
    this.logger = config.logger;
  }

  public async prepareWorkspace(issue: WorkspaceIssue): Promise<PreparedWorkspace> {
    const workspaceKey = sanitizeWorkspaceKey(issue.identifier);
    const workspacePath = resolve(this.root, workspaceKey);
    await this.ensureWorkspacePathInsideRoot(workspacePath);

    const existed = await directoryExists(workspacePath);
    if (this.source.kind === 'git_worktree') {
      await this.materializeGitWorktree(workspacePath, existed);
    } else {
      await mkdir(workspacePath, { recursive: true });
    }
    const workspace: PreparedWorkspace = {
      workspaceKey,
      workspaceRoot: this.root,
      workspacePath,
      createdNow: !existed,
    };

    if (workspace.createdNow) {
      await this.runFatalHook('after_create', workspace);
    }

    return workspace;
  }

  public async ensureWorkspacePathInsideRoot(workspacePath: string): Promise<void> {
    await mkdir(this.root, { recursive: true });

    if (!(await isPathReallyInsideDirectory(workspacePath, this.root))) {
      throw new WorkspacePathError(
        `Workspace path must remain inside workspace root: path=${resolve(workspacePath)} root=${this.root}`,
      );
    }
  }

  public async runBeforeRunHook(workspace: PreparedWorkspace): Promise<HookExecutionResult | undefined> {
    return this.runFatalHook('before_run', workspace);
  }

  public async runAfterRunHook(workspace: PreparedWorkspace): Promise<HookExecutionResult | undefined> {
    return this.runNonfatalHook('after_run', workspace);
  }

  public async preserveAfterSuccessfulRun(workspace: PreparedWorkspace): Promise<void> {
    void workspace;
    return Promise.resolve();
  }

  public async cleanupTerminalWorkspace(
    workspace: PreparedWorkspace,
  ): Promise<{ readonly hook?: HookExecutionResult }> {
    const hook = await this.runNonfatalHook('before_remove', workspace);
    if (this.source.kind === 'git_worktree') {
      await removeGitWorktree({ source: this.source, workspacePath: workspace.workspacePath });
    } else {
      await rm(workspace.workspacePath, { recursive: true, force: true });
    }
    return hook === undefined ? {} : { hook };
  }

  private async materializeGitWorktree(workspacePath: string, existed: boolean): Promise<void> {
    if (this.source.kind !== 'git_worktree') {
      return;
    }
    if (existed) {
      await assertExistingGitWorktree({ source: this.source, workspacePath });
      return;
    }
    await assertGitWorkTree({ source: this.source });
    await runGitCommand({
      source: this.source,
      cwd: this.source.repoPath,
      args: ['worktree', 'add', '--detach', workspacePath, this.source.baseRef],
      code: 'git_worktree_create_failed',
      message: 'Failed to create git worktree workspace.',
      details: { source_repo_path: this.source.repoPath, workspace_path: workspacePath, base_ref: this.source.baseRef },
    });
  }

  private async runFatalHook(
    hook: WorkspaceHookName,
    workspace: PreparedWorkspace,
  ): Promise<HookExecutionResult | undefined> {
    const result = await this.runHook(hook, workspace);
    if (result !== undefined && !result.ok) {
      throw new HookExecutionError(`${hook} hook failed`, result);
    }

    return result;
  }

  private async runNonfatalHook(
    hook: WorkspaceHookName,
    workspace: PreparedWorkspace,
  ): Promise<HookExecutionResult | undefined> {
    return this.runHook(hook, workspace);
  }

  private async runHook(
    hook: WorkspaceHookName,
    workspace: PreparedWorkspace,
  ): Promise<HookExecutionResult | undefined> {
    const script = this.hooks[hook];
    if (script === undefined || script.trim() === '') {
      return undefined;
    }

    assertAgentLaunchCwd(workspace.workspacePath, workspace.workspacePath);
    this.logger?.hookStart?.({ hook, cwd: workspace.workspacePath });
    const result = await executeShellHook({
      hook,
      script,
      cwd: workspace.workspacePath,
      timeoutMs: this.hooks.timeoutMs ?? defaultHookTimeoutMs,
    });

    if (!result.ok) {
      this.logger?.hookFailure?.(result);
    }
    if (result.timedOut) {
      this.logger?.hookTimeout?.(result);
    }

    return result;
  }
}

type GitWorktreeWorkspaceSource = Extract<WorkspaceSourceConfig, { readonly kind: 'git_worktree' }>;

interface GitCommandResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function assertGitWorkTree(input: { readonly source: GitWorktreeWorkspaceSource }): Promise<void> {
  const result = await executeGitCommand(input.source, ['-C', input.source.repoPath, 'rev-parse', '--is-inside-work-tree']);
  if (!result.ok || result.stdout.trim() !== 'true') {
    throw new WorkspaceMaterializationError(
      'source_repo_not_git',
      'Workspace git worktree source must be an existing git worktree.',
      { source_repo_path: input.source.repoPath, result },
    );
  }
}

async function assertExistingGitWorktree(input: {
  readonly source: GitWorktreeWorkspaceSource;
  readonly workspacePath: string;
}): Promise<void> {
  const inside = await executeGitCommand(input.source, ['-C', input.workspacePath, 'rev-parse', '--is-inside-work-tree']);
  const topLevel = inside.ok
    ? await executeGitCommand(input.source, ['-C', input.workspacePath, 'rev-parse', '--show-toplevel'])
    : { ok: false, exitCode: null, stdout: '', stderr: '' };
  const registeredWorktrees = inside.ok
    ? await executeGitCommand(input.source, ['-C', input.source.repoPath, 'worktree', 'list', '--porcelain'])
    : { ok: false, exitCode: null, stdout: '', stderr: '' };
  if (
    !inside.ok
    || inside.stdout.trim() !== 'true'
    || !topLevel.ok
    || resolve(topLevel.stdout.trim()) !== resolve(input.workspacePath)
    || resolve(input.workspacePath) === resolve(input.source.repoPath)
    || !registeredWorktrees.ok
    || !worktreeListContainsPath(registeredWorktrees.stdout, input.workspacePath)
  ) {
    throw new WorkspaceMaterializationError(
      'existing_workspace_not_git_worktree',
      'Existing workspace path is not a registered git worktree checkout for the configured source repo and will not be reused.',
      { workspace_path: input.workspacePath, inside, top_level: topLevel, registered_worktrees: registeredWorktrees },
    );
  }
}

function worktreeListContainsPath(output: string, workspacePath: string): boolean {
  const normalizedWorkspacePath = resolve(workspacePath);
  return output.split(/\r?\n/).some((line) => {
    if (!line.startsWith('worktree ')) {
      return false;
    }
    return resolve(line.slice('worktree '.length)) === normalizedWorkspacePath;
  });
}

async function removeGitWorktree(input: {
  readonly source: GitWorktreeWorkspaceSource;
  readonly workspacePath: string;
}): Promise<void> {
  await runGitCommand({
    source: input.source,
    cwd: input.source.repoPath,
    args: ['worktree', 'remove', '--force', input.workspacePath],
    code: 'git_worktree_remove_failed',
    message: 'Failed to remove git worktree workspace.',
    details: { source_repo_path: input.source.repoPath, workspace_path: input.workspacePath },
  });
}

async function runGitCommand(input: {
  readonly source: GitWorktreeWorkspaceSource;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}): Promise<void> {
  const result = await executeGitCommand(input.source, input.args, input.cwd);
  if (!result.ok) {
    throw new WorkspaceMaterializationError(input.code, input.message, { ...input.details, result });
  }
}

async function executeGitCommand(
  source: GitWorktreeWorkspaceSource,
  args: readonly string[],
  cwd = process.cwd(),
): Promise<GitCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(source.gitCommand, [...args], { cwd });
    return { ok: true, exitCode: 0, stdout, stderr };
  } catch (error) {
    const maybe = error as { readonly code?: unknown; readonly stdout?: unknown; readonly stderr?: unknown };
    return {
      ok: false,
      exitCode: typeof maybe.code === 'number' ? maybe.code : null,
      stdout: commandOutputToString(maybe.stdout),
      stderr: commandOutputToString(maybe.stderr),
    };
  }
}

function commandOutputToString(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '[non-string command output]';
}

async function executeShellHook(input: {
  readonly hook: WorkspaceHookName;
  readonly script: string;
  readonly cwd: string;
  readonly timeoutMs: number;
}): Promise<HookExecutionResult> {
  return new Promise((resolvePromise) => {
    const child = spawn('sh', ['-lc', input.script], {
      cwd: input.cwd,
      env: { ...process.env, TMPDIR: process.env['TMPDIR'] ?? tmpdir() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, input.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolvePromise({
        hook: input.hook,
        ok: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function ensureTrailingSeparator(path: string): string {
  if (path.endsWith(sep)) {
    return path;
  }

  return `${path}${sep}`;
}

export function hasPrefixDirectory(path: string, directory: string): boolean {
  const relativePath = relative(resolve(directory), resolve(path));
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith(sep));
}
