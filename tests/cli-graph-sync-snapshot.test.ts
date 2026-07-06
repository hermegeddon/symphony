import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSymphonyGraphSyncSnapshotCli, type GraphSyncSnapshotCliOptions } from '../src/cli/graph-sync-snapshot.js';

async function writeWorkflow(root: string): Promise<string> {
  const workflowPath = join(root, 'WORKFLOW.md');
  await writeFile(
    workflowPath,
    `---\nbackend:\n  kind: hermes_kanban\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  team_key: HER\nkanban:\n  hermes_command: /safe/bin/hermes\n  hermes_home: ./hermes-home\n  board: testflight\n  artifact_root: ${JSON.stringify(join(root, 'artifacts'))}\n---\nSnapshot workflow\n`,
    'utf8',
  );
  return workflowPath;
}

interface CaptureStdio {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly getStdout: () => string;
  readonly getStderr: () => string;
}

function captureStdio(): CaptureStdio {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    getStdout: () => stdout.join(''),
    getStderr: () => stderr.join(''),
  };
}

function buildOptions(stdout: string[], stderr: string[]): GraphSyncSnapshotCliOptions {
  const pushStdout = (chunk: string): void => {
    stdout.push(chunk);
  };
  const pushStderr = (chunk: string): void => {
    stderr.push(chunk);
  };
  return {
    stdout: pushStdout,
    stderr: pushStderr,
  };
}

describe('symphony-graph-sync-snapshot CLI', () => {
  it('shows help and exits 0', async () => {
    const stdio = captureStdio();
    const exitCode = await runSymphonyGraphSyncSnapshotCli(['--help'], buildOptions(stdio.stdout, stdio.stderr));
    expect(exitCode).toBe(0);
    expect(stdio.getStdout()).toContain('symphony-graph-sync-snapshot');
    expect(stdio.getStdout()).toContain('--mode read_only_snapshot');
    expect(stdio.getStderr()).toBe('');
  });

  it('rejects a missing or unsupported mode', async () => {
    const stdio = captureStdio();
    const exitCode = await runSymphonyGraphSyncSnapshotCli([], buildOptions(stdio.stdout, stdio.stderr));
    expect(exitCode).toBe(1);
    expect(stdio.getStderr()).toContain('read_only_snapshot');
  });

  it('returns BLOCK and suppressed_writes when the bridge ledger mapping state path is missing, without touching Hermes or Linear', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-snapshot-cli-'));
    const workflowPath = await writeWorkflow(root);
    const outputPath = join(root, 'snapshot.json');
    const receiptPath = join(root, 'receipt.json');
    const summaryPath = join(root, 'summary.md');
    const statusPath = join(root, 'status.json');

    const stdio = captureStdio();
    const exitCode = await runSymphonyGraphSyncSnapshotCli(
      [
        '--mode', 'read_only_snapshot',
        '--workflow', workflowPath,
        '--output', outputPath,
        '--receipt-output', receiptPath,
        '--summary-output', summaryPath,
        '--status-output', statusPath,
      ],
      {
        ...buildOptions(stdio.stdout, stdio.stderr),
        processEnv: { PATH: '/safe/bin' },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdio.getStderr()).toBe('');

    const artifact = JSON.parse(stdio.getStdout()) as {
      readonly ok: boolean;
      readonly status: string;
      readonly mode: string;
      readonly suppressed_writes: boolean;
      readonly effect: string;
      readonly error?: string;
      readonly non_actions: readonly string[];
    };

    expect(artifact.ok).toBe(false);
    expect(artifact.status).toBe('BLOCK');
    expect(artifact.mode).toBe('read_only_snapshot');
    expect(artifact.suppressed_writes).toBe(true);
    expect(artifact.effect).toBe('graph_sync_read_only_snapshot_artifact');
    expect(artifact.error).toMatch(/GraphSync mapping reader requires service\.state_path/);
    expect(artifact.non_actions).toContain('did_not_create_update_delete_linear_relations');
    expect(artifact.non_actions).toContain('did_not_create_update_delete_kanban_links');

    const status = JSON.parse(await readFile(statusPath, 'utf8')) as {
      readonly ok: boolean;
      readonly status: string;
      readonly mode: string;
      readonly suppressed_writes: boolean;
    };
    expect(status.ok).toBe(false);
    expect(status.status).toBe('BLOCK');
    expect(status.mode).toBe('read_only_snapshot');
    expect(status.suppressed_writes).toBe(true);

    const summary = await readFile(summaryPath, 'utf8');
    expect(summary).toContain('Operator status: `BLOCK`');
    expect(summary).toContain('No Linear relation writes, Kanban link writes');
  });

  it('reports memory state path kind and dry_run when no state path is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-snapshot-cli-dry-'));
    const workflowPath = await writeWorkflow(root);
    const outputPath = join(root, 'snapshot.json');
    const receiptPath = join(root, 'receipt.json');

    const stdio = captureStdio();
    const exitCode = await runSymphonyGraphSyncSnapshotCli(
      [
        '--mode', 'read_only_snapshot',
        '--workflow', workflowPath,
        '--output', outputPath,
        '--receipt-output', receiptPath,
      ],
      {
        ...buildOptions(stdio.stdout, stdio.stderr),
        processEnv: { PATH: '/safe/bin' },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdio.getStderr()).toBe('');

    const artifact = JSON.parse(stdio.getStdout()) as {
      readonly ok: boolean;
      readonly state?: {
        readonly checkpoint_state_path: string;
        readonly dry_run: boolean;
        readonly state_path?: string;
      };
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.state?.checkpoint_state_path).toBe('memory');
    expect(artifact.state?.dry_run).toBe(true);
    expect(artifact.state?.state_path).toBeUndefined();
  });

  it('does not write a state file even with --state-path because live readers still block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-snapshot-cli-state-'));
    const workflowPath = await writeWorkflow(root);
    const outputPath = join(root, 'snapshot.json');
    const receiptPath = join(root, 'receipt.json');
    const statePath = join(root, 'state.json');

    const stdio = captureStdio();
    const exitCode = await runSymphonyGraphSyncSnapshotCli(
      [
        '--mode', 'read_only_snapshot',
        '--workflow', workflowPath,
        '--output', outputPath,
        '--receipt-output', receiptPath,
        '--state-path', statePath,
      ],
      {
        ...buildOptions(stdio.stdout, stdio.stderr),
        processEnv: { PATH: '/safe/bin' },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdio.getStderr()).toBe('');

    const artifact = JSON.parse(stdio.getStdout()) as {
      readonly ok: boolean;
      readonly state?: {
        readonly checkpoint_state_path: string;
        readonly dry_run: boolean;
        readonly state_path?: string;
      };
    };
    expect(artifact.ok).toBe(false);
    expect(artifact.state?.checkpoint_state_path).toBe('injected');
    expect(artifact.state?.dry_run).toBe(false);
    expect(artifact.state?.state_path).toBe(statePath);

    await expect(readFile(statePath, 'utf8')).rejects.toThrow(/ENOENT/);
  });
});
