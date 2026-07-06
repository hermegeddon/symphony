import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { runCodexPatchPromotionCli } from '../src/cli/codex-promote-patch.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd });
  return stdout;
}

async function makeGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'symphony-promotion-cli-source-repo-'));
  await git(repo, ['init']);
  await git(repo, ['config', 'user.name', 'Symphony Promotion CLI Test']);
  await git(repo, ['config', 'user.email', 'symphony-promotion-cli@example.test']);
  await writeFile(join(repo, 'README.md'), 'fixture repo\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'initial']);
  return repo;
}

async function createReadmePatch(repo: string, content: string): Promise<string> {
  const patchPath = join(await mkdtemp(join(tmpdir(), 'symphony-promotion-cli-patch-')), 'codex-issue-run-worktree.patch');
  await writeFile(join(repo, 'README.md'), content, 'utf8');
  const patch = await git(repo, ['diff', '--binary']);
  await writeFile(patchPath, patch, 'utf8');
  await git(repo, ['checkout', '--', 'README.md']);
  return patchPath;
}

function verificationJson(script: string): string {
  return JSON.stringify([{
    name: 'node verification',
    command: process.execPath,
    args: ['-e', script],
  }]);
}

describe('symphony-codex-promote-patch CLI', () => {
  it('is declared as a package binary', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      readonly bin?: Readonly<Record<string, string>>;
    };

    expect(packageJson.bin?.['symphony-codex-promote-patch']).toBe('dist/src/cli/codex-promote-patch.js');
  });

  it('checks promotion readiness without applying a patch, creating a branch, or writing receipts', async () => {
    const sourceRepoPath = await makeGitRepo();
    const patchPath = await createReadmePatch(sourceRepoPath, 'fixture repo\ncli check candidate\n');
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-promotion-cli-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-promotion-cli-worktrees-'));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexPatchPromotionCli([
      '--check',
      '--source-repo', sourceRepoPath,
      '--patch-path', patchPath,
      '--receipt-dir', receiptDir,
      '--temp-root', tempRoot,
      '--branch-name', 'symphony/cli-check',
      '--commit-message', 'Promote CLI check patch',
      '--verification-command-json', verificationJson('process.exit(0)'),
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as {
      readonly effect: string;
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
        readonly promotion_would_apply_patch: boolean;
        readonly promotion_would_commit: boolean;
      };
    };
    expect(check).toEqual({
      effect: 'check_only',
      ok: true,
      checks: {
        source_repo_git: true,
        source_repo_clean: true,
        patch_readable: true,
        receipt_dir_writable: true,
        temp_root_writable: true,
        branch_name_safe: true,
        branch_available: true,
        promotion_worktree_available: true,
        verification_commands_present: true,
        promotion_would_apply_patch: false,
        promotion_would_commit: false,
      },
    });
    await expect(access(join(tempRoot, 'symphony-promotion-symphony_cli-check'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(receiptDir, 'codex-patch-promotion-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(git(sourceRepoPath, ['rev-parse', '--verify', 'symphony/cli-check'])).rejects.toThrow();
  });

  it('reports unavailable local branch and promotion worktree paths during no-side-effect check', async () => {
    const sourceRepoPath = await makeGitRepo();
    const patchPath = await createReadmePatch(sourceRepoPath, 'fixture repo\ncli unavailable candidate\n');
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-promotion-cli-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-promotion-cli-worktrees-'));
    await git(sourceRepoPath, ['branch', 'symphony/cli-existing']);
    await mkdir(join(tempRoot, 'symphony-promotion-symphony_cli-existing'));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexPatchPromotionCli([
      '--check',
      '--source-repo', sourceRepoPath,
      '--patch-path', patchPath,
      '--receipt-dir', receiptDir,
      '--temp-root', tempRoot,
      '--branch-name', 'symphony/cli-existing',
      '--commit-message', 'Should not promote unavailable branch',
      '--verification-command-json', verificationJson('process.exit(0)'),
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as {
      readonly ok: boolean;
      readonly checks: {
        readonly branch_available: boolean;
        readonly promotion_worktree_available: boolean;
        readonly promotion_would_apply_patch: boolean;
        readonly promotion_would_commit: boolean;
      };
    };
    expect(check.ok).toBe(false);
    expect(check.checks).toMatchObject({
      branch_available: false,
      promotion_worktree_available: false,
      promotion_would_apply_patch: false,
      promotion_would_commit: false,
    });
    await expect(readFile(join(receiptDir, 'codex-patch-promotion-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when promotion worktree availability cannot be inspected during no-side-effect check', async () => {
    const sourceRepoPath = await makeGitRepo();
    const patchPath = await createReadmePatch(sourceRepoPath, 'fixture repo\ncli inaccessible worktree candidate\n');
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-promotion-cli-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-promotion-cli-inaccessible-worktrees-'));
    const stdout: string[] = [];
    const stderr: string[] = [];

    await chmod(tempRoot, 0o000);
    try {
      const exitCode = await runCodexPatchPromotionCli([
        '--check',
        '--source-repo', sourceRepoPath,
        '--patch-path', patchPath,
        '--receipt-dir', receiptDir,
        '--temp-root', tempRoot,
        '--branch-name', 'symphony/cli-inaccessible',
        '--commit-message', 'Should not treat inaccessible path as available',
        '--verification-command-json', verificationJson('process.exit(0)'),
      ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

      expect(exitCode).toBe(1);
      expect(stderr).toEqual([]);
      const check = JSON.parse(stdout.join('')) as {
        readonly ok: boolean;
        readonly checks: {
          readonly temp_root_writable: boolean;
          readonly promotion_worktree_available: boolean;
          readonly promotion_would_apply_patch: boolean;
          readonly promotion_would_commit: boolean;
        };
      };
      expect(check.ok).toBe(false);
      expect(check.checks).toMatchObject({
        temp_root_writable: false,
        promotion_worktree_available: false,
        promotion_would_apply_patch: false,
        promotion_would_commit: false,
      });
    } finally {
      await chmod(tempRoot, 0o700);
    }
    await expect(readFile(join(receiptDir, 'codex-patch-promotion-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(git(sourceRepoPath, ['rev-parse', '--verify', 'symphony/cli-inaccessible'])).rejects.toThrow();
  });

  it('reports file paths as unusable receipt and temp directories during no-side-effect check', async () => {
    const sourceRepoPath = await makeGitRepo();
    const patchPath = await createReadmePatch(sourceRepoPath, 'fixture repo\ncli file path candidate\n');
    const parent = await mkdtemp(join(tmpdir(), 'symphony-promotion-cli-file-paths-'));
    const receiptDir = join(parent, 'receipt-file');
    const tempRoot = join(parent, 'temp-root-file');
    await writeFile(receiptDir, 'not a directory\n', 'utf8');
    await writeFile(tempRoot, 'not a directory\n', 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexPatchPromotionCli([
      '--check',
      '--source-repo', sourceRepoPath,
      '--patch-path', patchPath,
      '--receipt-dir', receiptDir,
      '--temp-root', tempRoot,
      '--branch-name', 'symphony/cli-file-paths',
      '--commit-message', 'Should not treat files as directories',
      '--verification-command-json', verificationJson('process.exit(0)'),
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as {
      readonly ok: boolean;
      readonly checks: {
        readonly receipt_dir_writable: boolean;
        readonly temp_root_writable: boolean;
        readonly promotion_worktree_available: boolean;
        readonly promotion_would_apply_patch: boolean;
        readonly promotion_would_commit: boolean;
      };
    };
    expect(check.ok).toBe(false);
    expect(check.checks).toMatchObject({
      receipt_dir_writable: false,
      temp_root_writable: false,
      promotion_worktree_available: false,
      promotion_would_apply_patch: false,
      promotion_would_commit: false,
    });
    expect((await stat(receiptDir)).isFile()).toBe(true);
    expect((await stat(tempRoot)).isFile()).toBe(true);
    await expect(git(sourceRepoPath, ['rev-parse', '--verify', 'symphony/cli-file-paths'])).rejects.toThrow();
  });

  it('promotes a patch with --yes and writes a local review receipt', async () => {
    const sourceRepoPath = await makeGitRepo();
    const patchPath = await createReadmePatch(sourceRepoPath, 'fixture repo\ncli promoted change\n');
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-promotion-cli-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-promotion-cli-worktrees-'));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexPatchPromotionCli([
      '--yes',
      '--source-repo', sourceRepoPath,
      '--patch-path', patchPath,
      '--receipt-dir', receiptDir,
      '--temp-root', tempRoot,
      '--branch-name', 'symphony/cli-promote',
      '--commit-message', 'Promote CLI Codex patch',
      '--verification-command-json', verificationJson('const fs = require("fs"); if (!fs.readFileSync("README.md", "utf8").includes("cli promoted change")) process.exit(8);'),
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const outcome = JSON.parse(stdout.join('')) as { readonly status: string; readonly commit_sha: string; readonly artifacts: { readonly summary: string } };
    expect(outcome.status).toBe('pass');
    expect(outcome.commit_sha).toMatch(/^[a-f0-9]{40}$/);
    await expect(readFile(outcome.artifacts.summary, 'utf8')).resolves.toContain('No git push, PR creation, Linear mutation, deployment, service restart, or broad dispatch is authorized.');
    await expect(readFile(join(sourceRepoPath, 'README.md'), 'utf8')).resolves.toBe('fixture repo\n');
    expect((await git(sourceRepoPath, ['rev-parse', 'symphony/cli-promote'])).trim()).toBe(outcome.commit_sha);
  });
});
