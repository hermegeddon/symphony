import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCodexIssueRunConfirmCli } from '../src/cli/codex-issue-run-confirm.js';

describe('symphony-codex-issue-run-confirm CLI', () => {
  it('is declared as a package binary', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      readonly bin?: Readonly<Record<string, string>>;
    };

    expect(packageJson.bin?.['symphony-codex-issue-run-confirm']).toBe('dist/src/cli/codex-issue-run-confirm.js');
  });

  it('prints a confirmation packet without spawning Codex or writing receipts', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-confirm-cli-workspace-'));
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-confirm-cli-receipts-'));
    const spawnMarkerPath = join(workspacePath, 'spawned.txt');
    const fakeServerPath = join(workspacePath, 'fake-app-server.mjs');
    await writeFile(fakeServerPath, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(spawnMarkerPath)}, 'spawned');
`, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = runCodexIssueRunConfirmCli([
      '--workspace', workspacePath,
      '--receipt-dir', receiptDir,
      '--issue', 'HER-102',
      '--title', 'Preview issue run',
      '--team', 'HER',
      '--codex-command', `node ${JSON.stringify(fakeServerPath)}`,
      '--schema-source', 'fake-jsonl-v1 fixture for confirmation CLI',
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
      readonly codex: { readonly command_preview: string; readonly approval_mode: string; readonly sandbox_mode: string };
      readonly hooks: { readonly will_run: boolean };
      readonly expected_artifacts: { readonly receipt_dir: string; readonly summary: string };
      readonly non_actions: { readonly codex_started: boolean; readonly receipt_files_written: boolean; readonly persistent_branch_created: boolean };
    };
    expect(packet.effect).toBe('print_only');
    expect(packet.exact_issue).toMatchObject({ identifier: 'HER-102', team_key: 'HER' });
    expect(packet.workspace.path).toBe(workspacePath);
    expect(packet.codex).toMatchObject({
      command_preview: `node ${JSON.stringify(fakeServerPath)}`,
      approval_mode: 'fail',
      sandbox_mode: 'workspace_write',
    });
    expect(packet.hooks.will_run).toBe(false);
    expect(packet.expected_artifacts).toMatchObject({
      receipt_dir: receiptDir,
      summary: 'LIVE-HER-102-codex-issue-run-summary.md',
    });
    expect(packet.non_actions).toMatchObject({
      codex_started: false,
      receipt_files_written: false,
      persistent_branch_created: false,
    });
    await expect(readFile(spawnMarkerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(receiptDir, 'codex-issue-run-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unknown flags instead of silently ignoring them', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-confirm-cli-workspace-'));
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-confirm-cli-receipts-'));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = runCodexIssueRunConfirmCli([
      '--workspace', workspacePath,
      '--receipt-dir', receiptDir,
      '--issue', 'HER-105',
      '--title', 'Reject unknown flag',
      '--codex-command', 'codex app-server',
      '--schema-source', 'fake-jsonl-v1 fixture for confirmation CLI',
      '--approval-mode', 'fail',
      '--sandbox-mode', 'workspace_write',
      '--hooks-will-run', 'false',
      '--unexpected-flag', 'ignored',
    ], (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk));

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('Unsupported flag --unexpected-flag');
    await expect(readFile(join(receiptDir, 'codex-issue-run-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
