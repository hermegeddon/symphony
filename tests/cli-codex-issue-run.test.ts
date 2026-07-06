import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { runCodexIssueRunCli } from '../src/cli/codex-issue-run.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd });
  return stdout;
}

async function makeGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'symphony-cli-source-repo-'));
  await git(repo, ['init']);
  await writeFile(join(repo, 'README.md'), 'fixture repo\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['-c', 'user.name=Symphony Test', '-c', 'user.email=symphony@example.test', 'commit', '-m', 'initial']);
  return repo;
}

describe('symphony-codex-issue-run CLI', () => {
  it('is declared as a package binary', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      readonly bin?: Readonly<Record<string, string>>;
    };

    expect(packageJson.bin?.['symphony-codex-issue-run']).toBe('dist/src/cli/codex-issue-run.js');
  });

  it('refuses execution without --yes and does not spawn the app-server', async () => {
    const sourceRepoPath = await mkdtemp(join(tmpdir(), 'symphony-cli-source-'));
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-cli-receipts-'));
    const spawnMarkerPath = join(sourceRepoPath, 'spawned.txt');
    const fakeServerPath = join(sourceRepoPath, 'fake-app-server.mjs');
    await writeFile(fakeServerPath, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(spawnMarkerPath)}, 'spawned');
`, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--source-repo', sourceRepoPath,
      '--receipt-dir', receiptDir,
      '--issue', 'HER-201',
      '--title', 'Refuse without yes',
      '--codex-command', `node ${JSON.stringify(fakeServerPath)}`,
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('requires --yes');
    await expect(readFile(spawnMarkerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(receiptDir, 'codex-issue-run-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prints a confirmation packet without spawning or writing receipts', async () => {
    const sourceRepoPath = await mkdtemp(join(tmpdir(), 'symphony-cli-source-'));
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-cli-receipts-'));
    const spawnMarkerPath = join(sourceRepoPath, 'spawned.txt');
    const fakeServerPath = join(sourceRepoPath, 'fake-app-server.mjs');
    await writeFile(fakeServerPath, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(spawnMarkerPath)}, 'spawned');
`, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--print-confirmation',
      '--source-repo', sourceRepoPath,
      '--receipt-dir', receiptDir,
      '--issue', 'HER-202',
      '--title', 'Print confirmation',
      '--team', 'HER',
      '--codex-command', `node ${JSON.stringify(fakeServerPath)}`,
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const packet = JSON.parse(stdout.join('')) as {
      readonly effect: string;
      readonly exact_issue: { readonly identifier: string; readonly team_key?: string };
      readonly workspace: { readonly path: string };
      readonly expected_artifacts: { readonly receipt_dir: string };
      readonly non_actions: { readonly codex_started: boolean; readonly receipt_files_written: boolean; readonly persistent_branch_created: boolean };
    };
    expect(packet.effect).toBe('print_only');
    expect(packet.exact_issue).toMatchObject({ identifier: 'HER-202', team_key: 'HER' });
    expect(packet.workspace.path).toBe(sourceRepoPath);
    expect(packet.expected_artifacts.receipt_dir).toBe(receiptDir);
    expect(packet.non_actions).toMatchObject({
      codex_started: false,
      receipt_files_written: false,
      persistent_branch_created: false,
    });
    await expect(readFile(spawnMarkerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(receiptDir, 'codex-issue-run-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('derives a deterministic receipt directory from artifact root and run id in print-only mode', async () => {
    const sourceRepoPath = await mkdtemp(join(tmpdir(), 'symphony-cli-source-'));
    const artifactRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-artifacts-'));
    const fakeServerPath = join(sourceRepoPath, 'fake-app-server.mjs');
    await writeFile(fakeServerPath, 'process.exit(99);\n', 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--print-confirmation',
      '--source-repo', sourceRepoPath,
      '--artifact-root', artifactRoot,
      '--run-id', '20260622T010203Z',
      '--issue', 'HER-205',
      '--title', 'Artifact root confirmation',
      '--codex-command', `node ${JSON.stringify(fakeServerPath)}`,
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const packet = JSON.parse(stdout.join('')) as {
      readonly expected_artifacts: { readonly receipt_dir: string };
    };
    const derivedReceiptDir = join(artifactRoot, '20260622T010203Z-HER-205');
    expect(packet.expected_artifacts.receipt_dir).toBe(derivedReceiptDir);
    await expect(readFile(join(derivedReceiptDir, 'codex-issue-run-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks local readiness without spawning or writing receipts', async () => {
    const sourceRepoPath = await makeGitRepo();
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-cli-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-worktree-root-'));
    const spawnMarkerPath = join(sourceRepoPath, 'spawned.txt');
    const fakeServerPath = join(sourceRepoPath, 'fake-app-server.mjs');
    await writeFile(fakeServerPath, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(spawnMarkerPath)}, 'spawned');
`, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--check',
      '--source-repo', sourceRepoPath,
      '--receipt-dir', receiptDir,
      '--temp-root', tempRoot,
      '--issue', 'HER-203',
      '--title', 'Check readiness',
      '--codex-command', `node ${JSON.stringify(fakeServerPath)}`,
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as {
      readonly effect: string;
      readonly ok: boolean;
      readonly checks: {
        readonly source_repo_git: boolean;
        readonly receipt_dir_writable: boolean;
        readonly temp_root_writable: boolean;
        readonly codex_would_spawn: boolean;
        readonly live_codex_or_openai: boolean;
        readonly live_command_override: boolean;
        readonly confirmation_digest_matches: boolean;
        readonly receipt_path_deterministic: boolean;
        readonly approval_mode_fail_closed: boolean;
        readonly derived_receipt_path_safe: boolean;
      };
    };
    expect(check).toEqual({
      effect: 'check_only',
      ok: true,
      checks: {
        source_repo_git: true,
        receipt_dir_writable: true,
        temp_root_writable: true,
        codex_would_spawn: false,
        live_codex_or_openai: false,
        live_command_override: false,
        confirmation_digest_matches: false,
        receipt_path_deterministic: true,
        approval_mode_fail_closed: true,
        derived_receipt_path_safe: true,
      },
    });
    await expect(readFile(spawnMarkerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(receiptDir, 'codex-issue-run-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats a creatable missing artifact root as check-ready without creating it', async () => {
    const sourceRepoPath = await makeGitRepo();
    const artifactParent = await mkdtemp(join(tmpdir(), 'symphony-cli-artifact-parent-'));
    const artifactRoot = join(artifactParent, 'operator-runs');
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-worktree-root-'));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--check',
      '--source-repo', sourceRepoPath,
      '--artifact-root', artifactRoot,
      '--temp-root', tempRoot,
      '--issue', 'HER-212',
      '--title', 'Creatable artifact root',
      '--codex-command', 'node fake-app-server.mjs',
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as { readonly ok: boolean; readonly checks: { readonly receipt_dir_writable: boolean } };
    expect(check.ok).toBe(true);
    expect(check.checks.receipt_dir_writable).toBe(true);
    await expect(readFile(join(artifactRoot, 'codex-issue-run-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports readiness failure for non-fail-closed approval mode', async () => {
    const sourceRepoPath = await makeGitRepo();
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-cli-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-worktree-root-'));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--check',
      '--source-repo', sourceRepoPath,
      '--receipt-dir', receiptDir,
      '--temp-root', tempRoot,
      '--issue', 'HER-213',
      '--title', 'Reject auto approve readiness',
      '--codex-command', 'node fake-app-server.mjs',
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'auto_approve',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as { readonly ok: boolean; readonly checks: { readonly approval_mode_fail_closed: boolean } };
    expect(check.ok).toBe(false);
    expect(check.checks.approval_mode_fail_closed).toBe(false);
    await expect(readFile(join(receiptDir, 'codex-issue-run-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not create an artifact-root run directory when approval mode is not fail-closed', async () => {
    const sourceRepoPath = await makeGitRepo();
    const artifactRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-artifacts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-worktree-root-'));
    const derivedReceiptDir = join(artifactRoot, '20260622T030405Z-HER-214');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--yes',
      '--source-repo', sourceRepoPath,
      '--artifact-root', artifactRoot,
      '--run-id', '20260622T030405Z',
      '--temp-root', tempRoot,
      '--issue', 'HER-214',
      '--title', 'No auto approve side effect',
      '--codex-command', 'node fake-app-server.mjs',
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'auto_approve',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as { readonly ok: boolean; readonly checks: { readonly approval_mode_fail_closed: boolean } };
    expect(check.ok).toBe(false);
    expect(check.checks.approval_mode_fail_closed).toBe(false);
    await expect(access(derivedReceiptDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports readiness failure for unsafe artifact-root run ids without creating the artifact root', async () => {
    const sourceRepoPath = await makeGitRepo();
    const artifactParent = await mkdtemp(join(tmpdir(), 'symphony-cli-artifact-parent-'));
    const artifactRoot = join(artifactParent, 'operator-runs');
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-worktree-root-'));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--check',
      '--source-repo', sourceRepoPath,
      '--artifact-root', artifactRoot,
      '--run-id', '../escape',
      '--temp-root', tempRoot,
      '--issue', 'HER-215',
      '--title', 'Unsafe run id check',
      '--codex-command', 'node fake-app-server.mjs',
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as { readonly ok: boolean; readonly checks: { readonly derived_receipt_path_safe: boolean } };
    expect(check.ok).toBe(false);
    expect(check.checks.derived_receipt_path_safe).toBe(false);
    await expect(access(artifactRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not create an artifact root when execution has an unsafe run id', async () => {
    const sourceRepoPath = await makeGitRepo();
    const artifactParent = await mkdtemp(join(tmpdir(), 'symphony-cli-artifact-parent-'));
    const artifactRoot = join(artifactParent, 'operator-runs');
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-worktree-root-'));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--yes',
      '--source-repo', sourceRepoPath,
      '--artifact-root', artifactRoot,
      '--run-id', '../escape',
      '--temp-root', tempRoot,
      '--issue', 'HER-216',
      '--title', 'Unsafe run id no side effect',
      '--codex-command', 'node fake-app-server.mjs',
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as { readonly ok: boolean; readonly checks: { readonly derived_receipt_path_safe: boolean } };
    expect(check.ok).toBe(false);
    expect(check.checks.derived_receipt_path_safe).toBe(false);
    await expect(access(artifactRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports readiness failure for unsafe derived issue path segments', async () => {
    const sourceRepoPath = await makeGitRepo();
    const artifactRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-artifacts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-worktree-root-'));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--check',
      '--source-repo', sourceRepoPath,
      '--artifact-root', artifactRoot,
      '--run-id', '20260622T040506Z',
      '--temp-root', tempRoot,
      '--issue', 'HER/217',
      '--title', 'Unsafe issue path segment',
      '--codex-command', 'node fake-app-server.mjs',
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as { readonly ok: boolean; readonly checks: { readonly derived_receipt_path_safe: boolean } };
    expect(check.ok).toBe(false);
    expect(check.checks.derived_receipt_path_safe).toBe(false);
  });

  it('runs a confirmed fake issue-run in an ephemeral worktree and preserves patch artifacts', async () => {
    const sourceRepoPath = await makeGitRepo();
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-cli-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-worktree-root-'));
    const fakeServerPath = join(sourceRepoPath, 'fake-app-server.mjs');
    await writeFile(fakeServerPath, `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread_cli_issue_run' } } });
  if (message.method === 'turn/start') {
    writeFileSync('README.md', 'fixture repo\\nmodified by CLI fake issue run\\n');
    send({ id: message.id, result: { turn: { id: 'turn_cli_issue_run' }, session: { id: 'session_cli_issue_run' } } });
    send({ method: 'turn/completed', params: { thread: { id: 'thread_cli_issue_run' }, turn: { id: 'turn_cli_issue_run' } } });
  }
});
`, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--yes',
      '--source-repo', sourceRepoPath,
      '--receipt-dir', receiptDir,
      '--temp-root', tempRoot,
      '--issue', 'HER-204',
      '--title', 'Run confirmed fake issue',
      '--team', 'HER',
      '--codex-command', `node ${JSON.stringify(fakeServerPath)}`,
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const outcome = JSON.parse(stdout.join('')) as {
      readonly status: string;
      readonly artifacts: { readonly workspace_patch: string; readonly workspace_status: string };
    };
    expect(outcome.status).toBe('pass');
    expect(outcome.artifacts.workspace_patch).toBe(join(receiptDir, 'codex-issue-run-worktree.patch'));
    expect(outcome.artifacts.workspace_status).toBe(join(receiptDir, 'codex-issue-run-worktree-status.txt'));
    await expect(readFile(outcome.artifacts.workspace_patch, 'utf8')).resolves.toContain('modified by CLI fake issue run');
    await expect(readFile(outcome.artifacts.workspace_status, 'utf8')).resolves.toContain('M README.md');
    await expect(readFile(join(receiptDir, 'artifact-manifest.json'), 'utf8')).resolves.toContain('workspace_patch');
    await expect(readFile(join(sourceRepoPath, 'README.md'), 'utf8')).resolves.toBe('fixture repo\n');
  });

  it('rejects unknown flags before any local execution', async () => {
    const sourceRepoPath = await mkdtemp(join(tmpdir(), 'symphony-cli-source-'));
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-cli-receipts-'));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--print-confirmation',
      '--source-repo', sourceRepoPath,
      '--receipt-dir', receiptDir,
      '--issue', 'HER-206',
      '--title', 'Unknown flag',
      '--codex-command', 'node fake-app-server.mjs',
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
      '--mutate-linear', 'true',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('Unsupported flag --mutate-linear');
    await expect(readFile(join(receiptDir, 'codex-issue-run-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unsafe run ids without creating derived receipt paths', async () => {
    const sourceRepoPath = await mkdtemp(join(tmpdir(), 'symphony-cli-source-'));
    const artifactRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-artifacts-'));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--print-confirmation',
      '--source-repo', sourceRepoPath,
      '--artifact-root', artifactRoot,
      '--run-id', '../escape',
      '--issue', 'HER-207',
      '--title', 'Unsafe run id',
      '--codex-command', 'node fake-app-server.mjs',
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('Unsafe --run-id path segment');
    await expect(readFile(join(artifactRoot, 'escape', 'codex-issue-run-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to overwrite an existing artifact-root derived run directory before spawning', async () => {
    const sourceRepoPath = await makeGitRepo();
    const artifactRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-artifacts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-worktree-root-'));
    const existingReceiptDir = join(artifactRoot, '20260622T020304Z-HER-208');
    await mkdir(existingReceiptDir);
    await writeFile(join(existingReceiptDir, 'already-here.txt'), 'occupied', 'utf8');
    const spawnMarkerPath = join(sourceRepoPath, 'spawned.txt');
    const fakeServerPath = join(sourceRepoPath, 'fake-app-server.mjs');
    await writeFile(fakeServerPath, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(spawnMarkerPath)}, 'spawned');
`, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--yes',
      '--source-repo', sourceRepoPath,
      '--artifact-root', artifactRoot,
      '--run-id', '20260622T020304Z',
      '--temp-root', tempRoot,
      '--issue', 'HER-208',
      '--title', 'No overwrite',
      '--codex-command', `node ${JSON.stringify(fakeServerPath)}`,
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('EEXIST');
    await expect(readFile(spawnMarkerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports readiness failure for a non-git source repo without spawning', async () => {
    const sourceRepoPath = await mkdtemp(join(tmpdir(), 'symphony-cli-source-'));
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-cli-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-worktree-root-'));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--check',
      '--source-repo', sourceRepoPath,
      '--receipt-dir', receiptDir,
      '--temp-root', tempRoot,
      '--issue', 'HER-209',
      '--title', 'Non git check',
      '--codex-command', 'node fake-app-server.mjs',
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as { readonly ok: boolean; readonly checks: { readonly source_repo_git: boolean } };
    expect(check.ok).toBe(false);
    expect(check.checks.source_repo_git).toBe(false);
    await expect(readFile(join(receiptDir, 'codex-issue-run-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports readiness failure for commands that look like live Codex or OpenAI', async () => {
    const sourceRepoPath = await makeGitRepo();
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-cli-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-worktree-root-'));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--check',
      '--source-repo', sourceRepoPath,
      '--receipt-dir', receiptDir,
      '--temp-root', tempRoot,
      '--issue', 'HER-210',
      '--title', 'Live codex rejected',
      '--codex-command', 'codex app-server',
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as { readonly ok: boolean; readonly checks: { readonly live_codex_or_openai: boolean } };
    expect(check.ok).toBe(false);
    expect(check.checks.live_codex_or_openai).toBe(true);
    await expect(readFile(join(receiptDir, 'codex-issue-run-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prints a live-command confirmation digest tied to exact operator inputs', async () => {
    const sourceRepoPath = await makeGitRepo();
    const artifactRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-artifacts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-worktree-root-'));
    const fakeServerPath = join(sourceRepoPath, 'fake-codex-app-server.mjs');
    await writeFile(fakeServerPath, 'process.exit(99);\n', 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--print-confirmation',
      '--source-repo', sourceRepoPath,
      '--artifact-root', artifactRoot,
      '--run-id', '20260622T050607Z',
      '--temp-root', tempRoot,
      '--issue', 'HER-218',
      '--title', 'Live override packet',
      '--codex-command', `node ${JSON.stringify(fakeServerPath)}`,
      '--schema-source', 'codex-cli 0.141.0 app-server schema for later live canary',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const packet = JSON.parse(stdout.join('')) as {
      readonly operator_confirmation: {
        readonly confirmation_digest_algorithm: string;
        readonly confirmation_digest: string;
        readonly live_command_detected: boolean;
        readonly live_command_default_blocked: boolean;
        readonly live_command_override_flag: string;
        readonly confirmation_digest_flag: string;
        readonly temp_root: string;
        readonly receipt_path_deterministic: boolean;
      };
    };
    expect(packet.operator_confirmation).toMatchObject({
      confirmation_digest_algorithm: 'sha256-json-v1',
      live_command_detected: true,
      live_command_default_blocked: true,
      live_command_override_flag: '--allow-live-codex-openai-command',
      confirmation_digest_flag: '--confirmation-digest',
      temp_root: tempRoot,
      receipt_path_deterministic: true,
    });
    expect(packet.operator_confirmation.confirmation_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects live-command override without a matching confirmation digest before creating artifact roots', async () => {
    const sourceRepoPath = await makeGitRepo();
    const artifactParent = await mkdtemp(join(tmpdir(), 'symphony-cli-artifact-parent-'));
    const artifactRoot = join(artifactParent, 'operator-runs');
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-worktree-root-'));
    const derivedReceiptDir = join(artifactRoot, '20260622T060708Z-HER-219');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--yes',
      '--allow-live-codex-openai-command',
      '--source-repo', sourceRepoPath,
      '--artifact-root', artifactRoot,
      '--run-id', '20260622T060708Z',
      '--temp-root', tempRoot,
      '--issue', 'HER-219',
      '--title', 'Live override without digest',
      '--codex-command', 'codex app-server',
      '--schema-source', 'codex-cli 0.141.0 app-server schema for later live canary',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as {
      readonly ok: boolean;
      readonly checks: {
        readonly live_codex_or_openai: boolean;
        readonly live_command_override: boolean;
        readonly confirmation_digest_matches: boolean;
      };
    };
    expect(check.ok).toBe(false);
    expect(check.checks.live_codex_or_openai).toBe(true);
    expect(check.checks.live_command_override).toBe(true);
    expect(check.checks.confirmation_digest_matches).toBe(false);
    await expect(access(artifactRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(derivedReceiptDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects live-command override with a mismatched confirmation digest before spawning', async () => {
    const sourceRepoPath = await makeGitRepo();
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-cli-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-worktree-root-'));
    const spawnMarkerPath = join(sourceRepoPath, 'spawned.txt');
    const fakeServerPath = join(sourceRepoPath, 'fake-codex-app-server.mjs');
    await writeFile(fakeServerPath, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(spawnMarkerPath)}, 'spawned');
`, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--yes',
      '--allow-live-codex-openai-command',
      '--confirmation-digest', '0'.repeat(64),
      '--source-repo', sourceRepoPath,
      '--receipt-dir', receiptDir,
      '--temp-root', tempRoot,
      '--issue', 'HER-220',
      '--title', 'Mismatched live digest',
      '--codex-command', `node ${JSON.stringify(fakeServerPath)}`,
      '--schema-source', 'codex-cli 0.141.0 app-server schema for later live canary',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as { readonly ok: boolean; readonly checks: { readonly confirmation_digest_matches: boolean } };
    expect(check.ok).toBe(false);
    expect(check.checks.confirmation_digest_matches).toBe(false);
    await expect(readFile(spawnMarkerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(receiptDir, 'codex-issue-run-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs a fake live-looking command only with explicit override and matching confirmation digest', async () => {
    const sourceRepoPath = await makeGitRepo();
    const artifactRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-artifacts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-cli-worktree-root-'));
    const fakeServerPath = join(sourceRepoPath, 'fake-codex-app-server.mjs');
    await writeFile(fakeServerPath, `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread_cli_live_override' } } });
  if (message.method === 'turn/start') {
    writeFileSync('README.md', 'fixture repo\\nmodified by fake live-looking issue run\\n');
    send({ id: message.id, result: { turn: { id: 'turn_cli_live_override' }, session: { id: 'session_cli_live_override' } } });
    send({ method: 'turn/completed', params: { thread: { id: 'thread_cli_live_override' }, turn: { id: 'turn_cli_live_override' } } });
  }
});
`, 'utf8');
    const baseArgs = [
      '--source-repo', sourceRepoPath,
      '--artifact-root', artifactRoot,
      '--run-id', '20260622T070809Z',
      '--temp-root', tempRoot,
      '--issue', 'HER-221',
      '--title', 'Run fake live-looking issue',
      '--team', 'HER',
      '--codex-command', `node ${JSON.stringify(fakeServerPath)}`,
      '--schema-source', 'codex-cli 0.141.0 app-server schema for later live canary',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ] as const;
    const confirmationStdout: string[] = [];
    const confirmationExitCode = await runCodexIssueRunCli([
      '--print-confirmation',
      ...baseArgs,
    ], (chunk) => confirmationStdout.push(chunk));
    expect(confirmationExitCode).toBe(0);
    const confirmation = JSON.parse(confirmationStdout.join('')) as {
      readonly operator_confirmation: { readonly confirmation_digest: string };
    };

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCodexIssueRunCli([
      '--yes',
      '--allow-live-codex-openai-command',
      '--confirmation-digest', confirmation.operator_confirmation.confirmation_digest,
      ...baseArgs,
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const outcome = JSON.parse(stdout.join('')) as {
      readonly status: string;
      readonly artifacts: { readonly workspace_patch: string; readonly workspace_status: string };
    };
    expect(outcome.status).toBe('pass');
    const derivedReceiptDir = join(artifactRoot, '20260622T070809Z-HER-221');
    expect(outcome.artifacts.workspace_patch).toBe(join(derivedReceiptDir, 'codex-issue-run-worktree.patch'));
    await expect(readFile(outcome.artifacts.workspace_patch, 'utf8')).resolves.toContain('modified by fake live-looking issue run');
    await expect(readFile(outcome.artifacts.workspace_status, 'utf8')).resolves.toContain('M README.md');
    await expect(readFile(join(sourceRepoPath, 'README.md'), 'utf8')).resolves.toBe('fixture repo\n');
  });

  it('derives codex command from WORKFLOW.md while still requiring exact issue fields', async () => {
    const sourceRepoPath = await mkdtemp(join(tmpdir(), 'symphony-cli-source-'));
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-cli-receipts-'));
    const fakeServerPath = join(sourceRepoPath, 'workflow-fake-app-server.mjs');
    const workflowPath = join(sourceRepoPath, 'WORKFLOW.md');
    await writeFile(fakeServerPath, 'process.exit(99);\n', 'utf8');
    await writeFile(workflowPath, `---
codex:
  command: node ${JSON.stringify(fakeServerPath)}
  read_timeout_ms: 1234
  turn_timeout_ms: 5678
---
Workflow prompt for {{ issue.identifier }}
`, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodexIssueRunCli([
      '--print-confirmation',
      '--workflow', workflowPath,
      '--source-repo', sourceRepoPath,
      '--receipt-dir', receiptDir,
      '--issue', 'HER-211',
      '--title', 'Workflow derived command',
      '--schema-source', 'fake-jsonl-v1 fixture for issue-run CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const packet = JSON.parse(stdout.join('')) as {
      readonly exact_issue: { readonly identifier: string };
      readonly codex: { readonly command_preview: string };
    };
    expect(packet.exact_issue.identifier).toBe('HER-211');
    expect(packet.codex.command_preview).toBe(`node ${JSON.stringify(fakeServerPath)}`);
  });
});
