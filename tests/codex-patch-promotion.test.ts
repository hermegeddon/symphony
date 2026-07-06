import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  promoteCodexIssueRunPatch as exportedPromoteCodexIssueRunPatch,
} from '../src/index.js';
import {
  promoteCodexIssueRunPatch,
  type CodexPatchPromotionVerificationCommand,
} from '../src/codex-patch-promotion.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd });
  return stdout;
}

async function makeGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'symphony-promotion-source-repo-'));
  await git(repo, ['init']);
  await git(repo, ['config', 'user.name', 'Symphony Promotion Test']);
  await git(repo, ['config', 'user.email', 'symphony-promotion@example.test']);
  await writeFile(join(repo, 'README.md'), 'fixture repo\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'initial']);
  return repo;
}

async function createReadmePatch(repo: string, content: string): Promise<string> {
  const patchPath = join(await mkdtemp(join(tmpdir(), 'symphony-promotion-patch-')), 'codex-issue-run-worktree.patch');
  await writeFile(join(repo, 'README.md'), content, 'utf8');
  const patch = await git(repo, ['diff', '--binary']);
  await writeFile(patchPath, patch, 'utf8');
  await git(repo, ['checkout', '--', 'README.md']);
  return patchPath;
}

describe('promoteCodexIssueRunPatch', () => {
  it('exports the patch promotion helper from the package API', () => {
    expect(exportedPromoteCodexIssueRunPatch).toBe(promoteCodexIssueRunPatch);
  });

  it('applies an exported issue-run patch in a fresh local worktree and commits only after verification passes', async () => {
    const sourceRepoPath = await makeGitRepo();
    const patchPath = await createReadmePatch(sourceRepoPath, 'fixture repo\npromoted change\n');
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-promotion-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-promotion-worktrees-'));

    const outcome = await promoteCodexIssueRunPatch({
      sourceRepoPath,
      patchPath,
      receiptDir,
      tempRoot,
      branchName: 'symphony/promote-test-123',
      commitMessage: 'Promote TEST-123 Codex patch',
      verificationCommands: [{
        name: 'readme contains promoted change',
        command: process.execPath,
        args: ['-e', 'const fs = require("fs"); if (!fs.readFileSync("README.md", "utf8").includes("promoted change")) process.exit(7);'],
      }],
    });

    expect(outcome.status).toBe('pass');
    expect(outcome.branch_name).toBe('symphony/promote-test-123');
    expect(outcome.commit_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(outcome.verification).toHaveLength(1);
    expect(outcome.verification[0]).toMatchObject({ ok: true, exit_code: 0, name: 'readme contains promoted change' });
    expect(outcome.non_actions).toEqual({
      git_push_authorized: false,
      pull_request_created: false,
      linear_mutation_authorized: false,
      deploy_authorized: false,
      service_restart_authorized: false,
      broad_dispatch_authorized: false,
    });

    await expect(readFile(outcome.artifacts.patch, 'utf8')).resolves.toContain('promoted change');
    await expect(readFile(outcome.artifacts.status, 'utf8')).resolves.toBe('');
    await expect(readFile(outcome.artifacts.summary, 'utf8')).resolves.toContain('No git push, PR creation, Linear mutation, deployment, service restart, or broad dispatch is authorized.');
    const outcomeJson = JSON.parse(await readFile(outcome.artifacts.outcome, 'utf8')) as { readonly commit_sha: string | null };
    expect(outcomeJson.commit_sha).toBe(outcome.commit_sha);

    expect(await git(sourceRepoPath, ['status', '--short'])).toBe('');
    await expect(readFile(join(sourceRepoPath, 'README.md'), 'utf8')).resolves.toBe('fixture repo\n');
    expect((await git(sourceRepoPath, ['rev-parse', 'symphony/promote-test-123'])).trim()).toBe(outcome.commit_sha);
  });

  it('refuses a dirty source repo before creating a promotion worktree', async () => {
    const sourceRepoPath = await makeGitRepo();
    const patchPath = await createReadmePatch(sourceRepoPath, 'fixture repo\ndirty source candidate\n');
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-promotion-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-promotion-worktrees-'));
    await writeFile(join(sourceRepoPath, 'UNTRACKED.md'), 'operator note\n', 'utf8');

    await expect(promoteCodexIssueRunPatch({
      sourceRepoPath,
      patchPath,
      receiptDir,
      tempRoot,
      branchName: 'symphony/dirty-source',
      commitMessage: 'Should not commit dirty source',
      verificationCommands: [{ name: 'never runs', command: process.execPath, args: ['-e', 'process.exit(0)'] }],
    })).rejects.toMatchObject({ code: 'source_repo_not_clean' });

    await expect(access(join(tempRoot, 'symphony-promotion-symphony_dirty-source'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(receiptDir, 'codex-patch-promotion-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(git(sourceRepoPath, ['rev-parse', '--verify', 'symphony/dirty-source'])).rejects.toThrow();
  });

  it('rejects unsafe local promotion branch names before git side effects', async () => {
    const sourceRepoPath = await makeGitRepo();
    const patchPath = await createReadmePatch(sourceRepoPath, 'fixture repo\nunsafe branch candidate\n');
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-promotion-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-promotion-worktrees-'));

    await expect(promoteCodexIssueRunPatch({
      sourceRepoPath,
      patchPath,
      receiptDir,
      tempRoot,
      branchName: '../escape',
      commitMessage: 'Should reject unsafe branch',
      verificationCommands: [{ name: 'never runs', command: process.execPath, args: ['-e', 'process.exit(0)'] }],
    })).rejects.toMatchObject({ code: 'unsafe_branch_name' });

    await expect(access(join(tempRoot, 'symphony-promotion-.._escape'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(receiptDir, 'codex-patch-promotion-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects sparse verification commands before creating a promotion worktree or commit', async () => {
    const sourceRepoPath = await makeGitRepo();
    const patchPath = await createReadmePatch(sourceRepoPath, 'fixture repo\nsparse verification candidate\n');
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-promotion-receipts-'));
    const tempParent = await mkdtemp(join(tmpdir(), 'symphony-promotion-worktree-parent-'));
    const tempRoot = join(tempParent, 'missing-temp-root');
    const verificationCommands = new Array<CodexPatchPromotionVerificationCommand>(1);

    await expect(promoteCodexIssueRunPatch({
      sourceRepoPath,
      patchPath,
      receiptDir,
      tempRoot,
      branchName: 'symphony/sparse-verification',
      commitMessage: 'Should not commit without verification',
      verificationCommands,
    })).rejects.toMatchObject({ code: 'missing_verification_command' });

    await expect(access(tempRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(receiptDir, 'codex-patch-promotion-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(git(sourceRepoPath, ['rev-parse', '--verify', 'symphony/sparse-verification'])).rejects.toThrow();
  });

  it('refuses an unreadable patch before creating a promotion branch or worktree', async () => {
    const sourceRepoPath = await makeGitRepo();
    const patchPath = await createReadmePatch(sourceRepoPath, 'fixture repo\nunreadable patch candidate\n');
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-promotion-receipts-'));
    const tempParent = await mkdtemp(join(tmpdir(), 'symphony-promotion-worktree-parent-'));
    const tempRoot = join(tempParent, 'missing-temp-root');

    await chmod(patchPath, 0o000);
    try {
      await expect(promoteCodexIssueRunPatch({
        sourceRepoPath,
        patchPath,
        receiptDir,
        tempRoot,
        branchName: 'symphony/unreadable-patch',
        commitMessage: 'Should not create branch for unreadable patch',
        verificationCommands: [{ name: 'never runs', command: process.execPath, args: ['-e', 'process.exit(0)'] }],
      })).rejects.toMatchObject({ code: 'patch_not_readable' });
    } finally {
      await chmod(patchPath, 0o600);
    }

    await expect(access(tempRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(receiptDir, 'codex-patch-promotion-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(git(sourceRepoPath, ['rev-parse', '--verify', 'symphony/unreadable-patch'])).rejects.toThrow();
  });

  it('refuses an existing promotion branch before creating a promotion worktree or temp root', async () => {
    const sourceRepoPath = await makeGitRepo();
    const patchPath = await createReadmePatch(sourceRepoPath, 'fixture repo\nexisting branch candidate\n');
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-promotion-receipts-'));
    const tempParent = await mkdtemp(join(tmpdir(), 'symphony-promotion-worktree-parent-'));
    const tempRoot = join(tempParent, 'missing-temp-root');
    await git(sourceRepoPath, ['branch', 'symphony/existing-branch']);

    await expect(promoteCodexIssueRunPatch({
      sourceRepoPath,
      patchPath,
      receiptDir,
      tempRoot,
      branchName: 'symphony/existing-branch',
      commitMessage: 'Should reject existing branch',
      verificationCommands: [{ name: 'never runs', command: process.execPath, args: ['-e', 'process.exit(0)'] }],
    })).rejects.toMatchObject({ code: 'promotion_branch_exists' });

    await expect(access(tempRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(receiptDir, 'codex-patch-promotion-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when the promotion worktree path cannot be inspected before creation', async () => {
    const sourceRepoPath = await makeGitRepo();
    const patchPath = await createReadmePatch(sourceRepoPath, 'fixture repo\ninaccessible promotion parent\n');
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-promotion-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-promotion-inaccessible-worktrees-'));

    await chmod(tempRoot, 0o000);
    try {
      await expect(promoteCodexIssueRunPatch({
        sourceRepoPath,
        patchPath,
        receiptDir,
        tempRoot,
        branchName: 'symphony/inaccessible-worktree',
        commitMessage: 'Should not create branch when worktree path is unknowable',
        verificationCommands: [{ name: 'never runs', command: process.execPath, args: ['-e', 'process.exit(0)'] }],
      })).rejects.toMatchObject({ code: 'promotion_worktree_check_failed' });
    } finally {
      await chmod(tempRoot, 0o700);
    }

    await expect(access(join(tempRoot, 'symphony-promotion-symphony_inaccessible-worktree'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(receiptDir, 'codex-patch-promotion-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(git(sourceRepoPath, ['rev-parse', '--verify', 'symphony/inaccessible-worktree'])).rejects.toThrow();
  });

  it('does not create a local commit when verification fails', async () => {
    const sourceRepoPath = await makeGitRepo();
    const baseSha = (await git(sourceRepoPath, ['rev-parse', 'HEAD'])).trim();
    const patchPath = await createReadmePatch(sourceRepoPath, 'fixture repo\nverification should fail\n');
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-promotion-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-promotion-worktrees-'));

    const outcome = await promoteCodexIssueRunPatch({
      sourceRepoPath,
      patchPath,
      receiptDir,
      tempRoot,
      branchName: 'symphony/verification-fails',
      commitMessage: 'Should not be created',
      verificationCommands: [{ name: 'intentional failure', command: process.execPath, args: ['-e', 'process.exit(9)'] }],
    });

    expect(outcome.status).toBe('fail');
    expect(outcome.commit_sha).toBeNull();
    expect(outcome.verification).toHaveLength(1);
    expect(outcome.verification[0]).toMatchObject({ ok: false, exit_code: 9, name: 'intentional failure' });
    expect((await git(sourceRepoPath, ['rev-parse', 'symphony/verification-fails'])).trim()).toBe(baseSha);
    await expect(readFile(outcome.artifacts.status, 'utf8')).resolves.toContain('README.md');
    const outcomeJson = JSON.parse(await readFile(outcome.artifacts.outcome, 'utf8')) as { readonly status: string; readonly commit_sha: string | null };
    expect(outcomeJson).toMatchObject({ status: 'fail', commit_sha: null });
  });
});
