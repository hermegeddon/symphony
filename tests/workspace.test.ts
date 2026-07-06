import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HookExecutionError,
  WorkspacePathError,
  WorkspaceManager,
  WorkspaceMaterializationError,
  assertAgentLaunchCwd,
  isPathInsideDirectory,
  sanitizeWorkspaceKey,
} from '../src/workspace.js';

const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd });
  return stdout;
}

async function makeGitRepo(): Promise<string> {
  const repo = await makeTempRoot();
  await git(repo, ['init']);
  await writeFile(join(repo, 'README.md'), 'fixture repo\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['-c', 'user.name=Symphony Test', '-c', 'user.email=symphony@example.test', 'commit', '-m', 'initial']);
  return repo;
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'symphony-workspace-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('workspace key sanitization', () => {
  it('replaces every character outside the spec allowed set with underscores', () => {
    expect(sanitizeWorkspaceKey('ABC-xyz_123.issue/../snowman☃ space')).toBe(
      'ABC-xyz_123.issue_.._snowman__space',
    );
  });
});

describe('workspace path containment', () => {
  it('accepts a normalized descendant of the workspace root', async () => {
    const root = await makeTempRoot();

    await expect(isPathInsideDirectory(join(root, 'ISSUE-123'), root)).resolves.toBe(true);
  });

  it('rejects prefix-confusion siblings outside the workspace root', async () => {
    const root = await makeTempRoot();

    await expect(isPathInsideDirectory(`${root}-sibling/ISSUE-123`, root)).resolves.toBe(false);
  });

  it('rejects traversal paths that normalize outside the workspace root', async () => {
    const root = await makeTempRoot();

    await expect(isPathInsideDirectory(join(root, '..', 'outside'), root)).resolves.toBe(false);
  });

  it('rejects symlink escapes from the workspace root', async () => {
    const root = await makeTempRoot();
    const outside = await makeTempRoot();
    const link = join(root, 'link-out');
    await symlink(outside, link);

    await expect(isPathInsideDirectory(join(link, 'ISSUE-123'), root)).resolves.toBe(false);
  });
});

describe('WorkspaceManager', () => {
  it('creates the sanitized per-issue workspace and runs after_create only for new workspaces', async () => {
    const root = await makeTempRoot();
    const manager = new WorkspaceManager({
      root,
      hooks: {
        after_create: 'printf created >> hook.log',
      },
    });

    const first = await manager.prepareWorkspace({ identifier: 'TEAM/123' });
    const second = await manager.prepareWorkspace({ identifier: 'TEAM/123' });

    expect(first.workspaceKey).toBe('TEAM_123');
    expect(first.workspacePath).toBe(resolve(root, 'TEAM_123'));
    expect(first.createdNow).toBe(true);
    expect(second.createdNow).toBe(false);
    await expect(readFile(join(first.workspacePath, 'hook.log'), 'utf8')).resolves.toBe('created');
  });

  it('treats after_create hook failures as fatal', async () => {
    const root = await makeTempRoot();
    const manager = new WorkspaceManager({
      root,
      hooks: {
        after_create: 'exit 7',
      },
    });

    await expect(manager.prepareWorkspace({ identifier: 'TEAM-123' })).rejects.toThrow(HookExecutionError);
  });

  it('runs before_run hooks as fatal and after_run hooks as logged/nonfatal', async () => {
    const root = await makeTempRoot();
    const manager = new WorkspaceManager({
      root,
      hooks: {
        before_run: 'printf before >> order.log',
        after_run: 'printf after >> order.log; exit 9',
      },
    });
    const workspace = await manager.prepareWorkspace({ identifier: 'TEAM-123' });

    await manager.runBeforeRunHook(workspace);
    const afterRun = await manager.runAfterRunHook(workspace);

    if (afterRun === undefined) {
      throw new Error('after_run hook should have executed');
    }
    expect(afterRun.ok).toBe(false);
    await expect(readFile(join(workspace.workspacePath, 'order.log'), 'utf8')).resolves.toBe(
      'beforeafter',
    );
  });

  it('treats before_run hook timeouts as fatal', async () => {
    const root = await makeTempRoot();
    const manager = new WorkspaceManager({
      root,
      hooks: {
        before_run: 'sleep 1',
        timeoutMs: 25,
      },
    });
    const workspace = await manager.prepareWorkspace({ identifier: 'TEAM-123' });

    await expect(manager.runBeforeRunHook(workspace)).rejects.toThrow(HookExecutionError);
  });

  it('preserves successful workspaces but runs before_remove during terminal cleanup', async () => {
    const root = await makeTempRoot();
    const manager = new WorkspaceManager({
      root,
      hooks: {
        before_remove: 'printf removing > remove.log; exit 11',
      },
    });
    const workspace = await manager.prepareWorkspace({ identifier: 'TEAM-123' });
    await writeFile(join(workspace.workspacePath, 'kept.txt'), 'kept');

    await manager.preserveAfterSuccessfulRun(workspace);
    await expect(readFile(join(workspace.workspacePath, 'kept.txt'), 'utf8')).resolves.toBe('kept');

    const cleanup = await manager.cleanupTerminalWorkspace(workspace);

    expect(cleanup.hook?.ok).toBe(false);
    await expect(readFile(join(workspace.workspacePath, 'kept.txt'), 'utf8')).rejects.toThrow();
  });

  it('materializes a per-issue workspace as a detached git worktree and removes it during terminal cleanup', async () => {
    const sourceRepoPath = await makeGitRepo();
    const root = await makeTempRoot();
    const manager = new WorkspaceManager({
      root,
      source: { kind: 'git_worktree', repoPath: sourceRepoPath, baseRef: 'HEAD', gitCommand: 'git' },
    });

    const workspace = await manager.prepareWorkspace({ identifier: 'HER-200' });

    expect(workspace.workspaceKey).toBe('HER-200');
    expect(workspace.workspacePath).toBe(resolve(root, 'HER-200'));
    expect(workspace.createdNow).toBe(true);
    await expect(readFile(join(workspace.workspacePath, 'README.md'), 'utf8')).resolves.toBe('fixture repo\n');
    expect((await git(workspace.workspacePath, ['branch', '--show-current'])).trim()).toBe('');

    const reused = await manager.prepareWorkspace({ identifier: 'HER-200' });
    expect(reused.workspacePath).toBe(workspace.workspacePath);
    expect(reused.createdNow).toBe(false);

    await manager.cleanupTerminalWorkspace(workspace);

    await expect(access(workspace.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(git(sourceRepoPath, ['worktree', 'list', '--porcelain'])).resolves.not.toContain(workspace.workspacePath);
    await expect(git(sourceRepoPath, ['branch', '--list', 'symphony-*'])).resolves.toBe('');
  });

  it('refuses to reuse an existing non-git directory for a git worktree source', async () => {
    const sourceRepoPath = await makeGitRepo();
    const root = await makeTempRoot();
    await mkdir(join(root, 'HER-201'), { recursive: true });
    await writeFile(join(root, 'HER-201', 'note.txt'), 'not a checkout\n', 'utf8');
    const manager = new WorkspaceManager({
      root,
      source: { kind: 'git_worktree', repoPath: sourceRepoPath, baseRef: 'HEAD', gitCommand: 'git' },
    });

    await expect(manager.prepareWorkspace({ identifier: 'HER-201' })).rejects.toThrow(WorkspaceMaterializationError);
    await expect(readFile(join(root, 'HER-201', 'note.txt'), 'utf8')).resolves.toBe('not a checkout\n');
  });

  it('refuses to reuse an existing unrelated git repository for a git worktree source', async () => {
    const sourceRepoPath = await makeGitRepo();
    const root = await makeTempRoot();
    const unrelatedPath = join(root, 'HER-202');
    await mkdir(unrelatedPath, { recursive: true });
    await git(unrelatedPath, ['init']);
    await writeFile(join(unrelatedPath, 'README.md'), 'unrelated repo\n', 'utf8');
    await git(unrelatedPath, ['add', 'README.md']);
    await git(unrelatedPath, ['-c', 'user.name=Symphony Test', '-c', 'user.email=symphony@example.test', 'commit', '-m', 'unrelated']);
    const manager = new WorkspaceManager({
      root,
      source: { kind: 'git_worktree', repoPath: sourceRepoPath, baseRef: 'HEAD', gitCommand: 'git' },
    });

    await expect(manager.prepareWorkspace({ identifier: 'HER-202' })).rejects.toThrow(WorkspaceMaterializationError);
    await expect(readFile(join(unrelatedPath, 'README.md'), 'utf8')).resolves.toBe('unrelated repo\n');
  });

  it('rejects an unsafe computed workspace path before creating directories', async () => {
    const root = await makeTempRoot();
    const manager = new WorkspaceManager({ root });

    await expect(manager.ensureWorkspacePathInsideRoot(join(root, '..', 'escape'))).rejects.toThrow(
      WorkspacePathError,
    );
  });
});

describe('agent cwd safety', () => {
  it('requires the launch cwd to exactly match the per-issue workspace path', async () => {
    const root = await makeTempRoot();
    const workspacePath = resolve(root, 'ISSUE-123');

    expect(() => {
      assertAgentLaunchCwd(workspacePath, `${workspacePath}-prefix`);
    }).toThrow(WorkspacePathError);
    expect(() => {
      assertAgentLaunchCwd(workspacePath, workspacePath);
    }).not.toThrow();
  });
});
